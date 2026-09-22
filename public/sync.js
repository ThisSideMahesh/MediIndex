/**
 * sync.js — MediIndex client-side offline synchronization
 *
 * Responsibilities:
 *  - Detect online/offline status and server availability
 *  - Maintain a durable IndexedDB outbox
 *  - Queue supported offline operations
 *  - Automatically sync the outbox when connectivity returns
 *  - Retry transient failures with capped backoff
 *  - Mark permanent failures as FAILED (no infinite retry)
 *  - Update the sync-status UI indicator
 *  - Provide a sync lock to prevent concurrent workers
 *
 * Supported offline operations:
 *  - STOCK_RECEIPT  (POST /api/sync/stock-receipt)
 *
 * Intentionally NOT supported offline (server-side logic required):
 *  - POS / Sales / Billing (FEFO requires live inventory)
 *  - Medicine creation / deactivation / reactivation
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const DB_NAME    = 'mediindex-sync';
const DB_VERSION = 1;
const STORE_NAME = 'outbox';

// Retry policy
const MAX_ATTEMPTS      = 5;
const BASE_BACKOFF_MS   = 2000;   // 2 s initial retry gap
const MAX_BACKOFF_MS    = 60000;  // 60 s maximum retry gap
const HEALTH_URL        = '/api/health';
const HEALTH_TIMEOUT_MS = 5000;

// Permanent-failure error codes returned by the server — do NOT retry these
const PERMANENT_ERROR_CODES = new Set([
  'MEDICINE_NOT_FOUND',
  'BATCH_NOT_FOUND',
  'INVALID_QR_PAYLOAD',
  'INVALID_QUANTITY',
  'QUANTITY_LIMIT_EXCEEDED',
  'TENANT_SPOOFING_REJECTED',
  'IDEMPOTENCY_CONFLICT',
]);
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

// ─── Module state ─────────────────────────────────────────────────────────────
let _db = null;           // IDBDatabase handle
let _syncLocked = false;  // in-process sync lock
let _syncTimer  = null;   // retry timer handle
let _onStatusChange = null; // external callback set by app.js

// ─── Status ───────────────────────────────────────────────────────────────────
// Valid states: 'online' | 'offline' | 'syncing' | 'synced' | 'failed'
let _currentStatus = 'online';
let _pendingCount  = 0;
let _failedCount   = 0;

function setStatus(status, pending, failed) {
  _currentStatus = status;
  if (pending !== undefined) _pendingCount = pending;
  if (failed  !== undefined) _failedCount  = failed;
  if (typeof _onStatusChange === 'function') {
    _onStatusChange({ status: _currentStatus, pending: _pendingCount, failed: _failedCount });
  }
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────
function openOutboxDB() {
  return new Promise((resolve, reject) => {
    if (_db) { resolve(_db); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by_status', 'status', { unique: false });
        store.createIndex('by_created', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = event => {
      _db = event.target.result;
      resolve(_db);
    };
    req.onerror = event => reject(event.target.error);
  });
}

function dbTransaction(mode, callback) {
  return openOutboxDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result;
    try {
      result = callback(store);
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result instanceof Promise ? result : result);
    tx.onerror   = event => reject(event.target.error);
    // If the callback returned a promise, resolve it but the transaction may
    // complete before it resolves — IDB is synchronous; we only need the
    // Promise for async wrappers that don't do extra IDB work.
    if (result instanceof Promise) result.then(resolve).catch(reject);
  }));
}

/** Add an operation to the outbox. Returns the stored entry. */
async function enqueue(type, payload) {
  const entry = {
    id:               crypto.randomUUID(),          // local operation ID
    idempotencyKey:   crypto.randomUUID(),          // stable key for server idempotency
    type,                                           // e.g. 'STOCK_RECEIPT'
    payload,                                        // operation-level data
    status:           'PENDING',
    attempts:         0,
    createdAt:        new Date().toISOString(),
    lastAttemptAt:    null,
    lastError:        null,
    syncedAt:         null,
  };
  await dbTransaction('readwrite', store => store.put(entry));
  await refreshCounts();
  return entry;
}

/** Fetch all PENDING entries ordered by createdAt. */
async function getPending() {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('by_created');
    const results = [];
    const req = idx.openCursor();
    req.onsuccess = event => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.status === 'PENDING' || cursor.value.status === 'SYNCING') {
          results.push(cursor.value);
        }
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = event => reject(event.target.error);
  });
}

