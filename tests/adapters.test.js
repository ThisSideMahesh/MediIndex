const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { SQLiteAdapter } = require('../db/sqlite-adapter');
const { PostgreSQLAdapter, sanitizeConnectionString, convertPlaceholders } = require('../db/postgres-adapter');
const { createDatabaseAdapter } = require('../db/index');

test('ADAPTER-001: SQLite adapter initialization and table verification', () => {
  const testDbDir = path.join(__dirname, '..', 'data');
  const adapter = new SQLiteAdapter({ dataDir: testDbDir }).initialize();
  
  assert.equal(adapter.type, 'sqlite');
  assert.equal(adapter.isInitialized, true);
  
  // Verify core tables exist
  const tables = adapter.query("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
  assert.ok(tables.includes('pharmacies'), 'pharmacies table must exist');
  assert.ok(tables.includes('users'), 'users table must exist');
  assert.ok(tables.includes('medicines'), 'medicines table must exist');
  assert.ok(tables.includes('medicine_batches'), 'medicine_batches table must exist');
  assert.ok(tables.includes('inventory_movements'), 'inventory_movements table must exist');
  assert.ok(tables.includes('sales'), 'sales table must exist');
  assert.ok(tables.includes('sale_items'), 'sale_items table must exist');
  assert.ok(tables.includes('expiry_alerts'), 'expiry_alerts table must exist');
  assert.ok(tables.includes('paired_devices'), 'paired_devices table must exist');
  assert.ok(tables.includes('device_pairing_codes'), 'device_pairing_codes table must exist');
  assert.ok(tables.includes('idempotency_keys'), 'idempotency_keys table must exist');
  assert.ok(tables.includes('sessions'), 'sessions table must exist');
});

test('ADAPTER-002: SQLite query compatibility (query, get, run, prepare)', () => {
  const adapter = new SQLiteAdapter().initialize();
  
  // 1. get()
  const pharmacy = adapter.get('SELECT id, name FROM pharmacies LIMIT 1');
  assert.ok(pharmacy, 'Pharmacy record should exist');
  assert.ok(pharmacy.id > 0);
  assert.ok(typeof pharmacy.name === 'string');

  // 2. query()
  const users = adapter.query('SELECT id, email, role FROM users WHERE pharmacy_id = ?', [pharmacy.id]);
  assert.ok(Array.isArray(users));
  assert.ok(users.length >= 2, 'Should have demo admin and staff');

  // 3. prepare()
  const stmt = adapter.prepare('SELECT id FROM users WHERE email = ?');
  const user = stmt.get('admin@mediindex.local');
  assert.ok(user);
  assert.equal(typeof user.id, 'number');

  // 4. run()
  const tempCode = 'TEST-ADAPTER-RUN-' + Date.now();
  const runRes = adapter.run(
    'INSERT INTO device_pairing_codes (pharmacy_id, pairing_code, created_by, expires_at) VALUES (?, ?, ?, ?)',
    [pharmacy.id, tempCode, user.id, new Date(Date.now() + 600000).toISOString()]
  );
  assert.ok(runRes.changes === 1);
  assert.ok(Number(runRes.lastInsertRowid) > 0);

  // Clean up
  adapter.run('DELETE FROM device_pairing_codes WHERE pairing_code = ?', [tempCode]);
});

test('ADAPTER-003: SQLite transaction commit', () => {
  const adapter = new SQLiteAdapter().initialize();
  const pharmacy = adapter.get('SELECT id FROM pharmacies LIMIT 1');
  const admin = adapter.get('SELECT id FROM users WHERE email = ?', ['admin@mediindex.local']);
  const code = 'TX-COMMIT-' + Date.now();

  adapter.transaction((tx) => {
    tx.run(
      'INSERT INTO device_pairing_codes (pharmacy_id, pairing_code, created_by, expires_at) VALUES (?, ?, ?, ?)',
      [pharmacy.id, code, admin.id, new Date(Date.now() + 600000).toISOString()]
    );
  });

  const check = adapter.get('SELECT * FROM device_pairing_codes WHERE pairing_code = ?', [code]);
  assert.ok(check, 'Record should be committed');
  assert.equal(check.pairing_code, code);

  // Clean up
  adapter.run('DELETE FROM device_pairing_codes WHERE pairing_code = ?', [code]);
});

test('ADAPTER-004: SQLite transaction rollback on error', () => {
  const adapter = new SQLiteAdapter().initialize();
  const pharmacy = adapter.get('SELECT id FROM pharmacies LIMIT 1');
  const admin = adapter.get('SELECT id FROM users WHERE email = ?', ['admin@mediindex.local']);
  const code = 'TX-ROLLBACK-' + Date.now();

  assert.throws(() => {
    adapter.transaction((tx) => {
      tx.run(
        'INSERT INTO device_pairing_codes (pharmacy_id, pairing_code, created_by, expires_at) VALUES (?, ?, ?, ?)',
        [pharmacy.id, code, admin.id, new Date(Date.now() + 600000).toISOString()]
      );
      throw new Error('Simulated failure inside transaction');
    });
  }, /Simulated failure inside transaction/);

  const check = adapter.get('SELECT * FROM device_pairing_codes WHERE pairing_code = ?', [code]);
  assert.equal(check, undefined, 'Rolled back record should not exist in database');
});

test('ADAPTER-005: PostgreSQL configuration validation', () => {
  const emptyAdapter = new PostgreSQLAdapter({ connectionString: '' });
  assert.throws(() => {
    emptyAdapter.validateConfig();
  }, /DATABASE_URL is not configured/);

  const invalidProtocolAdapter = new PostgreSQLAdapter({ connectionString: 'mysql://user:pass@localhost:3306/db' });
  assert.throws(() => {
    invalidProtocolAdapter.validateConfig();
  }, /Invalid connection protocol/);

  const validAdapter = new PostgreSQLAdapter({ connectionString: 'postgresql://user:pass@localhost:5432/mediindex' });
  assert.equal(validAdapter.validateConfig(), true);
});

test('ADAPTER-006: DATABASE_URL validation and sanitization', () => {
  const rawUrl = 'postgresql://admin_user:SuperSecretPassword123@db.cloud-cluster.internal:5432/mediindex_production';
  const sanitized = sanitizeConnectionString(rawUrl);
  
  assert.ok(!sanitized.includes('SuperSecretPassword123'), 'Sanitized URL must NEVER contain plaintext password');
  assert.ok(sanitized.includes('admin_user'));
  assert.ok(sanitized.includes('*****'));
  assert.ok(sanitized.includes('db.cloud-cluster.internal'));

  const pgAdapter = new PostgreSQLAdapter({ connectionString: rawUrl });
  assert.equal(pgAdapter.getSanitizedUrl(), sanitized);
});

test('ADAPTER-007: Parameterized query protection and placeholder conversion', () => {
  const sql1 = 'SELECT * FROM users WHERE id = ? AND active = ?';
  assert.equal(convertPlaceholders(sql1), 'SELECT * FROM users WHERE id = $1 AND active = $2');

  const sqlWithQuotes = "SELECT * FROM medicines WHERE name = 'What?' AND category = ? AND id = ?";
  assert.equal(
    convertPlaceholders(sqlWithQuotes),
    "SELECT * FROM medicines WHERE name = 'What?' AND category = $1 AND id = $2"
  );

  const sqlWithEscapedQuotes = "SELECT * FROM medicines WHERE name = 'Don''t know?' AND category = ?";
  assert.equal(
    convertPlaceholders(sqlWithEscapedQuotes),
    "SELECT * FROM medicines WHERE name = 'Don''t know?' AND category = $1"
  );

  const sqlWithComments = "-- Check comment with ? mark\nSELECT * FROM batches WHERE id = ? /* block ? comment */ AND medicine_id = ?";
  assert.equal(
    convertPlaceholders(sqlWithComments),
    "-- Check comment with ? mark\nSELECT * FROM batches WHERE id = $1 /* block ? comment */ AND medicine_id = $2"
  );

  const sqlWithDoubleQuotes = 'SELECT "column?" FROM "my_table" WHERE id = ?';
  assert.equal(
    convertPlaceholders(sqlWithDoubleQuotes),
    'SELECT "column?" FROM "my_table" WHERE id = $1'
  );

  const sqlNoParams = 'SELECT count(*) FROM pharmacies';
  assert.equal(convertPlaceholders(sqlNoParams), 'SELECT count(*) FROM pharmacies');
});

test('ADAPTER-008: PostgreSQL transaction lifecycle and rollback semantics', async () => {
  const executedStatements = [];
  let clientReleased = false;

  const mockClient = {
    query: async (sql, params) => {
      executedStatements.push({ sql, params });
      if (sql.includes('FAIL_ME')) {
        throw new Error('Database constraint violation');
      }
      return { rowCount: 1, rows: [{ id: 42 }] };
    },
    release: () => {
      clientReleased = true;
    }
  };

  const mockPool = {
    connect: async () => mockClient,
    query: async (sql, params) => mockClient.query(sql, params)
  };

  const adapter = new PostgreSQLAdapter({
    connectionString: 'postgresql://user:pass@localhost:5432/mediindex',
    pool: mockPool
  });

  // 1. Successful transaction
  const result = await adapter.transaction(async (tx) => {
    await tx.run('UPDATE medicine_batches SET quantity = quantity + ? WHERE id = ?', [10, 1]);
    await tx.run('INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, ?, ?)', [1, 10, 'RECEIPT', 2]);
    return { success: true };
  });

  assert.equal(result.success, true);
  assert.equal(clientReleased, true);
  assert.equal(executedStatements[0].sql, 'BEGIN');
  assert.ok(executedStatements.some(s => s.sql.includes('UPDATE medicine_batches')));
  assert.ok(executedStatements.some(s => s.sql.includes('INSERT INTO inventory_movements')));
  assert.equal(executedStatements[executedStatements.length - 1].sql, 'COMMIT');

  // 2. Rollback transaction on failure
  executedStatements.length = 0;
  clientReleased = false;

  await assert.rejects(async () => {
    await adapter.transaction(async (tx) => {
      await tx.run('UPDATE medicine_batches SET quantity = quantity + $1 WHERE id = $2', [10, 1]);
      await tx.run('FAIL_ME');
    });
  }, /Database constraint violation/);

  assert.equal(clientReleased, true);
  assert.equal(executedStatements[0].sql, 'BEGIN');
  assert.ok(executedStatements.some(s => s.sql === 'ROLLBACK'));
});
