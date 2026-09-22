'use strict';
/**
 * tests/medicine-requests-api.test.js
 *
 * PHASE 3 — HTTP API for manual medicine requests.
 *
 * Exercises the real route handlers end to end: authentication, authorization,
 * tenant isolation, idempotency, validation, state conflicts and JSON error
 * shapes.
 *
 * Two deliberate harness choices:
 *
 *  1. A REAL http server is used rather than the synthetic EventEmitter harness
 *     found in the older test files. On PostgreSQL the handler awaits
 *     ensureSchema() before reading the request body, and a bare EventEmitter
 *     loses 'data' events emitted before listeners attach. A real
 *     IncomingMessage is a paused stream that buffers until read, so this is
 *     both faithful to production and immune to that ordering artifact.
 *
 *  2. core.js is loaded against an ISOLATED database (a temp DATA_DIR for
 *     SQLite, a throwaway database for PostgreSQL) so these tests never touch
 *     the developer's working database. When POSTGRES_TEST_URL is set the whole
 *     suite also runs against real PostgreSQL, which is the first HTTP-level
 *     PostgreSQL coverage in the project.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const PG_URL = process.env.POSTGRES_TEST_URL || '';
const HAS_PG = !!PG_URL;
const PASSWORD = 'MediIndex@2026';

const COORDS = {
  mumbai:  { lat: 19.0760, lng: 72.8777 },
  near:    { lat: 19.1197, lng: 72.9051 },   // ~5.5 km
  near2:   { lat: 19.1550, lng: 72.9200 },   // ~9.9 km
  mid:     { lat: 19.2183, lng: 72.9781 },   // ~18 km
  delhi:   { lat: 28.6139, lng: 77.2090 }    // ~1150 km — outside every zone
};

const CORE_MODULES = ['../core', '../db/index', '../db/postgres-adapter', '../db/sqlite-adapter', '../medicine-requests'];
function clearCoreCache() {
  for (const m of CORE_MODULES) { try { delete require.cache[require.resolve(m)]; } catch {} }
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

let keyN = 0;
const newKey = () => `api-${Date.now()}-${keyN++}-${crypto.randomBytes(4).toString('hex')}`;

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/** Starts a real HTTP server around core.handler and returns a request helper. */
async function startServer(core) {
  const server = http.createServer((req, res) => {
    core.handler(req, res).catch(err => {
      // Mirrors api/index.js: unexpected failures must still be JSON.
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Internal server error.' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  function request({ method = 'GET', url, body, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path: url, method,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(cookie ? { cookie } : {})
        }
      }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            contentType: res.headers['content-type'] || '',
            body: parsed,
            raw
          });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  return { server, request, close: () => new Promise(r => server.close(r)) };
}

