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

test('SYNC-001: Bulk Submission of 5 Valid Operations (All 5 Synchronize Atomically)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  const batchIds = [];
  let deviceId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Bulk Sync Test Med', genericName: 'BulkGeneric', minimumStock: 10 }
    });
    medId = medRes.body.medicine.id;

    for (let i = 1; i <= 5; i++) {
      const batchRes = await callApi({
        method: 'POST',
        url: `/api/medicines/${medId}/batches`,
        cookie: adminCookie,
        body: { batchNumber: `BULK-LOT-0${i}`, quantity: 50, sellingPrice: 10 * i, expiryDate: '2028-12-31' }
      });
      batchIds.push(batchRes.body.batch.id);
    }

    const pairCodeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimRes = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCodeRes.body.pairingCode, deviceName: 'Bulk Scanner 01' }
    });
    const deviceToken = claimRes.body.deviceToken;
    deviceId = claimRes.body.deviceId;

    const operations = batchIds.map((bId, idx) => ({
      operationId: `op-bulk-0${idx + 1}`,
      idempotencyKey: `bulk-key-0${idx + 1}-${crypto.randomBytes(4).toString('hex')}`,
      qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: `BULK-LOT-0${idx + 1}` },
      quantity: 10 * (idx + 1),
      clientCreatedAt: new Date().toISOString()
    }));

    const syncRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: { operations }
    });

    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.success, true);
    assert.equal(syncRes.body.summary.total, 5);
    assert.equal(syncRes.body.summary.synced, 5);
    assert.equal(syncRes.body.summary.idempotent, 0);
    assert.equal(syncRes.body.summary.failed, 0);

    for (let i = 0; i < 5; i++) {
      const b = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchIds[i]);
      assert.equal(b.quantity, 50 + 10 * (i + 1));
    }
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    for (const bId of batchIds) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(bId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(bId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    for (const bId of batchIds) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(bId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-002: Mixed Batch Resilience (3 Valid, 1 Invalid Batch, 1 Duplicate — No Unrelated Rollbacks)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  const batchIds = [];
  let deviceId = null;
  const duplicateKey = 'dup-key-' + crypto.randomBytes(6).toString('hex');

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Mixed Batch Test Drug', genericName: 'MixedMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;

    for (let i = 1; i <= 3; i++) {
      const batchRes = await callApi({
        method: 'POST',
        url: `/api/medicines/${medId}/batches`,
        cookie: adminCookie,
        body: { batchNumber: `MIX-LOT-0${i}`, quantity: 100, sellingPrice: 15, expiryDate: '2028-10-10' }
      });
      batchIds.push(batchRes.body.batch.id);
    }

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Mixed Batch Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    // Pre-commit an intake to establish duplicate key
    await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        idempotencyKey: duplicateKey,
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'MIX-LOT-01' },
        quantity: 25
      }
    });

    const operations = [
      { operationId: 'op-valid-1', idempotencyKey: 'vk1-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'MIX-LOT-01' }, quantity: 10 },
      { operationId: 'op-valid-2', idempotencyKey: 'vk2-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'MIX-LOT-02' }, quantity: 20 },
      { operationId: 'op-invalid-batch', idempotencyKey: 'vk-err-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'NON_EXISTENT_LOT_99' }, quantity: 30 },
      { operationId: 'op-duplicate', idempotencyKey: duplicateKey, qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'MIX-LOT-01' }, quantity: 25 },
      { operationId: 'op-valid-3', idempotencyKey: 'vk3-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'MIX-LOT-03' }, quantity: 40 }
    ];

    const syncRes = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: { operations }
    });

    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.summary.total, 5);
    assert.equal(syncRes.body.summary.synced, 3);
    assert.equal(syncRes.body.summary.idempotent, 1);
    assert.equal(syncRes.body.summary.failed, 1);

    const opResults = syncRes.body.results;
    assert.equal(opResults[0].status, 'SYNCED');
    assert.equal(opResults[1].status, 'SYNCED');
    assert.equal(opResults[2].status, 'FAILED');
    assert.equal(opResults[2].errorCode, 'BATCH_NOT_FOUND');
    assert.equal(opResults[3].status, 'IDEMPOTENT');
    assert.equal(opResults[4].status, 'SYNCED');

    // Batch 1: initial 100 + 25 (pre-intake) + 10 (op1) = 135
    const b1 = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchIds[0]);
    assert.equal(b1.quantity, 135);

    // Batch 2: initial 100 + 20 (op2) = 120
    const b2 = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchIds[1]);
    assert.equal(b2.quantity, 120);

    // Batch 3: initial 100 + 40 (op5) = 140
    const b3 = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchIds[2]);
    assert.equal(b3.quantity, 140);
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(duplicateKey);
    for (const bId of batchIds) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(bId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(bId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    for (const bId of batchIds) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(bId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-003: Network-Retry Simulation (Entire Batch Resubmission Replays Idempotently)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;
  const key1 = 'retry-b-k1-' + crypto.randomBytes(4).toString('hex');
  const key2 = 'retry-b-k2-' + crypto.randomBytes(4).toString('hex');

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Batch Retry Med', genericName: 'RetryMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'RTR-LOT-1', quantity: 50, sellingPrice: 10, expiryDate: '2028-05-05' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Retry Batch Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const batchPayload = {
      operations: [
        { operationId: 'rtr-op-1', idempotencyKey: key1, qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'RTR-LOT-1' }, quantity: 15 },
        { operationId: 'rtr-op-2', idempotencyKey: key2, qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'RTR-LOT-1' }, quantity: 25 }
      ]
    };

    // First submission
    const res1 = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: batchPayload
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.summary.synced, 2);
    assert.equal(res1.body.summary.idempotent, 0);

    // Stock should be 50 + 15 + 25 = 90
    const stockAfter1 = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(stockAfter1.quantity, 90);

    // Replay entire batch (simulating client reconnect retry)
    const res2 = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: batchPayload
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.summary.synced, 0);
    assert.equal(res2.body.summary.idempotent, 2);

    // Stock must remain 90 (NOT 130)
    const stockAfter2 = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(stockAfter2.quantity, 90);
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM idempotency_keys WHERE key IN (?, ?)').run(key1, key2);
    if (batchId) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-004: Concurrent Duplicate Operations in Batch Requests (Zero Double-Increment)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;
  const key = 'conc-sync-k-' + crypto.randomBytes(6).toString('hex');

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Concurrent Sync Med', genericName: 'ConcMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'CONC-LOT-01', quantity: 100, sellingPrice: 20, expiryDate: '2028-09-09' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Conc Batch Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const batchPayload = {
      operations: [
        { operationId: 'conc-op-1', idempotencyKey: key, qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'CONC-LOT-01' }, quantity: 50 }
      ]
    };

    const [resA, resB] = await Promise.all([
      callApi({ method: 'POST', url: '/api/mobile/stock-entry/batch-sync', headers: { 'x-device-token': deviceToken }, body: batchPayload }),
      callApi({ method: 'POST', url: '/api/mobile/stock-entry/batch-sync', headers: { 'x-device-token': deviceToken }, body: batchPayload })
    ]);

    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);

    const statuses = [resA.body.results[0].status, resB.body.results[0].status].sort();
    assert.deepEqual(statuses, ['IDEMPOTENT', 'SYNCED']);

    // Stock must be 100 + 50 = 150 (NOT 200)
    const stock = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(stock.quantity, 150);
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    if (batchId) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-005: Batch Size Upper Limit (101 Operations Rejected with 400 Bad Request)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let deviceId = null;

  try {
    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Limit Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const oversizedOps = [];
    for (let i = 1; i <= 101; i++) {
      oversizedOps.push({
        operationId: `op-${i}`,
        idempotencyKey: `key-${i}`,
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: 1, batchNumber: 'LOT-1' },
        quantity: 10
      });
    }

    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: { operations: oversizedOps }
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /exceeds maximum allowable limit of 100/i);
  } finally {
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
  }
});

