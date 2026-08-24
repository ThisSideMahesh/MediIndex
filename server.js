const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mediindex.db');
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const sessions = new Map();

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function passwordMatches(password, stored) {
  const [salt, storedHash] = stored.split(':');
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function initializeDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS pharmacies (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'STAFF')), active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS medicines (
      id INTEGER PRIMARY KEY, pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      name TEXT NOT NULL, generic_name TEXT, manufacturer TEXT, category TEXT,
      minimum_stock INTEGER NOT NULL DEFAULT 0 CHECK(minimum_stock >= 0), active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines(name);
    CREATE TABLE IF NOT EXISTS medicine_batches (
      id INTEGER PRIMARY KEY, medicine_id INTEGER NOT NULL REFERENCES medicines(id),
      batch_number TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity >= 0),
      purchase_price REAL NOT NULL DEFAULT 0 CHECK(purchase_price >= 0),
      selling_price REAL NOT NULL CHECK(selling_price >= 0),
      manufacturing_date TEXT, expiry_date TEXT NOT NULL, location TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(medicine_id, batch_number)
    );
    CREATE INDEX IF NOT EXISTS idx_batches_expiry ON medicine_batches(expiry_date);
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES medicine_batches(id),
      change_quantity INTEGER NOT NULL CHECK(change_quantity != 0),
      reason TEXT NOT NULL CHECK(reason IN ('RECEIPT', 'ADJUSTMENT', 'SALE')),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_movements_batch ON inventory_movements(batch_id);
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY, pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      invoice_number TEXT NOT NULL UNIQUE, customer_name TEXT, customer_phone TEXT,
      payment_method TEXT NOT NULL DEFAULT 'CASH', total_amount REAL NOT NULL CHECK(total_amount >= 0),
      created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),
      batch_id INTEGER NOT NULL REFERENCES medicine_batches(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
      unit_price REAL NOT NULL CHECK(unit_price >= 0), line_total REAL NOT NULL CHECK(line_total >= 0)
    );
    CREATE TABLE IF NOT EXISTS expiry_alerts (
      id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES medicine_batches(id),
      alert_type TEXT NOT NULL CHECK(alert_type IN ('EXPIRED', 'EXPIRING_SOON', 'LOW_STOCK')),
      acknowledged INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_alert_once ON expiry_alerts(batch_id, alert_type);
  `);
  try {
    const cols = db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
    if (!cols.includes('customer_name')) db.exec('ALTER TABLE sales ADD COLUMN customer_name TEXT');
    if (!cols.includes('customer_phone')) db.exec('ALTER TABLE sales ADD COLUMN customer_phone TEXT');
    if (!cols.includes('payment_method')) db.exec("ALTER TABLE sales ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'CASH'");
  } catch {}
  const hasPharmacy = db.prepare('SELECT id FROM pharmacies LIMIT 1').get();
  if (!hasPharmacy) {
    db.prepare('INSERT INTO pharmacies (name, address) VALUES (?, ?)').run('MediIndex Demo Pharmacy', 'Chhatrapati Sambhajinagar');
    const pharmacy = db.prepare('SELECT id FROM pharmacies LIMIT 1').get();
    const addUser = db.prepare('INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
    addUser.run(pharmacy.id, 'Demo Administrator', 'admin@mediindex.local', passwordHash('MediIndex@2026'), 'ADMIN');
    addUser.run(pharmacy.id, 'Demo Pharmacy Staff', 'staff@mediindex.local', passwordHash('MediIndex@2026'), 'STAFF');
  }
  return db;
}

const db = initializeDatabase();

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

function currentUser(req) {
  const token = parseCookies(req).mediindex_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return db.prepare('SELECT id, pharmacy_id, full_name, email, role FROM users WHERE id = ? AND active = 1').get(session.userId) || null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON request body')); } });
    req.on('error', reject);
  });
}

function dashboardFor(user) {
  refreshExpiryAlerts(user.pharmacy_id);
  const pharmacyId = user.pharmacy_id;
  const single = sql => db.prepare(sql).get(pharmacyId).value;
  return {
    totalMedicines: single('SELECT COUNT(*) AS value FROM medicines WHERE pharmacy_id = ? AND active = 1'),
    totalStock: single('SELECT COALESCE(SUM(b.quantity), 0) AS value FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.pharmacy_id = ? AND m.active = 1'),
    expired: single("SELECT COUNT(*) AS value FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.pharmacy_id = ? AND b.quantity > 0 AND date(b.expiry_date) < date('now')"),
    expiringSoon: single("SELECT COUNT(*) AS value FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.pharmacy_id = ? AND b.quantity > 0 AND date(b.expiry_date) BETWEEN date('now') AND date('now', '+30 days')"),
    lowStock: single('SELECT COUNT(*) AS value FROM medicines m WHERE m.pharmacy_id = ? AND m.active = 1 AND (SELECT COALESCE(SUM(quantity), 0) FROM medicine_batches WHERE medicine_id = m.id) <= m.minimum_stock'),
    todaySales: single("SELECT COALESCE(SUM(total_amount), 0) AS value FROM sales WHERE pharmacy_id = ? AND date(created_at) = date('now')")
  };
}

function refreshExpiryAlerts(pharmacyId) {
  db.prepare(`DELETE FROM expiry_alerts WHERE id IN (
    SELECT a.id FROM expiry_alerts a JOIN medicine_batches b ON b.id=a.batch_id JOIN medicines m ON m.id=b.medicine_id
    WHERE m.pharmacy_id=? AND ((a.alert_type='EXPIRING_SOON' AND (b.quantity=0 OR date(b.expiry_date)<date('now') OR date(b.expiry_date)>date('now','+30 days'))) OR (a.alert_type='EXPIRED' AND (b.quantity=0 OR date(b.expiry_date)>=date('now'))))
  )`).run(pharmacyId);
  db.prepare(`INSERT OR IGNORE INTO expiry_alerts (batch_id, alert_type)
    SELECT b.id, CASE WHEN date(b.expiry_date)<date('now') THEN 'EXPIRED' ELSE 'EXPIRING_SOON' END
    FROM medicine_batches b JOIN medicines m ON m.id=b.medicine_id
    WHERE m.pharmacy_id=? AND m.active=1 AND b.quantity>0 AND date(b.expiry_date)<=date('now','+30 days')`).run(pharmacyId);
}

function calculateDemandForecast(pharmacyId) {
  const medicines = db.prepare(`
    SELECT m.id, m.name, m.generic_name, m.category, m.minimum_stock,
           (SELECT COALESCE(SUM(b.quantity), 0) 
            FROM medicine_batches b 
            WHERE b.medicine_id = m.id AND b.quantity > 0 AND date(b.expiry_date) >= date('now')) AS current_stock,
           (SELECT COALESCE(SUM(si.quantity), 0)
            FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            JOIN medicine_batches b ON b.id = si.batch_id
            WHERE b.medicine_id = m.id AND s.pharmacy_id = m.pharmacy_id) AS total_historical_sold
    FROM medicines m
    WHERE m.pharmacy_id = ? AND m.active = 1
    ORDER BY m.name COLLATE NOCASE
  `).all(pharmacyId);

  const forecastList = medicines.map(med => {
    // Group sales by week
    const periods = db.prepare(`
      SELECT strftime('%Y-W%W', s.created_at) AS period_id,
             MIN(date(s.created_at)) AS period_start,
             MAX(date(s.created_at)) AS period_end,
             SUM(si.quantity) AS quantity_sold,
             SUM(si.line_total) AS revenue,
             COUNT(DISTINCT s.id) AS sales_count
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN medicine_batches b ON b.id = si.batch_id
      WHERE b.medicine_id = ? AND s.pharmacy_id = ?
      GROUP BY strftime('%Y-W%W', s.created_at)
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

    // WMA calculation on 3 most recent periods
    const p1 = periods[0].quantity_sold; // Most recent
    const p2 = periods[1].quantity_sold;
    const p3 = periods[2].quantity_sold;

    const w1 = 0.50, w2 = 0.30, w3 = 0.20;
    const weeklyForecast = (w1 * p1) + (w2 * p2) + (w3 * p3);
    const monthlyForecast = Math.round(weeklyForecast * (30 / 7));

    // Historical standard deviation across the 3 periods
    const mean = (p1 + p2 + p3) / 3;
    const variance = ((p1 - mean) ** 2 + (p2 - mean) ** 2 + (p3 - mean) ** 2) / 2;
    const stdDev = Math.sqrt(variance);
    
    // Safety Stock at 95% service level (Z = 1.65)
    const calculatedSafetyStock = Math.round(1.65 * stdDev);
    const safetyStock = Math.max(med.minimum_stock, calculatedSafetyStock);

    // Replenishment Quantity
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
  });

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

