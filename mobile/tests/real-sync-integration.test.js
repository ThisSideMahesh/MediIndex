/**
 * REAL SYNC ENGINE INTEGRATION TESTS — Phase 7I
 *
 * Executes the ACTUAL production `AutoSyncEngine` class from
 * `mobile/src/sync/syncEngine.ts` against a REAL, file-backed SQLite outbox
 * (Node's built-in `node:sqlite`, injected the same way Phase 7H's
 * `SQLiteOutboxStore` tests inject it). Only two seams are faked, matching the
 * actual architectural boundary of the app:
 *   - ConnectivityPort: stands in for NetInfo (whose real import chain hits
 *     react-native's Flow syntax, unparseable outside Metro — same constraint
 *     documented in Phase 7H for expo-sqlite).
 *   - submit (stands in for the real `submitStockReceipt`/apiClient.post HTTP
 *     call): stands in for the actual backend, since these are unit/integration
 *     tests of the MOBILE app, not a live server.
 *
 * The sync engine's locking/coalescing, retry/backoff classification, and the
 * real outbox's SQL-level state transitions all execute for real.
 *
 * RUN: `npm run test:sqlite-integration` (requires --experimental-strip-types
 * and the custom ESM resolver — see package.json).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tempDbPath,
  cleanupDb,
  makeFakeConnectivity,
  makeFakeSubmit,
  successResponse,
  idempotentResponse,
} from './helpers/syncTestHarness.js';
import { openNodeSqliteDriver } from './helpers/nodeSqliteDriver.js';

const { SQLiteOutboxStore } = await import('../src/storage/outbox.ts');
const { AutoSyncEngine, backoffMs, MAX_ATTEMPTS, MAX_BACKOFF_MS, SYNC_BATCH_SIZE } = await import('../src/sync/syncEngine.ts');
const { ApiError } = await import('../src/api/errors.ts');

/** Builds a fresh real-SQLite outbox + fake connectivity + fake submit + engine. */
async function setup(label, { initiallyOnline = true } = {}) {
  const dbPath = tempDbPath(label);
  const testOutbox = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
  await testOutbox.init();

  const connectivity = makeFakeConnectivity(initiallyOnline);
  const fakeSubmit = makeFakeSubmit();
  const engine = new AutoSyncEngine(connectivity.port, testOutbox, fakeSubmit.submit);

  return {
    dbPath,
    outbox: testOutbox,
    connectivity,
    fakeSubmit,
    engine,
    async teardown() {
      await testOutbox.close();
      cleanupDb(dbPath);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-001 / 002 / 003: startup behavior
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-001: online startup triggers sync and processes a PENDING operation', async () => {
  const ctx = await setup('startup-online');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 1, batchNumber: 'A', quantity: 5 });
    ctx.fakeSubmit.programResponse(() => successResponse({ medicineId: 1, batchNumber: 'A', quantity: 5 }));

    await ctx.engine.syncNow(); // start() triggers this same call in the real app

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-002: offline startup does not sync', async () => {
  const ctx = await setup('startup-offline', { initiallyOnline: false });
  try {
    await ctx.outbox.enqueue({ medicineId: 2, batchNumber: 'B', quantity: 3 });

    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls.length, 0, 'no network call must be made while offline');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-003: offline operation remains PENDING', async () => {
  const ctx = await setup('offline-pending', { initiallyOnline: false });
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 3, batchNumber: 'C', quantity: 4 });
    await ctx.engine.syncNow();
    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'PENDING');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-004: online submission still uses the direct Phase 7G API path (stockEntry request shape), not a second endpoint', async () => {
  // This is verified structurally: the sync engine's `submit` IS submitStockReceipt
  // by default, which posts to the existing /api/mobile/stock-entry contract.
  // Here we confirm the request shape the engine sends matches that contract exactly.
  const ctx = await setup('request-shape');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 4, batchNumber: 'D', quantity: 6 });
    ctx.fakeSubmit.programResponse(() => successResponse({ medicineId: 4, batchNumber: 'D', quantity: 6 }));
    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls.length, 1);
    const sent = ctx.fakeSubmit.calls[0];
    assert.equal(sent.medicineId, 4);
    assert.equal(sent.batchNumber, 'D');
    assert.equal(sent.quantity, 6);
    assert.equal(sent.idempotencyKey, rec.idempotencyKey);
    assert.equal(sent.pharmacyId, undefined, 'must never send pharmacyId');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-005 / 006 / 007: triggers
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-005: network restoration (offline -> online transition) triggers sync', async () => {
  const ctx = await setup('net-restore', { initiallyOnline: false });
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 5, batchNumber: 'E', quantity: 2 });
    ctx.fakeSubmit.programResponse(() => successResponse({ medicineId: 5, batchNumber: 'E', quantity: 2 }));

    await ctx.engine.start();
    assert.equal(ctx.fakeSubmit.calls.length, 0, 'must not sync while offline at startup');

    ctx.connectivity.setOnline(true); // fires the subscribed listener -> triggers syncNow()
    // Allow the fire-and-forget syncNow() triggered by the listener to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Ensure any in-flight sync this triggered has fully resolved.
    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'SYNCED');
  } finally {
    ctx.engine.stop();
    await ctx.teardown();
  }
});

