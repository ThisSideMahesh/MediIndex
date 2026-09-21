'use strict';
/**
 * Shared harness for manual medicine-request tests.
 *
 * Deliberately NOT named *.test.js so the node test runner does not execute it
 * as a suite. Used by tests/medicine-requests-hardening.test.js.
 *
 * Provides an isolated core.js instance (temp DATA_DIR for SQLite, throwaway
 * database for PostgreSQL) fronted by a real HTTP server, plus seeding helpers.
 */

const assert = require('node:assert/strict');
const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const PG_URL = process.env.POSTGRES_TEST_URL || '';
const HAS_PG = !!PG_URL;
const PASSWORD = 'MediIndex@2026';

/** Coordinates producing deterministic Haversine distances from Mumbai. */
const COORDS = {
  mumbai:  { lat: 19.0760, lng: 72.8777 },  // requester
  d3:      { lat: 19.1000, lng: 72.8900 },  //  ~2.9 km
  near:    { lat: 19.1197, lng: 72.9051 },  //  ~5.5 km
  near2:   { lat: 19.1550, lng: 72.9200 },  //  ~9.9 km
  mid:     { lat: 19.2183, lng: 72.9781 },  // ~18.0 km  (zone 1)
  far:     { lat: 19.3919, lng: 73.0800 },  // ~39.0 km  (zone 2)
  farther: { lat: 19.7515, lng: 73.0169 },  // ~75.5 km  (zone 3)
  delhi:   { lat: 28.6139, lng: 77.2090 }   // ~1150 km  (outside all zones)
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
const newKey = () => `h-${Date.now()}-${keyN++}-${crypto.randomBytes(4).toString('hex')}`;

async function startServer(core) {
  const server = http.createServer((req, res) => {
    core.handler(req, res).catch(err => {
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
          resolve({ status: res.statusCode, headers: res.headers, contentType: res.headers['content-type'] || '', body: parsed, raw });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  return { server, request, close: () => new Promise(r => server.close(r)) };
}

async function makeSqliteHarness() {
  const dir = fs.mkdtempSync(path.join('/tmp', 'mi-h-'));
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

async function makePgHarness() {
  const { Client } = require('pg');
  const dbName = `mi_h_${crypto.randomBytes(5).toString('hex')}`;
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

  await core.db.run("INSERT INTO pharmacies (name, address) VALUES ('MediIndex Demo Pharmacy', 'Seed')");
  const ph = await core.db.get('SELECT id FROM pharmacies LIMIT 1');
  const hash = core.passwordHash(PASSWORD);
  for (const [name, email, role] of [
    ['Demo Administrator', 'admin@mediindex.local', 'ADMIN'],
    ['Demo Pharmacy Staff', 'staff@mediindex.local', 'STAFF']
  ]) {
    await core.db.run('INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      [ph.id, name, email, hash, role]);
  }

  const srv = await startServer(core);
  return {
    kind: 'postgres', core, db: core.db, request: srv.request, dbUrl,
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

// ─── seeding ────────────────────────────────────────────────────────────────

async function login(h, email) {
  const res = await h.request({ method: 'POST', url: '/api/auth/login', body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, `login failed for ${email}: ${res.raw}`);
  return res.headers['set-cookie'][0].split(';')[0];
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

/**
 * Creates a tenant with its own ADMIN + STAFF users.
 *   stock > 0            -> catalogue entry plus a batch
 *   stock === 0          -> catalogue entry, no stock
 *   withCatalogue:false  -> no catalogue entry at all
 */
async function addTenant(h, name, coords, opts = {}) {
  const { medicine = 'Paracetamol', stock = 0, withCatalogue = true, active = 1, expiredOnly = false } = opts;
  await h.db.run('INSERT INTO pharmacies (name, address, latitude, longitude, active) VALUES (?, ?, ?, ?, ?)',
    [name, name, coords.lat, coords.lng, active]);
  const ph = await h.db.get('SELECT id FROM pharmacies WHERE name = ?', [name]);
  const pid = Number(ph.id);
  const hash = h.core.passwordHash(PASSWORD);
  const adminEmail = `admin-${pid}@t.com`;
  const staffEmail = `staff-${pid}@t.com`;
  await h.db.run('INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [pid, `${name} Admin`, adminEmail, hash, 'ADMIN']);
  await h.db.run('INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [pid, `${name} Staff`, staffEmail, hash, 'STAFF']);
  if (withCatalogue) {
    const mid = await addMedicine(h, pid, medicine);
    if (expiredOnly) await addBatch(h, mid, `${pid}-EXP`, stock > 0 ? stock : 50, -5);
    else if (stock > 0) await addBatch(h, mid, `${pid}-LOT`, stock);
  }
  return { pharmacyId: pid, adminEmail, staffEmail, name };
}

/** Demo pharmacy becomes the requester: Mumbai coordinates + a catalogue entry. */
async function setupRequester(h, medicine = 'Paracetamol') {
  const pid = await demoPharmacyId(h);
  await h.db.run('UPDATE pharmacies SET latitude = ?, longitude = ? WHERE id = ?', [COORDS.mumbai.lat, COORDS.mumbai.lng, pid]);
  await addMedicine(h, pid, medicine);
  return pid;
}

async function createRequest(h, cookie, overrides = {}) {
  return h.request({
    method: 'POST', url: '/api/inter-pharmacy/medicine-requests', cookie,
    body: { medicineName: 'Paracetamol', requestedQuantity: 50, idempotencyKey: newKey(), ...overrides }
  });
}

async function inventorySnapshot(h) {
  const batches = await h.db.query('SELECT id, quantity, expiry_date FROM medicine_batches ORDER BY id');
  const mv = await h.db.get('SELECT COUNT(*) AS n FROM inventory_movements');
  const total = await h.db.get('SELECT COALESCE(SUM(quantity), 0) AS t FROM medicine_batches');
  return {
    batches: batches.map(b => `${b.id}:${b.quantity}`).join('|'),
    totalUnits: Number(total.t),
    movements: Number(mv.n)
  };
}

function assertSafeJson(res) {
  assert.match(res.contentType, /application\/json/, `expected JSON, got "${res.contentType}"`);
  assert.notEqual(res.body, undefined, `expected parseable JSON, got: ${res.raw}`);
  const text = res.raw || '';
  assert.doesNotMatch(text, /<html|<!DOCTYPE/i);
  assert.doesNotMatch(text, /\bat \/|\bat Object\.|node:internal/);
  assert.doesNotMatch(text, /postgresql:\/\/|postgres:\/\/|password=/i);
  assert.doesNotMatch(text, /token_hash|password_hash|mediindex_session=/i);
}

/** Runs a body against SQLite, and against PostgreSQL when configured. */
function forEachDb(test, name, body) {
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

/** Runs a body ONLY against real PostgreSQL (for genuine concurrency). */
function pgOnly(test, name, body) {
  test(`${name} [postgres]`, async (t) => {
    if (!HAS_PG) { t.skip('POSTGRES_TEST_URL not set'); return; }
    const h = await makePgHarness();
    try { await body(h); } finally { await h.cleanup(); }
  });
}

module.exports = {
  PASSWORD, COORDS, HAS_PG,
  daysFromNow, newKey,
  makeSqliteHarness, makePgHarness, forEachDb, pgOnly,
  login, demoPharmacyId, addMedicine, addBatch, addTenant, setupRequester,
  createRequest, inventorySnapshot, assertSafeJson
};
