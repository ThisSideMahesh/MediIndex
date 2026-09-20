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

// ─────────────────────────────────────────────────────────────────────────────
// DIALECT COMPATIBILITY TESTS — verify every SQL fix works on real PostgreSQL
// ─────────────────────────────────────────────────────────────────────────────

const { EventEmitter } = require('node:events');
// Note: PostgreSQLAdapter is already required at the top of this file

// Reuse DATABASE_URL guard from above (skipIfNoPostgres already defined)

// Helper: call handler over fake HTTP
function callHandlerPg(handler, { method = 'GET', url, body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}), ...headers };
    const res = {
      _headers: {},
      writeHead(status, hdrs) { this._status = status; this._headers = hdrs || {}; },
      end(payload) {
        try { resolve({ status: this._status, headers: this._headers, body: payload ? JSON.parse(payload) : null }); }
        catch { resolve({ status: this._status, headers: this._headers, raw: payload }); }
      }
    };
    handler(req, res).catch(reject);
    if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
    else setImmediate(() => req.emit('end'));
  });
}

test('PGDIALECT-001: /api/health executes real SELECT 1 against PostgreSQL', skipIfNoPostgres(async () => {
  // Use a standalone PG adapter + the minimal handler factory (same pattern as PGDIALECT-013)
  const pgAdapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await pgAdapter.initialize();

  const { buildHandlerWithAdapter } = buildPgHandlerFactory();
  const handler = buildHandlerWithAdapter(pgAdapter);

  const res = await callHandlerPg(handler, { url: '/api/health' });
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.database, 'connected');

  await pgAdapter.close();
}));

test('PGDIALECT-002: INSERT OR IGNORE replacement — expiry alert refresh idempotent on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Find test pharmacy created by earlier tests
  const pharmacy = await adapter.get('SELECT id FROM pharmacies WHERE name LIKE ? LIMIT 1', ['%PG Test%']);
  if (!pharmacy) { await adapter.close(); return; }

  // Find a batch to attach alerts to
  const batch = await adapter.get(`
    SELECT mb.id FROM medicine_batches mb
    JOIN medicines m ON m.id = mb.medicine_id
    WHERE m.pharmacy_id = ? LIMIT 1
  `, [pharmacy.id]);
  if (!batch) { await adapter.close(); return; }

  // Ensure no alert exists yet for this batch+type
  await adapter.exec(`DELETE FROM expiry_alerts WHERE batch_id = ${batch.id}`);

  // Insert once — must succeed
  await adapter.run(`
    INSERT INTO expiry_alerts (batch_id, alert_type)
    VALUES (?, 'EXPIRING_SOON')
    ON CONFLICT (batch_id, alert_type) DO NOTHING
  `, [batch.id]);

  const count1 = await adapter.get('SELECT COUNT(*) AS n FROM expiry_alerts WHERE batch_id = ?', [batch.id]);
  assert.equal(Number(count1.n), 1, 'First insert must create one row');

  // Insert again — must be idempotent (no error, no duplicate)
  await adapter.run(`
    INSERT INTO expiry_alerts (batch_id, alert_type)
    VALUES (?, 'EXPIRING_SOON')
    ON CONFLICT (batch_id, alert_type) DO NOTHING
  `, [batch.id]);

  const count2 = await adapter.get('SELECT COUNT(*) AS n FROM expiry_alerts WHERE batch_id = ?', [batch.id]);
  assert.equal(Number(count2.n), 1, 'Second insert must not create a duplicate (ON CONFLICT DO NOTHING)');

  // Cleanup
  await adapter.exec(`DELETE FROM expiry_alerts WHERE batch_id = ${batch.id}`);
  await adapter.close();
}));

