'use strict';
/**
 * tests/medicine-requests-hardening.test.js
 *
 * PHASE 4 — closes the remaining test gaps for the manual medicine-request
 * engine and API. No production behaviour is changed by this file.
 *
 * The concurrency tests run against REAL PostgreSQL and are deliberately
 * constructed to be non-vacuous: HARD-060 forces a genuine read-interleave with
 * a barrier so that the coverage CAS quantity predicate is the ONLY thing
 * standing between two stale-read transactions and an overshoot. Removing that
 * predicate makes HARD-060 fail (evidence recorded in the Phase 4 report).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const U = require('./medicine-request-test-utils');
const {
  COORDS, forEachDb, pgOnly, login, addTenant, addMedicine, addBatch,
  setupRequester, createRequest, inventorySnapshot, assertSafeJson, newKey, demoPharmacyId
} = U;

const OFFER_URL   = (id) => `/api/inter-pharmacy/medicine-requests/${id}/offer`;
const DECLINE_URL = (id) => `/api/inter-pharmacy/medicine-requests/${id}/decline`;
const CANCEL_URL  = (id) => `/api/inter-pharmacy/medicine-requests/${id}/cancel`;
const ADVANCE_URL = (id) => `/api/inter-pharmacy/medicine-requests/${id}/advance`;
const DETAIL_URL  = (id) => `/api/inter-pharmacy/medicine-requests/${id}`;

async function offersFor(h, requestId) {
  return h.db.query(
    `SELECT pharmacy_id, status, offered_quantity, zone_index, distance_km,
            usable_stock_at_contact, respond_by, contacted_at
     FROM medicine_request_offers WHERE request_id = ? ORDER BY zone_index, distance_km`,
    [requestId]
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. SYNCHRONOUS FIRST-ADVANCE FAILURE
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-001: a failing initial advance leaves a valid request and no partial contact state', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Tenant B', COORDS.near, { stock: 80 });
  const cookie = await login(h, 'staff@mediindex.local');

  // Force the synchronous first advance to fail in a controlled way by stubbing
  // the engine method the route calls. Production code is untouched.
  const engine = h.core.medicineRequestEngine;
  const real = engine.advanceRequest;
  let calls = 0;
  engine.advanceRequest = async (...args) => {
    calls++;
    throw new Error('simulated advance failure');
  };

  let created;
  try {
    created = await createRequest(h, cookie);
  } finally {
    engine.advanceRequest = real;   // always restore
  }

  assert.equal(calls, 1, 'the route must have attempted the initial advance');

  // The request itself must still be created and returned normally.
  assert.equal(created.status, 201, created.raw);
  assertSafeJson(created);
  const id = created.body.request.id;
  assert.equal(created.body.request.status, 'OPEN', 'the request must remain valid and OPEN');
  assert.equal(created.body.request.coveredQuantity, 0);
  assert.equal(created.body.created, true);
  assert.equal(created.body.search, null, 'a failed advance must report no search result');
  assert.doesNotMatch(created.raw, /simulated advance failure/, 'internal failure detail must not leak');

  // Persisted, with no partial or corrupt contact state.
  const row = await h.db.get('SELECT status, covered_quantity FROM medicine_requests WHERE id = ?', [id]);
  assert.ok(row, 'the request must be persisted');
  assert.equal(row.status, 'OPEN');
  assert.equal(Number(row.covered_quantity), 0);
  assert.equal((await offersFor(h, id)).length, 0, 'no offer/contact rows may be left behind');

  // A later advance recovers the request.
  const recovered = await h.request({ method: 'POST', url: ADVANCE_URL(id), cookie, body: {} });
  assert.equal(recovered.status, 200, recovered.raw);
  assert.equal(recovered.body.request.status, 'OPEN');
  const offers = await offersFor(h, id);
  assert.equal(offers.length, 1, 'recovery must contact the first zone');
  assert.equal(Number(offers[0].pharmacy_id), b.pharmacyId);
  assert.equal(offers[0].status, 'PENDING');

  // And the recovered request is fully usable.
  const o = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: await login(h, b.staffEmail), body: { offeredQuantity: 50 } });
  assert.equal(o.status, 200, o.raw);
  assert.equal(o.body.request.status, 'FULLY_COVERED');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. PROGRESSIVE SEARCH E2E — the exact required scenario
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-010: A needs 50; zone 1 has B=20 and C=0; zone 2 has D=30', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near,  { stock: 20 });  // ~5.5 km, zone 0
  const c = await addTenant(h, 'Pharmacy C', COORDS.near2, { stock: 0  });  // ~9.9 km, zone 0, no stock
  const d = await addTenant(h, 'Pharmacy D', COORDS.mid,   { stock: 30 });  // ~18 km,  zone 1
  const e = await addTenant(h, 'Pharmacy E', COORDS.far,   { stock: 500 }); // ~39 km,  zone 2 — must stay untouched
  const before = await inventorySnapshot(h);

  const reqCookie = await login(h, 'staff@mediindex.local');
  const created = await createRequest(h, reqCookie, { requestedQuantity: 50 });
  assert.equal(created.status, 201, created.raw);
  const id = created.body.request.id;

  // Zone 0 stock-bearing capacity is 20 < 50, so by the approved rule every
  // remaining eligible pharmacy in zone 0 is contacted — including zero-stock C —
  // and the search then expands to zone 1 and reaches D.
  const contacted = await offersFor(h, id);
  const ids = contacted.map(o => Number(o.pharmacy_id));
  assert.ok(ids.includes(b.pharmacyId), 'B must be contacted in zone 0');
  assert.ok(ids.includes(c.pharmacyId), 'zero-stock C must be contacted once zone 0 cannot cover');
  assert.ok(ids.includes(d.pharmacyId), 'the search must expand to zone 1 and reach D');
  assert.equal(ids.includes(e.pharmacyId), false,
    'E must NOT be contacted: B(20)+D(30) already covers the outstanding 50');

  const cRow = contacted.find(o => Number(o.pharmacy_id) === c.pharmacyId);
  assert.equal(Number(cRow.usable_stock_at_contact ?? 0), 0);
  assert.equal(Number(contacted.find(o => Number(o.pharmacy_id) === b.pharmacyId).zone_index), 0);
  assert.equal(Number(contacted.find(o => Number(o.pharmacy_id) === d.pharmacyId).zone_index), 1,
    'D must be recorded as reached in zone 1');

  // C cannot make a positive offer, but can decline.
  const cCookie = await login(h, c.staffEmail);
  const cOffer = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: cCookie, body: { offeredQuantity: 1 } });
  assert.equal(cOffer.status, 409, 'a zero-stock pharmacy cannot offer');
  assertSafeJson(cOffer);
  const cDecline = await h.request({ method: 'POST', url: DECLINE_URL(id), cookie: cCookie, body: { reason: 'No stock' } });
  assert.equal(cDecline.status, 200, cDecline.raw);
  assert.equal(cDecline.body.offer.status, 'DECLINED');

  // B offers 20 -> partial
  const bOffer = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: await login(h, b.staffEmail), body: { offeredQuantity: 20 } });
  assert.equal(bOffer.status, 200, bOffer.raw);
  assert.equal(bOffer.body.request.status, 'PARTIALLY_COVERED');
  assert.equal(bOffer.body.remainingQuantity, 30);

  // D offers 30 -> fully covered
  const dOffer = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: await login(h, d.staffEmail), body: { offeredQuantity: 30 } });
  assert.equal(dOffer.status, 200, dOffer.raw);
  assert.equal(dOffer.body.request.status, 'FULLY_COVERED');
  assert.equal(dOffer.body.remainingQuantity, 0);

  // No farther pharmacy is contacted afterwards, even if advance is called again.
  const after = await h.request({ method: 'POST', url: ADVANCE_URL(id), cookie: reqCookie, body: {} });
  assert.equal(after.body.request.status, 'FULLY_COVERED');
  const finalIds = (await offersFor(h, id)).map(o => Number(o.pharmacy_id));
  assert.equal(finalIds.includes(e.pharmacyId), false, 'E must never be contacted');

  // Inventory untouched throughout.
  const inv = await inventorySnapshot(h);
  assert.equal(inv.batches, before.batches);
  assert.equal(inv.movements, before.movements);
  assert.equal(inv.movements, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. NEAREST-FIRST ORDERING
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-020: four same-zone pharmacies are ordered by real Haversine distance', async (h) => {
  await setupRequester(h);
  // All four are inside zone 0 (10 km) with ascending true distances.
  const p3 = await addTenant(h, 'P 2.9km', COORDS.d3,    { stock: 5 });
  const p5 = await addTenant(h, 'P 5.5km', COORDS.near,  { stock: 5 });
  const p9 = await addTenant(h, 'P 9.9km', COORDS.near2, { stock: 5 });
  const requester = await demoPharmacyId(h);

  const engine = h.core.medicineRequestEngine;
  const reqCookie = await login(h, 'staff@mediindex.local');
  // A request larger than the zone can cover so all of them get contacted.
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 50 })).body.request.id;
  const request = await h.db.get('SELECT * FROM medicine_requests WHERE id = ?', [id]);

  const eligible = await engine.findEligiblePharmacies(
    { id: Number(request.id), requester_pharmacy_id: requester, medicine_name: request.medicine_name },
    10
  );
  // findEligiblePharmacies excludes already-contacted pharmacies, so query a
  // fresh request to observe ordering directly.
  const fresh = (await createRequest(h, reqCookie, { requestedQuantity: 50 })).body.request.id;
  const freshRow = await h.db.get('SELECT * FROM medicine_requests WHERE id = ?', [fresh]);
  const ordered = await engine.findEligiblePharmacies(
    { id: 0, requester_pharmacy_id: requester, medicine_name: freshRow.medicine_name },
    10
  );

  assert.equal(ordered.length, 3, 'all three same-zone pharmacies are eligible');
  const distances = ordered.map(o => o.distanceKm);
  for (let i = 1; i < distances.length; i++) {
    assert.ok(distances[i] >= distances[i - 1],
      `distances must ascend, got ${JSON.stringify(distances)}`);
  }
  assert.deepEqual(ordered.map(o => o.pharmacyId), [p3.pharmacyId, p5.pharmacyId, p9.pharmacyId],
    'ordering must be nearest-first by true Haversine distance');
  // Sanity-check the measured values rather than trusting the sort alone.
  assert.ok(distances[0] > 2 && distances[0] < 4,  `expected ~2.9 km, got ${distances[0]}`);
  assert.ok(distances[1] > 4 && distances[1] < 8,  `expected ~5.5 km, got ${distances[1]}`);
  assert.ok(distances[2] > 8 && distances[2] < 12, `expected ~9.9 km, got ${distances[2]}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. ZERO-STOCK / NO-CATALOGUE RULE
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-030: stock-bearing pharmacies are contacted first and alone when they suffice', async (h) => {
  await setupRequester(h);
  // Zero-stock and no-catalogue pharmacies are NEARER than the stocked one.
  const zero   = await addTenant(h, 'Zero near',  COORDS.d3,   { stock: 0 });
  const noCat  = await addTenant(h, 'NoCat near', COORDS.near, { withCatalogue: false });
  const stocked = await addTenant(h, 'Stocked',   COORDS.near2, { stock: 80 });

  const cookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, cookie, { requestedQuantity: 50 })).body.request.id;

  const ids = (await offersFor(h, id)).map(o => Number(o.pharmacy_id));
  assert.deepEqual(ids, [stocked.pharmacyId],
    'only the stock-bearing pharmacy is contacted while it can cover the need');
  assert.equal(ids.includes(zero.pharmacyId), false, 'a nearer zero-stock pharmacy must not be disturbed');
  assert.equal(ids.includes(noCat.pharmacyId), false, 'a nearer no-catalogue pharmacy must not be disturbed');
});

forEachDb(test, 'HARD-031: zero-stock and no-catalogue pharmacies are contacted once the zone cannot cover', async (h) => {
  await setupRequester(h);
  const partial = await addTenant(h, 'Partial', COORDS.d3,    { stock: 10 });
  const zero    = await addTenant(h, 'Zero',    COORDS.near,  { stock: 0 });
  const noCat   = await addTenant(h, 'NoCat',   COORDS.near2, { withCatalogue: false });
  const deep    = await addTenant(h, 'Deep',    COORDS.mid,   { stock: 500 });

  const cookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, cookie, { requestedQuantity: 50 })).body.request.id;

  const rows = await offersFor(h, id);
  const ids = rows.map(o => Number(o.pharmacy_id));
  assert.ok(ids.includes(partial.pharmacyId), 'the partially stocked pharmacy is contacted');
  assert.ok(ids.includes(zero.pharmacyId),    'zero-stock is contacted once zone 0 cannot cover');
  assert.ok(ids.includes(noCat.pharmacyId),   'no-catalogue is contacted once zone 0 cannot cover');
  assert.ok(ids.includes(deep.pharmacyId),    'the search also expands to zone 1');

  for (const pid of [zero.pharmacyId, noCat.pharmacyId]) {
    const row = rows.find(o => Number(o.pharmacy_id) === pid);
    assert.equal(Number(row.usable_stock_at_contact), 0, 'their snapshot stock is recorded as 0');
  }

  // Neither can make a positive offer; both can decline.
  for (const t of [zero, noCat]) {
    const c = await login(h, t.staffEmail);
    const bad = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: c, body: { offeredQuantity: 1 } });
    assert.equal(bad.status, 409, `${t.name} must not be able to offer`);
    const ok = await h.request({ method: 'POST', url: DECLINE_URL(id), cookie: c, body: {} });
    assert.equal(ok.status, 200, `${t.name} must be able to decline: ${ok.raw}`);
  }

  // Their incoming view tells them they cannot offer.
  const view = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/incoming', cookie: await login(h, deep.staffEmail) });
  assert.equal(view.status, 200);
  assert.equal(view.body.incoming[0].canOffer, true, 'the stocked pharmacy can offer');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. SOFT RESERVATION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-040: B has 50; offering 30 reserves it; the same units cannot be promised twice', async (h) => {
  const aPid = await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near, { stock: 50 });
  // A second requester so B can be asked twice for the same medicine.
  const a2 = await addTenant(h, 'Requester 2', COORDS.d3, { withCatalogue: false });
  await addMedicine(h, a2.pharmacyId, 'Paracetamol');
  const before = await inventorySnapshot(h);

  const engine = h.core.medicineRequestEngine;
  assert.equal((await engine.calculateOfferableStock(b.pharmacyId, 'Paracetamol')).offerableStock, 50);

  // Request 1 from A: B offers 30.
  const aCookie = await login(h, 'staff@mediindex.local');
  const r1 = (await createRequest(h, aCookie, { requestedQuantity: 30 })).body.request.id;
  const bCookie = await login(h, b.staffEmail);
  const o1 = await h.request({ method: 'POST', url: OFFER_URL(r1), cookie: bCookie, body: { offeredQuantity: 30 } });
  assert.equal(o1.status, 200, o1.raw);

  let stock = await engine.calculateOfferableStock(b.pharmacyId, 'Paracetamol');
  assert.equal(stock.usableStock, 50, 'physical stock is unchanged');
  assert.equal(stock.reservedStock, 30, '30 units are soft-reserved');
  assert.equal(stock.offerableStock, 20, 'only 20 remain promisable');

  // Request 2 from the second requester: B cannot promise the same 30 again.
  const a2Cookie = await login(h, a2.staffEmail);
  const r2 = (await h.request({
    method: 'POST', url: '/api/inter-pharmacy/medicine-requests', cookie: a2Cookie,
    body: { medicineName: 'Paracetamol', requestedQuantity: 30, idempotencyKey: newKey() }
  })).body.request.id;

  const o2 = await h.request({ method: 'POST', url: OFFER_URL(r2), cookie: bCookie, body: { offeredQuantity: 30 } });
  assert.equal(o2.status, 409, 'the same units must not be promised twice');
  assertSafeJson(o2);
  assert.equal(o2.body.details.offerableStock, 20);

  // 20 is still allowed.
  const o3 = await h.request({ method: 'POST', url: OFFER_URL(r2), cookie: bCookie, body: { offeredQuantity: 20 } });
  assert.equal(o3.status, 200, o3.raw);
  stock = await engine.calculateOfferableStock(b.pharmacyId, 'Paracetamol');
  assert.equal(stock.reservedStock, 50);
  assert.equal(stock.offerableStock, 0);

  // Request 1 becomes FULLY_COVERED -> stays reserved.
  const r1row = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [r1]);
  assert.equal(r1row.status, 'FULLY_COVERED');

  // Cancelling request 2 releases its 20.
  await h.request({ method: 'POST', url: CANCEL_URL(r2), cookie: a2Cookie, body: {} });
  stock = await engine.calculateOfferableStock(b.pharmacyId, 'Paracetamol');
  assert.equal(stock.reservedStock, 30, 'a cancelled request releases its reservation');
  assert.equal(stock.offerableStock, 20);

  // The FULLY_COVERED request keeps reserving until future fulfilment.
  assert.equal((await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [r1])).status, 'FULLY_COVERED');

  // Expiring request 1 releases the remaining 30.
  await h.db.run('UPDATE medicine_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['EXPIRED', r1]);
  stock = await engine.calculateOfferableStock(b.pharmacyId, 'Paracetamol');
  assert.equal(stock.reservedStock, 0, 'an expired request releases its reservation');
  assert.equal(stock.offerableStock, 50, 'full capacity restored');

  // Inventory never moved.
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches);
  assert.equal(after.totalUnits, before.totalUnits);
  assert.equal(after.movements, before.movements);
  assert.equal(after.movements, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. CONCURRENT OFFERS — real PostgreSQL, deterministic interleave
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Wraps an adapter so a transaction pauses immediately before the coverage CAS.
 * Test-only: production code is untouched. This forces the interleave that a
 * plain Promise.all does not reliably produce, making the CAS quantity predicate
 * the only remaining protection.
 */
