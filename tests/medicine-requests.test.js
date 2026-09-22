'use strict';
/**
 * tests/medicine-requests.test.js
 *
 * PHASE 2 — manual medicine request domain engine + progressive-radius algorithm.
 *
 * Drives the real engine (medicine-requests.js) against a real database. The
 * engine is an injectable factory, so each test gets an isolated database and a
 * controllable clock without module-cache manipulation.
 *
 * Runs on SQLite by default. When POSTGRES_TEST_URL is set, the PG-specific
 * tests additionally exercise real PostgreSQL — including the concurrency
 * scenario, where the coverage CAS must hold under genuine parallel writers.
 *
 * No HTTP routes and no UI are involved: this is domain logic only.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const { createMedicineRequestEngine } = require('../medicine-requests');
const { SQLiteAdapter } = require('../db/sqlite-adapter');
const { haversineKm } = require('../core');

const PG_URL = process.env.POSTGRES_TEST_URL || '';
const HAS_PG = !!PG_URL;

// Real coordinates used to produce deterministic Haversine distances from
// Mumbai (the requester). Measured values are asserted in MREQ-ZONE tests.
const COORDS = {
  mumbai:   { lat: 19.0760, lng: 72.8777 },  // requester
  near:     { lat: 19.1197, lng: 72.9051 },  //  ~5.5 km  → zone 0 (10 km)
  near2:    { lat: 19.1550, lng: 72.9200 },  //  ~9.9 km  → zone 0 (10 km)
  mid:      { lat: 19.2183, lng: 72.9781 },  // ~18.0 km  → zone 1 (25 km)
  far:      { lat: 19.3919, lng: 73.0800 },  // ~39.0 km  → zone 2 (50 km)
  farther:  { lat: 19.7515, lng: 73.0169 },  // ~75.5 km  → zone 3 (100 km)
  outside:  { lat: 18.5204, lng: 73.8567 },  // Pune ~120 km → beyond all zones
  delhi:    { lat: 28.6139, lng: 77.2090 }   // ~1150 km
};

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test harness — isolated database + controllable clock
// ─────────────────────────────────────────────────────────────────────────────

/** Creates an isolated SQLite-backed harness. */
function makeSqliteHarness() {
  const dbPath = path.join('/tmp', `mi-mreq-${crypto.randomBytes(6).toString('hex')}.db`);
  const adapter = new SQLiteAdapter({ dataDir: '/tmp', dbPath });
  adapter.initialize();
  let clock = Date.now();
  const engine = createMedicineRequestEngine({
    db: adapter, isPg: false, haversineKm, now: () => clock
  });
  return {
    kind: 'sqlite',
    db: adapter,
    engine,
    advanceClock: (ms) => { clock += ms; },
    setClock: (ms) => { clock = ms; },
    now: () => clock,
    async cleanup() { try { adapter.close(); } catch {} fs.rmSync(dbPath, { force: true }); }
  };
}

/** Creates an isolated PostgreSQL-backed harness on a throwaway database. */
async function makePgHarness() {
  const { Client } = require('pg');
  const { PostgreSQLAdapter } = require('../db/postgres-adapter');
  const dbName = `mi_mreq_${crypto.randomBytes(5).toString('hex')}`;
  const adminUrl = (() => { const u = new URL(PG_URL); u.pathname = '/postgres'; return u.toString(); })();
  const dbUrl    = (() => { const u = new URL(PG_URL); u.pathname = '/' + dbName; return u.toString(); })();

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const adapter = new PostgreSQLAdapter({ connectionString: dbUrl });
  adapter.initialize();
  await adapter.ensureSchema();

  let clock = Date.now();
  const engine = createMedicineRequestEngine({
    db: adapter, isPg: true, haversineKm, now: () => clock
  });
  return {
    kind: 'postgres',
    db: adapter,
    engine,
    dbUrl,
    advanceClock: (ms) => { clock += ms; },
    setClock: (ms) => { clock = ms; },
    now: () => clock,
    async cleanup() {
      try { await adapter.close(); } catch {}
      const a = new Client({ connectionString: adminUrl });
      await a.connect();
      try { await a.query(`DROP DATABASE IF EXISTS ${dbName}`); } catch {}
      await a.end();
    }
  };
}

/** Seeds a pharmacy (optionally with coordinates and an active flag). */
async function addPharmacy(h, name, coords = null, active = 1) {
  if (coords) {
    await h.db.run('INSERT INTO pharmacies (name, address, latitude, longitude, active) VALUES (?, ?, ?, ?, ?)',
      [name, name + ' address', coords.lat, coords.lng, active]);
  } else {
    await h.db.run('INSERT INTO pharmacies (name, address, active) VALUES (?, ?, ?)',
      [name, name + ' address', active]);
  }
  const row = await h.db.get('SELECT id FROM pharmacies WHERE name = ?', [name]);
  return Number(row.id);
}

async function addUser(h, pharmacyId, email, role = 'STAFF') {
  await h.db.run(
    'INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [pharmacyId, email, email, 'salt:hash', role]
  );
  const row = await h.db.get('SELECT id FROM users WHERE email = ?', [email]);
  return Number(row.id);
}

/** Adds a medicine to a pharmacy's catalogue; returns its per-pharmacy id. */
async function addMedicine(h, pharmacyId, name, minimumStock = 0) {
  await h.db.run('INSERT INTO medicines (pharmacy_id, name, minimum_stock) VALUES (?, ?, ?)',
    [pharmacyId, name, minimumStock]);
  const row = await h.db.get(
    'SELECT id FROM medicines WHERE pharmacy_id = ? AND lower(name) = lower(?)', [pharmacyId, name]);
  return Number(row.id);
}

/** Adds a batch. daysToExpiry < 0 produces already-expired stock. */
async function addBatch(h, medicineId, batchNumber, quantity, daysToExpiry = 365) {
  await h.db.run(
    'INSERT INTO medicine_batches (medicine_id, batch_number, quantity, selling_price, expiry_date) VALUES (?, ?, ?, ?, ?)',
    [medicineId, batchNumber, quantity, 5.0, daysFromNow(daysToExpiry)]
  );
}

/** Convenience: pharmacy + catalogue + stock in one call. */
async function addStockedPharmacy(h, name, coords, medicineName, quantity, opts = {}) {
  const pid = await addPharmacy(h, name, coords, opts.active === undefined ? 1 : opts.active);
  if (opts.withCatalogue !== false) {
    const mid = await addMedicine(h, pid, medicineName);
    if (quantity > 0) await addBatch(h, mid, `${name}-LOT`, quantity, opts.daysToExpiry === undefined ? 365 : opts.daysToExpiry);
  }
  return pid;
}

/** Standard scenario: requester A in Mumbai wanting `qty` of Paracetamol. */
async function seedRequester(h, qty = 50) {
  const pid = await addPharmacy(h, 'Pharmacy A', COORDS.mumbai);
  const uid = await addUser(h, pid, 'a-staff@x.com', 'STAFF');
  await addMedicine(h, pid, 'Paracetamol');
  return { pharmacyId: pid, userId: uid, quantity: qty };
}

let keyCounter = 0;
const newKey = () => `k-${Date.now()}-${keyCounter++}-${crypto.randomBytes(4).toString('hex')}`;

async function createStandardRequest(h, requester, quantity = 50, opts = {}) {
  const res = await h.engine.createRequest({
    pharmacyId: requester.pharmacyId,
    userId: requester.userId,
    medicineName: 'Paracetamol',
    requestedQuantity: quantity,
    idempotencyKey: newKey(),
    ...opts
  });
  return res.request;
}

/** Captures full inventory state so tests can prove nothing moved. */
async function snapshotInventory(h) {
  const batches = await h.db.query('SELECT id, medicine_id, quantity, expiry_date FROM medicine_batches ORDER BY id');
  const movements = await h.db.get('SELECT COUNT(*) AS n FROM inventory_movements');
  return {
    batches: batches.map(b => `${b.id}:${b.quantity}`).join('|'),
    movements: Number(movements.n)
  };
}

