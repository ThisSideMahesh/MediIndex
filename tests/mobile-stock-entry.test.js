const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { handler, passwordHash, hashDeviceToken, db } = require('../server');

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

test('MOB-STOCK-001: Device Authentication Guard (Unauthenticated / Missing / Fake Token Rejected)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Amoxicillin Auth Guard Test', genericName: 'Amoxicillin', minimumStock: 10 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'AMOX-AUTH-01', quantity: 100, sellingPrice: 15, expiryDate: '2027-12-31', location: 'Rack B1' }
    });
    batchId = batchRes.body.batch.id;

    // 1. Unauthenticated request without token
    const unauthRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'AMOX-AUTH-01' }, quantity: 20 }
    });
    assert.equal(unauthRes.status, 401);
    assert.match(unauthRes.body.error, /device authentication required|invalid or revoked/i);

    // 2. Invalid fake device token
    const invalidTokenRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': 'medidev_invalid_fake_token_12345' },
      body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'AMOX-AUTH-01' }, quantity: 20 }
    });
    assert.equal(invalidTokenRes.status, 401);
  } finally {
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-002: Hardware Revocation Guard (Revoked Device Rejected Immediately)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Revocation Guard Drug', genericName: 'RevokeMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'REV-LOT-01', quantity: 50, sellingPrice: 10, expiryDate: '2028-01-01' }
    });
    batchId = batchRes.body.batch.id;

    // Pair a valid device
    const pairCodeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimRes = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCodeRes.body.pairingCode, deviceName: 'Revocation Scanner T2' }
    });
    const deviceToken = claimRes.body.deviceToken;
    deviceId = claimRes.body.deviceId;

    // Revoke device via admin endpoint
    await callApi({ method: 'POST', url: `/api/mobile/devices/${deviceId}/revoke`, cookie: adminCookie });

    // Revoked device must receive 401 Unauthorized
    const revokedRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'REV-LOT-01' }, quantity: 20 }
    });
    assert.equal(revokedRes.status, 401);
  } finally {
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-003: Stock Intake & Quantity Arithmetic (Valid Submission Increments Batch)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Paracetamol 650mg Mobile Stock', genericName: 'Paracetamol', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'PARA-STK-01', quantity: 50, sellingPrice: 3.5, expiryDate: '2028-05-30', location: 'Rack A1' }
    });
    batchId = batchRes.body.batch.id;

    // Pair active device
    const pairCodeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimRes = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCodeRes.body.pairingCode, deviceName: 'Warehouse Scanner A1' }
    });
    const deviceToken = claimRes.body.deviceToken;
    deviceId = claimRes.body.deviceId;

    // Submit stock intake of +30 units
    const intakeRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'PARA-STK-01' },
        quantity: 30
      }
    });

    assert.equal(intakeRes.status, 200);
    assert.equal(intakeRes.body.success, true);
    assert.equal(intakeRes.body.status, 'STOCK_UPDATED');
    assert.equal(intakeRes.body.idempotent, false);
    assert.equal(intakeRes.body.batch.quantityAdded, 30);
    assert.equal(intakeRes.body.batch.currentStock, 80);
    assert.equal(intakeRes.body.deviceId, deviceId);
    assert.ok(intakeRes.body.movementId);

    // Verify in database: quantity = 50 + 30 = 80
    const updatedBatch = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(updatedBatch.quantity, 80);
  } finally {
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-004: Movement Audit Trail (Attribution to Authorizing User & Originating Hardware Device)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Audit Trail Test Drug', genericName: 'AuditMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'AUD-LOT-99', quantity: 20, sellingPrice: 5, expiryDate: '2028-10-10' }
    });
    batchId = batchRes.body.batch.id;

    const pairCodeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimRes = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCodeRes.body.pairingCode, deviceName: 'Audit Scanner Alpha' }
    });
    const deviceToken = claimRes.body.deviceToken;
    deviceId = claimRes.body.deviceId;

    const intakeRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'AUD-LOT-99' },
        quantity: 15
      }
    });
    assert.equal(intakeRes.status, 200);

    // Verify inventory_movements record contains both created_by (admin) AND device_id (mobile hardware)
    const movement = db.prepare('SELECT * FROM inventory_movements WHERE id = ?').get(intakeRes.body.movementId);
    assert.ok(movement);
    assert.equal(movement.batch_id, batchId);
    assert.equal(movement.change_quantity, 15);
    assert.equal(movement.reason, 'RECEIPT');
    assert.ok(movement.created_by);
    assert.equal(movement.device_id, deviceId);
  } finally {
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-005: Input & Boundary Validation (Float, Zero, Negative, and Exceeding Bound Rejected)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Boundary Guard Drug', genericName: 'Boundary', minimumStock: 2 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'BND-LOT-1', quantity: 10, sellingPrice: 10, expiryDate: '2028-01-01' }
    });
    batchId = batchRes.body.batch.id;

    const pairCodeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimRes = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCodeRes.body.pairingCode, deviceName: 'Boundary Test Device' }
    });
    const deviceToken = claimRes.body.deviceToken;
    deviceId = claimRes.body.deviceId;

    // 1. Float quantity
    const floatRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'BND-LOT-1' }, quantity: 10.5 }
    });
    assert.equal(floatRes.status, 400);

    // 2. String quantity
    const stringRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'BND-LOT-1' }, quantity: 'fifty' }
    });
    assert.equal(stringRes.status, 400);

    // 3. Zero quantity
    const zeroRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'BND-LOT-1' }, quantity: 0 }
    });
    assert.equal(zeroRes.status, 400);

    // 4. Negative quantity
    const negRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'BND-LOT-1' }, quantity: -10 }
    });
    assert.equal(negRes.status, 400);

    // 5. Exceeding upper boundary (100,000)
    const exceedRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'BND-LOT-1' }, quantity: 100001 }
    });
    assert.equal(exceedRes.status, 400);
    assert.match(exceedRes.body.error, /exceeds maximum allowable limit/i);
  } finally {
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-006: QR Validation & Multi-Format Parsing (Pipe, JSON Object, and Rejection of Bad Tags)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'QR Format Drug', genericName: 'QRFormat', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'QR-FMT-01', quantity: 40, sellingPrice: 20, expiryDate: '2028-12-31' }
    });
    batchId = batchRes.body.batch.id;

    const pairCodeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimRes = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCodeRes.body.pairingCode, deviceName: 'QR Scanner' }
    });
    const deviceToken = claimRes.body.deviceToken;
    deviceId = claimRes.body.deviceId;

    // 1. Valid Pipe-delimited string
    const pipeRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: `MEDIINDEX|v1|${medId}|QR-FMT-01`, quantity: 10 }
    });
    assert.equal(pipeRes.status, 200);
    assert.equal(pipeRes.body.batch.currentStock, 50);

    // 2. Foreign application QR rejected (400)
    const foreignRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: { app: 'OTHER_APP', v: 1, medicineId: medId, batchNumber: 'QR-FMT-01' }, quantity: 10 }
    });
    assert.equal(foreignRes.status, 400);

    // 3. Corrupted QR string rejected (400)
    const malformedRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: { qrPayload: 'CORRUPTED_NON_RECOGNIZED_STRING', quantity: 10 }
    });
    assert.equal(malformedRes.status, 400);
  } finally {
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-007: Tenant Spoofing Protection (Client-Supplied pharmacy_id Rejected)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Spoof Guard Drug', genericName: 'SpoofGuard', minimumStock: 2 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'SPF-LOT-1', quantity: 10, sellingPrice: 10, expiryDate: '2028-01-01' }
    });
    batchId = batchRes.body.batch.id;

    const pairCodeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimRes = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCodeRes.body.pairingCode, deviceName: 'Spoof Test Device' }
    });
    const deviceToken = claimRes.body.deviceToken;
    deviceId = claimRes.body.deviceId;

    // Client passes explicit pharmacyId
    const spoofRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        pharmacyId: 9999,
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'SPF-LOT-1' },
        quantity: 10
      }
    });
    assert.equal(spoofRes.status, 400);
    assert.match(spoofRes.body.error, /pharmacy_id/i);
  } finally {
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-008: Cross-Pharmacy Isolation & Rollback (Foreign Pharmacy Batch Rejected 404, Stock Unchanged)', async () => {
  let device1Id = null;
  let pharmacy2Id = null;
  let med2Id = null;
  let batch2Id = null;

  try {
    const admin1Login = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
    const admin1Cookie = admin1Login.headers['Set-Cookie'];

    const pairCode1 = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: admin1Cookie });
    const claim1 = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode1.body.pairingCode, deviceName: 'Pharmacy 1 Device' }
    });
    const device1Token = claim1.body.deviceToken;
    device1Id = claim1.body.deviceId;

    // Create Pharmacy 2 and medicine in Pharmacy 2
    db.prepare("INSERT INTO pharmacies (name, address) VALUES ('Isolated Branch 2', 'Nanded')").run();
    const pharmacy2 = db.prepare("SELECT id FROM pharmacies WHERE name = 'Isolated Branch 2'").get();
    pharmacy2Id = pharmacy2.id;
    const med2Res = db.prepare("INSERT INTO medicines (pharmacy_id, name, generic_name, minimum_stock) VALUES (?, 'Branch 2 Antibiotic', 'Antibiotic', 5)").run(pharmacy2Id);
    med2Id = Number(med2Res.lastInsertRowid);
    const batch2Res = db.prepare("INSERT INTO medicine_batches (medicine_id, batch_number, quantity, selling_price, expiry_date) VALUES (?, 'BR2-LOT-55', 40, 20, '2028-10-10')").run(med2Id);
    batch2Id = Number(batch2Res.lastInsertRowid);

    // Device 1 attempts stock entry on Pharmacy 2 medicine
    const crossRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': device1Token },
      body: {
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: med2Id, batchNumber: 'BR2-LOT-55' },
        quantity: 15
      }
    });
    assert.equal(crossRes.status, 404);

    // Pharmacy 2 stock must remain exactly 40
    const batch2Stock = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batch2Id);
    assert.equal(batch2Stock.quantity, 40);
  } finally {
    if (batch2Id) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batch2Id);
    if (device1Id) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(device1Id);
    if (batch2Id) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batch2Id);
    if (med2Id) db.prepare('DELETE FROM medicines WHERE id = ?').run(med2Id);
    if (pharmacy2Id) db.prepare('DELETE FROM pharmacies WHERE id = ?').run(pharmacy2Id);
  }
});

