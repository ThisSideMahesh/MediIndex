/**
 * Phase 7I: Automatic synchronization of the Phase 7H SQLite outbox.
 *
 * Responsibilities:
 *   - Coalesce concurrent triggers (startup, foreground, NetInfo online, manual
 *     "Sync Now") into a single active worker via an in-process lock.
 *   - Load PENDING/retryable rows from the outbox (oldest first, bounded batch).
 *   - Mark PENDING -> SYNCING BEFORE the network call (so a crash mid-request
 *     leaves a recoverable SYNCING row, per Phase 7H's recoverStranded()).
 *   - Submit to the EXISTING POST /api/mobile/stock-entry endpoint, reusing the
 *     row's persisted idempotencyKey — NEVER generating a new one.
 *   - Classify the result via `isTransient()` (Phase 7B/7G's error module):
 *       success or idempotent replay -> SYNCED
 *       transient (network/timeout/5xx) -> PENDING with capped backoff + jitter
 *       permanent (4xx validation/auth/conflict) -> FAILED
 *   - Never mark SYNCED without an authoritative server response.
 *
 * Non-goals, per Phase 7I scope: no OS background-fetch, no push notifications,
 * no polling loop, no second mutation endpoint, no server-side sync engine.
 */

import { outbox as defaultOutbox, type OutboxCounts, type OutboxRecord, type OutboxStore } from '../storage/outbox';
import { submitStockReceipt as defaultSubmitStockReceipt } from '../api/stockEntry';
import type { StockReceiptRequest, StockReceiptResponse } from '../types/stockReceipt';
import type { ConnectivityState } from '../utils/connectivity';

interface ConnectivityModule {
  isOnline(): Promise<boolean>;
  subscribeToConnectivity(callback: (state: ConnectivityState) => void): () => void;
}

/** Lazily loads the real connectivity module. See comment on ConnectivityPort below. */
async function loadRealConnectivity(): Promise<ConnectivityModule> {
  return import('../utils/connectivity');
}

import { ApiError, isTransient, isAuthenticationFailure } from '../api/errors';
import { logger, sanitizeErrorText } from '../utils/logger';

/** Prefix stored in `lastError` so the UI/tests can recognize an authentication
 *  failure without re-classifying the (no longer available) original error.
 *  Phase 7J requirement 6/11: distinct messaging and recovery path from an
 *  ordinary permanent validation failure. */
export const AUTH_FAILURE_ERROR_PREFIX = 'AUTH_REQUIRED: ';

/**
 * Connectivity dependency the engine needs, kept to the two operations it
 * actually calls. Injectable (constructor parameter, defaulting to the real
 * `utils/connectivity` module) for the same reason `SQLiteOutboxStore`'s
 * database driver is injectable (see Phase 7H `storage/outbox.ts`): the real
 * `@react-native-community/netinfo` package transitively imports `react-native`,
 * whose entrypoint uses Flow syntax that cannot be parsed outside Metro/Babel —
 * including under Node's native TypeScript type-stripping used by the real
 * SQLite/sync integration tests. Production code is unaffected: the app-wide
 * `syncEngine` singleton below always uses the real implementations.
 */
export interface ConnectivityPort {
  isOnline(): Promise<boolean>;
  subscribeToConnectivity(callback: (state: { isConnected: boolean }) => void): () => void;
}

/**
 * Default, production `ConnectivityPort`. Every access to the real
 * `utils/connectivity` module (and therefore to `@react-native-community/netinfo`,
 * which transitively imports `react-native`) happens INSIDE these functions, not
 * at module scope — so merely importing `sync/syncEngine.ts` never touches
 * react-native. Only calling `.isOnline()` or `.subscribeToConnectivity()` does,
 * and tests that inject their own `ConnectivityPort` never call these at all.
 */
const defaultConnectivity: ConnectivityPort = {
  async isOnline() {
    const { isOnline } = await loadRealConnectivity();
    return isOnline();
  },
  subscribeToConnectivity(callback) {
    let unsubscribeReal: (() => void) | null = null;
    let unsubscribedEarly = false;

    void loadRealConnectivity().then(({ subscribeToConnectivity }) => {
      const fn = subscribeToConnectivity(callback as (state: ConnectivityState) => void);
      if (unsubscribedEarly) fn();
      else unsubscribeReal = fn;
    });

    return () => {
      if (unsubscribeReal) unsubscribeReal();
      else unsubscribedEarly = true;
    };
  },
};