/** Runs a test body against SQLite, and against PostgreSQL when configured. */
function forEachDb(name, body, { pgOnly = false } = {}) {
  if (!pgOnly) {
    test(`${name} [sqlite]`, async () => {
      const h = makeSqliteHarness();
      try { await body(h); } finally { await h.cleanup(); }
    });
  }
  test(`${name} [postgres]`, async (t) => {
    if (!HAS_PG) { t.skip('POSTGRES_TEST_URL not set'); return; }
    const h = await makePgHarness();
    try { await body(h); } finally { await h.cleanup(); }
  });
}

async function expectError(fn, expectedCode, expectedStatus) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected the operation to fail');
  assert.equal(err.code, expectedCode, `expected code ${expectedCode}, got ${err.code}: ${err.message}`);
  if (expectedStatus !== undefined) assert.equal(err.status, expectedStatus);
  return err;
}

// ═════════════════════════════════════════════════════════════════════════════
// REQUEST CREATION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-001: creates a valid request in OPEN state at zone 0', async (h) => {
  const requester = await seedRequester(h);
  const res = await h.engine.createRequest({
    pharmacyId: requester.pharmacyId, userId: requester.userId,
    medicineName: 'Paracetamol', requestedQuantity: 50,
    priority: 'URGENT', reason: 'Stock-out', idempotencyKey: newKey()
  });
  assert.equal(res.created, true);
  const r = res.request;
  assert.equal(r.status, 'OPEN');
  assert.equal(r.covered_quantity, 0);
  assert.equal(r.requested_quantity, 50);
  assert.equal(r.current_zone_index, 0);
  assert.equal(r.current_radius_km, 10, 'must start at the first configured zone');
  assert.equal(r.priority, 'URGENT');
  assert.equal(r.reason, 'Stock-out');
  assert.equal(r.requester_pharmacy_id, requester.pharmacyId);
  assert.equal(r.medicine_name, 'Paracetamol');
  assert.equal(r.outstanding_quantity, 50);
});

forEachDb('MREQ-002: rejects non-positive and non-integer quantities', async (h) => {
  const requester = await seedRequester(h);
  for (const q of [0, -5, 1.5, 'abc', null, undefined]) {
    await expectError(() => h.engine.createRequest({
      pharmacyId: requester.pharmacyId, userId: requester.userId,
      medicineName: 'Paracetamol', requestedQuantity: q, idempotencyKey: newKey()
    }), 'VALIDATION', 400);
  }
});

forEachDb('MREQ-003: rejects a medicine not in the requester catalogue', async (h) => {
  const requester = await seedRequester(h);
  await expectError(() => h.engine.createRequest({
    pharmacyId: requester.pharmacyId, userId: requester.userId,
    medicineName: 'NoSuchMedicine', requestedQuantity: 10, idempotencyKey: newKey()
  }), 'NOT_FOUND', 404);
});

forEachDb('MREQ-004: cannot request a medicine belonging to another pharmacy', async (h) => {
  const requester = await seedRequester(h);
  const other = await addPharmacy(h, 'Pharmacy Z', COORDS.near);
  const foreignMedId = await addMedicine(h, other, 'ForeignOnly');
  // By id — ownership is enforced
  await expectError(() => h.engine.createRequest({
    pharmacyId: requester.pharmacyId, userId: requester.userId,
    medicineId: foreignMedId, requestedQuantity: 10, idempotencyKey: newKey()
  }), 'NOT_FOUND', 404);
  // By name — resolution is scoped to the requester's own catalogue
  await expectError(() => h.engine.createRequest({
    pharmacyId: requester.pharmacyId, userId: requester.userId,
    medicineName: 'ForeignOnly', requestedQuantity: 10, idempotencyKey: newKey()
  }), 'NOT_FOUND', 404);
});

forEachDb('MREQ-005: duplicate idempotency key returns the same request, creating no second row', async (h) => {
  const requester = await seedRequester(h);
  const key = newKey();
  const a = await h.engine.createRequest({
    pharmacyId: requester.pharmacyId, userId: requester.userId,
    medicineName: 'Paracetamol', requestedQuantity: 50, idempotencyKey: key
  });
  const b = await h.engine.createRequest({
    pharmacyId: requester.pharmacyId, userId: requester.userId,
    medicineName: 'Paracetamol', requestedQuantity: 50, idempotencyKey: key
  });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.idempotentReplay, true);
  assert.equal(a.request.id, b.request.id);
  const count = await h.db.get('SELECT COUNT(*) AS n FROM medicine_requests');
  assert.equal(Number(count.n), 1, 'exactly one request row must exist');
});

forEachDb('MREQ-006: an idempotency key used by another pharmacy does not leak that request', async (h) => {
  const requester = await seedRequester(h);
  const otherPid = await addPharmacy(h, 'Pharmacy Other', COORDS.near);
  const otherUid = await addUser(h, otherPid, 'other@x.com', 'STAFF');
  await addMedicine(h, otherPid, 'Paracetamol');

  const key = newKey();
  await h.engine.createRequest({
    pharmacyId: requester.pharmacyId, userId: requester.userId,
    medicineName: 'Paracetamol', requestedQuantity: 50, idempotencyKey: key
  });
  // Same key, different pharmacy — must be a conflict, never a disclosure.
  const err = await expectError(() => h.engine.createRequest({
    pharmacyId: otherPid, userId: otherUid,
    medicineName: 'Paracetamol', requestedQuantity: 50, idempotencyKey: key
  }), 'CONFLICT', 409);
  assert.doesNotMatch(String(err.message), /Pharmacy A/i);
});

forEachDb('MREQ-007: requester identity must be supplied; no implicit pharmacy', async (h) => {
  const requester = await seedRequester(h);
  await expectError(() => h.engine.createRequest({
    userId: requester.userId, medicineName: 'Paracetamol',
    requestedQuantity: 10, idempotencyKey: newKey()
  }), 'VALIDATION', 400);
  await expectError(() => h.engine.createRequest({
    pharmacyId: requester.pharmacyId, medicineName: 'Paracetamol',
    requestedQuantity: 10, idempotencyKey: newKey()
  }), 'VALIDATION', 400);
  await expectError(() => h.engine.createRequest({
    pharmacyId: requester.pharmacyId, userId: requester.userId,
    medicineName: 'Paracetamol', requestedQuantity: 10
  }), 'VALIDATION', 400);
});

// ═════════════════════════════════════════════════════════════════════════════
// ELIGIBILITY
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-010: requester is never eligible as its own recipient', async (h) => {
  const requester = await seedRequester(h);
  // Give the requester its own stock — it still must never be contacted.
  const ownMed = await h.db.get('SELECT id FROM medicines WHERE pharmacy_id = ?', [requester.pharmacyId]);
  await addBatch(h, Number(ownMed.id), 'A-OWN', 500, 365);
  await addStockedPharmacy(h, 'Pharmacy B', COORDS.near, 'Paracetamol', 80);

  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  const offers = await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]);
  assert.ok(offers.length > 0, 'someone must have been contacted');
  assert.equal(offers.some(o => Number(o.pharmacy_id) === requester.pharmacyId), false,
    'the requester must never be contacted');
});

forEachDb('MREQ-011: inactive pharmacies are excluded', async (h) => {
  const requester = await seedRequester(h);
  const inactive = await addStockedPharmacy(h, 'Pharmacy Inactive', COORDS.near, 'Paracetamol', 80, { active: 0 });
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  const offers = await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]);
  assert.equal(offers.some(o => Number(o.pharmacy_id) === inactive), false,
    'an inactive pharmacy must never be contacted');
});

forEachDb('MREQ-012: a candidate without coordinates is not geographically eligible', async (h) => {
  const requester = await seedRequester(h);
  const noCoords = await addPharmacy(h, 'Pharmacy NoCoords', null);
  const mid = await addMedicine(h, noCoords, 'Paracetamol');
  await addBatch(h, mid, 'NC-LOT', 500, 365);

  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  const offers = await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]);
  assert.equal(offers.some(o => Number(o.pharmacy_id) === noCoords), false,
    'a pharmacy without coordinates must never be contacted');
  // And no distance was invented for it
  assert.equal(offers.length, 0);
});