/** Fetch all FAILED entries. */
async function getFailed() {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = [];
    const req = store.openCursor();
    req.onsuccess = event => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.status === 'FAILED') results.push(cursor.value);
        cursor.continue();
      } else { resolve(results); }
    };
    req.onerror = event => reject(event.target.error);
  });
}

/** Update a single outbox entry by id. */
async function updateEntry(id, patch) {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = event => {
      const entry = event.target.result;
      if (!entry) { resolve(null); return; }
      Object.assign(entry, patch);
      store.put(entry);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = event => reject(event.target.error);
  });
}

async function refreshCounts() {
  const pending = await getPending();
  const failed  = await getFailed();
  _pendingCount = pending.length;
  _failedCount  = failed.length;
}

// ─── Connectivity ─────────────────────────────────────────────────────────────
let _lastKnownOnline = navigator.onLine;

/** Lightweight server reachability check via /api/health. */
async function isServerReachable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(HEALTH_URL, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function checkConnectivity() {
  if (!navigator.onLine) {
    _lastKnownOnline = false;
    await refreshCounts();
    setStatus('offline', _pendingCount, _failedCount);
    return false;
  }
  const reachable = await isServerReachable();
  _lastKnownOnline = reachable;
  if (!reachable) {
    await refreshCounts();
    setStatus('offline', _pendingCount, _failedCount);
  }
  return reachable;
}

// ─── Sync engine ──────────────────────────────────────────────────────────────

/** Backoff delay in ms for attempt n (0-indexed). */
function backoffDelay(n) {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, n), MAX_BACKOFF_MS);
}

/** Determine whether a server error should be retried. */
function isTransientError(httpStatus, errorCode) {
  if (PERMANENT_HTTP_STATUSES.has(httpStatus)) return false;
  if (errorCode && PERMANENT_ERROR_CODES.has(errorCode)) return false;
  return true;
}

/** Process one outbox entry. Returns 'synced' | 'transient' | 'permanent'. */
async function processEntry(entry) {
  await updateEntry(entry.id, { status: 'SYNCING', lastAttemptAt: new Date().toISOString(), attempts: entry.attempts + 1 });

  let response, data;
  try {
    response = await fetch('/api/sync/stock-receipt', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        ...entry.payload,
        idempotencyKey: entry.idempotencyKey,
      }),
      cache: 'no-store',
    });
    data = await response.json();
  } catch (networkErr) {
    // Network failure — treat as transient
    await updateEntry(entry.id, {
      status:    'PENDING',
      lastError: `Network error: ${networkErr.message}`,
    });
    return 'transient';
  }

  if (response.ok || (response.status === 200)) {
    await updateEntry(entry.id, {
      status:    'SYNCED',
      syncedAt:  new Date().toISOString(),
      lastError: null,
    });
    return 'synced';
  }

  const errorCode = data && data.errorCode ? data.errorCode : null;
  const errorMsg  = data && data.error ? data.error : `HTTP ${response.status}`;
  const attempts  = entry.attempts + 1;

  if (!isTransientError(response.status, errorCode) || attempts >= MAX_ATTEMPTS) {
    await updateEntry(entry.id, {
      status:    'FAILED',
      lastError: errorMsg,
    });
    return 'permanent';
  }

  await updateEntry(entry.id, {
    status:    'PENDING',
    lastError: errorMsg,
  });
  return 'transient';
}