/** Max automatic attempts before a receipt is marked FAILED. Mirrors sync.js. */
export const MAX_ATTEMPTS = 5;
/** First retry gap; doubles per attempt up to MAX_BACKOFF_MS. Mirrors sync.js. */
export const BASE_BACKOFF_MS = 2000;
/** Upper bound on the retry gap. Mirrors sync.js. */
export const MAX_BACKOFF_MS = 60000;
/** Timeout for the /api/health connectivity probe. Mirrors sync.js. */
export const HEALTH_TIMEOUT_MS = 5000;
/** Bounded batch size per sync cycle — do not overwhelm the backend or starve the app. */
export const SYNC_BATCH_SIZE = 10;

export type SyncState = 'IDLE' | 'OFFLINE' | 'SYNCING' | 'ERROR';

export interface SyncStatus {
  state: SyncState;
  counts: OutboxCounts;
  lastSyncAt: string | null;
  lastError: string | null;
}

/**
 * Capped exponential backoff for attempt N (1-based), with jitter to avoid many
 * devices retrying in lockstep. Pure aside from the jitter RNG, so the
 * deterministic part is independently testable.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const raw = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(raw, MAX_BACKOFF_MS);
  // +/-20% jitter, still bounded by MAX_BACKOFF_MS on the high side.
  const jitterFactor = 0.8 + random() * 0.4;
  return Math.min(Math.round(capped * jitterFactor), MAX_BACKOFF_MS);
}

export interface SyncEngine {
  /** Begins listening for connectivity/foreground changes. Idempotent. */
  start(): Promise<void>;
  stop(): void;
  /** Runs one coalesced sync pass. Concurrent calls share the same in-flight run. */
  syncNow(): Promise<SyncStatus>;
  /** Resets a FAILED receipt to PENDING (same key, same payload) and syncs if online. */
  retry(recordId: string): Promise<void>;
  getStatus(): SyncStatus;
  subscribe(listener: (status: SyncStatus) => void): () => void;
}

const EMPTY_COUNTS: OutboxCounts = { pending: 0, syncing: 0, synced: 0, failed: 0 };

class AutoSyncEngine implements SyncEngine {
  private status: SyncStatus = {
    state: 'IDLE',
    counts: EMPTY_COUNTS,
    lastSyncAt: null,
    lastError: null,
  };

  private listeners = new Set<(status: SyncStatus) => void>();

  /** The single in-flight sync promise. Concurrent triggers await this same promise
   *  instead of starting a second worker — this IS the mutex (requirement #5). */
  private inFlight: Promise<SyncStatus> | null = null;

  private unsubscribeNetInfo: (() => void) | null = null;
  private unsubscribeAppState: (() => void) | null = null;
  private started = false;

  private readonly connectivity: ConnectivityPort;
  private readonly outboxStore: OutboxStore;
  private readonly submit: (request: StockReceiptRequest) => Promise<StockReceiptResponse>;