/** Creates an isolated SQLite-backed harness (temp DATA_DIR, seeded ADMIN+STAFF). */
async function makeSqliteHarness() {
  const dir = fs.mkdtempSync(path.join('/tmp', 'mi-api-'));
  const prevData = process.env.DATA_DIR;
  const prevUrl = process.env.DATABASE_URL;
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  clearCoreCache();
  const core = require('../core');
  const srv = await startServer(core);
  return {
    kind: 'sqlite', core, db: core.db, request: srv.request,
    async cleanup() {
      await srv.close();
      try { core.adapter.close(); } catch {}
      if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData;
      if (prevUrl !== undefined) process.env.DATABASE_URL = prevUrl;
      clearCoreCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Creates an isolated PostgreSQL-backed harness (throwaway DB, seeded ADMIN+STAFF). */
async function makePgHarness() {
  const { Client } = require('pg');
  const dbName = `mi_api_${crypto.randomBytes(5).toString('hex')}`;
  const adminUrl = (() => { const u = new URL(PG_URL); u.pathname = '/postgres'; return u.toString(); })();
  const dbUrl    = (() => { const u = new URL(PG_URL); u.pathname = '/' + dbName; return u.toString(); })();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const prevUrl = process.env.DATABASE_URL;
  const prevData = process.env.DATA_DIR;
  process.env.DATABASE_URL = dbUrl;
  clearCoreCache();
  const core = require('../core');
  await core.adapter.ensureSchema();

  // schema.pg.sql carries no seed data, so create the demo tenant explicitly.
  await core.db.run("INSERT INTO pharmacies (name, address) VALUES ('MediIndex Demo Pharmacy', 'Seed')");
  const ph = await core.db.get('SELECT id FROM pharmacies LIMIT 1');
  const hash = core.passwordHash(PASSWORD);
  await core.db.run(
    'INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [ph.id, 'Demo Administrator', 'admin@mediindex.local', hash, 'ADMIN']
  );
  await core.db.run(
    'INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [ph.id, 'Demo Pharmacy Staff', 'staff@mediindex.local', hash, 'STAFF']
  );

  const srv = await startServer(core);
  return {
    kind: 'postgres', core, db: core.db, request: srv.request,
    async cleanup() {
      await srv.close();
      try { await core.adapter.close(); } catch {}
      if (prevUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevUrl;
      if (prevData !== undefined) process.env.DATA_DIR = prevData;
      clearCoreCache();
      const a = new Client({ connectionString: adminUrl });
      await a.connect();
      try { await a.query(`DROP DATABASE IF EXISTS ${dbName}`); } catch {}
      await a.end();
    }
  };
}

/** Runs a test body against SQLite, and against PostgreSQL when configured. */
function forEachDb(name, body) {
  test(`${name} [sqlite]`, async () => {
    const h = await makeSqliteHarness();
    try { await body(h); } finally { await h.cleanup(); }
  });
  test(`${name} [postgres]`, async (t) => {
    if (!HAS_PG) { t.skip('POSTGRES_TEST_URL not set'); return; }
    const h = await makePgHarness();
    try { await body(h); } finally { await h.cleanup(); }
  });
}

// ─── seeding helpers (operate through the harness db) ────────────────────────

async function login(h, email) {
  const res = await h.request({ method: 'POST', url: '/api/auth/login', body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, `login failed for ${email}: ${res.raw}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

async function setCoords(h, pharmacyId, coords) {
  await h.db.run('UPDATE pharmacies SET latitude = ?, longitude = ? WHERE id = ?', [coords.lat, coords.lng, pharmacyId]);
}

async function demoPharmacyId(h) {
  const row = await h.db.get('SELECT id FROM pharmacies ORDER BY id LIMIT 1');
  return Number(row.id);
}

async function addMedicine(h, pharmacyId, name) {
  await h.db.run('INSERT INTO medicines (pharmacy_id, name, minimum_stock) VALUES (?, ?, 0)', [pharmacyId, name]);
  const row = await h.db.get('SELECT id FROM medicines WHERE pharmacy_id = ? AND lower(name) = lower(?)', [pharmacyId, name]);
  return Number(row.id);
}

async function addBatch(h, medicineId, batchNumber, qty, days = 365) {
  await h.db.run(
    'INSERT INTO medicine_batches (medicine_id, batch_number, quantity, selling_price, expiry_date) VALUES (?, ?, ?, 5.0, ?)',
    [medicineId, batchNumber, qty, daysFromNow(days)]
  );
}

/** Creates a second tenant with its own ADMIN + STAFF, coordinates and stock. */
async function addTenant(h, name, coords, { medicine = 'Paracetamol', stock = 0 } = {}) {
  await h.db.run('INSERT INTO pharmacies (name, address, latitude, longitude) VALUES (?, ?, ?, ?)',
    [name, name, coords.lat, coords.lng]);
  const ph = await h.db.get('SELECT id FROM pharmacies WHERE name = ?', [name]);
  const pid = Number(ph.id);
  const hash = h.core.passwordHash(PASSWORD);
  const adminEmail = `admin-${pid}@t.com`;
  const staffEmail = `staff-${pid}@t.com`;
  await h.db.run('INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [pid, `${name} Admin`, adminEmail, hash, 'ADMIN']);
  await h.db.run('INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [pid, `${name} Staff`, staffEmail, hash, 'STAFF']);
  if (medicine) {
    const mid = await addMedicine(h, pid, medicine);
    if (stock > 0) await addBatch(h, mid, `${pid}-LOT`, stock);
  }
  return { pharmacyId: pid, adminEmail, staffEmail };
}

/** Standard setup: demo pharmacy is the requester in Mumbai with Paracetamol. */
async function setupRequester(h) {
  const pid = await demoPharmacyId(h);
  await setCoords(h, pid, COORDS.mumbai);
  await addMedicine(h, pid, 'Paracetamol');
  return pid;
}

async function createRequest(h, cookie, overrides = {}) {
  return h.request({
    method: 'POST', url: '/api/inter-pharmacy/medicine-requests', cookie,
    body: { medicineName: 'Paracetamol', requestedQuantity: 50, idempotencyKey: newKey(), ...overrides }
  });
}

async function inventorySnapshot(h) {
  const batches = await h.db.query('SELECT id, quantity FROM medicine_batches ORDER BY id');
  const mv = await h.db.get('SELECT COUNT(*) AS n FROM inventory_movements');
  return { batches: batches.map(b => `${b.id}:${b.quantity}`).join('|'), movements: Number(mv.n) };
}

/** Asserts a response is JSON and free of internal detail. */
function assertSafeJson(res) {
  assert.match(res.contentType, /application\/json/, `expected JSON content-type, got "${res.contentType}"`);
  assert.notEqual(res.body, undefined, `expected a parseable JSON body, got: ${res.raw}`);
  const text = res.raw || '';
  assert.doesNotMatch(text, /<html|<!DOCTYPE/i, 'must never return HTML');
  assert.doesNotMatch(text, /\bat \/|\bat Object\.|node:internal/, 'must never return a stack trace');
  assert.doesNotMatch(text, /postgresql:\/\/|postgres:\/\/|password=/i, 'must never leak a connection string');
  assert.doesNotMatch(text, /SELECT .* FROM |INSERT INTO |UPDATE .* SET /i, 'must never leak SQL');
  assert.doesNotMatch(text, /token_hash|password_hash|mediindex_session=/i, 'must never leak credentials or sessions');
}

const ALL_ENDPOINTS = [
  { method: 'POST', url: '/api/inter-pharmacy/medicine-requests', body: { medicineName: 'X', requestedQuantity: 1, idempotencyKey: 'k' } },
  { method: 'GET',  url: '/api/inter-pharmacy/medicine-requests' },
  { method: 'GET',  url: '/api/inter-pharmacy/medicine-requests/incoming' },
  { method: 'GET',  url: '/api/inter-pharmacy/medicine-requests/1' },
  { method: 'POST', url: '/api/inter-pharmacy/medicine-requests/1/advance', body: {} },
  { method: 'POST', url: '/api/inter-pharmacy/medicine-requests/1/offer', body: { offeredQuantity: 1 } },
  { method: 'POST', url: '/api/inter-pharmacy/medicine-requests/1/decline', body: {} },
  { method: 'POST', url: '/api/inter-pharmacy/medicine-requests/1/cancel', body: {} },
  { method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', body: {} }
];

// ═════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('API-001: every endpoint rejects unauthenticated access with JSON 401', async (h) => {
  for (const ep of ALL_ENDPOINTS) {
    const res = await h.request(ep);
    assert.equal(res.status, 401, `${ep.method} ${ep.url} must be 401, got ${res.status}`);
    assertSafeJson(res);
    assert.match(res.body.error, /Authentication required/i);
  }
});

forEachDb('API-002: an invalid session cookie is rejected with 401', async (h) => {
  const res = await h.request({
    method: 'GET', url: '/api/inter-pharmacy/medicine-requests',
    cookie: 'mediindex_session=' + 'f'.repeat(64)
  });
  assert.equal(res.status, 401);
  assertSafeJson(res);
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTHORIZATION (STAFF and ADMIN both allowed for normal operation)
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('API-010: STAFF can create a request', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });   // a supplier exists
  const cookie = await login(h, 'staff@mediindex.local');
  const res = await createRequest(h, cookie);
  assert.equal(res.status, 201, res.raw);
  assertSafeJson(res);
  assert.equal(res.body.request.status, 'OPEN');
  assert.equal(res.body.request.requestedQuantity, 50);
  assert.equal(res.body.created, true);
});

forEachDb('API-011: ADMIN can create a request', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const cookie = await login(h, 'admin@mediindex.local');
  const res = await createRequest(h, cookie);
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.request.status, 'OPEN');
});

forEachDb('API-012: STAFF and ADMIN can both list their pharmacy requests', async (h) => {
  await setupRequester(h);
  const staff = await login(h, 'staff@mediindex.local');
  const admin = await login(h, 'admin@mediindex.local');
  await createRequest(h, staff);

  for (const [label, cookie] of [['staff', staff], ['admin', admin]]) {
    const res = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests', cookie });
    assert.equal(res.status, 200, `${label}: ${res.raw}`);
    assertSafeJson(res);
    assert.equal(res.body.requests.length, 1, `${label} must see the pharmacy's request`);
    assert.equal(res.body.total, 1);
  }
});

forEachDb('API-013: STAFF and ADMIN can both view incoming requests', async (h) => {
  await setupRequester(h);
  const t = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const requester = await login(h, 'staff@mediindex.local');
  await createRequest(h, requester);

  for (const email of [t.staffEmail, t.adminEmail]) {
    const cookie = await login(h, email);
    const res = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/incoming', cookie });
    assert.equal(res.status, 200, res.raw);
    assertSafeJson(res);
    assert.equal(res.body.count, 1, `${email} must see the incoming request`);
  }
});

forEachDb('API-014: the maintenance expire endpoint is ADMIN-only', async (h) => {
  await setupRequester(h);
  const staff = await login(h, 'staff@mediindex.local');
  const admin = await login(h, 'admin@mediindex.local');

  const denied = await h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', cookie: staff, body: {} });
  assert.equal(denied.status, 403, 'STAFF must not run maintenance');
  assertSafeJson(denied);

  const allowed = await h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', cookie: admin, body: {} });
  assert.equal(allowed.status, 200, allowed.raw);
  assert.equal(allowed.body.scope, 'PHARMACY', 'the sweep must be tenant-scoped');
});

forEachDb('API-015: coordinate updates remain ADMIN-only', async (h) => {
  const staff = await login(h, 'staff@mediindex.local');
  const admin = await login(h, 'admin@mediindex.local');

  const denied = await h.request({ method: 'PUT', url: '/api/pharmacies/coordinates', cookie: staff, body: { latitude: 1, longitude: 1 } });
  assert.equal(denied.status, 403, 'STAFF must not change coordinates');
  assertSafeJson(denied);

  const ok = await h.request({ method: 'PUT', url: '/api/pharmacies/coordinates', cookie: admin, body: { latitude: 19.076, longitude: 72.8777 } });
  assert.equal(ok.status, 200, ok.raw);
});

// ═════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('API-020: a client-supplied pharmacy id cannot impersonate another pharmacy', async (h) => {
  await setupRequester(h);
  const other = await addTenant(h, 'Tenant Other', COORDS.near, { stock: 10 });
  const cookie = await login(h, 'staff@mediindex.local');

  for (const field of ['pharmacyId', 'pharmacy_id', 'requesterPharmacyId']) {
    const res = await createRequest(h, cookie, { [field]: other.pharmacyId });
    assert.equal(res.status, 400, `${field} must be rejected`);
    assertSafeJson(res);
    assert.match(res.body.error, /must not supply/i);
  }

  // Nothing was created for either pharmacy
  const mine = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests', cookie });
  assert.equal(mine.body.requests.length, 0);
  const count = await h.db.get('SELECT COUNT(*) AS n FROM medicine_requests');
  assert.equal(Number(count.n), 0);
});

forEachDb('API-021: an unrelated pharmacy gets 404 on request detail (no existence leak)', async (h) => {
  const requesterPid = await setupRequester(h);
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });        // will be contacted
  const unrelated = await addTenant(h, 'Tenant Far', COORDS.delhi, { stock: 500 }); // never contacted

  const reqCookie = await login(h, 'staff@mediindex.local');
  const created = await createRequest(h, reqCookie);
  const id = created.body.request.id;

  const res = await h.request({
    method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`,
    cookie: await login(h, unrelated.staffEmail)
  });
  assert.equal(res.status, 404, 'an unrelated pharmacy must get 404, not 403');
  assertSafeJson(res);
  assert.doesNotMatch(res.raw, /Paracetamol/, 'must not leak the medicine');
  assert.doesNotMatch(res.raw, /Demo Pharmacy/i, 'must not leak the requester');
});

forEachDb('API-022: an uncontacted pharmacy cannot offer or decline (404)', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const unrelated = await addTenant(h, 'Tenant Far', COORDS.delhi, { stock: 500 });

  const reqCookie = await login(h, 'staff@mediindex.local');
  const created = await createRequest(h, reqCookie);
  const id = created.body.request.id;
  const outsider = await login(h, unrelated.staffEmail);

  const offer = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: outsider, body: { offeredQuantity: 10 } });
  assert.equal(offer.status, 404);
  assertSafeJson(offer);

  const decline = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/decline`, cookie: outsider, body: {} });
  assert.equal(decline.status, 404);
  assertSafeJson(decline);

  const fresh = await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(Number(fresh.covered_quantity), 0, 'coverage must be untouched');
});

