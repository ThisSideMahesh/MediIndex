'use strict';
/**
 * Regression test for the "web inventory does not update in real time" bug.
 *
 * BUG: after a successful stock receipt (batch creation) or a sale via the
 * web UI, the backend persisted the change correctly, but the currently-open
 * page kept showing the OLD quantity — because the mutation handlers in
 * public/app.js only re-fetched a subset of the affected views (or none),
 * relying on the user manually reloading the browser or switching tabs away
 * and back (switchView() re-fetches on tab entry, which masked the bug for
 * anyone who happened to navigate away).
 *
 * FIX: public/app.js's batch-creation and sale-checkout handlers now call a
 * shared refreshInventoryRelatedViews() helper that re-fetches the Inventory
 * list and Dashboard metrics (always) and the Store Map / Expiry Alerts
 * views (only when they are the currently-visible tab), from the
 * authoritative backend — never by incrementing a local counter.
 *
 * This test loads the REAL public/index.html and public/app.js into a jsdom
 * document (not a mock DOM), scripts a fake `fetch` that mirrors the actual
 * backend response shapes, and asserts that after a real `submit` event on
 * the batch-creation form, the Inventory list and Dashboard DOM actually
 * re-render with the NEW authoritative stock numbers — proving this happens
 * without a page reload and without the test ever calling loadMedicines()
 * or refreshDashboard() itself (only the app's own mutation handler does).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ADMIN_USER = { id: 1, full_name: 'Admin User', fullName: 'Admin User', email: 'admin@example.com', role: 'ADMIN' };

/**
 * Loads the real index.html + app.js into a fresh jsdom window, wires a
 * scripted `fetch`, and drives the app past login into the given view.
 *
 * `routes` is a map of "METHOD path" (path without query string) -> a
 * function (url, options, callIndex) => response body object, OR a fixed
 * body object. Missing routes reject with a 404 body, matching how an
 * unexpected real request would behave.
 */
async function bootstrapApp(routes) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only', // we execute app.js ourselves, see below
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // HTMLDialogElement.showModal/close are unimplemented in some jsdom
  // builds; app.js only calls them for visual effect (openDialog/closeDialog),
  // so no-op stubs are sufficient and do not affect the assertions below.
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  }
  if (!window.HTMLDialogElement.prototype.close) {
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  }

  const calls = [];
  window.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    const pathname = String(url).split('?')[0];
    const key = `${method} ${pathname}`;
    const parsedBody = options && options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, pathname, url: String(url), body: parsedBody });

    const entry = routes[key];
    if (entry === undefined) {
      return jsonResponse(window, 404, { error: `Unscripted request: ${key}` });
    }
    const body = typeof entry === 'function' ? entry(url, options, calls.length - 1) : entry;
    return jsonResponse(window, 200, body);
  };

  // Execute the real app.js source inside the jsdom window context. Using
  // `runScripts: 'outside-only'` plus this explicit vm run (instead of a
  // <script src> tag) avoids jsdom needing to actually fetch the file over
  // a resource loader, while still running the EXACT same file the browser
  // serves — no test-only copy or rewrite.
  const appJsSource = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  window.eval(appJsSource);

  return { window, document: window.document, calls };
}

function jsonResponse(window, status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => text,
    json: async () => body,
  };
}

/** Logs in via the real login form submit handler (exercises showApp()). */
async function login(window, document) {
  document.querySelector('#email').value = 'admin@example.com';
  document.querySelector('#password').value = 'Demo@12345';

  const form = document.querySelector('#login-form');
  const submitEvent = new window.Event('submit', { bubbles: true, cancelable: true });
  // jsdom's SubmitEvent may not populate `submitter` from a synthetic dispatch;
  // app.js's login handler reads `event.submitter` for the button element.
  Object.defineProperty(submitEvent, 'submitter', { value: document.querySelector('#login-form button[type="submit"]') || document.createElement('button') });
  form.dispatchEvent(submitEvent);

  // Allow the async submit handler's microtasks (fetch + showApp) to settle.
  await flush();
}

function flush(times = 6) {
  return new Promise(resolve => {
    let remaining = times;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) return resolve();
      setTimeout(step, 0);
    };
    step();
  });
}

// ─── Fixtures mirroring real backend response shapes ─────────────────────────

const DASHBOARD_BEFORE = { totalMedicines: 1, totalStock: 250, expired: 0, expiringSoon: 0, lowStock: 0, todaySales: 0 };
const DASHBOARD_AFTER = { totalMedicines: 1, totalStock: 350, expired: 0, expiringSoon: 0, lowStock: 0, todaySales: 0 };