test('SYNC-006: Empty Operations Array Rejected with 400 Bad Request', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let deviceId = null;

  try {
    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Empty Array Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: { operations: [] }
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /operations array must not be empty/i);
  } finally {
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
  }
});

test('SYNC-007: Missing / Non-Array Operations Parameter Rejected with 400 Bad Request', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let deviceId = null;

  try {
    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Missing Param Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: { notOperations: 'invalid' }
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /must be a non-empty array/i);
  } finally {
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
  }
});

test('SYNC-008: Invalid Quantity Inside One Operation (Fails Independently Without Halting Batch)', async () => {
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
      body: { name: 'Invalid Qty Med', genericName: 'QtyMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'QTY-LOT-1', quantity: 20, sellingPrice: 10, expiryDate: '2028-01-01' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Qty Test Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: {
        operations: [
          { operationId: 'op-valid', idempotencyKey: 'q-key-1-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'QTY-LOT-1' }, quantity: 15 },
          { operationId: 'op-bad-qty', idempotencyKey: 'q-key-2-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'QTY-LOT-1' }, quantity: -5 }
        ]
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.summary.synced, 1);
    assert.equal(res.body.summary.failed, 1);
    assert.equal(res.body.results[0].status, 'SYNCED');
    assert.equal(res.body.results[1].status, 'FAILED');
    assert.equal(res.body.results[1].errorCode, 'INVALID_QUANTITY');

    // Stock should be 20 + 15 = 35
    const stock = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(stock.quantity, 35);
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    if (batchId) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-009: Tenant Isolation in Batch Sync (Foreign Pharmacy Batch Rejected Without Leakage)', async () => {
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

    // Create Pharmacy 2
    db.prepare("INSERT INTO pharmacies (name, address) VALUES ('Batch Isolation Branch', 'Aurangabad')").run();
    const p2 = db.prepare("SELECT id FROM pharmacies WHERE name = 'Batch Isolation Branch'").get();
    pharmacy2Id = p2.id;
    const med2Res = db.prepare("INSERT INTO medicines (pharmacy_id, name, generic_name, minimum_stock) VALUES (?, 'P2 Vaccine', 'Vaccine', 5)").run(pharmacy2Id);
    med2Id = Number(med2Res.lastInsertRowid);
    const batch2Res = db.prepare("INSERT INTO medicine_batches (medicine_id, batch_number, quantity, selling_price, expiry_date) VALUES (?, 'P2-VAC-01', 50, 100, '2028-12-12')").run(med2Id);
    batch2Id = Number(batch2Res.lastInsertRowid);

    // Device 1 submits batch targeting Pharmacy 2 medicine
    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': device1Token },
      body: {
        operations: [
          { operationId: 'op-foreign', idempotencyKey: 'foreign-k-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: med2Id, batchNumber: 'P2-VAC-01' }, quantity: 20 }
        ]
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.summary.failed, 1);
    assert.equal(res.body.results[0].status, 'FAILED');
    assert.equal(res.body.results[0].errorCode, 'MEDICINE_NOT_FOUND');

    // Pharmacy 2 stock unchanged
    const p2Stock = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batch2Id);
    assert.equal(p2Stock.quantity, 50);
  } finally {
    if (device1Id) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(device1Id);
    if (batch2Id) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batch2Id);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batch2Id);
    }
    if (device1Id) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(device1Id);
    if (batch2Id) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batch2Id);
    if (med2Id) db.prepare('DELETE FROM medicines WHERE id = ?').run(med2Id);
    if (pharmacy2Id) db.prepare('DELETE FROM pharmacies WHERE id = ?').run(pharmacy2Id);
  }
});

