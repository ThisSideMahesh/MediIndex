const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PostgreSQLAdapter } = require('../db/postgres-adapter');

// PostgreSQL integration tests run ONLY if DATABASE_URL is configured
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_TEST_URL;
const SKIP_REASON = 'Skipped: DATABASE_URL not configured for PostgreSQL integration testing';

// Safety check: Prevent running against production databases
function isTestDatabase(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes('test') || 
         lower.includes('dev') || 
         lower.includes('local') ||
         lower.includes('localhost') ||
         lower.includes('127.0.0.1');
}

function skipIfNoPostgres(callback) {
  if (!DATABASE_URL) {
    return test.skip(SKIP_REASON, callback);
  }
  // Safety check: Require test/dev database
  if (!isTestDatabase(DATABASE_URL)) {
    return test.skip('Skipped: DATABASE_URL does not appear to be a test database (must contain: test, dev, local, localhost, or 127.0.0.1)', callback);
  }
  return callback;
}

test('POSTGRES-INTEGRATION-001: PostgreSQL connection and schema initialization', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Verify connection works
  const result = await adapter.query('SELECT 1 AS test');
  assert.equal(result[0].test, 1);

  await adapter.close();
}));

test('POSTGRES-INTEGRATION-002: Apply PostgreSQL schema DDL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Read and apply schema
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.pg.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  
  // Execute schema (CREATE TABLE IF NOT EXISTS should be idempotent)
  await adapter.exec(schemaSql);

  // Verify tables exist
  const tables = await adapter.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  const tableNames = tables.map(t => t.table_name);
  
  // Verify expected tables
  const expectedTables = [
    'pharmacies',
    'users',
    'sessions',
    'medicines',
    'medicine_batches',
    'inventory_movements',
    'sales',
    'sale_items',
    'expiry_alerts',
    'paired_devices',
    'device_pairing_codes',
    'idempotency_keys'
  ];

  for (const expected of expectedTables) {
    assert.ok(
      tableNames.includes(expected),
      `Table '${expected}' must exist in PostgreSQL schema`
    );
  }

  await adapter.close();
}));

test('POSTGRES-INTEGRATION-003: Create test pharmacy and user', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Clean up test data first
  await adapter.exec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE \'%pgtest%\')');
  await adapter.exec('DELETE FROM users WHERE email LIKE \'%pgtest%\'');
  await adapter.exec('DELETE FROM pharmacies WHERE name LIKE \'%PG Test%\'');

  // Create test pharmacy
  const pharmacyResult = await adapter.run(
    'INSERT INTO pharmacies (name, address) VALUES (?, ?) RETURNING id',
    ['PG Test Pharmacy', 'PostgreSQL Integration Test']
  );
  
  const pharmacyId = pharmacyResult.rows[0].id;
  assert.ok(pharmacyId, 'Pharmacy ID must be returned');

  // Create test user
  const crypto = require('node:crypto');
  const passwordHash = crypto.scryptSync('TestPass123', 'salt', 64).toString('hex');
  const storedHash = `salt:${passwordHash}`;

  const userResult = await adapter.run(
    'INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [pharmacyId, 'PG Test Admin', 'admin@pgtest.local', storedHash, 'ADMIN']
  );

  const userId = userResult.rows[0].id;
  assert.ok(userId, 'User ID must be returned');

  // Verify user was created
  const user = await adapter.get(
    'SELECT id, full_name, email, role, pharmacy_id FROM users WHERE id = ?',
    [userId]
  );

  assert.equal(user.email, 'admin@pgtest.local');
  assert.equal(user.role, 'ADMIN');
  assert.equal(user.pharmacy_id, pharmacyId);

  await adapter.close();
}));

test('POSTGRES-INTEGRATION-004: Session persistence and authentication lifecycle', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Find test user
  const user = await adapter.get(
    'SELECT id, pharmacy_id FROM users WHERE email = ? AND active = 1',
    ['admin@pgtest.local']
  );
  
  if (!user) {
    // Skip if test user doesn't exist (previous test may have been skipped)
    await adapter.close();
    return;
  }

  // Generate session token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  // Create session
  await adapter.run(
    'INSERT INTO sessions (token_hash, user_id, pharmacy_id, expires_at) VALUES (?, ?, ?, ?)',
    [tokenHash, user.id, user.pharmacy_id, expiresAt]
  );

  // Verify session exists
  const session = await adapter.get(
    'SELECT token_hash, user_id, pharmacy_id, expires_at FROM sessions WHERE token_hash = ?',
    [tokenHash]
  );

  assert.ok(session, 'Session must be created');
  assert.equal(session.token_hash, tokenHash);
  assert.equal(session.user_id, user.id);
  assert.equal(session.pharmacy_id, user.pharmacy_id);

  // Verify raw token is NOT stored
  const rawTokenSearch = await adapter.get(
    'SELECT * FROM sessions WHERE token_hash = ?',
    [rawToken]
  );
  assert.equal(rawTokenSearch, null, 'Raw token must never be stored');

  // Verify session hash is exactly 64 characters (SHA-256 hex)
  assert.equal(session.token_hash.length, 64, 'Token hash must be 64-char SHA-256 hex');

  // Delete session
  const deleteResult = await adapter.run(
    'DELETE FROM sessions WHERE token_hash = ?',
    [tokenHash]
  );
  assert.equal(deleteResult.changes, 1, 'Session must be deleted');

  // Verify deletion
  const deletedSession = await adapter.get(
    'SELECT * FROM sessions WHERE token_hash = ?',
    [tokenHash]
  );
  assert.equal(deletedSession, null, 'Session must not exist after deletion');

  await adapter.close();
}));

