'use strict';
/**
 * tests/medicine-requests-ui.test.js
 *
 * PHASE 5 — frontend for manual medicine requests.
 *
 * Two layers, no new dependencies:
 *
 *  1. UI UNIT TESTS. public/app.js is a browser script, so it is evaluated
 *     inside a node:vm sandbox against a minimal DOM stub — the same technique
 *     already used by tests/api-response-parser.test.js. This exercises the
 *     REAL shipped rendering and timestamp code rather than a re-implementation.
 *
 *  2. API CONTRACT TESTS. Every field the UI reads is asserted to exist with the
 *     right shape on live responses (SQLite and PostgreSQL), so a backend change
 *     cannot silently break the screen.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const U = require('./medicine-request-test-utils');
const { COORDS, forEachDb, login, addTenant, setupRequester, createRequest, inventorySnapshot } = U;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_JS = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const STYLES_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Minimal DOM stub so public/app.js can be evaluated headlessly
// ─────────────────────────────────────────────────────────────────────────────

function makeElement(id = '') {
  const el = {
    id,
    _listeners: {},
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    textContent: '',
    innerHTML: '',
    value: '',
    max: '',
    hidden: false,
    disabled: false,
    open: false,
    checked: false,
    files: [],
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild(c) { return c; }, removeChild(c) { return c; }, insertAdjacentHTML() {},
    querySelector: () => makeElement(), querySelectorAll: () => [],
    closest: () => null, focus() {}, blur() {}, click() {}, reset() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    scrollIntoView() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
  };
  return el;
}

function buildSandbox(overrides = {}) {
  const elements = new Map();
  const getEl = (sel) => {
    const key = String(sel);
    if (!elements.has(key)) elements.set(key, makeElement(key.replace(/^#/, '')));
    return elements.get(key);
  };
  const documentStub = {
    _listeners: {},
    querySelector: getEl,
    querySelectorAll: () => [],
    getElementById: getEl,
    createElement: () => makeElement(),
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    body: makeElement('body'),
    documentElement: makeElement('html')
  };
  const sandbox = {
    document: documentStub,
    window: { addEventListener() {}, MediSync: null, location: { href: '', origin: 'http://localhost' } },
    navigator: { onLine: true },
    crypto: { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' }),
    alert() {}, confirm: () => true, prompt: () => '',
    console, Intl, Date, Math, JSON, Number, String, Boolean, Array, Object, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams,
    HTMLElement: class HTMLElement {},
    __elements: elements,
    ...overrides
  };
  sandbox.window.document = documentStub;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: 'public/app.js' });
  return sandbox;
}

let cachedSandbox = null;
function ui() {
  if (!cachedSandbox) cachedSandbox = buildSandbox();
  return cachedSandbox;
}

// Representative server payloads (shapes verified against the live API below).
const SQLITE_NAIVE_TS = '2026-09-21 17:57:25';        // SQLite CURRENT_TIMESTAMP (UTC, unmarked)
const PG_ISO_TS       = '2026-09-21T17:57:25.000Z';   // PostgreSQL / engine-written

function sampleRequest(over = {}) {
  return {
    id: 7, status: 'OPEN', requesterPharmacyId: 1, medicineId: 3,
    medicineName: 'Paracetamol', requestedQuantity: 50, coveredQuantity: 0,
    remainingQuantity: 50, priority: 'NORMAL', reason: 'Stock shortage',
    currentZoneIndex: 0, currentRadiusKm: 10, zoneCount: 4, maxRadiusKm: 100,
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    createdAt: SQLITE_NAIVE_TS, updatedAt: SQLITE_NAIVE_TS,
    ...over
  };
}

function sampleIncoming(over = {}) {
  return {
    offerId: 11, requestId: 7, requesterPharmacyId: 1, requesterName: 'Pharmacy A',
    medicineName: 'Paracetamol', requestedQuantity: 50, coveredQuantity: 0,
    outstandingQuantity: 50, distanceKm: 8.4, zoneIndex: 0, priority: 'NORMAL',
    reason: 'Stock shortage', usableStock: 80, reservedStock: 10, offerableStock: 70,
    canOffer: true, maxOfferableQuantity: 50, offerStatus: 'PENDING',
    requestStatus: 'OPEN',
    respondBy: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    requestedAt: SQLITE_NAIVE_TS,
    ...over
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 14. TIMESTAMP NORMALIZATION
// ═════════════════════════════════════════════════════════════════════════════

test('UI-001: parseServerTime treats an unmarked database timestamp as UTC', () => {
  const s = ui();
  const naive = s.parseServerTime(SQLITE_NAIVE_TS);
  const iso   = s.parseServerTime(PG_ISO_TS);
  assert.ok(naive, 'the SQLite form must parse');
  assert.ok(iso, 'the PostgreSQL form must parse');
  assert.equal(naive.toISOString(), '2026-09-21T17:57:25.000Z',
    'an unmarked timestamp must be read as UTC, not local time');
  assert.equal(naive.getTime(), iso.getTime(),
    'both engines must yield the identical instant');
});

test('UI-002: the naive form is NOT parsed the way a bare new Date() would', () => {
  const s = ui();
  const viaHelper = s.parseServerTime(SQLITE_NAIVE_TS).getTime();
  const viaNaive  = new Date(SQLITE_NAIVE_TS).getTime();
  // getTimezoneOffset() is minutes BEHIND UTC, so it is negative east of UTC.
  // Reading the string as UTC instead of local shifts the instant by -offset.
  const offsetMs  = new Date(SQLITE_NAIVE_TS).getTimezoneOffset() * 60000;
  if (offsetMs !== 0) {
    assert.notEqual(viaHelper, viaNaive,
      'in a non-UTC timezone the helper must differ from a bare new Date()');
  }
  // Normalize -0 to 0 so the assertion holds when the runner is already in UTC.
  const expectedShift = offsetMs === 0 ? 0 : -offsetMs;
  assert.equal(viaHelper - viaNaive, expectedShift,
    'the helper must correct exactly the local UTC offset');
});

test('UI-003: parseServerTime handles Date objects, offsets, and rejects junk', () => {
  const s = ui();
  const d = new Date('2026-01-02T03:04:05Z');
  assert.equal(s.parseServerTime(d).getTime(), d.getTime());
  assert.equal(s.parseServerTime('2026-09-21T17:57:25+05:30').toISOString(), '2026-09-21T12:27:25.000Z');
  for (const bad of [null, undefined, '', 'not-a-date']) {
    assert.equal(s.parseServerTime(bad), null, `${JSON.stringify(bad)} must yield null`);
  }
});

test('UI-004: formatRemaining renders 72h and 24h windows and handles elapsed time', () => {
  const s = ui();
  const now = Date.parse('2026-09-21T12:00:00Z');
  assert.equal(s.formatRemaining('2026-09-24T11:41:00Z', now), '2d 23h');   // ~72h request TTL
  assert.equal(s.formatRemaining('2026-09-21T19:12:00Z', now), '7h 12m');   // offer window
  assert.equal(s.formatRemaining('2026-09-21T12:18:00Z', now), '18m');
  assert.equal(s.formatRemaining('2026-09-21T11:00:00Z', now), null, 'already elapsed → null');
  assert.equal(s.formatRemaining(null, now), null);
  // Identical result whichever engine produced the value.
  assert.equal(
    s.formatRemaining('2026-09-21 19:12:00', now),
    s.formatRemaining('2026-09-21T19:12:00.000Z', now),
    'both timestamp shapes must produce the same countdown'
  );
});

test('UI-005: formatServerTime never emits "Invalid Date"', () => {
  const s = ui();
  assert.equal(s.formatServerTime(null), '—');
  assert.equal(s.formatServerTime('garbage'), '—');
  assert.doesNotMatch(s.formatServerTime(SQLITE_NAIVE_TS), /Invalid/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7/8/12. COVERAGE AND STATUS RENDERING
// ═════════════════════════════════════════════════════════════════════════════

test('UI-010: status labels use only the backend state names', () => {
  const s = ui();
  for (const st of ['OPEN', 'PARTIALLY_COVERED', 'FULLY_COVERED', 'NO_COVERAGE', 'CANCELLED', 'EXPIRED']) {
    const html = s.mreqStatusBadge(st);
    assert.match(html, new RegExp(st.replace('_', ' ')), `${st} must be shown with its own name`);
    assert.match(html, new RegExp(`mreq-badge-${st.toLowerCase()}`));
  }
  for (const st of ['PENDING', 'ACCEPTED', 'DECLINED', 'SUPERSEDED', 'EXPIRED']) {
    assert.match(s.mreqStatusBadge(st), new RegExp(st), `offer state ${st} must be shown`);
  }
  // No invented synonyms
  for (const invented of ['FULFILLED', 'COMPLETE', 'DELIVERED', 'TRANSFERRED', 'REJECTED']) {
    assert.doesNotMatch(s.mreqStatusBadge('FULLY_COVERED'), new RegExp(invented, 'i'));
  }
});

test('UI-011: partial coverage shows requested, covered and remaining', () => {
  const s = ui();
  const html = s.mreqCoverageBar(sampleRequest({
    status: 'PARTIALLY_COVERED', requestedQuantity: 50, coveredQuantity: 35, remainingQuantity: 15
  }));
  assert.match(html, /Requested\s*<strong>50<\/strong>/);
  assert.match(html, /Covered\s*<strong>35<\/strong>/);
  assert.match(html, /Remaining\s*<strong>15<\/strong>/);
  assert.match(html, /width:70%/, 'the progress bar must reflect 35 of 50');
});

test('UI-012: full coverage renders 100% and remaining zero', () => {
  const s = ui();
  const html = s.mreqCoverageBar(sampleRequest({
    status: 'FULLY_COVERED', coveredQuantity: 50, remainingQuantity: 0
  }));
  assert.match(html, /Remaining\s*<strong>0<\/strong>/);
  assert.match(html, /width:100%/);
});

test('UI-013: multiple contributing pharmacies are listed separately with distances', () => {
  const s = ui();
  const offers = [
    { id: 1, pharmacyId: 2, pharmacyName: 'Pharmacy B', status: 'ACCEPTED', offeredQuantity: 20, distanceKm: 8.4, zoneIndex: 0 },
    { id: 2, pharmacyId: 3, pharmacyName: 'Pharmacy C', status: 'ACCEPTED', offeredQuantity: 30, distanceKm: 17.2, zoneIndex: 1 }
  ];
  const html = offers.map(o => s.mreqOfferRow(o)).join('');
  assert.match(html, /Pharmacy B/);
  assert.match(html, /8\.4 km/);
  assert.match(html, /<strong>20<\/strong>/);
  assert.match(html, /Pharmacy C/);
  assert.match(html, /17\.2 km/);
  assert.match(html, /<strong>30<\/strong>/);
  assert.equal((html.match(/mreq-badge-accepted/g) || []).length, 2, 'each contribution is shown separately');
});

test('UI-014: a declined offer shows its reason and a pending one shows time left', () => {
  const s = ui();
  const declined = s.mreqOfferRow({ id: 3, pharmacyId: 4, pharmacyName: 'Pharmacy D', status: 'DECLINED', offeredQuantity: null, distanceKm: 5, zoneIndex: 0, declineReason: 'No spare stock' });
  assert.match(declined, /No spare stock/);
  assert.match(declined, /mreq-badge-declined/);
  assert.match(declined, /<strong>—<\/strong>/, 'a declined offer has no quantity');

  const pending = s.mreqOfferRow({ id: 4, pharmacyId: 5, pharmacyName: 'Pharmacy E', status: 'PENDING', offeredQuantity: null, distanceKm: 6, zoneIndex: 0, respondBy: new Date(Date.now() + 7 * 3600 * 1000).toISOString() });
  assert.match(pending, /Awaiting response/);
  assert.match(pending, /left/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. PROGRESSIVE SEARCH DISPLAY
// ═════════════════════════════════════════════════════════════════════════════

test('UI-020: zone 1 of 4 is reported as searching within the server-confirmed radius', () => {
  const s = ui();
  const html = s.mreqSearchProgress(sampleRequest({ currentZoneIndex: 0, currentRadiusKm: 10 }), []);
  assert.match(html, /Searching within 10 km/);
  assert.match(html, /Zone 1 of 4 — current · 10 km/);
  assert.match(html, /Zone 4 of 4 — not reached/);
  assert.doesNotMatch(html, /25 km|50 km|100 km/, 'radii the server did not confirm must not be claimed');
});

test('UI-021: expansion is announced and earlier zones are marked reached', () => {
  const s = ui();
  const offers = [
    { pharmacyId: 2, zoneIndex: 0, status: 'DECLINED' },
    { pharmacyId: 3, zoneIndex: 1, status: 'PENDING' }
  ];
  const html = s.mreqSearchProgress(sampleRequest({ currentZoneIndex: 1, currentRadiusKm: 25 }), offers);
  assert.match(html, /Expanded search to 25 km/);
  assert.match(html, /Zone 1 of 4 — reached · 1 contacted/);
  assert.match(html, /Zone 2 of 4 — current · 25 km · 1 contacted/);
  assert.match(html, /Zone 3 of 4 — not reached/);
});

test('UI-022: the final zone reports the maximum radius reached', () => {
  const s = ui();
  const html = s.mreqSearchProgress(sampleRequest({ currentZoneIndex: 3, currentRadiusKm: 100 }), []);
  assert.match(html, /Maximum search radius reached \(100 km\)/);
});

test('UI-023: a fully covered request never implies an ongoing search', () => {
  const s = ui();
  const html = s.mreqSearchProgress(sampleRequest({
    status: 'FULLY_COVERED', coveredQuantity: 50, remainingQuantity: 0, currentZoneIndex: 1, currentRadiusKm: 25
  }), [{ pharmacyId: 2, zoneIndex: 0 }, { pharmacyId: 3, zoneIndex: 1 }]);
  assert.match(html, /Fully covered — the search has stopped/);
  assert.doesNotMatch(html, /Searching within/);
  assert.doesNotMatch(html, /Expanded search/);
  // Zones never reached must not be presented as reached.
  assert.match(html, /Zone 3 of 4 — not reached/);
  assert.match(html, /Zone 4 of 4 — not reached/);
});

test('UI-024: NO_COVERAGE, CANCELLED and EXPIRED each stop the search narrative', () => {
  const s = ui();
  const noCov = s.mreqSearchProgress(sampleRequest({ status: 'NO_COVERAGE', currentZoneIndex: 3, currentRadiusKm: 100 }), []);
  assert.match(noCov, /No coverage found within the maximum 100 km radius/);
  const cancelled = s.mreqSearchProgress(sampleRequest({ status: 'CANCELLED' }), []);
  assert.match(cancelled, /cancelled — the search has stopped/i);
  const expired = s.mreqSearchProgress(sampleRequest({ status: 'EXPIRED' }), []);
  assert.match(expired, /expired — the search has stopped/i);
  for (const html of [noCov, cancelled, expired]) {
    assert.doesNotMatch(html, /Searching within|Expanded search/);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5/6/7. CARD RENDERING
// ═════════════════════════════════════════════════════════════════════════════

test('UI-030: a requester card shows every required field', () => {
  const s = ui();
  const html = s.mreqMyCard(sampleRequest({
    status: 'PARTIALLY_COVERED', coveredQuantity: 20, remainingQuantity: 30,
    currentZoneIndex: 1, currentRadiusKm: 25,
    offerSummary: { contacted: 3, byStatus: { ACCEPTED: 1, DECLINED: 1, PENDING: 1 }, acceptedQuantity: 20 }
  }));
  assert.match(html, /Paracetamol/);
  assert.match(html, /Requested\s*<strong>50<\/strong>/);
  assert.match(html, /Covered\s*<strong>20<\/strong>/);
  assert.match(html, /Remaining\s*<strong>30<\/strong>/);
  assert.match(html, /PARTIALLY COVERED/);
  assert.match(html, /Search radius: <strong>25 km<\/strong>/);
  assert.match(html, /Zone <strong>2 of 4<\/strong>/);
  assert.match(html, /Responses: <strong>3<\/strong> \(1 accepted\)/);
  assert.match(html, /Expires in/);
  assert.match(html, /Reason: Stock shortage/);
  assert.match(html, /data-mreq-detail="7"/);
  assert.match(html, /data-mreq-cancel="7"/, 'an open request is cancellable');
});

test('UI-031: a finished search never offers continue-search; final states offer no cancel', () => {
  const s = ui();
  // Once the search has stopped, "Continue search" must never be offered.
  for (const status of ['NO_COVERAGE', 'FULLY_COVERED', 'CANCELLED', 'EXPIRED']) {
    const html = s.mreqMyCard(sampleRequest({ status }));
    assert.doesNotMatch(html, /data-mreq-advance/, `${status} must not offer continue-search`);
    assert.match(html, /data-mreq-detail/, 'detail remains viewable');
  }
  // Final states (already cancelled / elapsed) offer no cancel either.
  for (const status of ['CANCELLED', 'EXPIRED']) {
    assert.doesNotMatch(s.mreqMyCard(sampleRequest({ status })), /data-mreq-cancel/,
      `${status} must not offer cancel`);
  }
  // But a still-live request whose search finished remains cancellable.
  for (const status of ['NO_COVERAGE', 'FULLY_COVERED']) {
    assert.match(s.mreqMyCard(sampleRequest({ status })), /data-mreq-cancel/,
      `${status} is still within its lifetime and must remain cancellable`);
  }
});

test('UI-032: an URGENT request is flagged', () => {
  const s = ui();
  assert.match(s.mreqMyCard(sampleRequest({ priority: 'URGENT' })), /URGENT/);
  assert.doesNotMatch(s.mreqMyCard(sampleRequest({ priority: 'NORMAL' })), /URGENT/);
});

test('UI-040: an incoming card shows server-computed stock figures and an offer control', () => {
  const s = ui();
  const html = s.mreqIncomingCard(sampleIncoming());
  assert.match(html, /Paracetamol/);
  assert.match(html, /From Pharmacy A/);
  assert.match(html, /8\.4 km away/);
  assert.match(html, /Requested: <strong>50<\/strong>/);
  assert.match(html, /Still needed: <strong>50<\/strong>/);
  assert.match(html, /Your usable stock: <strong>80<\/strong>/);
  assert.match(html, /Reserved: <strong>10<\/strong>/);
  assert.match(html, /Offerable: <strong>70<\/strong>/);
  assert.match(html, /Respond within/);
  assert.match(html, /data-mreq-offer-input="7"/);
  assert.match(html, /max="50"/, 'the input is capped by the server maximum');
  assert.match(html, /data-mreq-offer="7"/);
  assert.match(html, /data-mreq-decline="7"/);
});

test('UI-041: a zero-stock recipient sees the message and only Decline', () => {
  const s = ui();
  const html = s.mreqIncomingCard(sampleIncoming({
    usableStock: 0, reservedStock: 0, offerableStock: 0, canOffer: false, maxOfferableQuantity: 0
  }));
  assert.match(html, /You don't have usable stock for this medicine\./);
  assert.match(html, /data-mreq-decline="7"/, 'declining must still be possible');
  assert.doesNotMatch(html, /data-mreq-offer="7"/, 'the offer button must be absent');
  assert.doesNotMatch(html, /data-mreq-offer-input/, 'no quantity input when nothing is offerable');
  // The request is still shown, not hidden.
  assert.match(html, /Paracetamol/);
  assert.match(html, /From Pharmacy A/);
});

test('UI-042: the server verdict wins even when raw stock looks available', () => {
  const s = ui();
  // Fully reserved: usable 80 but nothing offerable, and canOffer=false.
  const html = s.mreqIncomingCard(sampleIncoming({
    usableStock: 80, reservedStock: 80, offerableStock: 0, canOffer: false, maxOfferableQuantity: 0
  }));
  assert.doesNotMatch(html, /data-mreq-offer="7"/,
    'the UI must not offer an action the server says is impossible');
  assert.match(html, /Your usable stock: <strong>80<\/strong>/, 'raw figures are still displayed honestly');
});

test('UI-043: the offer input is clamped to maxOfferableQuantity, not to raw stock', () => {
  const s = ui();
  // usable/offerable 70 but only 15 still needed → the cap is 15.
  const html = s.mreqIncomingCard(sampleIncoming({
    outstandingQuantity: 15, offerableStock: 70, maxOfferableQuantity: 15
  }));
  assert.match(html, /max="15"/);
  assert.match(html, /value="15"/);
  assert.match(html, /Max 15/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. COMMITMENT ≠ INVENTORY TRANSFER
// ═════════════════════════════════════════════════════════════════════════════

test('UI-050: the UI never claims inventory moved', () => {
  const s = ui();
  const incoming = s.mreqIncomingCard(sampleIncoming());
  assert.match(incoming, /does not transfer inventory/i,
    'the recipient must be told offering is a commitment only');

  const covered = s.mreqSearchProgress(sampleRequest({ status: 'FULLY_COVERED' }), []);
  assert.doesNotMatch(covered, /transferred|delivered|dispatched|shipped|stock moved/i);

  // The static copy in index.html carries the same disclaimer.
  assert.match(INDEX_HTML, /Offers are commitments only/i);
  assert.match(INDEX_HTML, /no inventory is transferred/i);

  // Nothing in the frontend mutates inventory.
  assert.doesNotMatch(APP_JS, /\/api\/medicines\/[^']*\/batches[^']*',\s*\{\s*method:\s*'DELETE'/);
  const mreqBlock = APP_JS.slice(APP_JS.indexOf('MANUAL MEDICINE REQUESTS'));
  assert.doesNotMatch(mreqBlock, /medicine_batches|inventory_movements/,
    'the medicine-request UI must not touch inventory tables');
  assert.doesNotMatch(mreqBlock, /\/api\/medicines\/\$\{[^}]*\}\/batches/,
    'the medicine-request UI must not post batch changes');
});

// ═════════════════════════════════════════════════════════════════════════════
// 12/13/17/20/21. STRUCTURE, RBAC VISIBILITY, A11Y, RESPONSIVENESS
// ═════════════════════════════════════════════════════════════════════════════

test('UI-060: the nav entry is available to STAFF (not gated as admin-only)', () => {
  const navMatch = INDEX_HTML.match(/<button class="nav[^"]*" data-view="medicine-requests"[^>]*>/);
  assert.ok(navMatch, 'a Medicine Requests nav button must exist');
  assert.doesNotMatch(navMatch[0], /admin-only-nav/,
    'medicine requests are normal pharmacy operation and must not be ADMIN-only');
  assert.doesNotMatch(navMatch[0], /hidden/, 'the tab must not start hidden');

  // The near-expiry tab remains ADMIN-only.
  const redistribNav = INDEX_HTML.match(/<button class="nav[^"]*" data-view="redistribution"[^>]*>/);
  assert.ok(redistribNav);
  assert.match(redistribNav[0], /admin-only-nav/, 'near-expiry redistribution stays ADMIN-only');
  assert.match(redistribNav[0], /hidden/);
});

test('UI-061: the view, tabs, dialogs and empty states exist', () => {
  assert.match(INDEX_HTML, /id="medicine-requests-view"/);
  assert.match(INDEX_HTML, /data-mreq-tab="mine"/);
  assert.match(INDEX_HTML, /data-mreq-tab="incoming"/);
  assert.match(INDEX_HTML, /id="mreq-create-dialog"/);
  assert.match(INDEX_HTML, /id="mreq-detail-dialog"/);
  assert.match(INDEX_HTML, /id="medicine-requests-badge"/);
  // switchView must manage the new section
  assert.match(APP_JS, /#medicine-requests-view'\)\.hidden = view !== 'medicine-requests'/);
  assert.match(APP_JS, /if \(view === 'medicine-requests'\) loadMedicineRequestsView\(\)/);
  // Meaningful empty states
  const s = ui();
  assert.match(APP_JS, /No medicine requests yet/);
  assert.match(APP_JS, /No incoming medicine requests/);
  assert.match(APP_JS, /No offers yet/);
  assert.ok(s.mreqStatusBadge);
});

test('UI-062: create form validates client-side and guards duplicate submission', () => {
  assert.match(APP_JS, /mreqBusy/, 'a submission guard must exist');
  assert.match(APP_JS, /Quantity must be a whole number greater than zero/);
  assert.match(APP_JS, /idempotencyKey: mreqCreateKey/, 'creation must send an idempotency key');
  assert.match(APP_JS, /mreqCreateKey = mreqNewIdempotencyKey\(\)/);
  // The key is retained on failure so a retry is idempotent.
  assert.match(APP_JS, /intentionally retained so a retry is treated as the same request/);
  const s = ui();
  assert.equal(typeof s.mreqNewIdempotencyKey(), 'string');
  assert.ok(s.mreqNewIdempotencyKey().length <= 64, 'the key must fit the 64-char column');
});

test('UI-063: cancellation asks for confirmation', () => {
  assert.match(APP_JS, /window\.confirm\('Cancel this medicine request\?/);
  // The mandatory confirmation must gate the API call: an early return on
  // dismissal appears before the cancel POST.
  const fn = APP_JS.slice(APP_JS.indexOf('async function mreqCancel'));
  const confirmIdx = fn.indexOf('window.confirm');
  const postIdx = fn.indexOf('/cancel`');
  assert.ok(confirmIdx > -1 && postIdx > -1 && confirmIdx < postIdx,
    'the confirmation must precede the cancel API call');
  assert.match(fn.slice(0, postIdx), /if \(!window\.confirm[\s\S]*?\) return;/,
    'dismissing the confirmation must return before any request is sent');
});

// ── Cancel Request action in the requester detail modal (the reported bug) ──

test('UI-063a: mreqCanCancel mirrors the backend CANCELLABLE_REQUEST_STATUSES exactly', () => {
  const s = ui();
  // The UI gate must be exactly as wide as the server rule — never narrower
  // (hiding a valid action) and never wider (offering a guaranteed 409).
  const { CANCELLABLE_REQUEST_STATUSES } = require('../medicine-requests')
    .createMedicineRequestEngine({
      db: { get: () => null, run: () => ({}), query: () => [], transaction: (f) => f({}) },
      isPg: false, haversineKm: () => 0
    });

  for (const st of CANCELLABLE_REQUEST_STATUSES) {
    assert.equal(s.mreqCanCancel(st, true), true,
      `${st} is cancellable server-side, so the UI must offer the action`);
  }
  // A requester-owned NO_COVERAGE request is still within its lifetime → cancellable.
  assert.equal(s.mreqCanCancel('NO_COVERAGE', true), true);
  assert.equal(s.mreqCanCancel('OPEN', true), true);
  assert.equal(s.mreqCanCancel('PARTIALLY_COVERED', true), true);
  assert.equal(s.mreqCanCancel('FULLY_COVERED', true), true);

  // Final states are never cancellable.
  assert.equal(s.mreqCanCancel('EXPIRED', true), false, 'an expired request is final');
  assert.equal(s.mreqCanCancel('CANCELLED', true), false, 'an already-cancelled request needs no action');

  // Non-requester → never cancellable, whatever the status.
  for (const st of ['OPEN', 'PARTIALLY_COVERED', 'FULLY_COVERED', 'NO_COVERAGE']) {
    assert.equal(s.mreqCanCancel(st, false), false, `a non-requester must not get cancel for ${st}`);
  }
});

test('UI-063h: a requester-owned NO_COVERAGE request offers Cancel Request in card and modal', () => {
  const s = ui();
  const noCoverage = sampleRequest({
    status: 'NO_COVERAGE', coveredQuantity: 0, remainingQuantity: 50,
    currentZoneIndex: 3, currentRadiusKm: 100,
    expiresAt: new Date(Date.now() + 71 * 3600 * 1000).toISOString()   // still within its 72h life
  });

  // Card: Cancel Request present, but "Continue search" is NOT — the search is exhausted.
  const card = s.mreqMyCard(noCoverage);
  assert.match(card, /data-mreq-cancel="7"/, 'the NO_COVERAGE card must offer Cancel Request');
  assert.match(card, /Cancel Request/);
  assert.doesNotMatch(card, /data-mreq-advance/,
    'an exhausted search must not offer Continue search');
  assert.match(card, /NO COVERAGE/, 'the status is still shown honestly');
  assert.match(card, /Expires in/, 'the remaining lifetime is still shown');

  // Modal: the same helper drives the action row.
  assert.equal(s.mreqCanCancel(noCoverage.status, true), true);
  // And the search narrative still says the search has stopped.
  assert.match(s.mreqSearchProgress(noCoverage, []), /No coverage found within the maximum 100 km radius/);
});

test('UI-063b: the detail modal shows a Cancel Request action for a cancellable own request', () => {
  // The detail modal builds its action row from mreqCanCancel + viewerRole.
  // Reproduce the exact expression the modal uses and assert the button appears.
  const s = ui();
  const build = (status, viewerRole) => {
    const isRequester = viewerRole === 'REQUESTER';
    const canCancel = s.mreqCanCancel(status, isRequester);
    return canCancel
      ? `<button type="button" class="danger" data-mreq-cancel="9">Cancel Request</button>`
      : '';
  };
  assert.match(build('OPEN', 'REQUESTER'), /data-mreq-cancel="9"/);
  assert.match(build('OPEN', 'REQUESTER'), /Cancel Request/);
  assert.match(build('PARTIALLY_COVERED', 'REQUESTER'), /data-mreq-cancel/);
  // The source wires the modal action row through mreqCanCancel and labels it "Cancel Request".
  const modalSrc = APP_JS.slice(APP_JS.indexOf('openMedicineRequestDetail'));
  assert.match(modalSrc, /const canCancel = mreqCanCancel\(r\.status, isRequester\)/,
    'the modal must derive cancellability from the shared helper');
  assert.match(modalSrc, /data-mreq-cancel="\$\{r\.id\}">Cancel Request/,
    'the modal must render a Cancel Request button in its action row');
  assert.match(modalSrc, /data-close="mreq-detail-dialog">Close/,
    'Close must remain in the same action row');
});

test('UI-063c: a non-requester viewing the request gets no cancel action in the modal', () => {
  const s = ui();
  const isRequester = false; // viewerRole === 'RECIPIENT'
  assert.equal(s.mreqCanCancel('OPEN', isRequester), false);
  assert.equal(s.mreqCanCancel('PARTIALLY_COVERED', isRequester), false);
});

test('UI-063d: CANCELLED and EXPIRED requests show no cancel action anywhere', () => {
  const s = ui();
  for (const status of ['CANCELLED', 'EXPIRED']) {
    // My Requests card
    assert.doesNotMatch(s.mreqMyCard(sampleRequest({ status })), /data-mreq-cancel/,
      `the ${status} card must not offer cancel`);
    // Modal helper
    assert.equal(s.mreqCanCancel(status, true), false, `the ${status} modal must not offer cancel`);
  }
});

test('UI-063e: duplicate cancellation is prevented while one is in flight', () => {
  // mreqCancel runs through mreqRunAction, which is guarded by the mreqBusy flag
  // and disables the button until the request settles.
  const fn = APP_JS.slice(APP_JS.indexOf('async function mreqCancel'), APP_JS.indexOf('async function mreqCancel') + 900);
  assert.match(fn, /mreqRunAction\(button/, 'cancel must run through the shared action guard');
  const guard = APP_JS.slice(APP_JS.indexOf('async function mreqRunAction'), APP_JS.indexOf('async function mreqRunAction') + 500);
  assert.match(guard, /if \(mreqBusy\) return/, 'a second submission must be ignored while busy');
  assert.match(guard, /button\.disabled = true/, 'the button must be disabled while working');
});

test('UI-063f: cancel never sends client pharmacy identity and uses the existing helper', () => {
  const fn = APP_JS.slice(APP_JS.indexOf('async function mreqCancel'), APP_JS.indexOf('async function mreqCancel') + 900);
  assert.match(fn, /\$\{MREQ_API\}\/\$\{requestId\}\/cancel/, 'the correct cancel endpoint is used');
  assert.match(fn, /JSON\.stringify\(\{\}\)/, 'the cancel body carries no pharmacy id');
  assert.doesNotMatch(fn, /pharmacyId|pharmacy_id|requesterPharmacyId/, 'no client pharmacy identity may be sent');
  assert.match(fn, /api\(/, 'the existing api() helper must be used');
});

test('UI-063g: a failed cancellation shows an error and never claims success', () => {
  const start = APP_JS.indexOf('async function mreqCancel');
  const fn = APP_JS.slice(start, APP_JS.indexOf('\n}\n', start) + 2);
  // On error the message is surfaced and no success/close path runs in the catch.
  assert.match(fn, /catch \(err\) \{[\s\S]*mreqSetError\(err\.message\)/,
    'a failure must surface the error message');
  assert.match(fn, /detailError[\s\S]*err\.message/, 'the modal error area must show the failure');
  const catchBlock = fn.slice(fn.indexOf('catch (err)'));
  assert.doesNotMatch(catchBlock, /CANCELLED|closeDialog/,
    'the failure path must not claim success or close as if cancelled');
});

test('UI-064: offline is surfaced and requests are never queued for sync', () => {
  assert.match(INDEX_HTML, /id="mreq-offline-note"/);
  assert.match(INDEX_HTML, /not queued for later sync/i);
  assert.match(APP_JS, /navigator\.onLine === false/);
  const mreqBlock = APP_JS.slice(APP_JS.indexOf('MANUAL MEDICINE REQUESTS'));
  assert.doesNotMatch(mreqBlock, /MediSync|enqueue|outbox|stock-receipt/i,
    'medicine requests must not enter the offline stock-receipt queue');
});

test('UI-065: no scheduler, websocket, push or email was introduced', () => {
  const mreqBlock = APP_JS.slice(APP_JS.indexOf('MANUAL MEDICINE REQUESTS'));
  for (const banned of ['setInterval', 'WebSocket', 'EventSource', 'Notification(', 'serviceWorker', 'pushManager']) {
    assert.ok(!mreqBlock.includes(banned), `${banned} must not appear in the medicine-request UI`);
  }
  assert.match(APP_JS, /no polling loop, timer or background worker/i);
});

test('UI-066: responsive and accessible conventions are present', () => {
  assert.match(STYLES_CSS, /@media \(max-width: 720px\)[\s\S]*mreq-card-head/,
    'cards must stack on small screens');
  assert.match(STYLES_CSS, /\.mreq-offer-row \{[\s\S]*flex-wrap: wrap/);
  assert.match(STYLES_CSS, /min-height: 2\.6rem/, 'touch targets must stay usable on mobile');
  assert.match(INDEX_HTML, /role="tablist"/);
  assert.match(INDEX_HTML, /aria-selected/);
  assert.match(INDEX_HTML, /aria-live="polite"/);
  assert.match(INDEX_HTML, /role="alert"/);
  assert.match(APP_JS, /aria-label="Quantity to offer/);
});

test('UI-067: rendered output escapes untrusted text', () => {
  const s = ui();
  const html = s.mreqIncomingCard(sampleIncoming({
    requesterName: '<img src=x onerror=alert(1)>', medicineName: '<script>bad()</script>', reason: '"><b>x'
  }));
  assert.doesNotMatch(html, /<script>bad/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

// ═════════════════════════════════════════════════════════════════════════════
// API CONTRACT — every field the UI reads must exist on live responses
// ═════════════════════════════════════════════════════════════════════════════

const REQUEST_FIELDS = ['id', 'status', 'medicineName', 'requestedQuantity', 'coveredQuantity',
  'remainingQuantity', 'priority', 'currentZoneIndex', 'currentRadiusKm', 'zoneCount',
  'maxRadiusKm', 'expiresAt', 'createdAt'];
const INCOMING_FIELDS = ['offerId', 'requestId', 'requesterName', 'medicineName', 'requestedQuantity',
  'coveredQuantity', 'outstandingQuantity', 'distanceKm', 'usableStock', 'reservedStock',
  'offerableStock', 'canOffer', 'maxOfferableQuantity', 'offerStatus', 'requestStatus',
  'respondBy', 'requestedAt'];
const OFFER_FIELDS = ['id', 'pharmacyId', 'pharmacyName', 'status', 'offeredQuantity', 'distanceKm', 'zoneIndex'];

forEachDb(test, 'UI-100: create/list/detail responses carry every field the UI renders', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near, { stock: 80 });
  const cookie = await login(h, 'staff@mediindex.local');

  const created = await createRequest(h, cookie, { requestedQuantity: 50, priority: 'URGENT', reason: 'Stock shortage' });
  assert.equal(created.status, 201, created.raw);
  for (const f of REQUEST_FIELDS) {
    assert.notEqual(created.body.request[f], undefined, `create response must include request.${f}`);
  }
  assert.equal(created.body.request.zoneCount, 4);
  assert.equal(created.body.request.maxRadiusKm, 100);
  assert.equal(created.body.request.currentRadiusKm, 10);
  const id = created.body.request.id;

  const list = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests', cookie });
  for (const f of REQUEST_FIELDS) {
    assert.notEqual(list.body.requests[0][f], undefined, `list response must include ${f}`);
  }
  assert.ok(list.body.requests[0].offerSummary, 'the list must include an offer summary for the card');
  assert.equal(typeof list.body.requests[0].offerSummary.contacted, 'number');

  const detail = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie });
  assert.equal(detail.body.viewerRole, 'REQUESTER');
  assert.equal(typeof detail.body.coveredQuantity, 'number');
  assert.equal(typeof detail.body.remainingQuantity, 'number');
  for (const f of OFFER_FIELDS) {
    assert.notEqual(detail.body.offers[0][f], undefined, `offer must include ${f}`);
  }

  // The renderers accept the live payloads without throwing.
  const s = ui();
  assert.ok(s.mreqMyCard(list.body.requests[0]).includes('Paracetamol'));
  assert.ok(s.mreqSearchProgress(detail.body.request, detail.body.offers).includes('Zone 1 of 4'));
  assert.ok(s.mreqOfferRow(detail.body.offers[0]).includes('Pharmacy B'));
  // Live timestamps normalize on both engines.
  assert.ok(s.parseServerTime(detail.body.request.createdAt), 'createdAt must normalize');
  assert.ok(s.formatRemaining(detail.body.request.expiresAt), 'expiresAt must yield a countdown');
});

forEachDb(test, 'UI-101: incoming response carries every field, including the zero-stock case', async (h) => {
  await setupRequester(h);
  const stocked = await addTenant(h, 'Pharmacy B', COORDS.near,  { stock: 80 });
  const zero    = await addTenant(h, 'Pharmacy C', COORDS.near2, { stock: 0 });
  await addTenant(h, 'Pharmacy D', COORDS.mid, { stock: 500 });
  const cookie = await login(h, 'staff@mediindex.local');
  await createRequest(h, cookie, { requestedQuantity: 200 });   // forces both to be contacted

  const s = ui();

  const stockedView = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/incoming', cookie: await login(h, stocked.staffEmail) });
  assert.equal(stockedView.status, 200, stockedView.raw);
  const item = stockedView.body.incoming[0];
  for (const f of INCOMING_FIELDS) assert.notEqual(item[f], undefined, `incoming must include ${f}`);
  assert.equal(item.canOffer, true);
  const stockedHtml = s.mreqIncomingCard(item);
  assert.match(stockedHtml, /data-mreq-offer=/, 'a stocked pharmacy gets the offer control');

  const zeroView = await h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/incoming', cookie: await login(h, zero.staffEmail) });
  assert.equal(zeroView.body.count, 1, 'a zero-stock pharmacy is still shown the request');
  const zeroItem = zeroView.body.incoming[0];
  assert.equal(zeroItem.usableStock, 0);
  assert.equal(zeroItem.canOffer, false);
  const zeroHtml = s.mreqIncomingCard(zeroItem);
  assert.match(zeroHtml, /You don't have usable stock/);
  assert.doesNotMatch(zeroHtml, /data-mreq-offer=/);
  assert.match(zeroHtml, /data-mreq-decline=/);
});

forEachDb(test, 'UI-102: offer, decline and cancel responses match what the UI reads', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near,  { stock: 20 });
  const c = await addTenant(h, 'Pharmacy C', COORDS.near2, { stock: 20 });
  await addTenant(h, 'Pharmacy D', COORDS.mid, { stock: 500 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const before = await inventorySnapshot(h);
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 60 })).body.request.id;

  // offer → the UI reads offer, request, coveredQuantity, remainingQuantity
  const offer = await h.request({
    method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`,
    cookie: await login(h, b.staffEmail), body: { offeredQuantity: 20 }
  });
  assert.equal(offer.status, 200, offer.raw);
  assert.equal(offer.body.accepted, true);
  assert.equal(offer.body.coveredQuantity, 20);
  assert.equal(offer.body.remainingQuantity, 40);
  assert.equal(offer.body.offer.status, 'ACCEPTED');
  assert.equal(offer.body.request.status, 'PARTIALLY_COVERED');

  // decline → the UI reads offer + declined
  const decline = await h.request({
    method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/decline`,
    cookie: await login(h, c.staffEmail), body: { reason: 'No spare stock' }
  });
  assert.equal(decline.status, 200, decline.raw);
  assert.equal(decline.body.declined, true);
  assert.equal(decline.body.offer.status, 'DECLINED');
  assert.equal(decline.body.offer.declineReason, 'No spare stock');

  // The detail view renders the mixed offer set.
  const s = ui();
  const detail = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie: reqCookie });
  const rendered = detail.body.offers.map(o => s.mreqOfferRow(o)).join('');
  assert.match(rendered, /mreq-badge-accepted/);
  assert.match(rendered, /mreq-badge-declined/);
  assert.match(rendered, /No spare stock/);

  // cancel → the UI reads request + cancelled
  const cancel = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie: reqCookie, body: {} });
  assert.equal(cancel.status, 200, cancel.raw);
  assert.equal(cancel.body.cancelled, true);
  assert.equal(cancel.body.request.status, 'CANCELLED');
  assert.match(s.mreqMyCard(cancel.body.request), /CANCELLED/);

  // No UI action moved inventory.
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches, 'offer/decline/cancel must not change any batch');
  assert.equal(after.totalUnits, before.totalUnits);
  assert.equal(after.movements, before.movements);
  assert.equal(after.movements, 0);
});

forEachDb(test, 'UI-106: cancel succeeds, flips status to CANCELLED, and disables further cancel', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const before = await inventorySnapshot(h);
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 50 })).body.request.id;

  const s = ui();

  // Before cancel: the requester detail view offers the action.
  const openDetail = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie: reqCookie });
  assert.equal(openDetail.body.viewerRole, 'REQUESTER');
  assert.equal(s.mreqCanCancel(openDetail.body.request.status, true), true,
    'an OPEN own request must be cancellable');

  // Cancel via the same endpoint the UI calls.
  const cancel = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie: reqCookie, body: {} });
  assert.equal(cancel.status, 200, cancel.raw);
  assert.equal(cancel.body.cancelled, true);
  assert.equal(cancel.body.request.status, 'CANCELLED');

  // After cancel: detail shows CANCELLED and the action is gone.
  const afterDetail = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie: reqCookie });
  assert.equal(afterDetail.body.request.status, 'CANCELLED');
  assert.equal(s.mreqCanCancel(afterDetail.body.request.status, true), false,
    'a cancelled request must no longer be cancellable');
  assert.doesNotMatch(s.mreqMyCard(afterDetail.body.request), /data-mreq-cancel/);
  assert.match(s.mreqMyCard(afterDetail.body.request), /CANCELLED/);

  // A repeat cancel is idempotent and stays 200 (the UI treats this as success).
  const again = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie: reqCookie, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.request.status, 'CANCELLED');

  // No inventory moved by cancelling.
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches);
  assert.equal(after.totalUnits, before.totalUnits);
  assert.equal(after.movements, before.movements);
  assert.equal(after.movements, 0);
});

forEachDb(test, 'UI-108: the reported NO_COVERAGE scenario is cancellable end to end', async (h) => {
  // Reproduces the manual-verification screenshot: requested 50, covered 0,
  // remaining 50, zone 4 of 4, 100 km, still within its 72h lifetime.
  await setupRequester(h);
  await addTenant(h, 'Tenant Far', COORDS.delhi, { stock: 500 });   // out of every zone
  const reqCookie = await login(h, 'staff@mediindex.local');
  const before = await inventorySnapshot(h);

  const created = await createRequest(h, reqCookie, { requestedQuantity: 50 });
  const r = created.body.request;
  assert.equal(r.status, 'NO_COVERAGE');
  assert.equal(r.requestedQuantity, 50);
  assert.equal(r.coveredQuantity, 0);
  assert.equal(r.remainingQuantity, 50);
  assert.equal(r.currentZoneIndex, 3);
  assert.equal(r.currentRadiusKm, 100);
  assert.equal(r.zoneCount, 4);

  const s = ui();
  // The lifetime countdown still renders (matching "Expires in 2d 23h").
  assert.ok(s.formatRemaining(r.expiresAt), 'the request must still show a lifetime countdown');
  // The card now offers Cancel Request — the bug that was reported.
  const card = s.mreqMyCard(r);
  assert.match(card, /data-mreq-cancel/, 'the NO_COVERAGE card must offer Cancel Request');
  assert.doesNotMatch(card, /data-mreq-advance/, 'and must not offer Continue search');
  // The modal gate agrees.
  const detail = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${r.id}`, cookie: reqCookie });
  assert.equal(detail.body.viewerRole, 'REQUESTER');
  assert.equal(s.mreqCanCancel(detail.body.request.status, true), true);

  // Cancelling succeeds and the action disappears.
  const cancel = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${r.id}/cancel`, cookie: reqCookie, body: {} });
  assert.equal(cancel.status, 200, cancel.raw);
  assert.equal(cancel.body.request.status, 'CANCELLED');
  assert.doesNotMatch(s.mreqMyCard(cancel.body.request), /data-mreq-cancel/);
  assert.match(s.mreqMyCard(cancel.body.request), /CANCELLED/);

  // No inventory moved, no offers invented.
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches);
  assert.equal(after.totalUnits, before.totalUnits);
  assert.equal(after.movements, before.movements);
  assert.equal(after.movements, 0);
  const offers = await h.db.query('SELECT COUNT(*) AS n FROM medicine_request_offers WHERE request_id = ?', [r.id]);
  assert.equal(Number(offers[0].n), 0);
});

forEachDb(test, 'UI-107: a non-requester cannot cancel (safe 404) and the UI hides the action for them', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 50 })).body.request.id;

  // The contacted pharmacy sees the request as RECIPIENT — no cancel offered.
  const s = ui();
  const asB = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie: await login(h, b.staffEmail) });
  assert.equal(asB.body.viewerRole, 'RECIPIENT');
  assert.equal(s.mreqCanCancel(asB.body.request.status, asB.body.viewerRole === 'REQUESTER'), false);

  // And the server refuses a cancel from the non-requester, safely.
  const bad = await h.request({ method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/cancel`, cookie: await login(h, b.staffEmail), body: {} });
  assert.equal(bad.status, 404, 'a non-requester cancel must be rejected');
  assert.match(bad.contentType, /application\/json/);
  assert.equal(typeof bad.body.error, 'string');
  // The request is untouched.
  assert.equal((await h.db.get('SELECT status FROM medicine_requests WHERE id = ?', [id])).status, 'OPEN');
});

forEachDb(test, 'UI-103: an expired request is reported so the UI can show EXPIRED', async (h) => {
  await setupRequester(h);
  const b = await addTenant(h, 'Pharmacy B', COORDS.near, { stock: 80 });
  const reqCookie = await login(h, 'staff@mediindex.local');
  const adminCookie = await login(h, 'admin@mediindex.local');
  const id = (await createRequest(h, reqCookie, { requestedQuantity: 50 })).body.request.id;

  await h.db.run('UPDATE medicine_requests SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), id]);
  await h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', cookie: adminCookie, body: {} });

  const detail = await h.request({ method: 'GET', url: `/api/inter-pharmacy/medicine-requests/${id}`, cookie: reqCookie });
  assert.equal(detail.body.request.status, 'EXPIRED');

  const s = ui();
  const card = s.mreqMyCard(detail.body.request);
  assert.match(card, /EXPIRED/);
  assert.doesNotMatch(card, /data-mreq-cancel/, 'an expired request offers no cancel action');
  assert.match(s.mreqSearchProgress(detail.body.request, detail.body.offers), /expired — the search has stopped/i);
  assert.equal(s.formatRemaining(detail.body.request.expiresAt), null, 'no countdown for an elapsed request');

  // Offering now must fail, and the UI surfaces a JSON error message.
  const late = await h.request({
    method: 'POST', url: `/api/inter-pharmacy/medicine-requests/${id}/offer`,
    cookie: await login(h, b.staffEmail), body: { offeredQuantity: 10 }
  });
  assert.equal(late.status, 409);
  assert.match(late.contentType, /application\/json/);
  assert.equal(typeof late.body.error, 'string');
});

forEachDb(test, 'UI-104: error responses stay JSON and user-safe for every status the UI handles', async (h) => {
  await setupRequester(h);
  await addTenant(h, 'Pharmacy B', COORDS.near, { stock: 80 });
  const cookie = await login(h, 'staff@mediindex.local');

  const cases = [
    [400, () => createRequest(h, cookie, { requestedQuantity: 0 })],
    [401, () => h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests' })],
    [403, () => h.request({ method: 'POST', url: '/api/inter-pharmacy/medicine-requests/maintenance/expire', cookie, body: {} })],
    [404, () => h.request({ method: 'GET', url: '/api/inter-pharmacy/medicine-requests/999999', cookie })]
  ];
  for (const [expected, call] of cases) {
    const res = await call();
    assert.equal(res.status, expected, `expected ${expected}, got ${res.status}: ${res.raw}`);
    assert.match(res.contentType, /application\/json/, `${expected} must be JSON`);
    assert.equal(typeof res.body.error, 'string', `${expected} must carry a message`);
    assert.doesNotMatch(res.raw, /\bat \/|node:internal/, 'no stack traces');
    assert.doesNotMatch(res.raw, /postgresql:\/\/|password=/i, 'no connection details');
    assert.doesNotMatch(res.raw, /SELECT .* FROM |INSERT INTO /i, 'no SQL');
  }
});

forEachDb(test, 'UI-105: the automatic near-expiry workflow still works alongside the new UI', async (h) => {
  const aPid = await setupRequester(h);
  const adminCookie = await login(h, 'admin@mediindex.local');
  const staffCookie = await login(h, 'staff@mediindex.local');

  const recipient = await addTenant(h, 'NE Recipient', COORDS.mid, { withCatalogue: false });
  await h.db.run('INSERT INTO medicines (pharmacy_id, name, minimum_stock) VALUES (?, ?, ?)', [recipient.pharmacyId, 'Paracetamol', 50]);
  const rMed = await h.db.get('SELECT id FROM medicines WHERE pharmacy_id = ? AND name = ?', [recipient.pharmacyId, 'Paracetamol']);
  await U.addBatch(h, Number(rMed.id), 'R-LOW', 10, 200);
  const aMed = await h.db.get('SELECT id FROM medicines WHERE pharmacy_id = ? AND name = ?', [aPid, 'Paracetamol']);
  await U.addBatch(h, Number(aMed.id), 'NE-15D', 30, 15);

  const before = await inventorySnapshot(h);
  const scan = await h.request({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process', cookie: adminCookie, body: {} });
  assert.equal(scan.status, 200, scan.raw);
  assert.equal(scan.body.nearExpiryDays, 20, 'the 20-day threshold is unchanged');
  assert.equal(scan.body.nearbyRadiusKm, 50, 'the 50 km radius is unchanged');
  assert.equal(scan.body.created, 1);
  assert.equal(scan.body.requests[0].automaticAcceptance, true);

  // The near-expiry history endpoint still works for the existing view.
  const hist = await h.request({ method: 'GET', url: '/api/inter-pharmacy/requests?role=ALL&status=ALL', cookie: adminCookie });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.requests.length, 1);

  // STAFF still cannot run the ADMIN-only scan.
  const denied = await h.request({ method: 'POST', url: '/api/inter-pharmacy/near-expiry/process', cookie: staffCookie, body: {} });
  assert.equal(denied.status, 403);

  // The two workflows remain separate and no inventory moved.
  assert.equal(Number((await h.db.get('SELECT COUNT(*) AS n FROM medicine_requests')).n), 0,
    'the near-expiry scan must not create manual medicine requests');
  const after = await inventorySnapshot(h);
  assert.equal(after.batches, before.batches);
  assert.equal(after.movements, before.movements);
});