function barrieredAdapter(realDb, gate) {
  const passthrough = {
    get:   (...a) => realDb.get(...a),
    run:   (...a) => realDb.run(...a),
    query: (...a) => realDb.query(...a),
    exec:  (...a) => realDb.exec(...a),
    type: realDb.type
  };
  passthrough.transaction = (fn, immediate) => realDb.transaction(async (tx) => {
    const proxy = {
      get:   (...a) => tx.get(...a),
      query: (...a) => tx.query(...a),
      exec:  (...a) => tx.exec(...a),
      run:   async (sql, params) => {
        if (typeof sql === 'string' && /SET covered_quantity/.test(sql)) await gate.wait();
        return tx.run(sql, params);
      }
    };
    return fn(proxy);
  }, immediate);
  return passthrough;
}

function makeGate() {
  let release;
  const opened = new Promise(r => { release = r; });
  let reached = null;
  const reachedPromise = new Promise(r => { reached = r; });
  return {
    async wait() { reached(); await opened; },
    reached: reachedPromise,
    open() { release(); }
  };
}

pgOnly(test, 'HARD-050: two simultaneous offers for the last 20 units cannot overshoot', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near,  { stock: 100 });
  const c = await addTenant(h, 'Pharmacy C', COORDS.near2, { stock: 100 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 20 })).body.request.id;

  // Guarantee both hold PENDING offers.
  const respondBy = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  for (const pid of [b.pharmacyId, c.pharmacyId]) {
    await h.db.run(`
      INSERT INTO medicine_request_offers (request_id, pharmacy_id, zone_index, distance_km, usable_stock_at_contact, status, respond_by)
      SELECT ?, ?, 0, 5.0, 100, 'PENDING', ?
      WHERE NOT EXISTS (SELECT 1 FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?)
    `, [id, pid, respondBy, id, pid]);
  }

  const results = await Promise.allSettled([
    h.request({ method: 'POST', url: OFFER_URL(id), cookie: await login(h, b.staffEmail), body: { offeredQuantity: 20 } }),
    h.request({ method: 'POST', url: OFFER_URL(id), cookie: await login(h, c.staffEmail), body: { offeredQuantity: 20 } })
  ]);

  const statuses = results.map(r => r.status === 'fulfilled' ? r.value.status : 'threw');
  const ok = statuses.filter(s => s === 200).length;
  const conflict = statuses.filter(s => s === 409).length;
  assert.equal(ok, 1, `exactly one offer may succeed, got statuses ${JSON.stringify(statuses)}`);
  assert.equal(conflict, 1, 'the other must receive a clean 409');

  const row = await h.db.get('SELECT covered_quantity, requested_quantity, status FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(Number(row.covered_quantity), 20, 'coverage must be exactly 20, never 40');
  assert.ok(Number(row.covered_quantity) <= Number(row.requested_quantity));
  assert.equal(row.status, 'FULLY_COVERED');

  const accepted = await h.db.query(
    "SELECT offered_quantity FROM medicine_request_offers WHERE request_id = ? AND status = 'ACCEPTED'", [id]);
  assert.equal(accepted.length, 1, 'exactly one ACCEPTED offer row — no corrupt state');
  assert.equal(Number(accepted[0].offered_quantity), 20);
});