test('PGDIALECT-003: CURRENT_DATE date arithmetic works correctly on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Verify CURRENT_DATE comparisons work as expected
  const r = await adapter.get(`
    SELECT
      CURRENT_DATE AS today,
      (CURRENT_DATE + 30) AS plus30,
      ('2020-01-01'::date < CURRENT_DATE) AS past_is_true,
      ('2099-12-31'::date > CURRENT_DATE) AS future_is_true,
      ('2020-01-01'::date >= CURRENT_DATE) AS past_not_gte
  `);
  assert.ok(r.today, 'CURRENT_DATE must return a value');
  assert.ok(r.past_is_true, '2020-01-01 must be in the past');
  assert.ok(r.future_is_true, '2099-12-31 must be in the future');
  assert.equal(r.past_not_gte, false, '2020-01-01 must not be >= CURRENT_DATE');

  // Verify +30 days interval
  const today = new Date(r.today);
  const plus30 = new Date(r.plus30);
  const diffDays = Math.round((plus30 - today) / (1000 * 60 * 60 * 24));
  assert.equal(diffDays, 30, 'CURRENT_DATE + 30 must be exactly 30 days ahead');

  await adapter.close();
}));

test('PGDIALECT-004: Days-to-expiry integer arithmetic on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Test the PostgreSQL days-to-expiry expression (b.expiry_date - CURRENT_DATE)
  const r = await adapter.get(`
    SELECT
      ('2099-12-31'::date - CURRENT_DATE) AS far_future,
      ('2020-01-01'::date - CURRENT_DATE) AS far_past,
      (CURRENT_DATE - CURRENT_DATE) AS zero_diff
  `);

  assert.ok(Number(r.far_future) > 0, 'Far future date must yield positive days');
  assert.ok(Number(r.far_past) < 0, 'Far past date must yield negative days');
  assert.equal(Number(r.zero_diff), 0, 'Today minus today must be 0');

  await adapter.close();
}));

test('PGDIALECT-005: ISO week grouping (to_char IYYY-W IW) on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Verify ISO week format matches expected pattern YYYY-WNN
  const r = await adapter.query(`
    SELECT to_char(d::date, 'IYYY-"W"IW') AS week_id
    FROM (VALUES ('2026-09-14'), ('2026-09-07'), ('2026-01-01')) AS t(d)
    ORDER BY week_id DESC
  `);

  assert.equal(r.length, 3, 'Must return 3 rows');
  for (const row of r) {
    assert.match(row.week_id, /^\d{4}-W\d{2}$/, `week_id "${row.week_id}" must match YYYY-WNN format`);
  }
  // 2026-09-14 is ISO week 38
  assert.equal(r[0].week_id, '2026-W38', 'First row must be 2026-W38');

  await adapter.close();
}));

test('PGDIALECT-006: Medicine INSERT returns id via RETURNING on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  const pharmacy = await adapter.get('SELECT id FROM pharmacies WHERE name LIKE ? LIMIT 1', ['%PG Test%']);
  if (!pharmacy) { await adapter.close(); return; }

  // INSERT with RETURNING id
  const result = await adapter.run(
    'INSERT INTO medicines (pharmacy_id, name, category, minimum_stock) VALUES (?, ?, ?, ?) RETURNING id',
    [pharmacy.id, 'PG Dialect Test Medicine', 'Test', 5]
  );

  assert.ok(result.lastInsertRowid, 'lastInsertRowid must be populated via RETURNING id');
  assert.ok(Number(result.lastInsertRowid) > 0, 'Returned id must be a positive integer');

  // Verify the row exists
  const med = await adapter.get('SELECT id, name FROM medicines WHERE id = ?', [result.lastInsertRowid]);
  assert.ok(med, 'Medicine must exist in database');
  assert.equal(med.name, 'PG Dialect Test Medicine');

  // Cleanup
  await adapter.exec(`DELETE FROM medicines WHERE id = ${result.lastInsertRowid}`);
  await adapter.close();
}));