function medicineById(id, pharmacyId) {
  return db.prepare('SELECT id, name, generic_name, manufacturer, category, minimum_stock, active, created_at, updated_at FROM medicines WHERE id = ? AND pharmacy_id = ?').get(id, pharmacyId);
}

function serializeMedicine(row) {
  return { ...row, total_stock: db.prepare('SELECT COALESCE(SUM(quantity), 0) AS value FROM medicine_batches WHERE medicine_id = ?').get(row.id).value };
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

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', database: 'connected' });
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    try {
      const { email, password } = await readJson(req);
      if (typeof email !== 'string' || typeof password !== 'string') return json(res, 400, { error: 'Email and password are required.' });
      const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1').get(email.trim());
      if (!user || !passwordMatches(password, user.password_hash)) return json(res, 401, { error: 'Invalid email or password.' });
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
      db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
      return json(res, 200, { user: { fullName: user.full_name, email: user.email, role: user.role } }, { 'Set-Cookie': `mediindex_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = parseCookies(req).mediindex_session; if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'mediindex_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  const user = currentUser(req);
  if (req.method === 'GET' && url.pathname === '/api/auth/me') return user ? json(res, 200, { user }) : json(res, 401, { error: 'Authentication required.' });
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return user ? json(res, 200, dashboardFor(user)) : json(res, 401, { error: 'Authentication required.' });
  if (req.method === 'GET' && url.pathname === '/api/analytics/demand') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    return json(res, 200, calculateDemandForecast(user.pharmacy_id));
  }
  if (req.method === 'GET' && url.pathname === '/api/expiry-alerts') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    refreshExpiryAlerts(user.pharmacy_id);
    const status = url.searchParams.get('status') || 'ALL';
    const acknowledged = url.searchParams.get('acknowledged') || 'ALL';
    const alerts = db.prepare(`SELECT a.id, a.alert_type, a.acknowledged, a.created_at, m.id AS medicine_id, m.name AS medicine_name, b.id AS batch_id, b.batch_number, b.quantity, b.expiry_date, b.location,
      CAST(julianday(date(b.expiry_date))-julianday(date('now')) AS INTEGER) AS days_to_expiry
      FROM expiry_alerts a JOIN medicine_batches b ON b.id=a.batch_id JOIN medicines m ON m.id=b.medicine_id
      WHERE m.pharmacy_id=? AND (?='ALL' OR a.alert_type=?) AND (?='ALL' OR a.acknowledged=CAST(? AS INTEGER))
      ORDER BY a.acknowledged ASC, CASE a.alert_type WHEN 'EXPIRED' THEN 0 ELSE 1 END, date(b.expiry_date) ASC`).all(user.pharmacy_id, status, status, acknowledged, acknowledged);
    return json(res, 200, { alerts });
  }
  const acknowledgeMatch = url.pathname.match(/^\/api\/expiry-alerts\/(\d+)\/acknowledge$/);
  if (acknowledgeMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const result = db.prepare(`UPDATE expiry_alerts SET acknowledged=1 WHERE id=? AND id IN (
      SELECT a.id FROM expiry_alerts a JOIN medicine_batches b ON b.id=a.batch_id JOIN medicines m ON m.id=b.medicine_id WHERE m.pharmacy_id=?
    )`).run(Number(acknowledgeMatch[1]), user.pharmacy_id);
    return result.changes ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Alert not found.' });
  }
  if (req.method === 'GET' && url.pathname === '/api/medicines') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const query = (url.searchParams.get('q') || '').trim();
    const rows = db.prepare(`SELECT id, name, generic_name, manufacturer, category, minimum_stock, active, created_at, updated_at FROM medicines WHERE pharmacy_id = ? AND active = 1 AND (name LIKE ? OR generic_name LIKE ?) ORDER BY name COLLATE NOCASE`).all(user.pharmacy_id, `%${query}%`, `%${query}%`);
    return json(res, 200, { medicines: rows.map(serializeMedicine) });
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
      const result = db.prepare('INSERT INTO medicines (pharmacy_id, name, generic_name, manufacturer, category, minimum_stock) VALUES (?, ?, ?, ?, ?, ?)').run(user.pharmacy_id, name, generic, manufacturer, category, minimumStock);
      return json(res, 201, { medicine: serializeMedicine(medicineById(Number(result.lastInsertRowid), user.pharmacy_id)) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  const medicineMatch = url.pathname.match(/^\/api\/medicines\/(\d+)$/);
  if (medicineMatch && req.method === 'PUT') {
    if (!requireRole(res, user, 'ADMIN')) return;
    try {
      const existing = medicineById(Number(medicineMatch[1]), user.pharmacy_id);
      if (!existing || !existing.active) return json(res, 404, { error: 'Medicine not found.' });
      const input = await readJson(req);
      const name = cleanText(input.name, 'Medicine name', { required: true });
      const generic = cleanText(input.genericName, 'Generic name');
      const manufacturer = cleanText(input.manufacturer, 'Manufacturer');
      const category = cleanText(input.category, 'Category');
      const minimumStock = nonNegative(input.minimumStock, 'Minimum stock');
      db.prepare("UPDATE medicines SET name=?, generic_name=?, manufacturer=?, category=?, minimum_stock=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name, generic, manufacturer, category, minimumStock, existing.id);
      return json(res, 200, { medicine: serializeMedicine(medicineById(existing.id, user.pharmacy_id)) });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (medicineMatch && req.method === 'DELETE') {
    if (!requireRole(res, user, 'ADMIN')) return;
    const existing = medicineById(Number(medicineMatch[1]), user.pharmacy_id);
    if (!existing || !existing.active) return json(res, 404, { error: 'Medicine not found.' });
    db.prepare('UPDATE medicines SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(existing.id);
    return json(res, 200, { ok: true });
  }
  const batchListMatch = url.pathname.match(/^\/api\/medicines\/(\d+)\/batches$/);
  if (batchListMatch && req.method === 'GET') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const medicine = medicineById(Number(batchListMatch[1]), user.pharmacy_id);
    if (!medicine || !medicine.active) return json(res, 404, { error: 'Medicine not found.' });
    const batches = db.prepare("SELECT id, batch_number, quantity, purchase_price, selling_price, manufacturing_date, expiry_date, location, CASE WHEN date(expiry_date) < date('now') THEN 'EXPIRED' WHEN date(expiry_date) <= date('now', '+30 days') THEN 'EXPIRING_SOON' ELSE 'SAFE' END AS expiry_status FROM medicine_batches WHERE medicine_id=? ORDER BY date(expiry_date), id").all(medicine.id);
    return json(res, 200, { medicine: serializeMedicine(medicine), batches });
  }
  if (batchListMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const medicine = medicineById(Number(batchListMatch[1]), user.pharmacy_id);
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
      const result = db.prepare('INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, manufacturing_date, expiry_date, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(medicine.id, batchNumber, quantity, purchasePrice, sellingPrice, manufacturingDate, expiryDate, location);
      db.prepare("INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, 'RECEIPT', ?)").run(Number(result.lastInsertRowid), quantity, user.id);
      return json(res, 201, { batch: db.prepare('SELECT * FROM medicine_batches WHERE id=?').get(Number(result.lastInsertRowid)) });
    } catch (error) { return json(res, 400, { error: error.message.includes('UNIQUE constraint') ? 'This batch number already exists for the selected medicine.' : error.message }); }
  }
  const adjustmentMatch = url.pathname.match(/^\/api\/batches\/(\d+)\/adjustments$/);
  if (adjustmentMatch && req.method === 'POST') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const input = await readJson(req); const change = Number(input.changeQuantity);
      if (!Number.isInteger(change) || change === 0) throw new Error('Adjustment quantity must be a non-zero whole number.');
      const batch = db.prepare('SELECT b.* FROM medicine_batches b JOIN medicines m ON m.id=b.medicine_id WHERE b.id=? AND m.pharmacy_id=? AND m.active=1').get(Number(adjustmentMatch[1]), user.pharmacy_id);
      if (!batch) return json(res, 404, { error: 'Batch not found.' });
      if (batch.quantity + change < 0) return json(res, 400, { error: 'Adjustment would reduce stock below zero.' });
      db.exec('BEGIN');
      db.prepare('UPDATE medicine_batches SET quantity=quantity + ? WHERE id=?').run(change, batch.id);
      db.prepare("INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, 'ADJUSTMENT', ?)").run(batch.id, change, user.id);
      db.exec('COMMIT');
      return json(res, 200, { batch: db.prepare('SELECT * FROM medicine_batches WHERE id=?').get(batch.id) });
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} return json(res, 400, { error: error.message }); }
  }
  const batchQrMatch = url.pathname.match(/^\/api\/batches\/(\d+)\/qr$/);
  if (batchQrMatch && req.method === 'GET') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const row = db.prepare(`
      SELECT b.id AS batch_id, b.batch_number, b.quantity, b.selling_price, b.expiry_date, b.location,
             m.id AS medicine_id, m.name AS medicine_name, m.generic_name, m.category
      FROM medicine_batches b
      JOIN medicines m ON m.id = b.medicine_id
      WHERE b.id = ? AND m.pharmacy_id = ? AND m.active = 1
    `).get(Number(batchQrMatch[1]), user.pharmacy_id);
    if (!row) return json(res, 404, { error: 'Batch not found.' });

    const payload = {
      app: 'MEDIINDEX',
      v: 1,
      medicineId: row.medicine_id,
      batchNumber: row.batch_number
    };

    return json(res, 200, {
      payload,
      payloadString: JSON.stringify(payload),
      sticker: {
        medicineId: row.medicine_id,
        medicineName: row.medicine_name,
        genericName: row.generic_name,
        category: row.category,
        batchNumber: row.batch_number,
        expiryDate: row.expiry_date,
        sellingPrice: row.selling_price,
        currentStock: row.quantity,
        location: row.location
      }
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/qr/lookup') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    try {
      const input = await readJson(req);
      let payload = input.payload;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload.trim());
        } catch {
          // Check if pipe-delimited format: MEDIINDEX|v1|MED_ID|BATCH_NO
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

      // Authoritative database resolution
      const row = db.prepare(`
        SELECT b.id AS batch_id, b.batch_number, b.quantity, b.purchase_price, b.selling_price,
               b.manufacturing_date, b.expiry_date, b.location,
               CASE 
                 WHEN date(b.expiry_date) < date('now') THEN 'EXPIRED'
                 WHEN date(b.expiry_date) <= date('now', '+30 days') THEN 'EXPIRING_SOON'
                 ELSE 'SAFE'
               END AS expiry_status,
               m.id AS medicine_id, m.name AS medicine_name, m.generic_name, m.manufacturer, m.category, m.minimum_stock
        FROM medicine_batches b
        JOIN medicines m ON m.id = b.medicine_id
        WHERE m.id = ? AND b.batch_number = ? AND m.pharmacy_id = ? AND m.active = 1
      `).get(medicineId, batchNumber, user.pharmacy_id);

      if (!row) {
        return json(res, 404, { error: `No active medicine batch found for ID ${medicineId} and lot '${batchNumber}'.` });
      }

      return json(res, 200, {
        valid: true,
        authoritative: true,
        medicine: {
          id: row.medicine_id,
          name: row.medicine_name,
          genericName: row.generic_name,
          manufacturer: row.manufacturer,
          category: row.category,
          minimumStock: row.minimum_stock
        },
        batch: {
          id: row.batch_id,
          batchNumber: row.batch_number,
          quantity: row.quantity,
          purchasePrice: row.purchase_price,
          sellingPrice: row.selling_price,
          manufacturingDate: row.manufacturing_date,
          expiryDate: row.expiry_date,
          expiryStatus: row.expiry_status,
          location: row.location
        }
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/layout/shelves') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    refreshExpiryAlerts(user.pharmacy_id);

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

    const rows = db.prepare(`
      SELECT b.id AS batch_id, b.batch_number, b.quantity, b.selling_price, b.purchase_price,
             b.manufacturing_date, b.expiry_date, b.location,
             CASE 
               WHEN date(b.expiry_date) < date('now') THEN 'EXPIRED'
               WHEN date(b.expiry_date) <= date('now', '+30 days') THEN 'EXPIRING_SOON'
               ELSE 'SAFE'
             END AS expiry_status,
             m.id AS medicine_id, m.name AS medicine_name, m.generic_name, m.category, m.minimum_stock
      FROM medicine_batches b
      JOIN medicines m ON m.id = b.medicine_id
      WHERE m.pharmacy_id = ? AND m.active = 1
      ORDER BY b.location ASC, m.name ASC
    `).all(user.pharmacy_id);

    const shelfMap = new Map();
    standardShelves.forEach(s => {
      shelfMap.set(s.id.toLowerCase(), {
        ...s,
        totalBatches: 0,
        totalUnits: 0,
        expiredBatches: 0,
        expiringSoonBatches: 0,
        batches: []
      });
    });

    const unassignedBatches = [];

    rows.forEach(r => {
      const locKey = (r.location || '').trim().toLowerCase();
      let matchedShelf = null;
      for (const [key, shelf] of shelfMap.entries()) {
        if (locKey === key || locKey.includes(key) || (key.includes(locKey) && locKey.length > 2)) {
          matchedShelf = shelf;
          break;
        }
      }

      const batchItem = {
        id: r.batch_id,
        batchNumber: r.batch_number,
        quantity: r.quantity,
        sellingPrice: r.selling_price,
        expiryDate: r.expiry_date,
        expiryStatus: r.expiry_status,
        location: r.location || 'Unassigned',
        medicine: {
          id: r.medicine_id,
          name: r.medicine_name,
          genericName: r.generic_name,
          category: r.category
        }
      };

      if (matchedShelf) {
        matchedShelf.totalBatches += 1;
        matchedShelf.totalUnits += r.quantity;
        if (r.expiry_status === 'EXPIRED') matchedShelf.expiredBatches += 1;
        if (r.expiry_status === 'EXPIRING_SOON') matchedShelf.expiringSoonBatches += 1;
        matchedShelf.batches.push(batchItem);
      } else {
        unassignedBatches.push(batchItem);
      }
    });

    const shelves = Array.from(shelfMap.values());
    const totalInventoryUnits = rows.reduce((sum, r) => sum + r.quantity, 0);

    return json(res, 200, {
      layoutName: 'Standard Community Pharmacy Floor Plan',
      totalShelves: shelves.length,
      totalUnits: totalInventoryUnits,
      shelves,
      unassigned: {
        totalBatches: unassignedBatches.length,
        totalUnits: unassignedBatches.reduce((sum, b) => sum + b.quantity, 0),
        batches: unassignedBatches
      }
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/sales') {
    if (!requireRole(res, user, 'ADMIN', 'STAFF')) return;
    const query = (url.searchParams.get('q') || '').trim();
    const rows = db.prepare(`
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
    const sale = db.prepare(`
      SELECT s.id, s.invoice_number, s.customer_name, s.customer_phone, s.payment_method, s.total_amount, s.created_at,
             u.full_name AS cashier_name
      FROM sales s
      JOIN users u ON u.id = s.created_by
      WHERE s.id = ? AND s.pharmacy_id = ?
    `).get(Number(saleDetailMatch[1]), user.pharmacy_id);
    if (!sale) return json(res, 404, { error: 'Sale record not found.' });
    const items = db.prepare(`
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

      db.exec('BEGIN');
      const allocations = [];

      for (const item of requestedItems) {
        const medicine = db.prepare('SELECT id, name FROM medicines WHERE id = ? AND pharmacy_id = ? AND active = 1').get(item.medicineId, user.pharmacy_id);
        if (!medicine) throw new Error(`Medicine ID ${item.medicineId} not found or is inactive.`);

        if (item.batchId) {
          const batch = db.prepare(`
            SELECT b.id, b.batch_number, b.quantity, b.selling_price, b.expiry_date
            FROM medicine_batches b
            WHERE b.id = ? AND b.medicine_id = ?
          `).get(item.batchId, medicine.id);
          if (!batch) throw new Error(`Batch ID ${item.batchId} not found for medicine ${medicine.name}.`);
          if (new Date(batch.expiry_date) < new Date(new Date().toISOString().slice(0, 10))) {
            throw new Error(`Cannot dispense expired batch ${batch.batch_number} for medicine ${medicine.name}.`);
          }
          if (batch.quantity < item.quantity) {
            throw new Error(`Insufficient stock in batch ${batch.batch_number} for ${medicine.name}. Requested: ${item.quantity}, Available: ${batch.quantity}.`);
          }
          allocations.push({
            batchId: batch.id,
            medicineId: medicine.id,
            medicineName: medicine.name,
            batchNumber: batch.batch_number,
            quantity: item.quantity,
            unitPrice: batch.selling_price,
            lineTotal: Math.round(item.quantity * batch.selling_price * 100) / 100
          });
        } else {
          // FEFO automatic batch allocation (First-Expired, First-Out)
          const batches = db.prepare(`
            SELECT b.id, b.batch_number, b.quantity, b.selling_price, b.expiry_date
            FROM medicine_batches b
            WHERE b.medicine_id = ? AND b.quantity > 0 AND date(b.expiry_date) >= date('now')
            ORDER BY date(b.expiry_date) ASC, b.id ASC
          `).all(medicine.id);

          const totalAvailable = batches.reduce((sum, b) => sum + b.quantity, 0);
          if (totalAvailable < item.quantity) {
            throw new Error(`Insufficient stock for ${medicine.name}. Requested: ${item.quantity}, Available: ${totalAvailable}.`);
          }

          let needed = item.quantity;
          for (const b of batches) {
            if (needed <= 0) break;
            const take = Math.min(b.quantity, needed);
            allocations.push({
              batchId: b.id,
              medicineId: medicine.id,
              medicineName: medicine.name,
              batchNumber: b.batch_number,
              quantity: take,
              unitPrice: b.selling_price,
              lineTotal: Math.round(take * b.selling_price * 100) / 100
            });
            needed -= take;
          }
        }
      }

      const totalAmount = Math.round(allocations.reduce((sum, a) => sum + a.lineTotal, 0) * 100) / 100;
      const now = new Date();
      const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
      const countToday = db.prepare("SELECT COUNT(*) AS count FROM sales WHERE pharmacy_id = ? AND date(created_at) = date('now')").get(user.pharmacy_id).count;
      const invoiceNumber = `INV-${datePart}-${String(countToday + 1).padStart(4, '0')}`;

      const saleResult = db.prepare(`
        INSERT INTO sales (pharmacy_id, invoice_number, customer_name, customer_phone, payment_method, total_amount, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(user.pharmacy_id, invoiceNumber, customerName, customerPhone, paymentMethod, totalAmount, user.id);
      const saleId = Number(saleResult.lastInsertRowid);

      const insertItem = db.prepare(`
        INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total)
        VALUES (?, ?, ?, ?, ?)
      `);
      const updateBatchStock = db.prepare('UPDATE medicine_batches SET quantity = quantity - ? WHERE id = ?');
      const insertMovement = db.prepare("INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, 'SALE', ?)");

      for (const a of allocations) {
        insertItem.run(saleId, a.batchId, a.quantity, a.unitPrice, a.lineTotal);
        updateBatchStock.run(a.quantity, a.batchId);
        insertMovement.run(a.batchId, -a.quantity, user.id);
      }

      db.exec('COMMIT');
      refreshExpiryAlerts(user.pharmacy_id);

      return json(res, 201, {
        sale: {
          id: saleId,
          invoice_number: invoiceNumber,
          customer_name: customerName,
          customer_phone: customerPhone,
          payment_method: paymentMethod,
          total_amount: totalAmount,
          created_at: new Date().toISOString(),
          cashier: user.full_name,
          items: allocations
        }
      });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      return json(res, 400, { error: error.message });
    }
  }
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'API endpoint not found.' });
  if (!serveFile(res, url.pathname)) json(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => handler(req, res).catch(error => { console.error(error); json(res, 500, { error: 'Internal server error.' }); }));
if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`MediIndex running at http://127.0.0.1:${PORT}`));
module.exports = { server, handler, passwordHash, passwordMatches };