forEachDb('API-023: only the requester can cancel; a non-requester gets 404', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const created = await createRequest(h, reqCookie);
  const id = created.body.request.id;

  const bad = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie: await login(h, b.staffEmail), body: {} });
  assert.equal(bad.status, 404, 'a contacted pharmacy must not be able to cancel');
  assertSafeJson(bad);
  let still = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(still.status, 'OPEN');

  const good = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie: reqCookie, body: {} });
  assert.equal(good.status, 200, good.raw);
  assert.equal(good.body.request.status, 'CANCELLED');
  assert.equal(good.body.cancelled, true);
});

forEachDb('API-024: a non-requester cannot advance the search (404)', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const created = await createRequest(h, reqCookie);
  const id = created.body.request.id;

  const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/advance`, cookie: await login(h, b.staffEmail), body: {} });
  assert.equal(res.status, 404, 'only the requester pharmacy may advance');
  assertSafeJson(res);
});

forEachDb('API-025: listing never returns another pharmacy\'s requests', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  // B raises its own request too
  await addBatch(h, await addMedicine(h, b.pharmacyId, 'Ibuprofen'), 'IBU', 10);
  const bCookie = await login(h, b.staffEmail);
  await h.request({
    method: 'POST', url: '/api/inter-pharmacy/medicine-requests', cookie: bCookie,
    body: { medicineName: 'Ibuprofen', requestedQuantity: 5, idempotencyKey: newKey() }
  });
  const aCookie = await login(h, 'staff@mediindex.local');
  await createRequest(h, aCookie);

  const aList = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests', cookie: aCookie });
  assert.equal(aList.body.requests.length, 1);
  assert.equal(aList.body.requests[0].medicineName, 'Paracetamol');

  const bList = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests', cookie: bCookie });
  assert.equal(bList.body.requests.length, 1);
  assert.equal(bList.body.requests[0].medicineName, 'Ibuprofen');
});

forEachDb('API-026: a contacted pharmacy sees only its own offer in the detail view', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 10 });
  const c = await addTenant(h, 'Tenant C', COORDS.near2, { stock: 10 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const created = await createRequest(h, reqCookie);
  const id = created.body.request.id;

  const asRequester = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie: reqCookie });
  assert.equal(asRequester.body.viewerRole, 'REQUESTER');
  assert.ok(asRequester.body.offers.length >= 2, 'the requester sees every offer');

  const asB = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie: await login(h, b.staffEmail) });
  assert.equal(asB.status, 200);
  assert.equal(asB.body.viewerRole, 'RECIPIENT');
  assert.equal(asB.body.offers.length, 1, 'a recipient sees only its own offer');
  assert.equal(asB.body.offers[0].pharmacyId, b.pharmacyId);
  assert.doesNotMatch(asB.raw, /Tenant C/, "must not leak a competitor's identity");
});

forEachDb('API-027: the tenant-scoped expire sweep never touches another pharmacy', async (h) => {
  const aPid = await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  await addBatch(h, await addMedicine(h, b.pharmacyId, 'Ibuprofen'), 'IBU', 10);
  // Pharmacy A stocks Ibuprofen so B's request finds a supplier and stays OPEN
  // (a NO_COVERAGE request is already terminal and could never expire).
  await addBatch(h, await addMedicine(h, aPid, 'Ibuprofen'), 'A-IBU', 100);

  const aCookie = await login(h, 'staff@mediindex.local');
  const bCookie = await login(h, b.staffEmail);
  const aReq = (await createRequest(h, aCookie)).body.request.id;
  const bReq = (await h.request({
    method: 'POST', url: '/api/inter-pharmacy/medicine-requests', cookie: bCookie,
    body: { medicineName: 'Ibuprofen', requestedQuantity: 5, idempotencyKey: newKey() }
  })).body.request.id;

  // Force both past their TTL
  const past = new Date(Date.now() - 1000).toISOString();
  await h.db.run('UPDATE medicine_requests SET expires_at = ?', [past]);

  // B's ADMIN sweeps — only B's request may expire
  await h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', cookie: await login(h, b.adminEmail), body: {} });

  const aRow = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [aReq]);
  const bRow = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [bReq]);
  assert.equal(bRow.status, 'EXPIRED', "B's own request must expire");
  assert.notEqual(aRow.status, 'EXPIRED', "A's request must not be touched by B's sweep");
});

// ═════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('API-030: replaying an idempotency key returns the same request without duplicating', async (h) => {
  await setupRequester(h);
  const cookie = await login(h, 'staff@mediindex.local');
  const key = newKey();

  const first = await createRequest(h, cookie, { idempotencyKey: key });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);

  const replay = await createRequest(h, cookie, { idempotencyKey: key });
  assert.equal(replay.status, 200, 'a replay is not a new creation');
  assert.equal(replay.body.created, false);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.request.id, first.body.request.id);

  const count = await h.db.get('SELECT COUNT(*) AS n FROM medicine_requests');
  assert.equal(Number(count.n), 1, 'exactly one request row');
});

forEachDb('API-031: reusing a key from another pharmacy returns 409 without leaking', async (h) => {
  await setupRequester(h);
  const other = await addTenant(h, 'Tenant Other', COORDS.near, { stock: 10 });
  const key = newKey();

  const a = await createRequest(h, await login(h, 'staff@mediindex.local'), { idempotencyKey: key });
  assert.equal(a.status, 201);

  const res = await h.request({
    method: 'POST', url: '/api/inter-pharmacy/medicine-requests',
    cookie: await login(h, other.staffEmail),
    body: { medicineName: 'Paracetamol', requestedQuantity: 7, idempotencyKey: key }
  });
  assert.equal(res.status, 409, 'a cross-tenant key collision must be a conflict');
  assertSafeJson(res);
  assert.equal(res.body.code, 'CONFLICT');
  assert.equal(res.body.request, undefined, 'the original request must not be returned');
  assert.doesNotMatch(res.raw, /Demo Pharmacy/i, 'must not leak the original requester');
});

forEachDb('API-032: repeated offer and decline submissions are safe', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const c = await addTenant(h, 'Tenant C', COORDS.near2, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 60 })).body.request.id;

  const bCookie = await login(h, b.staffEmail);
  const first = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: bCookie, body: { offeredQuantity: 20 } });
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.body.accepted, true);
  assert.equal(first.body.coveredQuantity, 20);

  const replay = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: bCookie, body: { offeredQuantity: 20 } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.coveredQuantity, 20, 'a replay must not double-count');

  // Decline is idempotent too
  await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/advance`, cookie: reqCookie, body: {} });
  const cCookie = await login(h, c.staffEmail);
  const d1 = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/decline`, cookie: cCookie, body: { reason: 'None spare' } });
  assert.equal(d1.status, 200, d1.raw);
  assert.equal(d1.body.declined, true);
  const d2 = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/decline`, cookie: cCookie, body: {} });
  assert.equal(d2.status, 200);
  assert.equal(d2.body.idempotentReplay, true);
  assert.equal(d2.body.offer.declineReason, 'None spare', 'audit detail is preserved');
});

