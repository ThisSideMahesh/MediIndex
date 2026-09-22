/**
 * Phase 7H: SQLite-backed durable outbox for stock-receipt operations.
 *
 * Provides transactional writes that survive app close, restart and device sleep,
 * plus a UNIQUE constraint on the idempotency key for duplicate protection.
 *
 * Key design principles:
 *  - SQLite, not AsyncStorage: transactional durability and UNIQUE constraints
 *  - The idempotency key is generated ONCE at enqueue and NEVER regenerated
 *  - A receipt is written as PENDING BEFORE any network call
 *  - On startup, rows stranded in SYNCING are reset to PENDING for retry
 *  - A local PENDING row is NOT authoritative inventory
 *  - No sensitive credentials (device tokens, passwords) are stored
 */

// `expo-sqlite` is imported lazily inside `openExpoSqliteDriver` below (not at module
// scope) so that this file can be loaded in a plain Node.js test process — where
// expo-sqlite's package entrypoint cannot resolve without the Expo/React Native
// native runtime — as long as a test supplies its own `driverFactory` and never
// calls the default one. Production app code always goes through the default
// factory, which does perform the real expo-sqlite import.
import { generateIdempotencyKey, isValidIdempotencyKey } from '../utils/idempotency';
import { logger } from '../utils/logger';
import type { OutboxStatus } from '../types/api';

/**
 * Minimal database driver surface that `SQLiteOutboxStore` depends on.
 *
 * This mirrors the exact subset of `expo-sqlite`'s `SQLiteDatabase` async API used
 * below (`execAsync`, `runAsync`, `getFirstAsync`, `getAllAsync`, `withTransactionAsync`).
 * It exists so tests can inject a REAL SQLite engine (Node's built-in `node:sqlite`,
 * file-backed) and exercise the actual store logic and actual SQL statements —
 * without substituting the repository itself with a mock/Map. Production code is
 * unaffected: `getDatabase()` below still opens a real `expo-sqlite` database by
 * default. Only tests supply an alternate driver via the constructor.
 */
