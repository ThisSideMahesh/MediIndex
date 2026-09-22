const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler, passwordHash, passwordMatches } = require('../core');

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

test('password hashes never store plaintext and validate correctly', () => {
  const hash = passwordHash('secret');
  assert.notEqual(hash, 'secret');
  assert.equal(passwordMatches('secret', hash), true);
  assert.equal(passwordMatches('wrong', hash), false);
});

test('valid login creates a protected session', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  assert.equal(login.status, 200);
  assert.match(login.headers['Set-Cookie'], /HttpOnly/);
  const dashboard = await callApi({ url: '/api/dashboard', cookie: login.headers['Set-Cookie'] });
  assert.equal(dashboard.status, 200);
  assert.ok(typeof dashboard.body.totalMedicines === 'number', 'totalMedicines must be a number');
});

test('invalid login and unauthenticated dashboard are rejected', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'wrong' } });
  assert.equal(login.status, 401);
  const dashboard = await callApi({ url: '/api/dashboard' });
  assert.equal(dashboard.status, 401);
});

test('administrator can create, search, batch-stock and deactivate a medicine', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];
  const medicine = await callApi({ method: 'POST', url: '/api/medicines', cookie, body: { name: 'Test Paracetamol', genericName: 'Paracetamol', manufacturer: 'Synthetic Labs', category: 'Tablet', minimumStock: 10 } });
  assert.equal(medicine.status, 201);
  const medicineId = medicine.body.medicine.id;
  const batch = await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/batches`, cookie, body: { batchNumber: 'TEST-2030', quantity: 25, purchasePrice: 5, sellingPrice: 8, expiryDate: '2030-12-31', location: 'Test shelf' } });
  assert.equal(batch.status, 201);
  const search = await callApi({ url: '/api/medicines?q=Test%20Paracetamol', cookie });
  assert.equal(search.body.medicines[0].total_stock, 25);
  const batches = await callApi({ url: `/api/medicines/${medicineId}/batches`, cookie });
  assert.equal(batches.body.batches[0].expiry_status, 'SAFE');
  const deleteResult = await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });
  assert.equal(deleteResult.status, 200);
});

test('expiry alerts are generated from batch dates and can be acknowledged', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];
  const medicine = await callApi({ method: 'POST', url: '/api/medicines', cookie, body: { name: 'Expiry Alert Test', minimumStock: 1 } });
  const medicineId = medicine.body.medicine.id;
  await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/batches`, cookie, body: { batchNumber: 'EXPIRED-TEST', quantity: 4, sellingPrice: 2, expiryDate: '2020-01-01' } });
  const alerts = await callApi({ url: '/api/expiry-alerts?status=EXPIRED&acknowledged=0', cookie });
  const alert = alerts.body.alerts.find(item => item.medicine_id === medicineId);
  assert.equal(alert.alert_type, 'EXPIRED');
  const acknowledged = await callApi({ method: 'POST', url: `/api/expiry-alerts/${alert.id}/acknowledge`, cookie });
  assert.equal(acknowledged.status, 200);
  const after = await callApi({ url: '/api/expiry-alerts?status=EXPIRED&acknowledged=1', cookie });
  assert.ok(after.body.alerts.some(item => item.id === alert.id && item.acknowledged === 1));
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });
});

// ─── Medicine Reactivation Regression Tests ───────────────────────────────────

test('medicine reactivation: deactivated medicine is excluded from active listing', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Create a medicine
  const created = await callApi({ method: 'POST', url: '/api/medicines', cookie, body: { name: 'Reactivation Test Alpha', genericName: 'Test Drug A', category: 'Tablet', minimumStock: 5 } });
  assert.equal(created.status, 201);
  const medicineId = created.body.medicine.id;

  // Deactivate it
  const deactivated = await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });
  assert.equal(deactivated.status, 200);

  // Must NOT appear in active listing
  const active = await callApi({ url: '/api/medicines?q=Reactivation+Test+Alpha', cookie });
  assert.equal(active.status, 200);
  assert.equal(active.body.medicines.find(m => m.id === medicineId), undefined, 'Deactivated medicine must not appear in active list');

  // Cleanup (leave deactivated — other tests clean up their own medicines)
});

test('medicine reactivation: GET /api/medicines/inactive lists inactive medicines (Admin only)', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Create and deactivate a medicine
  const created = await callApi({ method: 'POST', url: '/api/medicines', cookie, body: { name: 'Reactivation Test Beta', genericName: 'Test Drug B', minimumStock: 0 } });
  const medicineId = created.body.medicine.id;
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });

  // Must appear in inactive listing
  const inactive = await callApi({ url: '/api/medicines/inactive', cookie });
  assert.equal(inactive.status, 200);
  assert.ok(Array.isArray(inactive.body.medicines), 'Response must contain medicines array');
  const found = inactive.body.medicines.find(m => m.id === medicineId);
  assert.ok(found, 'Deactivated medicine must appear in /api/medicines/inactive');
  assert.equal(found.active, 0, 'Inactive medicine must have active=0');
});