// ═════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('API-040: invalid create payloads return JSON 400', async (h) => {
  await setupRequester(h);
  const cookie = await login(h, 'staff@mediindex.local');
  const cases = [
    [{ medicineName: 'Paracetamol', requestedQuantity: 0, idempotencyKey: newKey() }, /positive/i],
    [{ medicineName: 'Paracetamol', requestedQuantity: -5, idempotencyKey: newKey() }, /positive/i],
    [{ medicineName: 'Paracetamol', requestedQuantity: 1.5, idempotencyKey: newKey() }, /whole number/i],
    [{ medicineName: 'Paracetamol', requestedQuantity: 10 }, /idempotencyKey/i],
    [{ requestedQuantity: 10, idempotencyKey: newKey() }, /medicineName|medicineId/i],
    [{ medicineName: 'Paracetamol', requestedQuantity: 10, priority: 'SUPER', idempotencyKey: newKey() }, /priority/i]
  ];
  for (const [body, pattern] of cases) {
    const res = await h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests', cookie, body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
    assertSafeJson(res);
    assert.match(res.body.error, pattern);
  }
});

forEachDb('API-041: an unknown medicine returns JSON 404', async (h) => {
  await setupRequester(h);
  const cookie = await login(h, 'staff@mediindex.local');
  const res = await createRequest(h, cookie, { medicineName: 'NoSuchMedicine' });
  assert.equal(res.status, 404);
  assertSafeJson(res);
  assert.equal(res.body.code, 'NOT_FOUND');
});

