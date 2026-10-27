const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { createDatabaseAdapter } = require('./db/index');
const { createMedicineRequestEngine, MedicineRequestError } = require('./medicine-requests');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mediindex.db');
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function passwordMatches(password, stored) {
  const [salt, storedHash] = stored.split(':');
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function hashSessionToken(token) {
  if (typeof token !== 'string' || !token.trim()) return '';
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

// Auto-select adapter: PostgreSQL if DATABASE_URL set, otherwise SQLite.
// db IS the adapter — both SQLiteAdapter and PostgreSQLAdapter expose
// .prepare(sql).get/run/all(), .get(), .run(), .query(), .exec(), .transaction().
const adapter = createDatabaseAdapter({ dataDir: DATA_DIR, dbPath: DB_PATH }).initialize();
// For SQLite, initialize() is synchronous and returns `this`.
// For PostgreSQL, initialize() returns a Promise — the await is handled inside
// each async route handler that actually uses the db. Module-level initialization
// only sets up the pool (PG) or opens the file (SQLite); schema is applied via
// the PostgreSQL schema.pg.sql on first deploy, and via SQLiteAdapter.initialize()
// for local dev.
const db = adapter;

// For PostgreSQL, begin idempotent schema application immediately at module load
// so it is already in flight (usually already complete) by the time the first
// request is routed. handler() still awaits it, which is a no-op once settled.
// The .catch() here only prevents an unhandled rejection at load time — the real
// error is surfaced to the caller by the await inside handler().
if (adapter.type === 'postgres' && typeof adapter.ensureSchema === 'function') {
  adapter.ensureSchema().catch(() => {});
}

// ─── SQL dialect helpers ───────────────────────────────────────────────────
// SQLite uses date('now', '+N days'); PostgreSQL uses CURRENT_DATE + N.
// Both databases accept CURRENT_DATE for "today".
// expiry_date is TEXT in SQLite (YYYY-MM-DD) and DATE in PostgreSQL — direct
// comparison against CURRENT_DATE works correctly on both.
const isPg = adapter.type === 'postgres';
// TODAY  : 'CURRENT_DATE'          — works on both SQLite and PostgreSQL
const D_TODAY        = 'CURRENT_DATE';
// +30    : SQLite needs the date() modifier; PostgreSQL uses integer addition
const D_TODAY_30     = isPg ? "(CURRENT_DATE + 30)" : "date(CURRENT_DATE, '+30 days')";
// Days-to-expiry as integer: PG uses (col - CURRENT_DATE); SQLite uses julianday diff
const D_DAYS_LEFT    = isPg ? "(expiry_date - CURRENT_DATE)" : "CAST(julianday(expiry_date) - julianday(CURRENT_DATE) AS INTEGER)";
// Days-to-expiry with table alias (b.expiry_date)
const D_DAYS_LEFT_B  = isPg ? "(b.expiry_date - CURRENT_DATE)" : "CAST(julianday(b.expiry_date) - julianday(CURRENT_DATE) AS INTEGER)";
// ISO week period for grouping: strftime('%G-W%V') on SQLite, to_char on PostgreSQL
// Both produce 'YYYY-WNN' ISO 8601 week strings (e.g. '2026-W38').
const D_WEEK = isPg
  ? "to_char(s.created_at, 'IYYY-\"W\"IW')"
  : "strftime('%G-W%V', s.created_at)";
// Cast a timestamp/text column to a DATE value.
// PostgreSQL: col::date  |  SQLite: date(col)
// Used for period_start / period_end metadata in the demand forecast query
// where s.created_at is TIMESTAMPTZ on PG and TEXT on SQLite.
const D_DATE_OF = isPg ? (col => `${col}::date`) : (col => `date(${col})`);
// EXPIRY_STATUS CASE expression — reused in multiple queries
// Returns 'EXPIRED', 'EXPIRING_SOON', or 'SAFE' based on expiry_date vs today
function expiryStatusCase(col) {
  return `CASE WHEN ${col} < ${D_TODAY} THEN 'EXPIRED' WHEN ${col} <= ${D_TODAY_30} THEN 'EXPIRING_SOON' ELSE 'SAFE' END`;
}
// Duplicate-constraint error detection: SQLite says "UNIQUE constraint failed",
// PostgreSQL says "duplicate key value violates unique constraint" (code 23505)
function isDuplicateError(err) {
  return (err && (
    (err.code === '23505') ||
    (typeof err.message === 'string' && (
      err.message.includes('UNIQUE constraint') ||
      err.message.includes('duplicate key') ||
      err.message.includes('already exists')
    ))
  ));
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

// ─── Near-expiry redistribution configuration ─────────────────────────────
// NEAR_EXPIRY_DAYS: single centralized threshold. A batch qualifies when
//   days until expiry <= NEAR_EXPIRY_DAYS and quantity > 0 and not expired.
const NEAR_EXPIRY_DAYS = 20;

// NEARBY_RADIUS_KM: maximum Haversine distance for a recipient to be considered
//   nearby. Only applied when BOTH sender and recipient have non-NULL lat/lng.
//   When either coordinate is missing, no proximity match is made — no fake
//   distances are invented.
const NEARBY_RADIUS_KM = 50;

// SQL expression: expiry_date <= CURRENT_DATE + NEAR_EXPIRY_DAYS (both adapters)
const D_NEAR_EXPIRY_CUTOFF = isPg
  ? `(CURRENT_DATE + ${NEAR_EXPIRY_DAYS})`
  : `date(CURRENT_DATE, '+${NEAR_EXPIRY_DAYS} days')`;

/**
 * Haversine great-circle distance between two geographic coordinates.
 * @param {number} lat1  Latitude of point A (decimal degrees)
 * @param {number} lng1  Longitude of point A (decimal degrees)
 * @param {number} lat2  Latitude of point B (decimal degrees)
 * @param {number} lng2  Longitude of point B (decimal degrees)
 * @returns {number}  Distance in kilometres
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R   = 6371; // Earth radius km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
          * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ─── Manual medicine request engine ──────────────────────────────────────────
// A single shared instance. The API layer delegates every rule to this engine
// rather than re-implementing logic in route handlers. Completely separate from
// processNearExpiryRedistribution and medicine_redistribution_requests, which it
// neither reads nor writes.
const medicineRequestEngine = createMedicineRequestEngine({
  db,
  isPg,
  haversineKm,
  isDuplicateError
});

/**
 * Maps a Phase 2 MedicineRequestError onto the project's JSON error convention.
 * VALIDATION -> 400, NOT_FOUND -> 404, CONFLICT -> 409. Anything unexpected is
 * logged server-side and reported as a generic 500, so stack traces, SQL and
 * connection details are never returned to a client.
 */
function medicineRequestError(res, error) {
  if (error instanceof MedicineRequestError) {
    const body = { error: error.message, code: error.code };
    // details only ever carry the caller's own figures (their stock, the
    // request's outstanding quantity), never another tenant's data.
    if (error.details !== undefined) body.details = error.details;
    return json(res, error.status, body);
  }
  console.error(error);
  return json(res, 500, { error: 'Internal server error.' });
}

/** Rejects any attempt to supply pharmacy context from the client. */
function rejectsClientPharmacy(res, input) {
  if (input && (input.pharmacyId !== undefined || input.pharmacy_id !== undefined)) {
    json(res, 400, { error: 'Client must not supply pharmacy_id. Pharmacy context is derived from the authenticated session.' });
    return true;
  }
  return false;
}

/** API shape for a medicine request. Internal columns are deliberately omitted. */
function serializeMedicineRequest(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    status: r.status,
    requesterPharmacyId: r.requester_pharmacy_id,
    medicineId: r.medicine_id,
    medicineName: r.medicine_name,
    requestedQuantity: r.requested_quantity,
    coveredQuantity: r.covered_quantity,
    remainingQuantity: Math.max(0, r.requested_quantity - r.covered_quantity),
    priority: r.priority,
    reason: r.reason,
    currentZoneIndex: r.current_zone_index,
    currentRadiusKm: r.current_radius_km,
    zoneCount: medicineRequestEngine.MEDICINE_REQUEST_ZONES_KM.length,
    maxRadiusKm: medicineRequestEngine.MEDICINE_REQUEST_MAX_RADIUS_KM,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
  if (r.offerSummary) out.offerSummary = r.offerSummary;
  return out;
}

/** API shape for an offer. */
function serializeMedicineOffer(o) {
  if (!o) return null;
  return {
    id: o.id,
    requestId: o.request_id,
    pharmacyId: o.pharmacy_id,
    pharmacyName: o.pharmacy_name === undefined ? undefined : o.pharmacy_name,
    status: o.status,
    offeredQuantity: o.offered_quantity,
    distanceKm: o.distance_km,
    zoneIndex: o.zone_index,
    usableStockAtContact: o.usable_stock_at_contact,
    declineReason: o.decline_reason,
    respondBy: o.respond_by,
    respondedAt: o.responded_at,
    contactedAt: o.contacted_at
  };
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(item => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
  }));
}

async function currentUser(req) {
  const token = parseCookies(req).mediindex_session;
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  if (!tokenHash) return null;

  const row = await db.prepare(`
    SELECT s.token_hash, s.user_id, s.pharmacy_id, s.expires_at,
           u.id, u.full_name, u.email, u.role, u.active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.active = 1
  `).get(tokenHash);

  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    try {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    } catch {}
    return null;
  }

  return {
    id: row.id,
    pharmacy_id: row.pharmacy_id,
    full_name: row.full_name,
    email: row.email,
    role: row.role
  };
}