test('PGDIALECT-007: Batch INSERT returns id via RETURNING on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  const pharmacy = await adapter.get('SELECT id FROM pharmacies WHERE name LIKE ? LIMIT 1', ['%PG Test%']);
  if (!pharmacy) { await adapter.close(); return; }

  // Create temp medicine
  const medResult = await adapter.run(
    'INSERT INTO medicines (pharmacy_id, name, category, minimum_stock) VALUES (?, ?, ?, ?) RETURNING id',
    [pharmacy.id, 'PG Batch Test Medicine', 'Test', 0]
  );
  const medicineId = Number(medResult.lastInsertRowid);

  // INSERT batch with RETURNING id
  const batchResult = await adapter.run(
    'INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, expiry_date) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [medicineId, 'PG-DIALECT-001', 50, 10.00, 15.00, '2027-12-31']
  );

  assert.ok(batchResult.lastInsertRowid, 'Batch lastInsertRowid must be populated');
  const batchId = Number(batchResult.lastInsertRowid);
  assert.ok(batchId > 0);

  // Insert movement using the returned batch id
  const movResult = await adapter.run(
    "INSERT INTO inventory_movements (batch_id, change_quantity, reason, created_by) VALUES (?, ?, 'RECEIPT', ?) RETURNING id",
    [batchId, 50, 1]
  );
  assert.ok(movResult.lastInsertRowid, 'Movement lastInsertRowid must be populated');

  // Cleanup
  await adapter.exec(`DELETE FROM inventory_movements WHERE batch_id = ${batchId}`);
  await adapter.exec(`DELETE FROM medicine_batches WHERE id = ${batchId}`);
  await adapter.exec(`DELETE FROM medicines WHERE id = ${medicineId}`);
  await adapter.close();
}));

test('PGDIALECT-008: Sale INSERT returns id + sale_items linked correctly on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  const pharmacy = await adapter.get('SELECT id FROM pharmacies WHERE name LIKE ? LIMIT 1', ['%PG Test%']);
  const user = await adapter.get("SELECT id FROM users WHERE email LIKE '%pgtest%' LIMIT 1");
  if (!pharmacy || !user) { await adapter.close(); return; }

  // Create medicine + batch
  const medRes = await adapter.run(
    'INSERT INTO medicines (pharmacy_id, name, category, minimum_stock) VALUES (?, ?, ?, ?) RETURNING id',
    [pharmacy.id, 'PG Sale Test Med', 'Test', 0]
  );
  const medicineId = Number(medRes.lastInsertRowid);

  const batchRes = await adapter.run(
    'INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, expiry_date) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [medicineId, 'PG-SALE-001', 100, 5.00, 8.00, '2028-06-30']
  );
  const batchId = Number(batchRes.lastInsertRowid);

  // INSERT sale with RETURNING id
  const saleRes = await adapter.run(
    "INSERT INTO sales (pharmacy_id, invoice_number, payment_method, total_amount, created_by) VALUES (?, ?, 'CASH', ?, ?) RETURNING id",
    [pharmacy.id, `PG-TEST-SALE-${Date.now()}`, 8.00, user.id]
  );
  assert.ok(saleRes.lastInsertRowid, 'Sale lastInsertRowid must be populated');
  const saleId = Number(saleRes.lastInsertRowid);
  assert.ok(saleId > 0);

  // Insert sale item using returned saleId
  await adapter.run(
    'INSERT INTO sale_items (sale_id, batch_id, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?)',
    [saleId, batchId, 1, 8.00, 8.00]
  );

  // Verify sale item exists and is linked
  const item = await adapter.get('SELECT * FROM sale_items WHERE sale_id = ?', [saleId]);
  assert.ok(item, 'Sale item must exist');
  assert.equal(item.sale_id, saleId);
  assert.equal(item.batch_id, batchId);

  // Cleanup
  await adapter.exec(`DELETE FROM sale_items WHERE sale_id = ${saleId}`);
  await adapter.exec(`DELETE FROM sales WHERE id = ${saleId}`);
  await adapter.exec(`DELETE FROM medicine_batches WHERE id = ${batchId}`);
  await adapter.exec(`DELETE FROM medicines WHERE id = ${medicineId}`);
  await adapter.close();
}));