export interface SQLiteDriver {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params?: any[]): Promise<{ lastInsertRowId: number; changes: number }>;
  getFirstAsync<T = any>(source: string, params?: any[]): Promise<T | null | undefined>;
  getAllAsync<T = any>(source: string, params?: any[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

/** Opens a driver instance for a given database file path. Defaults to real expo-sqlite. */
export type SQLiteDriverFactory = (databaseName: string) => Promise<SQLiteDriver>;

async function openExpoSqliteDriver(databaseName: string): Promise<SQLiteDriver> {
  // Lazy require: only touches expo-sqlite when this factory actually runs, i.e.
  // in the real app. Tests that inject their own driverFactory never reach this line.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SQLiteModule: any = require('expo-sqlite');
  const db = await SQLiteModule.openDatabaseAsync(databaseName);
  return db as SQLiteDriver;
}

export interface OutboxRecord {
  id: string;
  idempotencyKey: string;
  medicineId: number;
  batchNumber: string;
  quantity: number;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  syncedAt: string | null;
}

export interface OutboxCounts {
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
}

export interface OutboxStore {
  /** Creates the table if absent. Safe to call on every launch. */
  init(): Promise<void>;
  /** Inserts a PENDING receipt and returns it. Generates the idempotency key. */
  enqueue(input: { medicineId: number; batchNumber: string; quantity: number }): Promise<OutboxRecord>;
  /** Rows eligible for a sync attempt (PENDING and past nextAttemptAt). */
  listSyncable(limit: number): Promise<OutboxRecord[]>;
  listAll(): Promise<OutboxRecord[]>;
  getById(id: string): Promise<OutboxRecord | null>;
  getByIdempotencyKey(key: string): Promise<OutboxRecord | null>;
  update(id: string, patch: Partial<Omit<OutboxRecord, 'id' | 'idempotencyKey'>>): Promise<void>;
  counts(): Promise<OutboxCounts>;
  /** Startup recovery: SYNCING -> PENDING so orphaned rows are retried. */
  recoverStranded(): Promise<number>;
  /** Housekeeping: drop SYNCED rows older than the cutoff. */
  pruneSynced(olderThanIso: string): Promise<number>;
}

/**
 * Database schema version for migrations.
 * Increment when schema changes require data migration.
 */
const SCHEMA_VERSION = 1;

/**
 * SQLite database schema for the outbox table.
 * Includes constraints to ensure data integrity and prevent duplicates.
 */
const CREATE_OUTBOX_TABLE = `
  CREATE TABLE IF NOT EXISTS outbox (
    id               TEXT PRIMARY KEY,
    idempotency_key  TEXT NOT NULL UNIQUE,
    medicine_id      INTEGER NOT NULL,
    batch_number     TEXT NOT NULL,
    quantity         INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
    status           TEXT NOT NULL CHECK (status IN ('PENDING','SYNCING','SYNCED','FAILED')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    next_attempt_at  TEXT,
    created_at       TEXT NOT NULL,
    synced_at        TEXT
  );
`;

const CREATE_METADATA_TABLE = `
  CREATE TABLE IF NOT EXISTS outbox_metadata (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`;

/**
 * Generate a unique operation ID for outbox records.
 * Format: outbox-[timestamp]-[random] for sortable uniqueness.
 */
function generateOperationId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `outbox-${timestamp}-${random}`;
}

/**
 * Validate input for stock receipt operations.
 * Ensures data meets backend API requirements.
 */
function validateStockReceiptInput(input: { medicineId: number; batchNumber: string; quantity: number }): void {
  const { medicineId, batchNumber, quantity } = input;

  if (!Number.isInteger(medicineId) || medicineId <= 0) {
    throw new Error('Medicine ID must be a positive integer');
  }

  if (typeof batchNumber !== 'string' || batchNumber.trim().length === 0) {
    throw new Error('Batch number must be a non-empty string');
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Quantity must be a positive integer');
  }

  if (quantity > 100000) {
    throw new Error('Quantity exceeds maximum limit of 100,000 units');
  }
}

/**
 * Convert database row to OutboxRecord.
 */
function mapRowToRecord(row: any): OutboxRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    medicineId: row.medicine_id,
    batchNumber: row.batch_number,
    quantity: row.quantity,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    syncedAt: row.synced_at,
  };
}

/**
 * Validate state transitions to prevent invalid state changes.
 */
function validateStateTransition(fromStatus: OutboxStatus, toStatus: OutboxStatus): void {
  const validTransitions: Record<OutboxStatus, OutboxStatus[]> = {
    'PENDING': ['SYNCING', 'FAILED'], // Can start sync or fail validation
    'SYNCING': ['SYNCED', 'FAILED', 'PENDING'], // Can succeed, fail, or recover to pending
    'SYNCED': [], // Terminal state - no further transitions
    'FAILED': ['PENDING'], // Can be manually retried
  };

  if (!validTransitions[fromStatus].includes(toStatus)) {
    throw new Error(`Invalid state transition: ${fromStatus} -> ${toStatus}`);
  }
}

/**
 * SQLite-backed implementation of the outbox store.
 */
class SQLiteOutboxStore implements OutboxStore {
  private db: SQLiteDriver | null = null;

  private readonly databaseName: string;
  private readonly driverFactory: SQLiteDriverFactory;

  /**
   * @param databaseName Database file name. Defaults to the production file.
   *   Tests pass a distinct temporary path so they never touch the real app database.
   * @param driverFactory How to open that database file. Defaults to real `expo-sqlite`.
   *   Tests inject a real, file-backed `node:sqlite` driver — never a Map or mock —
   *   so this exact class and its exact SQL run against a genuine SQLite engine.
   */
  constructor(
    databaseName: string = 'mediindex-outbox.db',
    driverFactory: SQLiteDriverFactory = openExpoSqliteDriver,
  ) {
    this.databaseName = databaseName;
    this.driverFactory = driverFactory;
  }

  private async getDatabase(): Promise<SQLiteDriver> {
    if (!this.db) {
      this.db = await this.driverFactory(this.databaseName);
    }
    return this.db;
  }