forEachDb('MREQ-013: a requester without coordinates contacts nobody', async (h) => {
  const pid = await addPharmacy(h, 'Pharmacy NoGeo', null);
  const uid = await addUser(h, pid, 'nogeo@x.com', 'STAFF');
  await addMedicine(h, pid, 'Paracetamol');
  await addStockedPharmacy(h, 'Pharmacy B', COORDS.near, 'Paracetamol', 500);

  const res = await h.engine.createRequest({
    pharmacyId: pid, userId: uid, medicineName: 'Paracetamol',
    requestedQuantity: 50, idempotencyKey: newKey()
  });
  const summary = await h.engine.advanceRequest(res.request.id);
  assert.equal(summary.contacted.length, 0, 'no pharmacy may be contacted without requester coordinates');
  // All zones are exhausted without any eligible pharmacy → NO_COVERAGE
  assert.equal(summary.status, 'NO_COVERAGE');
});

forEachDb('MREQ-014: findEligiblePharmacies computes real Haversine distances', async (h) => {
  const requester = await seedRequester(h);
  await addStockedPharmacy(h, 'B near', COORDS.near, 'Paracetamol', 10);
  await addStockedPharmacy(h, 'C mid', COORDS.mid, 'Paracetamol', 10);
  const req = await createStandardRequest(h, requester, 50);

  const within10 = await h.engine.findEligiblePharmacies(req, 10);
  assert.equal(within10.length, 1, 'only the ~5.5 km pharmacy is inside 10 km');
  assert.ok(within10[0].distanceKm > 4 && within10[0].distanceKm < 8,
    `expected ~5.5 km, got ${within10[0].distanceKm}`);

  const within25 = await h.engine.findEligiblePharmacies(req, 25);
  assert.equal(within25.length, 2, 'both pharmacies are inside 25 km');
  const mid = within25.find(p => p.pharmacyName === 'C mid');
  assert.ok(mid.distanceKm > 14 && mid.distanceKm < 22, `expected ~18 km, got ${mid.distanceKm}`);

  const within100 = await h.engine.findEligiblePharmacies(req, 100);
  assert.equal(within100.length, 2, 'Pune/Delhi-scale distances are not present here');
});

// ═════════════════════════════════════════════════════════════════════════════
// STOCK AND RESERVATION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-020: usable stock sums only non-expired positive batches', async (h) => {
  const pid = await addPharmacy(h, 'Stock Pharmacy', COORDS.near);
  const mid = await addMedicine(h, pid, 'Paracetamol');
  await addBatch(h, mid, 'GOOD-1', 30, 120);
  await addBatch(h, mid, 'GOOD-2', 20, 10);
  await addBatch(h, mid, 'EXPIRED', 999, -5);   // expired — must not count
  await addBatch(h, mid, 'ZERO', 0, 200);       // zero qty — must not count
  assert.equal(await h.engine.calculateUsableStock(pid, 'Paracetamol'), 50);
  // Identity rule is case-insensitive on name
  assert.equal(await h.engine.calculateUsableStock(pid, 'paracetamol'), 50);
});

forEachDb('MREQ-021: expired-only stock yields zero usable stock', async (h) => {
  const pid = await addPharmacy(h, 'Expired Pharmacy', COORDS.near);
  const mid = await addMedicine(h, pid, 'Paracetamol');
  await addBatch(h, mid, 'EXP-1', 500, -1);
  assert.equal(await h.engine.calculateUsableStock(pid, 'Paracetamol'), 0);
});

forEachDb('MREQ-022: a pharmacy with no catalogue entry reports zero usable stock, not an error', async (h) => {
  const pid = await addPharmacy(h, 'No Catalogue', COORDS.near);
  assert.equal(await h.engine.calculateUsableStock(pid, 'Paracetamol'), 0);
  const s = await h.engine.calculateOfferableStock(pid, 'Paracetamol');
  assert.deepEqual({ ...s }, { usableStock: 0, reservedStock: 0, offerableStock: 0 });
});

forEachDb('MREQ-023: an accepted offer soft-reserves capacity without touching inventory', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'Pharmacy B', COORDS.near, 'Paracetamol', 50);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const before = await snapshotInventory(h);

  const req = await createStandardRequest(h, requester, 20);
  await h.engine.advanceRequest(req.id);
  await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });

  const s = await h.engine.calculateOfferableStock(b, 'Paracetamol');
  assert.equal(s.usableStock, 50, 'physical usable stock is unchanged');
  assert.equal(s.reservedStock, 20, '20 units are soft-reserved');
  assert.equal(s.offerableStock, 30, 'only 30 may be promised elsewhere');

  const after = await snapshotInventory(h);
  assert.equal(after.batches, before.batches, 'no batch quantity may change');
  assert.equal(after.movements, before.movements, 'no inventory movement may be created');
});

forEachDb('MREQ-024: cancelling a request releases its soft reservation', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'Pharmacy B', COORDS.near, 'Paracetamol', 50);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 20);
  await h.engine.advanceRequest(req.id);
  await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  assert.equal((await h.engine.calculateOfferableStock(b, 'Paracetamol')).offerableStock, 30);

  await h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId });
  const after = await h.engine.calculateOfferableStock(b, 'Paracetamol');
  assert.equal(after.reservedStock, 0, 'a cancelled request must release its reservation');
  assert.equal(after.offerableStock, 50, 'full capacity is restored');
});

forEachDb('MREQ-025: an expired request releases its reservation; FULLY_COVERED retains it', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'Pharmacy B', COORDS.near, 'Paracetamol', 100);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');

  // Request 1 becomes FULLY_COVERED → reservation retained
  const covered = await createStandardRequest(h, requester, 10);
  await h.engine.advanceRequest(covered.id);
  await h.engine.submitOffer({ requestId: covered.id, pharmacyId: b, userId: bUser, offeredQuantity: 10 });
  const r1 = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [covered.id]);
  assert.equal(r1.status, 'FULLY_COVERED');
  assert.equal((await h.engine.calculateOfferableStock(b, 'Paracetamol')).reservedStock, 10,
    'FULLY_COVERED must keep its reservation until fulfilment');

  // Request 2 is partially covered then allowed to expire → reservation released
  const expiring = await createStandardRequest(h, requester, 40);
  await h.engine.advanceRequest(expiring.id);
  await h.engine.submitOffer({ requestId: expiring.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  assert.equal((await h.engine.calculateOfferableStock(b, 'Paracetamol')).reservedStock, 30);

  h.advanceClock(73 * 60 * 60 * 1000);   // past the 72h request TTL
  const sweep = await h.engine.expireDue();
  assert.ok(sweep.expiredRequests >= 1, 'the stale request must expire');
  const r2 = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [expiring.id]);
  assert.equal(r2.status, 'EXPIRED');

  const final = await h.engine.calculateOfferableStock(b, 'Paracetamol');
  assert.equal(final.reservedStock, 10, 'only the FULLY_COVERED reservation remains');
  assert.equal(final.offerableStock, 90);
});

forEachDb('MREQ-026: superseded and declined offers never consume reservation', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'Pharmacy B', COORDS.near, 'Paracetamol', 60);
  const c = await addStockedPharmacy(h, 'Pharmacy C', COORDS.near2, 'Paracetamol', 60);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 20);
  await h.engine.advanceRequest(req.id);
  // Force both to be contacted so one can be superseded
  await h.db.run(
    `INSERT INTO medicine_request_offers (request_id, pharmacy_id, zone_index, distance_km, usable_stock_at_contact, status, respond_by)
     SELECT ?, ?, 0, 9.9, 60, 'PENDING', ? WHERE NOT EXISTS
       (SELECT 1 FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?)`,
    [req.id, c, new Date(h.now() + 24 * 3600 * 1000).toISOString(), req.id, c]
  );

  await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  const cOffer = await h.db.get('SELECT status FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?', [req.id, c]);
  assert.equal(cOffer.status, 'SUPERSEDED', 'remaining pending offers are superseded on full coverage');
  assert.equal((await h.engine.calculateOfferableStock(c, 'Paracetamol')).reservedStock, 0,
    'a superseded offer must not reserve capacity');
});