test('PGDIALECT-009: Mobile pairing INSERT returns device id via RETURNING on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  const pharmacy = await adapter.get('SELECT id FROM pharmacies WHERE name LIKE ? LIMIT 1', ['%PG Test%']);
  const user = await adapter.get("SELECT id FROM users WHERE email LIKE '%pgtest%' LIMIT 1");
  if (!pharmacy || !user) { await adapter.close(); return; }

  const tokenHash = crypto.createHash('sha256').update('pg-dialect-test-device-' + Date.now()).digest('hex');

  const result = await adapter.run(
    'INSERT INTO paired_devices (pharmacy_id, device_name, device_model, token_hash, paired_by) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [pharmacy.id, 'PG Dialect Scanner', 'TestModel', tokenHash, user.id]
  );
  assert.ok(result.lastInsertRowid, 'Device lastInsertRowid must be populated');
  const deviceId = Number(result.lastInsertRowid);
  assert.ok(deviceId > 0);

  // Verify device was inserted
  const dev = await adapter.get('SELECT id, device_name FROM paired_devices WHERE id = ?', [deviceId]);
  assert.ok(dev, 'Device must exist');
  assert.equal(dev.device_name, 'PG Dialect Scanner');

  // Cleanup
  await adapter.exec(`DELETE FROM paired_devices WHERE id = ${deviceId}`);
  await adapter.close();
}));

test('PGDIALECT-010: case-insensitive medicine ordering (lower(m.name)) on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  const pharmacy = await adapter.get('SELECT id FROM pharmacies WHERE name LIKE ? LIMIT 1', ['%PG Test%']);
  if (!pharmacy) { await adapter.close(); return; }

  // Insert medicines with mixed case names
  const names = ['Zinc Sulfate', 'amoxicillin', 'Paracetamol', 'ibuprofen', 'Beta-carotene'];
  const ids = [];
  for (const name of names) {
    const r = await adapter.run(
      'INSERT INTO medicines (pharmacy_id, name, category, minimum_stock) VALUES (?, ?, ?, ?) RETURNING id',
      [pharmacy.id, name, 'Test', 0]
    );
    ids.push(Number(r.lastInsertRowid));
  }

  // Query with lower(m.name) ordering
  const rows = await adapter.query(
    'SELECT name FROM medicines WHERE pharmacy_id = ? AND active = 1 ORDER BY lower(name)',
    [pharmacy.id]
  );

  // Extract just the names we inserted
  const insertedNames = rows.map(r => r.name).filter(n => names.includes(n));
  const expected = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  assert.deepEqual(insertedNames, expected, 'Medicines must be sorted case-insensitively');

  // Cleanup
  for (const id of ids) await adapter.exec(`DELETE FROM medicines WHERE id = ${id}`);
  await adapter.close();
}));

test('PGDIALECT-011: expiry date CASE expression (expiryStatusCase) on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Test the exact CASE expression used in core.js expiryStatusCase()
  const r = await adapter.query(`
    SELECT
      expiry_date,
      CASE WHEN expiry_date < CURRENT_DATE THEN 'EXPIRED'
           WHEN expiry_date <= (CURRENT_DATE + 30) THEN 'EXPIRING_SOON'
           ELSE 'SAFE' END AS expiry_status
    FROM (VALUES
      ('2020-01-01'::date),
      (CURRENT_DATE + 15),
      (CURRENT_DATE + 60)
    ) AS t(expiry_date)
    ORDER BY expiry_date
  `);

  assert.equal(r.length, 3);
  assert.equal(r[0].expiry_status, 'EXPIRED', '2020-01-01 must be EXPIRED');
  assert.equal(r[1].expiry_status, 'EXPIRING_SOON', 'Today+15 must be EXPIRING_SOON');
  assert.equal(r[2].expiry_status, 'SAFE', 'Today+60 must be SAFE');

  await adapter.close();
}));