  /** Releases the underlying connection. Tests use this to prove reopen-after-close durability. */
  async close(): Promise<void> {
    if (this.db && 'closeAsync' in this.db && typeof (this.db as any).closeAsync === 'function') {
      await (this.db as any).closeAsync();
    }
    this.db = null;
  }

  async init(): Promise<void> {
    logger.debug('outbox', 'Initializing SQLite outbox database');
    
    const db = await this.getDatabase();

    await db.withTransactionAsync(async () => {
      // Create tables
      await db.execAsync(CREATE_OUTBOX_TABLE);
      await db.execAsync(CREATE_METADATA_TABLE);

      // Check/set schema version
      const versionRow = await db.getFirstAsync<{ value: string }>(`
        SELECT value FROM outbox_metadata WHERE key = 'schema_version'
      `);

      const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

      if (currentVersion === 0) {
        // First initialization
        await db.runAsync(`
          INSERT OR REPLACE INTO outbox_metadata (key, value) VALUES ('schema_version', ?)
        `, [SCHEMA_VERSION.toString()]);
        logger.debug('outbox', 'Database initialized with schema version', { version: SCHEMA_VERSION });
      } else if (currentVersion !== SCHEMA_VERSION) {
        // Future: handle schema migrations here
        logger.warn('outbox', 'Schema version mismatch', { current: currentVersion, expected: SCHEMA_VERSION });
      }
    });

    // Recovery: reset stranded SYNCING records to PENDING
    const recoveredCount = await this.recoverStranded();
    if (recoveredCount > 0) {
      logger.debug('outbox', 'Recovered stranded SYNCING records', { count: recoveredCount });
    }

    logger.debug('outbox', 'SQLite outbox database initialized successfully');
  }

  async enqueue(input: { medicineId: number; batchNumber: string; quantity: number }): Promise<OutboxRecord> {
    validateStockReceiptInput(input);

    const { medicineId, batchNumber, quantity } = input;
    const id = generateOperationId();
    const idempotencyKey = generateIdempotencyKey();
    const now = new Date().toISOString();

    logger.debug('outbox', 'Enqueuing stock receipt operation', {
      id,
      medicineId,
      batchNumber,
      quantity,
      hasIdempotencyKey: !!idempotencyKey,
    });

    const db = await this.getDatabase();

    try {
      await db.withTransactionAsync(async () => {
        // Check for existing record with same idempotency key
        const existing = await db.getFirstAsync<{ id: string; medicine_id: number; batch_number: string; quantity: number }>(`
          SELECT id, medicine_id, batch_number, quantity
          FROM outbox 
          WHERE idempotency_key = ?
        `, [idempotencyKey]);

        if (existing) {
          // Check if payload matches (same operation)
          if (existing.medicine_id === medicineId && 
              existing.batch_number === batchNumber && 
              existing.quantity === quantity) {
            // Same operation - will return existing record after transaction
            return;
          } else {
            // Same key, different payload - conflict
            throw new Error(`Idempotency key conflict: key '${idempotencyKey}' already used with different payload`);
          }
        }

        // Insert new record
        await db.runAsync(`
          INSERT INTO outbox (
            id, idempotency_key, medicine_id, batch_number, quantity,
            status, attempts, created_at
          ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?)
        `, [id, idempotencyKey, medicineId, batchNumber, quantity, now]);
      });

      // Check if we need to return existing record
      const existingByKey = await this.getByIdempotencyKey(idempotencyKey);
      if (existingByKey && existingByKey.id !== id) {
        // Found existing record with same key - return it
        logger.debug('outbox', 'Idempotent enqueue - returning existing record', { existingId: existingByKey.id });
        return existingByKey;
      }

      const record = await this.getById(id);
      if (!record) {
        throw new Error('Failed to retrieve enqueued record');
      }

      logger.debug('outbox', 'Stock receipt operation enqueued successfully', {
        id: record.id,
        status: record.status,
      });

      return record;

    } catch (error) {
      logger.error('outbox', 'Failed to enqueue stock receipt operation', {
        error: error instanceof Error ? error.message : String(error),
        medicineId,
        batchNumber,
        quantity,
      });
      throw error;
    }
  }