// ═════════════════════════════════════════════════════════════════════════════
// PROGRESSIVE SEARCH
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-030: contacts the nearest stock-bearing pharmacy first and only the minimal set', async (h) => {
  const requester = await seedRequester(h);
  const near = await addStockedPharmacy(h, 'B near', COORDS.near, 'Paracetamol', 80);   // ~5.5 km, covers alone
  const near2 = await addStockedPharmacy(h, 'C near2', COORDS.near2, 'Paracetamol', 80); // ~9.9 km, same zone

  const req = await createStandardRequest(h, requester, 50);
  const summary = await h.engine.advanceRequest(req.id);

  assert.equal(summary.contacted.length, 1, 'one pharmacy already covers the need — contact only it');
  assert.equal(summary.contacted[0].pharmacyId, near, 'the nearest stock-bearing pharmacy must be contacted');
  assert.equal(summary.waiting, true, 'pending capacity suffices, so the search waits');
  assert.equal(summary.zonesAdvanced, 0, 'no expansion while nearer capacity is unresolved');

  const contactedIds = (await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]))
    .map(o => Number(o.pharmacy_id));
  assert.equal(contactedIds.includes(near2), false, 'the farther pharmacy must not be contacted yet');
});

forEachDb('MREQ-031: prioritizes stock-bearing pharmacies over nearer zero-stock ones', async (h) => {
  const requester = await seedRequester(h);
  // Zero-stock pharmacy is NEARER; stock-bearing one is farther but still zone 0.
  const zeroNear = await addStockedPharmacy(h, 'Zero near', COORDS.near, 'Paracetamol', 0);
  const stockFar = await addStockedPharmacy(h, 'Stock near2', COORDS.near2, 'Paracetamol', 80);

  const req = await createStandardRequest(h, requester, 50);
  const ordered = await h.engine.findEligiblePharmacies(req, 10);
  assert.equal(ordered[0].pharmacyId, stockFar, 'stock-bearing must sort ahead of a nearer zero-stock pharmacy');

  const summary = await h.engine.advanceRequest(req.id);
  assert.equal(summary.contacted.length, 1, 'only the stock-bearing pharmacy is needed');
  assert.equal(summary.contacted[0].pharmacyId, stockFar);
  const ids = (await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]))
    .map(o => Number(o.pharmacy_id));
  assert.equal(ids.includes(zeroNear), false,
    'a zero-stock pharmacy must not be contacted while stock-bearing capacity suffices');
});

forEachDb('MREQ-032: contacts zero-stock and no-catalogue pharmacies once the zone cannot cover', async (h) => {
  const requester = await seedRequester(h);
  const partial = await addStockedPharmacy(h, 'B partial', COORDS.near, 'Paracetamol', 10);  // only 10 of 50
  const zero    = await addStockedPharmacy(h, 'C zero', COORDS.near2, 'Paracetamol', 0);
  const noCat   = await addPharmacy(h, 'D nocat', COORDS.near2);                             // no catalogue at all

  const req = await createStandardRequest(h, requester, 50);
  const summary = await h.engine.advanceRequest(req.id);

  const ids = (await h.db.query('SELECT pharmacy_id, usable_stock_at_contact FROM medicine_request_offers WHERE request_id = ?', [req.id]));
  const contacted = ids.map(o => Number(o.pharmacy_id));
  assert.ok(contacted.includes(partial), 'the stock-bearing pharmacy must be contacted');
  assert.ok(contacted.includes(zero), 'zero-stock pharmacy is contacted once the zone cannot cover');
  assert.ok(contacted.includes(noCat), 'no-catalogue pharmacy is contacted once the zone cannot cover');
  const zeroRow = ids.find(o => Number(o.pharmacy_id) === noCat);
  assert.equal(Number(zeroRow.usable_stock_at_contact), 0, 'its snapshot stock is recorded as 0');
  assert.ok(summary.zonesAdvanced >= 1, 'the search must also expand beyond this zone');
});

forEachDb('MREQ-033: expands 10 -> 25 -> 50 -> 100 km as zones fail to cover', async (h) => {
  const requester = await seedRequester(h);
  const z1 = await addStockedPharmacy(h, 'Z1 mid', COORDS.mid, 'Paracetamol', 10);      // ~18 km, zone 1
  const z2 = await addStockedPharmacy(h, 'Z2 far', COORDS.far, 'Paracetamol', 10);      // ~39 km, zone 2
  const z3 = await addStockedPharmacy(h, 'Z3 farther', COORDS.farther, 'Paracetamol', 10); // ~75 km, zone 3

  const req = await createStandardRequest(h, requester, 50);   // nobody can cover 50
  const summary = await h.engine.advanceRequest(req.id);

  const rows = await h.db.query('SELECT pharmacy_id, zone_index FROM medicine_request_offers WHERE request_id = ? ORDER BY zone_index', [req.id]);
  const byPharmacy = Object.fromEntries(rows.map(r => [Number(r.pharmacy_id), Number(r.zone_index)]));
  assert.equal(byPharmacy[z1], 1, 'the ~18 km pharmacy is reached in zone 1 (25 km)');
  assert.equal(byPharmacy[z2], 2, 'the ~39 km pharmacy is reached in zone 2 (50 km)');
  assert.equal(byPharmacy[z3], 3, 'the ~75 km pharmacy is reached in zone 3 (100 km)');
  assert.equal(summary.status, 'NO_COVERAGE', 'all zones exhausted with quantity outstanding');
  assert.equal(summary.zoneIndex, 3);
});

forEachDb('MREQ-034: a pharmacy beyond the maximum radius is never contacted', async (h) => {
  const requester = await seedRequester(h);
  const pune  = await addStockedPharmacy(h, 'Pune', COORDS.outside, 'Paracetamol', 500);
  const delhi = await addStockedPharmacy(h, 'Delhi', COORDS.delhi, 'Paracetamol', 500);

  const req = await createStandardRequest(h, requester, 50);
  const summary = await h.engine.advanceRequest(req.id);

  assert.equal(summary.contacted.length, 0, 'nobody is inside 100 km');
  assert.equal(summary.status, 'NO_COVERAGE');
  const ids = (await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]))
    .map(o => Number(o.pharmacy_id));
  assert.equal(ids.includes(pune), false);
  assert.equal(ids.includes(delhi), false);
});

forEachDb('MREQ-035: partial offer then expansion, second offer completes coverage', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B near', COORDS.near, 'Paracetamol', 20);  // ~5.5 km, only 20
  const c = await addStockedPharmacy(h, 'C mid', COORDS.mid, 'Paracetamol', 40);    // ~18 km, has 40
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  // B offers its 20 → partial
  const o1 = await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  assert.equal(o1.request.status, 'PARTIALLY_COVERED');
  assert.equal(o1.request.covered_quantity, 20);
  assert.equal(o1.request.outstanding_quantity, 30);

  // C offers the remaining 30 → fully covered
  await h.engine.advanceRequest(req.id);
  const o2 = await h.engine.submitOffer({ requestId: req.id, pharmacyId: c, userId: cUser, offeredQuantity: 30 });
  assert.equal(o2.request.status, 'FULLY_COVERED');
  assert.equal(o2.request.covered_quantity, 50);
  assert.equal(o2.request.outstanding_quantity, 0);
});

forEachDb('MREQ-036: full coverage stops expansion — farther pharmacies are never contacted', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B near', COORDS.near, 'Paracetamol', 80);
  const far = await addStockedPharmacy(h, 'Far', COORDS.far, 'Paracetamol', 500);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 50 });

  // Further advances must be no-ops on a covered request
  const after = await h.engine.advanceRequest(req.id);
  assert.equal(after.status, 'FULLY_COVERED');
  assert.equal(after.contacted.length, 0);
  const ids = (await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]))
    .map(o => Number(o.pharmacy_id));
  assert.equal(ids.includes(far), false, 'no farther pharmacy may be contacted after full coverage');
});

