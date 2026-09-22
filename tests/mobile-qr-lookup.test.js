/**
 * Mobile QR Lookup API Tests
 * Tests the /api/mobile/qr/lookup endpoint for device-authenticated QR validation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler } = require('../core');

function callApi({ method, url, body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method || 'GET';
    req.url = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}), ...headers };
    const res = {
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
      end(payload) { resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : undefined }); }
    };
    handler(req, res).catch(reject);
    if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

test('QR-LOOKUP-001: Valid QR JSON format lookup returns medicine and batch details', async () => {
  // Use existing demo user and login
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  assert.equal(login.status, 200);

  // Create device pairing
  const pairingCode = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/create',
    cookie: login.headers['Set-Cookie']
  });
  assert.equal(pairingCode.status, 201);

  // Complete pairing to get device token
  const pairing = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: {
      pairingCode: pairingCode.body.pairingCode,
      deviceName: 'Test Scanner',
      deviceModel: 'Mobile Device'
    }
  });
  assert.equal(pairing.status, 201);
  const deviceToken = pairing.body.deviceToken;

  // Create test medicine
  const medicine = await callApi({
    method: 'POST',
    url: '/api/medicines',
    cookie: login.headers['Set-Cookie'],
    body: {
      name: 'Test Medicine',
      genericName: 'Test Generic',
      manufacturer: 'Test Mfg',
      category: 'TABLET',
      minimumStock: 10
    }
  });
  assert.equal(medicine.status, 201);
  const medicineId = medicine.body.medicine.id;

  // Create test batch
  const batch = await callApi({
    method: 'POST',
    url: `/api/medicines/${medicineId}/batches`,
    cookie: login.headers['Set-Cookie'],
    body: {
      batchNumber: 'BATCH001',
      quantity: 100,
      purchasePrice: 10.00,
      sellingPrice: 15.00,
      manufacturingDate: '2024-01-01',
      expiryDate: '2026-12-31',
      location: 'Shelf A1'
    }
  });
  assert.equal(batch.status, 201);
  
  // Test: Valid QR lookup
  const qrPayload = {
    app: 'MEDIINDEX',
    v: 1,
    medicineId: medicineId,
    batchNumber: 'BATCH001'
  };

  const response = await callApi({
    method: 'POST',
    url: '/api/mobile/qr/lookup',
    headers: { 'x-device-token': deviceToken },
    body: { qrPayload }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.valid, true);
  assert.equal(response.body.authoritative, true);
  assert.equal(response.body.medicine.name, 'Test Medicine');
  assert.equal(response.body.batch.batchNumber, 'BATCH001');
  assert.equal(response.body.batch.quantity, 100);
  assert.equal(response.body.batch.expiryStatus, 'VALID');
});

test('QR-LOOKUP-002: Authentication required - reject requests without device token', async () => {
  const response = await callApi({
    method: 'POST',
    url: '/api/mobile/qr/lookup',
    body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: 1, batchNumber: 'TEST' } }
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'Device authentication required. Invalid or revoked device token.');
});

test('QR-LOOKUP-003: Authentication required - reject requests with invalid device token', async () => {
  const response = await callApi({
    method: 'POST',
    url: '/api/mobile/qr/lookup',
    headers: { 'x-device-token': 'invalid_token' },
    body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: 1, batchNumber: 'TEST' } }
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'Device authentication required. Invalid or revoked device token.');
});

test('QR-LOOKUP-004: Invalid QR payload validation - reject QR with wrong app identifier', async () => {
  // Get a valid device token first
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  
  const pairingCode = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/create',
    cookie: login.headers['Set-Cookie']
  });
  
  const pairing = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: {
      pairingCode: pairingCode.body.pairingCode,
      deviceName: 'Test Scanner',
      deviceModel: 'Mobile Device'
    }
  });
  const deviceToken = pairing.body.deviceToken;

  const response = await callApi({
    method: 'POST',
    url: '/api/mobile/qr/lookup',
    headers: { 'x-device-token': deviceToken },
    body: { qrPayload: { app: 'WRONG', v: 1, medicineId: 1, batchNumber: 'BATCH001' } }
  });

  assert.equal(response.status, 400);
  assert.ok(response.body.error.includes('Invalid QR payload'));
});

test('QR-LOOKUP-005: Medicine not found returns 404', async () => {
  // Get a valid device token first
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  
  const pairingCode = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/create',
    cookie: login.headers['Set-Cookie']
  });
  
  const pairing = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: {
      pairingCode: pairingCode.body.pairingCode,
      deviceName: 'Test Scanner',
      deviceModel: 'Mobile Device'
    }
  });
  const deviceToken = pairing.body.deviceToken;

  const response = await callApi({
    method: 'POST',
    url: '/api/mobile/qr/lookup',
    headers: { 'x-device-token': deviceToken },
    body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: 99999, batchNumber: 'BATCH001' } }
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.valid, false);
  assert.equal(response.body.authoritative, true);
  assert.ok(response.body.error.includes('Medicine ID 99999 not found'));
});