pgOnly(test, 'HARD-060: a forced stale-read interleave cannot overshoot (isolates the CAS predicate)', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near,  { stock: 100 });
  const c = await addTenant(h, 'Pharmacy C', COORDS.near2, { stock: 100 });
  const reqCookie = await login(h, 'staff@mediindex.local');

  // requested 30; each pharmacy offers 20. After the first commits the request is
  // PARTIALLY_COVERED, so the CAS *status* predicate cannot block the second —
  // only "covered_quantity + ? <= requested_quantity" prevents 20+20 = 40.
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 30 })).body.request.id;
  const respondBy = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  for (const pid of [b.pharmacyId, c.pharmacyId]) {
    await h.db.run(`
      INSERT INTO medicine_request_offers (request_id, pharmacy_id, zone_index, distance_km, usable_stock_at_contact, status, respond_by)
      SELECT ?, ?, 0, 5.0, 100, 'PENDING', ?
      WHERE NOT EXISTS (SELECT 1 FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?)
    `, [id, pid, respondBy, id, pid]);
  }

  const { createMedicineRequestEngine } = require('../medicine-requests');
  const gate = makeGate();
  const slowEngine = createMedicineRequestEngine({
    db: barrieredAdapter(h.db, gate), isPg: true, haversineKm: h.core.haversineKm
  });
  const fastEngine = h.core.medicineRequestEngine;

  // 1. Slow transaction reads (outstanding = 30) then pauses before its CAS.
  const slow = slowEngine.submitOffer({ requestId: id, pharmacyId: b.pharmacyId, offeredQuantity: 20 });
  const slowFailed = slow.then(() => null, err => err);
  await gate.reached;   // its stale read is now committed to memory

  // 2. Fast transaction completes fully: covered 0 -> 20, PARTIALLY_COVERED.
  const fast = await fastEngine.submitOffer({ requestId: id, pharmacyId: c.pharmacyId, offeredQuantity: 20 });
  assert.equal(fast.accepted, true);
  const mid = await h.db.get('SELECT covered_quantity, status FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(Number(mid.covered_quantity), 20);
  assert.equal(mid.status, 'PARTIALLY_COVERED', 'the status predicate alone cannot block the second offer');

  // 3. Release the slow transaction; its CAS now runs against a stale read.
  gate.open();
  const err = await slowFailed;

  assert.ok(err, 'the stale-read offer must not succeed');
  assert.equal(err.code, 'CONFLICT',
    `the loser must fail as a clean domain CONFLICT, got ${err && err.code}: ${err && err.message}`);

  const final = await h.db.get('SELECT covered_quantity, requested_quantity, status FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(Number(final.covered_quantity), 20, 'coverage must remain 20 — never 40');
  assert.ok(Number(final.covered_quantity) <= Number(final.requested_quantity),
    'the coverage invariant must hold under a genuine stale-read race');
  assert.equal(final.status, 'PARTIALLY_COVERED');

  const accepted = await h.db.query(
    "SELECT pharmacy_id, offered_quantity FROM medicine_request_offers WHERE request_id = ? AND status = 'ACCEPTED'", [id]);
  assert.equal(accepted.length, 1, 'exactly one ACCEPTED offer row');
  assert.equal(Number(accepted[0].pharmacy_id), c.pharmacyId);

  // The loser's offer row must be left untouched (no partial/corrupt state).
  const loser = await h.db.get(
    'SELECT status, offered_quantity FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?', [id, b.pharmacyId]);
  assert.equal(loser.status, 'PENDING', "the loser's offer row must roll back to PENDING");
  assert.equal(loser.offered_quantity, null);
});