forEachDb('MREQ-037: declining unblocks expansion to the next zone', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B near', COORDS.near, 'Paracetamol', 80);  // could cover alone
  const c = await addStockedPharmacy(h, 'C mid', COORDS.mid, 'Paracetamol', 80);    // zone 1
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 50);
  const first = await h.engine.advanceRequest(req.id);
  assert.deepEqual(first.contacted.map(c2 => c2.pharmacyId), [b], 'only B is contacted initially');

  await h.engine.declineRequest({ requestId: req.id, pharmacyId: b, userId: bUser, reason: 'Needed locally' });

  const second = await h.engine.advanceRequest(req.id);
  assert.equal(second.contacted.some(x => x.pharmacyId === c), true,
    'after the decline the search must expand and contact C');
  assert.ok(second.zonesAdvanced >= 1);
});

forEachDb('MREQ-038: an unanswered offer expires and unblocks the search', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B near', COORDS.near, 'Paracetamol', 80);
  const c = await addStockedPharmacy(h, 'C mid', COORDS.mid, 'Paracetamol', 80);

  const req = await createStandardRequest(h, requester, 50);
  const first = await h.engine.advanceRequest(req.id);
  assert.deepEqual(first.contacted.map(x => x.pharmacyId), [b]);

  // B stays silent past the 24h response window
  h.advanceClock(25 * 60 * 60 * 1000);
  const second = await h.engine.advanceRequest(req.id);
  assert.equal(second.expiredOffers, 1, "B's offer must expire");
  assert.equal(second.contacted.some(x => x.pharmacyId === c), true,
    'silence must not block the request forever');
});

forEachDb('MREQ-039: repeated advance calls are idempotent (no duplicate contacts)', async (h) => {
  const requester = await seedRequester(h);
  await addStockedPharmacy(h, 'B near', COORDS.near, 'Paracetamol', 80);
  const req = await createStandardRequest(h, requester, 50);

  await h.engine.advanceRequest(req.id);
  await h.engine.advanceRequest(req.id);
  await h.engine.advanceRequest(req.id);

  const rows = await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]);
  assert.equal(rows.length, 1, 'repeated advances must not create duplicate offer rows');
});

// ═════════════════════════════════════════════════════════════════════════════
// OFFERS
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-040: valid offer is accepted and counts toward coverage immediately', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  const res = await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 30 });
  assert.equal(res.accepted, true);
  assert.equal(res.offer.status, 'ACCEPTED');
  assert.equal(res.offer.offered_quantity, 30);
  assert.equal(res.offer.responded_by, bUser, 'the responding user is recorded');
  assert.ok(res.offer.responded_at, 'a response timestamp is recorded');
  assert.equal(res.request.covered_quantity, 30);
  assert.equal(res.request.status, 'PARTIALLY_COVERED');
});

forEachDb('MREQ-041: offer exceeding usable stock is a CONFLICT, never clamped', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 10);
  // A well-stocked pharmacy further out keeps the request actionable, so the
  // engine does not (correctly) conclude NO_COVERAGE before we test the offer.
  await addStockedPharmacy(h, 'Deep', COORDS.mid, 'Paracetamol', 500);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  const err = await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 40
  }), 'CONFLICT', 409);
  assert.equal(err.details.offerableStock, 10);
  const fresh = await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 0, 'nothing may be recorded — no silent clamping');
  const offer = await h.db.get('SELECT status, offered_quantity FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?', [req.id, b]);
  assert.equal(offer.status, 'PENDING', 'the offer row stays PENDING');
  assert.equal(offer.offered_quantity, null);
});

forEachDb('MREQ-042: offer exceeding the outstanding quantity is a CONFLICT, never clamped', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 500);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 20);
  await h.engine.advanceRequest(req.id);

  const err = await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 25
  }), 'CONFLICT', 409);
  assert.equal(err.details.outstanding, 20);
  const fresh = await h.db.get('SELECT covered_quantity, status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 0, 'coverage must be untouched');
  assert.equal(fresh.status, 'OPEN');
});

forEachDb('MREQ-043: offer must be a positive whole number', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  for (const q of [0, -1, 2.5, 'x', null]) {
    await expectError(() => h.engine.submitOffer({
      requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: q
    }), 'VALIDATION', 400);
  }
});

forEachDb('MREQ-044: an uncontacted pharmacy cannot offer', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const outsider = await addStockedPharmacy(h, 'Outsider', COORDS.far, 'Paracetamol', 500);
  const oUser = await addUser(h, outsider, 'o@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);   // contacts B only

  await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: outsider, userId: oUser, offeredQuantity: 10
  }), 'NOT_FOUND', 404);
});

forEachDb('MREQ-045: the requester cannot offer against its own request', async (h) => {
  const requester = await seedRequester(h);
  await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const ownMed = await h.db.get('SELECT id FROM medicines WHERE pharmacy_id = ?', [requester.pharmacyId]);
  await addBatch(h, Number(ownMed.id), 'A-OWN', 500, 365);
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: requester.pharmacyId, userId: requester.userId, offeredQuantity: 10
  }), 'NOT_FOUND', 404);
});

forEachDb('MREQ-046: repeating an identical offer is idempotent; changing it conflicts', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  const first = await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  assert.equal(first.accepted, true);
  const replay = await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.accepted, false);

  const fresh = await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 20, 'a replay must not double-count coverage');

  await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 30
  }), 'CONFLICT', 409);
});

forEachDb('MREQ-047: an expired offer window blocks acceptance', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  h.advanceClock(25 * 60 * 60 * 1000);   // past the 24h window
  const err = await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20
  }), 'CONFLICT', 409);
  assert.match(String(err.message), /expired/i);
  const fresh = await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 0);
});

forEachDb('MREQ-048: no offer may be accepted after cancellation', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  await h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId });

  await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20
  }), 'CONFLICT', 409);
  const fresh = await h.db.get('SELECT covered_quantity, status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 0);
  assert.equal(fresh.status, 'CANCELLED');
});

forEachDb('MREQ-049: no offer may be accepted after full coverage', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 60);
  const c = await addStockedPharmacy(h, 'C', COORDS.near2, 'Paracetamol', 60);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 20);
  await h.engine.advanceRequest(req.id);
  // Ensure C also holds a PENDING offer
  await h.db.run(
    `INSERT INTO medicine_request_offers (request_id, pharmacy_id, zone_index, distance_km, usable_stock_at_contact, status, respond_by)
     SELECT ?, ?, 0, 9.9, 60, 'PENDING', ? WHERE NOT EXISTS
       (SELECT 1 FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?)`,
    [req.id, c, new Date(h.now() + 24 * 3600 * 1000).toISOString(), req.id, c]
  );

  await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: c, userId: cUser, offeredQuantity: 20
  }), 'CONFLICT', 409);

  const fresh = await h.db.get('SELECT covered_quantity, requested_quantity FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 20, 'coverage must not exceed the requested quantity');
  assert.equal(Number(fresh.covered_quantity) <= Number(fresh.requested_quantity), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// DECLINE
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-050: decline records pharmacy, user, timestamp and reason; is idempotent', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  const before = await snapshotInventory(h);

  const res = await h.engine.declineRequest({ requestId: req.id, pharmacyId: b, userId: bUser, reason: 'No spare stock' });
  assert.equal(res.declined, true);
  assert.equal(res.offer.status, 'DECLINED');
  assert.equal(res.offer.decline_reason, 'No spare stock');
  assert.equal(res.offer.responded_by, bUser);
  assert.ok(res.offer.responded_at);

  const replay = await h.engine.declineRequest({ requestId: req.id, pharmacyId: b, userId: bUser });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.offer.decline_reason, 'No spare stock', 'audit information is preserved');

  const covered = await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(covered.covered_quantity), 0, 'a decline must not affect coverage');
  const after = await snapshotInventory(h);
  assert.equal(after.batches, before.batches);
  assert.equal(after.movements, before.movements);
});

