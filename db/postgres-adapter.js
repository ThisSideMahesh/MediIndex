const crypto = require('node:crypto');

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

  async initialize() {
    this.getPool();
    this.isInitialized = true;
    return this;
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
  convertPlaceholders
};