/** Process all pending entries. Called when connectivity is detected. */
async function syncOutbox() {
  if (_syncLocked) return;   // Prevent concurrent sync workers
  _syncLocked = true;

  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }

  try {
    const pending = await getPending();
    if (pending.length === 0) {
      await refreshCounts();
      const failed = await getFailed();
      if (failed.length > 0) {
        setStatus('failed', 0, failed.length);
      } else {
        setStatus('synced', 0, 0);
      }
      return;
    }

    await refreshCounts();
    setStatus('syncing', _pendingCount, _failedCount);

    let anyTransient = false;
    for (const entry of pending) {
      const outcome = await processEntry(entry);
      if (outcome === 'transient') anyTransient = true;
    }

    await refreshCounts();
    const failedEntries = await getFailed();

    if (_pendingCount === 0 && failedEntries.length === 0) {
      setStatus('synced', 0, 0);
    } else if (_pendingCount === 0) {
      setStatus('failed', 0, failedEntries.length);
    } else {
      // Still pending after a pass — schedule retry
      setStatus('failed', _pendingCount, failedEntries.length);
    }

    // If transient failures, schedule a retry after backoff
    if (anyTransient && _pendingCount > 0) {
      const allPending = await getPending();
      const minAttempts = allPending.reduce((m, e) => Math.min(m, e.attempts), Infinity);
      const delay = backoffDelay(minAttempts);
      _syncTimer = setTimeout(async () => {
        _syncLocked = false;
        if (await checkConnectivity()) await syncOutbox();
      }, delay);
    }
  } finally {
    if (!_syncTimer) _syncLocked = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Queue a STOCK_RECEIPT operation.
 *
 * payload: { medicineId, batchNumber, quantity }
 *
 * Returns:
 *   { queued: true, entry }   — offline, stored in outbox
 *   { queued: false, data }   — online, synced immediately
 */
async function queueStockReceipt(payload) {
  const online = await checkConnectivity();
  if (!online) {
    const entry = await enqueue('STOCK_RECEIPT', payload);
    await refreshCounts();
    setStatus('offline', _pendingCount, _failedCount);
    return { queued: true, entry };
  }

  // Online: attempt immediately, fall through to queue on network error
  const idempotencyKey = crypto.randomUUID();
  let response, data;
  try {
    response = await fetch('/api/sync/stock-receipt', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...payload, idempotencyKey }),
      cache:   'no-store',
    });
    data = await response.json();
  } catch (networkErr) {
    // Network dropped mid-submit — queue with same idempotency key
    const entry = await enqueue('STOCK_RECEIPT', payload);
    // Overwrite the idempotency key to match what we already sent
    await updateEntry(entry.id, { idempotencyKey });
    await refreshCounts();
    setStatus('offline', _pendingCount, _failedCount);
    return { queued: true, entry };
  }

  if (response.ok) {
    setStatus('synced', _pendingCount, _failedCount);
    return { queued: false, data };
  }

  // Permanent server error — do not queue silently, surface the error
  throw new Error(data && data.error ? data.error : `Server error ${response.status}`);
}

/** Return all outbox entries (for UI display or testing). */
async function getOutboxEntries() {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const results = [];
    const req = store.openCursor();
    req.onsuccess = event => {
      const cursor = event.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = event => reject(event.target.error);
  });
}

/** Clear all SYNCED entries from the outbox (maintenance/cleanup). */
async function clearSynced() {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const results = [];
    const req = store.openCursor();
    req.onsuccess = event => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.status === 'SYNCED') cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = event => reject(event.target.error);
  });
}

/**
 * Initialize the sync module.
 * Call this once at application startup (after login).
 *
 * @param {Function} onStatusChange  Callback invoked whenever status changes:
 *   ({ status, pending, failed }) => void
 */
async function initSync(onStatusChange) {
  _onStatusChange = onStatusChange || null;

  // Open the database eagerly so it's ready
  await openOutboxDB();
  await refreshCounts();

  // Initial connectivity probe
  const online = await checkConnectivity();
  if (online) {
    setStatus('online', _pendingCount, _failedCount);
    // Process any entries left from a previous session
    if (_pendingCount > 0) await syncOutbox();
  }

  // Browser online/offline events
  window.addEventListener('online', async () => {
    _lastKnownOnline = true;
    const reachable = await isServerReachable();
    if (reachable) {
      await refreshCounts();
      setStatus('online', _pendingCount, _failedCount);
      await syncOutbox();
    }
  });

  window.addEventListener('offline', async () => {
    _lastKnownOnline = false;
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    _syncLocked = false;
    await refreshCounts();
    setStatus('offline', _pendingCount, _failedCount);
  });
}

/** Force an immediate sync attempt (callable from UI). */
async function manualSync() {
  const online = await checkConnectivity();
  if (online) await syncOutbox();
}

/** Get the current sync status snapshot (for testing / UI). */
function getStatus() {
  return { status: _currentStatus, pending: _pendingCount, failed: _failedCount };
}

// ─── Exports (module pattern compatible with vanilla JS via window global) ────
window.MediSync = {
  init:              initSync,
  queueStockReceipt,
  getOutboxEntries,
  clearSynced,
  manualSync,
  getStatus,
  // Exposed for testing
  _openOutboxDB:     openOutboxDB,
  _enqueue:          enqueue,
  _getPending:       getPending,
  _getFailed:        getFailed,
  _updateEntry:      updateEntry,
  _refreshCounts:    refreshCounts,
  _isServerReachable: isServerReachable,
  _processEntry:     processEntry,
  _syncOutbox:       syncOutbox,
  _isTransientError: isTransientError,
};