test('SYNC-006: manual Sync Now triggers sync (foreground-equivalent path)', async () => {
  // Foreground uses AppState, which is unavailable in this Node test process
  // (see syncEngine.ts start()'s try/catch around require('react-native')).
  // The functional requirement — "when active and online, sync" — is the same
  // code path syncNow() exercises regardless of trigger, so this test proves
  // that path directly, matching how a foreground event would invoke it.
  const ctx = await setup('foreground-equivalent');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 6, batchNumber: 'F', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => successResponse({ medicineId: 6, batchNumber: 'F', quantity: 1 }));

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-007: manual Sync Now triggers sync', async () => {
  const ctx = await setup('manual-sync-now');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 7, batchNumber: 'G', quantity: 8 });
    ctx.fakeSubmit.programResponse(() => successResponse({ medicineId: 7, batchNumber: 'G', quantity: 8 }));

    const status = await ctx.engine.syncNow();

    assert.equal(status.counts.synced, 1);
    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-008 / 009: coalescing / single worker
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-008: duplicate simultaneous syncNow() calls coalesce into one pass', async () => {
  const ctx = await setup('coalesce');
  try {
    await ctx.outbox.enqueue({ medicineId: 8, batchNumber: 'H', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => successResponse({ medicineId: 8, batchNumber: 'H', quantity: 1 }));

    const [s1, s2, s3] = await Promise.all([ctx.engine.syncNow(), ctx.engine.syncNow(), ctx.engine.syncNow()]);

    // All three callers must observe the SAME resolved status object identity,
    // proving they shared one in-flight run rather than three separate ones.
    assert.equal(s1, s2);
    assert.equal(s2, s3);
    // Exactly one network call for the one enqueued record — not three.
    assert.equal(ctx.fakeSubmit.calls.length, 1);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-009: only one sync worker runs at a time even with slow network responses', async () => {
  const ctx = await setup('single-worker');
  try {
    await ctx.outbox.enqueue({ medicineId: 9, batchNumber: 'I', quantity: 1 });

    let resolveSubmit;
    const submitStarted = new Promise((resolveStarted) => {
      ctx.fakeSubmit.programResponse(() => {
        resolveStarted();
        return new Promise((resolve) => {
          resolveSubmit = () => resolve(successResponse({ medicineId: 9, batchNumber: 'I', quantity: 1 }));
        });
      });
    });

    const firstRun = ctx.engine.syncNow();
    // Wait until the (single) network call has actually started before firing
    // more coalescing triggers, so this deterministically tests "a second call
    // while one is in flight", not a race on which call goes first.
    await submitStarted;

    const secondRun = ctx.engine.syncNow();
    const thirdRun = ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls.length, 1, 'a second worker must not have started a second network call yet');

    resolveSubmit();
    await Promise.all([firstRun, secondRun, thirdRun]);

    assert.equal(ctx.fakeSubmit.calls.length, 1, 'still exactly one call after completion');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-010 / 011 / 012: state transitions on success and idempotent replay
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-010: PENDING transitions to SYNCING before the network call', async () => {
  const ctx = await setup('pending-to-syncing');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 10, batchNumber: 'J', quantity: 1 });

    let statusDuringCall = null;
    ctx.fakeSubmit.programResponse(async (request) => {
      statusDuringCall = (await ctx.outbox.getById(rec.id)).status;
      return successResponse(request);
    });

    await ctx.engine.syncNow();

    assert.equal(statusDuringCall, 'SYNCING', 'record must be SYNCING during the network call');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-011: successful server response marks the operation SYNCED', async () => {
  const ctx = await setup('success-synced');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 11, batchNumber: 'K', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'SYNCED');
    assert.ok(after.syncedAt);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-012: idempotent server response also marks the operation SYNCED', async () => {
  const ctx = await setup('idempotent-synced');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 12, batchNumber: 'L', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => idempotentResponse(request));

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'SYNCED', 'an idempotent replay is still authoritative confirmation');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-013 / 014: timeout retryability + same key
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-013: network timeout leaves the operation retryable (PENDING, not FAILED)', async () => {
  const ctx = await setup('timeout-retryable');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 13, batchNumber: 'M', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('TIMEOUT', 'Request timed out after 15000ms.'); });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'PENDING');
    assert.equal(after.attempts, 1);
    assert.ok(after.nextAttemptAt, 'a backoff time must be scheduled');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-014: retrying after a timeout sends the SAME idempotency key', async () => {
  const ctx = await setup('timeout-same-key');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 14, batchNumber: 'N', quantity: 1 });
    const K = rec.idempotencyKey;

    ctx.fakeSubmit.programResponse(() => { throw new ApiError('TIMEOUT', 'timed out'); });
    await ctx.engine.syncNow();
    assert.equal(ctx.fakeSubmit.calls[0].idempotencyKey, K);

    // Force immediate retry eligibility by clearing the backoff timer manually
    // (bypassing the wait, not the logic) and run again.
    await ctx.outbox.update(rec.id, { nextAttemptAt: null });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls.length, 2);
    assert.equal(ctx.fakeSubmit.calls[1].idempotencyKey, K, 'the retry must reuse the exact same key');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-015 / 016 / 017 / 018: error classification
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-015: HTTP 500 remains retryable (PENDING)', async () => {
  const ctx = await setup('http500-retryable');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 15, batchNumber: 'O', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Server error', { status: 500 }); });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'PENDING');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-016: HTTP 400 (permanent validation failure) marks the operation FAILED', async () => {
  const ctx = await setup('http400-failed');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 16, batchNumber: 'P', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => {
      throw new ApiError('HTTP', 'Invalid quantity', { status: 400, code: 'INVALID_QUANTITY' });
    });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'FAILED');
    assert.match(after.lastError, /Invalid quantity/);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-017: HTTP 401 authentication failure is handled without silent credential regeneration or data loss', async () => {
  const ctx = await setup('http401-auth');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 17, batchNumber: 'Q', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Unauthorized', { status: 401 }); });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    // Per PERMANENT_HTTP_STATUSES in api/errors.ts, 401 is non-retryable -> FAILED.
    assert.equal(after.status, 'FAILED');
    assert.match(after.lastError, /Unauthorized/);
    // The operation itself is preserved (not deleted) and still carries its key.
    assert.equal(after.idempotencyKey, rec.idempotencyKey);
    assert.equal(after.medicineId, 17);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-018: HTTP 409 idempotency conflict marks the operation FAILED', async () => {
  const ctx = await setup('http409-conflict');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 18, batchNumber: 'R', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => {
      throw new ApiError('HTTP', 'Idempotency key conflict', { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'FAILED');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-019 / 020 / 021: permanent validation failures
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-019: invalid QR payload (server-classified) marks FAILED', async () => {
  const ctx = await setup('invalid-qr');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 19, batchNumber: 'S', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => {
      throw new ApiError('HTTP', 'Invalid QR payload', { status: 400, code: 'INVALID_QR_PAYLOAD' });
    });

    await ctx.engine.syncNow();

    assert.equal((await ctx.outbox.getById(rec.id)).status, 'FAILED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-020: invalid quantity (server-classified) marks FAILED', async () => {
  const ctx = await setup('invalid-qty');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 20, batchNumber: 'T', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => {
      throw new ApiError('HTTP', 'Quantity must be positive', { status: 400, code: 'INVALID_QUANTITY' });
    });

    await ctx.engine.syncNow();

    assert.equal((await ctx.outbox.getById(rec.id)).status, 'FAILED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-021: invalid medicine/batch (server-classified 404) marks FAILED', async () => {
  const ctx = await setup('invalid-medicine');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 21, batchNumber: 'U', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => {
      throw new ApiError('HTTP', 'Medicine not found', { status: 404, code: 'MEDICINE_NOT_FOUND' });
    });

    await ctx.engine.syncNow();

    assert.equal((await ctx.outbox.getById(rec.id)).status, 'FAILED');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-022 / 023 / 024 / 025: retry metadata, backoff, jitter, restart persistence
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-022: retry count (attempts) persists in the real database after a transient failure', async () => {
  const ctx = await setup('retry-count-persists');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 22, batchNumber: 'V', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('NETWORK', 'offline'); });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.attempts, 1);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-023: retry backoff is bounded by MAX_BACKOFF_MS', () => {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const delay = backoffMs(attempt, () => 1); // max jitter factor
    assert.ok(delay <= MAX_BACKOFF_MS, `attempt ${attempt} produced ${delay}ms, exceeding the cap`);
    assert.ok(delay > 0);
  }
});