pgOnly(test, 'HARD-061: the database CHECK is the final backstop against overshoot', async (h) => {
  await setupRequester(h);
  const cookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, cookie, { requestedQuantity: 30 })).body.request.id;

  // Bypass the engine entirely: a direct write that would overshoot must be
  // rejected by ck_mreq_coverage.
  let threw = false;
  try {
    await h.db.run('UPDATE medicine_requests SET covered_quantity = 31 WHERE id = ?', [id]);
  } catch { threw = true; }
  assert.equal(threw, true, 'ck_mreq_coverage must reject covered_quantity > requested_quantity');
  const row = await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(Number(row.covered_quantity), 0, 'the rejected write must leave coverage unchanged');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. IDEMPOTENCY — every mutating operation
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-070: create, offer, decline, advance and cancel are all idempotent', async (h) => {
  await setupRequester(h);
  // B and C each hold 20 so zone 0 (40) cannot cover 60 and BOTH get contacted;
  // D in zone 1 supplies enough pending capacity to keep the request actionable.
  const b = await addTenant(h, 'Pharmacy B', COORDS.near,  { stock: 20 });
  const c = await addTenant(h, 'Pharmacy C', COORDS.near2, { stock: 20 });
  await addTenant(h, 'Pharmacy D', COORDS.mid, { stock: 100 });
  const other = await addTenant(h, 'Other Tenant', COORDS.d3, { withCatalogue: false });
  await addMedicine(h, other.pharmacyId, 'Paracetamol');

  const cookie = await login(h, 'staff@mediindex.local');
  const key = newKey();

  // create x2
  const c1 = await createRequest(h, cookie, { requestedQuantity: 60, idempotencyKey: key });
  const c2 = await createRequest(h, cookie, { requestedQuantity: 60, idempotencyKey: key });
  assert.equal(c1.status, 201);
  assert.equal(c2.status, 200);
  assert.equal(c2.body.idempotentReplay, true);
  assert.equal(c1.body.request.id, c2.body.request.id);
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM medicine_requests')).n), 1);
  const id = c1.body.request.id;

  // same key from another pharmacy -> 409, no leak
  const cross = await h.request({
    method: 'POST', url: '/api/inter-pharmacy/medicine-requests', cookie: await login(h, other.staffEmail),
    body: { medicineName: 'Paracetamol', requestedQuantity: 5, idempotencyKey: key }
  });
  assert.equal(cross.status, 409);
  assert.equal(cross.body.request, undefined);
  assert.doesNotMatch(cross.raw, /Demo Pharmacy/i);

  // advance x3 -> no duplicate contacts
  for (let i = 0; i < 3; i++) {
    const a = await h.request({ method: 'POST', url: ADVANCE_URL(id), cookie, body: {} });
    assert.equal(a.status, 200, a.raw);
  }
  for (const row of await h.db.query(
    'SELECT pharmacy_id, COUNT(*) AS n FROM medicine_request_offers WHERE request_id = ? GROUP BY pharmacy_id', [id])) {
    assert.equal(Number(row.n), 1, `pharmacy ${row.pharmacy_id} must hold exactly one offer row`);
  }

  // offer x2
  const bCookie = await login(h, b.staffEmail);
  const o1 = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: bCookie, body: { offeredQuantity: 20 } });
  const o2 = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: bCookie, body: { offeredQuantity: 20 } });
  assert.equal(o1.body.accepted, true);
  assert.equal(o2.body.idempotentReplay, true);
  assert.equal(o2.body.coveredQuantity, 20, 'a replayed offer must not double-count');

  // decline x2
  const cCookie = await login(h, c.staffEmail);
  const d1 = await h.request({ method: 'POST', url: DECLINE_URL(id), cookie: cCookie, body: { reason: 'None' } });
  const d2 = await h.request({ method: 'POST', url: DECLINE_URL(id), cookie: cCookie, body: {} });
  assert.equal(d1.body.declined, true);
  assert.equal(d2.body.idempotentReplay, true);
  assert.equal(d2.body.offer.declineReason, 'None', 'audit detail preserved across replay');

  // cancel x2
  const x1 = await h.request({ method: 'POST', url: CANCEL_URL(id), cookie, body: {} });
  const x2 = await h.request({ method: 'POST', url: CANCEL_URL(id), cookie, body: {} });
  assert.equal(x1.status, 200, x1.raw);
  assert.equal(x1.body.cancelled, true);
  assert.equal(x2.status, 200, x2.raw);
  assert.equal(x2.body.idempotentReplay, true);
  assert.equal(x2.body.request.status, 'CANCELLED');

  // coverage unchanged by all the replays
  const final = await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(Number(final.covered_quantity), 20);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. TENANT ISOLATION — three pharmacies
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-080: three-pharmacy isolation across every mutating and reading route', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near,  { stock: 10 });   // contacted
  const c = await addTenant(h, 'Pharmacy C', COORDS.near2, { stock: 10 });   // contacted
  // Keeps the request actionable rather than terminating at NO_COVERAGE, so the
  // isolation checks exercise live PENDING offers.
  await addTenant(h, 'Pharmacy D', COORDS.mid, { stock: 100 });
  const x = await addTenant(h, 'Pharmacy X', COORDS.delhi, { stock: 500 });  // never contacted

  const aCookie = await login(h, 'staff@mediindex.local');
  const bCookie = await login(h, b.staffEmail);
  const cCookie = await login(h, c.staffEmail);
  const xCookie = await login(h, x.staffEmail);

  const id = (await createRequest(h, aCookie, { requestedQuantity: 50 })).body.request.id;

  // Unrelated X: cannot read, offer, decline, cancel or advance.
  for (const [label, call] of [
    ['detail',  () => h.request({ method: 'GET',  url: DETAIL_URL(id),  cookie: xCookie })],
    ['offer',   () => h.request({ method: 'POST', url: OFFER_URL(id),   cookie: xCookie, body: { offeredQuantity: 10 } })],
    ['decline', () => h.request({ method: 'POST', url: DECLINE_URL(id), cookie: xCookie, body: {} })],
    ['cancel',  () => h.request({ method: 'POST', url: CANCEL_URL(id),  cookie: xCookie, body: {} })],
    ['advance', () => h.request({ method: 'POST', url: ADVANCE_URL(id), cookie: xCookie, body: {} })]
  ]) {
    const res = await call();
    assert.equal(res.status, 404, `X must get 404 on ${label}, got ${res.status}`);
    assertSafeJson(res);
    assert.doesNotMatch(res.raw, /Paracetamol/, `${label} must not leak the medicine`);
    assert.doesNotMatch(res.raw, /Demo Pharmacy/i, `${label} must not leak the requester`);
  }

  // A contacted pharmacy cannot see a competitor's offer.
  const asB = await h.request({ method: 'GET', url: DETAIL_URL(id), cookie: bCookie });
  assert.equal(asB.status, 200);
  assert.equal(asB.body.viewerRole, 'RECIPIENT');
  assert.equal(asB.body.offers.length, 1);
  assert.equal(asB.body.offers[0].pharmacyId, b.pharmacyId);
  assert.doesNotMatch(asB.raw, /Pharmacy C/, "B must not see C's identity");

  // A contacted pharmacy cannot cancel or advance someone else's request.
  assert.equal((await h.request({ method: 'POST', url: CANCEL_URL(id),  cookie: bCookie, body: {} })).status, 404);
  assert.equal((await h.request({ method: 'POST', url: ADVANCE_URL(id), cookie: bCookie, body: {} })).status, 404);

  // B cannot respond on C's behalf: it can only affect its own offer row.
  await h.request({ method: 'POST', url: DECLINE_URL(id), cookie: bCookie, body: { reason: 'B only' } });
  const cRow = await h.db.get('SELECT status FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?', [id, c.pharmacyId]);
  assert.equal(cRow.status, 'PENDING', "C's offer must be untouched by B's action");

  // Client-supplied pharmacy ids cannot impersonate.
  for (const field of ['pharmacyId', 'pharmacy_id']) {
    const res = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: cCookie, body: { offeredQuantity: 5, [field]: b.pharmacyId } });
    assert.equal(res.status, 400, `${field} must be rejected on offer`);
    assertSafeJson(res);
  }
  const impersonateCreate = await createRequest(h, aCookie, { requesterPharmacyId: x.pharmacyId });
  assert.equal(impersonateCreate.status, 400);

  // Listing stays scoped.
  const xList = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests', cookie: xCookie });
  assert.equal(xList.status, 200);
  assert.equal(xList.body.requests.length, 0, 'X owns no requests');
  const xIncoming = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/incoming', cookie: xCookie });
  assert.equal(xIncoming.body.count, 0, 'X was never contacted');
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. EXPIRATION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-090: an offer past its 24-hour window cannot be accepted and unblocks the search', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near, { stock: 80 });
  const d = await addTenant(h, 'Pharmacy D', COORDS.mid,  { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const createdAtMs = Date.now();
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 50 })).body.request.id;

  // Only B is contacted (its 80 covers the need); confirm the window is ~24h.
  const initial = await offersFor(h, id);
  assert.deepEqual(initial.map(o => Number(o.pharmacy_id)), [b.pharmacyId]);
  // Measure the window against a JS reference captured around creation.
  // SQLite's CURRENT_TIMESTAMP is a naive UTC string ('YYYY-MM-DD HH:MM:SS')
  // which JS would misparse as local time, so contacted_at is not a safe
  // baseline for arithmetic here. respond_by is written by the engine as a full
  // ISO-8601 UTC string and parses unambiguously.
  const windowMs = new Date(initial[0].respond_by).getTime() - createdAtMs;
  assert.ok(Math.abs(windowMs - 24 * 3600 * 1000) < 5 * 60 * 1000,
    `the response window must be ~24h, got ${(windowMs / 3600000).toFixed(2)}h`);

  // Push the deadline into the past.
  await h.db.run('UPDATE medicine_request_offers SET respond_by = ? WHERE request_id = ? AND pharmacy_id = ?',
    [new Date(Date.now() - 1000).toISOString(), id, b.pharmacyId]);

  const late = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: await login(h, b.staffEmail), body: { offeredQuantity: 50 } });
  assert.equal(late.status, 409, 'an expired offer must not be accepted');
  assertSafeJson(late);
  assert.equal(Number((await h.db.get('SELECT covered_quantity FROM medicine_requests WHERE id = ?', [id])).covered_quantity), 0);

  // Advancing marks it EXPIRED and lets the search reach D.
  const adv = await h.request({ method: 'POST', url: ADVANCE_URL(id), cookie: reqCookie, body: {} });
  assert.equal(adv.status, 200, adv.raw);
  const bRow = await h.db.get('SELECT status FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?', [id, b.pharmacyId]);
  assert.equal(bRow.status, 'EXPIRED');
  const ids = (await offersFor(h, id)).map(o => Number(o.pharmacy_id));
  assert.ok(ids.includes(d.pharmacyId), 'silence must not block the search forever');
});