test('POSTGRES-INTEGRATION-005: Medicine and batch inventory transaction', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Find test pharmacy
  const pharmacy = await adapter.get(
    'SELECT id FROM pharmacies WHERE name LIKE ?',
    ['%PG Test%']
  );

  if (!pharmacy) {
    await adapter.close();
    return;
  }

  // Create test medicine
  const medicineResult = await adapter.run(
    'INSERT INTO medicines (pharmacy_id, name, generic_name, category, minimum_stock) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [pharmacy.id, 'PG Test Paracetamol', 'Paracetamol', 'Tablet', 10]
  );

  const medicineId = medicineResult.rows[0].id;
  assert.ok(medicineId, 'Medicine ID must be returned');

  // Create batch
  const batchResult = await adapter.run(
    `INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, expiry_date)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [medicineId, 'PG-TEST-001', 100, 5.00, 8.50, '2026-12-31']
  );

  const batchId = batchResult.rows[0].id;
  assert.ok(batchId, 'Batch ID must be returned');

  // Verify batch was created
  const batch = await adapter.get(
    'SELECT id, batch_number, quantity, selling_price FROM medicine_batches WHERE id = ?',
    [batchId]
  );

  assert.equal(batch.batch_number, 'PG-TEST-001');
  assert.equal(batch.quantity, 100);

  // Perform transaction: add stock
  await adapter.transaction(async (client) => {
    // Lock the batch
    const lockedBatch = await client.get(
      'SELECT id, quantity FROM medicine_batches WHERE id = ? FOR UPDATE',
      [batchId]
    );

    assert.equal(lockedBatch.id, batchId);

    // Update quantity
    await client.run(
      'UPDATE medicine_batches SET quantity = quantity + ? WHERE id = ?',
      [50, batchId]
    );

    // Verify within transaction
    const updated = await client.get(
      'SELECT quantity FROM medicine_batches WHERE id = ?',
      [batchId]
    );
    assert.equal(updated.quantity, 150);
  });

  // Verify committed
  const final = await adapter.get(
    'SELECT quantity FROM medicine_batches WHERE id = ?',
    [batchId]
  );
  assert.equal(final.quantity, 150);

  await adapter.close();
}));

test('POSTGRES-INTEGRATION-006: Idempotency key uniqueness and conflict detection', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Find test pharmacy
  const pharmacy = await adapter.get(
    'SELECT id FROM pharmacies WHERE name LIKE ?',
    ['%PG Test%']
  );

  if (!pharmacy) {
    await adapter.close();
    return;
  }

  const testKey = `pgtest-idempotency-${Date.now()}`;
  const requestHash1 = crypto.createHash('sha256').update('payload-1').digest('hex');

  // Insert idempotency key
  await adapter.run(
    `INSERT INTO idempotency_keys (key, pharmacy_id, endpoint, request_hash, response_status, response_body)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [testKey, pharmacy.id, '/api/test', requestHash1, 200, JSON.stringify({ success: true })]
  );

  // Verify key exists
  const stored = await adapter.get(
    'SELECT key, request_hash FROM idempotency_keys WHERE key = ? AND pharmacy_id = ?',
    [testKey, pharmacy.id]
  );

  assert.equal(stored.key, testKey);
  assert.equal(stored.request_hash, requestHash1);

  // Attempt duplicate insert with same key and pharmacy (should fail)
  const requestHash2 = crypto.createHash('sha256').update('payload-2').digest('hex');
  
  let duplicateError = null;
  try {
    await adapter.run(
      `INSERT INTO idempotency_keys (key, pharmacy_id, endpoint, request_hash, response_status, response_body)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [testKey, pharmacy.id, '/api/test', requestHash2, 200, JSON.stringify({ success: true })]
    );
  } catch (err) {
    duplicateError = err;
  }

  assert.ok(duplicateError, 'Duplicate idempotency key must be rejected');
  assert.match(
    duplicateError.message,
    /duplicate key value|unique constraint|already exists/i,
    'Error must indicate constraint violation'
  );

  await adapter.close();
}));

test('POSTGRES-INTEGRATION-007: Tenant isolation verification', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Create second test pharmacy
  await adapter.exec('DELETE FROM pharmacies WHERE name = \'PG Test Pharmacy 2\'');
  
  const pharmacy2Result = await adapter.run(
    'INSERT INTO pharmacies (name, address) VALUES (?, ?) RETURNING id',
    ['PG Test Pharmacy 2', 'Tenant Isolation Test']
  );

  const pharmacy2Id = pharmacy2Result.rows[0].id;

  // Get original test pharmacy
  const pharmacy1 = await adapter.get(
    'SELECT id FROM pharmacies WHERE name LIKE ?',
    ['%PG Test Pharmacy%']
  );

  if (!pharmacy1 || pharmacy1.id === pharmacy2Id) {
    await adapter.close();
    return;
  }

  // Create medicine for pharmacy 1
  const med1Result = await adapter.run(
    'INSERT INTO medicines (pharmacy_id, name, category) VALUES (?, ?, ?) RETURNING id',
    [pharmacy1.id, 'Pharmacy 1 Medicine', 'Tablet']
  );
  const med1Id = med1Result.rows[0].id;

  // Create medicine for pharmacy 2
  const med2Result = await adapter.run(
    'INSERT INTO medicines (pharmacy_id, name, category) VALUES (?, ?, ?) RETURNING id',
    [pharmacy2Id, 'Pharmacy 2 Medicine', 'Tablet']
  );
  const med2Id = med2Result.rows[0].id;

  // Query pharmacy 1's medicines
  const pharmacy1Medicines = await adapter.query(
    'SELECT id, name, pharmacy_id FROM medicines WHERE pharmacy_id = ?',
    [pharmacy1.id]
  );

  // Verify isolation: pharmacy 1 query must not return pharmacy 2's medicine
  const foundPharmacy2Medicine = pharmacy1Medicines.some(m => m.id === med2Id);
  assert.equal(foundPharmacy2Medicine, false, 'Tenant isolation must prevent cross-pharmacy data access');

  // Query pharmacy 2's medicines
  const pharmacy2Medicines = await adapter.query(
    'SELECT id, name, pharmacy_id FROM medicines WHERE pharmacy_id = ?',
    [pharmacy2Id]
  );

  // Verify pharmacy 2 query doesn't return pharmacy 1's medicine
  const foundPharmacy1Medicine = pharmacy2Medicines.some(m => m.id === med1Id);
  assert.equal(foundPharmacy1Medicine, false, 'Tenant isolation must be bidirectional');

  await adapter.close();
}));

test('POSTGRES-INTEGRATION-008: Concurrent transaction safety', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Find test batch
  const batch = await adapter.get(
    `SELECT b.id, b.quantity, m.pharmacy_id
     FROM medicine_batches b
     JOIN medicines m ON m.id = b.medicine_id
     WHERE b.batch_number = 'PG-TEST-001'
     LIMIT 1`
  );

  if (!batch) {
    await adapter.close();
    return;
  }

  const initialQuantity = batch.quantity;

  // Simulate two concurrent increments
  const increment1 = adapter.transaction(async (client) => {
    const locked = await client.get(
      'SELECT quantity FROM medicine_batches WHERE id = ? FOR UPDATE',
      [batch.id]
    );
    await new Promise(resolve => setTimeout(resolve, 50)); // Simulate processing
    await client.run(
      'UPDATE medicine_batches SET quantity = quantity + ? WHERE id = ?',
      [10, batch.id]
    );
  });

  const increment2 = adapter.transaction(async (client) => {
    const locked = await client.get(
      'SELECT quantity FROM medicine_batches WHERE id = ? FOR UPDATE',
      [batch.id]
    );
    await new Promise(resolve => setTimeout(resolve, 50)); // Simulate processing
    await client.run(
      'UPDATE medicine_batches SET quantity = quantity + ? WHERE id = ?',
      [15, batch.id]
    );
  });

  // Execute concurrently
  await Promise.all([increment1, increment2]);

  // Verify both increments were applied
  const final = await adapter.get(
    'SELECT quantity FROM medicine_batches WHERE id = ?',
    [batch.id]
  );

  const expectedQuantity = initialQuantity + 10 + 15;
  assert.equal(final.quantity, expectedQuantity, 'Concurrent transactions must both apply correctly');

  await adapter.close();
}));

test('POSTGRES-INTEGRATION-CLEANUP: Remove test data', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Clean up in reverse dependency order
  await adapter.exec('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE \'%pgtest%\')');
  await adapter.exec('DELETE FROM idempotency_keys WHERE pharmacy_id IN (SELECT id FROM pharmacies WHERE name LIKE \'%PG Test%\')');
  await adapter.exec('DELETE FROM inventory_movements WHERE batch_id IN (SELECT id FROM medicine_batches WHERE medicine_id IN (SELECT id FROM medicines WHERE pharmacy_id IN (SELECT id FROM pharmacies WHERE name LIKE \'%PG Test%\')))');
  await adapter.exec('DELETE FROM medicine_batches WHERE medicine_id IN (SELECT id FROM medicines WHERE pharmacy_id IN (SELECT id FROM pharmacies WHERE name LIKE \'%PG Test%\'))');
  await adapter.exec('DELETE FROM medicines WHERE pharmacy_id IN (SELECT id FROM pharmacies WHERE name LIKE \'%PG Test%\')');
  await adapter.exec('DELETE FROM users WHERE email LIKE \'%pgtest%\'');
  await adapter.exec('DELETE FROM pharmacies WHERE name LIKE \'%PG Test%\'');

  await adapter.close();
}));
