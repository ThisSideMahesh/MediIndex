const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler } = require('../server');

function callApi({ method, url, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method || 'GET';
    req.url = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}) };
    const res = {
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
      end(payload) { resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : undefined }); }
    };
    handler(req, res).catch(reject);
    if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

test('Demand Analytics: Unauthenticated access is rejected', async () => {
  const res = await callApi({ url: '/api/analytics/demand' });
  assert.equal(res.status, 401);
});

test('Demand Analytics: Medicine with insufficient historical periods shows hard reliability guard', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Create test medicine with no sales history
  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'New Launch Drug', genericName: 'Test Generic', minimumStock: 20 }
  });
  assert.equal(medRes.status, 201);
  const medId = medRes.body.medicine.id;

  const demandRes = await callApi({ url: '/api/analytics/demand', cookie });
  assert.equal(demandRes.status, 200);

  const forecast = demandRes.body.items.find(item => item.medicineId === medId);
  assert.ok(forecast);
  assert.equal(forecast.status, 'INSUFFICIENT_DATA');
  assert.equal(forecast.message, 'INSUFFICIENT DATA FOR RELIABLE FORECAST');
  assert.equal(forecast.forecast, null);
  assert.equal(forecast.periodsFound, 0);
  assert.equal(forecast.periodsRequired, 3);
  assert.equal(forecast.safetyStock, 20); // Defaults to minimum_stock
  assert.equal(forecast.recommendedReorder, 20); // 20 min_stock - 0 current_stock

  // Clean up
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('Demand Analytics: Weighted Moving Average (WMA) accurate forecast and safety stock calculation with 3 historical periods', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // 1. Create a medicine
  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Cetirizine 10mg', genericName: 'Cetirizine', category: 'Tablet', minimumStock: 5 }
  });
  const medId = medRes.body.medicine.id;

  // 2. Add batches
  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'CET-2027', quantity: 200, purchasePrice: 2, sellingPrice: 4, expiryDate: '2027-12-31' }
  });
  const batchId = batchRes.body.batch.id;

  // 3. Directly simulate 3 sales transactions in SQLite with 3 distinct weeks to test WMA math
  // Note: we can use the server's db directly or make sales and modify timestamps
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'mediindex.db'));

  const pharmacyId = 1;
  const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@mediindex.local'").get();

  // Period 3 (2 weeks ago): 10 units sold on 2026-08-03
  const s3 = db.prepare("INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, 'SIM-INV-001', 'CASH', 40, ?, '2026-08-03 10:00:00')").run(pharmacyId, adminUser.id);
  db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 10, 4, 40)").run(Number(s3.lastInsertRowid), batchId);

  // Period 2 (1 week ago): 20 units sold on 2026-08-10
  const s2 = db.prepare("INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, 'SIM-INV-002', 'CASH', 80, ?, '2026-08-10 10:00:00')").run(pharmacyId, adminUser.id);
  db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 20, 4, 80)").run(Number(s2.lastInsertRowid), batchId);

  // Period 1 (current week): 30 units sold on 2026-08-17
  const s1 = db.prepare("INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, 'SIM-INV-003', 'CASH', 120, ?, '2026-08-17 10:00:00')").run(pharmacyId, adminUser.id);
  db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 30, 4, 120)").run(Number(s1.lastInsertRowid), batchId);

  // 4. Query demand forecast
  const demandRes = await callApi({ url: '/api/analytics/demand', cookie });
  assert.equal(demandRes.status, 200);

  const forecast = demandRes.body.items.find(item => item.medicineId === medId);
  assert.ok(forecast);
  assert.equal(forecast.status, 'RELIABLE');
  assert.equal(forecast.periodsFound >= 3, true);

  // Mathematical Verification:
  // p1 = 30 (most recent, weight 0.50)
  // p2 = 20 (weight 0.30)
  // p3 = 10 (weight 0.20)
  // weeklyForecast = (0.50 * 30) + (0.30 * 20) + (0.20 * 10) = 15 + 6 + 2 = 23.00
  // monthly30DayDemand = round(23.00 * (30 / 7)) = round(98.5714) = 99
  // mean = 20, variance = ((10^2 + 0^2 + (-10)^2)/2) = 100, stdDev = 10
  // safetyStock = max(5, round(1.65 * 10)) = 17
  assert.equal(forecast.forecast.weeklyDemand, 23);
  assert.equal(forecast.forecast.monthly30DayDemand, 99);
  assert.equal(forecast.forecast.historicalStdDev, 10);
  assert.equal(forecast.safetyStock, 17);

  // Target Inventory = 99 + 17 = 116. Current stock = 200.
  // Reorder = max(0, 116 - 200) = 0
  assert.equal(forecast.recommendedReorder, 0);
  assert.equal(forecast.riskLevel, 'OPTIMAL_STOCK');

  // Clean up
  db.prepare("DELETE FROM sale_items WHERE sale_id IN (?, ?, ?)").run(Number(s1.lastInsertRowid), Number(s2.lastInsertRowid), Number(s3.lastInsertRowid));
  db.prepare("DELETE FROM sales WHERE id IN (?, ?, ?)").run(Number(s1.lastInsertRowid), Number(s2.lastInsertRowid), Number(s3.lastInsertRowid));
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});
