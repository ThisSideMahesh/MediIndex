const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDatabaseAdapter } = require('./db/index');

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
      const reorderNeeded = Math.max(0, med.minimum_stock - med.current_stock);
      return {
        medicineId: med.id,
        medicineName: med.name,
        genericName: med.generic_name,
        category: med.category,
        currentStock: med.current_stock,
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
        riskLevel: med.current_stock <= med.minimum_stock ? (med.current_stock === 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK') : 'MONITORING'
      };
    }

    const p1 = periods[0].quantity_sold;
    const p2 = periods[1].quantity_sold;
    const p3 = periods[2].quantity_sold;

    const w1 = 0.50, w2 = 0.30, w3 = 0.20;
    const weeklyForecast = (w1 * p1) + (w2 * p2) + (w3 * p3);
    const monthlyForecast = Math.round(weeklyForecast * (30 / 7));

    const mean = (p1 + p2 + p3) / 3;
    const variance = ((p1 - mean) ** 2 + (p2 - mean) ** 2 + (p3 - mean) ** 2) / 2;
    const stdDev = Math.sqrt(variance);

    const calculatedSafetyStock = Math.round(1.65 * stdDev);
    const safetyStock = Math.max(med.minimum_stock, calculatedSafetyStock);

    const targetInventory = monthlyForecast + safetyStock;
    const recommendedReorder = Math.max(0, targetInventory - med.current_stock);

    let riskLevel = 'OPTIMAL_STOCK';
    if (med.current_stock <= 0) {
      riskLevel = 'OUT_OF_STOCK';
    } else if (med.current_stock < safetyStock) {
      riskLevel = 'HIGH_RUNOUT_RISK';
    } else if (med.current_stock < targetInventory) {
      riskLevel = 'REORDER_NEEDED';
    }

    return {
      medicineId: med.id,
      medicineName: med.name,
      genericName: med.generic_name,
      category: med.category,
      currentStock: med.current_stock,
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
  res.writeHead(200, { 'Content-Type': types[path.extname(normalized)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
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

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check — performs a real DB query so connectivity is verified.
  if (req.method === 'GET' && url.pathname === '/api/health') {
    try {
      await db.prepare('SELECT 1 AS ok').get();
      return json(res, 200, { status: 'ok', database: 'connected' });
    } catch (err) {
      return json(res, 503, { status: 'error', database: 'unavailable', message: err.message });
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

    const standardShelves = [
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

  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'API endpoint not found.' });
  if (!serveFile(res, url.pathname)) json(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => handler(req, res).catch(error => { console.error(error); json(res, 500, { error: 'Internal server error.' }); }));
module.exports = { server, handler, passwordHash, passwordMatches, hashDeviceToken, hashSessionToken, currentDevice, currentUser, db, adapter, SESSION_TTL_MS };

if (require.main === module) {
  server.listen(PORT, () => console.log(`MediIndex API running on http://localhost:${PORT}`));
}