forEachDb('API-042: invalid list filters return JSON 400', async (h) => {
  await setupRequester(h);
  const cookie = await login(h, 'staff@mediindex.local');
  for (const qs of ['?status=BOGUS', '?limit=abc', '?offset=-1']) {
    const res = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests' + qs, cookie });
    assert.equal(res.status, 400, `${qs} must be rejected`);
    assertSafeJson(res);
  }
});

forEachDb('API-043: the client cannot choose a search zone or radius', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const cookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, cookie)).body.request.id;

  for (const body of [{ zoneIndex: 3 }, { radiusKm: 999 }, { zonesKm: [500] }]) {
    const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/advance`, cookie, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} must be rejected`);
    assertSafeJson(res);
    assert.match(res.body.error, /must not choose/i);
  }
  // The zone is still server-determined
  const detail = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie });
  assert.ok(detail.body.request.currentZoneIndex <= 3);
});

forEachDb('API-044: an unknown request id returns JSON 404 and unknown routes stay JSON', async (h) => {
  const cookie = await login(h, 'admin@mediindex.local');
  const detail = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/999999', cookie });
  assert.equal(detail.status, 404);
  assertSafeJson(detail);

  const bogus = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/not-a-number', cookie });
  assert.equal(bogus.status, 404);
  assertSafeJson(bogus);
});

