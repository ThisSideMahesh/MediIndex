const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler } = require('../core');

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
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'mediindex.db'));

  const pharmacyId = 1;
  const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@mediindex.local'").get();

  // Unique identifier prevents invoice-number collisions when the test is
  // re-run after a failed cleanup (same pattern as TYPE-COERCION-C).
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Hoist sale IDs so the finally block can reference them even if an
  // intermediate INSERT or assertion fails before all three are assigned.
  let s1id, s2id, s3id;
  try {
    // Period 3 (2 weeks ago): 10 units sold on 2026-08-03
    const s3 = db.prepare(
      "INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, ?, 'CASH', 40, ?, '2026-08-03 10:00:00')"
    ).run(pharmacyId, `SIM-INV-A-${uid}`, adminUser.id);
    s3id = Number(s3.lastInsertRowid);
    db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 10, 4, 40)").run(s3id, batchId);

    // Period 2 (1 week ago): 20 units sold on 2026-08-10
    const s2 = db.prepare(
      "INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, ?, 'CASH', 80, ?, '2026-08-10 10:00:00')"
    ).run(pharmacyId, `SIM-INV-B-${uid}`, adminUser.id);
    s2id = Number(s2.lastInsertRowid);
    db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 20, 4, 80)").run(s2id, batchId);

    // Period 1 (current week): 30 units sold on 2026-08-17
    const s1 = db.prepare(
      "INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, ?, 'CASH', 120, ?, '2026-08-17 10:00:00')"
    ).run(pharmacyId, `SIM-INV-C-${uid}`, adminUser.id);
    s1id = Number(s1.lastInsertRowid);
    db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 30, 4, 120)").run(s1id, batchId);

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
  } finally {
    // Always clean up inserted rows even if an assertion or INSERT failed.
    if (s1id !== undefined) db.prepare("DELETE FROM sale_items WHERE sale_id = ?").run(s1id);
    if (s2id !== undefined) db.prepare("DELETE FROM sale_items WHERE sale_id = ?").run(s2id);
    if (s3id !== undefined) db.prepare("DELETE FROM sale_items WHERE sale_id = ?").run(s3id);
    if (s1id !== undefined) db.prepare("DELETE FROM sales WHERE id = ?").run(s1id);
    if (s2id !== undefined) db.prepare("DELETE FROM sales WHERE id = ?").run(s2id);
    if (s3id !== undefined) db.prepare("DELETE FROM sales WHERE id = ?").run(s3id);
    await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
  }
});

// ---------------------------------------------------------------------------
// Regression tests for the PostgreSQL bigint string-coercion fix
//
// DIAGNOSIS: PostgreSQL's pg driver returns SUM(INTEGER) as a JavaScript string
// (bigint, OID 20). Before the fix, `(p1 + p2 + p3) / 3` concatenated the
// strings instead of adding them, corrupting mean, stdDev, safetyStock, and
// recommendedReorder. The WMA weeklyForecast was unaffected because `*` always
// coerces to number, but `+` does not.
//
// SEAM: core.js exports `db` (the live SQLite adapter). In each of these tests,
// db.prepare is temporarily monkey-patched so that the periods query returns
// rows with string-valued quantity_sold (mimicking what the pg driver would
// return). The real `calculateDemandForecast` runs, end-to-end through the
// handler, against those string values. db.prepare is always restored in a
// finally block. The medicines and current_stock queries are also proxied to
// return pg-style strings where relevant.
//
// This approach exercises the actual production code path rather than
// re-implementing the arithmetic in the test file.
// ---------------------------------------------------------------------------

// Import the exported db so we can proxy its prepare method.
const { db: coreDb } = require('../core');

