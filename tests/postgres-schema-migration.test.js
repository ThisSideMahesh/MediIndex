'use strict';
/**
 * tests/postgres-schema-migration.test.js
 *
 * REGRESSION: the deployed PostgreSQL/Neon database never received DDL appended
 * to db/schema.pg.sql, because PostgreSQLAdapter.initialize() only opened a
 * connection pool — it never applied schema (unlike SQLiteAdapter.initialize(),
 * which calls applySchema() + applyMigrations()). Schema was applied only by
 * scripts/bootstrap-postgres.js (manual one-off) or by the integration tests.
 *
 * Consequence: GET /api/inter-pharmacy/requests threw
 *   SQLSTATE 42P01  relation "medicine_redistribution_requests" does not exist
 * which escaped the route (no try/catch) and became a Vercel
 * FUNCTION_INVOCATION_FAILED non-JSON 500 in the browser.
 *
 * Why no existing test caught it: core.js chooses PostgreSQL only when
 * DATABASE_URL is set, but the project's "PostgreSQL suite" sets
 * POSTGRES_TEST_URL — so core.js ran on SQLite even during that run, and
 * postgres-integration.test.js exercises the adapter directly (applying the
 * schema itself) without ever routing through the HTTP handler.
 *
 * These tests close that gap by driving the real handler against a real
 * PostgreSQL database whose schema is deliberately NOT pre-applied.
 *
 * Skipped unless POSTGRES_TEST_URL is set (same convention as the other PG tests).
 * Creates and drops its own throwaway database; never touches existing data.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');
const { EventEmitter } = require('node:events');

const PG_URL = process.env.POSTGRES_TEST_URL || '';
const HAS_PG = !!PG_URL;

// Derive an admin URL (postgres db) and a throwaway DB name from POSTGRES_TEST_URL
const THROWAWAY_DB = 'mediindex_schemamig_test';
function adminUrl() { const u = new URL(PG_URL); u.pathname = '/postgres'; return u.toString(); }
function throwawayUrl() { const u = new URL(PG_URL); u.pathname = '/' + THROWAWAY_DB; return u.toString(); }

function skipIfNoPg(fn) {
  return async (t) => {
    if (!HAS_PG) { t.skip('POSTGRES_TEST_URL not set'); return; }
    return fn(t);
  };
}

/** Returns schema.pg.sql truncated to exclude the inter-pharmacy migration block. */
function preFeatureSchema() {
  const full = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.pg.sql'), 'utf-8');
  const marker = '-- INTER-PHARMACY NEAR-EXPIRY REDISTRIBUTION (additive migration)';
  const idx = full.indexOf(marker);
  if (idx < 0) return full;
  return full.slice(0, full.lastIndexOf('-- ====', idx));
}

async function withThrowawayDb(callback) {
  const { Client } = require('pg');
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${THROWAWAY_DB}`);
  await admin.query(`CREATE DATABASE ${THROWAWAY_DB}`);
  await admin.end();
  try {
    return await callback();
  } finally {
    const cleanup = new Client({ connectionString: adminUrl() });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE IF EXISTS ${THROWAWAY_DB}`); } catch {}
    await cleanup.end();
  }
}

/** Seeds the pre-feature schema + one pharmacy + one ADMIN user + a live session. */
async function seedPreFeatureDb() {
  const { Client } = require('pg');
  const c = new Client({ connectionString: throwawayUrl() });
  await c.connect();
  await c.query(preFeatureSchema());
  await c.query("INSERT INTO pharmacies (name, address) VALUES ('Migration Test Pharmacy', 'Test')");
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('MediIndex@2026', salt, 64).toString('hex');
  await c.query(
    "INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (1, 'Mig Admin', 'migadmin@mediindex.local', $1, 'ADMIN')",
    [`${salt}:${hash}`]
  );
  // Insert a session directly so tests can authenticate with a GET (no request body,
  // which keeps the synthetic request harness free of body-timing artifacts).
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  await c.query(
    'INSERT INTO sessions (token_hash, user_id, pharmacy_id, expires_at) VALUES ($1, 1, 1, $2)',
    [tokenHash, expiresAt]
  );
  // Verify the target table is genuinely absent — this is the deployed-state precondition
  const present = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name='medicine_redistribution_requests'"
  );
  await c.end();
  return { rawToken, tableAbsent: present.rows.length === 0 };
}