// ═════════════════════════════════════════════════════════════════════════════
// STATE CONFLICTS
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('API-050: offering more than available stock returns JSON 409', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 10 });
  await addTenant(h, 'Tenant Deep', COORDS.mid, { stock: 500 }); // keeps the request actionable
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie)).body.request.id;

  const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: await login(h, b.staffEmail), body: { offeredQuantity: 40 } });
  assert.equal(res.status, 409);
  assertSafeJson(res);
  assert.equal(res.body.code, 'CONFLICT');
  assert.equal(res.body.details.offerableStock, 10);

  const fresh = await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(Number(fresh.covered_quantity), 0, 'never silently clamped');
});

forEachDb('API-051: offering more than the outstanding quantity returns JSON 409', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 500 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 20 })).body.request.id;

  const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: await login(h, b.staffEmail), body: { offeredQuantity: 25 } });
  assert.equal(res.status, 409);
  assertSafeJson(res);
  assert.equal(res.body.details.outstanding, 20);
  const fresh = await h.db.get('SELECT covered_quantity, status FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(Number(fresh.covered_quantity), 0);
  assert.equal(fresh.status, 'OPEN');
});

forEachDb('API-052: offering after cancellation returns JSON 409', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie)).body.request.id;
  await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie: reqCookie, body: {} });

  const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: await login(h, b.staffEmail), body: { offeredQuantity: 10 } });
  assert.equal(res.status, 409);
  assertSafeJson(res);
});

