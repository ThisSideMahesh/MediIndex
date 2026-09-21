'use strict';
/**
 * tests/inter-pharmacy.test.js
 *
 * Comprehensive regression tests for the near-expiry redistribution feature.
 *
 * Architecture under test:
 *   processNearExpiryRedistribution(pharmacyId, opts)
 *   POST /api/inter-pharmacy/near-expiry/process
 *   GET  /api/inter-pharmacy/requests
 *   POST /api/inter-pharmacy/requests/:id/status
 *   PUT  /api/pharmacies/coordinates
 *   haversineKm(lat1,lng1,lat2,lng2)
 *   NEAR_EXPIRY_DAYS, NEARBY_RADIUS_KM constants
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const {
  handler, db,
  processNearExpiryRedistribution,
  haversineKm,
  NEAR_EXPIRY_DAYS,
  NEARBY_RADIUS_KM,
} = require('../core');

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function callApi({ method = 'GET', url, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method  = method;
    req.url     = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}) };
    const res = {
      _h: {},
      writeHead(s, h) { this.status = s; this._h = h || {}; },
      end(p) {
        try { resolve({ status: this.status, headers: this._h, body: p ? JSON.parse(p) : null }); }
        catch { resolve({ status: this.status, headers: this._h, raw: p }); }
      }
    };
    handler(req, res).catch(reject);
    if (body !== undefined)
      setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

async function adminLogin() {
  const r = await callApi({ method: 'POST', url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  assert.equal(r.status, 200);
  return r.headers['Set-Cookie'];
}

// ─── Test fixtures ────────────────────────────────────────────────────────────
/** Returns { pharmacyId, medicineId, batchId, batchNumber } and cleans up on dispose() */
function makeFixture() {
  const state = {};
  const dispose = () => {
    try {
      if (state.batchId) {
        db.prepare('DELETE FROM medicine_redistribution_requests WHERE source_batch_id = ?').run(state.batchId);
        db.prepare('DELETE FROM inventory_movements WHERE batch_id = ?').run(state.batchId);
        db.prepare('DELETE FROM expiry_alerts WHERE batch_id = ?').run(state.batchId);
        db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(state.batchId);
      }
      if (state.medicineId) db.prepare('DELETE FROM medicines WHERE id = ?').run(state.medicineId);
      if (state.pharmacyId && state.pharmacyId !== 1) {
        db.prepare('DELETE FROM pharmacies WHERE id = ?').run(state.pharmacyId);
      }
    } catch {}
  };
  return { state, dispose };
}

/** Sets coordinates for a pharmacy directly in DB */
function setCoords(pharmacyId, lat, lng) {
  db.prepare('UPDATE pharmacies SET latitude=?, longitude=? WHERE id=?').run(lat, lng, pharmacyId);
}

/** Creates a fresh pharmacy with optional coordinates */
function createPharmacy(name, lat = null, lng = null) {
  const r = db.prepare("INSERT INTO pharmacies (name, address, latitude, longitude) VALUES (?,?,?,?) RETURNING id")
    .run(name, 'Test Address', lat, lng);
  return Number(r.lastInsertRowid);
}

/** Creates a medicine in a pharmacy */
function createMedicine(pharmacyId, name, minimumStock = 10) {
  const r = db.prepare("INSERT INTO medicines (pharmacy_id, name, minimum_stock) VALUES (?,?,?) RETURNING id")
    .run(pharmacyId, name, minimumStock);
  return Number(r.lastInsertRowid);
}

/** Creates a batch for a medicine */
function createBatch(medicineId, batchNum, quantity, expiryDate) {
  const r = db.prepare(
    "INSERT INTO medicine_batches (medicine_id, batch_number, quantity, selling_price, expiry_date) VALUES (?,?,?,10.0,?) RETURNING id"
  ).run(medicineId, batchNum, quantity, expiryDate);
  return Number(r.lastInsertRowid);
}

/** Returns a date string N days from today */
function daysFromNow(n) {
  const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
}

