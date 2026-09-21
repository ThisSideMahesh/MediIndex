const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sanitizeConnectionString(connString) {
  if (!connString || typeof connString !== 'string') return '';
  try {
    const url = new URL(connString);
    if (url.password) {
      url.password = '*****';
    }
    return url.toString();
  } catch {
    // If URL parsing fails, mask any user:pass@ occurrence
    return connString.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:*****@');
  }
}

// ─── Schema-initialization advisory lock ──────────────────────────────────────
// Deterministic 64-bit advisory-lock key dedicated to MediIndex schema
// initialization. Derived from a namespaced constant string so it is stable
// across processes and deploys, and so it cannot collide with advisory locks
// taken by unrelated application logic (which would use different namespaces).
//   SCHEMA_LOCK_ID = signed int64 from the first 8 bytes of
//                    SHA-256('mediindex:schema:init:v1')
// Exported for observability (it can be matched against pg_locks.objid).
const SCHEMA_LOCK_NAMESPACE = 'mediindex:schema:init:v1';
const SCHEMA_LOCK_ID = crypto
  .createHash('sha256')
  .update(SCHEMA_LOCK_NAMESPACE)
  .digest()
  .readBigInt64BE(0)
  .toString(); // pass as string so the pg driver binds it as bigint without precision loss

// Bounded wait for the advisory lock. Advisory locks ignore lock_timeout, so a
// blocking pg_advisory_lock() could hang until the serverless function timeout.
const SCHEMA_LOCK_WAIT_MS = Number(process.env.MEDIINDEX_SCHEMA_LOCK_WAIT_MS || 15000);
const SCHEMA_LOCK_POLL_MS = 100;

// PostgreSQL codes emitted when concurrent DDL loses a creation race.
// 23505 = unique_violation on pg_type/pg_class catalog indexes
// 42P07 = duplicate_table / relation already exists
const BENIGN_DDL_RACE_CODES = new Set(['23505', '42P07']);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Derives the set of objects schema.pg.sql is expected to create, straight from
 * the SQL text. Parsing the file rather than hardcoding a list means the
 * verification automatically covers future additions and cannot drift.
 */
function parseExpectedSchemaObjects(schemaSql) {
  const tables = [...schemaSql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/gi)]
    .map(m => m[1].toLowerCase());
  const columns = [...schemaSql.matchAll(/ALTER\s+TABLE\s+([A-Za-z0-9_]+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/gi)]
    .map(m => ({ table: m[1].toLowerCase(), column: m[2].toLowerCase() }));
  const indexes = [...schemaSql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/gi)]
    .map(m => m[1].toLowerCase());
  return {
    tables: [...new Set(tables)],
    columns,
    indexes: [...new Set(indexes)]
  };
}

/** Returns true only when every expected table, column and index exists. */
async function verifySchemaObjects(client, expected) {
  return (await describeMissingSchemaObjects(client, expected)) === '';
}

/** Returns a human-readable description of missing objects ('' when complete). */
async function describeMissingSchemaObjects(client, expected) {
  const missing = [];

  if (expected.tables.length > 0) {
    const res = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])",
      [expected.tables]
    );
    const present = new Set(res.rows.map(r => r.table_name.toLowerCase()));
    for (const t of expected.tables) if (!present.has(t)) missing.push(`table ${t}`);
  }

  for (const { table, column } of expected.columns) {
    const res = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2",
      [table, column]
    );
    if (res.rowCount === 0) missing.push(`column ${table}.${column}`);
  }

  if (expected.indexes.length > 0) {
    const res = await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ANY($1::text[])",
      [expected.indexes]
    );
    const present = new Set(res.rows.map(r => r.indexname.toLowerCase()));
    for (const i of expected.indexes) if (!present.has(i)) missing.push(`index ${i}`);
  }

  return missing.join(', ');
}

function convertPlaceholders(sql) {
  if (typeof sql !== 'string') return sql;

  let paramIndex = 1;
  let result = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const char = sql[i];
    const nextChar = i + 1 < len ? sql[i + 1] : '';

    // Line comment: -- until newline
    if (char === '-' && nextChar === '-') {
      result += '--';
      i += 2;
      while (i < len && sql[i] !== '\n') {
        result += sql[i];
        i++;
      }
      continue;
    }

    // Block comment: /* until */
    if (char === '/' && nextChar === '*') {
      result += '/*';
      i += 2;
      while (i < len) {
        if (sql[i] === '*' && i + 1 < len && sql[i + 1] === '/') {
          result += '*/';
          i += 2;
          break;
        }
        result += sql[i];
        i++;
      }
      continue;
    }

    // Single-quoted string literal: '...' (handles '' and \')
    if (char === "'") {
      result += "'";
      i++;
      while (i < len) {
        const c = sql[i];
        if (c === "'") {
          result += "'";
          i++;
          if (i < len && sql[i] === "'") {
            result += "'";
            i++;
            continue;
          }
          break;
        } else if (c === '\\' && i + 1 < len) {
          result += c + sql[i + 1];
          i += 2;
        } else {
          result += c;
          i++;
        }
      }
      continue;
    }

    // Double-quoted identifier: "..."
    if (char === '"') {
      result += '"';
      i++;
      while (i < len) {
        const c = sql[i];
        if (c === '"') {
          result += '"';
          i++;
          if (i < len && sql[i] === '"') {
            result += '"';
            i++;
            continue;
          }
          break;
        } else if (c === '\\' && i + 1 < len) {
          result += c + sql[i + 1];
          i += 2;
        } else {
          result += c;
          i++;
        }
      }
      continue;
    }

    // Unquoted, uncommented positional placeholder '?'
    if (char === '?') {
      result += `$${paramIndex++}`;
      i++;
    } else {
      result += char;
      i++;
    }
  }

  return result;
}