test('MOB-STOCK-009: Idempotency Network Retry Replay (Same Key Returns Previous Result Without Stock Mutation)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;
  let idempotencyKey = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Idempotency Replay Drug', genericName: 'IdemDrug', minimumStock: 10 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'IDEM-RPL-01', quantity: 100, sellingPrice: 50, expiryDate: '2027-11-15' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Replay Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    idempotencyKey = 'retry-uuid-' + crypto.randomBytes(8).toString('hex');

    // First request: +25 units
    const req1 = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        idempotencyKey,
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'IDEM-RPL-01' },
        quantity: 25
      }
    });
    assert.equal(req1.status, 200);
    assert.equal(req1.body.idempotent, false);
    assert.equal(req1.body.batch.currentStock, 125);
    const movementId1 = req1.body.movementId;

    // Repeated request with same key
    const req2 = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        idempotencyKey,
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'IDEM-RPL-01' },
        quantity: 25
      }
    });
    assert.equal(req2.status, 200);
    assert.equal(req2.body.idempotent, true);
    assert.equal(req2.body.batch.currentStock, 125);
    assert.equal(req2.body.movementId, movementId1);

    // Stock must be exactly 125 (NOT 150)
    const finalStock = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(finalStock.quantity, 125);

    // Inventory movements count for RECEIPT must be exactly 2 (1 from batch creation + 1 from first intake)
    const movementsCount = db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE batch_id = ?').get(batchId);
    assert.equal(movementsCount.count, 2);
  } finally {
    if (idempotencyKey) db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(idempotencyKey);
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-010: Idempotency Conflict Resolution (Reused Key with Different Payload Returns 409 Conflict)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;
  let idempotencyKey = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Conflict Test Drug', genericName: 'ConflictMed', minimumStock: 10 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'CONF-LOT-01', quantity: 50, sellingPrice: 25, expiryDate: '2028-06-30' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Conflict Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    idempotencyKey = 'conflict-uuid-' + crypto.randomBytes(8).toString('hex');

    // First request: +20 units
    const req1 = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        idempotencyKey,
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'CONF-LOT-01' },
        quantity: 20
      }
    });
    assert.equal(req1.status, 200);

    // Second request: Same idempotency key with DIFFERENT quantity (+50)
    const reqConflict = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        idempotencyKey,
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'CONF-LOT-01' },
        quantity: 50
      }
    });
    assert.equal(reqConflict.status, 409);
    assert.match(reqConflict.body.error, /conflict/i);
  } finally {
    if (idempotencyKey) db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(idempotencyKey);
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('MOB-STOCK-011: Real Concurrent Submissions (Promise.all Parallel Requests Mutate Stock Exactly Once)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;
  let idempotencyKey = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Concurrency Test Vaccine', genericName: 'ConcVaccine', minimumStock: 10 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'CONC-LOT-88', quantity: 100, sellingPrice: 60, expiryDate: '2028-11-20' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Concurrency Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    idempotencyKey = 'conc-uuid-' + crypto.randomBytes(8).toString('hex');

    const payload = {
      idempotencyKey,
      qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'CONC-LOT-88' },
      quantity: 40
    };

    // Fire two concurrent requests simultaneously over the in-process event loop
    const [resA, resB] = await Promise.all([
      callApi({ method: 'POST', url: '/api/mobile/stock-entry', headers: { 'x-device-token': deviceToken }, body: payload }),
      callApi({ method: 'POST', url: '/api/mobile/stock-entry', headers: { 'x-device-token': deviceToken }, body: payload })
    ]);

    // Invariant 1: Both requests must succeed (200 OK)
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);

    // Invariant 2: One request performed mutation (idempotent: false), other received replay (idempotent: true)
    const idempotentFlags = [resA.body.idempotent, resB.body.idempotent].sort();
    assert.deepEqual(idempotentFlags, [false, true]);

    // Invariant 3: Both returned the same final stock (100 + 40 = 140)
    assert.equal(resA.body.batch.currentStock, 140);
    assert.equal(resB.body.batch.currentStock, 140);

    // Invariant 4: Database stock increased EXACTLY ONCE (+40, NOT +80)
    const dbBatch = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(dbBatch.quantity, 140);

    // Invariant 5: Exactly 1 intake inventory movement created (2 total including batch creation)
    const movements = db.prepare('SELECT COUNT(*) AS count FROM inventory_movements WHERE batch_id = ?').get(batchId);
    assert.equal(movements.count, 2);

    // Invariant 6: Exactly 1 idempotency key record stored
    const keysCount = db.prepare('SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = ?').get(idempotencyKey);
    assert.equal(keysCount.count, 1);
  } finally {
    if (idempotencyKey) db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(idempotencyKey);
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});