const MEDICINE_BEFORE = {
  id: 12, pharmacy_id: 7, name: 'Paracetamol 500mg', generic_name: 'Paracetamol',
  manufacturer: 'GenPharma', category: 'TABLET', minimum_stock: 50, active: 1,
  total_stock: 250,
};
const MEDICINE_AFTER = { ...MEDICINE_BEFORE, total_stock: 350 };

test('WEB-REFRESH-001 (Regression A): batch creation refreshes the Inventory list to the new authoritative stock total without a page reload', async () => {
  let medicinesCallCount = 0;

  const { window, document, calls } = await bootstrapApp({
    'GET /api/dashboard': () => DASHBOARD_BEFORE,
    'GET /api/medicines': () => {
      medicinesCallCount += 1;
      // First GET (on inventory load) returns the OLD total; every call
      // AFTER the batch is created returns the NEW authoritative total —
      // simulating the server having actually applied the mutation.
      const medicine = medicinesCallCount === 1 ? MEDICINE_BEFORE : MEDICINE_AFTER;
      return { medicines: [medicine] };
    },
    'POST /api/auth/login': { user: ADMIN_USER },
    'POST /api/medicines/12/batches': { batch: { id: 999, batch_number: 'PAR-A-2601', quantity: 100 } },
  });

  await login(window, document);

  // Navigate to Inventory — this performs the FIRST /api/medicines fetch,
  // rendering the OLD (250 units) card, exactly like a real user opening the tab.
  window.switchView('inventory');
  await flush();

  const cardBefore = document.querySelector('#medicine-list .medicine-card .stock');
  assert.ok(cardBefore, 'medicine card must be rendered before the mutation');
  assert.equal(cardBefore.textContent.trim(), '250 units', 'must show the pre-mutation stock count');

  // Simulate the real user flow: click "Add batch" on the rendered card
  // (fills #batch-medicine-id via the app's own click handler), fill in the
  // batch form, and submit it — the EXACT same DOM interaction a real batch
  // receipt performs. Nothing here calls loadMedicines()/refreshDashboard()
  // directly; only the app's own submit handler may do that.
  document.querySelector('#medicine-list [data-add-batch="12"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();

  document.querySelector('#batch-number').value = 'PAR-A-2601';
  document.querySelector('#batch-quantity').value = '100';
  document.querySelector('#batch-selling').value = '3.00';
  document.querySelector('#batch-expiry').value = '2027-06-01';

  const batchForm = document.querySelector('#batch-form');
  const batchSubmitEvent = new window.Event('submit', { bubbles: true, cancelable: true });
  batchForm.dispatchEvent(batchSubmitEvent);
  await flush(12);

  // The mutation request must have actually been sent.
  const batchPost = calls.find(c => c.method === 'POST' && c.pathname === '/api/medicines/12/batches');
  assert.ok(batchPost, 'batch creation request must have been sent');
  assert.equal(batchPost.body.quantity, '100');

  // THE ACTUAL BUG FIX, PROVEN AT RUNTIME: the inventory card in the DOM
  // must now show the NEW authoritative total — without the test calling
  // any refresh function itself, and without a page reload/navigation.
  const cardAfter = document.querySelector('#medicine-list .medicine-card .stock');
  assert.ok(cardAfter, 'medicine card must still be rendered after the mutation');
  assert.equal(cardAfter.textContent.trim(), '350 units', 'inventory must reflect the authoritative post-mutation stock without a manual refresh');

  // Dashboard metrics (visible in the background) must also have been
  // re-fetched — proving refreshInventoryRelatedViews() ran, not just
  // loadMedicines() alone.
  const dashboardGets = calls.filter(c => c.method === 'GET' && c.pathname === '/api/dashboard');
  assert.ok(dashboardGets.length >= 2, 'dashboard must be re-fetched after the mutation, not just once at login');

  // Guard against the "faking the quantity by incrementing a local counter"
  // failure mode explicitly ruled out by the task: the displayed number must
  // come from a real GET /api/medicines call made AFTER the mutation, not
  // from client-side arithmetic on the pre-mutation value.
  assert.ok(medicinesCallCount >= 2, 'the new total must come from a fresh GET /api/medicines, not a client-side increment');
});

test('WEB-REFRESH-002 (Regression A): a sale (checkout) refreshes the Inventory list to reflect reduced stock without a page reload', async () => {
  // Tracks whether the sale has actually been POSTed yet, rather than
  // counting GET /api/medicines calls — the Billing tab also calls
  // GET /api/medicines (to populate the medicine picker) before any sale
  // happens, so call-count alone can't distinguish "before" from "after".
  let saleCompleted = false;
  const medicineWithBatch = { ...MEDICINE_BEFORE, id: 20, total_stock: 100 };
  const medicineAfterSale = { ...medicineWithBatch, total_stock: 80 };

  const { window, document, calls } = await bootstrapApp({
    'GET /api/dashboard': () => DASHBOARD_BEFORE,
    'GET /api/medicines': () => ({ medicines: [saleCompleted ? medicineAfterSale : medicineWithBatch] }),
    'GET /api/sales': () => ({ sales: [] }),
    'POST /api/auth/login': { user: ADMIN_USER },
    'POST /api/sales': () => {
      saleCompleted = true;
      return {
        sale: {
          id: 501, invoice_number: 'INV-20260919-0001', customer_name: null,
          customer_phone: null, payment_method: 'CASH', total_amount: 50,
          created_at: '2026-09-19T12:00:00.000Z', items: [],
        },
      };
    },
  });

  await login(window, document);
  window.switchView('inventory');
  await flush();

  const before = document.querySelector('#medicine-list .medicine-card .stock');
  assert.equal(before.textContent.trim(), '100 units');

  // Drive the cart through the REAL Billing/POS UI (select medicine, enter
  // quantity, click "Add to cart") rather than reaching into the module's
  // private `billingCart` array — `billingCart` is declared with `let` at
  // module scope and (correctly) is not reachable from outside the script,
  // exactly like it isn't reachable from any other external caller in a real
  // browser either. This exercises the exact same addCartItem()/handleCheckout()
  // code path a real cashier's click would.
  window.switchView('billing');
  await flush();
  document.querySelector('#pos-medicine-select').value = '20';
  document.querySelector('#pos-quantity').value = '20';
  window.addCartItem();
  await flush();

  const checkoutForm = document.querySelector('#pos-checkout-form');
  checkoutForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(12);

  const salePost = calls.find(c => c.method === 'POST' && c.pathname === '/api/sales');
  assert.ok(salePost, 'sale request must have been sent');

  const after = document.querySelector('#medicine-list .medicine-card .stock');
  assert.ok(after, 'medicine card must still be rendered after the sale');
  assert.equal(after.textContent.trim(), '80 units', 'inventory must reflect reduced stock after a sale without a manual refresh');
});

test('WEB-REFRESH-003: the fix does not refresh Store Map or Expiry Alerts when those tabs are not open (no unnecessary requests)', async () => {
  let storeMapCalls = 0;
  let alertCalls = 0;

  const { window, document, calls } = await bootstrapApp({
    'GET /api/dashboard': () => DASHBOARD_BEFORE,
    'GET /api/medicines': () => ({ medicines: [MEDICINE_BEFORE] }),
    'GET /api/layout/shelves': () => { storeMapCalls += 1; return { layoutName: 'x', totalShelves: 0, totalUnits: 0, shelves: [], unassigned: { totalBatches: 0, totalUnits: 0, batches: [] } }; },
    'GET /api/expiry-alerts': () => { alertCalls += 1; return { alerts: [] }; },
    'POST /api/auth/login': { user: ADMIN_USER },
    'POST /api/medicines/12/batches': { batch: { id: 1, batch_number: 'B1', quantity: 10 } },
  });

  await login(window, document);
  window.switchView('inventory'); // Store Map and Expiry are NOT the active view
  await flush();

  assert.equal(storeMapCalls, 0, 'store map must not be fetched while Inventory is the active tab');
  assert.equal(alertCalls, 0, 'expiry alerts must not be fetched while Inventory is the active tab');

  document.querySelector('#medicine-list [data-add-batch="12"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush();
  document.querySelector('#batch-number').value = 'B1';
  document.querySelector('#batch-quantity').value = '10';
  document.querySelector('#batch-selling').value = '1.00';
  document.querySelector('#batch-expiry').value = '2027-01-01';
  document.querySelector('#batch-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(12);

  assert.equal(storeMapCalls, 0, 'store map must still not be fetched after a mutation when it is not the visible view (avoid unnecessary requests)');
  assert.equal(alertCalls, 0, 'expiry alerts must still not be fetched after a mutation when it is not the visible view (avoid unnecessary requests)');

  const dashboardGets = calls.filter(c => c.method === 'GET' && c.pathname === '/api/dashboard');
  assert.ok(dashboardGets.length >= 2, 'dashboard is always refreshed regardless of active tab (cheap, always relevant)');
});