test('SYNC-010: Revoked Device Rejected on Batch Sync (401 Unauthorized, 0 Operations Processed)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let deviceId = null;

  try {
    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Revoked Batch Device' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    // Revoke device
    await callApi({ method: 'POST', url: `/api/mobile/devices/${deviceId}/revoke`, cookie: adminCookie });

    // Submit batch
    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: {
        operations: [
          { operationId: 'op-1', idempotencyKey: 'k1', qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: 1, batchNumber: 'LOT-1' }, quantity: 10 }
        ]
      }
    });

    assert.equal(res.status, 401);
  } finally {
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
  }
});

test('SYNC-011: Idempotency Key Reused with Different Payload in Batch (Returns CONFLICT Status)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;
  const conflictKey = 'conf-batch-key-' + crypto.randomBytes(6).toString('hex');

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Conflict Batch Drug', genericName: 'ConfDrug', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'CONF-LOT-B', quantity: 50, sellingPrice: 20, expiryDate: '2028-10-10' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Conflict Batch Device' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    // First commit with quantity 10
    await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry',
      headers: { 'x-device-token': deviceToken },
      body: {
        idempotencyKey: conflictKey,
        qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'CONF-LOT-B' },
        quantity: 10
      }
    });

    // Batch sync reuses same key with quantity 50
    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: {
        operations: [
          { operationId: 'op-conflict', idempotencyKey: conflictKey, qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'CONF-LOT-B' }, quantity: 50 }
        ]
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.summary.failed, 1);
    assert.equal(res.body.results[0].status, 'CONFLICT');
    assert.equal(res.body.results[0].errorCode, 'IDEMPOTENCY_CONFLICT');
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(conflictKey);
    if (batchId) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-012: Two Distinct Additive Receipts Targeting Same Batch (Commutative Invariant Verified)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let devAId = null;
  let devBId = null;

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Commutative Test Med', genericName: 'ComMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'COM-LOT-01', quantity: 100, sellingPrice: 20, expiryDate: '2028-12-31' }
    });
    batchId = batchRes.body.batch.id;

    // Pair Device A
    const codeA = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimA = await callApi({ method: 'POST', url: '/api/mobile/pairing/complete', body: { pairingCode: codeA.body.pairingCode, deviceName: 'Scanner A' } });
    const tokenA = claimA.body.deviceToken;
    devAId = claimA.body.deviceId;

    // Pair Device B
    const codeB = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claimB = await callApi({ method: 'POST', url: '/api/mobile/pairing/complete', body: { pairingCode: codeB.body.pairingCode, deviceName: 'Scanner B' } });
    const tokenB = claimB.body.deviceToken;
    devBId = claimB.body.deviceId;

    // Device A submits batch (+20)
    const resA = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': tokenA },
      body: {
        operations: [
          { operationId: 'op-A', idempotencyKey: 'key-A-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'COM-LOT-01' }, quantity: 20 }
        ]
      }
    });
    assert.equal(resA.status, 200);

    // Device B submits batch (+30)
    const resB = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': tokenB },
      body: {
        operations: [
          { operationId: 'op-B', idempotencyKey: 'key-B-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'COM-LOT-01' }, quantity: 30 }
        ]
      }
    });
    assert.equal(resB.status, 200);

    // Final stock = 100 + 20 + 30 = 150
    const finalStock = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(finalStock.quantity, 150);
  } finally {
    if (devAId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(devAId);
    if (devBId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(devBId);
    if (batchId) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
    }
    if (devAId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(devAId);
    if (devBId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(devBId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-013: Malformed QR Operation Mixed with Valid Operations (Independent Rejection)', async () => {
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
      body: { name: 'Malformed QR Sync Med', genericName: 'MalMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'MAL-LOT-01', quantity: 30, sellingPrice: 15, expiryDate: '2028-11-11' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Malformed QR Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: {
        operations: [
          { operationId: 'op-valid', idempotencyKey: 'mal-k1-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'MAL-LOT-01' }, quantity: 10 },
          { operationId: 'op-malformed-qr', idempotencyKey: 'mal-k2-' + crypto.randomBytes(4).toString('hex'), qrPayload: 'CORRUPTED_STRING_TAG', quantity: 15 }
        ]
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.summary.synced, 1);
    assert.equal(res.body.summary.failed, 1);
    assert.equal(res.body.results[0].status, 'SYNCED');
    assert.equal(res.body.results[1].status, 'FAILED');
    assert.equal(res.body.results[1].errorCode, 'INVALID_QR_PAYLOAD');

    // Valid stock committed: 30 + 10 = 40
    const stock = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(stock.quantity, 40);
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    if (batchId) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-014: Movement Audit Trail Verification in Batch Sync (User & Device Attribution)', async () => {
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
      body: { name: 'Audit Batch Med', genericName: 'AudMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'AUD-SYNC-01', quantity: 40, sellingPrice: 25, expiryDate: '2028-10-10' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Audit Batch Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const res = await callApi({
      method: 'POST',
      url: '/api/mobile/stock-entry/batch-sync',
      headers: { 'x-device-token': deviceToken },
      body: {
        operations: [
          { operationId: 'aud-op-1', idempotencyKey: 'aud-k1-' + crypto.randomBytes(4).toString('hex'), qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'AUD-SYNC-01' }, quantity: 35 }
        ]
      }
    });

    assert.equal(res.status, 200);
    const movementId = res.body.results[0].movementId;
    assert.ok(movementId);

    const movement = db.prepare('SELECT * FROM inventory_movements WHERE id = ?').get(movementId);
    assert.equal(movement.batch_id, batchId);
    assert.equal(movement.change_quantity, 35);
    assert.equal(movement.reason, 'RECEIPT');
    assert.ok(movement.created_by);
    assert.equal(movement.device_id, deviceId);
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    if (batchId) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});

test('SYNC-015: Retry After Server Commit Simulation (Zero Duplicate Movements Logged)', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  let medId = null;
  let batchId = null;
  let deviceId = null;
  const key = 'commit-sim-key-' + crypto.randomBytes(6).toString('hex');

  try {
    const medRes = await callApi({
      method: 'POST',
      url: '/api/medicines',
      cookie: adminCookie,
      body: { name: 'Commit Sim Med', genericName: 'SimMed', minimumStock: 5 }
    });
    medId = medRes.body.medicine.id;
    const batchRes = await callApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      cookie: adminCookie,
      body: { batchNumber: 'SIM-LOT-01', quantity: 50, sellingPrice: 30, expiryDate: '2028-10-10' }
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
    const claim = await callApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Commit Sim Scanner' }
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    const payload = {
      operations: [
        { operationId: 'sim-op-1', idempotencyKey: key, qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: medId, batchNumber: 'SIM-LOT-01' }, quantity: 20 }
      ]
    };

    // First attempt commits
    const res1 = await callApi({ method: 'POST', url: '/api/mobile/stock-entry/batch-sync', headers: { 'x-device-token': deviceToken }, body: payload });
    assert.equal(res1.status, 200);

    // Simulated reconnect retry
    const res2 = await callApi({ method: 'POST', url: '/api/mobile/stock-entry/batch-sync', headers: { 'x-device-token': deviceToken }, body: payload });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.results[0].status, 'IDEMPOTENT');

    // Exactly 2 movement records (1 batch creation + 1 stock intake)
    const movements = db.prepare('SELECT COUNT(*) as count FROM inventory_movements WHERE batch_id = ?').get(batchId);
    assert.equal(movements.count, 2);
  } finally {
    if (deviceId) db.prepare('DELETE FROM idempotency_keys WHERE device_id = ?').run(deviceId);
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    if (batchId) {
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
    }
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});