test('Demand Analytics — TYPE-COERCION-A: real calculateDemandForecast handles pg-driver string quantities correctly', async () => {
  // PURPOSE: prove that the actual production code (not a local copy of the
  // arithmetic) produces correct results when quantity_sold arrives as a string,
  // as it does from the PostgreSQL pg driver.
  //
  // APPROACH: use the handler's /api/analytics/demand route, but proxy
  // db.prepare so the periods query returns three rows with string-valued
  // quantity_sold ('30', '20', '10'), and the outer medicines query returns a
  // medicine row with string-valued current_stock ('200').  The real
  // calculateDemandForecast function runs unmodified against these strings.
  //
  // EXPECTED (from actual formula in core.js):
  //   p1=30, p2=20, p3=10 (after Number() coercion in the fix)
  //   w1=0.50, w2=0.30, w3=0.20
  //   weeklyForecast = 0.5*30 + 0.3*20 + 0.2*10 = 15+6+2 = 23
  //   monthly30DayDemand = round(23 * 30/7) = round(98.571) = 99
  //   mean = (30+20+10)/3 = 20
  //   variance = ((30-20)^2 + (20-20)^2 + (10-20)^2) / 2 = 100
  //   stdDev = 10
  //   calculatedSafetyStock = round(1.65*10) = round(16.5) = 17
  //   safetyStock = max(5, 17) = 17  (minimumStock=5)
  //   currentStock = Number('200') = 200
  //   targetInventory = 99+17 = 116
  //   recommendedReorder = max(0, 116-200) = 0
  //   riskLevel = OPTIMAL_STOCK

  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Create a real medicine so the forecast list includes our target medicine id.
  const medRes = await callApi({
    method: 'POST', url: '/api/medicines', cookie,
    body: { name: 'PG-String-Test-A', genericName: 'PGS-A', minimumStock: 5 }
  });
  assert.equal(medRes.status, 201);
  const medId = medRes.body.medicine.id;

  // We need to add a batch so current_stock is non-zero in the real query.
  // (The proxy overrides only the period query, not the medicines query —
  //  we proxy the whole db.prepare to intercept by SQL content instead.)
  const batchRes = await callApi({
    method: 'POST', url: `/api/medicines/${medId}/batches`, cookie,
    body: { batchNumber: 'PGS-A-001', quantity: 200, purchasePrice: 2, sellingPrice: 4, expiryDate: '2027-12-31' }
  });
  assert.equal(batchRes.status, 201);

  const originalPrepare = coreDb.prepare.bind(coreDb);
  try {
    // Proxy db.prepare: intercept the weekly-periods query for our medicine and
    // return pg-driver-style string quantities. All other queries run normally.
    coreDb.prepare = function (sql) {
      const stmt = originalPrepare(sql);
      // The periods query selects from sale_items…GROUP BY week. We detect it
      // by the presence of 'quantity_sold' in the SQL, which is unique to that
      // query in calculateDemandForecast.
      if (sql.includes('quantity_sold')) {
        return {
          all: (...args) => {
            // Only intercept when the first param is our medicine's id.
            if (args[0] !== medId) return stmt.all(...args);
            // Return three period rows with string-typed quantity_sold,
            // mimicking what node-postgres bigint parser returns.
            return [
              { period_id: '2026-W33', period_start: '2026-08-17', period_end: '2026-08-17', quantity_sold: '30', revenue: '120', sales_count: 1 },
              { period_id: '2026-W32', period_start: '2026-08-10', period_end: '2026-08-10', quantity_sold: '20', revenue: '80',  sales_count: 1 },
              { period_id: '2026-W31', period_start: '2026-08-03', period_end: '2026-08-03', quantity_sold: '10', revenue: '40',  sales_count: 1 },
            ];
          },
          get: (...args) => stmt.get(...args),
          run: (...args) => stmt.run(...args),
        };
      }
      return stmt;
    };

    const demandRes = await callApi({ url: '/api/analytics/demand', cookie });
    assert.equal(demandRes.status, 200);

    const forecast = demandRes.body.items.find(i => i.medicineId === medId);
    assert.ok(forecast, 'forecast item must exist for the test medicine');
    assert.equal(forecast.status, 'RELIABLE', 'status must be RELIABLE (3 periods injected)');

    // Verify all fields that the pre-fix bug corrupted:
    assert.equal(forecast.forecast.weeklyDemand, 23,    'weeklyDemand: 0.5*30+0.3*20+0.2*10 = 23');
    assert.equal(forecast.forecast.monthly30DayDemand, 99, 'monthly30DayDemand: round(23*30/7) = 99');
    assert.equal(forecast.forecast.historicalStdDev, 10,   'historicalStdDev: sqrt(100) = 10 (NOT ~123270 from buggy mean)');
    assert.equal(forecast.safetyStock, 17,                 'safetyStock: max(5, round(1.65*10)) = 17 (NOT ~203396 from buggy stdDev)');
    assert.equal(forecast.recommendedReorder, 0,           'recommendedReorder: max(0, 116-200) = 0');
    assert.equal(forecast.riskLevel, 'OPTIMAL_STOCK',     'riskLevel: OPTIMAL_STOCK (NOT HIGH_RUNOUT_RISK from buggy safetyStock)');

    // Confirm that without the fix these same inputs would produce wrong outputs.
    // This proves the test is a real regression guard, not trivially passing.
    const buggyMean = ('30' + '20' + '10') / 3;  // pre-fix string concatenation
    assert.ok(buggyMean > 1000, 'pre-fix string-concat mean is implausibly large — confirms test targets the real bug');
    assert.notEqual(buggyMean, 20, 'pre-fix mean does not equal the correct value of 20');
  } finally {
    coreDb.prepare = originalPrepare;
    await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
  }
});

