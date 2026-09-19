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
  assert.equal(dashboard.body.totalMedicines, 0);
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