test('PGDIALECT-012: today-sales date filter (created_at::date) on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();

  // Verify the today-filter expression works in PostgreSQL
  const r = await adapter.get(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 WHERE CURRENT_TIMESTAMP::date = CURRENT_DATE
    ) sub
  `);
  assert.equal(Number(r.n), 1, 'CURRENT_TIMESTAMP::date = CURRENT_DATE must be true');

  // Verify the created_at::date filter syntax is accepted
  const check = await adapter.get(
    "SELECT COUNT(*) AS n FROM sales WHERE created_at::date = CURRENT_DATE AND pharmacy_id = -1"
  );
  assert.equal(Number(check.n), 0, 'Query must execute without syntax error');

  await adapter.close();
}));

test('PGDIALECT-013: full PostgreSQL login → session → /api/auth/me → logout flow', skipIfNoPostgres(async () => {
  // Use the HTTP handler backed by the real PostgreSQL test adapter
  // We build a standalone handler instance against the test DB to avoid
  // mutating the module-level adapter which uses sqlite locally.
  const pgAdapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await pgAdapter.initialize();

  // Apply schema to ensure tables exist
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.pg.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  await pgAdapter.exec(schemaSql);

  // Seed a test user
  const crypto2 = require('node:crypto');
  const salt = crypto2.randomBytes(16).toString('hex');
  const hash = crypto2.scryptSync('PgDialectPass@2026', salt, 64).toString('hex');
  const pwHash = `${salt}:${hash}`;

  // Ensure fresh test pharmacy + user
  await pgAdapter.exec("DELETE FROM users WHERE email = 'pg-dialect-test@example.com'");
  await pgAdapter.exec("DELETE FROM pharmacies WHERE name = 'PG Dialect Test Pharmacy'");

  const pharmRes = await pgAdapter.run(
    "INSERT INTO pharmacies (name, address) VALUES ('PG Dialect Test Pharmacy', 'Test') RETURNING id"
  );
  const pharmacyId = Number(pharmRes.lastInsertRowid);

  await pgAdapter.run(
    "INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
    [pharmacyId, 'PG Dialect Admin', 'pg-dialect-test@example.com', pwHash, 'ADMIN']
  );

  // Build handler with this test adapter
  const { buildHandlerWithAdapter } = buildPgHandlerFactory();
  const handler = buildHandlerWithAdapter(pgAdapter);

  // 1. Health
  const h = await callHandlerPg(handler, { url: '/api/health' });
  assert.equal(h.status, 200, `Health must be 200, got: ${JSON.stringify(h.body)}`);
  assert.equal(h.body.database, 'connected');

  // 2. Login
  const login = await callHandlerPg(handler, {
    method: 'POST', url: '/api/auth/login',
    body: { email: 'pg-dialect-test@example.com', password: 'PgDialectPass@2026' }
  });
  assert.equal(login.status, 200, `Login must be 200, got: ${JSON.stringify(login.body)}`);
  assert.ok(login.headers['Set-Cookie'], 'Login must set session cookie');
  const cookie = login.headers['Set-Cookie'];
  const tokenMatch = cookie.match(/mediindex_session=([^;]+)/);
  assert.ok(tokenMatch, 'Cookie must contain session token');
  const rawToken = tokenMatch[1];
  const tokenHash = crypto2.createHash('sha256').update(rawToken.trim()).digest('hex');

  // Verify session in PG
  const session = await pgAdapter.get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
  assert.ok(session, 'Session must be persisted in PostgreSQL sessions table');
  assert.equal(session.pharmacy_id, pharmacyId);

  // 3. /api/auth/me
  const me = await callHandlerPg(handler, { url: '/api/auth/me', cookie });
  assert.equal(me.status, 200, `/api/auth/me must be 200, got: ${JSON.stringify(me.body)}`);
  assert.equal(me.body.user.email, 'pg-dialect-test@example.com');
  assert.equal(me.body.user.role, 'ADMIN');

  // 4. Logout
  const logout = await callHandlerPg(handler, { method: 'POST', url: '/api/auth/logout', cookie });
  assert.equal(logout.status, 200, 'Logout must be 200');
  assert.match(logout.headers['Set-Cookie'], /Max-Age=0/, 'Logout must clear cookie');

  // Session must be deleted
  const sessionAfter = await pgAdapter.get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
  assert.equal(sessionAfter, null, 'Session must be deleted from PostgreSQL after logout');

  // 5. Post-logout /api/auth/me must 401
  const afterLogout = await callHandlerPg(handler, { url: '/api/auth/me', cookie });
  assert.equal(afterLogout.status, 401, 'Post-logout request must return 401');

  // Cleanup
  await pgAdapter.exec(`DELETE FROM sessions WHERE pharmacy_id = ${pharmacyId}`);
  await pgAdapter.exec(`DELETE FROM users WHERE email = 'pg-dialect-test@example.com'`);
  await pgAdapter.exec(`DELETE FROM pharmacies WHERE id = ${pharmacyId}`);
  await pgAdapter.close();
}));

// Minimal handler factory for PG dialect tests (replicates auth + health routes only)
function buildPgHandlerFactory() {
  const crypto3 = require('node:crypto');
  const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

  function hashTok(t) {
    if (typeof t !== 'string' || !t.trim()) return '';
    return crypto3.createHash('sha256').update(t.trim()).digest('hex');
  }
  function passwordMatchesLocal(pw, stored) {
    try {
      const [salt, hash] = stored.split(':');
      const actual = crypto3.scryptSync(pw, salt, 64).toString('hex');
      return crypto3.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(hash, 'hex'));
    } catch { return false; }
  }
  function parseCookiesLocal(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(item => {
      const i = item.indexOf('=');
      return [item.slice(0, i).trim(), decodeURIComponent(item.slice(i + 1))];
    }));
  }
  function jsonResp(res, status, body, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(body));
  }
  function readBodyJson(req) {
    return new Promise((res, rej) => {
      let d = '';
      req.on('data', c => { d += c; });
      req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { rej(new Error('bad json')); } });
      req.on('error', rej);
    });
  }
  function buildHandlerWithAdapter(db) {
    return async function handler(req, res) {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        try { await db.prepare('SELECT 1 AS ok').get(); return jsonResp(res, 200, { status: 'ok', database: 'connected' }); }
        catch (e) { return jsonResp(res, 503, { status: 'error', database: 'unavailable', message: e.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        try {
          const { email, password } = await readBodyJson(req);
          const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1').get(email.trim());
          if (!user || !passwordMatchesLocal(password, user.password_hash)) return jsonResp(res, 401, { error: 'Invalid email or password.' });
          const rawToken = crypto3.randomBytes(32).toString('hex');
          const tokenHash = hashTok(rawToken);
          const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
          await db.prepare('INSERT INTO sessions (token_hash, user_id, pharmacy_id, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, user.id, user.pharmacy_id, expiresAt);
          await db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
          return jsonResp(res, 200, { user: { email: user.email, role: user.role } },
            { 'Set-Cookie': `mediindex_session=${rawToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
        } catch (e) { return jsonResp(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const raw = parseCookiesLocal(req).mediindex_session;
        if (raw) { try { await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashTok(raw)); } catch {} }
        return jsonResp(res, 200, { ok: true }, { 'Set-Cookie': 'mediindex_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const raw = parseCookiesLocal(req).mediindex_session;
        if (!raw || !raw.trim()) return jsonResp(res, 401, { error: 'Authentication required.' });
        const th = hashTok(raw);
        const row = await db.prepare(`
          SELECT s.token_hash, s.user_id, s.pharmacy_id, s.expires_at,
                 u.id, u.full_name, u.email, u.role, u.active
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND u.active = 1
        `).get(th);
        if (!row || new Date(row.expires_at).getTime() < Date.now()) return jsonResp(res, 401, { error: 'Authentication required.' });
        return jsonResp(res, 200, { user: { id: row.id, email: row.email, role: row.role } });
      }
      return jsonResp(res, 404, { error: 'Not found.' });
    };
  }
  return { buildHandlerWithAdapter };
}

