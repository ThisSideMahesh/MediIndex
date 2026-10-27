/**
 * map-loading.test.js
 *
 * Regression tests for the renderRelocateMap() guard condition fix.
 *
 * Root cause (commit 2f24299):
 *   storeMapData is initialised as { shelves: [], ... }.
 *   The old guard `!storeMapData.shelves` evaluates to `false` because []
 *   is truthy in JavaScript, so loadStoreMapView() was never called on first
 *   use and the dialog rendered with no shelf buttons.
 *
 * Fix:
 *   Changed to `!storeMapData.shelves.length` so the guard fires when
 *   shelves is an empty array.
 *
 * Tests here cover:
 *   1. JS guard logic: proves the old condition silently passed an empty array.
 *   2. JS guard logic: proves the fixed condition correctly detects empty.
 *   3. API contract: GET /api/layout/shelves returns all 14 expected shelves —
 *      the data source that renderRelocateMap() loads from must be non-empty.
 *   4. No unnecessary reload: guard does not fire when shelves are already
 *      populated (avoids extra network round-trip on re-open).
 *   5. Integration: layout endpoint is auth-protected (no anonymous access).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler } = require('../core');

// ── Shared callApi helper (mirrors batch-relocation.test.js pattern) ────────

function callApi({ method, url, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method || 'GET';
    req.url = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}) };
    const res = {
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
      end(payload) {
        resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : undefined });
      }
    };
    handler(req, res).catch(reject);
    if (body !== undefined) {
      setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
    }
  });
}

// ── Guard logic tests (pure JS — no DOM or network required) ─────────────────

test('Map loading guard: old condition (!storeMapData.shelves) is false for empty array', () => {
  // This documents the root cause: [] is truthy, so ![] === false.
  // The old guard never fired, so loadStoreMapView() was never called.
  const storeMapData = { shelves: [], unassigned: { batches: [] } };

  const oldGuard = !storeMapData || !storeMapData.shelves;
  assert.equal(oldGuard, false,
    'Old guard must evaluate to false for empty shelves array — this was the bug');

  // Prove the array is truthy (why the old guard failed)
  assert.equal(Boolean(storeMapData.shelves), true,
    'Empty array [] is truthy in JavaScript');
  assert.equal(!storeMapData.shelves, false,
    '![] === false in JavaScript — old guard condition was always skipped');
});

test('Map loading guard: fixed condition (!storeMapData.shelves.length) is true for empty array', () => {
  // The fix: check .length instead of truthiness.
  const storeMapData = { shelves: [], unassigned: { batches: [] } };

  const fixedGuard = !storeMapData || !storeMapData.shelves.length;
  assert.equal(fixedGuard, true,
    'Fixed guard must evaluate to true for empty shelves — triggers loadStoreMapView()');

  assert.equal(storeMapData.shelves.length, 0, 'Empty array has length 0');
  assert.equal(!storeMapData.shelves.length, true, '!0 === true — guard fires correctly');
});

test('Map loading guard: fixed condition does not fire when shelves are already populated', () => {
  // If user visited Store Map tab first, storeMapData.shelves is populated.
  // The guard must NOT fire in that case — no unnecessary reload.
  const storeMapData = {
    shelves: [
      { id: 'Rack A1', rack: 'RACK_A', label: 'A1 - Fast Moving Analgesics', zone: 'Front Left' },
      { id: 'Rack B2', rack: 'RACK_B', label: 'B2 - Cephalosporins', zone: 'Front Right' }
    ],
    unassigned: { batches: [] }
  };

  const fixedGuard = !storeMapData || !storeMapData.shelves.length;
  assert.equal(fixedGuard, false,
    'Fixed guard must not fire when shelves are already loaded — avoids unnecessary reload');

  assert.equal(storeMapData.shelves.length, 2);
  assert.equal(!storeMapData.shelves.length, false, 'Non-empty length is truthy — !truthy === false');
});

// ── API contract tests (integration against real server handler) ─────────────

test('Map loading: GET /api/layout/shelves returns all 14 expected shelf IDs', async () => {
  // This proves the data source that renderRelocateMap() calls loadStoreMapView()
  // to fetch is non-empty and returns the correct authoritative shelf list.
  const login = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = login.headers['Set-Cookie'];
  assert.equal(login.status, 200, 'Login must succeed');

  const mapRes = await callApi({
    method: 'GET',
    url: '/api/layout/shelves',
    cookie
  });

  assert.equal(mapRes.status, 200);
  assert.ok(Array.isArray(mapRes.body.shelves), 'shelves must be an array');
  assert.equal(mapRes.body.shelves.length, 14,
    'Must return all 14 shelves from STANDARD_SHELVES');
  assert.equal(mapRes.body.shelves.length > 0, true,
    'Shelves must be non-empty — the fixed guard would NOT fire after this loads');

  // Verify shelf IDs match STANDARD_SHELVES exactly
  const expectedIds = [
    'Rack A1', 'Rack A2', 'Rack A3',
    'Rack B1', 'Rack B2', 'Rack B3',
    'Rack C1', 'Rack C2', 'Rack C3',
    'Rack D1', 'Rack D2', 'Rack D3',
    'Cold Storage F1', 'Cold Storage F2'
  ];
  const returnedIds = mapRes.body.shelves.map(s => s.id);
  assert.deepEqual(returnedIds, expectedIds,
    'Returned shelf IDs must match STANDARD_SHELVES exactly');

  // Each shelf must have the fields renderRelocateMap() reads: id, rack, label
  for (const shelf of mapRes.body.shelves) {
    assert.ok(shelf.id, `Shelf must have id field: ${JSON.stringify(shelf)}`);
    assert.ok(shelf.rack, `Shelf must have rack field for grouping: ${shelf.id}`);
    assert.ok(shelf.label, `Shelf must have label field for tooltip: ${shelf.id}`);
  }
});

test('Map loading: GET /api/layout/shelves requires authentication', async () => {
  // Confirms the auth guard on the layout endpoint is intact after the fix.
  const res = await callApi({
    method: 'GET',
    url: '/api/layout/shelves'
    // no cookie
  });
  assert.equal(res.status, 401,
    'Unauthenticated request to layout endpoint must return 401');
});

// ── renderRelocateMap() DOM behaviour tests (jsdom — no real browser required) ─
//
// These tests drive the REAL renderRelocateMap() function body, extracted
// from public/app.js at test runtime using a source-code parser. They do not
// maintain a separate copy; if the live function changes, the tests
// automatically test the changed version.
//
// Extraction method:
//   1. Read public/app.js source at test startup.
//   2. Walk braces from the function signature to find its exact body.
//   3. The function references five module-level names: document, storeMapData,
//      relocateBatchState, escapeHtml, and loadStoreMapView. These are
//      module globals in the browser but are injected as function parameters
//      here so the body can run in Node.js without a full module load.
//   4. new Function('...params', body) creates a callable from the live source.
//   5. storeMapData is wrapped in a { current } ref-box so that mutations
//      made by the loadStoreMapView stub are visible inside the running body,
//      mirroring the module-level variable assignment in the real app.
//
// KNOWN LIMITATION: app.js calls document.querySelector at module evaluation
// time (top-level code), so it cannot be require()'d in Node.js. The
// extraction approach above tests the real guard and rendering logic without
// needing a full module load. What remains untested without a real browser:
//   - That click handlers on shelf buttons call selectRelocateShelf in the
//     live page after the dialog opens.
//   - That openDialog() correctly calls showModal() and the dialog becomes
//     visible.
//   (Both require a real browser or an e2e tool like Playwright.)

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// ── Runtime extraction of renderRelocateMap from the live public/app.js ─────

const appJsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'app.js'),
  'utf8'
);

// Extract the function body by walking matching braces from the signature.
function extractFunctionBody(src, funcSignature) {
  const idx = src.indexOf(funcSignature);
  if (idx === -1) throw new Error(`Function not found: ${funcSignature}`);
  let depth = 0, i = idx, bodyStart = -1, bodyEnd = -1;
  while (i < src.length) {
    if (src[i] === '{') { if (depth === 0) bodyStart = i + 1; depth++; }
    else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
    i++;
  }
  if (bodyEnd === -1) throw new Error('Could not find matching closing brace');
  return src.slice(bodyStart, bodyEnd);
}

const renderRelocateMapBody = extractFunctionBody(appJsSrc, 'async function renderRelocateMap()');

// Verify the fixed guard is present in the extracted body before running tests.
// This ensures we are testing the patched version, not a stale read.
if (!renderRelocateMapBody.includes('storeMapData.shelves.length')) {
  throw new Error(
    'EXTRACTED BODY DOES NOT CONTAIN THE FIX: expected "storeMapData.shelves.length" ' +
    'in renderRelocateMap. The fix may not have been applied to public/app.js.'
  );
}
if (renderRelocateMapBody.includes('!storeMapData.shelves)')) {
  throw new Error(
    'EXTRACTED BODY STILL CONTAINS THE BUG: found "!storeMapData.shelves)" ' +
    'in renderRelocateMap. The old guard is still present in public/app.js.'
  );
}

// Build a callable async function from the live body.
// Parameters replace the five module-global names the function references.
// storeMapData_ref is a { current } wrapper: the body accesses
// storeMapData_ref.current everywhere storeMapData appears in the original.
const patchedBody = renderRelocateMapBody
  .replace(/\bstoreMapData\b/g, 'storeMapData_ref.current');

// AsyncFunction constructor — same as new Function but returns a Promise.
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const renderRelocateMap_live = new AsyncFunction(
  'document',
  'storeMapData_ref',
  'relocateBatchState',
  'escapeHtml',
  'loadStoreMapView',
  patchedBody
);

// ── Shared helpers ───────────────────────────────────────────────────────────

function makeDOM() {
  return new JSDOM(`<!DOCTYPE html>
    <div id="relocate-map-grid"></div>
    <p id="relocate-new-location"></p>
    <button id="relocate-save-btn" disabled></button>
  `);
}

// escapeHtml is also extracted live from public/app.js so both the test and
// the function under test use identical implementations.
function extractFunctionFull(src, funcSignature) {
  const idx = src.indexOf(funcSignature);
  if (idx === -1) throw new Error(`Function not found: ${funcSignature}`);
  let depth = 0, i = idx, bodyEnd = -1;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
    i++;
  }
  return src.slice(idx, bodyEnd + 1);
}

const escapeHtmlFull = extractFunctionFull(appJsSrc, 'function escapeHtml(');
// Strip the function wrapper to get just the body for new Function.
const escapeHtmlBody = extractFunctionBody(appJsSrc, 'function escapeHtml(');
const escapeHtml = new Function('value', escapeHtmlBody);

// Representative subset of STANDARD_SHELVES used by loadStoreMapView stub.
const STUB_SHELVES = [
  { id: 'Rack A1', rack: 'RACK_A', label: 'A1 - Fast Moving Analgesics', zone: 'Front Left' },
  { id: 'Rack A2', rack: 'RACK_A', label: 'A2 - Pain & Anti-inflammatory', zone: 'Front Left' },
  { id: 'Rack B1', rack: 'RACK_B', label: 'B1 - Broad Spectrum Antibiotics', zone: 'Front Right' },
  { id: 'Cold Storage F1', rack: 'RACK_COLD', label: 'Cold Bay F1 - Insulins', zone: 'Cold Refrigerator' }
];

test('renderRelocateMap (jsdom): empty storeMapData.shelves triggers loadStoreMapView and renders shelf buttons', async () => {
  const dom = makeDOM();
  const { document } = dom.window;

  // Start with empty shelves — the bug state.
  const storeMapData_ref = { current: { shelves: [], unassigned: { batches: [] } } };

  let loadCalled = 0;
  async function loadStoreMapView() {
    loadCalled++;
    // Simulate what the real loadStoreMapView() does: populate storeMapData.
    storeMapData_ref.current = { shelves: STUB_SHELVES, unassigned: { batches: [] } };
  }

  const relocateBatchState = { currentLocation: 'No shelf assigned' };

  await renderRelocateMap_live(document, storeMapData_ref, relocateBatchState, escapeHtml, loadStoreMapView);

  // Guard must have fired.
  assert.equal(loadCalled, 1, 'loadStoreMapView() must be called exactly once when shelves is empty');

  // Shelf buttons must be rendered.
  const buttons = document.querySelectorAll('[data-relocate-shelf]');
  assert.equal(buttons.length, STUB_SHELVES.length,
    `Must render one button per shelf (${STUB_SHELVES.length} expected, got ${buttons.length})`);

  // Button data attributes match shelf IDs exactly.
  const renderedIds = Array.from(buttons).map(b => b.dataset.relocateShelf);
  const expectedIds = STUB_SHELVES.map(s => s.id);
  assert.deepEqual(renderedIds, expectedIds, 'data-relocate-shelf values must match shelf IDs');

  // Rack grouping is correct — RACK_A buttons are inside RACK_A card.
  const rackACard = document.querySelector('[data-rack="RACK_A"]');
  assert.ok(rackACard, 'RACK_A card must be rendered');
  const rackAButtons = rackACard.querySelectorAll('[data-relocate-shelf]');
  const rackAShelfIds = STUB_SHELVES.filter(s => s.rack === 'RACK_A').map(s => s.id);
  assert.equal(rackAButtons.length, rackAShelfIds.length,
    'Rack A card must contain exactly the Rack A shelves');
});

test('renderRelocateMap (jsdom): populated storeMapData.shelves does NOT call loadStoreMapView', async () => {
  const dom = makeDOM();
  const { document } = dom.window;

  // Already populated — user visited Store Map tab first.
  const storeMapData_ref = { current: { shelves: STUB_SHELVES, unassigned: { batches: [] } } };

  let loadCalled = 0;
  async function loadStoreMapView() {
    loadCalled++;
  }

  const relocateBatchState = { currentLocation: 'No shelf assigned' };

  await renderRelocateMap_live(document, storeMapData_ref, relocateBatchState, escapeHtml, loadStoreMapView);

  assert.equal(loadCalled, 0,
    'loadStoreMapView() must NOT be called when shelves are already loaded');

  const buttons = document.querySelectorAll('[data-relocate-shelf]');
  assert.equal(buttons.length, STUB_SHELVES.length,
    'Shelf buttons must still render from pre-loaded data');
});

test('renderRelocateMap (jsdom): null storeMapData triggers loadStoreMapView safely', async () => {
  const dom = makeDOM();
  const { document } = dom.window;

  // Defensive: storeMapData itself is null (edge case — should not happen in
  // normal flow but the guard covers it).
  const storeMapData_ref = { current: null };

  let loadCalled = 0;
  async function loadStoreMapView() {
    loadCalled++;
    storeMapData_ref.current = { shelves: STUB_SHELVES, unassigned: { batches: [] } };
  }

  const relocateBatchState = { currentLocation: 'No shelf assigned' };

  await renderRelocateMap_live(document, storeMapData_ref, relocateBatchState, escapeHtml, loadStoreMapView);

  assert.equal(loadCalled, 1, 'loadStoreMapView() must be called when storeMapData is null');
  const buttons = document.querySelectorAll('[data-relocate-shelf]');
  assert.equal(buttons.length, STUB_SHELVES.length,
    'Shelf buttons must render after loadStoreMapView populates the data');
});

test('renderRelocateMap (jsdom): current location batch is highlighted as current-location', async () => {
  const dom = makeDOM();
  const { document } = dom.window;

  const storeMapData_ref = { current: { shelves: STUB_SHELVES, unassigned: { batches: [] } } };
  let loadCalled = 0;
  async function loadStoreMapView() { loadCalled++; }

  // Batch is currently on Rack A1.
  const relocateBatchState = { currentLocation: 'Rack A1' };

  await renderRelocateMap_live(document, storeMapData_ref, relocateBatchState, escapeHtml, loadStoreMapView);

  assert.equal(loadCalled, 0, 'No reload needed — shelves already populated');

  const rackA1Btn = document.querySelector('[data-relocate-shelf="Rack A1"]');
  assert.ok(rackA1Btn, 'Rack A1 button must exist');
  assert.ok(rackA1Btn.classList.contains('current-location'),
    'Rack A1 button must have current-location class when batch is on Rack A1');

  const rackA2Btn = document.querySelector('[data-relocate-shelf="Rack A2"]');
  assert.ok(rackA2Btn, 'Rack A2 button must exist');
  assert.equal(rackA2Btn.classList.contains('current-location'), false,
    'Rack A2 button must NOT have current-location class');
});