forEachDb('MREQ-051: a zero-stock pharmacy can decline (and cannot offer)', async (h) => {
  const requester = await seedRequester(h);
  const partial = await addStockedPharmacy(h, 'B partial', COORDS.near, 'Paracetamol', 10);
  const zero = await addStockedPharmacy(h, 'C zero', COORDS.near2, 'Paracetamol', 0);
  // Keeps the request actionable so it does not reach NO_COVERAGE first.
  await addStockedPharmacy(h, 'Deep', COORDS.mid, 'Paracetamol', 500);
  const zUser = await addUser(h, zero, 'z@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);   // zone cannot cover → zero-stock is contacted

  const incoming = await h.engine.listIncomingForPharmacy(zero);
  assert.equal(incoming.length, 1, 'the zero-stock pharmacy sees the request');
  assert.equal(incoming[0].usableStock, 0);
  assert.equal(incoming[0].canOffer, false, 'it must not be offered the Offer action');

  await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: zero, userId: zUser, offeredQuantity: 1
  }), 'CONFLICT', 409);

  const res = await h.engine.declineRequest({ requestId: req.id, pharmacyId: zero, userId: zUser });
  assert.equal(res.declined, true, 'it can still decline');
});

// ═════════════════════════════════════════════════════════════════════════════
// CANCEL / LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-060: only the requester can cancel; others get NOT_FOUND', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  await expectError(() => h.engine.cancelRequest({ requestId: req.id, pharmacyId: b }), 'NOT_FOUND', 404);
  const still = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(still.status, 'OPEN', "another pharmacy must not change the requester's request");

  const res = await h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId });
  assert.equal(res.cancelled, true);
  assert.equal(res.request.status, 'CANCELLED');
});

forEachDb('MREQ-061: cancellation supersedes pending offers and preserves history', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  await h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId });
  const offers = await h.db.query('SELECT status FROM medicine_request_offers WHERE request_id = ?', [req.id]);
  assert.equal(offers.length, 1, 'historical offer rows are preserved');
  assert.equal(offers[0].status, 'SUPERSEDED');

  const replay = await h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId });
  assert.equal(replay.idempotentReplay, true, 'cancellation is idempotent');
});

forEachDb('MREQ-065: a NO_COVERAGE request is still cancellable while within its lifetime', async (h) => {
  const requester = await seedRequester(h);
  // Only an out-of-range pharmacy, so the search exhausts every zone.
  await addStockedPharmacy(h, 'Delhi', COORDS.delhi, 'Paracetamol', 500);
  const before = await snapshotInventory(h);

  const req = await createStandardRequest(h, requester, 50);
  const summary = await h.engine.advanceRequest(req.id);
  assert.equal(summary.status, 'NO_COVERAGE', 'precondition: the search must exhaust all zones');

  // The record is still within its 72h lifetime.
  const live = await h.db.get('SELECT expires_at FROM medicine_requests WHERE id = ?', [req.id]);
  assert.ok(new Date(live.expires_at).getTime() > h.now(), 'precondition: not yet expired');

  // NO_COVERAGE -> CANCELLED is permitted.
  const res = await h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId });
  assert.equal(res.cancelled, true);
  assert.equal(res.request.status, 'CANCELLED');

  // Cancellation is a pure status transition: no offers created, no search restarted.
  assert.equal(Number(res.request.current_zone_index), 3, 'the zone index must not be rewound');
  assert.equal(Number(res.request.current_radius_km), 100, 'the radius must not be reset to 10 km');
  assert.equal(Number(res.request.covered_quantity), 0, 'coverage must be untouched');

  // Idempotent repeat.
  const again = await h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId });
  assert.equal(again.idempotentReplay, true);
  assert.equal(again.request.status, 'CANCELLED');

  // No inventory movement.
  const after = await snapshotInventory(h);
  assert.equal(after.batches, before.batches);
  assert.equal(after.movements, before.movements);
  assert.equal(after.movements, 0);
});

forEachDb('MREQ-066: EXPIRED remains non-cancellable and tenant isolation still holds', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'Pharmacy B', COORDS.near, 'Paracetamol', 80);
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  // A non-requester can never cancel, whatever the status.
  await expectError(() => h.engine.cancelRequest({ requestId: req.id, pharmacyId: b }), 'NOT_FOUND', 404);

  // Let the request expire, then confirm cancellation is refused.
  h.advanceClock(73 * 60 * 60 * 1000);
  await h.engine.expireDue();
  assert.equal((await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [req.id])).status, 'EXPIRED');
  const err = await expectError(
    () => h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId }),
    'CONFLICT', 409);
  assert.match(String(err.message), /can no longer be cancelled \(EXPIRED\)/);
});

forEachDb('MREQ-062: request lifecycle covers OPEN, PARTIALLY_COVERED, FULLY_COVERED', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 20);
  const c = await addStockedPharmacy(h, 'C', COORDS.mid, 'Paracetamol', 40);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 50);
  assert.equal(req.status, 'OPEN');
  await h.engine.advanceRequest(req.id);
  const s1 = await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  assert.equal(s1.request.status, 'PARTIALLY_COVERED');
  await h.engine.advanceRequest(req.id);
  const s2 = await h.engine.submitOffer({ requestId: req.id, pharmacyId: c, userId: cUser, offeredQuantity: 30 });
  assert.equal(s2.request.status, 'FULLY_COVERED');
});

forEachDb('MREQ-063: an expired request accepts no further offers', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  h.advanceClock(73 * 60 * 60 * 1000);
  await h.engine.expireDue();
  const fresh = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(fresh.status, 'EXPIRED');

  await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20
  }), 'CONFLICT', 409);
});

forEachDb('MREQ-064: advancing a terminal request is a safe no-op', async (h) => {
  const requester = await seedRequester(h);
  await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.cancelRequest({ requestId: req.id, pharmacyId: requester.pharmacyId });
  const summary = await h.engine.advanceRequest(req.id);
  assert.equal(summary.changed, false);
  assert.equal(summary.status, 'CANCELLED');
  assert.equal(summary.contacted.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// TENANT ISOLATION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-070: pharmacy A cannot respond on pharmacy B\'s behalf', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const c = await addStockedPharmacy(h, 'C', COORDS.far, 'Paracetamol', 80);
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);   // contacts B only

  // C was never contacted, so it can neither offer nor decline
  await expectError(() => h.engine.submitOffer({
    requestId: req.id, pharmacyId: c, userId: cUser, offeredQuantity: 10
  }), 'NOT_FOUND', 404);
  await expectError(() => h.engine.declineRequest({
    requestId: req.id, pharmacyId: c, userId: cUser
  }), 'NOT_FOUND', 404);

  const bOffer = await h.db.get('SELECT status FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?', [req.id, b]);
  assert.equal(bOffer.status, 'PENDING', "B's offer must be untouched by C's attempts");
});

forEachDb('MREQ-071: an unrelated pharmacy cannot read a request', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const unrelated = await addPharmacy(h, 'Unrelated', COORDS.delhi);
  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);

  // Requester sees everything
  const asRequester = await h.engine.getRequestDetail(req.id, requester.pharmacyId);
  assert.equal(asRequester.viewerRole, 'REQUESTER');
  assert.equal(asRequester.offers.length, 1);

  // A contacted pharmacy sees only its own response
  const asRecipient = await h.engine.getRequestDetail(req.id, b);
  assert.equal(asRecipient.viewerRole, 'RECIPIENT');
  assert.equal(asRecipient.offers.every(o => o.pharmacy_id === b), true);

  // An unrelated pharmacy gets NOT_FOUND (no existence disclosure)
  await expectError(() => h.engine.getRequestDetail(req.id, unrelated), 'NOT_FOUND', 404);
});