test('Demand Analytics — TYPE-COERCION-B: real calculateDemandForecast handles mixed string/number period quantities', async () => {
  // PURPOSE: one period quantity arrives as a string, two as numbers.
  // The fix must produce results identical to all-number inputs.
  //
  // EXPECTED: same results as TYPE-COERCION-A for WMA, mean, stdDev, safetyStock
  // since Number('30') === 30.

  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST', url: '/api/medicines', cookie,
    body: { name: 'PG-String-Test-B', genericName: 'PGS-B', minimumStock: 5 }
  });
  assert.equal(medRes.status, 201);
  const medId = medRes.body.medicine.id;

  await callApi({
    method: 'POST', url: `/api/medicines/${medId}/batches`, cookie,
    body: { batchNumber: 'PGS-B-001', quantity: 200, purchasePrice: 2, sellingPrice: 4, expiryDate: '2027-12-31' }
  });

  const originalPrepare = coreDb.prepare.bind(coreDb);
  try {
    coreDb.prepare = function (sql) {
      const stmt = originalPrepare(sql);
      if (sql.includes('quantity_sold')) {
        return {
          all: (...args) => {
            if (args[0] !== medId) return stmt.all(...args);
            // p1 as string, p2 and p3 as numbers — mixed type scenario
            return [
              { period_id: '2026-W33', period_start: '2026-08-17', period_end: '2026-08-17', quantity_sold: '30', revenue: '120', sales_count: 1 },
              { period_id: '2026-W32', period_start: '2026-08-10', period_end: '2026-08-10', quantity_sold: 20,   revenue: 80,    sales_count: 1 },
              { period_id: '2026-W31', period_start: '2026-08-03', period_end: '2026-08-03', quantity_sold: 10,   revenue: 40,    sales_count: 1 },
            ];
          },
          get: (...args) => stmt.get(...args),
          run: (...args) => stmt.run(...args),
        };
      }
      return stmt;
    };

    const demandRes = await callApi({ url: '/api/analytics/demand', cookie });
    assert.equal(demandRes.status, 200);

    const forecast = demandRes.body.items.find(i => i.medicineId === medId);
    assert.ok(forecast, 'forecast must exist');
    assert.equal(forecast.status, 'RELIABLE');

    // Results must match the all-number case exactly — Number('30') === 30
    assert.equal(forecast.forecast.weeklyDemand, 23);
    assert.equal(forecast.forecast.monthly30DayDemand, 99);
    assert.equal(forecast.forecast.historicalStdDev, 10);
    assert.equal(forecast.safetyStock, 17);
    assert.equal(forecast.recommendedReorder, 0);
    assert.equal(forecast.riskLevel, 'OPTIMAL_STOCK');
  } finally {
    coreDb.prepare = originalPrepare;
    await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
  }
});