  /**
   * @param connectivity Defaults to the real NetInfo-backed implementation.
   * @param outboxStore Defaults to the production outbox singleton (real expo-sqlite,
   *   'mediindex-outbox.db'). Tests inject a distinct real-SQLite-backed instance
   *   (see Phase 7H's SQLiteOutboxStore with an injected driver) so they exercise
   *   genuine outbox state transitions without touching the app's database.
   * @param submit Defaults to the real `submitStockReceipt`, which calls the
   *   shared `apiClient` and therefore the real device-token header injection.
   *   Tests may substitute this directly, or — more commonly — leave it as the
   *   real function and instead monkey-patch `apiClient.post` to simulate the
   *   backend's HTTP responses, which exercises the real request-construction
   *   code in `api/stockEntry.ts` as well.
   */
  constructor(
    connectivity: ConnectivityPort = defaultConnectivity,
    outboxStore: OutboxStore = defaultOutbox,
    submit: (request: StockReceiptRequest) => Promise<StockReceiptResponse> = defaultSubmitStockReceipt,
  ) {
    this.connectivity = connectivity;
    this.outboxStore = outboxStore;
    this.submit = submit;
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.status);
      } catch (err) {
        logger.warn('sync', 'Sync status listener threw', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return; // Idempotent: starting twice must not double-subscribe.
    this.started = true;

    // Trigger C: NetInfo offline -> online transition.
    let wasOnline: boolean | null = null;
    this.unsubscribeNetInfo = this.connectivity.subscribeToConnectivity((state) => {
      const isNowOnline = state.isConnected;
      if (wasOnline === false && isNowOnline === true) {
        logger.debug('sync', 'Network restored; triggering sync');
        void this.syncNow();
      }
      wasOnline = isNowOnline;
    });

    // Trigger B: app returns to foreground.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AppState } = require('react-native');
      const subscription = AppState.addEventListener('change', (nextState: string) => {
        if (nextState === 'active') {
          logger.debug('sync', 'App foregrounded; checking connectivity for sync');
          void this.syncNow();
        }
      });
      this.unsubscribeAppState = () => subscription.remove();
    } catch {
      // Non-React-Native environment (Node test process). Foreground trigger
      // is simply unavailable there; NetInfo/manual/startup triggers still work.
    }

    // Trigger A: app startup — one immediate coalesced attempt.
    void this.syncNow();
  }

  stop(): void {
    this.unsubscribeNetInfo?.();
    this.unsubscribeNetInfo = null;
    this.unsubscribeAppState?.();
    this.unsubscribeAppState = null;
    this.started = false;
  }

  /**
   * Trigger D (manual) and the shared entry point for all other triggers.
   * Requirement #5: multiple simultaneous calls must coalesce into ONE worker.
   * Achieved by returning the existing in-flight promise instead of starting a
   * second run whenever one is already active.
   */
  async syncNow(): Promise<SyncStatus> {
    if (this.inFlight) {
      logger.debug('sync', 'Sync already in progress; coalescing into existing run');
      return this.inFlight;
    }

    this.inFlight = this.runSyncPass().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  async retry(recordId: string): Promise<void> {
    const record = await this.outboxStore.getById(recordId);
    if (!record) {
      throw new Error(`Cannot retry: record '${recordId}' not found`);
    }
    if (record.status !== 'FAILED') {
      throw new Error(`Cannot retry: record '${recordId}' is ${record.status}, not FAILED`);
    }

    // FAILED -> PENDING. Same key, same payload — update() only ever touches
    // status/attempts/lastError/nextAttemptAt/syncedAt, never the key or payload
    // columns, so this cannot mutate medicineId/batchNumber/quantity/idempotencyKey.
    await this.outboxStore.update(recordId, { status: 'PENDING', nextAttemptAt: null });
    logger.debug('sync', 'Manual retry: reset FAILED -> PENDING', { id: recordId, idempotencyKey: record.idempotencyKey });

    await this.syncNow();
  }

  private async runSyncPass(): Promise<SyncStatus> {
    const online = await this.connectivity.isOnline();
    if (!online) {
      logger.debug('sync', 'Sync skipped: offline');
      const counts = await this.outboxStore.counts();
      this.setStatus({ state: 'OFFLINE', counts });
      return this.status;
    }

    this.setStatus({ state: 'SYNCING' });

    let lastError: string | null = null;

    try {
      const batch = await this.outboxStore.listSyncable(SYNC_BATCH_SIZE);
      logger.debug('sync', 'Starting sync pass', { batchSize: batch.length });

      for (const record of batch) {
        // Re-check connectivity before each item: if it disappears mid-pass,
        // stop safely rather than let every remaining item fail as a network error.
        if (!(await this.connectivity.isOnline())) {
          logger.debug('sync', 'Connectivity lost mid-sync; stopping pass safely');
          break;
        }
        await this.processOne(record);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error('sync', 'Sync pass failed unexpectedly', { error: lastError });
    }

    const counts = await this.outboxStore.counts();
    this.setStatus({
      state: counts.pending > 0 || counts.syncing > 0 ? 'IDLE' : 'IDLE',
      counts,
      lastSyncAt: new Date().toISOString(),
      lastError,
    });

    return this.status;
  }

  /**
   * Processes exactly one outbox record: PENDING -> SYNCING -> (SYNCED | PENDING | FAILED).
   * One record's failure is caught locally so it cannot abort the batch loop and
   * block unrelated valid operations (requirement #33).
   */
  private async processOne(record: OutboxRecord): Promise<void> {
    try {
      await this.outboxStore.update(record.id, { status: 'SYNCING' });
    } catch (err) {
      // Another path already moved this row out of PENDING (e.g. a manual
      // retry raced this pass) — skip it rather than crash the batch.
      logger.warn('sync', 'Could not transition record to SYNCING; skipping this pass', {
        id: record.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      // CRITICAL: read the key from storage, never regenerate it.
      const idempotencyKey = record.idempotencyKey;

      const result = await this.submit({
        medicineId: record.medicineId,
        batchNumber: record.batchNumber,
        quantity: record.quantity,
        idempotencyKey,
      });

      // Authoritative server confirmation (fresh success OR idempotent replay)
      // is the ONLY thing that may mark SYNCED. SQLite's own quantity/state is
      // never treated as authoritative.
      logger.debug('sync', 'Server confirmed stock receipt', {
        id: record.id,
        idempotencyKey,
        idempotent: result.idempotent === true,
        movementId: result.movementId,
      });

      await this.outboxStore.update(record.id, {
        status: 'SYNCED',
        syncedAt: new Date().toISOString(),
      });

    } catch (err) {
      await this.handleSyncFailure(record, err);
    }
  }

  private async handleSyncFailure(record: OutboxRecord, err: unknown): Promise<void> {
    const rawMessage = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : String(err));
    const message = sanitizeErrorText(rawMessage);
    const nextAttempts = record.attempts + 1;

    // Authentication failures are their own category (Phase 7J requirement 2B
    // / 6): the credential is the problem, not the payload, and not something
    // that resolves by waiting and retrying with backoff. The operation is
    // preserved (never deleted), the idempotency key is untouched, and the
    // stored error is tagged so the UI can show "needs re-pairing" rather than
    // a generic failure. It becomes FAILED (not left retrying automatically)
    // because retrying with the same rejected/revoked credential cannot
    // succeed — but it is NOT counted against MAX_ATTEMPTS exhaustion, and a
    // manual retry (typically right after re-pairing) is exactly the intended
    // recovery path, same as any other FAILED row.
    if (isAuthenticationFailure(err)) {
      logger.error('sync', 'Authentication failure — device credential rejected; not retrying automatically', {
        id: record.id,
        idempotencyKey: record.idempotencyKey,
        // Never logged: the token itself. Only the fact that auth failed.
      });

      await this.outboxStore.update(record.id, {
        status: 'FAILED',
        attempts: nextAttempts,
        lastError: `${AUTH_FAILURE_ERROR_PREFIX}${message}`,
      });
      return;
    }

    const transient = isTransient(err);

    if (transient && nextAttempts < MAX_ATTEMPTS) {
      // SYNCING -> PENDING: stays retryable, same key, bounded backoff with jitter.
      const delayMs = backoffMs(nextAttempts);
      const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();

      logger.warn('sync', 'Transient sync failure; will retry with same idempotency key', {
        id: record.id,
        idempotencyKey: record.idempotencyKey,
        attempt: nextAttempts,
        delayMs,
        error: message,
      });

      await this.outboxStore.update(record.id, {
        status: 'PENDING',
        attempts: nextAttempts,
        lastError: message,
        nextAttemptAt,
      });
      return;
    }

    // Either a permanent classification, or transient but attempts exhausted.
    // Either way: SYNCING -> FAILED. Never SYNCED. Never silently dropped.
    logger.error('sync', 'Sync failure marked FAILED', {
      id: record.id,
      idempotencyKey: record.idempotencyKey,
      attempts: nextAttempts,
      transient,
      exhausted: transient && nextAttempts >= MAX_ATTEMPTS,
      error: message,
    });

    await this.outboxStore.update(record.id, {
      status: 'FAILED',
      attempts: nextAttempts,
      lastError: message,
    });
  }
}

/** True when a FAILED record's stored error indicates the device needs re-pairing. */
export function isAuthFailureRecord(record: Pick<OutboxRecord, 'status' | 'lastError'>): boolean {
  return record.status === 'FAILED' && !!record.lastError && record.lastError.startsWith(AUTH_FAILURE_ERROR_PREFIX);
}

/** Strips the internal AUTH_REQUIRED prefix for display. */
export function stripAuthFailurePrefix(lastError: string): string {
  return lastError.startsWith(AUTH_FAILURE_ERROR_PREFIX) ? lastError.slice(AUTH_FAILURE_ERROR_PREFIX.length) : lastError;
}

export const syncEngine: SyncEngine = new AutoSyncEngine();

// Exported for tests that need a fresh, isolated engine instance rather than the
// app-wide singleton above (e.g. to avoid cross-test listener/lock leakage, or to
// inject a fake ConnectivityPort / a distinct outbox instance).
export { AutoSyncEngine };

/** True once Phase 7I lands. */
export const SYNC_ENGINE_IMPLEMENTED = true;