/**
 * Loads a FRESH copy of core.js bound to the throwaway PostgreSQL database.
 * core.js reads DATABASE_URL at module load, so the module cache must be cleared.
 */
function loadCoreAgainstThrowaway() {
  const corePath    = require.resolve('../core');
  const dbIndexPath = require.resolve('../db/index');
  const pgPath      = require.resolve('../db/postgres-adapter');
  delete require.cache[corePath];
  delete require.cache[dbIndexPath];
  delete require.cache[pgPath];
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = throwawayUrl();
  try {
    return { core: require('../core'), restore: () => {
      if (prev === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev;
      delete require.cache[corePath];
      delete require.cache[dbIndexPath];
      delete require.cache[pgPath];
    }};
  } catch (err) {
    if (prev === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev;
    throw err;
  }
}

/** GET-only request driver (no body ⇒ no emit-ordering artifact). */
function httpGet(handler, url, cookie) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method  = 'GET';
    req.url     = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}) };
    const res = {
      _h: {},
      writeHead(status, headers) { this.status = status; this._h = headers || {}; },
      end(payload) {
        let body = null;
        try { body = payload ? JSON.parse(payload) : null; } catch { body = null; }
        resolve({ status: this.status, headers: this._h, body, raw: payload });
      }
    };
    handler(req, res).catch(reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('PGMIG-001: PostgreSQLAdapter exposes ensureSchema()', () => {
  const { PostgreSQLAdapter } = require('../db/postgres-adapter');
  const a = new PostgreSQLAdapter({ connectionString: 'postgresql://u:p@localhost:5432/x' });
  assert.equal(typeof a.ensureSchema, 'function',
    'ensureSchema() must exist so the deployed PG database self-migrates');
});

test('PGMIG-002: GET /api/inter-pharmacy/requests works on a PG database with un-applied schema',
  skipIfNoPg(async () => {
    await withThrowawayDb(async () => {
      const { rawToken, tableAbsent } = await seedPreFeatureDb();
      assert.equal(tableAbsent, true,
        'Precondition: medicine_redistribution_requests must be absent (deployed state)');

      const { core, restore } = loadCoreAgainstThrowaway();
      try {
        assert.equal(core.adapter.type, 'postgres', 'core.js must be bound to PostgreSQL');

        // This is the exact request the Request History UI makes.
        // Before the fix this threw SQLSTATE 42P01 and escaped as a 500.
        const res = await httpGet(core.handler,
          '/api/inter-pharmacy/requests?role=ALL&status=ALL',
          `mediindex_session=${rawToken}`);

        assert.equal(res.status, 200,
          `Expected 200, got ${res.status}. Body: ${res.raw}`);
        assert.ok(Array.isArray(res.body.requests), 'Response must contain a requests array');

        // The missing table must now have been created by ensureSchema()
        const tbl = await core.adapter.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name='medicine_redistribution_requests'"
        );
        assert.equal(tbl.length, 1, 'ensureSchema() must have created the missing table');

        // The missing pharmacies columns must now exist too
        const cols = await core.adapter.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='pharmacies' AND column_name IN ('latitude','longitude')"
        );
        assert.equal(cols.length, 2, 'ensureSchema() must have added latitude and longitude');

        await core.adapter.close();
      } finally {
        restore();
      }
    });
  }));

test('PGMIG-003: repeated requests are idempotent (ensureSchema runs at most once, no error)',
  skipIfNoPg(async () => {
    await withThrowawayDb(async () => {
      const { rawToken } = await seedPreFeatureDb();
      const { core, restore } = loadCoreAgainstThrowaway();
      try {
        const cookie = `mediindex_session=${rawToken}`;
        const r1 = await httpGet(core.handler, '/api/inter-pharmacy/requests?role=ALL&status=ALL', cookie);
        const r2 = await httpGet(core.handler, '/api/inter-pharmacy/requests?role=SENDER&status=ALL', cookie);
        const r3 = await httpGet(core.handler, '/api/inter-pharmacy/requests?role=RECIPIENT&status=ACCEPTED', cookie);
        assert.equal(r1.status, 200, `role=ALL failed: ${r1.raw}`);
        assert.equal(r2.status, 200, `role=SENDER failed: ${r2.raw}`);
        assert.equal(r3.status, 200, `role=RECIPIENT failed: ${r3.raw}`);
        await core.adapter.close();
      } finally {
        restore();
      }
    });
  }));

// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENT COLD-START SAFETY (advisory-lock serialization)
//
// Without serialization, PostgreSQL's CREATE TABLE IF NOT EXISTS is not
// race-free: concurrent initializers that both observe an object as absent will
// both attempt creation, and losers fail with 23505 (unique violation on the
// pg_type/pg_class catalog indexes) or 42P07 (relation already exists).
// Measured before the fix: 7 of 8 concurrent initializers failed.
// ─────────────────────────────────────────────────────────────────────────────

test('PGMIG-005: advisory lock identifier is deterministic and namespaced to MediIndex', () => {
  const a = require('../db/postgres-adapter');
  // Re-require through a fresh module registry entry to confirm stability
  delete require.cache[require.resolve('../db/postgres-adapter')];
  const b = require('../db/postgres-adapter');
  assert.equal(typeof a.SCHEMA_LOCK_ID, 'string');
  assert.match(a.SCHEMA_LOCK_ID, /^-?\d+$/, 'lock id must be an integer string for bigint binding');
  assert.equal(a.SCHEMA_LOCK_ID, b.SCHEMA_LOCK_ID, 'lock id must be deterministic across loads');
  assert.equal(a.SCHEMA_LOCK_NAMESPACE, 'mediindex:schema:init:v1',
    'lock namespace must be dedicated to MediIndex schema initialization');
});