test('medicine reactivation: STAFF cannot access inactive list (403)', async () => {
  const staffLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' } });
  const staffCookie = staffLogin.headers['Set-Cookie'];

  const res = await callApi({ url: '/api/medicines/inactive', cookie: staffCookie });
  assert.equal(res.status, 403, 'STAFF must not access /api/medicines/inactive');
});

test('medicine reactivation: Admin can reactivate an inactive medicine', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Create, add batch, then deactivate
  const created = await callApi({ method: 'POST', url: '/api/medicines', cookie, body: { name: 'Reactivation Test Gamma', genericName: 'Test Drug C', minimumStock: 3 } });
  const medicineId = created.body.medicine.id;
  await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/batches`, cookie, body: { batchNumber: 'REACT-001', quantity: 20, sellingPrice: 5, expiryDate: '2030-06-30' } });
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });

  // Reactivate
  const reactivated = await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/reactivate`, cookie });
  assert.equal(reactivated.status, 200, `Expected 200, got: ${JSON.stringify(reactivated.body)}`);
  assert.ok(reactivated.body.medicine, 'Reactivated response must include medicine object');
  assert.equal(reactivated.body.medicine.id, medicineId);
  assert.equal(reactivated.body.medicine.active, 1, 'Reactivated medicine must have active=1');
});

test('medicine reactivation: reactivated medicine appears in active listing', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  const created = await callApi({ method: 'POST', url: '/api/medicines', cookie, body: { name: 'Reactivation Test Delta', minimumStock: 0 } });
  const medicineId = created.body.medicine.id;
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });
  await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/reactivate`, cookie });

  // Must appear in active listing
  const active = await callApi({ url: '/api/medicines?q=Reactivation+Test+Delta', cookie });
  assert.equal(active.status, 200);
  assert.ok(active.body.medicines.find(m => m.id === medicineId), 'Reactivated medicine must appear in active list');

  // Must NOT appear in inactive listing
  const inactive = await callApi({ url: '/api/medicines/inactive', cookie });
  assert.equal(inactive.body.medicines.find(m => m.id === medicineId), undefined, 'Reactivated medicine must not appear in inactive list');

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });
});

test('medicine reactivation: existing batch stock is preserved after deactivate/reactivate cycle', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  const created = await callApi({ method: 'POST', url: '/api/medicines', cookie, body: { name: 'Reactivation Test Epsilon', minimumStock: 0 } });
  const medicineId = created.body.medicine.id;
  await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/batches`, cookie, body: { batchNumber: 'STOCK-PRESERVE', quantity: 77, sellingPrice: 3, expiryDate: '2031-12-31' } });

  // Deactivate then reactivate
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });
  await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/reactivate`, cookie });

  // Batch stock must be unchanged
  const batches = await callApi({ url: `/api/medicines/${medicineId}/batches`, cookie });
  assert.equal(batches.status, 200);
  const batch = batches.body.batches.find(b => b.batch_number === 'STOCK-PRESERVE');
  assert.ok(batch, 'Batch must still exist after reactivation');
  assert.equal(batch.quantity, 77, 'Batch quantity must be unchanged after reactivation');

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });
});

test('medicine reactivation: STAFF cannot reactivate a medicine (403)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];
  const staffLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' } });
  const staffCookie = staffLogin.headers['Set-Cookie'];

  // Create and deactivate as admin
  const created = await callApi({ method: 'POST', url: '/api/medicines', cookie: adminCookie, body: { name: 'Reactivation Test Zeta', minimumStock: 0 } });
  const medicineId = created.body.medicine.id;
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie: adminCookie });

  // Attempt reactivation as staff
  const res = await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/reactivate`, cookie: staffCookie });
  assert.equal(res.status, 403, 'STAFF must not be able to reactivate medicines');

  // Cleanup
  await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/reactivate`, cookie: adminCookie });
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie: adminCookie });
});

test('medicine reactivation: cross-pharmacy tenant isolation', async () => {
  // The test database only has one pharmacy, so we verify via the 404 response
  // for a medicine ID that simply does not belong to this pharmacy.
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Use a non-existent / wrong-pharmacy ID
  const res = await callApi({ method: 'POST', url: '/api/medicines/999999/reactivate', cookie });
  assert.equal(res.status, 404, 'Reactivating a medicine from another pharmacy must return 404');
});

test('medicine reactivation: already-active medicine returns 409', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  const created = await callApi({ method: 'POST', url: '/api/medicines', cookie, body: { name: 'Reactivation Test Eta', minimumStock: 0 } });
  const medicineId = created.body.medicine.id;

  // Attempt to reactivate an already-active medicine
  const res = await callApi({ method: 'POST', url: `/api/medicines/${medicineId}/reactivate`, cookie });
  assert.equal(res.status, 409, 'Reactivating an already-active medicine must return 409');
  assert.ok(res.body.error, 'Must return an error message');

  // Cleanup
  await callApi({ method: 'DELETE', url: `/api/medicines/${medicineId}`, cookie });
});