forEachDb(test, 'HARD-091: a request past its 72-hour lifetime expires, accepts no offers and releases reservations', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near, { stock: 100 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const adminCookie = await login(h, 'admin@mediindex.local');
  const before = await inventorySnapshot(h);

  const createdAtMs = Date.now();
  const created = await createRequest(h, reqCookie, { requestedQuantity: 50 });
  const id = created.body.request.id;

  // TTL must be ~72h from creation. expires_at is engine-written ISO-8601 UTC;
  // created_at is the database's own CURRENT_TIMESTAMP and is not used as the
  // baseline here (see the note in HARD-090).
  const row = await h.db.get('SELECT expires_at FROM medicine_requests WHERE id = ?', [id]);
  const ttlMs = new Date(row.expires_at).getTime() - createdAtMs;
  assert.ok(Math.abs(ttlMs - 72 * 3600 * 1000) < 10 * 60 * 1000,
    `the request lifetime must be ~72h, got ${(ttlMs / 3600000).toFixed(2)}h`);

  // Partially cover it so there is a reservation to release.
  const bCookie = await login(h, b.staffEmail);
  await h.request({ method: 'POST', url: OFFER_URL(id), cookie: bCookie, body: { offeredQuantity: 20 } });
  const engine = h.core.medicineRequestEngine;
  assert.equal((await engine.calculateOfferableStock(b.pharmacyId, 'Paracetamol')).reservedStock, 20);

  // Push it past its TTL and sweep.
  await h.db.run('UPDATE medicine_requests SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), id]);
  const sweep = await h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', cookie: adminCookie, body: {} });
  assert.equal(sweep.status, 200, sweep.raw);
  assert.ok(sweep.body.expiredRequests >= 1);

  const expired = await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [id]);
  assert.equal(expired.status, 'EXPIRED');

  // No further offers.
  const late = await h.request({ method: 'POST', url: OFFER_URL(id), cookie: bCookie, body: { offeredQuantity: 10 } });
  assert.equal(late.status, 409, 'an expired request must accept no new offers');
  assertSafeJson(late);

  // Reservation released.
  assert.equal((await engine.calculateOfferableStock(b.pharmacyId, 'Paracetamol')).reservedStock, 0,
    'an expired request must release its reservation');
  assert.equal((await engine.calculateOfferableStock(b.pharmacyId, 'Paracetamol')).offerableStock, 100);

  // Inventory untouched.
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches);
  assert.equal(after.totalUnits, before.totalUnits);
  assert.equal(after.movements, before.movements);
  assert.equal(after.movements, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. INVENTORY NON-MUTATION — complete flow on real PostgreSQL
// ═════════════════════════════════════════════════════════════════════════════

pgOnly(test, 'HARD-100: a complete PostgreSQL flow never mutates inventory', async (h) => {
  const aPid = await setupRequester(h);
  await addBatch(h, await addMedicine(h, aPid, 'Ibuprofen'), 'A-IBU', 40);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near,  { stock: 40 });
  const c = await addTenant(h, 'Pharmacy C', COORDS.near2, { stock: 0 });
  const d = await addTenant(h, 'Pharmacy D', COORDS.mid,   { stock: 60 });
  // Include expired stock to prove it is neither counted nor altered.
  const e = await addTenant(h, 'Pharmacy E', COORDS.far, { stock: 90, expiredOnly: true });

  const before = await inventorySnapshot(h);
  assert.ok(before.totalUnits > 0, 'the scenario must contain real inventory');

  const aCookie = await login(h, 'staff@mediindex.local');
  const adminCookie = await login(h, 'admin@mediindex.local');

  // Flow 1: create -> advance -> partial offer -> decline -> full coverage
  const r1 = (await createRequest(h, aCookie, { requestedQuantity: 50 })).body.request.id;
  await h.request({ method: 'POST', url: ADVANCE_URL(r1), cookie: aCookie, body: {} });
  await h.request({ method: 'POST', url: OFFER_URL(r1),   cookie: await login(h, b.staffEmail), body: { offeredQuantity: 40 } });
  await h.request({ method: 'POST', url: DECLINE_URL(r1), cookie: await login(h, c.staffEmail), body: { reason: 'none' } });
  await h.request({ method: 'POST', url: ADVANCE_URL(r1), cookie: aCookie, body: {} });
  const fill = await h.request({ method: 'POST', url: OFFER_URL(r1), cookie: await login(h, d.staffEmail), body: { offeredQuantity: 10 } });
  assert.equal(fill.status, 200, fill.raw);
  assert.equal(fill.body.request.status, 'FULLY_COVERED');

  // Flow 2: create -> offer -> cancel (reservation released)
  const r2 = (await createRequest(h, aCookie, { requestedQuantity: 20 })).body.request.id;
  await h.request({ method: 'POST', url: OFFER_URL(r2), cookie: await login(h, d.staffEmail), body: { offeredQuantity: 20 } });
  const cancelled = await h.request({ method: 'POST', url: CANCEL_URL(r2), cookie: aCookie, body: {} });
  assert.equal(cancelled.body.request.status, 'CANCELLED');

  // Flow 3: create -> expire
  const r3 = (await createRequest(h, aCookie, { requestedQuantity: 15 })).body.request.id;
  await h.db.run('UPDATE medicine_requests SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), r3]);
  await h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', cookie: adminCookie, body: {} });
  assert.equal((await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [r3])).status, 'EXPIRED');

  // Nothing in inventory changed across all three flows.
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches, 'every batch quantity must be identical');
  assert.equal(after.totalUnits, before.totalUnits, 'total units in the system must be identical');
  assert.equal(after.movements, before.movements, 'no inventory movement may be created');
  assert.equal(after.movements, 0);

  // Expired stock was never counted as usable.
  assert.equal(await h.core.medicineRequestEngine.calculateUsableStock(e.pharmacyId, 'Paracetamol'), 0,
    'expired batches must never count as usable stock');
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. AUTOMATIC NEAR-EXPIRY REGRESSION
// ═════════════════════════════════════════════════════════════════════════════

forEachDb(test, 'HARD-110: automatic near-expiry redistribution is unchanged by the manual workflow', async (h) => {
  const aPid = await setupRequester(h);
  const adminCookie = await login(h, 'admin@mediindex.local');

  // Recipient within the 50 km near-expiry radius with a genuine stock need.
  const recipient = await addTenant(h, 'NE Recipient', COORDS.mid, { withCatalogue: false });
  await h.db.run('INSERT INTO medicines (pharmacy_id, name, minimum_stock) VALUES (?, ?, ?)', [recipient.pharmacyId, 'Paracetamol', 50]);
  const rMed = await h.db.get('SELECT id FROM medicines WHERE pharmacy_id = ? AND name = ?', [recipient.pharmacyId, 'Paracetamol']);
  await addBatch(h, Number(rMed.id), 'R-LOW', 10, 200);   // 10 of a 50 minimum

  // Sender batch expiring in 15 days (inside the 20-day threshold).
  const aMed = await h.db.get('SELECT id FROM medicines WHERE pharmacy_id = ? AND name = ?', [aPid, 'Paracetamol']);
  await addBatch(h, Number(aMed.id), 'NE-15D', 30, 15);
  // And one at 21 days, which must NOT qualify.
  await addBatch(h, Number(aMed.id), 'NE-21D', 25, 21);

  const before = await inventorySnapshot(h);
  const scan = await h.request({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process', cookie: adminCookie, body: {} });
  assert.equal(scan.status, 200, scan.raw);
  assert.equal(scan.body.nearExpiryDays, 20, 'the 20-day threshold is unchanged');
  assert.equal(scan.body.nearbyRadiusKm, 50, 'the 50 km radius is unchanged');

  const made = scan.body.requests.filter(r => r.recipientPharmacyId === recipient.pharmacyId);
  assert.equal(made.length, 1, 'exactly one automatic request for the 15-day batch');
  assert.equal(made[0].batchNumber, 'NE-15D');
  assert.equal(made[0].daysUntilExpiry, 15);
  assert.equal(made[0].reason, 'NEAR_EXPIRY_REDISTRIBUTION');
  assert.equal(made[0].requestType, 'NEAR_EXPIRY');
  assert.equal(made[0].status, 'ACCEPTED', 'auto-acceptance is unchanged');
  assert.equal(made[0].automaticRequest, true);
  assert.equal(made[0].automaticAcceptance, true);
  assert.equal(made[0].requestedQuantity, 30, 'min(deficit 40, available 30)');
  assert.ok(made[0].distanceKm > 14 && made[0].distanceKm < 22, `expected ~18 km, got ${made[0].distanceKm}`);

  // The 21-day batch must not have produced a request.
  assert.equal(scan.body.requests.some(r => r.batchNumber === 'NE-21D'), false,
    'a 21-day batch must not qualify');

  // Re-running is idempotent.
  const rerun = await h.request({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process', cookie: adminCookie, body: {} });
  assert.equal(rerun.body.created, 0);
  assert.ok(rerun.body.skippedDuplicate >= 1);

  // No automatic inventory movement.
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches, 'near-expiry must not move inventory');
  assert.equal(after.movements, before.movements);

  // And the manual tables were not involved.
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM medicine_requests')).n), 0,
    'the near-expiry scan must not create manual medicine requests');
});