function hashDeviceToken(token) {
  if (typeof token !== 'string') return '';
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

function parseDeviceToken(req) {
  const headerToken = req.headers['x-device-token'];
  if (headerToken && typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

async function currentDevice(req) {
  const rawToken = parseDeviceToken(req);
  if (!rawToken) return null;
  const tokenHash = hashDeviceToken(rawToken);
  const row = await db.prepare(`
    SELECT d.id, d.pharmacy_id, d.device_name, d.device_model, d.token_hash, d.paired_by, d.created_at, d.last_seen_at, d.revoked, d.revoked_at,
           p.name AS pharmacy_name, p.address AS pharmacy_address
    FROM paired_devices d
    JOIN pharmacies p ON p.id = d.pharmacy_id
    WHERE d.token_hash = ? AND d.revoked = 0
  `).get(tokenHash);

  if (!row) return null;

  try {
    await db.prepare('UPDATE paired_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  } catch {}

  return {
    id: row.id,
    pharmacyId: row.pharmacy_id,
    pharmacyName: row.pharmacy_name,
    pharmacyAddress: row.pharmacy_address,
    deviceName: row.device_name,
    deviceModel: row.device_model,
    pairedBy: row.paired_by,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON request body')); } });
    req.on('error', reject);
  });
}

async function refreshExpiryAlerts(pharmacyId) {
  await db.prepare(`DELETE FROM expiry_alerts WHERE id IN (
    SELECT a.id FROM expiry_alerts a JOIN medicine_batches b ON b.id=a.batch_id JOIN medicines m ON m.id=b.medicine_id
    WHERE m.pharmacy_id=? AND ((a.alert_type='EXPIRING_SOON' AND (b.quantity=0 OR b.expiry_date<${D_TODAY} OR b.expiry_date>${D_TODAY_30})) OR (a.alert_type='EXPIRED' AND (b.quantity=0 OR b.expiry_date>=${D_TODAY})))
  )`).run(pharmacyId);
  await db.prepare(`INSERT INTO expiry_alerts (batch_id, alert_type)
    SELECT b.id, CASE WHEN b.expiry_date<${D_TODAY} THEN 'EXPIRED' ELSE 'EXPIRING_SOON' END
    FROM medicine_batches b JOIN medicines m ON m.id=b.medicine_id
    WHERE m.pharmacy_id=? AND m.active=1 AND b.quantity>0 AND b.expiry_date<=${D_TODAY_30}
    ON CONFLICT (batch_id, alert_type) DO NOTHING`).run(pharmacyId);
}

async function dashboardFor(user) {
  await refreshExpiryAlerts(user.pharmacy_id);
  const pharmacyId = user.pharmacy_id;
  const single = async sql => (await db.prepare(sql).get(pharmacyId)).value;
  return {
    totalMedicines: await single('SELECT COUNT(*) AS value FROM medicines WHERE pharmacy_id = ? AND active = 1'),
    totalStock: await single('SELECT COALESCE(SUM(b.quantity), 0) AS value FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.pharmacy_id = ? AND m.active = 1'),
    expired: await single(`SELECT COUNT(*) AS value FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.pharmacy_id = ? AND b.quantity > 0 AND b.expiry_date < ${D_TODAY}`),
    expiringSoon: await single(`SELECT COUNT(*) AS value FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.pharmacy_id = ? AND b.quantity > 0 AND b.expiry_date >= ${D_TODAY} AND b.expiry_date <= ${D_TODAY_30}`),
    lowStock: await single('SELECT COUNT(*) AS value FROM medicines m WHERE m.pharmacy_id = ? AND m.active = 1 AND (SELECT COALESCE(SUM(quantity), 0) FROM medicine_batches WHERE medicine_id = m.id) <= m.minimum_stock'),
    todaySales: await single(`SELECT COALESCE(SUM(total_amount), 0) AS value FROM sales WHERE pharmacy_id = ? AND ${isPg ? "created_at::date = CURRENT_DATE" : "date(created_at) = CURRENT_DATE"}`)
  };
}

async function calculateDemandForecast(pharmacyId) {
  const medicines = await db.prepare(`
    SELECT m.id, m.name, m.generic_name, m.category, m.minimum_stock,
           (SELECT COALESCE(SUM(b.quantity), 0) 
            FROM medicine_batches b 
            WHERE b.medicine_id = m.id AND b.quantity > 0 AND b.expiry_date >= ${D_TODAY}) AS current_stock,
           (SELECT COALESCE(SUM(si.quantity), 0)
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            JOIN medicine_batches b ON b.id = si.batch_id
            WHERE b.medicine_id = m.id AND s.pharmacy_id = m.pharmacy_id) AS total_historical_sold
    FROM medicines m
    WHERE m.pharmacy_id = ? AND m.active = 1
    ORDER BY lower(m.name)
  `).all(pharmacyId);

  const forecastList = await Promise.all(medicines.map(async med => {
    const periods = await db.prepare(`
      SELECT ${D_WEEK} AS period_id,
             MIN(${D_DATE_OF('s.created_at')}) AS period_start,
             MAX(${D_DATE_OF('s.created_at')}) AS period_end,
             SUM(si.quantity) AS quantity_sold,
             SUM(si.line_total) AS revenue,
             COUNT(DISTINCT s.id) AS sales_count
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN medicine_batches b ON b.id = si.batch_id
      WHERE b.medicine_id = ? AND s.pharmacy_id = ?
      GROUP BY ${D_WEEK}
      ORDER BY period_id DESC
      LIMIT 8
    `).all(med.id, pharmacyId);

    const periodsCount = periods.length;
    const requiredPeriods = 3;

    if (periodsCount < requiredPeriods) {
      const reorderNeeded = Math.max(0, med.minimum_stock - Number(med.current_stock));
      return {
        medicineId: med.id,
        medicineName: med.name,
        genericName: med.generic_name,
        category: med.category,
        currentStock: Number(med.current_stock),
        minimumStock: med.minimum_stock,
        totalSold: med.total_historical_sold,
        status: 'INSUFFICIENT_DATA',
        message: 'INSUFFICIENT DATA FOR RELIABLE FORECAST',
        periodsFound: periodsCount,
        periodsRequired: requiredPeriods,
        historicalPeriods: periods,
        methodology: 'Weighted Moving Average (WMA) requires at least 3 historical sales periods',
        forecast: null,
        safetyStock: med.minimum_stock,
        recommendedReorder: reorderNeeded,
        riskLevel: Number(med.current_stock) <= med.minimum_stock ? (Number(med.current_stock) === 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK') : 'MONITORING'
      };
    }

    // Number() coercion is required here: PostgreSQL returns SUM(INTEGER) as a
    // bigint, which the pg driver hands to JavaScript as a string (e.g. '30').
    // JavaScript's + operator is overloaded — when either operand is a string it
    // concatenates rather than adds, so (p1 + p2 + p3) / 3 would compute
    // ('30' + '20' + '10') / 3 = 100670 instead of 20, corrupting mean, variance,
    // stdDev, safetyStock, and the reorder recommendation. The WMA line is
    // unaffected by this bug because * always coerces to number, but we normalise
    // all three quantities consistently here to keep the calculation safe against
    // the adapter's return type and any future query changes.
    // On SQLite, Number(30) === 30, so this is a no-op for local development.
    const p1 = Number(periods[0].quantity_sold);
    const p2 = Number(periods[1].quantity_sold);
    const p3 = Number(periods[2].quantity_sold);

    // Guard: if any period produced a non-finite value (should not occur given the
    // SQL SUM + WHERE filter, but defensive against future schema changes or
    // corrupted rows), fall back to INSUFFICIENT_DATA rather than propagating
    // NaN or Infinity through the forecast.
    if (!Number.isFinite(p1) || !Number.isFinite(p2) || !Number.isFinite(p3)) {
      const reorderNeeded = Math.max(0, med.minimum_stock - Number(med.current_stock));
      return {
        medicineId: med.id,
        medicineName: med.name,
        genericName: med.generic_name,
        category: med.category,
        currentStock: Number(med.current_stock),
        minimumStock: med.minimum_stock,
        totalSold: med.total_historical_sold,
        status: 'INSUFFICIENT_DATA',
        message: 'INSUFFICIENT DATA FOR RELIABLE FORECAST',
        periodsFound: periodsCount,
        periodsRequired: requiredPeriods,
        historicalPeriods: periods,
        methodology: 'Weighted Moving Average (WMA) requires at least 3 historical sales periods',
        forecast: null,
        safetyStock: med.minimum_stock,
        recommendedReorder: reorderNeeded,
        riskLevel: Number(med.current_stock) <= med.minimum_stock ? (Number(med.current_stock) === 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK') : 'MONITORING'
      };
    }

    const w1 = 0.50, w2 = 0.30, w3 = 0.20;
    const weeklyForecast = (w1 * p1) + (w2 * p2) + (w3 * p3);
    const monthlyForecast = Math.round(weeklyForecast * (30 / 7));

    const mean = (p1 + p2 + p3) / 3;
    const variance = ((p1 - mean) ** 2 + (p2 - mean) ** 2 + (p3 - mean) ** 2) / 2;
    const stdDev = Math.sqrt(variance);

    const calculatedSafetyStock = Math.round(1.65 * stdDev);
    const safetyStock = Math.max(med.minimum_stock, calculatedSafetyStock);

    // Number() coercion on current_stock: COALESCE(SUM(b.quantity), 0) returns
    // bigint on PostgreSQL, which the pg driver also delivers as a string.
    // Arithmetic operators coerce automatically, but explicit normalisation here
    // keeps the calculation safe and ensures currentStock in the API response is
    // always a number, not a string.
    const currentStock = Number(med.current_stock);

    const targetInventory = monthlyForecast + safetyStock;
    const recommendedReorder = Math.max(0, targetInventory - currentStock);

    let riskLevel = 'OPTIMAL_STOCK';
    if (currentStock <= 0) {
      riskLevel = 'OUT_OF_STOCK';
    } else if (currentStock < safetyStock) {
      riskLevel = 'HIGH_RUNOUT_RISK';
    } else if (currentStock < targetInventory) {
      riskLevel = 'REORDER_NEEDED';
    }

    return {
      medicineId: med.id,
      medicineName: med.name,
      genericName: med.generic_name,
      category: med.category,
      currentStock,
      minimumStock: med.minimum_stock,
      totalSold: med.total_historical_sold,
      status: 'RELIABLE',
      message: 'Reliable forecast computed via 3-period Weighted Moving Average',
      periodsFound: periodsCount,
      periodsRequired: requiredPeriods,
      historicalPeriods: periods.slice(0, 3),
      methodology: 'Weighted Moving Average (WMA: w1=0.50, w2=0.30, w3=0.20)',
      forecast: {
        weeklyDemand: Math.round(weeklyForecast * 100) / 100,
        monthly30DayDemand: monthlyForecast,
        historicalStdDev: Math.round(stdDev * 100) / 100,
        weightsApplied: { p1: w1, p2: w2, p3: w3 },
        periodData: [
          { period: periods[0].period_id, quantity: p1, weight: w1 },
          { period: periods[1].period_id, quantity: p2, weight: w2 },
          { period: periods[2].period_id, quantity: p3, weight: w3 }
        ]
      },
      safetyStock,
      recommendedReorder,
      riskLevel
    };
  }));

  const summary = {
    totalMedicines: forecastList.length,
    reliableCount: forecastList.filter(f => f.status === 'RELIABLE').length,
    insufficientDataCount: forecastList.filter(f => f.status === 'INSUFFICIENT_DATA').length,
    reorderNeededCount: forecastList.filter(f => f.recommendedReorder > 0).length,
    highRiskCount: forecastList.filter(f => f.riskLevel === 'HIGH_RUNOUT_RISK' || f.riskLevel === 'OUT_OF_STOCK').length
  };

  return { summary, items: forecastList };
}

function requireRole(res, user, ...roles) {
  if (!user) { json(res, 401, { error: 'Authentication required.' }); return false; }
  if (!roles.includes(user.role)) { json(res, 403, { error: 'You do not have permission for this action.' }); return false; }
  return true;
}

function cleanText(value, field, { required = false, max = 150 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) throw new Error(`${field} must be valid text up to ${max} characters.`);
  return value.trim();
}

function nonNegative(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${field} is required.`);
    return 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be a non-negative number.`);
  return number;
}

async function medicineById(id, pharmacyId) {
  return await db.prepare('SELECT id, pharmacy_id, name, generic_name, manufacturer, category, minimum_stock, active, created_at, updated_at FROM medicines WHERE id = ? AND pharmacy_id = ?').get(id, pharmacyId);
}

async function serializeMedicine(row) {
  const stockRow = await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS value FROM medicine_batches WHERE medicine_id = ?').get(row.id);
  return { ...row, total_stock: stockRow.value };
}

function parseAndValidateQrPayload(raw) {
  let payload = raw;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload.trim());
    } catch {
      const parts = payload.trim().split('|');
      if (parts.length >= 4 && parts[0] === 'MEDIINDEX') {
        payload = {
          app: parts[0],
          v: Number(parts[1].replace(/^v/i, '')) || 1,
          medicineId: Number(parts[2]),
          batchNumber: parts[3]
        };
      } else {
        throw new Error('QR payload is not recognized as a valid MediIndex code.');
      }
    }
  }

  if (!payload || typeof payload !== 'object') throw new Error('Invalid QR payload structure.');
  if (payload.app !== 'MEDIINDEX') throw new Error('Unrecognized application tag. Expected MEDIINDEX.');
  if (Number(payload.v) !== 1) throw new Error(`Unsupported QR version: ${payload.v}. Expected version 1.`);

  const medicineId = Number(payload.medicineId);
  if (!Number.isInteger(medicineId) || medicineId <= 0) throw new Error('Invalid medicine ID in QR payload.');

  const batchNumber = cleanText(payload.batchNumber, 'Batch number', { required: true, max: 80 });

  return { medicineId, batchNumber };
}

function serveFile(res, requestedPath) {
  const filePath = requestedPath === '/' ? path.join(__dirname, 'public', 'index.html') : path.join(__dirname, 'public', requestedPath);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) return false;
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png' };
  
  // Add cache control: no-cache for JS/CSS/HTML to prevent stale code during development
  const ext = path.extname(normalized);
  const cacheControl = ['.js', '.css', '.html'].includes(ext) ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600';
  
  res.writeHead(200, { 
    'Content-Type': types[ext] || 'application/octet-stream', 
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cacheControl
  });
  fs.createReadStream(normalized).pipe(res);
  return true;
}

// processMobileStockEntry is async because PostgreSQL operations are async.
async function processMobileStockEntry(device, input) {
  if (!input || typeof input !== 'object') {
    return { success: false, status: 'FAILED', errorCode: 'INVALID_INPUT', message: 'Operation payload must be an object.' };
  }

  if (input.pharmacyId !== undefined || input.pharmacy_id !== undefined) {
    return { success: false, status: 'FAILED', errorCode: 'TENANT_SPOOFING_REJECTED', message: 'Client must not supply pharmacy_id. Pharmacy context is determined authoritatively from the authenticated device.' };
  }

  let medicineId, batchNumber;
  try {
    const qrPayloadRaw = input.qrPayload || input.payload || input;
    const parsed = parseAndValidateQrPayload(qrPayloadRaw);
    medicineId = parsed.medicineId;
    batchNumber = parsed.batchNumber;
  } catch (err) {
    return { success: false, status: 'FAILED', errorCode: 'INVALID_QR_PAYLOAD', message: err.message };
  }

  if (input.quantity === undefined || input.quantity === null || input.quantity === '') {
    return { success: false, status: 'FAILED', errorCode: 'QUANTITY_REQUIRED', message: 'Quantity is required.' };
  }
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { success: false, status: 'FAILED', errorCode: 'INVALID_QUANTITY', message: 'Quantity must be a positive whole number greater than zero.' };
  }
  if (quantity > 100000) {
    return { success: false, status: 'FAILED', errorCode: 'QUANTITY_LIMIT_EXCEEDED', message: 'Quantity exceeds maximum allowable limit of 100,000 units per intake transaction.' };
  }

  let idempotencyKey = null;
  try {
    idempotencyKey = cleanText(input.idempotencyKey || input.idempotency_key, 'Idempotency key', { max: 120 });
  } catch (err) {
    return { success: false, status: 'FAILED', errorCode: 'INVALID_IDEMPOTENCY_KEY', message: err.message };
  }

  let requestHash = null;
  if (idempotencyKey) {
    requestHash = crypto.createHash('sha256').update(JSON.stringify({
      medicineId: Number(medicineId),
      batchNumber: String(batchNumber).trim(),
      quantity: Number(quantity)
    })).digest('hex');

    const existingKey = await db.prepare(`
      SELECT request_hash, response_status, response_body
      FROM idempotency_keys
      WHERE key = ? AND pharmacy_id = ?
    `).get(idempotencyKey, device.pharmacyId);

    if (existingKey) {
      if (existingKey.request_hash !== requestHash) {
        return { success: false, status: 'CONFLICT', errorCode: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key conflict: This idempotency key was previously used with a different request payload.' };
      }
      const cachedBody = JSON.parse(existingKey.response_body);
      cachedBody.idempotent = true;
      return { success: true, status: 'IDEMPOTENT', idempotent: true, data: cachedBody };
    }
  }

  try {
    return await db.transaction(async (client) => {
      const activeDev = await client.get('SELECT id, revoked FROM paired_devices WHERE id = ? AND revoked = 0', [device.id]);
      if (!activeDev) {
        return { success: false, status: 'FAILED', errorCode: 'DEVICE_REVOKED', message: 'Device has been revoked or is no longer authorized.' };
      }

      if (idempotencyKey) {
        const lockedExistingKey = await client.get(`
          SELECT request_hash, response_status, response_body
          FROM idempotency_keys
          WHERE key = ? AND pharmacy_id = ?
        `, [idempotencyKey, device.pharmacyId]);

        if (lockedExistingKey) {
          if (lockedExistingKey.request_hash !== requestHash) {
            return { success: false, status: 'CONFLICT', errorCode: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key conflict: This idempotency key was previously used with a different request payload.' };
          }
          const cachedBody = JSON.parse(lockedExistingKey.response_body);
          cachedBody.idempotent = true;
          return { success: true, status: 'IDEMPOTENT', idempotent: true, data: cachedBody };
        }
      }

      const medicine = await client.get(`
        SELECT id, name, generic_name, category
        FROM medicines
        WHERE id = ? AND pharmacy_id = ? AND active = 1
      `, [medicineId, device.pharmacyId]);

      if (!medicine) {
        return { success: false, status: 'FAILED', errorCode: 'MEDICINE_NOT_FOUND', message: `Active medicine ID ${medicineId} not found for this pharmacy.` };
      }

      const batch = await client.get(`
        SELECT id, batch_number, quantity, purchase_price, selling_price, expiry_date, location
        FROM medicine_batches
        WHERE medicine_id = ? AND batch_number = ?
      `, [medicine.id, batchNumber]);

      if (!batch) {
        return { success: false, status: 'FAILED', errorCode: 'BATCH_NOT_FOUND', message: `Batch '${batchNumber}' not found for medicine '${medicine.name}'.` };
      }

      await client.run('UPDATE medicine_batches SET quantity = quantity + ? WHERE id = ?', [quantity, batch.id]);

      let auditUserId = device.pairedBy;
      if (!auditUserId) {
        const adminUser = await client.get('SELECT id FROM users WHERE pharmacy_id = ? AND role = ? LIMIT 1', [device.pharmacyId, 'ADMIN']);
        auditUserId = adminUser ? adminUser.id : 1;
      }

      const movementRes = await client.run(`
        INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by, device_id)
        VALUES (?, ?, 'RECEIPT', ?, ?) RETURNING id
      `, [batch.id, quantity, auditUserId, device.id]);
      const movementId = Number(movementRes.lastInsertRowid);

      const newStock = batch.quantity + quantity;

      const responseData = {
        success: true,
        status: 'STOCK_UPDATED',
        idempotent: false,
        medicine: { id: medicine.id, name: medicine.name, genericName: medicine.generic_name, category: medicine.category },
        batch: { id: batch.id, batchNumber: batch.batch_number, quantityAdded: quantity, currentStock: newStock, expiryDate: batch.expiry_date, sellingPrice: batch.selling_price, location: batch.location },
        movementId,
        deviceId: device.id,
        timestamp: new Date().toISOString()
      };

      if (idempotencyKey) {
        await client.run(`
          INSERT INTO idempotency_keys (key, pharmacy_id, device_id, endpoint, request_hash, response_status, response_body)
          VALUES (?, ?, ?, '/api/mobile/stock-entry', ?, 200, ?)
        `, [idempotencyKey, device.pharmacyId, device.id, requestHash, JSON.stringify(responseData)]);
      }

      await refreshExpiryAlerts(device.pharmacyId);

      return { success: true, status: 'SYNCED', idempotent: false, data: responseData };
    });
  } catch (error) {
    if (error.message && isDuplicateError(error) && (error.message.includes('idempotency_keys') || error.message.includes('pk_idempotency_keys'))) {
      try {
        const fallbackKey = await db.prepare(`
          SELECT request_hash, response_status, response_body
          FROM idempotency_keys
          WHERE key = ? AND pharmacy_id = ?
        `).get(idempotencyKey, device.pharmacyId);
        if (fallbackKey) {
          if (fallbackKey.request_hash !== requestHash) {
            return { success: false, status: 'CONFLICT', errorCode: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key conflict: This idempotency key was previously used with a different request payload.' };
          }
          const cachedBody = JSON.parse(fallbackKey.response_body);
          cachedBody.idempotent = true;
          return { success: true, status: 'IDEMPOTENT', idempotent: true, data: cachedBody };
        }
      } catch {}
    }
    return { success: false, status: 'FAILED', errorCode: 'OPERATION_ERROR', message: error.message };
  }
}

// ─── processNearExpiryRedistribution ─────────────────────────────────────
/**
 * Scans near-expiry batches at `pharmacyId` and creates redistribution requests
 * to eligible nearby pharmacies that have a confirmed stock need.
 *
 * PROXIMITY RULE (strict):
 *   Both sender and recipient must have non-NULL latitude/longitude.
 *   If either coordinate is missing, the pair is skipped — no distance is invented.
 *   Only pairs within nearbyRadiusKm are eligible.
 *
 * NEED RULE:
 *   Recipient's current stock < minimum_stock for the matched medicine.
 *   INSUFFICIENT_DATA from demand forecasting is NOT a demand signal.
 *
 * DUPLICATE PREVENTION (atomic):
 *   Each request has a deterministic idempotency_key =
 *     SHA-256(sender_id|recipient_id|medicine_id|batch_id)
 *   A UNIQUE constraint on that column prevents concurrent duplicates at the
 *   database level; application-level read-before-write is a secondary guard.
 *
 * INVENTORY SAFETY:
 *   No stock is deducted or transferred. The request status ACCEPTED means
 *   the request is ready for manual fulfillment.
 *
 * @param {number}  pharmacyId  Sender pharmacy to scan.
 * @param {object}  [opts]      { nearExpiryDays, nearbyRadiusKm }
 * @returns {{ created, skippedDuplicate, skippedNoCoordinates, skippedSufficientStock, requests }}
 */
async function processNearExpiryRedistribution(pharmacyId, opts = {}) {
  const nearExpiryDays = Number.isInteger(opts.nearExpiryDays)  ? opts.nearExpiryDays  : NEAR_EXPIRY_DAYS;
  const nearbyRadiusKm = typeof opts.nearbyRadiusKm === 'number' ? opts.nearbyRadiusKm : NEARBY_RADIUS_KM;

  const cutoff      = isPg ? `(CURRENT_DATE + ${nearExpiryDays})` : `date(CURRENT_DATE, '+${nearExpiryDays} days')`;
  const daysLeftSQL = isPg ? '(b.expiry_date - CURRENT_DATE)' : 'CAST(julianday(b.expiry_date) - julianday(CURRENT_DATE) AS INTEGER)';

  // 1. Fetch sender pharmacy (need coordinates)
  const sender = await db.prepare('SELECT id, name, latitude, longitude FROM pharmacies WHERE id = ?').get(pharmacyId);
  if (!sender) return { created: 0, skippedDuplicate: 0, skippedNoCoordinates: 0, skippedSufficientStock: 0, requests: [] };

  // 2. Find qualifying near-expiry batches at sender
  const nearExpiryBatches = await db.prepare(`
    SELECT b.id AS batch_id, b.batch_number, b.quantity, b.expiry_date,
           ${daysLeftSQL} AS days_until_expiry,
           m.id AS medicine_id, m.name AS medicine_name, m.generic_name, m.minimum_stock
    FROM medicine_batches b
    JOIN medicines m ON m.id = b.medicine_id
    WHERE m.pharmacy_id = ?
      AND m.active = 1
      AND b.quantity > 0
      AND b.expiry_date >= ${D_TODAY}
      AND b.expiry_date <= ${cutoff}
    ORDER BY b.expiry_date ASC
  `).all(pharmacyId);

  if (nearExpiryBatches.length === 0) {
    return { created: 0, skippedDuplicate: 0, skippedNoCoordinates: 0, skippedSufficientStock: 0, requests: [] };
  }

  // 3. Fetch all other pharmacies (potential recipients, with their coordinates)
  const otherPharmacies = await db.prepare(
    'SELECT id, name, latitude, longitude FROM pharmacies WHERE id != ?'
  ).all(pharmacyId);

  let created = 0, skippedDuplicate = 0, skippedNoCoordinates = 0, skippedSufficientStock = 0;
  const requests = [];

  for (const batch of nearExpiryBatches) {
    for (const recipient of otherPharmacies) {

      // 4. PROXIMITY CHECK (strict — no fake distances)
      const sLat = sender.latitude    != null ? Number(sender.latitude)    : null;
      const sLng = sender.longitude   != null ? Number(sender.longitude)   : null;
      const rLat = recipient.latitude  != null ? Number(recipient.latitude)  : null;
      const rLng = recipient.longitude != null ? Number(recipient.longitude) : null;

      if (sLat === null || sLng === null || rLat === null || rLng === null) {
        skippedNoCoordinates++;
        continue;
      }

      const distKm = haversineKm(sLat, sLng, rLat, rLng);
      if (distKm > nearbyRadiusKm) {
        skippedNoCoordinates++;
        continue;
      }

      // 5. NEED CHECK — find matching medicine at recipient (by lower(name))
      const recipientMed = await db.prepare(`
        SELECT m.id, m.minimum_stock,
               COALESCE((SELECT SUM(b2.quantity) FROM medicine_batches b2
                         WHERE b2.medicine_id = m.id
                           AND b2.quantity > 0
                           AND b2.expiry_date >= ${D_TODAY}), 0) AS current_stock
        FROM medicines m
        WHERE m.pharmacy_id = ?
          AND m.active = 1
          AND lower(m.name) = lower(?)
        LIMIT 1
      `).get(recipient.id, batch.medicine_name);

      if (!recipientMed || Number(recipientMed.minimum_stock) <= 0) { skippedSufficientStock++; continue; }
      if (Number(recipientMed.current_stock) >= Number(recipientMed.minimum_stock)) { skippedSufficientStock++; continue; }

      // 6. REQUEST QUANTITY — amount needed to reach minimum_stock, bounded by available qty
      const deficit    = Number(recipientMed.minimum_stock) - Number(recipientMed.current_stock);
      const requestQty = Math.min(deficit, batch.quantity);
      if (requestQty <= 0) { skippedSufficientStock++; continue; }

      // 7. Deterministic idempotency key — prevents atomic duplicates via UNIQUE constraint
      const idemKey = crypto.createHash('sha256')
        .update(`${pharmacyId}|${recipient.id}|${batch.medicine_id}|${batch.batch_id}`)
        .digest('hex');

      // 8. Application-level duplicate guard (secondary; DB UNIQUE is authoritative)
      const existing = await db.prepare(
        "SELECT id FROM medicine_redistribution_requests WHERE idempotency_key = ? AND status IN ('PENDING','ACCEPTED')"
      ).get(idemKey);
      if (existing) { skippedDuplicate++; continue; }

      // 9. Insert request — auto-accepted immediately
      let requestId;
      try {
        const ins = await db.prepare(`
          INSERT INTO medicine_redistribution_requests
            (idempotency_key, sender_pharmacy_id, recipient_pharmacy_id, medicine_id,
             source_batch_id, requested_quantity, reason, request_type, status,
             automatic_request, automatic_acceptance, days_until_expiry, distance_km)
          VALUES (?, ?, ?, ?, ?, ?, 'NEAR_EXPIRY_REDISTRIBUTION', 'NEAR_EXPIRY', 'ACCEPTED',
                  1, 1, ?, ?) RETURNING id
        `).run(
          idemKey, pharmacyId, recipient.id, batch.medicine_id,
          batch.batch_id, requestQty,
          Number(batch.days_until_expiry),
          Math.round(distKm * 1000) / 1000
        );
        requestId = Number(ins.lastInsertRowid);
      } catch (err) {
        // UNIQUE constraint violation = concurrent duplicate — treat as skipped
        if (isDuplicateError(err)) { skippedDuplicate++; continue; }
        throw err;
      }

      created++;
      requests.push({
        id: requestId,
        senderPharmacyId:    pharmacyId,
        senderName:          sender.name,
        recipientPharmacyId: recipient.id,
        recipientName:       recipient.name,
        medicineId:          batch.medicine_id,
        medicineName:        batch.medicine_name,
        batchId:             batch.batch_id,
        batchNumber:         batch.batch_number,
        requestedQuantity:   requestQty,
        daysUntilExpiry:     Number(batch.days_until_expiry),
        distanceKm:          Math.round(distKm * 1000) / 1000,
        reason:              'NEAR_EXPIRY_REDISTRIBUTION',
        requestType:         'NEAR_EXPIRY',
        status:              'ACCEPTED',
        automaticRequest:    true,
        automaticAcceptance: true,
      });
    }
  }

  return { created, skippedDuplicate, skippedNoCoordinates, skippedSufficientStock, requests };
}

// Authoritative shelf/rack layout for this pharmacy floor plan.
// This is the single source of truth used by GET /api/layout/shelves and
// validated against by PUT /api/batches/:id/location.
const STANDARD_SHELVES = [
  { id: 'Rack A1', rack: 'RACK_A', label: 'A1 - Fast Moving Analgesics', zone: 'Front Left', description: 'Paracetamol, Ibuprofen, Aspirin' },
  { id: 'Rack A2', rack: 'RACK_A', label: 'A2 - Pain & Anti-inflammatory', zone: 'Front Left', description: 'Diclofenac, Aceclofenac' },
  { id: 'Rack A3', rack: 'RACK_A', label: 'A3 - Antipyretics & Cold', zone: 'Front Left', description: 'Cetirizine, Cough Syrups' },
  { id: 'Rack B1', rack: 'RACK_B', label: 'B1 - Broad Spectrum Antibiotics', zone: 'Front Right', description: 'Amoxicillin, Azithromycin' },
  { id: 'Rack B2', rack: 'RACK_B', label: 'B2 - Cephalosporins & Fluoroquinolones', zone: 'Front Right', description: 'Cefixime, Ciprofloxacin' },
  { id: 'Rack B3', rack: 'RACK_B', label: 'B3 - Antifungals & Antivirals', zone: 'Front Right', description: 'Fluconazole, Acyclovir' },
  { id: 'Rack C1', rack: 'RACK_C', label: 'C1 - Cardiovascular & Hypertension', zone: 'Rear Left', description: 'Amlodipine, Telmisartan, Atenolol' },
  { id: 'Rack C2', rack: 'RACK_C', label: 'C2 - Diabetes & Endocrine', zone: 'Rear Left', description: 'Metformin, Glimepiride' },
  { id: 'Rack C3', rack: 'RACK_C', label: 'C3 - Gastrointestinal & Antacids', zone: 'Rear Left', description: 'Pantoprazole, Omeprazole, Domperidone' },
  { id: 'Rack D1', rack: 'RACK_D', label: 'D1 - Dermatological Topicals & Ointments', zone: 'Rear Right', description: 'Betamethasone, Clotrimazole Cream' },
  { id: 'Rack D2', rack: 'RACK_D', label: 'D2 - Ophthalmic & Otic Drops', zone: 'Rear Right', description: 'Ciprofloxacin Eye Drops, Tears' },
  { id: 'Rack D3', rack: 'RACK_D', label: 'D3 - Respiratory & Inhalers', zone: 'Rear Right', description: 'Salbutamol, Budesonide Inhalers' },
  { id: 'Cold Storage F1', rack: 'RACK_COLD', label: 'Cold Bay F1 - Insulins & Biologics (2-8°C)', zone: 'Cold Refrigerator', description: 'Human Insulin, Glargine' },
  { id: 'Cold Storage F2', rack: 'RACK_COLD', label: 'Cold Bay F2 - Vaccines & Sera (2-8°C)', zone: 'Cold Refrigerator', description: 'Tetanus Toxoid, Rabies Vaccines' }
];
const VALID_SHELF_IDS = new Set(STANDARD_SHELVES.map(s => s.id.toLowerCase()));

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // On PostgreSQL, apply db/schema.pg.sql once per process before serving any
  // request. SQLite self-migrates in its initialize(); PostgreSQL previously did
  // not, so DDL appended to schema.pg.sql never reached the deployed database.
  // ensureSchema() is memoized and idempotent — effectively free after the first call.
  if (isPg && typeof adapter.ensureSchema === 'function') {
    try {
      await adapter.ensureSchema();
    } catch (err) {
      console.error('Schema initialization failed:', err);
      return json(res, 503, { error: 'The database is not ready. Please try again shortly.' });
    }
  }

  // Health check — performs a real DB query so connectivity is verified.
  if (req.method === 'GET' && url.pathname === '/api/health') {
    try {
      await db.prepare('SELECT 1 AS ok').get();
      return json(res, 200, { status: 'ok', database: 'connected' });
    } catch (err) {
      return json(res, 503, { status: 'error', database: 'unavailable', message: err.message });
    }
  }

  // QR Code generation endpoint (no auth required - generates QR for any payload)
  if (req.method === 'GET' && url.pathname === '/api/qr/generate') {
    const payload = url.searchParams.get('payload');
    if (!payload) {
      return json(res, 400, { error: 'Missing required parameter: payload' });
    }

    try {
      // Generate QR code as SVG using proven qrcode library
      const svg = await QRCode.toString(payload, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 256,
        color: {
          dark: '#102a43',
          light: '#ffffff'
        }
      });
      
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      res.writeHead(200);
      return res.end(svg);
    } catch (err) {
      console.error('QR generation error:', err);
      return json(res, 500, { error: 'QR code generation failed', message: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    try {
      const { email, password } = await readJson(req);
      if (typeof email !== 'string' || typeof password !== 'string') return json(res, 400, { error: 'Email and password are required.' });
      const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1').get(email.trim());
      if (!user || !passwordMatches(password, user.password_hash)) return json(res, 401, { error: 'Invalid email or password.' });

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashSessionToken(rawToken);
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

      await db.prepare(`
        INSERT INTO sessions (token_hash, user_id, pharmacy_id, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenHash, user.id, user.pharmacy_id, expiresAt);

      await db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
      return json(res, 200, { user: { fullName: user.full_name, email: user.email, role: user.role } }, { 'Set-Cookie': `mediindex_session=${rawToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const rawToken = parseCookies(req).mediindex_session;
    if (rawToken) {
      const tokenHash = hashSessionToken(rawToken);
      try {
        await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      } catch {}
    }
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'mediindex_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const user = await currentUser(req);

  if (req.method === 'GET' && url.pathname === '/api/auth/me') return user ? json(res, 200, { user }) : json(res, 401, { error: 'Authentication required.' });

  if (req.method === 'GET' && url.pathname === '/api/dashboard') return user ? json(res, 200, await dashboardFor(user)) : json(res, 401, { error: 'Authentication required.' });

  if (req.method === 'GET' && url.pathname === '/api/analytics/demand') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    return json(res, 200, await calculateDemandForecast(user.pharmacy_id));
  }

  if (req.method === 'GET' && url.pathname === '/api/expiry-alerts') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    await refreshExpiryAlerts(user.pharmacy_id);
    const status = url.searchParams.get('status') || 'ALL';
    const acknowledged = url.searchParams.get('acknowledged') || 'ALL';
    // acknowledged filter: pass null to match all rows, or the integer (0/1) to filter.
    // This avoids CAST(? AS INTEGER) which PostgreSQL evaluates eagerly even inside OR.
    const acknowledgedParam = acknowledged === 'ALL' ? null : parseInt(acknowledged, 10);
    const alerts = await db.prepare(`SELECT a.id, a.alert_type, a.acknowledged, a.created_at, m.id AS medicine_id, m.name AS medicine_name, b.id AS batch_id, b.batch_number, b.quantity, b.expiry_date, b.location,
      ${D_DAYS_LEFT_B} AS days_to_expiry
      FROM expiry_alerts a JOIN medicine_batches b ON b.id=a.batch_id JOIN medicines m ON m.id=b.medicine_id
      WHERE m.pharmacy_id=? AND (?='ALL' OR a.alert_type=?) AND (CAST(? AS INTEGER) IS NULL OR a.acknowledged=?)
      ORDER BY a.acknowledged ASC, CASE a.alert_type WHEN 'EXPIRED' THEN 0 ELSE 1 END, b.expiry_date ASC`).all(user.pharmacy_id, status, status, acknowledgedParam, acknowledgedParam);
    return json(res, 200, { alerts });
  }

  const acknowledgeMatch = url.pathname.match(/^\/api\/expiry-alerts\/(\d+)\/acknowledge$/);
  if (acknowledgeMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const result = await db.prepare(`UPDATE expiry_alerts SET acknowledged=1 WHERE id=? AND id IN (
      SELECT a.id FROM expiry_alerts a JOIN medicine_batches b ON b.id=a.batch_id JOIN medicines m ON m.id=b.medicine_id WHERE m.pharmacy_id=?
    )`).run(Number(acknowledgeMatch[1]), user.pharmacy_id);
    return result.changes ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Alert not found.' });
  }

  if (req.method === 'GET' && url.pathname === '/api/medicines') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const query = (url.searchParams.get('q') || '').trim();
    const rows = await db.prepare(`SELECT id, pharmacy_id, name, generic_name, manufacturer, category, minimum_stock, active, created_at, updated_at FROM medicines WHERE pharmacy_id = ? AND active = 1 AND (name LIKE ? OR generic_name LIKE ?) ORDER BY lower(name)`).all(user.pharmacy_id, `%${query}%`, `%${query}%`);
    return json(res, 200, { medicines: await Promise.all(rows.map(serializeMedicine)) });
  }

  if (req.method === 'GET' && url.pathname === '/api/medicines/inactive') {
    if (!requireRole(res, user, 'ADMIN')) return;
    const rows = await db.prepare(`SELECT id, pharmacy_id, name, generic_name, manufacturer, category, minimum_stock, active, created_at, updated_at FROM medicines WHERE pharmacy_id = ? AND active = 0 ORDER BY lower(name)`).all(user.pharmacy_id);
    return json(res, 200, { medicines: await Promise.all(rows.map(serializeMedicine)) });
  }

  if (req.method === 'POST' && url.pathname === '/api/medicines') {
    if (!requireRole(res, user, 'ADMIN')) return;
    try {
      const input = await readJson(req);
      const name = cleanText(input.name, 'Medicine name', { required: true });
      const generic = cleanText(input.genericName, 'Generic name');
      const manufacturer = cleanText(input.manufacturer, 'Manufacturer');
      const category = cleanText(input.category, 'Category');
      const minimumStock = nonNegative(input.minimumStock, 'Minimum stock');
      const result = await db.prepare('INSERT INTO medicines (pharmacy_id, name, generic_name, manufacturer, category, minimum_stock) VALUES (?, ?, ?, ?, ?, ?) RETURNING id').run(user.pharmacy_id, name, generic, manufacturer, category, minimumStock);
      return json(res, 201, { medicine: await serializeMedicine(await medicineById(Number(result.lastInsertRowid), user.pharmacy_id)) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  const medicineMatch = url.pathname.match(/^\/api\/medicines\/(\d+)$/);
  if (medicineMatch && req.method === 'PUT') {
    if (!requireRole(res, user, 'ADMIN')) return;
    try {
      const existing = await medicineById(Number(medicineMatch[1]), user.pharmacy_id);
      if (!existing || !existing.active) return json(res, 404, { error: 'Medicine not found.' });
      const input = await readJson(req);
      const name = cleanText(input.name, 'Medicine name', { required: true });
      const generic = cleanText(input.genericName, 'Generic name');
      const manufacturer = cleanText(input.manufacturer, 'Manufacturer');
      const category = cleanText(input.category, 'Category');
      const minimumStock = nonNegative(input.minimumStock, 'Minimum stock');
      await db.prepare("UPDATE medicines SET name=?, generic_name=?, manufacturer=?, category=?, minimum_stock=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name, generic, manufacturer, category, minimumStock, existing.id);
      return json(res, 200, { medicine: await serializeMedicine(await medicineById(existing.id, user.pharmacy_id)) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (medicineMatch && req.method === 'DELETE') {
    if (!requireRole(res, user, 'ADMIN')) return;
    const existing = await medicineById(Number(medicineMatch[1]), user.pharmacy_id);
    if (!existing || !existing.active) return json(res, 404, { error: 'Medicine not found.' });
    await db.prepare('UPDATE medicines SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(existing.id);
    return json(res, 200, { ok: true });
  }

  const reactivateMatch = url.pathname.match(/^\/api\/medicines\/(\d+)\/reactivate$/);
  if (reactivateMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN')) return;
    const target = await db.prepare('SELECT id, name, active, pharmacy_id FROM medicines WHERE id = ? AND pharmacy_id = ?').get(Number(reactivateMatch[1]), user.pharmacy_id);
    if (!target) return json(res, 404, { error: 'Medicine not found.' });
    if (target.active) return json(res, 409, { error: 'Medicine is already active.' });
    await db.prepare('UPDATE medicines SET active=1, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(target.id);
    return json(res, 200, { medicine: await serializeMedicine(await medicineById(target.id, user.pharmacy_id)) });
  }

  const batchListMatch = url.pathname.match(/^\/api\/medicines\/(\d+)\/batches$/);
  if (batchListMatch && req.method === 'GET') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const medicine = await medicineById(Number(batchListMatch[1]), user.pharmacy_id);
    if (!medicine || !medicine.active) return json(res, 404, { error: 'Medicine not found.' });
    const batches = await db.prepare(`SELECT id, batch_number, quantity, purchase_price, selling_price, manufacturing_date, expiry_date, location, ${expiryStatusCase('expiry_date')} AS expiry_status FROM medicine_batches WHERE medicine_id=? ORDER BY expiry_date, id`).all(medicine.id);
    return json(res, 200, { medicine: await serializeMedicine(medicine), batches });
  }

  if (batchListMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const medicine = await medicineById(Number(batchListMatch[1]), user.pharmacy_id);
      if (!medicine || !medicine.active) return json(res, 404, { error: 'Medicine not found.' });
      const input = await readJson(req);
      const batchNumber = cleanText(input.batchNumber, 'Batch number', { required: true, max: 80 });
      const quantity = nonNegative(input.quantity, 'Quantity', { required: true });
      const purchasePrice = nonNegative(input.purchasePrice, 'Purchase price');
      const sellingPrice = nonNegative(input.sellingPrice, 'Selling price', { required: true });
      const expiryDate = cleanText(input.expiryDate, 'Expiry date', { required: true, max: 10 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) || Number.isNaN(Date.parse(expiryDate))) throw new Error('Expiry date must use YYYY-MM-DD.');
      const manufacturingDate = cleanText(input.manufacturingDate, 'Manufacturing date', { max: 10 });
      const location = cleanText(input.location, 'Location', { max: 100 });
      const result = await db.prepare('INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, manufacturing_date, expiry_date, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id').run(medicine.id, batchNumber, quantity, purchasePrice, sellingPrice, manufacturingDate, expiryDate, location);
      await db.prepare("INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, 'RECEIPT', ?)").run(Number(result.lastInsertRowid), quantity, user.id);
      return json(res, 201, { batch: await db.prepare('SELECT * FROM medicine_batches WHERE id=?').get(Number(result.lastInsertRowid)) });
    } catch (error) { return json(res, 400, { error: isDuplicateError(error) ? 'This batch number already exists for the selected medicine.' : error.message }); }
  }

  const adjustmentMatch = url.pathname.match(/^\/api\/batches\/(\d+)\/adjustments$/);
  if (adjustmentMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const input = await readJson(req);
      const change = Number(input.changeQuantity);
      if (!Number.isInteger(change) || change === 0) throw new Error('Adjustment quantity must be a non-zero whole number.');
      const batch = await db.prepare('SELECT b.* FROM medicine_batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.id=? AND m.pharmacy_id=? AND m.active=1').get(Number(adjustmentMatch[1]), user.pharmacy_id);
      if (!batch) return json(res, 404, { error: 'Batch not found.' });
      if (batch.quantity + change < 0) return json(res, 400, { error: 'Adjustment would reduce stock below zero.' });
      await db.transaction(async (client) => {
        await client.run('UPDATE medicine_batches SET quantity=quantity + ? WHERE id=?', [change, batch.id]);
        await client.run("INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, 'ADJUSTMENT', ?)", [batch.id, change, user.id]);
      });
      return json(res, 200, { batch: await db.prepare('SELECT * FROM medicine_batches WHERE id=?').get(batch.id) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  const batchLocationMatch = url.pathname.match(/^\/api\/batches\/(\d+)\/location$/);
  if (batchLocationMatch && req.method === 'PUT') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const input = await readJson(req);
      const newLocation = cleanText(input.location, 'Location', { max: 100 });
      // Non-empty locations must match a shelf in the store layout exactly (case-insensitive).
      // Empty string is allowed — it clears the shelf assignment.
      if (newLocation && !VALID_SHELF_IDS.has(newLocation.toLowerCase())) {
        return json(res, 422, { error: `Invalid destination: "${newLocation}" is not a shelf in this store layout.` });
      }
      const batch = await db.prepare('SELECT b.* FROM medicine_batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.id=? AND m.pharmacy_id=? AND m.active=1').get(Number(batchLocationMatch[1]), user.pharmacy_id);
      if (!batch) return json(res, 404, { error: 'Batch not found.' });
      await db.prepare('UPDATE medicine_batches SET location = ? WHERE id = ?').run(newLocation, batch.id);
      return json(res, 200, { batch: await db.prepare('SELECT * FROM medicine_batches WHERE id=?').get(batch.id) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  const batchQrMatch = url.pathname.match(/^\/api\/batches\/(\d+)\/qr$/);
  if (batchQrMatch && req.method === 'GET') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const row = await db.prepare(`
      SELECT b.id AS batch_id, b.batch_number, b.quantity, b.selling_price, b.expiry_date, b.location,
             m.id AS medicine_id, m.name AS medicine_name, m.generic_name, m.category
      FROM medicine_batches b
      JOIN medicines m ON m.id = b.medicine_id
      WHERE b.id = ? AND m.pharmacy_id = ? AND m.active = 1
    `).get(Number(batchQrMatch[1]), user.pharmacy_id);
    if (!row) return json(res, 404, { error: 'Batch not found.' });

    const payload = { app: 'MEDIINDEX', v: 1, medicineId: row.medicine_id, batchNumber: row.batch_number };
    return json(res, 200, {
      payload,
      payloadString: JSON.stringify(payload),
      sticker: {
        medicineId: row.medicine_id, medicineName: row.medicine_name, genericName: row.generic_name,
        category: row.category, batchNumber: row.batch_number, expiryDate: row.expiry_date,
        sellingPrice: row.selling_price, currentStock: row.quantity, location: row.location
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/qr/lookup') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const input = await readJson(req);
      const { medicineId, batchNumber } = parseAndValidateQrPayload(input.payload);
      const row = await db.prepare(`
        SELECT b.id AS batch_id, b.batch_number, b.quantity, b.purchase_price, b.selling_price,
               b.manufacturing_date, b.expiry_date, b.location,
               ${expiryStatusCase('b.expiry_date')} AS expiry_status,
               m.id AS medicine_id, m.name AS medicine_name, m.generic_name, m.manufacturer, m.category, m.minimum_stock
        FROM medicine_batches b
        JOIN medicines m ON m.id = b.medicine_id
        WHERE m.id = ? AND b.batch_number = ? AND m.pharmacy_id = ? AND m.active = 1
      `).get(medicineId, batchNumber, user.pharmacy_id);
      if (!row) return json(res, 404, { error: `No active medicine batch found for ID ${medicineId} and lot '${batchNumber}'.` });
      return json(res, 200, {
        valid: true, authoritative: true,
        medicine: { id: row.medicine_id, name: row.medicine_name, genericName: row.generic_name, manufacturer: row.manufacturer, category: row.category, minimumStock: row.minimum_stock },
        batch: { id: row.batch_id, batchNumber: row.batch_number, quantity: row.quantity, purchasePrice: row.purchase_price, sellingPrice: row.selling_price, manufacturingDate: row.manufacturing_date, expiryDate: row.expiry_date, expiryStatus: row.expiry_status, location: row.location }
      });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/layout/shelves') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    await refreshExpiryAlerts(user.pharmacy_id);

    const standardShelves = STANDARD_SHELVES;

    const rows = await db.prepare(`
      SELECT b.id AS batch_id, b.batch_number, b.quantity, b.selling_price, b.purchase_price,
             b.manufacturing_date, b.expiry_date, b.location,
             ${expiryStatusCase('b.expiry_date')} AS expiry_status,
             m.id AS medicine_id, m.name AS medicine_name, m.generic_name, m.category, m.minimum_stock
      FROM medicine_batches b
      JOIN medicines m ON m.id = b.medicine_id
      WHERE m.pharmacy_id = ? AND m.active = 1
      ORDER BY b.location ASC, m.name ASC
    `).all(user.pharmacy_id);

    const shelfMap = new Map();
    standardShelves.forEach(s => shelfMap.set(s.id.toLowerCase(), { ...s, totalBatches: 0, totalUnits: 0, expiredBatches: 0, expiringSoonBatches: 0, batches: [] }));
    const unassignedBatches = [];

    rows.forEach(r => {
      const locKey = (r.location || '').trim().toLowerCase();
      let matchedShelf = null;
      for (const [key, shelf] of shelfMap.entries()) {
        if (locKey === key || locKey.includes(key) || (key.includes(locKey) && locKey.length > 2)) { matchedShelf = shelf; break; }
      }
      const batchItem = {
        id: r.batch_id, batchNumber: r.batch_number, quantity: r.quantity,
        sellingPrice: r.selling_price, expiryDate: r.expiry_date, expiryStatus: r.expiry_status,
        location: r.location || 'Unassigned',
        medicine: { id: r.medicine_id, name: r.medicine_name, genericName: r.generic_name, category: r.category }
      };
      if (matchedShelf) {
        matchedShelf.totalBatches += 1; matchedShelf.totalUnits += r.quantity;
        if (r.expiry_status === 'EXPIRED') matchedShelf.expiredBatches += 1;
        if (r.expiry_status === 'EXPIRING_SOON') matchedShelf.expiringSoonBatches += 1;
        matchedShelf.batches.push(batchItem);
      } else { unassignedBatches.push(batchItem); }
    });

    const shelves = Array.from(shelfMap.values());
    return json(res, 200, {
      layoutName: 'Standard Community Pharmacy Floor Plan',
      totalShelves: shelves.length,
      totalUnits: rows.reduce((sum, r) => sum + r.quantity, 0),
      shelves,
      unassigned: { totalBatches: unassignedBatches.length, totalUnits: unassignedBatches.reduce((sum, b) => sum + b.quantity, 0), batches: unassignedBatches }
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/sales') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const query = (url.searchParams.get('q') || '').trim();
    const rows = await db.prepare(`
      SELECT s.id, s.invoice_number, s.customer_name, s.customer_phone, s.payment_method, s.total_amount, s.created_at,
             u.full_name AS cashier_name,
             (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS total_items,
             (SELECT COALESCE(SUM(quantity), 0) FROM sale_items WHERE sale_id = s.id) AS total_units
      FROM sales s
      JOIN users u ON u.id = s.created_by
      WHERE s.pharmacy_id = ? AND (s.invoice_number LIKE ? OR COALESCE(s.customer_name, '') LIKE ?)
      ORDER BY s.created_at DESC
      LIMIT 50
    `).all(user.pharmacy_id, `%${query}%`, `%${query}%`);
    return json(res, 200, { sales: rows });
  }

  const saleDetailMatch = url.pathname.match(/^\/api\/sales\/(\d+)$/);
  if (saleDetailMatch && req.method === 'GET') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const sale = await db.prepare(`
      SELECT s.id, s.invoice_number, s.customer_name, s.customer_phone, s.payment_method, s.total_amount, s.created_at,
             u.full_name AS cashier_name
      FROM sales s JOIN users u ON u.id = s.created_by
      WHERE s.id = ? AND s.pharmacy_id = ?
    `).get(Number(saleDetailMatch[1]), user.pharmacy_id);
    if (!sale) return json(res, 404, { error: 'Sale record not found.' });
    const items = await db.prepare(`
      SELECT si.id, si.quantity, si.unit_price, si.line_total,
             b.batch_number, b.expiry_date,
             m.id AS medicine_id, m.name AS medicine_name, m.generic_name
      FROM sale_items si
      JOIN medicine_batches b ON b.id = si.batch_id
      JOIN medicines m ON m.id = b.medicine_id
      WHERE si.sale_id = ?
      ORDER BY si.id ASC
    `).all(sale.id);
    return json(res, 200, { sale: { ...sale, items } });
  }

  if (req.method === 'POST' && url.pathname === '/api/sales') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const input = await readJson(req);
      const customerName = cleanText(input.customerName, 'Customer name', { max: 100 });
      const customerPhone = cleanText(input.customerPhone, 'Customer phone', { max: 20 });
      const paymentMethod = cleanText(input.paymentMethod, 'Payment method', { max: 20 }) || 'CASH';
      const rawItems = Array.isArray(input.items) ? input.items : [];
      if (rawItems.length === 0) throw new Error('At least one item is required to generate a bill.');

      const requestedItems = rawItems.map((item, index) => {
        const medicineId = Number(item.medicineId);
        if (!Number.isInteger(medicineId) || medicineId <= 0) throw new Error(`Item ${index + 1}: Invalid medicine.`);
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`Item ${index + 1}: Quantity must be a positive whole number.`);
        const batchId = item.batchId ? Number(item.batchId) : null;
        return { medicineId, quantity, batchId };
      });

      const saleData = await db.transaction(async (client) => {
        const allocations = [];

        for (const item of requestedItems) {
          const medicine = await client.get('SELECT id, name FROM medicines WHERE id = ? AND pharmacy_id = ? AND active = 1', [item.medicineId, user.pharmacy_id]);
          if (!medicine) throw new Error(`Medicine ID ${item.medicineId} not found or is inactive.`);

          if (item.batchId) {
            const batch = await client.get(`
              SELECT b.id, b.batch_number, b.quantity, b.selling_price, b.expiry_date
              FROM medicine_batches b WHERE b.id = ? AND b.medicine_id = ?
            `, [item.batchId, medicine.id]);
            if (!batch) throw new Error(`Batch ID ${item.batchId} not found for medicine ${medicine.name}.`);
            if (new Date(batch.expiry_date) < new Date(new Date().toISOString().slice(0, 10))) {
              throw new Error(`Cannot dispense expired batch ${batch.batch_number} for medicine ${medicine.name}.`);
            }
            if (batch.quantity < item.quantity) {
              throw new Error(`Insufficient stock in batch ${batch.batch_number} for ${medicine.name}. Requested: ${item.quantity}, Available: ${batch.quantity}.`);
            }
            allocations.push({ batchId: batch.id, medicineId: medicine.id, medicineName: medicine.name, batchNumber: batch.batch_number, quantity: item.quantity, unitPrice: batch.selling_price, lineTotal: Math.round(item.quantity * batch.selling_price * 100) / 100 });
          } else {
            // FEFO automatic batch allocation (First-Expired, First-Out)
            const batches = await client.query(`
              SELECT b.id, b.batch_number, b.quantity, b.selling_price, b.expiry_date
              FROM medicine_batches b
              WHERE b.medicine_id = ? AND b.quantity > 0 AND b.expiry_date >= ${D_TODAY}
              ORDER BY b.expiry_date ASC, b.id ASC
            `, [medicine.id]);
            const totalAvailable = batches.reduce((sum, b) => sum + b.quantity, 0);
            if (totalAvailable < item.quantity) throw new Error(`Insufficient stock for ${medicine.name}. Requested: ${item.quantity}, Available: ${totalAvailable}.`);
            let needed = item.quantity;
            for (const b of batches) {
              if (needed <= 0) break;
              const take = Math.min(b.quantity, needed);
              allocations.push({ batchId: b.id, medicineId: medicine.id, medicineName: medicine.name, batchNumber: b.batch_number, quantity: take, unitPrice: b.selling_price, lineTotal: Math.round(take * b.selling_price * 100) / 100 });
              needed -= take;
            }
          }
        }

        const totalAmount = Math.round(allocations.reduce((sum, a) => sum + a.lineTotal, 0) * 100) / 100;
        const now = new Date();
        const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
        const countRow = await client.get(`SELECT COUNT(*) AS count FROM sales WHERE pharmacy_id = ? AND ${isPg ? "created_at::date = CURRENT_DATE" : "date(created_at) = CURRENT_DATE"}`, [user.pharmacy_id]);
        const invoiceNumber = `INV-${datePart}-${String(countRow.count + 1).padStart(4, '0')}`;

        const saleResult = await client.run(`
          INSERT INTO sales (pharmacy_id, invoice_number, customer_name, customer_phone, payment_method, total_amount, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
        `, [user.pharmacy_id, invoiceNumber, customerName, customerPhone, paymentMethod, totalAmount, user.id]);
        const saleId = Number(saleResult.lastInsertRowid);

        for (const a of allocations) {
          await client.run('INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?)', [saleId, a.batchId, a.quantity, a.unitPrice, a.lineTotal]);
          await client.run('UPDATE medicine_batches SET quantity = quantity - ? WHERE id = ?', [a.quantity, a.batchId]);
          await client.run("INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, 'SALE', ?)", [a.batchId, -a.quantity, user.id]);
        }

        return { saleId, invoiceNumber, totalAmount, allocations };
      });

      await refreshExpiryAlerts(user.pharmacy_id);

      return json(res, 201, {
        sale: {
          id: saleData.saleId, invoice_number: saleData.invoiceNumber,
          customer_name: customerName, customer_phone: customerPhone,
          payment_method: paymentMethod, total_amount: saleData.totalAmount,
          created_at: new Date().toISOString(), cashier: user.full_name,
          items: saleData.allocations
        }
      });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  // Mobile Device One-Time Pairing & Device Management Routes
  if (req.method === 'GET' && (url.pathname === '/api/mobile/auth/verify' || url.pathname === '/api/mobile/verify')) {
    const device = await currentDevice(req);
    if (!device) return json(res, 401, { error: 'Invalid or revoked device token.' });
    return json(res, 200, {
      valid: true,
      device: { id: device.id, name: device.deviceName, model: device.deviceModel, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt },
      pharmacy: { id: device.pharmacyId, name: device.pharmacyName, address: device.pharmacyAddress }
    });
  }

  if (req.method === 'POST' && (url.pathname === '/api/mobile/pairing/create' || url.pathname === '/api/mobile/pairing/generate')) {
    if (!requireRole(res, user, 'ADMIN')) return;
    try {
      const pairingCode = 'MED-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      const expiresInSeconds = 600;
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
      await db.prepare(`
        INSERT INTO device_pairing_codes (pharmacy_id, pairing_code, created_by, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(user.pharmacy_id, pairingCode, user.id, expiresAt);
      return json(res, 201, { pairingCode, expiresAt, expiresInSeconds });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (req.method === 'POST' && (url.pathname === '/api/mobile/pairing/complete' || url.pathname === '/api/mobile/pairing/claim')) {
    try {
      const input = await readJson(req);
      const pairingCode = cleanText(input.pairingCode || input.code, 'Pairing code', { required: true, max: 50 });
      const deviceName = cleanText(input.deviceName || input.deviceLabel || input.name, 'Device name', { required: true, max: 100 });
      const deviceModel = cleanText(input.deviceModel || input.model, 'Device model', { max: 100 });

      const pairingResult = await db.transaction(async (client) => {
        const record = await client.get(`
          SELECT id, pharmacy_id, pairing_code, expires_at, used, created_by
          FROM device_pairing_codes
          WHERE UPPER(pairing_code) = UPPER(?)
        `, [pairingCode]);

        if (!record) throw Object.assign(new Error('Invalid or unrecognized pairing code.'), { status: 400 });
        if (record.used === 1) throw Object.assign(new Error('This pairing code has already been used.'), { status: 400 });
        if (new Date(record.expires_at).getTime() < Date.now()) throw Object.assign(new Error('This pairing code has expired.'), { status: 400 });

        const updateRes = await client.run(`
          UPDATE device_pairing_codes SET used = 1, used_at = CURRENT_TIMESTAMP
          WHERE id = ? AND used = 0
        `, [record.id]);
        if (updateRes.changes === 0) throw Object.assign(new Error('This pairing code has already been claimed.'), { status: 400 });

        const rawDeviceToken = 'medidev_' + crypto.randomBytes(32).toString('hex');
        const tokenHash = hashDeviceToken(rawDeviceToken);

        const insertDevice = await client.run(`
          INSERT INTO paired_devices (pharmacy_id, device_name, device_model, token_hash, paired_by)
          VALUES (?, ?, ?, ?, ?) RETURNING id
        `, [record.pharmacy_id, deviceName, deviceModel, tokenHash, record.created_by]);

        const deviceId = Number(insertDevice.lastInsertRowid);
        const pharmacy = await client.get('SELECT id, name, address FROM pharmacies WHERE id = ?', [record.pharmacy_id]);

        return { deviceId, rawDeviceToken, pharmacy };
      });

      return json(res, 201, {
        success: true, deviceId: pairingResult.deviceId, deviceName,
        deviceToken: pairingResult.rawDeviceToken,
        pharmacy: { id: pairingResult.pharmacy.id, name: pairingResult.pharmacy.name, address: pairingResult.pharmacy.address },
        pairedAt: new Date().toISOString()
      });
    } catch (error) { return json(res, error.status || 400, { error: error.message }); }
  }

  if (req.method === 'GET' && url.pathname === '/api/mobile/devices') {
    if (!requireRole(res, user, 'ADMIN')) return;
    const devices = await db.prepare(`
      SELECT id, device_name, device_model, created_at, last_seen_at, revoked, revoked_at
      FROM paired_devices WHERE pharmacy_id = ? ORDER BY created_at DESC
    `).all(user.pharmacy_id);
    return json(res, 200, { devices });
  }

  const deviceRevokeMatch = url.pathname.match(/^\/api\/mobile\/devices\/(\d+)\/revoke$/);
  if (deviceRevokeMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN')) return;
    const device = await db.prepare(`
      SELECT id, pharmacy_id, device_name, revoked FROM paired_devices
      WHERE id = ? AND pharmacy_id = ?
    `).get(Number(deviceRevokeMatch[1]), user.pharmacy_id);
    if (!device) return json(res, 404, { error: 'Device not found for this pharmacy.' });
    if (device.revoked === 1) return json(res, 200, { ok: true, message: 'Device is already revoked.', deviceId: device.id });
    await db.prepare(`UPDATE paired_devices SET revoked = 1, revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(device.id);
    return json(res, 200, { ok: true, message: `Device '${device.device_name}' has been successfully revoked.`, device: { id: device.id, deviceName: device.device_name, revoked: 1, revokedAt: new Date().toISOString() } });
  }

  if (req.method === 'POST' && url.pathname === '/api/mobile/stock-entry') {
    const device = await currentDevice(req);
    if (!device) return json(res, 401, { error: 'Device authentication required. Invalid or revoked device token.' });
    try {
      const input = await readJson(req);
      const result = await processMobileStockEntry(device, input);
      if (result.success) return json(res, 200, result.data);
      if (result.status === 'CONFLICT') return json(res, 409, { error: result.message });
      if (result.errorCode === 'MEDICINE_NOT_FOUND' || result.errorCode === 'BATCH_NOT_FOUND') return json(res, 404, { error: result.message });
      return json(res, 400, { error: result.message });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (req.method === 'POST' && url.pathname === '/api/mobile/stock-entry/batch-sync') {
    const device = await currentDevice(req);
    if (!device) return json(res, 401, { error: 'Device authentication required. Invalid or revoked device token.' });
    try {
      const body = await readJson(req);
      if (body.pharmacyId !== undefined || body.pharmacy_id !== undefined) return json(res, 400, { error: 'Client must not supply pharmacy_id. Pharmacy context is determined authoritatively from the authenticated device.' });
      if (!body.operations || !Array.isArray(body.operations)) return json(res, 400, { error: 'Invalid request: "operations" must be a non-empty array.' });
      if (body.operations.length === 0) return json(res, 400, { error: 'Operations array must not be empty.' });
      if (body.operations.length > 100) return json(res, 400, { error: 'Batch size exceeds maximum allowable limit of 100 operations per request.' });

      const results = [];
      let syncedCount = 0, idempotentCount = 0, failedCount = 0;

      for (let i = 0; i < body.operations.length; i++) {
        const op = body.operations[i];
        const operationId = op && op.operationId ? String(op.operationId).trim() : `op-${i + 1}`;
        const opResult = await processMobileStockEntry(device, op);
        if (opResult.success) {
          if (opResult.idempotent) {
            idempotentCount++;
            results.push({ operationId, status: 'IDEMPOTENT', idempotent: true, movementId: opResult.data.movementId, batchId: opResult.data.batch ? opResult.data.batch.id : undefined, batchNumber: opResult.data.batch ? opResult.data.batch.batchNumber : undefined, quantityAdded: opResult.data.batch ? opResult.data.batch.quantityAdded : undefined, currentStock: opResult.data.batch ? opResult.data.batch.currentStock : undefined, timestamp: opResult.data.timestamp });
          } else {
            syncedCount++;
            results.push({ operationId, status: 'SYNCED', idempotent: false, movementId: opResult.data.movementId, batchId: opResult.data.batch.id, batchNumber: opResult.data.batch.batchNumber, quantityAdded: opResult.data.batch.quantityAdded, currentStock: opResult.data.batch.currentStock, timestamp: opResult.data.timestamp });
          }
        } else {
          failedCount++;
          results.push({ operationId, status: opResult.status || 'FAILED', errorCode: opResult.errorCode || 'OPERATION_FAILED', message: opResult.message });
        }
      }

      return json(res, 200, { success: true, deviceId: device.id, pharmacyId: device.pharmacyId, summary: { total: body.operations.length, synced: syncedCount, idempotent: idempotentCount, failed: failedCount }, results });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  // ─── POST /api/mobile/qr/lookup ─────────────────────────────────────────
  // Mobile device-authenticated QR lookup without inventory mutation.
  // Validates QR payload and returns medicine/batch information for scanning.
  if (req.method === 'POST' && url.pathname === '/api/mobile/qr/lookup') {
    const device = await currentDevice(req);
    if (!device) return json(res, 401, { error: 'Device authentication required. Invalid or revoked device token.' });

    try {
      const input = await readJson(req);
      
      // Parse and validate QR payload using existing validation logic
      let medicineId, batchNumber;
      try {
        const qrPayloadRaw = input.qrPayload || input.payload || input;
        const parsed = parseAndValidateQrPayload(qrPayloadRaw);
        medicineId = parsed.medicineId;
        batchNumber = parsed.batchNumber;
      } catch (err) {
        return json(res, 400, { error: 'Invalid QR payload: ' + err.message });
      }

      // Lookup medicine and batch information without mutation
      const medicine = await db.prepare(`
        SELECT id, name, generic_name, manufacturer, category, minimum_stock
        FROM medicines
        WHERE id = ? AND pharmacy_id = ? AND active = 1
      `).get(medicineId, device.pharmacyId);

      if (!medicine) {
        return json(res, 404, { 
          valid: false, 
          authoritative: true,
          error: `Medicine ID ${medicineId} not found for this pharmacy.` 
        });
      }

      const batch = await db.prepare(`
        SELECT id, batch_number, quantity, purchase_price, selling_price, 
               manufacturing_date, expiry_date, location
        FROM medicine_batches
        WHERE medicine_id = ? AND batch_number = ?
      `).get(medicine.id, batchNumber);

      if (!batch) {
        return json(res, 404, { 
          valid: false, 
          authoritative: true,
          medicine: {
            id: medicine.id,
            name: medicine.name,
            genericName: medicine.generic_name,
            manufacturer: medicine.manufacturer,
            category: medicine.category,
            minimumStock: medicine.minimum_stock
          },
          error: `Batch '${batchNumber}' not found for medicine '${medicine.name}'.` 
        });
      }

      // Calculate expiry status
      const today = new Date();
      const expiryDate = new Date(batch.expiry_date);
      const daysUntilExpiry = Math.floor((expiryDate - today) / (1000 * 60 * 60 * 24));
      let expiryStatus;
      if (daysUntilExpiry < 0) {
        expiryStatus = 'EXPIRED';
      } else if (daysUntilExpiry <= 30) {
        expiryStatus = 'NEAR_EXPIRY';
      } else {
        expiryStatus = 'VALID';
      }

      return json(res, 200, {
        valid: true,
        authoritative: true,
        medicine: {
          id: medicine.id,
          name: medicine.name,
          genericName: medicine.generic_name,
          manufacturer: medicine.manufacturer,
          category: medicine.category,
          minimumStock: medicine.minimum_stock
        },
        batch: {
          id: batch.id,
          batchNumber: batch.batch_number,
          quantity: batch.quantity,
          purchasePrice: batch.purchase_price,
          sellingPrice: batch.selling_price,
          manufacturingDate: batch.manufacturing_date,
          expiryDate: batch.expiry_date,
          expiryStatus: expiryStatus,
          location: batch.location
        }
      });

    } catch (error) {
      return json(res, 500, { error: 'Internal server error during QR lookup.' });
    }
  }

  // ─── POST /api/sync/stock-receipt ─────────────────────────────────────────
  // Browser-session-authenticated stock receipt with idempotency.
  // Equivalent to processMobileStockEntry but authenticated via browser session
  // (cookie) rather than a paired device token.  Pharmacy and user are derived
  // authoritatively from the session — the client never supplies them.
  if (req.method === 'POST' && url.pathname === '/api/sync/stock-receipt') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const input = await readJson(req);

      // Reject any attempt to spoof pharmacy context
      if (input.pharmacyId !== undefined || input.pharmacy_id !== undefined) {
        return json(res, 400, { error: 'Client must not supply pharmacy_id. Pharmacy context is derived from the authenticated session.' });
      }

      const medicineId = Number(input.medicineId);
      if (!Number.isInteger(medicineId) || medicineId <= 0) return json(res, 400, { error: 'Invalid medicine ID.' });

      const batchNumber = cleanText(input.batchNumber, 'Batch number', { required: true, max: 80 });
      const quantity = Number(input.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) return json(res, 400, { error: 'Quantity must be a positive whole number.' });
      if (quantity > 100000) return json(res, 400, { error: 'Quantity exceeds maximum allowable limit of 100,000 units.' });

      const idempotencyKey = cleanText(input.idempotencyKey, 'Idempotency key', { required: true, max: 120 });

      // Stable request hash — same inputs always produce the same hash
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({
        medicineId,
        batchNumber: batchNumber.trim(),
        quantity
      })).digest('hex');

      // Pre-check idempotency (outside transaction — fast path for retries)
      const existingKey = await db.prepare(
        'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = ? AND pharmacy_id = ?'
      ).get(idempotencyKey, user.pharmacy_id);

      if (existingKey) {
        if (existingKey.request_hash !== requestHash) {
          return json(res, 409, { error: 'Idempotency key conflict: same key was previously used with a different payload.' });
        }
        const cached = JSON.parse(existingKey.response_body);
        cached.idempotent = true;
        return json(res, 200, { ...cached, idempotent: true, status: 'IDEMPOTENT' });
      }

      // Execute inside a transaction
      const result = await db.transaction(async (client) => {
        // Double-check under lock (handles concurrent retries)
        const lockedKey = await client.get(
          'SELECT request_hash, response_body FROM idempotency_keys WHERE key = ? AND pharmacy_id = ?',
          [idempotencyKey, user.pharmacy_id]
        );
        if (lockedKey) {
          if (lockedKey.request_hash !== requestHash) {
            return { conflict: true };
          }
          const cached = JSON.parse(lockedKey.response_body);
          cached.idempotent = true;
          return { idempotent: true, data: cached };
        }

        const medicine = await client.get(
          'SELECT id, name, generic_name, category FROM medicines WHERE id = ? AND pharmacy_id = ? AND active = 1',
          [medicineId, user.pharmacy_id]
        );
        if (!medicine) return { notFound: true, error: `Active medicine ID ${medicineId} not found for this pharmacy.` };

        const batch = await client.get(
          'SELECT id, batch_number, quantity, selling_price, expiry_date, location FROM medicine_batches WHERE medicine_id = ? AND batch_number = ?',
          [medicine.id, batchNumber]
        );
        if (!batch) return { notFound: true, error: `Batch '${batchNumber}' not found for medicine '${medicine.name}'.` };

        await client.run('UPDATE medicine_batches SET quantity = quantity + ? WHERE id = ?', [quantity, batch.id]);

        const movementRes = await client.run(
          "INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, 'RECEIPT', ?) RETURNING id",
          [batch.id, quantity, user.id]
        );
        const movementId = Number(movementRes.lastInsertRowid);
        const newStock = batch.quantity + quantity;

        const responseData = {
          success: true,
          status: 'SYNCED',
          idempotent: false,
          medicine: { id: medicine.id, name: medicine.name, genericName: medicine.generic_name, category: medicine.category },
          batch: { id: batch.id, batchNumber: batch.batch_number, quantityAdded: quantity, currentStock: newStock, expiryDate: batch.expiry_date, sellingPrice: batch.selling_price, location: batch.location },
          movementId,
          userId: user.id,
          timestamp: new Date().toISOString()
        };

        // Record idempotency key (device_id = NULL for browser-session receipts)
        await client.run(
          `INSERT INTO idempotency_keys (key, pharmacy_id, device_id, endpoint, request_hash, response_status, response_body)
           VALUES (?, ?, NULL, '/api/sync/stock-receipt', ?, 200, ?)`,
          [idempotencyKey, user.pharmacy_id, requestHash, JSON.stringify(responseData)]
        );

        await refreshExpiryAlerts(user.pharmacy_id);
        return { ok: true, data: responseData };
      });

      if (result.conflict) return json(res, 409, { error: 'Idempotency key conflict: same key was previously used with a different payload.' });
      if (result.notFound) return json(res, 404, { error: result.error });
      if (result.idempotent) return json(res, 200, result.data);
      return json(res, 200, result.data);
    } catch (error) {
      if (isDuplicateError(error) && (error.message || '').includes('idempotency_keys')) {
        return json(res, 409, { error: 'Idempotency key conflict.' });
      }
      return json(res, 400, { error: error.message });
    }
  }

  // ─── POST /api/inter-pharmacy/near-expiry/process ─────────────────────────
  // Triggers the near-expiry redistribution scan. Idempotent — safe to re-run.
  // ADMIN only. Pharmacy derived from session; client cannot supply it.
  if (req.method === 'POST' && url.pathname === '/api/inter-pharmacy/near-expiry/process') {
    if (!requireRole(res, user, 'ADMIN')) return;
    try {
      const body = await readJson(req);
      const opts = {};
      if (body.nearExpiryDays !== undefined) {
        const d = Number(body.nearExpiryDays);
        if (!Number.isInteger(d) || d < 1 || d > 365)
          return json(res, 400, { error: 'nearExpiryDays must be an integer between 1 and 365.' });
        opts.nearExpiryDays = d;
      }
      if (body.nearbyRadiusKm !== undefined) {
        const r = Number(body.nearbyRadiusKm);
        if (!Number.isFinite(r) || r <= 0)
          return json(res, 400, { error: 'nearbyRadiusKm must be a positive number.' });
        opts.nearbyRadiusKm = r;
      }
      const result = await processNearExpiryRedistribution(user.pharmacy_id, opts);
      return json(res, 200, {
        ...result,
        nearExpiryDays: opts.nearExpiryDays ?? NEAR_EXPIRY_DAYS,
        nearbyRadiusKm: opts.nearbyRadiusKm ?? NEARBY_RADIUS_KM,
      });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  // ─── GET /api/inter-pharmacy/requests ─────────────────────────────────────
  // Lists redistribution requests where the authenticated pharmacy is sender or recipient.
  if (req.method === 'GET' && url.pathname === '/api/inter-pharmacy/requests') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const role   = url.searchParams.get('role')   || 'ALL'; // ALL | SENDER | RECIPIENT
    const status = url.searchParams.get('status') || 'ALL';
    const pid = user.pharmacy_id;
    const rows = await db.prepare(`
      SELECT r.id, r.idempotency_key,
             r.sender_pharmacy_id, sp.name AS sender_name,
             r.recipient_pharmacy_id, rp.name AS recipient_name,
             r.medicine_id, m.name AS medicine_name, m.generic_name,
             r.source_batch_id, b.batch_number,
             r.requested_quantity, r.reason, r.request_type, r.status,
             r.automatic_request, r.automatic_acceptance,
             r.days_until_expiry, r.distance_km, r.notes,
             r.created_at, r.updated_at
      FROM medicine_redistribution_requests r
      JOIN pharmacies sp ON sp.id = r.sender_pharmacy_id
      JOIN pharmacies rp ON rp.id = r.recipient_pharmacy_id
      JOIN medicines  m  ON m.id  = r.medicine_id
      JOIN medicine_batches b ON b.id = r.source_batch_id
      WHERE (
            (?  = 'ALL'       AND (r.sender_pharmacy_id = ? OR r.recipient_pharmacy_id = ?))
         OR (? = 'SENDER'    AND r.sender_pharmacy_id    = ?)
         OR (? = 'RECIPIENT' AND r.recipient_pharmacy_id = ?)
      )
      AND (? = 'ALL' OR r.status = ?)
      ORDER BY r.created_at DESC
      LIMIT 200
    `).all(
      role, pid, pid,
      role, pid,
      role, pid,
      status, status
    );
    return json(res, 200, { requests: rows });
  }

  // ─── POST /api/inter-pharmacy/requests/:id/status ─────────────────────────
  // Transitions a request status (e.g. ACCEPTED → COMPLETED or CANCELLED).
  const redistMatch = url.pathname.match(/^\/api\/inter-pharmacy\/requests\/(\d+)\/status$/);
  if (redistMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN')) return;
    try {
      const reqId = Number(redistMatch[1]);
      const input = await readJson(req);
      const newStatus = cleanText(input.status, 'status', { required: true, max: 20 });
      const validTransitions = {
        PENDING:   ['ACCEPTED', 'REJECTED', 'CANCELLED'],
        ACCEPTED:  ['COMPLETED', 'CANCELLED'],
        REJECTED:  [],
        CANCELLED: [],
        COMPLETED: [],
      };
      // Must belong to authenticated pharmacy (sender or recipient) — tenant isolation
      const existing = await db.prepare(`
        SELECT id, status FROM medicine_redistribution_requests
        WHERE id = ? AND (sender_pharmacy_id = ? OR recipient_pharmacy_id = ?)
      `).get(reqId, user.pharmacy_id, user.pharmacy_id);
      if (!existing) return json(res, 404, { error: 'Request not found.' });
      const allowed = validTransitions[existing.status] || [];
      if (!allowed.includes(newStatus))
        return json(res, 409, { error: `Cannot transition from '${existing.status}' to '${newStatus}'.` });
      await db.prepare(
        "UPDATE medicine_redistribution_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
      ).run(newStatus, reqId);
      const updated = await db.prepare(
        'SELECT * FROM medicine_redistribution_requests WHERE id = ?'
      ).get(reqId);
      return json(res, 200, { request: updated });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MANUAL MEDICINE REQUESTS — progressive geographic search
  //
  // Every rule lives in medicineRequestEngine (Phase 2). These handlers only
  // authenticate, authorize, derive the pharmacy from the session, translate
  // input/output, and map domain errors onto HTTP. No business logic is
  // duplicated here, and no route touches inventory.
  //
  // Normal pharmacy operation is available to STAFF and ADMIN alike.
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── GET /api/inter-pharmacy/medicine-requests/incoming ───────────────────
  // Requests this pharmacy has actually been contacted for. Declared before the
  // /:id routes so the literal path is never treated as an identifier.
  if (req.method === 'GET' && url.pathname === '/api/inter-pharmacy/medicine-requests/incoming') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const incoming = await medicineRequestEngine.listIncomingForPharmacy(user.pharmacy_id);
      return json(res, 200, { incoming, count: incoming.length });
    } catch (error) { return medicineRequestError(res, error); }
  }

  // ─── POST /api/inter-pharmacy/medicine-requests/maintenance/expire ────────
  // ADMIN-only, and tenant-scoped: expires only this pharmacy's own overdue
  // requests and the offers belonging to / addressed to this pharmacy. The
  // unscoped sweep remains an internal service call and is never exposed.
  if (req.method === 'POST' && url.pathname === '/api/inter-pharmacy/medicine-requests/maintenance/expire') {
    if (!requireRole(res, user, 'ADMIN')) return;
    try {
      const result = await medicineRequestEngine.expireDue({ pharmacyId: user.pharmacy_id });
      return json(res, 200, { ...result, scope: 'PHARMACY' });
    } catch (error) { return medicineRequestError(res, error); }
  }

  // ─── POST /api/inter-pharmacy/medicine-requests ───────────────────────────
  // Creates a request. Requester pharmacy and user come from the session only.
  if (req.method === 'POST' && url.pathname === '/api/inter-pharmacy/medicine-requests') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const input = await readJson(req);
      if (rejectsClientPharmacy(res, input)) return;
      if (input.requesterPharmacyId !== undefined) {
        return json(res, 400, { error: 'Client must not supply requesterPharmacyId. Pharmacy context is derived from the authenticated session.' });
      }

      const result = await medicineRequestEngine.createRequest({
        pharmacyId: user.pharmacy_id,          // authoritative
        userId: user.user_id || user.id,       // authoritative
        medicineName: input.medicineName,
        medicineId: Number.isInteger(input.medicineId) ? input.medicineId : undefined,
        requestedQuantity: input.requestedQuantity,
        priority: input.priority,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey
      });

      // Kick off the progressive search immediately so the first zone is
      // contacted as part of creation. Failure here must not void the request.
      let search = null;
      if (result.created) {
        try {
          search = await medicineRequestEngine.advanceRequest(result.request.id);
        } catch (err) { console.error('Initial medicine-request advance failed:', err); }
      }

      const fresh = await medicineRequestEngine.getRequestDetail(result.request.id, user.pharmacy_id);
      return json(res, result.created ? 201 : 200, {
        request: serializeMedicineRequest(fresh.request),
        offers: fresh.offers.map(serializeMedicineOffer),
        created: result.created,
        idempotentReplay: result.idempotentReplay,
        search: search ? {
          contacted: search.contacted,
          zoneIndex: search.zoneIndex,
          zonesAdvanced: search.zonesAdvanced,
          waiting: search.waiting
        } : null
      });
    } catch (error) { return medicineRequestError(res, error); }
  }

  // ─── GET /api/inter-pharmacy/medicine-requests ────────────────────────────
  // The caller pharmacy's own requests, with an offer summary. Filters: status,
  // medicine, limit, offset.
  if (req.method === 'GET' && url.pathname === '/api/inter-pharmacy/medicine-requests') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const statusParam = url.searchParams.get('status');
      const VALID = ['OPEN', 'PARTIALLY_COVERED', 'FULLY_COVERED', 'NO_COVERAGE', 'CANCELLED', 'EXPIRED'];
      if (statusParam && statusParam !== 'ALL' && !VALID.includes(statusParam)) {
        return json(res, 400, { error: `status must be ALL or one of: ${VALID.join(', ')}.` });
      }
      const limitRaw = url.searchParams.get('limit');
      const offsetRaw = url.searchParams.get('offset');
      if (limitRaw !== null && !/^\d+$/.test(limitRaw))  return json(res, 400, { error: 'limit must be a non-negative integer.' });
      if (offsetRaw !== null && !/^\d+$/.test(offsetRaw)) return json(res, 400, { error: 'offset must be a non-negative integer.' });

      const result = await medicineRequestEngine.listRequestsForPharmacy(user.pharmacy_id, {
        status: statusParam || 'ALL',
        medicineName: url.searchParams.get('medicine') || undefined,
        limit: limitRaw === null ? undefined : Number(limitRaw),
        offset: offsetRaw === null ? undefined : Number(offsetRaw)
      });

      return json(res, 200, {
        requests: result.requests.map(serializeMedicineRequest),
        total: result.total,
        limit: result.limit,
        offset: result.offset
      });
    } catch (error) { return medicineRequestError(res, error); }
  }

  // ─── Routes addressing a single medicine request ──────────────────────────
  const mreqMatch = url.pathname.match(/^\/api\/inter-pharmacy\/medicine-requests\/(\d+)$/);
  const mreqAction = url.pathname.match(/^\/api\/inter-pharmacy\/medicine-requests\/(\d+)\/(advance|offer|decline|cancel)$/);

  // GET /api/inter-pharmacy/medicine-requests/:id
  // Requester sees the full picture; a contacted pharmacy sees only its own
  // response; an unrelated pharmacy gets 404 so existence is not disclosed.
  if (req.method === 'GET' && mreqMatch) {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const detail = await medicineRequestEngine.getRequestDetail(Number(mreqMatch[1]), user.pharmacy_id);
      return json(res, 200, {
        request: serializeMedicineRequest(detail.request),
        offers: detail.offers.map(serializeMedicineOffer),
        coveredQuantity: detail.coveredQuantity,
        remainingQuantity: detail.remainingQuantity,
        viewerRole: detail.viewerRole
      });
    } catch (error) { return medicineRequestError(res, error); }
  }

  if (mreqAction && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const requestId = Number(mreqAction[1]);
    const action = mreqAction[2];
    try {
      const input = await readJson(req);
      if (rejectsClientPharmacy(res, input)) return;

      // ── advance ── requester pharmacy only; the engine picks the next zone.
      if (action === 'advance') {
        if (input.zoneIndex !== undefined || input.radiusKm !== undefined || input.zonesKm !== undefined) {
          return json(res, 400, { error: 'Client must not choose a search zone or radius. The server determines progression.' });
        }
        // requesterPharmacyId is the engine's tenant guard, not client input.
        await medicineRequestEngine.advanceRequest(requestId, { requesterPharmacyId: user.pharmacy_id });
        const detail = await medicineRequestEngine.getRequestDetail(requestId, user.pharmacy_id);
        return json(res, 200, {
          request: serializeMedicineRequest(detail.request),
          offers: detail.offers.map(serializeMedicineOffer),
          coveredQuantity: detail.coveredQuantity,
          remainingQuantity: detail.remainingQuantity
        });
      }

      // ── offer ── responding pharmacy comes from the session only.
      if (action === 'offer') {
        const result = await medicineRequestEngine.submitOffer({
          requestId,
          pharmacyId: user.pharmacy_id,
          userId: user.user_id || user.id,
          offeredQuantity: input.offeredQuantity
        });
        return json(res, 200, {
          offer: serializeMedicineOffer(result.offer),
          request: serializeMedicineRequest(result.request),
          coveredQuantity: result.request.covered_quantity,
          remainingQuantity: Math.max(0, result.request.requested_quantity - result.request.covered_quantity),
          accepted: result.accepted,
          idempotentReplay: result.idempotentReplay
        });
      }

      // ── decline ──
      if (action === 'decline') {
        const result = await medicineRequestEngine.declineRequest({
          requestId,
          pharmacyId: user.pharmacy_id,
          userId: user.user_id || user.id,
          reason: input.reason
        });
        return json(res, 200, {
          offer: serializeMedicineOffer(result.offer),
          declined: result.declined,
          idempotentReplay: result.idempotentReplay
        });
      }

      // ── cancel ── requester pharmacy only; releases soft reservations via
      // the CANCELLED state.
      const result = await medicineRequestEngine.cancelRequest({
        requestId,
        pharmacyId: user.pharmacy_id
      });
      return json(res, 200, {
        request: serializeMedicineRequest(result.request),
        cancelled: result.cancelled,
        idempotentReplay: result.idempotentReplay
      });
    } catch (error) { return medicineRequestError(res, error); }
  }

  // ─── PUT /api/pharmacies/coordinates ──────────────────────────────────────
  // Allows ADMIN to set coordinates for their own pharmacy.
  if (req.method === 'PUT' && url.pathname === '/api/pharmacies/coordinates') {
    if (!requireRole(res, user, 'ADMIN')) return;
    try {
      const input = await readJson(req);
      const lat = input.latitude  != null ? Number(input.latitude)  : null;
      const lng = input.longitude != null ? Number(input.longitude) : null;
      if (lat !== null && (lat < -90  || lat > 90))  return json(res, 400, { error: 'latitude must be between -90 and 90.' });
      if (lng !== null && (lng < -180 || lng > 180)) return json(res, 400, { error: 'longitude must be between -180 and 180.' });
      await db.prepare('UPDATE pharmacies SET latitude=?, longitude=? WHERE id=?').run(lat, lng, user.pharmacy_id);
      const ph = await db.prepare('SELECT id, name, address, latitude, longitude FROM pharmacies WHERE id=?').get(user.pharmacy_id);
      return json(res, 200, { pharmacy: ph });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }

  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'API endpoint not found.' });
  if (!serveFile(res, url.pathname)) json(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => handler(req, res).catch(error => { console.error(error); json(res, 500, { error: 'Internal server error.' }); }));
module.exports = { server, handler, passwordHash, passwordMatches, hashDeviceToken, hashSessionToken, currentDevice, currentUser, db, adapter, SESSION_TTL_MS, processNearExpiryRedistribution, haversineKm, NEAR_EXPIRY_DAYS, NEARBY_RADIUS_KM, medicineRequestEngine, createMedicineRequestEngine, MedicineRequestError, parseAndValidateQrPayload };

if (require.main === module) {
  server.listen(PORT, () => console.log(`MediIndex API running on http://localhost:${PORT}`));
}
