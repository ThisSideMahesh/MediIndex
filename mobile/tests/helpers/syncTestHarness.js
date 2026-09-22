/**
 * Shared harness for Phase 7I real sync-engine integration tests.
 *
 * Builds an isolated (real SQLite, temp file) outbox + a real AutoSyncEngine
 * instance with an injected fake ConnectivityPort and a fake `submit` function
 * standing in for the network boundary (api/stockEntry.ts -> apiClient.post).
 * The engine class, its locking/coalescing, retry/backoff logic, and the real
 * outbox state machine all execute for real. Only the HTTP transport and the
 * NetInfo-backed connectivity check are faked, mirroring the boundary already
 * established for Phase 7H's SQLiteDriver injection.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function tempDbPath(label) {
  return path.join(os.tmpdir(), `mediindex-sync-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

function cleanupDb(dbPath) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
  }
}

/** A controllable fake ConnectivityPort. `setOnline(bool)` changes state and (if subscribed) fires listeners. */
function makeFakeConnectivity(initiallyOnline = true) {
  let online = initiallyOnline;
  const listeners = new Set();

  return {
    port: {
      async isOnline() {
        return online;
      },
      subscribeToConnectivity(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    setOnline(next) {
      online = next;
      for (const listener of listeners) listener({ isConnected: next });
    },
    isOnline() {
      return online;
    },
  };
}

/**
 * A controllable fake `submit` function (stands in for submitStockReceipt).
 * `programResponse(fn)` sets what the NEXT call returns/throws; `calls` records
 * every request actually sent, so tests can assert on idempotencyKey reuse.
 */
function makeFakeSubmit() {
  const calls = [];
  const queue = [];

  function programResponse(fn) {
    queue.push(fn);
  }

  async function submit(request) {
    calls.push({ ...request });
    const next = queue.shift();
    if (!next) {
      throw new Error('makeFakeSubmit: no response programmed for this call');
    }
    return next(request);
  }

  return { submit, calls, programResponse };
}

function successResponse(overrides = {}) {
  return {
    success: true,
    status: 'STOCK_UPDATED',
    idempotent: false,
    medicine: { id: overrides.medicineId ?? 1, name: 'Test Medicine', genericName: 'Generic', category: 'TABLET' },
    batch: {
      id: 1,
      batchNumber: overrides.batchNumber ?? 'BATCH',
      quantityAdded: overrides.quantity ?? 1,
      currentStock: overrides.currentStock ?? 100,
      expiryDate: '2030-01-01',
      sellingPrice: 10,
      location: 'Shelf A',
    },
    movementId: overrides.movementId ?? 100,
    deviceId: 1,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function idempotentResponse(overrides = {}) {
  return successResponse({ ...overrides, idempotent: true });
}

module.exports = {
  tempDbPath,
  cleanupDb,
  makeFakeConnectivity,
  makeFakeSubmit,
  successResponse,
  idempotentResponse,
};