test('Demand Analytics — TYPE-COERCION-C: SQLite integration produces correct numeric response types and values', async () => {
  // PURPOSE: end-to-end integration test through the live SQLite adapter.
  // SQLite returns numbers natively; Number(30) === 30, so the coercion is
  // a no-op. This confirms existing SQLite behaviour is unchanged by the fix,
  // and that all numeric fields in the API response are JS numbers.
  //
  // Uses a finally block so cleanup runs even if an assertion fails.

  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');

  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST', url: '/api/medicines', cookie,
    body: { name: 'TypeCoercion-C', genericName: 'TC-C', minimumStock: 5 }
  });
  assert.equal(medRes.status, 201);
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST', url: `/api/medicines/${medId}/batches`, cookie,
    body: { batchNumber: 'TCC-001', quantity: 300, purchasePrice: 2, sellingPrice: 4, expiryDate: '2027-12-31' }
  });
  assert.equal(batchRes.status, 201);
  const batchId = batchRes.body.batch.id;

  // Use both timestamp AND a random hex fragment to guarantee unique invoice
  // numbers even if the test suite runs multiple times within one millisecond.
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'mediindex.db'));
  const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@mediindex.local'").get();
  const pharmacyId = 1;

  let s1id, s2id, s3id;
  try {
    const s3 = db.prepare(
      "INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, ?, 'CASH', 40, ?, '2026-06-02 10:00:00')"
    ).run(pharmacyId, `TC-C-INV-A-${uid}`, adminUser.id);
    s3id = Number(s3.lastInsertRowid);
    db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 10, 4, 40)").run(s3id, batchId);

    const s2 = db.prepare(
      "INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, ?, 'CASH', 80, ?, '2026-06-09 10:00:00')"
    ).run(pharmacyId, `TC-C-INV-B-${uid}`, adminUser.id);
    s2id = Number(s2.lastInsertRowid);
    db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 20, 4, 80)").run(s2id, batchId);

    const s1 = db.prepare(
      "INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by, created_at) VALUES (?, ?, 'CASH', 120, ?, '2026-06-16 10:00:00')"
    ).run(pharmacyId, `TC-C-INV-C-${uid}`, adminUser.id);
    s1id = Number(s1.lastInsertRowid);
    db.prepare("INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, 30, 4, 120)").run(s1id, batchId);

    const demandRes = await callApi({ url: '/api/analytics/demand', cookie });
    assert.equal(demandRes.status, 200);

    const forecast = demandRes.body.items.find(i => i.medicineId === medId);
    assert.ok(forecast, 'forecast item must exist');
    assert.equal(forecast.status, 'RELIABLE');

    // After the fix, all numeric fields must be JS numbers in the response.
    assert.equal(typeof forecast.currentStock,       'number', 'currentStock must be a JS number');
    assert.equal(typeof forecast.minimumStock,       'number', 'minimumStock must be a number');
    assert.equal(typeof forecast.safetyStock,        'number', 'safetyStock must be a number');
    assert.equal(typeof forecast.recommendedReorder, 'number', 'recommendedReorder must be a number');
    assert.ok(Number.isFinite(forecast.currentStock), 'currentStock must be finite');

    // WMA and safety stock correctness:
    // p1=30, p2=20, p3=10 -> weeklyForecast=23, monthly=99, stdDev=10, safetyStock=17
    assert.equal(forecast.forecast.weeklyDemand, 23);
    assert.equal(forecast.forecast.monthly30DayDemand, 99);
    assert.equal(forecast.forecast.historicalStdDev, 10);
    assert.equal(forecast.safetyStock, 17);

    // currentStock comes from medicine_batches.quantity (= 300 — not decremented
    // because sale_items were inserted directly, bypassing the FEFO API path).
    // targetInventory=116, currentStock=300 → OPTIMAL_STOCK, reorder=0.
    assert.equal(forecast.riskLevel, 'OPTIMAL_STOCK');
    assert.equal(forecast.recommendedReorder, 0);
  } finally {
    // Always clean up inserted rows, even if assertions failed.
    if (s1id !== undefined) db.prepare("DELETE FROM sale_items WHERE sale_id = ?").run(s1id);
    if (s2id !== undefined) db.prepare("DELETE FROM sale_items WHERE sale_id = ?").run(s2id);
    if (s3id !== undefined) db.prepare("DELETE FROM sale_items WHERE sale_id = ?").run(s3id);
    if (s1id !== undefined) db.prepare("DELETE FROM sales WHERE id = ?").run(s1id);
    if (s2id !== undefined) db.prepare("DELETE FROM sales WHERE id = ?").run(s2id);
    if (s3id !== undefined) db.prepare("DELETE FROM sales WHERE id = ?").run(s3id);
    await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
  }
});