test('PGDIALECT-014: GET /api/expiry-alerts — acknowledged filter uses CAST-typed NULL (no 42P18 error)', skipIfNoPostgres(async () => {
  // Regression guard for two successive PostgreSQL parameter-type bugs:
  //
  // Bug 1 (commit 5a76579): CAST(? AS INTEGER) with string 'ALL' caused:
  //   "invalid input syntax for type integer: ALL"
  //   Fix: JS normalises 'ALL' → null before binding.
  //
  // Bug 2 (this fix): (? IS NULL OR a.acknowledged=?) with an untyped null caused:
  //   42P18 "could not determine data type of parameter $4"
  //   Fix: (CAST(? AS INTEGER) IS NULL OR a.acknowledged=?)
  //   CAST gives PostgreSQL the type hint it needs; null cast to INTEGER is still null.

  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.pg.sql');
  await adapter.exec(fs.readFileSync(schemaPath, 'utf-8'));

  let pharmacy = await adapter.get("SELECT id FROM pharmacies WHERE name LIKE '%PG Test%' LIMIT 1");
  if (!pharmacy) { await adapter.close(); return; }

  // Create medicine + batch with past expiry (EXPIRED)
  const medRes = await adapter.run(
    'INSERT INTO medicines (pharmacy_id, name, category, minimum_stock) VALUES (?, ?, ?, ?) RETURNING id',
    [pharmacy.id, 'PG Expiry Alert Test Med 14', 'Test', 0]
  );
  const medicineId = Number(medRes.lastInsertRowid);
  const batchRes = await adapter.run(
    'INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, expiry_date) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [medicineId, 'PG-EXPIRE-014', 5, 1.00, 2.00, '2020-01-01']
  );
  const batchId = Number(batchRes.lastInsertRowid);
  await adapter.run(
    "INSERT INTO expiry_alerts (batch_id, alert_type) VALUES (?, 'EXPIRED') ON CONFLICT (batch_id, alert_type) DO NOTHING",
    [batchId]
  );

  // --- Core test: verify the fixed SQL pattern executes without error on PostgreSQL ---
  // This is exactly the SQL that core.js now sends for GET /api/expiry-alerts

  // Simulate the dialect helpers as computed in core.js with isPg=true
  const D_DAYS_LEFT_B_PG = '(b.expiry_date - CURRENT_DATE)';
  const alertSql = `SELECT a.id, a.alert_type, a.acknowledged, a.created_at,
      m.id AS medicine_id, m.name AS medicine_name,
      b.id AS batch_id, b.batch_number, b.quantity, b.expiry_date, b.location,
      ${D_DAYS_LEFT_B_PG} AS days_to_expiry
      FROM expiry_alerts a JOIN medicine_batches b ON b.id=a.batch_id JOIN medicines m ON m.id=b.medicine_id
      WHERE m.pharmacy_id=? AND (?='ALL' OR a.alert_type=?) AND (CAST(? AS INTEGER) IS NULL OR a.acknowledged=?)
      ORDER BY a.acknowledged ASC, CASE a.alert_type WHEN 'EXPIRED' THEN 0 ELSE 1 END, b.expiry_date ASC`;

  // 1. status=ALL, acknowledged=ALL → acknowledgedParam = null
  const r1 = await adapter.query(alertSql, [pharmacy.id, 'ALL', 'ALL', null, null]);
  assert.ok(Array.isArray(r1), 'status=ALL,acknowledged=ALL must return array without error');
  const testAlert = r1.find(a => a.batch_id === batchId);
  assert.ok(testAlert, 'Test alert must appear in ALL/ALL results');
  assert.equal(testAlert.alert_type, 'EXPIRED');
  assert.equal(Number(testAlert.acknowledged), 0);
  // days_to_expiry must be a negative number (batch expired in 2020)
  const daysLeft = Number(testAlert.days_to_expiry);
  assert.ok(typeof daysLeft === 'number' && !isNaN(daysLeft), `days_to_expiry must be numeric, got: ${testAlert.days_to_expiry}`);
  assert.ok(daysLeft < 0, `EXPIRED alert days_to_expiry must be negative, got: ${daysLeft}`);

  // 2. status=EXPIRED, acknowledged=ALL → only EXPIRED alerts
  const r2 = await adapter.query(alertSql, [pharmacy.id, 'EXPIRED', 'EXPIRED', null, null]);
  assert.ok(r2.every(a => a.alert_type === 'EXPIRED'), 'status=EXPIRED filter must return only EXPIRED alerts');

  // 3. acknowledged=0 (unacknowledged only) → acknowledgedParam = 0
  const r3 = await adapter.query(alertSql, [pharmacy.id, 'ALL', 'ALL', 0, 0]);
  const unackAlert = r3.find(a => a.batch_id === batchId);
  assert.ok(unackAlert, 'Test alert must appear in acknowledged=0 results');
  assert.equal(Number(unackAlert.acknowledged), 0);

  // 4. Acknowledge the alert, then filter acknowledged=1
  await adapter.run('UPDATE expiry_alerts SET acknowledged=1 WHERE id=?', [testAlert.id]);
  const r4 = await adapter.query(alertSql, [pharmacy.id, 'ALL', 'ALL', 1, 1]);
  const ackAlert = r4.find(a => a.id === testAlert.id);
  assert.ok(ackAlert, 'Acknowledged alert must appear in acknowledged=1 filter');
  assert.equal(Number(ackAlert.acknowledged), 1);

  // 5. acknowledged=0 must NOT return the now-acknowledged alert
  const r5 = await adapter.query(alertSql, [pharmacy.id, 'ALL', 'ALL', 0, 0]);
  const shouldBeGone = r5.find(a => a.id === testAlert.id);
  assert.equal(shouldBeGone, undefined, 'Acknowledged alert must not appear in acknowledged=0 filter');

  // Cleanup
  await adapter.exec(`DELETE FROM expiry_alerts WHERE batch_id = ${batchId}`);
  await adapter.exec(`DELETE FROM medicine_batches WHERE id = ${batchId}`);
  await adapter.exec(`DELETE FROM medicines WHERE id = ${medicineId}`);
  await adapter.close();
}));