class PostgreSQLAdapter {
  constructor(options = {}) {
    this.type = 'postgres';
    this.connectionString = options.connectionString || process.env.DATABASE_URL || '';
    this.poolConfig = options.poolConfig || {};
    this.pg = options.pg || null;
    this.pool = options.pool || null;
    this.isInitialized = false;
  }

  validateConfig() {
    if (!this.connectionString || typeof this.connectionString !== 'string' || !this.connectionString.trim()) {
      throw new Error('PostgreSQL configuration error: DATABASE_URL is not configured.');
    }
    const trimmed = this.connectionString.trim();
    if (!trimmed.startsWith('postgres://') && !trimmed.startsWith('postgresql://')) {
      throw new Error('PostgreSQL configuration error: Invalid connection protocol. Expected postgres:// or postgresql://.');
    }
    return true;
  }

  getSanitizedUrl() {
    return sanitizeConnectionString(this.connectionString);
  }

  getPool() {
    if (this.pool) return this.pool;

    this.validateConfig();
    const pg = this.pg || require('pg');
    const { Pool } = pg;

    const config = {
      connectionString: this.connectionString,
      max: this.poolConfig.max || 10,
      idleTimeoutMillis: this.poolConfig.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: this.poolConfig.connectionTimeoutMillis || 5000,
      ...this.poolConfig
    };

    this.pool = new Pool(config);
    return this.pool;
  }

  initialize() {
    this.getPool();
    this.isInitialized = true;
    return this;
  }

  /**
   * Applies db/schema.pg.sql once per process, idempotently and safely under
   * concurrent cold starts.
   *
   * Unlike SQLiteAdapter.initialize() — which calls applySchema() +
   * applyMigrations() on every startup — the PostgreSQL path previously only
   * opened a connection pool and never applied schema at runtime. Schema was
   * applied only by scripts/bootstrap-postgres.js (a manual one-off) or by the
   * integration tests. Any DDL appended to schema.pg.sql after the last manual
   * bootstrap therefore never reached the deployed database, causing
   * "relation ... does not exist" (SQLSTATE 42P01) at runtime.
   *
   * schema.pg.sql is fully idempotent (CREATE TABLE IF NOT EXISTS,
   * ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS). However, those forms
   * are NOT race-free in PostgreSQL: two sessions that simultaneously observe an
   * object as absent can both attempt creation, and the loser fails with
   * 23505 (unique violation on pg_type/pg_class) or 42P07 (relation exists).
   * Schema application is therefore serialized with a dedicated PostgreSQL
   * advisory lock, and completion is always confirmed by verifying the objects
   * actually exist before resolving.
   *
   * Memoized so it runs at most once per process; on failure the memo is
   * cleared so a later request can retry rather than the process staying
   * permanently broken.
   */
  async ensureSchema() {
    if (this._schemaReady) return this._schemaReady;
    this._schemaReady = this._applySchemaWithAdvisoryLock().catch(err => {
      this._schemaReady = null; // allow retry on the next request
      throw err;
    });
    return this._schemaReady;
  }