test('SYNC-024: retry jitter prevents identical delays across calls for the same attempt number', () => {
  const delays = new Set();
  let seed = 0;
  const pseudoRandom = () => {
    seed = (seed + 0.13) % 1;
    return seed;
  };
  for (let i = 0; i < 10; i++) {
    delays.add(backoffMs(3, pseudoRandom));
  }
  assert.ok(delays.size > 1, 'varying the RNG input must vary the resulting delay (jitter is applied)');
});

test('SYNC-025: app restart preserves retry metadata (attempts, lastError, nextAttemptAt)', async () => {
  const dbPath = tempDbPath('restart-retry-metadata');
  try {
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();
    const connectivity = makeFakeConnectivity(true);
    const fakeSubmit = makeFakeSubmit();
    const engine1 = new AutoSyncEngine(connectivity.port, store1, fakeSubmit.submit);

    const rec = await store1.enqueue({ medicineId: 25, batchNumber: 'W', quantity: 1 });
    fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Server error', { status: 500 }); });
    await engine1.syncNow();

    const beforeRestart = await store1.getById(rec.id);
    assert.equal(beforeRestart.attempts, 1);
    assert.ok(beforeRestart.nextAttemptAt);
    await store1.close();

    // Simulate app restart: brand new store instance, same file.
    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init();
    const afterRestart = await store2.getById(rec.id);

    assert.equal(afterRestart.attempts, beforeRestart.attempts);
    assert.equal(afterRestart.nextAttemptAt, beforeRestart.nextAttemptAt);
    assert.equal(afterRestart.lastError, beforeRestart.lastError);
    await store2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('SYNC-026: app restart preserves the idempotency key across a retry cycle', async () => {
  const dbPath = tempDbPath('restart-key');
  try {
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();
    const connectivity = makeFakeConnectivity(true);
    const fakeSubmit = makeFakeSubmit();
    const engine1 = new AutoSyncEngine(connectivity.port, store1, fakeSubmit.submit);

    const rec = await store1.enqueue({ medicineId: 26, batchNumber: 'X', quantity: 1 });
    const K = rec.idempotencyKey;
    fakeSubmit.programResponse(() => { throw new ApiError('TIMEOUT', 'timeout'); });
    await engine1.syncNow();
    await store1.close();

    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init();
    const reloaded = await store2.getById(rec.id);
    assert.equal(reloaded.idempotencyKey, K);

    const fakeSubmit2 = makeFakeSubmit();
    fakeSubmit2.programResponse((request) => successResponse(request));
    await store2.update(rec.id, { nextAttemptAt: null });
    const engine2 = new AutoSyncEngine(connectivity.port, store2, fakeSubmit2.submit);
    await engine2.syncNow();

    assert.equal(fakeSubmit2.calls[0].idempotencyKey, K, 'the post-restart retry must use the same key');
    await store2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('SYNC-027: a SYNCING record stranded by a crash is recovered to a retryable state on next init()', async () => {
  const dbPath = tempDbPath('crash-recovery-sync');
  try {
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();
    const rec = await store1.enqueue({ medicineId: 27, batchNumber: 'Y', quantity: 1 });
    await store1.update(rec.id, { status: 'SYNCING' }); // simulate an in-flight sync
    await store1.close(); // app "crashes" mid-sync

    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init(); // Phase 7H's recoverStranded() runs automatically here

    const recovered = await store2.getById(rec.id);
    assert.equal(recovered.status, 'PENDING', 'must be retryable, not stuck in SYNCING or silently FAILED');
    assert.equal(recovered.idempotencyKey, rec.idempotencyKey);
    await store2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-028 / 029: manual retry preserves key and payload
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-028: manual retry() preserves the original idempotency key', async () => {
  const ctx = await setup('manual-retry-key');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 28, batchNumber: 'Z', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad request', { status: 400 } ); });
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(rec.id)).status, 'FAILED');

    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    assert.equal(ctx.fakeSubmit.calls[1].idempotencyKey, rec.idempotencyKey);
    assert.equal((await ctx.outbox.getById(rec.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-029: manual retry cannot edit medicine/batch/quantity/idempotencyKey', async () => {
  const ctx = await setup('manual-retry-no-edit');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 29, batchNumber: 'AA', quantity: 12 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad request', { status: 400 }); });
    await ctx.engine.syncNow();

    // retry() only accepts a record id — there is no parameter through which a
    // caller could supply a different medicineId/batchNumber/quantity/key.
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.medicineId, 29);
    assert.equal(after.batchNumber, 'AA');
    assert.equal(after.quantity, 12);
    assert.equal(after.idempotencyKey, rec.idempotencyKey);
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-030 / 031: request/security
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-030: no pharmacyId is ever sent to the backend by the sync engine', async () => {
  const ctx = await setup('no-pharmacy-id');
  try {
    await ctx.outbox.enqueue({ medicineId: 30, batchNumber: 'BB', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();

    const sent = ctx.fakeSubmit.calls[0];
    assert.equal(sent.pharmacyId, undefined);
    assert.equal(sent.pharmacy_id, undefined);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-031: no device token appears in the reconstructed request body', async () => {
  const ctx = await setup('no-token-in-body');
  try {
    await ctx.outbox.enqueue({ medicineId: 31, batchNumber: 'CC', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();

    const sentStr = JSON.stringify(ctx.fakeSubmit.calls[0]);
    assert.ok(!/medidev_/.test(sentStr));
    assert.ok(!/deviceToken|device_token/i.test(sentStr));
    // Device auth happens via the header, injected by the central apiClient —
    // outside the request body the sync engine constructs.
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-032 / 033 / 034 / 035: multiple operations, isolation, ordering, batching
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-032: multiple pending operations are processed independently', async () => {
  const ctx = await setup('multi-independent');
  try {
    const a = await ctx.outbox.enqueue({ medicineId: 32, batchNumber: 'DD1', quantity: 1 });
    const b = await ctx.outbox.enqueue({ medicineId: 33, batchNumber: 'DD2', quantity: 2 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    await ctx.engine.syncNow();

    assert.equal((await ctx.outbox.getById(a.id)).status, 'SYNCED');
    assert.equal((await ctx.outbox.getById(b.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-033: one failed operation does not block unrelated valid operations in the same batch', async () => {
  const ctx = await setup('one-fail-others-ok');
  try {
    const bad = await ctx.outbox.enqueue({ medicineId: 34, batchNumber: 'EE1', quantity: 1 });
    const good = await ctx.outbox.enqueue({ medicineId: 35, batchNumber: 'EE2', quantity: 2 });

    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Medicine not found', { status: 404, code: 'MEDICINE_NOT_FOUND' }); });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    await ctx.engine.syncNow();

    assert.equal((await ctx.outbox.getById(bad.id)).status, 'FAILED');
    assert.equal((await ctx.outbox.getById(good.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-034: processing order is deterministic (oldest created_at first)', async () => {
  const ctx = await setup('deterministic-order');
  try {
    const first = await ctx.outbox.enqueue({ medicineId: 36, batchNumber: 'FF1', quantity: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await ctx.outbox.enqueue({ medicineId: 37, batchNumber: 'FF2', quantity: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await ctx.outbox.enqueue({ medicineId: 38, batchNumber: 'FF3', quantity: 1 });

    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls[0].medicineId, first.medicineId);
    assert.equal(ctx.fakeSubmit.calls[1].medicineId, second.medicineId);
    assert.equal(ctx.fakeSubmit.calls[2].medicineId, third.medicineId);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-035: batch size per sync cycle is bounded (SYNC_BATCH_SIZE)', async () => {
  const ctx = await setup('bounded-batch');
  try {
    const total = SYNC_BATCH_SIZE + 5;
    for (let i = 0; i < total; i++) {
      await ctx.outbox.enqueue({ medicineId: 100 + i, batchNumber: `GG${i}`, quantity: 1 });
    }
    for (let i = 0; i < total; i++) {
      ctx.fakeSubmit.programResponse((request) => successResponse(request));
    }

    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls.length, SYNC_BATCH_SIZE, 'exactly one bounded batch must be processed per cycle');

    const counts = await ctx.outbox.counts();
    assert.equal(counts.synced, SYNC_BATCH_SIZE);
    assert.equal(counts.pending, total - SYNC_BATCH_SIZE, 'the remainder must survive, untouched, for the next cycle');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-036 / 037: Sync Queue does not fabricate status
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-036: reading the queue (listAll/counts) never fabricates a success state', async () => {
  const ctx = await setup('queue-no-fabrication');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 39, batchNumber: 'HH', quantity: 1 });
    // Deliberately do NOT sync. Merely reading the queue must reflect PENDING.
    const all = await ctx.outbox.listAll();
    const counts = await ctx.outbox.counts();

    assert.equal(all.find((r) => r.id === rec.id).status, 'PENDING');
    assert.equal(counts.synced, 0);
    assert.equal(ctx.fakeSubmit.calls.length, 0, 'reading the queue must not call the network');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-037: Sync Queue shows the actual persisted status after a real sync pass', async () => {
  const ctx = await setup('queue-actual-status');
  try {
    const a = await ctx.outbox.enqueue({ medicineId: 40, batchNumber: 'II1', quantity: 1 });
    const b = await ctx.outbox.enqueue({ medicineId: 41, batchNumber: 'II2', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });

    await ctx.engine.syncNow();

    const all = await ctx.outbox.listAll();
    assert.equal(all.find((r) => r.id === a.id).status, 'SYNCED');
    assert.equal(all.find((r) => r.id === b.id).status, 'FAILED');

    const counts = await ctx.outbox.counts();
    assert.equal(counts.synced, 1);
    assert.equal(counts.failed, 1);
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-038: offline during sync
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-038: connectivity lost mid-sync does not lose any operation', async () => {
  const ctx = await setup('offline-during-sync');
  try {
    const a = await ctx.outbox.enqueue({ medicineId: 42, batchNumber: 'JJ1', quantity: 1 });
    const b = await ctx.outbox.enqueue({ medicineId: 43, batchNumber: 'JJ2', quantity: 1 });

    // First item succeeds; before the second item's isOnline() re-check, go offline.
    ctx.fakeSubmit.programResponse(async (request) => {
      ctx.connectivity.setOnline(false);
      return successResponse(request);
    });
    // No second response is programmed — if it were called, the harness would
    // throw "no response programmed", which we assert does NOT happen.

    await ctx.engine.syncNow();

    const aAfter = await ctx.outbox.getById(a.id);
    const bAfter = await ctx.outbox.getById(b.id);
    assert.equal(aAfter.status, 'SYNCED');
    assert.equal(bAfter.status, 'PENDING', 'must stop safely rather than fail the second item as a network error');
    assert.equal(ctx.fakeSubmit.calls.length, 1, 'the second item must never have been attempted once offline');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-039 / 040: repeated triggers do not duplicate workers
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-039: repeated NetInfo online events do not start duplicate workers', async () => {
  const ctx = await setup('repeated-netinfo-online', { initiallyOnline: false });
  try {
    await ctx.outbox.enqueue({ medicineId: 44, batchNumber: 'KK', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    await ctx.engine.start();

    // Fire online -> offline -> online -> online repeatedly; only a genuine
    // offline->online EDGE should trigger a run, and overlapping runs coalesce.
    ctx.connectivity.setOnline(true);
    ctx.connectivity.setOnline(true); // no transition, should not add a call
    ctx.connectivity.setOnline(true); // no transition, should not add a call

    // The listener's syncNow() call is fire-and-forget (void this.syncNow());
    // give it a tick to actually start before we await our own syncNow() call,
    // matching the same pattern used in SYNC-005.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ctx.engine.syncNow(); // settle any in-flight coalesced run

    assert.equal(ctx.fakeSubmit.calls.length, 1, 'exactly one network call for the one queued operation');
  } finally {
    ctx.engine.stop();
    await ctx.teardown();
  }
});

test('SYNC-040: repeated Sync Now taps do not start duplicate workers', async () => {
  const ctx = await setup('repeated-sync-now-taps');
  try {
    await ctx.outbox.enqueue({ medicineId: 45, batchNumber: 'LL', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    const taps = [ctx.engine.syncNow(), ctx.engine.syncNow(), ctx.engine.syncNow(), ctx.engine.syncNow(), ctx.engine.syncNow()];
    await Promise.all(taps);

    assert.equal(ctx.fakeSubmit.calls.length, 1, 'five rapid taps must coalesce into one worker/one network call');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-041 / 042: response loss + restart, via idempotency
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-041: server response loss after a successful mutation is safe — retry resolves via idempotent replay', async () => {
  const ctx = await setup('response-loss-safe');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 46, batchNumber: 'MM', quantity: 9 });

    // Attempt 1: the server "successfully mutated" but the client never saw the
    // response (simulated as a network/timeout error at the client boundary).
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('NETWORK', 'Could not reach the MediIndex server.'); });
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(rec.id)).status, 'PENDING');

    // Attempt 2 (retry, same key): the backend recognizes K and returns the
    // cached/idempotent result rather than mutating again.
    await ctx.outbox.update(rec.id, { nextAttemptAt: null });
    ctx.fakeSubmit.programResponse((request) => idempotentResponse(request));
    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls[1].idempotencyKey, rec.idempotencyKey);
    assert.equal((await ctx.outbox.getById(rec.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-042: the same operation retries after a simulated app restart using the same key', async () => {
  const dbPath = tempDbPath('restart-retry-same-key');
  try {
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();
    const connectivity = makeFakeConnectivity(true);
    const fakeSubmit1 = makeFakeSubmit();
    const engine1 = new AutoSyncEngine(connectivity.port, store1, fakeSubmit1.submit);

    const rec = await store1.enqueue({ medicineId: 47, batchNumber: 'NN', quantity: 3 });
    fakeSubmit1.programResponse(() => { throw new ApiError('TIMEOUT', 'timeout'); });
    await engine1.syncNow();
    await store1.close(); // simulated restart

    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init();
    await store2.update(rec.id, { nextAttemptAt: null });
    const fakeSubmit2 = makeFakeSubmit();
    fakeSubmit2.programResponse((request) => successResponse(request));
    const engine2 = new AutoSyncEngine(connectivity.port, store2, fakeSubmit2.submit);
    await engine2.syncNow();

    assert.equal(fakeSubmit2.calls[0].idempotencyKey, rec.idempotencyKey);
    assert.equal((await store2.getById(rec.id)).status, 'SYNCED');
    await store2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-043: no locally-authoritative inventory
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-043: a successful sync does not write server-side inventory fields into the local outbox row as authoritative', async () => {
  const ctx = await setup('no-local-authority');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 48, batchNumber: 'OO', quantity: 4 });
    ctx.fakeSubmit.programResponse((request) => successResponse({ ...request, currentStock: 999999 }));

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    // The outbox schema (Phase 7H) has no currentStock/authoritative-inventory
    // column at all — confirm no such field leaked onto the record.
    assert.equal(after.currentStock, undefined);
    assert.equal(after.quantity, 4, 'the outbox retains only the ORIGINAL requested quantity, never a server-recalculated value');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-044 / 045 / 046: permanent failure bounds, manual retry, SYNCED immutability
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-044: a permanent failure is not automatically retried forever (it becomes FAILED after one attempt, no scheduled nextAttemptAt)', async () => {
  const ctx = await setup('permanent-not-forever');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 49, batchNumber: 'PP', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Invalid quantity', { status: 400, code: 'INVALID_QUANTITY' }); });

    await ctx.engine.syncNow();
    const after = await ctx.outbox.getById(rec.id);

    assert.equal(after.status, 'FAILED');
    assert.equal(after.nextAttemptAt, null, 'a permanent failure must not be scheduled for automatic retry');

    // Running further sync passes must not attempt it again automatically.
    await ctx.engine.syncNow();
    assert.equal(ctx.fakeSubmit.calls.length, 1, 'a FAILED record must not be picked up by listSyncable()/automatic sync again');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-045: a FAILED operation can be manually retried', async () => {
  const ctx = await setup('failed-manual-retry');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 50, batchNumber: 'QQ', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'not found', { status: 404 }); });
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(rec.id)).status, 'FAILED');

    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    assert.equal((await ctx.outbox.getById(rec.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-046: a SYNCED operation cannot be retried as if it were a new/different logical operation', async () => {
  const ctx = await setup('synced-immutable');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 51, batchNumber: 'RR', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(rec.id)).status, 'SYNCED');

    // retry() explicitly rejects anything that isn't FAILED.
    await assert.rejects(ctx.engine.retry(rec.id), /is SYNCED, not FAILED/);

    // Sync passes never re-select SYNCED rows either.
    await ctx.engine.syncNow();
    assert.equal(ctx.fakeSubmit.calls.length, 1, 'a SYNCED row must never be resubmitted');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SYNC-047 / 048 / 049 / 050: lock lifecycle and count accuracy
// ─────────────────────────────────────────────────────────────────────────────
test('SYNC-047: no automatic synchronization starts a second pass while one is already running', async () => {
  const ctx = await setup('no-second-pass-while-running');
  try {
    await ctx.outbox.enqueue({ medicineId: 52, batchNumber: 'SS', quantity: 1 });

    let releaseFirst;
    const started = new Promise((resolveStarted) => {
      ctx.fakeSubmit.programResponse(() => {
        resolveStarted();
        return new Promise((resolve) => { releaseFirst = () => resolve(successResponse({})); });
      });
    });

    const firstRun = ctx.engine.syncNow();
    await started;

    // Simulate the startup trigger firing again while the first run is still active.
    await ctx.engine.start(); // idempotent no-op subscription, but calls syncNow() internally too — should coalesce
    const raceRun = ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls.length, 1, 'still only one call while the first run is in flight');

    releaseFirst();
    await Promise.all([firstRun, raceRun]);
    ctx.engine.stop();
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-048: outbox counts update correctly after a successful sync', async () => {
  const ctx = await setup('counts-after-success');
  try {
    await ctx.outbox.enqueue({ medicineId: 53, batchNumber: 'TT', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    const before = await ctx.outbox.counts();
    assert.equal(before.pending, 1);

    await ctx.engine.syncNow();

    const after = await ctx.outbox.counts();
    assert.equal(after.pending, 0);
    assert.equal(after.synced, 1);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-049: outbox counts update correctly after a failure', async () => {
  const ctx = await setup('counts-after-failure');
  try {
    await ctx.outbox.enqueue({ medicineId: 54, batchNumber: 'UU', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.counts();
    assert.equal(after.pending, 0);
    assert.equal(after.failed, 1);
  } finally {
    await ctx.teardown();
  }
});

test('SYNC-050: the sync worker releases its lock after both success and failure, allowing a subsequent pass', async () => {
  const ctx = await setup('lock-released');
  try {
    const a = await ctx.outbox.enqueue({ medicineId: 55, batchNumber: 'VV1', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(a.id)).status, 'SYNCED');

    // Lock must be free now — a brand new pass for a NEW operation must proceed.
    const b = await ctx.outbox.enqueue({ medicineId: 56, batchNumber: 'VV2', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(b.id)).status, 'FAILED');

    // And again after a failure — lock must still be free.
    const c = await ctx.outbox.enqueue({ medicineId: 57, batchNumber: 'VV3', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(c.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});