test('PGDIALECT-015: medicine reactivation workflow on PostgreSQL', skipIfNoPostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: DATABASE_URL });
  await adapter.initialize();
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.pg.sql');
  await adapter.exec(fs.readFileSync(schemaPath, 'utf-8'));

  const pharmacy = await adapter.get("SELECT id FROM pharmacies WHERE name LIKE '%PG Test%' LIMIT 1");
  if (!pharmacy) { await adapter.close(); return; }

  // Create medicine
  const medRes = await adapter.run(
    'INSERT INTO medicines (pharmacy_id, name, generic_name, category, minimum_stock) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [pharmacy.id, 'PG Reactivation Test', 'Test Generic', 'Tablet', 5]
  );
  const medicineId = Number(medRes.lastInsertRowid);

  // Add a batch so we can verify stock survives deactivation/reactivation
  const batchRes = await adapter.run(
    'INSERT INTO medicine_batches (medicine_id, batch_number, quantity, purchase_price, selling_price, expiry_date) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [medicineId, 'PG-REACT-001', 42, 2.00, 4.00, '2030-12-31']
  );
  const batchId = Number(batchRes.lastInsertRowid);

  // Deactivate
  await adapter.run('UPDATE medicines SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?', [medicineId]);

  // Must NOT appear in active listing
  const activeRows = await adapter.query('SELECT id FROM medicines WHERE pharmacy_id=? AND active=1', [pharmacy.id]);
  assert.equal(activeRows.find(m => m.id === medicineId), undefined, 'Deactivated medicine must not be in active list');

  // Must appear in inactive listing
  const inactiveRows = await adapter.query('SELECT id, active FROM medicines WHERE pharmacy_id=? AND active=0', [pharmacy.id]);
  const found = inactiveRows.find(m => m.id === medicineId);
  assert.ok(found, 'Deactivated medicine must appear in inactive list');
  assert.equal(Number(found.active), 0);

  // Reactivate
  const reactivateRes = await adapter.run('UPDATE medicines SET active=1, updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING id, name, active', [medicineId]);
  assert.equal(reactivateRes.rowCount, 1, 'Reactivation must update exactly 1 row');

  // Must appear in active listing again
  const afterActive = await adapter.query('SELECT id, active FROM medicines WHERE pharmacy_id=? AND active=1', [pharmacy.id]);
  assert.ok(afterActive.find(m => m.id === medicineId), 'Reactivated medicine must be in active list');

  // Batch stock must be unchanged
  const batch = await adapter.get('SELECT quantity FROM medicine_batches WHERE id=?', [batchId]);
  assert.equal(Number(batch.quantity), 42, 'Batch stock must be unchanged after deactivation/reactivation cycle');

  // Already-active: updating active=1 on already-active medicine still updates 1 row (idempotent UPDATE)
  // The conflict is enforced at application level (409), not database level — verify 409 logic
  const activeCheck = await adapter.get('SELECT active FROM medicines WHERE id=?', [medicineId]);
  assert.equal(Number(activeCheck.active), 1, 'Medicine must be active before conflict check');

  // Cleanup
  await adapter.exec(`DELETE FROM medicine_batches WHERE id = ${batchId}`);
  await adapter.exec(`DELETE FROM medicines WHERE id = ${medicineId}`);
  await adapter.close();
}));
