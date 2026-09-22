/**
 * REAL SQLite test driver — backs `SQLiteDriver` (see src/storage/outbox.ts) with
 * Node's built-in `node:sqlite` module (`DatabaseSync`), which is a genuine,
 * file-backed SQLite engine — not a mock, not a Map, not an in-memory stand-in.
 *
 * Why this exists:
 *   `expo-sqlite` cannot execute under plain Node.js. Its own web/server fallback
 *   (`expo-sqlite/web/SQLiteModule.node.ts`) is an explicit no-op dummy — every
 *   method returns empty/zero results without touching a real database. Using it
 *   would make tests "pass" without exercising any actual SQL. This adapter instead
 *   gives the actual production `SQLiteOutboxStore` class a REAL SQLite backend to
 *   run its REAL SQL against, while implementing the exact same narrow interface
 *   (execAsync, runAsync, getFirstAsync, getAllAsync, withTransactionAsync,
 *   closeAsync) that `SQLiteOutboxStore` depends on.
 *
 * The production code path (mobile/src/storage/outbox.ts -> `outbox` singleton)
 * is completely unaffected: it still opens a real expo-sqlite database by default.
 * Only tests that explicitly construct `new SQLiteOutboxStore(path, driverFactory)`
 * use this file.
 */

const { DatabaseSync } = require('node:sqlite');

/**
 * Wraps a node:sqlite DatabaseSync as an async SQLiteDriver.
 * node:sqlite is synchronous; we simply resolve promises immediately, which
 * preserves real transactional/durability semantics (writes hit the real file).
 */
function wrapNodeSqlite(db) {
  return {
    async execAsync(source) {
      db.exec(source);
    },

    async runAsync(source, params = []) {
      const stmt = db.prepare(source);
      const info = stmt.run(...params);
      return {
        lastInsertRowId: Number(info.lastInsertRowid ?? 0),
        changes: Number(info.changes ?? 0),
      };
    },

    async getFirstAsync(source, params = []) {
      const stmt = db.prepare(source);
      const row = stmt.get(...params);
      return row === undefined ? null : row;
    },

    async getAllAsync(source, params = []) {
      const stmt = db.prepare(source);
      return stmt.all(...params);
    },

    async withTransactionAsync(task) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    async closeAsync() {
      db.close();
    },
  };
}

/**
 * SQLiteDriverFactory-compatible function: opens (or creates) a real, file-backed
 * SQLite database at `databaseName` using node:sqlite. Matches the signature
 * `(databaseName: string) => Promise<SQLiteDriver>` expected by SQLiteOutboxStore.
 */
async function openNodeSqliteDriver(databaseName) {
  const db = new DatabaseSync(databaseName);
  return wrapNodeSqlite(db);
}

module.exports = { openNodeSqliteDriver, wrapNodeSqlite };