forEachDb('API-054: a requester can cancel a NO_COVERAGE request over HTTP; others cannot', async (h) => {
  await setupRequester(h);
  // Only an out-of-range pharmacy → the search exhausts every zone.
  const far = await addTenant(h, 'Tenant Far', COORDS.delhi, { stock: 500 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const before = await inventorySnapshot(h);

  const created = await createRequest(h, reqCookie);
  assert.equal(created.body.request.status, 'NO_COVERAGE', 'precondition');
  const id = created.body.request.id;

  // A pharmacy that is not the requester must not be able to cancel it.
  const bad = await h.request({
    method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`,
    cookie: await login(h, far.staffEmail), body: {}
  });
  assert.equal(bad.status, 404, 'a non-requester cancel must be refused');
  assertSafeJson(bad);
  assert.equal((await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [id])).status, 'NO_COVERAGE');

  // The requester can cancel it, and the response is safe JSON.
  const ok = await h.request({
    method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`,
    cookie: reqCookie, body: {}
  });
  assert.equal(ok.status, 200, ok.raw);
  assertSafeJson(ok);
  assert.equal(ok.body.cancelled, true);
  assert.equal(ok.body.request.status, 'CANCELLED');
  // Search state is preserved, not rewound.
  assert.equal(ok.body.request.currentZoneIndex, 3);
  assert.equal(ok.body.request.currentRadiusKm, 100);

  // Repeat is idempotent.
  const again = await h.request({
    method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`,
    cookie: reqCookie, body: {}
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.request.status, 'CANCELLED');
  assert.equal(again.body.idempotentReplay, true);

  // No new offers were created and no inventory moved.
  const offers = await h.db.query('SELECT COUNT(*) AS n FROM medicine_request_offers WHERE request_id = ?', [id]);
  assert.equal(Number(offers[0].n), 0, 'cancelling must not create offers');
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches);
  assert.equal(after.movements, before.movements);
  assert.equal(after.movements, 0);
});

forEachDb('API-055: an EXPIRED request still cannot be cancelled (safe 409)', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const adminCookie = await login(h, 'admin@mediindex.local');
  const id = (await createRequest(h, reqCookie)).body.request.id;

  await h.db.run('UPDATE medicine_requests SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), id]);
  await h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', cookie: adminCookie, body: {} });
  assert.equal((await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [id])).status, 'EXPIRED');

  const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie: reqCookie, body: {} });
  assert.equal(res.status, 409, 'an expired request must not be cancellable');
  assertSafeJson(res);
  assert.equal(res.body.code, 'CONFLICT');
  assert.match(res.body.error, /EXPIRED/);
});

forEachDb('API-053: invalid offer quantities return JSON 400', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie)).body.request.id;
  const bCookie = await login(h, b.staffEmail);

  for (const q of [0, -1, 2.5, 'x', null]) {
    const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: bCookie, body: { offeredQuantity: q } });
    assert.equal(res.status, 400, `quantity ${q} must be rejected`);
    assertSafeJson(res);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// FUNCTIONAL FLOW
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('API-060: create returns full state and contacts the first zone', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const cookie = await login(h, 'staff@mediindex.local');

  const res = await createRequest(h, cookie, { priority: 'URGENT', reason: 'Stock-out' });
  assert.equal(res.status, 201, res.raw);
  const r = res.body.request;
  assert.equal(r.status, 'OPEN');
  assert.equal(r.requestedQuantity, 50);
  assert.equal(r.coveredQuantity, 0);
  assert.equal(r.remainingQuantity, 50);
  assert.equal(r.currentZoneIndex, 0);
  assert.equal(r.currentRadiusKm, 10);
  assert.equal(r.zoneCount, 4);
  assert.equal(r.maxRadiusKm, 100);
  assert.equal(r.priority, 'URGENT');
  assert.equal(r.reason, 'Stock-out');
  assert.ok(r.expiresAt, 'expiration information must be present');
  assert.equal(r.idempotency_key, undefined, 'internal columns must not be exposed');

  assert.equal(res.body.search.contacted.length, 1, 'the first zone is contacted on creation');
  assert.equal(res.body.offers.length, 1);
  assert.equal(res.body.offers[0].pharmacyId, b.pharmacyId);
  assert.equal(res.body.offers[0].status, 'PENDING');
  assert.ok(res.body.offers[0].distanceKm > 0, 'a real distance is recorded');
});

forEachDb('API-061: incoming returns everything the recipient needs, server-computed', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  await createRequest(h, reqCookie);

  const res = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/incoming', cookie: await login(h, b.staffEmail) });
  assert.equal(res.status, 200, res.raw);
  assertSafeJson(res);
  assert.equal(res.body.count, 1);
  const item = res.body.incoming[0];
  assert.equal(item.requesterName, 'MediIndex Demo Pharmacy');
  assert.equal(item.medicineName, 'Paracetamol');
  assert.equal(item.requestedQuantity, 50);
  assert.equal(item.coveredQuantity, 0);
  assert.equal(item.outstandingQuantity, 50);
  assert.ok(item.distanceKm > 4 && item.distanceKm < 8, `expected ~5.5 km, got ${item.distanceKm}`);
  assert.equal(item.usableStock, 80, "the recipient's own usable stock");
  assert.equal(item.offerableStock, 80);
  assert.equal(item.canOffer, true, 'the server decides actionability');
  assert.equal(item.maxOfferableQuantity, 50);
  assert.equal(item.offerStatus, 'PENDING');
  assert.equal(item.requestStatus, 'OPEN');
  assert.ok(item.respondBy, 'a response deadline is present');
});

forEachDb('API-062: a zero-stock recipient is told it cannot offer', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant Partial', COORDS.near, { stock: 10 });
  const zero = await addTenant(h, 'Tenant Zero', COORDS.near2, { stock: 0 });
  await addTenant(h, 'Tenant Deep', COORDS.mid, { stock: 500 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  await createRequest(h, reqCookie);

  const res = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/incoming', cookie: await login(h, zero.staffEmail) });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.count, 1, 'the zero-stock pharmacy is still contacted');
  assert.equal(res.body.incoming[0].usableStock, 0);
  assert.equal(res.body.incoming[0].canOffer, false, 'it must be told Offer is unavailable');
  assert.equal(res.body.incoming[0].maxOfferableQuantity, 0);
});

forEachDb('API-063: advance is repeatable and creates no duplicate contacts', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 10 });
  await addTenant(h, 'Tenant C', COORDS.near2, { stock: 10 });
  const cookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, cookie)).body.request.id;

  for (let i = 0; i < 3; i++) {
    const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/advance`, cookie, body: {} });
    assert.equal(res.status, 200, res.raw);
    assertSafeJson(res);
  }
  const dupes = await h.db.query(
    'SELECT pharmacy_id, COUNT(*) AS c FROM medicine_request_offers WHERE request_id = ? GROUP BY pharmacy_id', [id]);
  for (const row of dupes) assert.equal(Number(row.c), 1, `pharmacy ${row.pharmacy_id} must have one offer row`);
});

forEachDb('API-064: advance on a fully covered request returns current state unchanged', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie)).body.request.id;
  await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: await login(h, b.staffEmail), body: { offeredQuantity: 50 } });

  const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/advance`, cookie: reqCookie, body: {} });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.request.status, 'FULLY_COVERED');
  assert.equal(res.body.remainingQuantity, 0);
});

forEachDb('API-065: advance on a cancelled request returns the cancelled state', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const cookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, cookie)).body.request.id;
  await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie, body: {} });

  const res = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/advance`, cookie, body: {} });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.request.status, 'CANCELLED');
});

