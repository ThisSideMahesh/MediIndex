/**
 * CRITICAL END-TO-END TEST — Phase 7I requirement #26.
 *
 * Exercises, against the REAL production code on both sides of the boundary:
 *
 *   OFFLINE -> enqueue receipt -> PENDING -> app restart simulation ->
 *   internet restored -> SYNCING -> server processes stock -> simulated
 *   response loss -> retry SAME idempotency key -> backend returns idempotent
 *   result -> SYNCED -> exactly one stock mutation occurred.
 *
 * "Real" on both sides means:
 *   - Mobile: the actual `SQLiteOutboxStore` (real, file-backed node:sqlite)
 *     and the actual `AutoSyncEngine` (real locking/state-machine/backoff code).
 *   - Backend: the actual `processMobileStockEntry()` / `handler` from the
 *     project's real `core.js`, running against the project's real SQLite
 *     database (`db` from core.js) — NOT a fake standing in for the backend's
 *     idempotency behavior. This is what requirement #26 means by "use the
 *     existing backend idempotency behavior where practical" and "do not
 *     simulate duplicate protection solely in the client."
 *
 * The only thing simulated is the TRANSPORT-level response loss (the backend
 * genuinely processes the first request and increments stock; the mobile
 * client's `submit` function is made to throw, as if the HTTP response never
 * arrived) — this is the literal scenario requirement #26 describes, and it
 * cannot be produced any other way without an actual dropped TCP packet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tempDbPath, cleanupDb, makeFakeConnectivity } from './helpers/syncTestHarness.js';
import { openNodeSqliteDriver } from './helpers/nodeSqliteDriver.js';

const { SQLiteOutboxStore } = await import('../src/storage/outbox.ts');
const { AutoSyncEngine } = await import('../src/sync/syncEngine.ts');
const { ApiError } = await import('../src/api/errors.ts');

// Real backend, real database — same pattern tests/mobile-stock-entry.test.js uses.
// require (not import) because core.js is plain CommonJS.
const require = createRequire(import.meta.url);
const core = require('../../core.js');
const { handler, db } = core;

function callBackendApi({ method, url, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost', ...headers };
    const res = {
      headers: {},
      writeHead(status, hdrs) { this.status = status; this.headers = hdrs || {}; },
      end(payload) { resolve({ status: this.status, body: payload ? JSON.parse(payload) : undefined }); },
    };
    handler(req, res).catch(reject);
    if (body !== undefined) {
      setImmediate(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      });
    }
  });
}

test('CRITICAL-E2E: offline enqueue -> restart -> online -> SYNCING -> real backend mutation -> simulated response loss -> retry same key -> real backend idempotent replay -> SYNCED -> exactly one mutation', async () => {
  // ── Arrange: real backend fixtures (medicine + batch + paired device) ──────
  // Login needs response headers (Set-Cookie), which callBackendApi() above
  // does not surface, so this uses the raw handler call directly, matching the
  // existing project convention in tests/mobile-stock-entry.test.js.
  const loginRes = await new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/api/auth/login';
    req.headers = { host: 'localhost' };
    const res = {
      headers: {},
      writeHead(status, hdrs) { this.status = status; this.headers = hdrs || {}; },
      end(payload) { resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : undefined }); },
    };
    handler(req, res).catch(reject);
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify({ email: 'admin@mediindex.local', password: 'MediIndex@2026' })));
      req.emit('end');
    });
  });
  const cookie = loginRes.headers['Set-Cookie'];
  assert.equal(loginRes.status, 200, 'admin login must succeed against the real backend');

  let medId = null;
  let batchId = null;
  let deviceId = null;
  const dbPath = tempDbPath('critical-e2e');

  try {
    const medRes = await callBackendApi({
      method: 'POST',
      url: '/api/medicines',
      headers: { cookie },
      body: { name: 'Critical E2E Test Drug', genericName: 'E2EDrug', minimumStock: 5 },
    });
    medId = medRes.body.medicine.id;

    const batchRes = await callBackendApi({
      method: 'POST',
      url: `/api/medicines/${medId}/batches`,
      headers: { cookie },
      body: { batchNumber: 'E2E-CRITICAL-01', quantity: 100, sellingPrice: 25, expiryDate: '2028-06-30', location: 'E2E Shelf' },
    });
    batchId = batchRes.body.batch.id;

    const pairCode = await callBackendApi({ method: 'POST', url: '/api/mobile/pairing/create', headers: { cookie } });
    const claim = await callBackendApi({
      method: 'POST',
      url: '/api/mobile/pairing/complete',
      body: { pairingCode: pairCode.body.pairingCode, deviceName: 'Critical E2E Device' },
    });
    const deviceToken = claim.body.deviceToken;
    deviceId = claim.body.deviceId;

    // ── Step 1: OFFLINE — enqueue the receipt into the REAL SQLite outbox ────
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();

    const receipt = await store1.enqueue({ medicineId: medId, batchNumber: 'E2E-CRITICAL-01', quantity: 30 });
    const K = receipt.idempotencyKey;
    assert.equal(receipt.status, 'PENDING');

    const stockAfterEnqueueOnly = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(stockAfterEnqueueOnly.quantity, 100, 'enqueueing offline must not touch the real backend at all');

    // ── Step 2: app restart simulation ────────────────────────────────────────
    await store1.close();
    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init();
    const reloaded = await store2.getById(receipt.id);
    assert.equal(reloaded.idempotencyKey, K, 'key must survive the restart unchanged');
    assert.equal(reloaded.status, 'PENDING');

    // ── Step 3: internet restored -> sync engine submits to the REAL backend ──
    // The engine's `submit` function calls the REAL backend handler directly
    // (not the apiClient/fetch layer, which isn't meaningful in this Node test
    // process — see api/client.ts's use of `fetch`). This still exercises the
    // exact request shape (qrPayload/quantity/idempotencyKey) and, crucially,
    // the REAL server-side idempotency_keys table and REAL stock mutation.
    let responseLossArmed = true;

    async function submitToRealBackend(request) {
      const res = await callBackendApi({
        method: 'POST',
        url: '/api/mobile/stock-entry',
        headers: { 'x-device-token': deviceToken },
        body: {
          qrPayload: { app: 'MEDIINDEX', v: 1, medicineId: request.medicineId, batchNumber: request.batchNumber },
          quantity: request.quantity,
          idempotencyKey: request.idempotencyKey,
        },
      });

      if (res.status !== 200) {
        throw new ApiError('HTTP', res.body?.error || 'request failed', { status: res.status, code: res.body?.code });
      }

      if (responseLossArmed) {
        // The backend has ALREADY applied the mutation above (real SQL UPDATE
        // already executed and committed) — we now simulate that the HTTP
        // response never reached the client, exactly as requirement #9/#26
        // describe: "Response is lost / request times out... Client cannot
        // know whether the mutation happened."
        responseLossArmed = false;
        throw new ApiError('TIMEOUT', 'Simulated response loss after the server already committed the mutation.');
      }

      return res.body;
    }

    const connectivity = makeFakeConnectivity(true);
    const engine = new AutoSyncEngine(connectivity.port, store2, submitToRealBackend);

    let capturedSyncingStatus = null;
    // Confirm PENDING -> SYNCING actually happens before the (real) network call.
    const originalGetById = store2.getById.bind(store2);
    store2.getById = async (id) => {
      const rec = await originalGetById(id);
      if (rec && rec.id === receipt.id && rec.status === 'SYNCING' && !capturedSyncingStatus) {
        capturedSyncingStatus = rec.status;
      }
      return rec;
    };

    await engine.syncNow(); // Attempt 1: real mutation happens server-side, then simulated response loss

    const afterFirstAttempt = await store2.getById(receipt.id);
    assert.equal(afterFirstAttempt.status, 'PENDING', 'a transient (TIMEOUT) failure must leave it retryable');
    assert.equal(afterFirstAttempt.idempotencyKey, K, 'key must be unchanged after the failed attempt');

    // Confirm the REAL backend already applied the mutation exactly once,
    // even though the client believes the attempt failed.
    const stockAfterFirstAttempt = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(stockAfterFirstAttempt.quantity, 130, 'the real backend committed +30 units on the first attempt, despite the simulated response loss');

    const movementsAfterFirstAttempt = db.prepare('SELECT COUNT(*) AS c FROM inventory_movements WHERE batch_id = ?').get(batchId);
    // 1 movement from batch creation (RECEIPT of the initial 100) + 1 from this test's mutation.
    assert.equal(movementsAfterFirstAttempt.c, 2);

    // ── Step 4: retry, reusing the SAME idempotency key ───────────────────────
    await store2.update(receipt.id, { nextAttemptAt: null }); // clear backoff so retry is immediately eligible
    await engine.syncNow(); // Attempt 2: same key K reaches the real backend again

    const afterRetry = await store2.getById(receipt.id);
    assert.equal(afterRetry.status, 'SYNCED', 'the retry, via the backend real idempotent replay, must resolve to SYNCED');
    assert.equal(afterRetry.idempotencyKey, K);

    // ── Step 5: exactly one stock mutation occurred, proven against the REAL DB ─
    const stockFinal = db.prepare('SELECT quantity FROM medicine_batches WHERE id = ?').get(batchId);
    assert.equal(stockFinal.quantity, 130, 'stock must be EXACTLY 130 (100 + 30), NOT 160 — the retry must not have added another 30');

    const movementsFinal = db.prepare('SELECT COUNT(*) AS c FROM inventory_movements WHERE batch_id = ?').get(batchId);
    assert.equal(movementsFinal.c, 2, 'no additional inventory_movements row must have been created by the retry — the backend served an idempotent replay, not a new mutation');

    assert.equal(capturedSyncingStatus, 'SYNCING', 'the operation genuinely passed through the SYNCING state before the network call');

    await store2.close();
  } finally {
    cleanupDb(dbPath);
    // Deletion order matches FK dependency order: idempotency_keys and
    // inventory_movements reference batch/device, so they go first; the
    // device row is deleted before nothing else references it; batches
    // before medicines.
    try {
      if (deviceId) {
        const dev = db.prepare('SELECT pharmacy_id FROM paired_devices WHERE id = ?').get(deviceId);
        if (dev) db.prepare('DELETE FROM idempotency_keys WHERE endpoint = ? AND pharmacy_id = ?').run('/api/mobile/stock-entry', dev.pharmacy_id);
      }
    } catch { /* best effort */ }
    if (batchId) db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(batchId);
    if (deviceId) db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
    if (batchId) db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    if (medId) db.prepare('DELETE FROM medicines WHERE id = ?').run(medId);
  }
});