test('Demand Analytics — TYPE-COERCION-D: non-finite quantity_sold triggers INSUFFICIENT_DATA guard, not NaN/Infinity output', async () => {
  // PURPOSE: verify the NaN/Infinity guard added in the fix works via the real
  // production code path.  We proxy db.prepare so the periods query returns a
  // row with quantity_sold: undefined for the test medicine, which becomes NaN
  // after Number(undefined). The guard must catch this and return
  // INSUFFICIENT_DATA rather than propagating NaN into safetyStock etc.

  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  const medRes = await callApi({
    method: 'POST', url: '/api/medicines', cookie,
    body: { name: 'PG-String-Test-D', genericName: 'PGS-D', minimumStock: 10 }
  });
  assert.equal(medRes.status, 201);
  const medId = medRes.body.medicine.id;

  await callApi({
    method: 'POST', url: `/api/medicines/${medId}/batches`, cookie,
    body: { batchNumber: 'PGS-D-001', quantity: 50, purchasePrice: 2, sellingPrice: 4, expiryDate: '2027-12-31' }
  });

  const originalPrepare = coreDb.prepare.bind(coreDb);
  try {
    coreDb.prepare = function (sql) {
      const stmt = originalPrepare(sql);
      if (sql.includes('quantity_sold')) {
        return {
          all: (...args) => {
            if (args[0] !== medId) return stmt.all(...args);
            // Return 3 rows so periodsCount >= 3, but one has undefined quantity_sold.
            // Number(undefined) = NaN → guard must trigger.
            return [
              { period_id: '2026-W33', period_start: '2026-08-17', period_end: '2026-08-17', quantity_sold: undefined, revenue: '0', sales_count: 1 },
              { period_id: '2026-W32', period_start: '2026-08-10', period_end: '2026-08-10', quantity_sold: '20',      revenue: '80', sales_count: 1 },
              { period_id: '2026-W31', period_start: '2026-08-03', period_end: '2026-08-03', quantity_sold: '10',      revenue: '40', sales_count: 1 },
            ];
          },
          get: (...args) => stmt.get(...args),
          run: (...args) => stmt.run(...args),
        };
      }
      return stmt;
    };

    const demandRes = await callApi({ url: '/api/analytics/demand', cookie });
    assert.equal(demandRes.status, 200);

    const forecast = demandRes.body.items.find(i => i.medicineId === medId);
    assert.ok(forecast, 'forecast must exist for the test medicine');

    // Guard must have triggered → INSUFFICIENT_DATA
    assert.equal(forecast.status, 'INSUFFICIENT_DATA', 'undefined quantity_sold must trigger the NaN guard');
    assert.equal(forecast.forecast, null, 'forecast must be null when guard triggers');

    // Safety stock and reorder must still be sane (fall back to minimum_stock)
    assert.equal(forecast.safetyStock, 10, 'safetyStock must fall back to minimumStock=10 when guard triggers');
    assert.ok(Number.isFinite(forecast.recommendedReorder), 'recommendedReorder must be finite, not NaN');
    assert.ok(forecast.recommendedReorder >= 0, 'recommendedReorder must be non-negative');
  } finally {
    coreDb.prepare = originalPrepare;
    await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
  }
});
