const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabaseAdapter, SQLiteAdapter, PostgreSQLAdapter } = require('../db/index');

test('ADAPTER-SELECT-001: SQLite selected when DATABASE_URL is not set', () => {
  // Save original
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  
  try {
    const adapter = createDatabaseAdapter({ dbPath: ':memory:' });
    assert.equal(adapter.type, 'sqlite', 'Should select SQLite when DATABASE_URL is not set');
    assert.ok(adapter instanceof SQLiteAdapter, 'Should be instance of SQLiteAdapter');
  } finally {
    // Restore
    if (original !== undefined) {
      process.env.DATABASE_URL = original;
    }
  }
});

test('ADAPTER-SELECT-002: PostgreSQL selected when DATABASE_URL is set', () => {
  // Save original
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  
  try {
    const adapter = createDatabaseAdapter();
    assert.equal(adapter.type, 'postgres', 'Should select PostgreSQL when DATABASE_URL is set');
    assert.ok(adapter instanceof PostgreSQLAdapter, 'Should be instance of PostgreSQLAdapter');
  } finally {
    // Restore
    if (original !== undefined) {
      process.env.DATABASE_URL = original;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

test('ADAPTER-SELECT-003: Explicit type option overrides environment', () => {
  // Save original
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  
  try {
    // Force SQLite despite DATABASE_URL
    const adapter = createDatabaseAdapter({ type: 'sqlite', dbPath: ':memory:' });
    assert.equal(adapter.type, 'sqlite', 'Explicit type should override DATABASE_URL');
    assert.ok(adapter instanceof SQLiteAdapter, 'Should be instance of SQLiteAdapter');
  } finally {
    // Restore
    if (original !== undefined) {
      process.env.DATABASE_URL = original;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

test('ADAPTER-SELECT-004: Empty DATABASE_URL selects SQLite', () => {
  // Save original
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = '';
  
  try {
    const adapter = createDatabaseAdapter({ dbPath: ':memory:' });
    assert.equal(adapter.type, 'sqlite', 'Empty DATABASE_URL should select SQLite');
    assert.ok(adapter instanceof SQLiteAdapter, 'Should be instance of SQLiteAdapter');
  } finally {
    // Restore
    if (original !== undefined) {
      process.env.DATABASE_URL = original;
    } else {
      delete process.env.DATABASE_URL;
    }
  }
});

test('ADAPTER-SELECT-005: PostgreSQL connection string passed via options', () => {
  const adapter = createDatabaseAdapter({ 
    type: 'postgres',
    connectionString: 'postgresql://test:test@localhost:5432/test'
  });
  
  assert.equal(adapter.type, 'postgres', 'Should select PostgreSQL');
  assert.ok(adapter instanceof PostgreSQLAdapter, 'Should be instance of PostgreSQLAdapter');
  assert.equal(adapter.connectionString, 'postgresql://test:test@localhost:5432/test');
});

test('ADAPTER-SELECT-006: server.js uses createDatabaseAdapter factory', () => {
  // Verify server.js imports the factory, not direct adapter
  const serverCode = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server.js'),
    'utf-8'
  );
  
  // Should import createDatabaseAdapter
  assert.match(serverCode, /createDatabaseAdapter/, 'server.js should import createDatabaseAdapter');
  
  // Should NOT directly construct SQLiteAdapter
  assert.ok(
    !serverCode.includes('new SQLiteAdapter('),
    'server.js should NOT directly construct SQLiteAdapter'
  );
  
  // Should use createDatabaseAdapter()
  assert.match(
    serverCode,
    /createDatabaseAdapter\(/,
    'server.js should call createDatabaseAdapter()'
  );
});

test('ADAPTER-SELECT-007: No in-memory session Map in server.js', () => {
  const serverCode = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server.js'),
    'utf-8'
  );
  
  // Should NOT have sessions = new Map()
  const sessionMapPattern = /const\s+sessions\s*=\s*new\s+Map\(\)/;
  assert.ok(
    !sessionMapPattern.test(serverCode),
    'server.js should NOT have in-memory sessions Map'
  );
});

test('ADAPTER-SELECT-008: Adapter initialization is synchronous for SQLite', () => {
  const original = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  
  try {
    const adapter = createDatabaseAdapter({ dbPath: ':memory:' });
    const initialized = adapter.initialize();
    
    // SQLiteAdapter.initialize() returns this (synchronous)
    assert.ok(initialized === adapter, 'SQLite initialize should be synchronous');
    assert.ok(initialized.isInitialized, 'Should be marked as initialized');
  } finally {
    if (original !== undefined) {
      process.env.DATABASE_URL = original;
    }
  }
});

test('ADAPTER-SELECT-009: PostgreSQL adapter has async initialize', () => {
  const adapter = createDatabaseAdapter({ 
    type: 'postgres',
    connectionString: 'postgresql://test:test@localhost:5432/test'
  });
  
  // PostgreSQLAdapter.initialize() returns a Promise
  const result = adapter.initialize();
  assert.ok(result instanceof Promise, 'PostgreSQL initialize should return Promise');
});

test('ADAPTER-SELECT-010: Adapter type is exposed for debugging', () => {
  const sqliteAdapter = createDatabaseAdapter({ type: 'sqlite', dbPath: ':memory:' });
  assert.equal(sqliteAdapter.type, 'sqlite', 'SQLite adapter should expose type');
  
  const pgAdapter = createDatabaseAdapter({ 
    type: 'postgres',
    connectionString: 'postgresql://test:test@localhost:5432/test'
  });
  assert.equal(pgAdapter.type, 'postgres', 'PostgreSQL adapter should expose type');
});