test('PGMIG-006: schema verification detects missing objects (does not blindly trust DDL)',
  skipIfNoPg(async () => {
    await withThrowawayDb(async () => {
      await seedPreFeatureDb();
      const { PostgreSQLAdapter, parseExpectedSchemaObjects, verifySchemaObjects,
              describeMissingSchemaObjects } = require('../db/postgres-adapter');
      const ad = new PostgreSQLAdapter({ connectionString: throwawayUrl() });
      ad.initialize();
      const client = await ad.getPool().connect();
      try {
        // Pre-feature DB: the new table is genuinely absent, so verification must fail
        const expected = parseExpectedSchemaObjects(
          fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.pg.sql'), 'utf-8'));
        assert.equal(await verifySchemaObjects(client, expected), false,
          'verification must report incomplete before the schema is applied');
        const missing = await describeMissingSchemaObjects(client, expected);
        assert.match(missing, /medicine_redistribution_requests/,
          'missing report must name the absent table');

        // After applying, verification must pass
        await ad.ensureSchema();
        assert.equal(await verifySchemaObjects(client, expected), true,
          'verification must report complete after ensureSchema()');
      } finally {
        client.release();
        await ad.close();
      }
    });
  }));

test('PGMIG-007: concurrent cold starts all succeed with no 23505/42P07 and a correct schema',
  skipIfNoPg(async () => {
    await withThrowawayDb(async () => {
      // Deliberately start from a database missing the new objects — the exact
      // condition under which the race occurs.
      const { tableAbsent } = await seedPreFeatureDb();
      assert.equal(tableAbsent, true, 'Precondition: new table must be absent');

      const { PostgreSQLAdapter } = require('../db/postgres-adapter');
      const CONCURRENCY = 8;
      const adapters = Array.from({ length: CONCURRENCY }, () => {
        const a = new PostgreSQLAdapter({ connectionString: throwawayUrl() });
        a.initialize();
        return a;
      });

      try {
        // Each adapter is an independent "instance" with its own pool and memo,
        // mirroring separate Vercel containers cold-starting simultaneously.
        const results = await Promise.allSettled(adapters.map(a => a.ensureSchema()));

        const rejected = results.filter(r => r.status === 'rejected');
        const raceFailures = rejected.filter(r =>
          r.reason && (r.reason.code === '23505' || r.reason.code === '42P07'));

        assert.equal(raceFailures.length, 0,
          'No initializer may fail with 23505/42P07: ' +
          raceFailures.map(r => `${r.reason.code} ${r.reason.message}`).join(' | '));

        assert.equal(rejected.length, 0,
          'All concurrent initializers must succeed. Failures: ' +
          rejected.map(r => r.reason && r.reason.message).join(' | '));

        // Verify the resulting schema is complete and not duplicated
        const probe = adapters[0];
        const tables = await probe.query(
          "SELECT table_name, COUNT(*) AS c FROM information_schema.tables WHERE table_schema = current_schema() GROUP BY table_name");
        const dupes = tables.filter(t => Number(t.c) > 1);
        assert.equal(dupes.length, 0, 'No duplicate table definitions may exist');

        const redis = await probe.get(
          "SELECT table_name FROM information_schema.tables WHERE table_name = 'medicine_redistribution_requests'");
        assert.ok(redis, 'medicine_redistribution_requests must exist after concurrent init');

        const cols = await probe.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='pharmacies' AND column_name IN ('latitude','longitude')");
        assert.equal(cols.length, 2, 'pharmacies.latitude and .longitude must exist');

        const idx = await probe.query(
          "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'idx_redistrib%'");
        assert.equal(idx.length, 4, 'all four redistribution indexes must exist');

        // No advisory lock may be left held
        const held = await probe.get("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
        assert.equal(Number(held.n), 0, 'advisory lock must be released by every initializer');
      } finally {
        await Promise.all(adapters.map(a => a.close().catch(() => {})));
      }
    });
  }));

test('PGMIG-008: endpoint remains tenant-scoped on PostgreSQL after auto-migration',
  skipIfNoPg(async () => {
    await withThrowawayDb(async () => {
      const { rawToken } = await seedPreFeatureDb();
      const { core, restore } = loadCoreAgainstThrowaway();
      try {
        const cookie = `mediindex_session=${rawToken}`;
        // Force schema creation first
        await httpGet(core.handler, '/api/inter-pharmacy/requests?role=ALL&status=ALL', cookie);

        // Create a SECOND and THIRD pharmacy and a request between them.
        // The authenticated session belongs to pharmacy 1, which is neither party.
        await core.adapter.run("INSERT INTO pharmacies (name, latitude, longitude) VALUES ('Foreign X', 19.0, 72.8)");
        await core.adapter.run("INSERT INTO pharmacies (name, latitude, longitude) VALUES ('Foreign Y', 19.1, 72.9)");
        const px = (await core.adapter.get("SELECT id FROM pharmacies WHERE name='Foreign X'")).id;
        const py = (await core.adapter.get("SELECT id FROM pharmacies WHERE name='Foreign Y'")).id;
        await core.adapter.run("INSERT INTO medicines (pharmacy_id, name, minimum_stock) VALUES (?, 'ForeignMed', 0)", [px]);
        const mx = (await core.adapter.get("SELECT id FROM medicines WHERE pharmacy_id=? AND name='ForeignMed'", [px])).id;
        await core.adapter.run(
          "INSERT INTO medicine_batches (medicine_id, batch_number, quantity, selling_price, expiry_date) VALUES (?, 'FX-1', 10, 5, '2030-01-01')",
          [mx]
        );
        const bx = (await core.adapter.get("SELECT id FROM medicine_batches WHERE medicine_id=? AND batch_number='FX-1'", [mx])).id;
        const ikey = crypto.createHash('sha256').update(`${px}|${py}|${mx}|${bx}`).digest('hex');
        await core.adapter.run(
          `INSERT INTO medicine_redistribution_requests
             (idempotency_key, sender_pharmacy_id, recipient_pharmacy_id, medicine_id, source_batch_id,
              requested_quantity, status)
           VALUES (?, ?, ?, ?, ?, 5, 'ACCEPTED')`,
          [ikey, px, py, mx, bx]
        );

        // Pharmacy 1 must not see the foreign request under ANY role filter
        for (const role of ['ALL', 'SENDER', 'RECIPIENT']) {
          const res = await httpGet(core.handler, `/api/inter-pharmacy/requests?role=${role}&status=ALL`, cookie);
          assert.equal(res.status, 200, `role=${role} failed: ${res.raw}`);
          const leaked = res.body.requests.filter(r => r.sender_pharmacy_id === px || r.recipient_pharmacy_id === py);
          assert.equal(leaked.length, 0,
            `TENANT LEAK: role=${role} exposed a request belonging to other pharmacies`);
        }

        await core.adapter.close();
      } finally {
        restore();
      }
    });
  }));
