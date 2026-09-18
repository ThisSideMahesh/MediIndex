const { SQLiteAdapter } = require('./sqlite-adapter');
const { PostgreSQLAdapter, sanitizeConnectionString, convertPlaceholders } = require('./postgres-adapter');

function createDatabaseAdapter(options = {}) {
  const type = options.type || (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
  if (type === 'postgres') {
    return new PostgreSQLAdapter(options);
  }
  return new SQLiteAdapter(options);
}

module.exports = {
  createDatabaseAdapter,
  SQLiteAdapter,
  PostgreSQLAdapter,
  sanitizeConnectionString,
  convertPlaceholders
};