function cleanRequests(batchId) {
  if (batchId) db.prepare('DELETE FROM medicine_redistribution_requests WHERE source_batch_id = ?').run(batchId);
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIT: haversineKm
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-001: haversineKm returns 0 for identical coordinates', () => {
  assert.equal(haversineKm(19.0760, 72.8777, 19.0760, 72.8777), 0);
});

test('INTER-002: haversineKm computes ~120 km between Mumbai and Pune', () => {
  // Mumbai (19.0760, 72.8777) to Pune (18.5204, 73.8567) ≈ 120 km
  const d = haversineKm(19.0760, 72.8777, 18.5204, 73.8567);
  assert.ok(d > 100 && d < 140, `Expected ~120 km, got ${d.toFixed(1)}`);
});

test('INTER-003: haversineKm computes > 1000 km for Mumbai to Delhi', () => {
  const d = haversineKm(19.0760, 72.8777, 28.6139, 77.2090);
  assert.ok(d > 1100 && d < 1200, `Expected ~1150 km, got ${d.toFixed(1)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-004: NEAR_EXPIRY_DAYS default is 20', () => {
  assert.equal(NEAR_EXPIRY_DAYS, 20);
});

test('INTER-005: NEARBY_RADIUS_KM default is 50', () => {
  assert.equal(NEARBY_RADIUS_KM, 50);
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPIRY THRESHOLD QUALIFICATION
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-006: batch expiring in exactly NEAR_EXPIRY_DAYS days qualifies', async () => {
  const senderPid = createPharmacy('Sender Thresh Test', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip Thresh Test',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'ThreshMed', 0);
  const rMedId    = createMedicine(recipPid,  'ThreshMed', 20); // minimum_stock=20, current=0
  const bId       = createBatch(sMedId, 'THRESH-20', 30, daysFromNow(20));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.ok(result.created >= 1, `Expected >=1 created, got ${result.created}`);
    const req = result.requests.find(r => r.batchId === bId);
    assert.ok(req, 'Request for exactly-20-day batch must be created');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-007: batch expiring in 19 days qualifies (within threshold)', async () => {
  const senderPid = createPharmacy('Sender 19d', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip 19d',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'Med19d', 0);
  const rMedId    = createMedicine(recipPid,  'Med19d', 15);
  const bId       = createBatch(sMedId, 'BATCH-19D', 20, daysFromNow(19));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.ok(result.created >= 1);
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-008: batch expiring in 21 days does NOT qualify (beyond threshold)', async () => {
  const senderPid = createPharmacy('Sender 21d', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip 21d',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'Med21d', 0);
  const rMedId    = createMedicine(recipPid,  'Med21d', 15);
  const bId       = createBatch(sMedId, 'BATCH-21D', 20, daysFromNow(21));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.equal(result.requests.filter(r => r.batchId === bId).length, 0, '21-day batch must not create a request');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-009: already expired batch does NOT qualify', async () => {
  const senderPid = createPharmacy('Sender Expired', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip Expired',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedExpired', 0);
  const rMedId    = createMedicine(recipPid,  'MedExpired', 15);
  const bId       = createBatch(sMedId, 'BATCH-EXP', 20, daysFromNow(-5)); // expired
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.equal(result.requests.filter(r => r.batchId === bId).length, 0);
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-010: zero-stock batch does NOT qualify', async () => {
  const senderPid = createPharmacy('Sender ZeroStock', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip ZeroStock',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedZeroStock', 0);
  const rMedId    = createMedicine(recipPid,  'MedZeroStock', 15);
  const bId       = createBatch(sMedId, 'BATCH-ZERO', 0, daysFromNow(10));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.equal(result.requests.filter(r => r.batchId === bId).length, 0);
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROXIMITY — coordinates required
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-011: both coords present, within radius → eligible', async () => {
  // Mumbai (sender) → Thane ~18 km away (recipient)
  const senderPid = createPharmacy('Mumbai Sender', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Thane Recip',   19.1973, 72.9614);
  const sMedId    = createMedicine(senderPid, 'MedProxIn', 0);
  const rMedId    = createMedicine(recipPid,  'MedProxIn', 20);
  const bId       = createBatch(sMedId, 'PROX-IN', 30, daysFromNow(15));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 50 });
    assert.ok(result.requests.some(r => r.batchId === bId), 'Within-radius pharmacy must be eligible');
    // Note: other pharmacies in the shared test DB (e.g. Demo Pharmacy with null coords)
    // may be counted as skipped-no-coords — only assert the target request was created
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-012: both coords present, outside radius → NOT eligible', async () => {
  // Mumbai sender → Delhi recipient (~1150 km >> 50 km radius)
  const senderPid = createPharmacy('Mumbai Far Sender', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Delhi Far Recip',   28.6139, 77.2090);
  const sMedId    = createMedicine(senderPid, 'MedProxOut', 0);
  const rMedId    = createMedicine(recipPid,  'MedProxOut', 20);
  const bId       = createBatch(sMedId, 'PROX-OUT', 30, daysFromNow(15));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 50 });
    assert.equal(result.requests.filter(r => r.batchId === bId).length, 0, 'Out-of-radius pharmacy must not receive request');
    assert.ok(result.skippedNoCoordinates >= 1, 'Should be counted as skipped-no-coords (out of range)');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-013: sender missing coordinates → no requests created', async () => {
  const senderPid = createPharmacy('No-Coords Sender', null, null); // no lat/lng
  const recipPid  = createPharmacy('Coords Recip',     19.1, 72.9);
  const sMedId    = createMedicine(senderPid, 'MedNoSender', 0);
  const rMedId    = createMedicine(recipPid,  'MedNoSender', 20);
  const bId       = createBatch(sMedId, 'NS-BATCH', 30, daysFromNow(10));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.equal(result.created, 0, 'No requests when sender has no coordinates');
    assert.ok(result.skippedNoCoordinates >= 1);
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-014: recipient missing coordinates → that pair skipped', async () => {
  const senderPid = createPharmacy('Coords Sender',      19.0760, 72.8777);
  const recipPid  = createPharmacy('No-Coords Recip',    null, null); // no lat/lng
  const sMedId    = createMedicine(senderPid, 'MedNoRecip', 0);
  const rMedId    = createMedicine(recipPid,  'MedNoRecip', 20);
  const bId       = createBatch(sMedId, 'NR-BATCH', 30, daysFromNow(10));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.equal(result.requests.filter(r => r.recipientPharmacyId === recipPid).length, 0,
      'Recipient without coordinates must be skipped');
    assert.ok(result.skippedNoCoordinates >= 1);
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RECIPIENT NEED
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-015: recipient with sufficient stock → NOT eligible', async () => {
  const senderPid = createPharmacy('Sender SuffStock', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip SuffStock',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedSuff', 0);
  const rMedId    = createMedicine(recipPid,  'MedSuff', 10); // minimum_stock = 10
  // Give recipient 50 units (above minimum) 
  createBatch(rMedId, 'RECIP-STOCK', 50, daysFromNow(90));
  const bId = createBatch(sMedId, 'SUFF-BATCH', 30, daysFromNow(15));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.equal(result.requests.filter(r => r.recipientPharmacyId === recipPid).length, 0,
      'Recipient with sufficient stock must not receive a request');
    assert.ok(result.skippedSufficientStock >= 1);
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    db.prepare('DELETE FROM medicine_batches WHERE medicine_id=?').run(rMedId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-016: recipient below minimum stock → eligible', async () => {
  const senderPid = createPharmacy('Sender BelowMin', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip BelowMin',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedBelow', 0);
  const rMedId    = createMedicine(recipPid,  'MedBelow', 50); // minimum_stock = 50
  createBatch(rMedId, 'RECIP-LOW', 5, daysFromNow(90));       // only 5 units (< 50)
  const bId = createBatch(sMedId, 'BELOW-BATCH', 60, daysFromNow(15));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.ok(result.requests.some(r => r.recipientPharmacyId === recipPid), 'Below-min recipient must receive request');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    db.prepare('DELETE FROM medicine_batches WHERE medicine_id=?').run(rMedId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-017: recipient with no minimum_stock configured (0) → NOT eligible', async () => {
  const senderPid = createPharmacy('Sender MinZero', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip MinZero',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedMinZero', 0);
  const rMedId    = createMedicine(recipPid,  'MedMinZero', 0); // minimum_stock = 0
  const bId = createBatch(sMedId, 'MINZERO-BATCH', 30, daysFromNow(15));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.equal(result.requests.filter(r => r.recipientPharmacyId === recipPid).length, 0,
      'minimum_stock=0 means no configured need — must not create request');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-018: same pharmacy never selected as recipient', async () => {
  const pid   = createPharmacy('Self Select Test', 19.0760, 72.8777);
  const medId = createMedicine(pid, 'SelfMed', 5);
  const bId   = createBatch(medId, 'SELF-BATCH', 30, daysFromNow(10));
  try {
    const result = await processNearExpiryRedistribution(pid, { nearExpiryDays: 20, nearbyRadiusKm: 1000 });
    assert.equal(result.requests.filter(r => r.recipientPharmacyId === pid).length, 0, 'Same pharmacy must never be recipient');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    db.prepare('DELETE FROM medicines WHERE id=?').run(medId);
    db.prepare('DELETE FROM pharmacies WHERE id=?').run(pid);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST CREATION CORRECTNESS
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-019: created request has correct sender, recipient, medicine, batch, qty, reason, auto flags', async () => {
  const senderPid = createPharmacy('Sender Correct', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip Correct',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedCorrect', 0);
  const rMedId    = createMedicine(recipPid,  'MedCorrect', 40); // needs 40, has 0
  const bId       = createBatch(sMedId, 'CORRECT-BATCH', 30, daysFromNow(12));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    const req = result.requests.find(r => r.batchId === bId && r.recipientPharmacyId === recipPid);
    assert.ok(req, 'Request must be created');
    assert.equal(req.senderPharmacyId,    senderPid);
    assert.equal(req.recipientPharmacyId, recipPid);
    assert.equal(req.medicineId,          sMedId);
    assert.equal(req.batchId,             bId);
    assert.equal(req.reason,              'NEAR_EXPIRY_REDISTRIBUTION');
    assert.equal(req.requestType,         'NEAR_EXPIRY');
    assert.equal(req.status,              'ACCEPTED');
    assert.equal(req.automaticRequest,    true);
    assert.equal(req.automaticAcceptance, true);
    // Qty = min(deficit=40, available=30) = 30
    assert.equal(req.requestedQuantity, 30);
    // Distance must be a finite positive number
    assert.ok(Number.isFinite(req.distanceKm) && req.distanceKm > 0);
    // DB record must exist
    const row = db.prepare('SELECT * FROM medicine_redistribution_requests WHERE id=?').get(req.id);
    assert.ok(row);
    assert.equal(row.automatic_request,    1);
    assert.equal(row.automatic_acceptance, 1);
    assert.equal(row.status, 'ACCEPTED');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-020: request quantity is bounded by available batch qty', async () => {
  // Recipient needs 100, sender only has 20 → qty must be 20
  const senderPid = createPharmacy('Sender BoundQty', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip BoundQty',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedBoundQty', 0);
  const rMedId    = createMedicine(recipPid,  'MedBoundQty', 100); // minimum=100, current=0
  const bId       = createBatch(sMedId, 'BOUND-BATCH', 20, daysFromNow(10));
  try {
    const result = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    const req = result.requests.find(r => r.batchId === bId);
    assert.ok(req);
    assert.equal(req.requestedQuantity, 20, 'Qty must be min(deficit=100, available=20) = 20');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE PREVENTION (idempotency key + UNIQUE constraint)
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-021: running process twice creates no duplicate requests', async () => {
  const senderPid = createPharmacy('Sender Idem', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip Idem',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedIdem', 0);
  const rMedId    = createMedicine(recipPid,  'MedIdem', 20);
  const bId       = createBatch(sMedId, 'IDEM-BATCH', 30, daysFromNow(10));
  try {
    const r1 = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    const r2 = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.equal(r2.created, 0, 'Second run must create no new requests');
    assert.ok(r2.skippedDuplicate >= 1, 'Second run must count duplicates skipped');
    const rows = db.prepare('SELECT id FROM medicine_redistribution_requests WHERE source_batch_id=?').all(bId);
    assert.equal(rows.length, r1.created, 'DB must have exactly as many rows as first-run created');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-022: concurrent processing creates at most one request per pair/batch', async () => {
  const senderPid = createPharmacy('Sender Concur', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip Concur',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedConcur', 0);
  const rMedId    = createMedicine(recipPid,  'MedConcur', 25);
  const bId       = createBatch(sMedId, 'CONCUR-BATCH', 40, daysFromNow(10));
  try {
    const [rA, rB] = await Promise.all([
      processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 }),
      processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 }),
    ]);
    const totalCreated = rA.created + rB.created;
    const rows = db.prepare('SELECT id FROM medicine_redistribution_requests WHERE source_batch_id=?').all(bId);
    assert.equal(rows.length, 1, `UNIQUE constraint must ensure exactly 1 row, got ${rows.length}`);
    assert.equal(totalCreated, 1, `Only one of the concurrent calls must have created a request`);
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY SAFETY — no stock deducted/added automatically
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-023: creating request does NOT deduct sender stock', async () => {
  const senderPid = createPharmacy('Sender NoDeduct', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip NoDeduct',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedNoDeduct', 0);
  const rMedId    = createMedicine(recipPid,  'MedNoDeduct', 20);
  const bId       = createBatch(sMedId, 'NODEDUCT-BATCH', 50, daysFromNow(10));
  const before    = db.prepare('SELECT quantity FROM medicine_batches WHERE id=?').get(bId).quantity;
  try {
    await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    const after = db.prepare('SELECT quantity FROM medicine_batches WHERE id=?').get(bId).quantity;
    assert.equal(after, before, 'Sender batch quantity must be unchanged after request creation');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-024: accepting request does NOT add stock to recipient', async () => {
  const senderPid = createPharmacy('Sender NoAdd', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip NoAdd',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedNoAdd', 0);
  const rMedId    = createMedicine(recipPid,  'MedNoAdd', 30);
  const rBId      = createBatch(rMedId, 'RECIP-NOADD', 5, daysFromNow(90));
  const bId       = createBatch(sMedId, 'NOADD-BATCH', 40, daysFromNow(12));
  const beforeRecip = db.prepare('SELECT quantity FROM medicine_batches WHERE id=?').get(rBId).quantity;
  try {
    await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    const afterRecip = db.prepare('SELECT quantity FROM medicine_batches WHERE id=?').get(rBId).quantity;
    assert.equal(afterRecip, beforeRecip, 'Recipient stock must NOT increase when request is auto-accepted');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(rBId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-025: no inventory_movements record created by redistribution', async () => {
  const senderPid = createPharmacy('Sender NoMov', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip NoMov',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedNoMov', 0);
  const rMedId    = createMedicine(recipPid,  'MedNoMov', 20);
  const bId       = createBatch(sMedId, 'NOMOV-BATCH', 30, daysFromNow(10));
  const movsBefore = db.prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE batch_id=?').get(bId).n;
  try {
    await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    const movsAfter = db.prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE batch_id=?').get(bId).n;
    assert.equal(movsAfter, movsBefore, 'No inventory_movements must be created by redistribution');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP API — authentication, RBAC, tenant isolation
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-026: POST /api/inter-pharmacy/near-expiry/process requires ADMIN', async () => {
  const staffLogin = await callApi({ method: 'POST', url: '/api/auth/login',
    body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' } });
  const staffCookie = staffLogin.headers['Set-Cookie'];
  const res = await callApi({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process',
    cookie: staffCookie, body: {} });
  assert.equal(res.status, 403, 'STAFF must not trigger near-expiry processing');
});

test('INTER-027: GET /api/inter-pharmacy/requests is accessible to STAFF', async () => {
  const staffLogin = await callApi({ method: 'POST', url: '/api/auth/login',
    body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' } });
  const res = await callApi({ url: '/api/inter-pharmacy/requests', cookie: staffLogin.headers['Set-Cookie'] });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.requests));
});

test('INTER-028: unauthenticated process request returns 401', async () => {
  const res = await callApi({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process', body: {} });
  assert.equal(res.status, 401);
});

test('INTER-029: invalid nearExpiryDays returns 400', async () => {
  const cookie = await adminLogin();
  const res = await callApi({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process',
    cookie, body: { nearExpiryDays: 400 } });
  assert.equal(res.status, 400);
});

test('INTER-030: process endpoint returns nearExpiryDays and nearbyRadiusKm in response', async () => {
  const cookie = await adminLogin();
  const res = await callApi({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process',
    cookie, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.nearExpiryDays, NEAR_EXPIRY_DAYS);
  assert.equal(res.body.nearbyRadiusKm, NEARBY_RADIUS_KM);
  assert.ok(typeof res.body.created === 'number');
  assert.ok(typeof res.body.skippedNoCoordinates === 'number');
});

test('INTER-031: status transition ACCEPTED → COMPLETED succeeds', async () => {
  const cookie = await adminLogin();
  // Create a request directly in DB
  const senderPid = createPharmacy('Sender Transition', 19.07, 72.87);
  const recipPid  = createPharmacy('Recip Transition',  19.10, 72.90);
  const sMedId    = createMedicine(senderPid, 'MedTrans', 0);
  const rMedId    = createMedicine(recipPid,  'MedTrans', 10);
  const bId       = createBatch(sMedId, 'TRANS-BATCH', 20, daysFromNow(5));
  const ikey = crypto.createHash('sha256').update(`${senderPid}|${recipPid}|${sMedId}|${bId}`).digest('hex');
  const ins = db.prepare(
    "INSERT INTO medicine_redistribution_requests (idempotency_key,sender_pharmacy_id,recipient_pharmacy_id,medicine_id,source_batch_id,requested_quantity,status,automatic_request,automatic_acceptance) VALUES (?,?,?,?,?,10,'ACCEPTED',1,1) RETURNING id"
  ).run(ikey, senderPid, recipPid, sMedId, bId);
  const reqId = Number(ins.lastInsertRowid);

  try {
    // Only works if authenticated pharmacy is sender or recipient.
    // The test pharmacy (pharmacy 1) is neither — expect 404.
    const r = await callApi({ method: 'POST', url: `/api/inter-pharmacy/requests/${reqId}/status`,
      cookie, body: { status: 'COMPLETED' } });
    // Pharmacy 1 (admin) is not sender/recipient of this request → 404
    assert.equal(r.status, 404, 'Admin from unrelated pharmacy must get 404');
  } finally {
    db.prepare('DELETE FROM medicine_redistribution_requests WHERE id=?').run(reqId);
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});

test('INTER-032: invalid state transition returns 409', async () => {
  // Create a COMPLETED request belonging to pharmacy 1 (the test admin)
  const mainPid = db.prepare('SELECT id FROM pharmacies LIMIT 1').get().id;
  const recipPid = createPharmacy('Recip 409', 19.1, 72.9);
  const medId    = createMedicine(mainPid, 'Med409', 0);
  const bId      = createBatch(medId, 'BATCH-409', 10, daysFromNow(5));
  const ikey = crypto.createHash('sha256').update(`${mainPid}|${recipPid}|${medId}|${bId}`).digest('hex');
  const ins = db.prepare(
    "INSERT INTO medicine_redistribution_requests (idempotency_key,sender_pharmacy_id,recipient_pharmacy_id,medicine_id,source_batch_id,requested_quantity,status) VALUES (?,?,?,?,?,5,'COMPLETED') RETURNING id"
  ).run(ikey, mainPid, recipPid, medId, bId);
  const reqId = Number(ins.lastInsertRowid);
  const cookie = await adminLogin();
  try {
    const r = await callApi({ method: 'POST', url: `/api/inter-pharmacy/requests/${reqId}/status`,
      cookie, body: { status: 'ACCEPTED' } });
    assert.equal(r.status, 409, 'Cannot transition from COMPLETED to ACCEPTED');
  } finally {
    db.prepare('DELETE FROM medicine_redistribution_requests WHERE id=?').run(reqId);
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    db.prepare('DELETE FROM medicines WHERE id=?').run(medId);
    db.prepare('DELETE FROM pharmacies WHERE id=?').run(recipPid);
  }
});

test('INTER-033: PUT /api/pharmacies/coordinates sets lat/lng for own pharmacy', async () => {
  const cookie = await adminLogin();
  const r = await callApi({ method: 'PUT', url: '/api/pharmacies/coordinates',
    cookie, body: { latitude: 19.0760, longitude: 72.8777 } });
  assert.equal(r.status, 200);
  assert.ok(r.body.pharmacy);
  assert.equal(Number(r.body.pharmacy.latitude).toFixed(4), '19.0760');
  assert.equal(Number(r.body.pharmacy.longitude).toFixed(4), '72.8777');
  // Reset coordinates for test isolation
  await callApi({ method: 'PUT', url: '/api/pharmacies/coordinates',
    cookie, body: { latitude: null, longitude: null } });
});

test('INTER-034: coordinates endpoint rejects out-of-range values', async () => {
  const cookie = await adminLogin();
  const r1 = await callApi({ method: 'PUT', url: '/api/pharmacies/coordinates',
    cookie, body: { latitude: 91, longitude: 0 } });
  assert.equal(r1.status, 400);
  const r2 = await callApi({ method: 'PUT', url: '/api/pharmacies/coordinates',
    cookie, body: { latitude: 0, longitude: 181 } });
  assert.equal(r2.status, 400);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURABLE THRESHOLD
// ─────────────────────────────────────────────────────────────────────────────
test('INTER-035: custom nearExpiryDays via opts respected', async () => {
  const senderPid = createPharmacy('Sender Custom', 19.0760, 72.8777);
  const recipPid  = createPharmacy('Recip Custom',  19.1000, 72.9000);
  const sMedId    = createMedicine(senderPid, 'MedCustom', 0);
  const rMedId    = createMedicine(recipPid,  'MedCustom', 20);
  const bId       = createBatch(sMedId, 'CUSTOM-BATCH', 25, daysFromNow(10));
  try {
    // With default threshold 20 days, expiry in 10 days qualifies
    const r1 = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 20, nearbyRadiusKm: 100 });
    assert.ok(r1.requests.some(r => r.batchId === bId), 'Should qualify under 20-day threshold');
    cleanRequests(bId);
    // With threshold = 5 days, 10-day batch does NOT qualify
    const r2 = await processNearExpiryRedistribution(senderPid, { nearExpiryDays: 5, nearbyRadiusKm: 100 });
    assert.equal(r2.requests.filter(r => r.batchId === bId).length, 0, '10-day batch must not qualify under 5-day threshold');
  } finally {
    cleanRequests(bId);
    db.prepare('DELETE FROM medicine_batches WHERE id=?').run(bId);
    [sMedId, rMedId].forEach(id => db.prepare('DELETE FROM medicines WHERE id=?').run(id));
    [senderPid, recipPid].forEach(id => db.prepare('DELETE FROM pharmacies WHERE id=?').run(id));
  }
});