  async listSyncable(limit: number): Promise<OutboxRecord[]> {
    const db = await this.getDatabase();
    const now = new Date().toISOString();

    const rows = await db.getAllAsync<any>(`
      SELECT * FROM outbox 
      WHERE status = 'PENDING' 
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `, [now, limit]);

    return rows.map(mapRowToRecord);
  }

  async listAll(): Promise<OutboxRecord[]> {
    const db = await this.getDatabase();
    
    const rows = await db.getAllAsync<any>(`
      SELECT * FROM outbox 
      ORDER BY created_at DESC
    `);

    return rows.map(mapRowToRecord);
  }

  async getById(id: string): Promise<OutboxRecord | null> {
    const db = await this.getDatabase();
    
    const row = await db.getFirstAsync<any>(`
      SELECT * FROM outbox WHERE id = ?
    `, [id]);

    return row ? mapRowToRecord(row) : null;
  }

  async getByIdempotencyKey(key: string): Promise<OutboxRecord | null> {
    const db = await this.getDatabase();
    
    const row = await db.getFirstAsync<any>(`
      SELECT * FROM outbox WHERE idempotency_key = ?
    `, [key]);

    return row ? mapRowToRecord(row) : null;
  }

  async update(id: string, patch: Partial<Omit<OutboxRecord, 'id' | 'idempotencyKey'>>): Promise<void> {
    const db = await this.getDatabase();

    // Get current record for validation
    const current = await this.getById(id);
    if (!current) {
      throw new Error(`Record with id '${id}' not found`);
    }

    // Validate state transition if status is being updated
    if (patch.status && patch.status !== current.status) {
      validateStateTransition(current.status, patch.status);
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (patch.status !== undefined) {
      updates.push('status = ?');
      values.push(patch.status);
    }
    if (patch.attempts !== undefined) {
      updates.push('attempts = ?');
      values.push(patch.attempts);
    }
    if (patch.lastError !== undefined) {
      updates.push('last_error = ?');
      values.push(patch.lastError);
    }
    if (patch.nextAttemptAt !== undefined) {
      updates.push('next_attempt_at = ?');
      values.push(patch.nextAttemptAt);
    }
    if (patch.syncedAt !== undefined) {
      updates.push('synced_at = ?');
      values.push(patch.syncedAt);
    }

    if (updates.length === 0) {
      return; // No changes
    }

    values.push(id); // For WHERE clause

    await db.runAsync(`
      UPDATE outbox SET ${updates.join(', ')} WHERE id = ?
    `, values);

    logger.debug('outbox', 'Record updated', {
      id,
      updates: Object.keys(patch),
      newStatus: patch.status,
    });
  }

  async counts(): Promise<OutboxCounts> {
    const db = await this.getDatabase();
    
    const rows = await db.getAllAsync<{ status: string; count: number }>(`
      SELECT status, COUNT(*) as count
      FROM outbox 
      GROUP BY status
    `);

    const counts: OutboxCounts = {
      pending: 0,
      syncing: 0,
      synced: 0,
      failed: 0,
    };

    for (const row of rows) {
      const status = row.status.toLowerCase() as keyof OutboxCounts;
      if (status in counts) {
        counts[status] = row.count;
      }
    }

    return counts;
  }

  async recoverStranded(): Promise<number> {
    const db = await this.getDatabase();
    
    const result = await db.runAsync(`
      UPDATE outbox 
      SET status = 'PENDING', last_error = 'Recovered from stranded SYNCING state' 
      WHERE status = 'SYNCING'
    `);

    return result.changes;
  }

  async pruneSynced(olderThanIso: string): Promise<number> {
    const db = await this.getDatabase();
    
    const result = await db.runAsync(`
      DELETE FROM outbox 
      WHERE status = 'SYNCED' AND synced_at < ?
    `, [olderThanIso]);

    return result.changes;
  }
}

// Export the class so tests can instantiate it directly against an injected driver
// and a distinct database file, while production uses the singleton below unchanged.
export { SQLiteOutboxStore };

// Export singleton instance — production default, backed by real expo-sqlite.
export const outbox: OutboxStore = new SQLiteOutboxStore();

/** True once Phase 7H lands. */
export const OUTBOX_IMPLEMENTED = true;
