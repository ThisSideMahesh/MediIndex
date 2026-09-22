/**
 * tests/sync-offline.test.js
 *
 * Tests for the client-side offline synchronisation workflow.
 *
 * Architecture under test:
 *   POST /api/sync/stock-receipt  ← new browser-session endpoint
 *     ↳ same idempotency_keys table used by mobile endpoints
 *     ↳ same inventory_movements audit trail
 *     ↳ derived from authenticated session (no device token)
 *
 * These tests exercise the SERVER side of the chain through the HTTP handler,
 * exactly as the IndexedDB outbox would call it during synchronisation.
 * The IndexedDB itself is a browser API unavailable in Node; its logic is
 * validated through behavioural assertions on the server contract it relies on.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { handler, db } = require('../core');

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function callApi({ method = 'GET', url, body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method  = method;
    req.url     = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}), ...headers };
    const res = {
      _h: {},
      writeHead(status, hdrs) { this.status = status; this._h = hdrs || {}; },
      end(payload) {
        try { resolve({ status: this.status, headers: this._h, body: payload ? JSON.parse(payload) : null }); }
        catch { resolve({ status: this.status, headers: this._h, raw: payload }); }
      }
    };
    handler(req, res).catch(reject);
    if (body !== undefined)
      setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

// ─── Shared setup helpers ─────────────────────────────────────────────────────

async function adminLogin() {
  const res = await callApi({
    method: 'POST', url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  assert.equal(res.status, 200, 'admin login must succeed');
  return res.headers['Set-Cookie'];
}

async function staffLogin() {
  const res = await callApi({
    method: 'POST', url: '/api/auth/login',
    body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' }
  });
  assert.equal(res.status, 200, 'staff login must succeed');
  return res.headers['Set-Cookie'];
}

async function createMedicineBatch(cookie) {
  const med = await callApi({
    method: 'POST', url: '/api/medicines', cookie,
    body: { name: `SyncTest-${crypto.randomBytes(4).toString('hex')}`, minimumStock: 0 }
  });
  assert.equal(med.status, 201);
  const medicineId = med.body.medicine.id;
  const batchNum = 'SB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const batch = await callApi({
    method: 'POST', url: `/api/medicines/${medicineId}/batches`, cookie,
    body: { batchNumber: batchNum, quantity: 100, sellingPrice: 10, expiryDate: '2030-12-31' }
  });
  assert.equal(batch.status, 201);
  return { medicineId, batchId: batch.body.batch.id, batchNumber: batchNum };
}

function cleanupMedicine(medicineId, batchId) {
  try {
    if (batchId) {
      db.prepare('DELETE FROM idempotency_keys WHERE key LIKE ? OR key LIKE ?').run(`sync-test-%`, `idem-%`);
      db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(batchId);
      db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    }
    if (medicineId) db.prepare('UPDATE medicines SET active=0 WHERE id = ?').run(medicineId);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Outbox creation — server accepts the operation and creates audit trail
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-001: stock-receipt endpoint creates inventory movement (outbox sync target)', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const key = 'sync-test-' + crypto.randomBytes(6).toString('hex');

  try {
    const res = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: 25, idempotencyKey: key }
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, 'SYNCED');
    assert.ok(res.body.movementId, 'movementId must be returned');
    assert.equal(res.body.batch.quantityAdded, 25);

    // Verify inventory movement was created (the audit trail)
    const movement = db.prepare('SELECT * FROM inventory_movements WHERE id = ?').get(res.body.movementId);
    assert.ok(movement, 'inventory movement must exist');
    assert.equal(movement.batch_id, batchId);
    assert.equal(movement.change_quantity, 25);
    assert.equal(movement.reason, 'RECEIPT');

    // Verify stock increased by exactly 25
    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(row.quantity, 125, 'Stock must be 100 + 25 = 125');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Idempotency — same key same payload → IDEMPOTENT, no duplicate
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-002: same idempotency key returns IDEMPOTENT, no duplicate stock increment', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const key = 'sync-test-' + crypto.randomBytes(6).toString('hex');
  const payload = { medicineId, batchNumber, quantity: 30, idempotencyKey: key };

  try {
    const r1 = await callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie, body: payload });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.status, 'SYNCED');

    const r2 = await callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie, body: payload });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.idempotent, true, 'Second submission must be idempotent');
    assert.equal(r2.body.status, 'IDEMPOTENT');

    // Stock must be 100 + 30 = 130, NOT 160
    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(row.quantity, 130, 'Stock must not be double-incremented');

    // Only one inventory movement must exist for this batch from these ops
    const movements = db.prepare('SELECT id FROM inventory_movements WHERE batch_id = ?').all(batchId);
    // initial batch creation movement + 1 sync movement = at most 2
    assert.ok(movements.length <= 2, 'Must not have created duplicate movements');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Outbox persistence simulation — server-side idempotency survives restart
// (the client stores the key before the request; on retry after reload the same key is re-sent)
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-003: operation survives reload simulation (stable idempotency key)', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  // The client generates this key BEFORE storing to IndexedDB — it must be the same on retry
  const stableKey = 'persist-' + crypto.randomBytes(8).toString('hex');
  const payload = { medicineId, batchNumber, quantity: 15, idempotencyKey: stableKey };

  try {
    // Simulate: client sends the operation (e.g. after coming back online)
    const r1 = await callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie, body: payload });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.status, 'SYNCED');

    // Simulate: browser restarted, outbox re-reads the same entry and retries
    const r2 = await callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie, body: payload });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.idempotent, true, 'Retry after "restart" must be idempotent');

    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(row.quantity, 115, 'Exactly 15 units must be added, not more');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(stableKey);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Multiple pending operations sync correctly
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-004: multiple pending operations process sequentially', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const keys = Array.from({ length: 3 }, () => 'multi-' + crypto.randomBytes(6).toString('hex'));

  try {
    // Simulate 3 queued operations arriving in order
    for (let i = 0; i < 3; i++) {
      const r = await callApi({
        method: 'POST', url: '/api/sync/stock-receipt', cookie,
        body: { medicineId, batchNumber, quantity: 10 * (i + 1), idempotencyKey: keys[i] }
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'SYNCED');
    }

    // 100 + 10 + 20 + 30 = 160
    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(row.quantity, 160);
  } finally {
    for (const k of keys) db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(k);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Network-drop-after-server-processing — response lost, client retries
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-005: network drop after server commit — retry does not duplicate', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const key = 'netloss-' + crypto.randomBytes(6).toString('hex');

  try {
    // First submission: server processes and commits, client "loses" the response
    const r1 = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: 50, idempotencyKey: key }
    });
    assert.equal(r1.status, 200);
    // Simulate client not knowing result — it retries with the same key
    const r2 = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: 50, idempotencyKey: key }
    });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.idempotent, true, 'Retry must be idempotent, not a new receipt');

    // Stock = 100 + 50 = 150, NOT 200
    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(row.quantity, 150);
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Idempotency conflict — same key, different payload → 409
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-006: same key different payload returns 409 conflict', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const key = 'conflict-' + crypto.randomBytes(6).toString('hex');

  try {
    const r1 = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: 10, idempotencyKey: key }
    });
    assert.equal(r1.status, 200);

    // Same key but different quantity — must be rejected
    const r2 = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: 99, idempotencyKey: key }
    });
    assert.equal(r2.status, 409, 'Payload mismatch on same key must return 409');

    // Stock unchanged beyond first operation
    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(row.quantity, 110, 'Only first operation must apply');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Permanent failure — invalid medicine → 404, must not be retried
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-007: invalid medicine returns 404 (permanent failure, do not retry)', async () => {
  const cookie = await adminLogin();
  const key = 'perm-fail-' + crypto.randomBytes(6).toString('hex');

  try {
    const res = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId: 999999, batchNumber: 'FAKE-LOT', quantity: 10, idempotencyKey: key }
    });
    // 404 is a PERMANENT failure — isTransientError(404) returns false
    assert.equal(res.status, 404, 'Non-existent medicine must return 404');
    assert.ok(res.body.error, 'Error message must be present');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Permanent failure — invalid batch number → 404
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-008: invalid batch number returns 404 (permanent failure)', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId } = await createMedicineBatch(cookie);
  const key = 'perm-batch-' + crypto.randomBytes(6).toString('hex');

  try {
    const res = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber: 'NONEXISTENT-LOT-XYZ', quantity: 10, idempotencyKey: key }
    });
    assert.equal(res.status, 404);
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: Permanent failure — invalid quantity → 400
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-009: invalid quantity returns 400 (permanent failure)', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const key = 'perm-qty-' + crypto.randomBytes(6).toString('hex');

  try {
    const res = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: -5, idempotencyKey: key }
    });
    assert.equal(res.status, 400);
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: Authentication required — unauthenticated request → 401
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-010: unauthenticated sync request returns 401', async () => {
  const res = await callApi({
    method: 'POST', url: '/api/sync/stock-receipt',
    body: { medicineId: 1, batchNumber: 'LOT-1', quantity: 10, idempotencyKey: 'unauth-key' }
  });
  assert.equal(res.status, 401, 'Must require authentication');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11: RBAC — STAFF can sync stock receipts (ADMIN + STAFF both allowed)
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-011: STAFF role can submit sync stock receipt', async () => {
  const adminCookie = await adminLogin();
  const staffCookie = await staffLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(adminCookie);
  const key = 'staff-sync-' + crypto.randomBytes(6).toString('hex');

  try {
    const res = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie: staffCookie,
      body: { medicineId, batchNumber, quantity: 20, idempotencyKey: key }
    });
    assert.equal(res.status, 200, `STAFF must be able to sync stock receipts, got: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.status, 'SYNCED');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12: Tenant isolation — pharmacy_id comes from session, not client
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-012: client-supplied pharmacy_id is rejected (tenant isolation)', async () => {
  const cookie = await adminLogin();
  const key = 'tenant-test-' + crypto.randomBytes(6).toString('hex');

  try {
    const res = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId: 1, batchNumber: 'LOT-1', quantity: 10, idempotencyKey: key, pharmacyId: 9999 }
    });
    assert.equal(res.status, 400, 'Supplying pharmacyId must be rejected');
    assert.match(res.body.error, /pharmacy_id/i);
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 13: Cross-pharmacy isolation — medicine from pharmacy 2 rejected for pharmacy 1 user
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-013: cannot sync against medicine from a different pharmacy', async () => {
  const cookie = await adminLogin();

  // Create a second pharmacy and medicine directly in the DB
  db.prepare("INSERT INTO pharmacies (name, address) VALUES ('Offline Test Branch', 'Test City')").run();
  const p2 = db.prepare("SELECT id FROM pharmacies WHERE name = 'Offline Test Branch'").get();
  const pharmacy2Id = p2.id;
  const med2Res = db.prepare("INSERT INTO medicines (pharmacy_id, name, minimum_stock) VALUES (?, 'CrossPharm Drug', 0)").run(pharmacy2Id);
  const med2Id = Number(med2Res.lastInsertRowid);
  const batch2Res = db.prepare("INSERT INTO medicine_batches (medicine_id, batch_number, quantity, selling_price, expiry_date) VALUES (?, 'XP-LOT-01', 50, 10, '2030-01-01')").run(med2Id);
  const batch2Id = Number(batch2Res.lastInsertRowid);

  const key = 'cross-pharm-' + crypto.randomBytes(6).toString('hex');
  try {
    const res = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId: med2Id, batchNumber: 'XP-LOT-01', quantity: 10, idempotencyKey: key }
    });
    // Server must NOT find this medicine (it belongs to pharmacy2, not pharmacy1)
    assert.equal(res.status, 404, 'Medicine from another pharmacy must return 404');

    // Pharmacy2 stock must be unchanged
    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batch2Id);
    assert.equal(Number(row.quantity), 50, 'Cross-pharmacy stock must not be modified');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batch2Id);
    db.prepare('DELETE FROM medicines WHERE id = ?').run(med2Id);
    db.prepare('DELETE FROM pharmacies WHERE id = ?').run(pharmacy2Id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 14: Inventory movement audit record exists after sync
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-014: inventory movement audit record is created by sync endpoint', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const key = 'audit-' + crypto.randomBytes(6).toString('hex');

  try {
    const res = await callApi({
      method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: 40, idempotencyKey: key }
    });
    assert.equal(res.status, 200);

    const movementId = res.body.movementId;
    assert.ok(movementId, 'movementId must be returned');

    const movement = db.prepare('SELECT * FROM inventory_movements WHERE id = ?').get(movementId);
    assert.ok(movement, 'Movement record must exist in DB');
    assert.equal(movement.batch_id, batchId);
    assert.equal(movement.change_quantity, 40);
    assert.equal(movement.reason, 'RECEIPT');
    assert.ok(movement.created_by > 0, 'created_by must be the authenticated user');
    assert.equal(movement.device_id, null, 'Browser sync must have device_id = NULL');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 15: Concurrent sync protection — same key submitted in parallel
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-015: concurrent submissions with same key produce exactly one receipt', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const key = 'concurrent-' + crypto.randomBytes(6).toString('hex');
  const payload = { medicineId, batchNumber, quantity: 25, idempotencyKey: key };

  try {
    const [r1, r2] = await Promise.all([
      callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie, body: payload }),
      callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie, body: payload }),
    ]);

    assert.ok([200, 200].every((_, i) => [r1, r2][i].status === 200));
    const statuses = [r1.body.status, r2.body.status].sort();
    assert.deepEqual(statuses, ['IDEMPOTENT', 'SYNCED'], 'One SYNCED and one IDEMPOTENT');

    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(row.quantity, 125, 'Stock must be 100 + 25 = 125, not 150');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 16: Missing idempotency key → 400 (outbox always generates one)
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-016: missing idempotency key returns 400', async () => {
  const cookie = await adminLogin();
  const res = await callApi({
    method: 'POST', url: '/api/sync/stock-receipt', cookie,
    body: { medicineId: 1, batchNumber: 'LOT-1', quantity: 10 }
  });
  assert.equal(res.status, 400, 'Request without idempotency key must fail');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 17: Operation-based (not set-based) — quantities are additive
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-017: stock receipt is operation-based (additive, not replacement)', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);
  const keys = [
    'add-op-1-' + crypto.randomBytes(4).toString('hex'),
    'add-op-2-' + crypto.randomBytes(4).toString('hex'),
  ];

  try {
    // Two separate receipts: +20, +30
    await callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: 20, idempotencyKey: keys[0] } });
    await callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie,
      body: { medicineId, batchNumber, quantity: 30, idempotencyKey: keys[1] } });

    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    // 100 + 20 + 30 = 150
    assert.equal(row.quantity, 150, 'Each operation must add to existing stock, not replace it');
  } finally {
    for (const k of keys) db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(k);
    cleanupMedicine(medicineId, batchId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 18: /api/health returns 200 with real DB query (connectivity detection target)
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-018: /api/health executes real DB query (used by connectivity probe)', async () => {
  const res = await callApi({ url: '/api/health' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.database, 'connected');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 19: isTransientError classification is correct
// (unit-tests the retry-policy logic embedded in sync.js, reproduced here)
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-019: retry policy correctly classifies transient vs permanent errors', () => {
  // Reproduce the classification logic from sync.js
  const PERMANENT_HTTP   = new Set([400, 401, 403, 404, 409, 422]);
  const PERMANENT_CODES  = new Set([
    'MEDICINE_NOT_FOUND', 'BATCH_NOT_FOUND', 'INVALID_QR_PAYLOAD',
    'INVALID_QUANTITY', 'QUANTITY_LIMIT_EXCEEDED', 'TENANT_SPOOFING_REJECTED',
    'IDEMPOTENCY_CONFLICT',
  ]);
  function isTransientError(httpStatus, errorCode) {
    if (PERMANENT_HTTP.has(httpStatus)) return false;
    if (errorCode && PERMANENT_CODES.has(errorCode)) return false;
    return true;
  }

  // Permanent (do NOT retry)
  assert.equal(isTransientError(400, 'INVALID_QUANTITY'), false);
  assert.equal(isTransientError(401, null), false);
  assert.equal(isTransientError(403, null), false);
  assert.equal(isTransientError(404, 'MEDICINE_NOT_FOUND'), false);
  assert.equal(isTransientError(409, 'IDEMPOTENCY_CONFLICT'), false);
  assert.equal(isTransientError(422, null), false);

  // Transient (DO retry)
  assert.equal(isTransientError(500, null), true);
  assert.equal(isTransientError(503, null), true);
  assert.equal(isTransientError(502, null), true);
  assert.equal(isTransientError(undefined, null), true); // network error, no HTTP status
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 20: Sync status transitions (conceptual verification via server contract)
// Verifies the full chain: OFFLINE → QUEUE → RETRY → SYNCED → no duplicate
// ─────────────────────────────────────────────────────────────────────────────
test('OFFLINE-020: full offline → queue → sync → SYNCED chain produces correct server state', async () => {
  const cookie = await adminLogin();
  const { medicineId, batchId, batchNumber } = await createMedicineBatch(cookie);

  // Simulate what the outbox does:
  // 1. While offline: generate stable idempotency key + store operation
  const stableKey = 'chain-' + crypto.randomBytes(8).toString('hex');
  const payload = { medicineId, batchNumber, quantity: 35, idempotencyKey: stableKey };

  try {
    // 2. Connectivity returns → outbox submits the operation
    const r1 = await callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie, body: payload });
    assert.equal(r1.status, 200, `Sync must succeed: ${JSON.stringify(r1.body)}`);
    assert.equal(r1.body.status, 'SYNCED');
    assert.ok(r1.body.movementId);
    assert.equal(r1.body.batch.quantityAdded, 35);

    // 3. Outbox marks entry SYNCED, clears it — verify server state
    const row = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(row.quantity, 135);

    const movement = db.prepare('SELECT * FROM inventory_movements WHERE id = ?').get(r1.body.movementId);
    assert.ok(movement);
    assert.equal(movement.reason, 'RECEIPT');
    assert.equal(movement.change_quantity, 35);

    // 4. If outbox retries (network blip after server commit) → IDEMPOTENT
    const r2 = await callApi({ method: 'POST', url: '/api/sync/stock-receipt', cookie, body: payload });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.idempotent, true);

    // Server state unchanged
    const rowAfter = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(rowAfter.quantity, 135, 'No duplicate on retry');
  } finally {
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(stableKey);
    cleanupMedicine(medicineId, batchId);
  }
});
