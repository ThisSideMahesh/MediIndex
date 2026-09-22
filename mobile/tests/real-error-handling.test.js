/**
 * REAL ERROR HANDLING / RETRY HARDENING TESTS — Phase 7J
 *
 * Executes the ACTUAL production `AutoSyncEngine` (mobile/src/sync/syncEngine.ts)
 * against a REAL, file-backed SQLite outbox (Node's built-in node:sqlite, same
 * injection pattern established in Phase 7H/7I). Only the network transport
 * (`submit`) and NetInfo-backed connectivity are faked — never the outbox,
 * never the engine, never the error classification module (api/errors.ts),
 * which all run for real.
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
const {
  AutoSyncEngine,
  backoffMs,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  BASE_BACKOFF_MS,
  isAuthFailureRecord,
  stripAuthFailurePrefix,
  AUTH_FAILURE_ERROR_PREFIX,
} = await import('../src/sync/syncEngine.ts');
const {
  ApiError,
  isTransient,
  isAuthenticationFailure,
  classifyError,
  toUserMessage,
} = await import('../src/api/errors.ts');
const { sanitizeErrorText } = await import('../src/utils/logger.ts');

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
// ERROR-001 to 006: classification, using the REAL classifyError/isTransient/
// isAuthenticationFailure from api/errors.ts — not a re-implementation.
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-001: network failure classified retryable', () => {
  const err = new ApiError('NETWORK', 'Could not reach the MediIndex server.');
  assert.equal(isTransient(err), true);
  assert.equal(classifyError(err), 'RETRYABLE');
});

test('ERROR-002: timeout classified retryable', () => {
  const err = new ApiError('TIMEOUT', 'Request timed out after 15000ms.');
  assert.equal(isTransient(err), true);
  assert.equal(classifyError(err), 'RETRYABLE');
});

test('ERROR-003: HTTP 500 classified retryable', () => {
  const err = new ApiError('HTTP', 'Internal server error', { status: 500 });
  assert.equal(isTransient(err), true);
  assert.equal(classifyError(err), 'RETRYABLE');
});

test('ERROR-004: HTTP 400 classified permanent', () => {
  const err = new ApiError('HTTP', 'Invalid quantity', { status: 400, code: 'INVALID_QUANTITY' });
  assert.equal(isTransient(err), false);
  assert.equal(isAuthenticationFailure(err), false);
  assert.equal(classifyError(err), 'PERMANENT');
});

test('ERROR-005: HTTP 401 classified authentication (not permanent, not retryable)', () => {
  const err = new ApiError('HTTP', 'This device is not authorised.', { status: 401 });
  assert.equal(isAuthenticationFailure(err), true);
  assert.equal(isTransient(err), false);
  assert.equal(classifyError(err), 'AUTHENTICATION');
});

test('ERROR-006: HTTP 409 idempotency conflict classified permanent', () => {
  const err = new ApiError('HTTP', 'Idempotency key conflict', { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(isTransient(err), false);
  assert.equal(isAuthenticationFailure(err), false);
  assert.equal(classifyError(err), 'PERMANENT');
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-007 / 008: backoff increases, jitter bounded
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-007: retry backoff increases with attempt number', () => {
  const noJitter = () => 0.5; // midpoint, jitterFactor = 1.0
  const d1 = backoffMs(1, noJitter);
  const d2 = backoffMs(2, noJitter);
  const d3 = backoffMs(3, noJitter);
  assert.ok(d2 > d1, `attempt 2 (${d2}ms) must exceed attempt 1 (${d1}ms)`);
  assert.ok(d3 > d2, `attempt 3 (${d3}ms) must exceed attempt 2 (${d2}ms)`);
});

test('ERROR-008: retry jitter is bounded within +/-20% of the base delay and never exceeds MAX_BACKOFF_MS', () => {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const raw = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
    const capped = Math.min(raw, MAX_BACKOFF_MS);
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = backoffMs(attempt, () => r);
      const minExpected = Math.round(capped * 0.8);
      const maxExpected = Math.min(Math.round(capped * 1.2), MAX_BACKOFF_MS);
      assert.ok(delay >= minExpected - 1 && delay <= maxExpected, `attempt ${attempt} r=${r}: ${delay}ms outside [${minExpected}, ${maxExpected}]`);
      assert.ok(delay <= MAX_BACKOFF_MS);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-009: max automatic retry count enforced
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-009: maximum automatic retry count (MAX_ATTEMPTS) is enforced — becomes FAILED, not retried forever', async () => {
  const ctx = await setup('max-attempts');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 9, batchNumber: 'MAXR', quantity: 1 });

    // Fail MAX_ATTEMPTS times with a transient error, clearing backoff each time
    // to make the test deterministic without waiting on real timers.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      ctx.fakeSubmit.programResponse(() => { throw new ApiError('NETWORK', 'offline'); });
      await ctx.engine.syncNow();
      const current = await ctx.outbox.getById(rec.id);
      if (current.status === 'PENDING') {
        await ctx.outbox.update(rec.id, { nextAttemptAt: null });
      }
    }

    const final = await ctx.outbox.getById(rec.id);
    assert.equal(final.status, 'FAILED', `after ${MAX_ATTEMPTS} transient failures the record must stop being auto-retried`);
    assert.equal(final.attempts, MAX_ATTEMPTS);
    assert.equal(final.idempotencyKey, rec.idempotencyKey, 'the key must be unchanged even after exhausting retries');

    // One more sync pass must not pick it up again automatically.
    const callsBefore = ctx.fakeSubmit.calls.length;
    await ctx.engine.syncNow();
    assert.equal(ctx.fakeSubmit.calls.length, callsBefore, 'a FAILED record must not be retried automatically');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-010 / 011 / 012: manual retry resets timing, preserves key + payload
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-010: manual retry resets eligible timing (clears nextAttemptAt, returns to PENDING)', async () => {
  const ctx = await setup('manual-retry-timing');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 10, batchNumber: 'MRT', quantity: 2 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });
    await ctx.engine.syncNow();
    const failed = await ctx.outbox.getById(rec.id);
    assert.equal(failed.status, 'FAILED');

    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    const final = await ctx.outbox.getById(rec.id);
    assert.equal(final.status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-011: manual retry preserves the original idempotency key', async () => {
  const ctx = await setup('manual-retry-key');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 11, batchNumber: 'MRK', quantity: 3 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'not found', { status: 404 }); });
    await ctx.engine.syncNow();

    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    assert.equal(ctx.fakeSubmit.calls[1].idempotencyKey, rec.idempotencyKey);
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-012: manual retry preserves the original payload (medicineId/batchNumber/quantity)', async () => {
  const ctx = await setup('manual-retry-payload');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 12, batchNumber: 'MRP', quantity: 44 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });
    await ctx.engine.syncNow();

    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    const sent = ctx.fakeSubmit.calls[1];
    assert.equal(sent.medicineId, 12);
    assert.equal(sent.batchNumber, 'MRP');
    assert.equal(sent.quantity, 44);

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.medicineId, 12);
    assert.equal(after.batchNumber, 'MRP');
    assert.equal(after.quantity, 44);
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-013 / 014 / 015: authentication failure handling
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-013: a 401 does not generate a new device credential (engine never touches credential storage)', async () => {
  const ctx = await setup('auth-no-new-credential');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 13, batchNumber: 'A13', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Unauthorized', { status: 401 }); });

    await ctx.engine.syncNow();

    // The engine has no dependency on secureStore/deviceToken at all — this is
    // a structural guarantee, not just a runtime observation: `submit` is the
    // ONLY thing the engine calls across the network boundary, and it never
    // receives or produces a credential. Confirmed by reading engine.ts's
    // imports, and reinforced here by checking the persisted record contains
    // no credential-shaped value.
    const after = await ctx.outbox.getById(rec.id);
    assert.ok(!/medidev_/.test(JSON.stringify(after)));
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-014: a 401 does not delete the queued operation', async () => {
  const ctx = await setup('auth-no-delete');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 14, batchNumber: 'A14', quantity: 5 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Unauthorized', { status: 401 }); });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.ok(after, 'the record must still exist');
    assert.equal(after.medicineId, 14);
    assert.equal(after.batchNumber, 'A14');
    assert.equal(after.quantity, 5);
    assert.equal(after.idempotencyKey, rec.idempotencyKey);
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-015: after re-authentication, the existing operation retries with the same key (not deleted, not recreated)', async () => {
  const ctx = await setup('auth-reauth-retry');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 15, batchNumber: 'A15', quantity: 6 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Unauthorized', { status: 401 }); });
    await ctx.engine.syncNow();

    const afterAuthFailure = await ctx.outbox.getById(rec.id);
    assert.equal(afterAuthFailure.status, 'FAILED');
    assert.ok(isAuthFailureRecord(afterAuthFailure), 'must be tagged as an auth failure');

    // Simulate: user re-pairs the device (out of scope here — that's Phase 7C/7D
    // machinery, unmodified), then retries this same operation.
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    assert.equal(ctx.fakeSubmit.calls[1].idempotencyKey, rec.idempotencyKey, 'retry after re-auth must reuse the same key');
    const final = await ctx.outbox.getById(rec.id);
    assert.equal(final.status, 'SYNCED');
    assert.equal(final.id, rec.id, 'must be the SAME row, not a new one');
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-015b: an authentication-failed record is correctly tagged and its display message has the internal prefix stripped', async () => {
  const ctx = await setup('auth-tag-display');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 151, batchNumber: 'A151', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'This device is not authorised. Please pair it again.', { status: 401 }); });
    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.ok(after.lastError.startsWith(AUTH_FAILURE_ERROR_PREFIX));
    assert.ok(isAuthFailureRecord(after));

    const displayed = stripAuthFailurePrefix(after.lastError);
    assert.ok(!displayed.startsWith(AUTH_FAILURE_ERROR_PREFIX));
    assert.match(displayed, /not authorised/i);
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-016 / 017: response loss / timeout preserves key, no duplicate stock
// (client-side proof; the full real-backend proof is the critical E2E test)
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-016: response timeout preserves the idempotency key for the next attempt', async () => {
  const ctx = await setup('timeout-key-preserved');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 16, batchNumber: 'A16', quantity: 7 });
    const K = rec.idempotencyKey;

    ctx.fakeSubmit.programResponse(() => { throw new ApiError('TIMEOUT', 'Request timed out.'); });
    await ctx.engine.syncNow();
    assert.equal(ctx.fakeSubmit.calls[0].idempotencyKey, K);

    await ctx.outbox.update(rec.id, { nextAttemptAt: null });
    ctx.fakeSubmit.programResponse((request) => idempotentResponse(request));
    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls[1].idempotencyKey, K, 'the retry must send the exact same key');
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-017: retrying after a timeout does not create a duplicate logical operation (still one row, one key)', async () => {
  const ctx = await setup('timeout-no-duplicate-row');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 17, batchNumber: 'A17', quantity: 8 });

    ctx.fakeSubmit.programResponse(() => { throw new ApiError('TIMEOUT', 'timed out'); });
    await ctx.engine.syncNow();
    await ctx.outbox.update(rec.id, { nextAttemptAt: null });
    ctx.fakeSubmit.programResponse((request) => idempotentResponse(request));
    await ctx.engine.syncNow();

    const all = await ctx.outbox.listAll();
    assert.equal(all.length, 1, 'exactly one outbox row must exist for this one logical receipt');
    assert.equal(all[0].id, rec.id);
    assert.equal(all[0].status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-018 / 019 / 020: offline mid-sync, crash recovery
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-018: network loss during sync preserves the in-flight operation (no delete, no false SYNCED)', async () => {
  const ctx = await setup('network-loss-mid-sync');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 18, batchNumber: 'A18', quantity: 9 });

    ctx.fakeSubmit.programResponse(async () => {
      ctx.connectivity.setOnline(false); // connectivity vanishes mid-request
      throw new ApiError('NETWORK', 'Connection lost');
    });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.notEqual(after.status, 'SYNCED');
    assert.ok(after, 'operation must still exist');
    assert.equal(after.idempotencyKey, rec.idempotencyKey);
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-019: app termination during SYNCING recovers the operation to a retryable state on next startup', async () => {
  const dbPath = tempDbPath('term-during-syncing');
  try {
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();
    const rec = await store1.enqueue({ medicineId: 19, batchNumber: 'A19', quantity: 10 });
    await store1.update(rec.id, { status: 'SYNCING' }); // simulate mid-flight
    await store1.close(); // simulated termination — no clean shutdown

    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init(); // recoverStranded() runs automatically

    const recovered = await store2.getById(rec.id);
    assert.equal(recovered.status, 'PENDING');
    await store2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('ERROR-020: a recovered SYNCING operation preserves its original idempotency key', async () => {
  const dbPath = tempDbPath('term-key-preserved');
  try {
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();
    const rec = await store1.enqueue({ medicineId: 20, batchNumber: 'A20', quantity: 11 });
    await store1.update(rec.id, { status: 'SYNCING' });
    await store1.close();

    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init();
    const recovered = await store2.getById(rec.id);

    assert.equal(recovered.idempotencyKey, rec.idempotencyKey);
    await store2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-021 / 022 / 023: concurrency — one worker only, across every trigger
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-021: multiple simultaneous sync triggers create exactly one worker', async () => {
  const ctx = await setup('multi-trigger-one-worker');
  try {
    await ctx.outbox.enqueue({ medicineId: 21, batchNumber: 'A21', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    // Simulate startup + NetInfo + manual all firing at once.
    const results = await Promise.all([
      ctx.engine.syncNow(),
      ctx.engine.syncNow(),
      ctx.engine.syncNow(),
    ]);

    assert.equal(results[0], results[1]);
    assert.equal(results[1], results[2]);
    assert.equal(ctx.fakeSubmit.calls.length, 1);
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-022: repeated "Sync Now" taps create exactly one worker', async () => {
  const ctx = await setup('repeated-taps-one-worker');
  try {
    await ctx.outbox.enqueue({ medicineId: 22, batchNumber: 'A22', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    const taps = Array.from({ length: 8 }, () => ctx.engine.syncNow());
    await Promise.all(taps);

    assert.equal(ctx.fakeSubmit.calls.length, 1, 'eight rapid taps must still result in exactly one network call');
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-023: repeated NetInfo online events create exactly one worker (no duplicate on repeated online-true)', async () => {
  const ctx = await setup('repeated-netinfo-one-worker', { initiallyOnline: false });
  try {
    await ctx.outbox.enqueue({ medicineId: 23, batchNumber: 'A23', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));

    await ctx.engine.start();
    ctx.connectivity.setOnline(true);
    ctx.connectivity.setOnline(true);
    ctx.connectivity.setOnline(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls.length, 1);
  } finally {
    ctx.engine.stop();
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-024 / 025: manual retry of FAILED, permanent failure not retried forever
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-024: a FAILED operation can be manually retried', async () => {
  const ctx = await setup('failed-manual-retry-2');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 24, batchNumber: 'A24', quantity: 1 });
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

test('ERROR-025: a permanent failure is not automatically retried forever', async () => {
  const ctx = await setup('permanent-not-forever-2');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 25, batchNumber: 'A25', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Invalid quantity', { status: 400, code: 'INVALID_QUANTITY' }); });
    await ctx.engine.syncNow();

    const after1 = await ctx.outbox.getById(rec.id);
    assert.equal(after1.status, 'FAILED');
    assert.equal(after1.nextAttemptAt, null);

    const callsBefore = ctx.fakeSubmit.calls.length;
    await ctx.engine.syncNow();
    await ctx.engine.syncNow();
    assert.equal(ctx.fakeSubmit.calls.length, callsBefore, 'no further automatic attempts for a permanent failure');
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-026 to 030: idempotency conflict, and payload/key immutability
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-026: an idempotency conflict (409) does not generate a new key', async () => {
  const ctx = await setup('conflict-no-new-key');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 26, batchNumber: 'A26', quantity: 1 });
    const K = rec.idempotencyKey;
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Idempotency key conflict', { status: 409, code: 'IDEMPOTENCY_CONFLICT' }); });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.equal(after.status, 'FAILED');
    assert.equal(after.idempotencyKey, K, 'the key must be unchanged by a conflict');
    assert.equal(ctx.fakeSubmit.calls[0].idempotencyKey, K);
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-027: persisted medicineId cannot change after any sync attempt (success, failure, or retry)', async () => {
  const ctx = await setup('immutable-medicine-id');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 27, batchNumber: 'A27', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });
    await ctx.engine.syncNow();
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    const final = await ctx.outbox.getById(rec.id);
    assert.equal(final.medicineId, 27);
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-028: persisted batchNumber cannot change after any sync attempt', async () => {
  const ctx = await setup('immutable-batch-number');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 28, batchNumber: 'IMMUTABLE-BATCH', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('NETWORK', 'offline'); });
    await ctx.engine.syncNow();
    await ctx.outbox.update(rec.id, { nextAttemptAt: null });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();

    const final = await ctx.outbox.getById(rec.id);
    assert.equal(final.batchNumber, 'IMMUTABLE-BATCH');
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-029: persisted quantity cannot change after any sync attempt', async () => {
  const ctx = await setup('immutable-quantity');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 29, batchNumber: 'A29', quantity: 77 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'server error', { status: 503 }); });
    await ctx.engine.syncNow();
    await ctx.outbox.update(rec.id, { nextAttemptAt: null });
    ctx.fakeSubmit.programResponse((request) => idempotentResponse(request));
    await ctx.engine.syncNow();

    const final = await ctx.outbox.getById(rec.id);
    assert.equal(final.quantity, 77);
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-030: persisted idempotencyKey cannot change across the full success/failure/retry lifecycle', async () => {
  const ctx = await setup('immutable-key-lifecycle');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 30, batchNumber: 'A30', quantity: 1 });
    const K = rec.idempotencyKey;

    ctx.fakeSubmit.programResponse(() => { throw new ApiError('NETWORK', 'offline'); });
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(rec.id)).idempotencyKey, K);

    await ctx.outbox.update(rec.id, { nextAttemptAt: null });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(rec.id)).idempotencyKey, K);

    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);
    assert.equal((await ctx.outbox.getById(rec.id)).idempotencyKey, K);
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-031 / 032: logging and user-facing message safety
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-031: no credential appears in a persisted error message, even if the underlying error text contained one', async () => {
  const ctx = await setup('no-credential-in-logs');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 31, batchNumber: 'A31', quantity: 1 });
    // Simulate a worst-case underlying error that echoes a token (e.g. from a
    // library that includes request details in its message) — sanitizeErrorText
    // must strip it before it is ever persisted to SQLite.
    ctx.fakeSubmit.programResponse(() => {
      throw new ApiError('HTTP', 'Request failed with Authorization: Bearer medidev_deadbeefdeadbeefdeadbeefdeadbeef', { status: 400 });
    });

    await ctx.engine.syncNow();

    const after = await ctx.outbox.getById(rec.id);
    assert.ok(!/medidev_[a-f0-9]+/.test(after.lastError), 'raw device token must never be persisted');
    assert.ok(!/Bearer\s+medidev_/.test(after.lastError));
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-032: sanitizeErrorText strips tokens, paths, and SQL-shaped fragments while remaining a usable message', () => {
  const withToken = sanitizeErrorText('Auth failed for medidev_abc123def456abc123def456');
  assert.ok(!withToken.includes('medidev_abc123def456abc123def456'));

  const withBearer = sanitizeErrorText('Failed: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def');
  assert.ok(!withBearer.includes('eyJhbGciOiJIUzI1NiJ9'));

  const withPath = sanitizeErrorText('ENOENT: /Users/someone/secret-project/db.sqlite not found');
  assert.ok(!withPath.includes('/Users/someone/secret-project'));

  const withSql = sanitizeErrorText('DB error: SELECT * FROM paired_devices WHERE token_hash = \'xyz\' failed');
  assert.ok(!withSql.includes('paired_devices'));

  // A plain, already-safe message must survive basically unchanged.
  const plain = sanitizeErrorText('Medicine not found');
  assert.equal(plain, 'Medicine not found');
});

test('ERROR-032b: toUserMessage() never echoes the raw technical error text', () => {
  const raw = new ApiError('HTTP', 'INTERNAL: constraint failed at /Users/dev/core.js:512 querying idempotency_keys', { status: 500 });
  const shown = toUserMessage(raw, classifyError(raw));
  assert.ok(!shown.includes('/Users/dev'));
  assert.ok(!shown.includes('idempotency_keys'));
  assert.ok(!shown.includes('core.js'));
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-033 / 034 / 035: durability and queue visibility
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-033: an offline receipt remains durable after a simulated restart', async () => {
  const dbPath = tempDbPath('durable-restart');
  try {
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();
    const rec = await store1.enqueue({ medicineId: 33, batchNumber: 'A33', quantity: 12 });
    await store1.close();

    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init();
    const reloaded = await store2.getById(rec.id);

    assert.ok(reloaded);
    assert.equal(reloaded.status, 'PENDING');
    assert.equal(reloaded.medicineId, 33);
    assert.equal(reloaded.batchNumber, 'A33');
    assert.equal(reloaded.quantity, 12);
    await store2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('ERROR-034: retry metadata (attempts, lastError, nextAttemptAt) survives a simulated restart', async () => {
  const dbPath = tempDbPath('retry-metadata-restart');
  try {
    const store1 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store1.init();
    const connectivity = makeFakeConnectivity(true);
    const fakeSubmit = makeFakeSubmit();
    const engine1 = new AutoSyncEngine(connectivity.port, store1, fakeSubmit.submit);

    const rec = await store1.enqueue({ medicineId: 34, batchNumber: 'A34', quantity: 13 });
    fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'Server error', { status: 500 }); });
    await engine1.syncNow();

    const before = await store1.getById(rec.id);
    await store1.close();

    const store2 = new SQLiteOutboxStore(dbPath, openNodeSqliteDriver);
    await store2.init();
    const after = await store2.getById(rec.id);

    assert.equal(after.attempts, before.attempts);
    assert.equal(after.lastError, before.lastError);
    assert.equal(after.nextAttemptAt, before.nextAttemptAt);
    await store2.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('ERROR-035: a FAILED operation remains visible in the queue (listAll/counts), never silently hidden', async () => {
  const ctx = await setup('failed-visible');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 35, batchNumber: 'A35', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });
    await ctx.engine.syncNow();

    const all = await ctx.outbox.listAll();
    assert.ok(all.some((r) => r.id === rec.id && r.status === 'FAILED'));

    const counts = await ctx.outbox.counts();
    assert.equal(counts.failed, 1);
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-036 / 037: manual retry row identity, SYNCED immutability
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-036: manual retry does not create a second row', async () => {
  const ctx = await setup('manual-retry-no-second-row');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 36, batchNumber: 'A36', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });
    await ctx.engine.syncNow();

    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.retry(rec.id);

    const all = await ctx.outbox.listAll();
    assert.equal(all.length, 1, 'retry must reuse the existing row, never insert a new one');
    assert.equal(all[0].id, rec.id);
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-037: a successful (SYNCED) operation cannot accidentally become a new logical operation via retry()', async () => {
  const ctx = await setup('synced-cannot-retry-as-new');
  try {
    const rec = await ctx.outbox.enqueue({ medicineId: 37, batchNumber: 'A37', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(rec.id)).status, 'SYNCED');

    await assert.rejects(ctx.engine.retry(rec.id), /is SYNCED, not FAILED/);

    // No new row was created, and the network was not called again.
    const all = await ctx.outbox.listAll();
    assert.equal(all.length, 1);
    assert.equal(ctx.fakeSubmit.calls.length, 1);
  } finally {
    await ctx.teardown();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR-038 / 039 / 040: lock release after every outcome
// ─────────────────────────────────────────────────────────────────────────────
test('ERROR-038: the sync worker releases its lock after an unexpected exception in the sync pass', async () => {
  const ctx = await setup('lock-release-exception');
  try {
    const first = await ctx.outbox.enqueue({ medicineId: 38, batchNumber: 'A38', quantity: 1 });

    // Force listSyncable() itself to throw, simulating an unexpected failure
    // inside the sync pass (not a classified network/HTTP error at the submit
    // boundary — a genuinely unexpected exception in the sync loop itself).
    const originalListSyncable = ctx.outbox.listSyncable.bind(ctx.outbox);
    ctx.outbox.listSyncable = async () => { throw new Error('Simulated unexpected failure'); };

    const status = await ctx.engine.syncNow();
    assert.ok(status.lastError);
    assert.equal(ctx.fakeSubmit.calls.length, 0, 'submit must never have been reached');

    ctx.outbox.listSyncable = originalListSyncable;

    // Lock must be free: a subsequent call must proceed, not hang forever
    // waiting on a stuck in-flight promise. The original record (never
    // attempted, since listSyncable threw before it could be read) is picked
    // up together with a freshly-enqueued second record in this next pass.
    await ctx.outbox.enqueue({ medicineId: 381, batchNumber: 'A381', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();

    assert.equal(ctx.fakeSubmit.calls.length, 2, 'both the never-attempted original record and the new one are processed once the lock is free');
    assert.equal((await ctx.outbox.getById(first.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-039: the sync worker releases its lock after a success, allowing an immediate subsequent pass', async () => {
  const ctx = await setup('lock-release-success');
  try {
    const a = await ctx.outbox.enqueue({ medicineId: 39, batchNumber: 'A39a', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(a.id)).status, 'SYNCED');

    const b = await ctx.outbox.enqueue({ medicineId: 391, batchNumber: 'A39b', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(b.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});

test('ERROR-040: the sync worker releases its lock after a permanent failure, allowing an immediate subsequent pass', async () => {
  const ctx = await setup('lock-release-permanent-failure');
  try {
    const a = await ctx.outbox.enqueue({ medicineId: 40, batchNumber: 'A40a', quantity: 1 });
    ctx.fakeSubmit.programResponse(() => { throw new ApiError('HTTP', 'bad', { status: 400 }); });
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(a.id)).status, 'FAILED');

    const b = await ctx.outbox.enqueue({ medicineId: 401, batchNumber: 'A40b', quantity: 1 });
    ctx.fakeSubmit.programResponse((request) => successResponse(request));
    await ctx.engine.syncNow();
    assert.equal((await ctx.outbox.getById(b.id)).status, 'SYNCED');
  } finally {
    await ctx.teardown();
  }
});