forEachDb('API-066: NO_COVERAGE is reported when no pharmacy can supply', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Tenant Far', COORDS.delhi, { stock: 500 }); // outside every zone
  const cookie = await login(h, 'staff@mediindex.local');
  const created = await createRequest(h, cookie);
  assert.equal(created.body.request.status, 'NO_COVERAGE');
  assert.equal(created.body.request.remainingQuantity, 50);
  assert.equal(created.body.offers.length, 0);
});

forEachDb('API-067: list filters by status and medicine and paginates', async (h) => {
  const pid = await setupRequester(h);
  await addMedicine(h, pid, 'Ibuprofen');
  await addTenant(h, 'Tenant B', COORDS.near, { stock: 500 });
  const cookie = await login(h, 'staff@mediindex.local');

  const a = (await createRequest(h, cookie, { medicineName: 'Paracetamol', requestedQuantity: 10 })).body.request.id;
  await createRequest(h, cookie, { medicineName: 'Ibuprofen', requestedQuantity: 10 });
  await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${a}/cancel`, cookie, body: {} });

  const all = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests', cookie });
  assert.equal(all.body.total, 2);

  const cancelled = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests?status=CANCELLED', cookie });
  assert.equal(cancelled.body.total, 1);
  assert.equal(cancelled.body.requests[0].status, 'CANCELLED');

  const byMed = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests?medicine=Ibuprofen', cookie });
  assert.equal(byMed.body.total, 1);
  assert.equal(byMed.body.requests[0].medicineName, 'Ibuprofen');

  const paged = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests?limit=1&offset=0', cookie });
  assert.equal(paged.body.requests.length, 1);
  assert.equal(paged.body.total, 2, 'total reflects the unpaginated count');
  assert.equal(paged.body.limit, 1);
});

forEachDb('API-068: two pharmacies cover one request end to end over HTTP', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 20 });
  const c = await addTenant(h, 'Tenant C', COORDS.mid, { stock: 40 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const before = await inventorySnapshot(h);

  const created = await createRequest(h, reqCookie);
  const id = created.body.request.id;

  const o1 = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: await login(h, b.staffEmail), body: { offeredQuantity: 20 } });
  assert.equal(o1.status, 200, o1.raw);
  assert.equal(o1.body.request.status, 'PARTIALLY_COVERED');
  assert.equal(o1.body.remainingQuantity, 30);

  const o2 = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: await login(h, c.staffEmail), body: { offeredQuantity: 30 } });
  assert.equal(o2.status, 200, o2.raw);
  assert.equal(o2.body.request.status, 'FULLY_COVERED');
  assert.equal(o2.body.remainingQuantity, 0);

  const detail = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie: reqCookie });
  assert.equal(detail.body.coveredQuantity, 50);
  assert.equal(detail.body.remainingQuantity, 0);
  const accepted = detail.body.offers.filter(o => o.status === 'ACCEPTED');
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted.map(o => o.offeredQuantity).sort((x, y) => x - y), [20, 30]);

  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches, 'no batch quantity may change');
  assert.equal(after.movements, before.movements, 'no inventory movement may be created');
  assert.equal(after.movements, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// NON-REGRESSION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('API-070: existing endpoints keep working and stay tenant-safe', async (h) => {
  await setupRequester(h);
  const other = await addTenant(h, 'Tenant Other', COORDS.near, { stock: 10 });
  const admin = await login(h, 'admin@mediindex.local');
  const staff = await login(h, 'staff@mediindex.local');

  // health, dashboard, medicines, expiry alerts, near-expiry list
  const health = await h.request({ method: 'GET', url: '/api/health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.database, 'connected');

  for (const url of ['/api/dashboard', '/api/medicines', '/api/expiry-alerts', '/api/inter-pharmacy/requests']) {
    const res = await h.request({ method: 'GET', url, cookie: admin });
    assert.equal(res.status, 200, `${url} must still work: ${res.raw}`);
    assertSafeJson(res);
  }

  // near-expiry processing is still ADMIN-only
  const staffScan = await h.request({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process', cookie: staff, body: {} });
  assert.equal(staffScan.status, 403, 'near-expiry scan must remain ADMIN-only');
  const adminScan = await h.request({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process', cookie: admin, body: {} });
  assert.equal(adminScan.status, 200, adminScan.raw);

  // near-expiry request history is still tenant-scoped
  const hist = await h.request({ method: 'GET', url: '/api/inter-pharmacy/requests?role=ALL', cookie: await login(h, other.staffEmail) });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.requests.filter(r => r.sender_pharmacy_id === 1).length, 0,
    "another tenant's redistribution rows must not be visible");
});

forEachDb('API-071: the manual workflow never writes to the near-expiry table', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie)).body.request.id;
  await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`, cookie: await login(h, b.staffEmail), body: { offeredQuantity: 50 } });

  const n = await h.db.get('SELECT COUNT(*) AS n FROM medicine_redistribution_requests');
  assert.equal(Number(n.n), 0, 'medicine_redistribution_requests must remain untouched');
});
