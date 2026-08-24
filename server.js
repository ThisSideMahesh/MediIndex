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
      invoice_number TEXT NOT NULL UNIQUE, total_amount REAL NOT NULL CHECK(total_amount >= 0),
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
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'API endpoint not found.' });
  if (!serveFile(res, url.pathname)) json(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => handler(req, res).catch(error => { console.error(error); json(res, 500, { error: 'Internal server error.' }); }));
if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`MediIndex running at http://127.0.0.1:${PORT}`));
module.exports = { server, handler, passwordHash, passwordMatches };