forEachDb('MREQ-072: listRequestsForPharmacy is scoped to the owning pharmacy', async (h) => {
  const requester = await seedRequester(h);
  const otherPid = await addPharmacy(h, 'Other', COORDS.near);
  const otherUid = await addUser(h, otherPid, 'o@x.com', 'STAFF');
  await addMedicine(h, otherPid, 'Paracetamol');

  await createStandardRequest(h, requester, 50);
  await h.engine.createRequest({
    pharmacyId: otherPid, userId: otherUid, medicineName: 'Paracetamol',
    requestedQuantity: 10, idempotencyKey: newKey()
  });

  // Returns { requests, total, limit, offset } — paginated for API exposure.
  const mine = await h.engine.listRequestsForPharmacy(requester.pharmacyId);
  assert.equal(mine.requests.length, 1);
  assert.equal(mine.total, 1);
  assert.equal(mine.requests[0].requester_pharmacy_id, requester.pharmacyId);
  assert.ok(mine.requests[0].offerSummary, 'an offer summary is included for the requester');

  const theirs = await h.engine.listRequestsForPharmacy(otherPid);
  assert.equal(theirs.requests.length, 1);
  assert.equal(theirs.total, 1);
  assert.equal(theirs.requests[0].requester_pharmacy_id, otherPid);

  // Filters are scoped too
  const filtered = await h.engine.listRequestsForPharmacy(requester.pharmacyId, { status: 'OPEN' });
  assert.ok(filtered.requests.every(r => r.requester_pharmacy_id === requester.pharmacyId));
});

// ═════════════════════════════════════════════════════════════════════════════
// INVENTORY SAFETY
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-080: the full workflow never moves inventory', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 20);
  const c = await addStockedPharmacy(h, 'C', COORDS.mid, 'Paracetamol', 40);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');
  const before = await snapshotInventory(h);

  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  await h.engine.advanceRequest(req.id);
  await h.engine.submitOffer({ requestId: req.id, pharmacyId: c, userId: cUser, offeredQuantity: 30 });

  const covered = await h.db.get('SELECT status, covered_quantity FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(covered.status, 'FULLY_COVERED');
  assert.equal(Number(covered.covered_quantity), 50);

  const after = await snapshotInventory(h);
  assert.equal(after.batches, before.batches, 'no medicine_batches row may change');
  assert.equal(after.movements, before.movements, 'no inventory_movements row may be created');
  assert.equal(after.movements, 0);
});

forEachDb('MREQ-081: the engine never touches the automatic near-expiry table', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 80);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 50);
  await h.engine.advanceRequest(req.id);
  await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 50 });
  await h.engine.expireDue();

  const redis = await h.db.get('SELECT COUNT(*) AS n FROM medicine_redistribution_requests');
  assert.equal(Number(redis.n), 0,
    'the manual engine must never write to medicine_redistribution_requests');
});

// ═════════════════════════════════════════════════════════════════════════════
// CONCURRENCY — the critical guarantee
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-090: two simultaneous offers for the last units cannot overshoot', async (h) => {
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 100);
  const c = await addStockedPharmacy(h, 'C', COORDS.near2, 'Paracetamol', 100);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 20);
  await h.engine.advanceRequest(req.id);
  // Guarantee both hold PENDING offers
  const respondBy = new Date(h.now() + 24 * 3600 * 1000).toISOString();
  for (const pid of [b, c]) {
    await h.db.run(
      `INSERT INTO medicine_request_offers (request_id, pharmacy_id, zone_index, distance_km, usable_stock_at_contact, status, respond_by)
       SELECT ?, ?, 0, 5.0, 100, 'PENDING', ? WHERE NOT EXISTS
         (SELECT 1 FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?)`,
      [req.id, pid, respondBy, req.id, pid]
    );
  }

  // Both try to take the entire outstanding 20 at once.
  const results = await Promise.allSettled([
    h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 }),
    h.engine.submitOffer({ requestId: req.id, pharmacyId: c, userId: cUser, offeredQuantity: 20 })
  ]);

  const ok = results.filter(r => r.status === 'fulfilled' && r.value.accepted);
  const failed = results.filter(r => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one offer may succeed');
  assert.equal(failed.length, 1, 'the other must fail cleanly');
  assert.equal(failed[0].reason.code, 'CONFLICT');
  assert.equal(failed[0].reason.status, 409);

  const fresh = await h.db.get('SELECT covered_quantity, requested_quantity, status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 20, 'coverage must be exactly 20, never 40');
  assert.ok(Number(fresh.covered_quantity) <= Number(fresh.requested_quantity));
  assert.equal(fresh.status, 'FULLY_COVERED');

  // No partial/corrupt offer may remain
  const accepted = await h.db.query(
    "SELECT pharmacy_id, offered_quantity FROM medicine_request_offers WHERE request_id = ? AND status = 'ACCEPTED'", [req.id]);
  assert.equal(accepted.length, 1, 'exactly one ACCEPTED offer row');
  assert.equal(Number(accepted[0].offered_quantity), 20);
});