  /**
   * Serializes schema application across processes with a PostgreSQL advisory lock.
   *
   * pg_advisory_lock is SESSION-scoped, so the lock, the DDL and the unlock must
   * all run on the SAME dedicated connection — pool.query() would pick arbitrary
   * connections and the lock would not protect the DDL.
   *
   * pg_try_advisory_lock (non-blocking) is used in a bounded wait loop rather
   * than the blocking pg_advisory_lock, because advisory locks ignore
   * lock_timeout and a blocking acquire could hang a serverless request until
   * the platform function timeout.
   */
  async _applySchemaWithAdvisoryLock() {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf-8');
    const expected = parseExpectedSchemaObjects(schemaSql);
    const pool = this.getPool();
    const client = await pool.connect();
    let lockHeld = false;

    try {
      const deadline = Date.now() + SCHEMA_LOCK_WAIT_MS;

      // ── Acquire the dedicated schema-initialization advisory lock ──
      for (;;) {
        const res = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [SCHEMA_LOCK_ID]);
        if (res.rows[0] && res.rows[0].acquired === true) { lockHeld = true; break; }

        // Another instance holds the lock and is applying the schema. If it has
        // already finished, our work is done — verify and return without waiting.
        if (await verifySchemaObjects(client, expected)) return;

        if (Date.now() >= deadline) {
          // Final chance: the holder may have completed during the last interval.
          if (await verifySchemaObjects(client, expected)) return;
          throw new Error(
            'Timed out waiting for the MediIndex schema-initialization advisory lock ' +
            `(${SCHEMA_LOCK_WAIT_MS}ms). Schema is incomplete; the next request will retry.`
          );
        }
        await sleep(SCHEMA_LOCK_POLL_MS);
      }

      // ── Lock held: apply the idempotent schema ──
      try {
        await client.query(schemaSql);
      } catch (err) {
        // With the lock held our own instances are serialized, so these codes
        // should not occur. An external actor (e.g. a manual bootstrap run or a
        // migration tool) could still race us. Tolerate only the benign
        // "already exists" codes — and never on trust: the verification below is
        // what actually guarantees the schema is complete.
        if (!BENIGN_DDL_RACE_CODES.has(err.code)) throw err;
      }

      // ── Guarantee completeness before resolving ──
      if (!(await verifySchemaObjects(client, expected))) {
        const missing = await describeMissingSchemaObjects(client, expected);
        throw new Error('Schema verification failed after application. Missing: ' + missing);
      }
    } finally {
      if (lockHeld) {
        // Must unlock explicitly: the connection returns to the pool for reuse,
        // so the session (and its advisory locks) would otherwise persist.
        try { await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_ID]); } catch {}
      }
      client.release();
    }
  }

  async query(sql, params = []) {
    const pool = this.getPool();
    const pgSql = convertPlaceholders(sql);
    const result = await pool.query(pgSql, params);
    return result.rows;
  }

  async get(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows && rows.length > 0 ? rows[0] : null;
  }

  async run(sql, params = []) {
    const pool = this.getPool();
    const pgSql = convertPlaceholders(sql);
    const result = await pool.query(pgSql, params);
    return {
      changes: result.rowCount || 0,
      rowCount: result.rowCount || 0,
      rows: result.rows || [],
      lastInsertRowid: result.rows && result.rows[0] && result.rows[0].id ? result.rows[0].id : null
    };
  }

  async exec(sql) {
    const pool = this.getPool();
    return await pool.query(sql);
  }

  async getClient() {
    const pool = this.getPool();
    const client = await pool.connect();

    const wrappedClient = {
      rawClient: client,
      query: async (sql, params = []) => {
        const pgSql = convertPlaceholders(sql);
        const res = await client.query(pgSql, params);
        return res.rows;
      },
      get: async (sql, params = []) => {
        const rows = await wrappedClient.query(sql, params);
        return rows && rows.length > 0 ? rows[0] : null;
      },
      run: async (sql, params = []) => {
        const pgSql = convertPlaceholders(sql);
        const res = await client.query(pgSql, params);
        return {
          changes: res.rowCount || 0,
          rowCount: res.rowCount || 0,
          rows: res.rows || [],
          lastInsertRowid: res.rows && res.rows[0] && res.rows[0].id ? res.rows[0].id : null
        };
      },
      exec: async (sql) => {
        return await client.query(sql);
      },
      release: () => {
        client.release();
      }
    };

    return wrappedClient;
  }

  async transaction(callback) {
    const client = await this.getClient();
    try {
      await client.exec('BEGIN');
      const result = await callback(client);
      await client.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.exec('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  // prepare(sql) returns a statement-like object with async .get(), .run(), .all().
  // This makes the PostgreSQL adapter interface compatible with the same call pattern
  // used for SQLite's DatabaseSync.prepare(), so core.js can call
  // db.prepare(sql).get(...params) / .run(...params) / .all(...params) uniformly.
  prepare(sql) {
    const adapter = this;
    return {
      get: (...params) => adapter.get(sql, params),
      run: (...params) => adapter.run(sql, params),
      all: (...params) => adapter.query(sql, params),
    };
  }

  async close() {
    if (this.pool && typeof this.pool.end === 'function') {
      await this.pool.end();
      this.pool = null;
      this.isInitialized = false;
    }
  }
}

module.exports = {
  PostgreSQLAdapter,
  sanitizeConnectionString,
  convertPlaceholders,
  // Schema-initialization locking internals — exported for observability and tests
  SCHEMA_LOCK_ID,
  SCHEMA_LOCK_NAMESPACE,
  parseExpectedSchemaObjects,
  verifySchemaObjects,
  describeMissingSchemaObjects
};
