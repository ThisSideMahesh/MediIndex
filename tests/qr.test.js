const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler } = require('../app');

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

test('QR Module: Unauthenticated access to QR endpoints is rejected', async () => {
  const getQr = await callApi({ url: '/api/batches/1/qr' });
  assert.equal(getQr.status, 401);

  const lookup = await callApi({ method: 'POST', url: '/api/qr/lookup', body: { payload: 'test' } });
  assert.equal(lookup.status, 401);
});

test('QR Module: Batch QR payload generation and sticker details format', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Create medicine and batch
  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Azithromycin 500mg', genericName: 'Azithromycin', category: 'Tablet', minimumStock: 10 }
  });
  assert.equal(medRes.status, 201);
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'AZI-LOT-2027', quantity: 50, purchasePrice: 15, sellingPrice: 25, expiryDate: '2027-06-30', location: 'Rack C3' }
  });
  assert.equal(batchRes.status, 201);
  const batchId = batchRes.body.batch.id;

  // Query QR metadata endpoint
  const qrRes = await callApi({ url: `/api/batches/${batchId}/qr`, cookie });
  assert.equal(qrRes.status, 200);

  // Validate versioned payload specification
  assert.equal(qrRes.body.payload.app, 'MEDIINDEX');
  assert.equal(qrRes.body.payload.v, 1);
  assert.equal(qrRes.body.payload.medicineId, medId);
  assert.equal(qrRes.body.payload.batchNumber, 'AZI-LOT-2027');

  // Validate sticker metadata
  assert.equal(qrRes.body.sticker.medicineName, 'Azithromycin 500mg');
  assert.equal(qrRes.body.sticker.batchNumber, 'AZI-LOT-2027');
  assert.equal(qrRes.body.sticker.expiryDate, '2027-06-30');
  assert.equal(qrRes.body.sticker.sellingPrice, 25);
  assert.equal(qrRes.body.sticker.location, 'Rack C3');

  // Clean up
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('QR Module: Authoritative database resolution from valid JSON payload and pipe string', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Create medicine and batch
  const medRes = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie,
    body: { name: 'Ibuprofen 400mg', genericName: 'Ibuprofen', minimumStock: 5 }
  });
  const medId = medRes.body.medicine.id;

  const batchRes = await callApi({
    method: 'POST',
    url: `/api/medicines/${medId}/batches`,
    cookie,
    body: { batchNumber: 'IBU-9900', quantity: 30, sellingPrice: 6.5, expiryDate: '2027-10-15' }
  });
  const batchId = batchRes.body.batch.id;

  // 1. Test lookup via JSON Object payload
  const lookupJsonObj = await callApi({
    method: 'POST',
    url: '/api/qr/lookup',
    cookie,
    body: {
      payload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'IBU-9900' }
    }
  });
  assert.equal(lookupJsonObj.status, 200);
  assert.equal(lookupJsonObj.body.valid, true);
  assert.equal(lookupJsonObj.body.authoritative, true);
  assert.equal(lookupJsonObj.body.medicine.name, 'Ibuprofen 400mg');
  assert.equal(lookupJsonObj.body.batch.batchNumber, 'IBU-9900');
  assert.equal(lookupJsonObj.body.batch.sellingPrice, 6.5);
  assert.equal(lookupJsonObj.body.batch.quantity, 30);
  assert.equal(lookupJsonObj.body.batch.expiryStatus, 'SAFE');

  // 2. Test lookup via JSON String payload (standard barcode scanner emulation)
  const lookupJsonStr = await callApi({
    method: 'POST',
    url: '/api/qr/lookup',
    cookie,
    body: {
      payload: JSON.stringify({ app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'IBU-9900' })
    }
  });
  assert.equal(lookupJsonStr.status, 200);
  assert.equal(lookupJsonStr.body.batch.id, batchId);

  // 3. Test lookup via Pipe String format: MEDIINDEX|v1|medId|batchNumber
  const lookupPipe = await callApi({
    method: 'POST',
    url: '/api/qr/lookup',
    cookie,
    body: {
      payload: `MEDIINDEX|v1|${medId}|IBU-9900`
    }
  });
  assert.equal(lookupPipe.status, 200);
  assert.equal(lookupPipe.body.medicine.id, medId);

  // Clean up
  await callApi({ method: 'DELETE', url: `/api/medicines/${medId}`, cookie });
});

test('QR Module: Rejection of invalid, foreign, or corrupted payloads', async () => {
  const login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const cookie = login.headers['Set-Cookie'];

  // Foreign app QR code
  const foreignRes = await callApi({
    method: 'POST',
    url: '/api/qr/lookup',
    cookie,
    body: { payload: { app: 'OTHERAPP', v: 1, medicineId: 1, batchNumber: 'LOT-1' } }
  });
  assert.equal(foreignRes.status, 400);
  assert.match(foreignRes.body.error, /MEDIINDEX/);

  // Unsupported version
  const badVersion = await callApi({
    method: 'POST',
    url: '/api/qr/lookup',
    cookie,
    body: { payload: { app: 'MEDIINDEX', v: 99, medicineId: 1, batchNumber: 'LOT-1' } }
  });
  assert.equal(badVersion.status, 400);
  assert.match(badVersion.body.error, /Unsupported QR version/);

  // Non-existent medicine ID
  const notFoundRes = await callApi({
    method: 'POST',
    url: '/api/qr/lookup',
    cookie,
    body: { payload: { app: 'MEDIINDEX', v: 1, medicineId: 999999, batchNumber: 'LOT-FAKE' } }
  });
  assert.equal(notFoundRes.status, 404);
  assert.match(notFoundRes.body.error, /No active medicine batch found/);
});