forEachDb('MREQ-091: concurrent partial offers sum exactly to the requested quantity', async (h) => {
  const requester = await seedRequester(h);
  const pharmacies = [];
  const coordsList = [COORDS.near, COORDS.near2, COORDS.mid, COORDS.far];
  for (let i = 0; i < 4; i++) {
    const pid = await addStockedPharmacy(h, `P${i}`, coordsList[i], 'Paracetamol', 100);
    pharmacies.push({ pid, uid: await addUser(h, pid, `p${i}@x.com`, 'STAFF') });
  }

  const req = await createStandardRequest(h, requester, 30);
  const respondBy = new Date(h.now() + 24 * 3600 * 1000).toISOString();
  for (const p of pharmacies) {
    await h.db.run(
      `INSERT INTO medicine_request_offers (request_id, pharmacy_id, zone_index, distance_km, usable_stock_at_contact, status, respond_by)
       VALUES (?, ?, 0, 5.0, 100, 'PENDING', ?)`,
      [req.id, p.pid, respondBy]
    );
  }

  // Four pharmacies each try to offer 10 against an outstanding 30.
  const results = await Promise.allSettled(pharmacies.map(p =>
    h.engine.submitOffer({ requestId: req.id, pharmacyId: p.pid, userId: p.uid, offeredQuantity: 10 })
  ));
  const accepted = results.filter(r => r.status === 'fulfilled' && r.value.accepted).length;
  assert.equal(accepted, 3, 'exactly three 10-unit offers fit into 30');

  const fresh = await h.db.get('SELECT covered_quantity, requested_quantity, status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 30);
  assert.ok(Number(fresh.covered_quantity) <= Number(fresh.requested_quantity),
    'the coverage invariant must always hold');
  assert.equal(fresh.status, 'FULLY_COVERED');

  const sum = await h.db.get(
    "SELECT COALESCE(SUM(offered_quantity),0) AS total FROM medicine_request_offers WHERE request_id = ? AND status = 'ACCEPTED'", [req.id]);
  assert.equal(Number(sum.total), 30, 'accepted offer quantities must sum to covered_quantity');
});

forEachDb('MREQ-094: the coverage CAS predicate itself rejects an overshooting update', async (h) => {
  // The parallel-submission tests prove the invariant holds, but in practice the
  // engine's pre-validation usually catches the loser first, so they do not
  // isolate the CAS. This test executes the exact conditional UPDATE the engine
  // uses and asserts the predicate is what blocks an overshoot — the last line of
  // defence if two transactions ever read before either writes.
  const requester = await seedRequester(h);
  const req = await createStandardRequest(h, requester, 30);

  const cas = (qty) => h.db.run(`
    UPDATE medicine_requests
    SET covered_quantity = covered_quantity + ?,
        status = CASE WHEN covered_quantity + ? >= requested_quantity
                      THEN 'FULLY_COVERED' ELSE 'PARTIALLY_COVERED' END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status IN ('OPEN', 'PARTIALLY_COVERED')
      AND covered_quantity + ? <= requested_quantity
  `, [qty, qty, req.id, qty]);

  // 20 of 30 fits
  const first = await cas(20);
  assert.equal(Number(first.changes), 1, 'a fitting update must apply');
  let row = await h.db.get('SELECT covered_quantity, status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(row.covered_quantity), 20);
  assert.equal(row.status, 'PARTIALLY_COVERED');

  // A second 20 would make 40 > 30 — the predicate must reject it outright,
  // matching zero rows rather than raising a constraint violation.
  const second = await cas(20);
  assert.equal(Number(second.changes), 0,
    'the CAS predicate must reject an overshooting update by matching no rows');
  row = await h.db.get('SELECT covered_quantity, status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(row.covered_quantity), 20, 'coverage must be unchanged after a rejected CAS');

  // Exactly filling the remainder still works
  const third = await cas(10);
  assert.equal(Number(third.changes), 1);
  row = await h.db.get('SELECT covered_quantity, status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(row.covered_quantity), 30);
  assert.equal(row.status, 'FULLY_COVERED', 'reaching the requested quantity flips to FULLY_COVERED');

  // And once FULLY_COVERED the status predicate blocks any further coverage
  const fourth = await cas(1);
  assert.equal(Number(fourth.changes), 0, 'a covered request accepts no further coverage');
});

forEachDb('MREQ-093: overshoot is blocked even while the request stays PARTIALLY_COVERED', async (h) => {
  // This isolates the CAS quantity predicate specifically. Two pharmacies each
  // offer 20 against a request for 30. Both pass pre-validation (20 <= 30), and
  // after the first commits the request is PARTIALLY_COVERED — so the CAS status
  // predicate alone would NOT stop the second. Only the
  // "covered_quantity + ? <= requested_quantity" predicate prevents 20+20=40.
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 100);
  const c = await addStockedPharmacy(h, 'C', COORDS.near2, 'Paracetamol', 100);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');

  const req = await createStandardRequest(h, requester, 30);
  const respondBy = new Date(h.now() + 24 * 3600 * 1000).toISOString();
  for (const pid of [b, c]) {
    await h.db.run(
      `INSERT INTO medicine_request_offers (request_id, pharmacy_id, zone_index, distance_km, usable_stock_at_contact, status, respond_by)
       SELECT ?, ?, 0, 5.0, 100, 'PENDING', ? WHERE NOT EXISTS
         (SELECT 1 FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?)`,
      [req.id, pid, respondBy, req.id, pid]
    );
  }

  const results = await Promise.allSettled([
    h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 }),
    h.engine.submitOffer({ requestId: req.id, pharmacyId: c, userId: cUser, offeredQuantity: 20 })
  ]);

  const accepted = results.filter(r => r.status === 'fulfilled' && r.value.accepted);
  assert.equal(accepted.length, 1, 'only one 20-unit offer fits into 30 without overshooting');
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'CONFLICT',
    `the loser must get a clean domain CONFLICT, got ${rejected[0].reason && rejected[0].reason.code}`);

  const fresh = await h.db.get('SELECT covered_quantity, requested_quantity, status FROM medicine_requests WHERE id = ?', [req.id]);
  assert.equal(Number(fresh.covered_quantity), 20, 'coverage must be 20, never 40');
  assert.ok(Number(fresh.covered_quantity) <= Number(fresh.requested_quantity),
    'the coverage invariant must hold');
  assert.equal(fresh.status, 'PARTIALLY_COVERED', 'the request remains partially covered');

  const acceptedRows = await h.db.query(
    "SELECT offered_quantity FROM medicine_request_offers WHERE request_id = ? AND status = 'ACCEPTED'", [req.id]);
  assert.equal(acceptedRows.length, 1, 'exactly one ACCEPTED offer row — no partial/corrupt state');
});

forEachDb('MREQ-092: concurrent advances create no duplicate offer rows', async (h) => {
  const requester = await seedRequester(h);
  await addStockedPharmacy(h, 'B', COORDS.near, 'Paracetamol', 10);
  await addStockedPharmacy(h, 'C', COORDS.near2, 'Paracetamol', 10);
  const req = await createStandardRequest(h, requester, 50);

  await Promise.allSettled([
    h.engine.advanceRequest(req.id),
    h.engine.advanceRequest(req.id),
    h.engine.advanceRequest(req.id)
  ]);

  const rows = await h.db.query('SELECT pharmacy_id, COUNT(*) AS c FROM medicine_request_offers WHERE request_id = ? GROUP BY pharmacy_id', [req.id]);
  for (const r of rows) {
    assert.equal(Number(r.c), 1, `pharmacy ${r.pharmacy_id} must hold exactly one offer row`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// END-TO-END
// ═════════════════════════════════════════════════════════════════════════════

forEachDb('MREQ-100: three-pharmacy end-to-end progressive search', async (h) => {
  // A (Mumbai) needs 50. B ~5.5km has 20. C ~18km has 40. D ~39km has 500.
  const requester = await seedRequester(h);
  const b = await addStockedPharmacy(h, 'Pharmacy B', COORDS.near, 'Paracetamol', 20);
  const c = await addStockedPharmacy(h, 'Pharmacy C', COORDS.mid, 'Paracetamol', 40);
  const d = await addStockedPharmacy(h, 'Pharmacy D', COORDS.far, 'Paracetamol', 500);
  const bUser = await addUser(h, b, 'b@x.com', 'STAFF');
  const cUser = await addUser(h, c, 'c@x.com', 'STAFF');
  const before = await snapshotInventory(h);

  const req = await createStandardRequest(h, requester, 50);

  // Zone 0 (10 km) holds only B with 20 — cannot cover 50, so the search
  // expands and also reaches C in zone 1.
  const first = await h.engine.advanceRequest(req.id);
  const contactedFirst = first.contacted.map(x => x.pharmacyId);
  assert.ok(contactedFirst.includes(b), 'B must be contacted in zone 0');
  assert.ok(contactedFirst.includes(c), 'the search must expand to reach C');
  assert.equal(contactedFirst.includes(d), false,
    'D is unnecessary once B+C capacity (60) covers the outstanding 50');

  // B offers 20 → partial
  const s1 = await h.engine.submitOffer({ requestId: req.id, pharmacyId: b, userId: bUser, offeredQuantity: 20 });
  assert.equal(s1.request.status, 'PARTIALLY_COVERED');
  assert.equal(s1.request.outstanding_quantity, 30);

  // C offers 30 → fully covered
  const s2 = await h.engine.submitOffer({ requestId: req.id, pharmacyId: c, userId: cUser, offeredQuantity: 30 });
  assert.equal(s2.request.status, 'FULLY_COVERED');
  assert.equal(s2.request.covered_quantity, 50);
  assert.equal(s2.request.outstanding_quantity, 0);

  // Requester view
  const detail = await h.engine.getRequestDetail(req.id, requester.pharmacyId);
  assert.equal(detail.coveredQuantity, 50);
  assert.equal(detail.remainingQuantity, 0);
  assert.equal(detail.request.status, 'FULLY_COVERED');
  const acceptedOffers = detail.offers.filter(o => o.status === 'ACCEPTED');
  assert.equal(acceptedOffers.length, 2);
  assert.deepEqual(acceptedOffers.map(o => o.offered_quantity).sort((x, y) => x - y), [20, 30]);
  for (const o of acceptedOffers) {
    assert.ok(o.distance_km > 0, 'each offer carries a real distance');
  }

  // Further advance is a no-op and D is still never contacted
  const after = await h.engine.advanceRequest(req.id);
  assert.equal(after.contacted.length, 0);
  const allIds = (await h.db.query('SELECT pharmacy_id FROM medicine_request_offers WHERE request_id = ?', [req.id]))
    .map(o => Number(o.pharmacy_id));
  assert.equal(allIds.includes(d), false, 'D must never be contacted');

  // Nothing moved
  const inv = await snapshotInventory(h);
  assert.equal(inv.batches, before.batches);
  assert.equal(inv.movements, before.movements);
  assert.equal(inv.movements, 0);
});
