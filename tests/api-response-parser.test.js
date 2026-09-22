'use strict';
/**
 * tests/api-response-parser.test.js
 *
 * Focused unit tests for the frontend api() response parser in public/app.js.
 *
 * public/app.js is a browser script (uses document.querySelector, fetch, etc.)
 * and is never require()'d directly. To test the api() helper against real
 * production source (not a re-implementation), we extract its exact function
 * source via a regex anchored on its declaration and execute it inside a
 * node:vm sandbox with a mocked global fetch. This exercises the actual
 * shipped code, catching the "Unexpected token 'A', "A server e"..." defect
 * class: response.json() being called unconditionally on non-JSON bodies.
 *
 * No new dependency is introduced — node:vm and node:fs are built-in.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const APP_JS_PATH = path.join(__dirname, '..', 'public', 'app.js');
const appJsSource = fs.readFileSync(APP_JS_PATH, 'utf8');

// Extract the exact api() function source from the real file.
const apiFnMatch = appJsSource.match(/async function api\(path, options\) \{[\s\S]*?\n\}/);
if (!apiFnMatch) {
  throw new Error('Could not locate api() function in public/app.js — test extraction pattern is stale.');
}
const apiFnSource = apiFnMatch[0];

/**
 * Builds a minimal Response-like mock object matching the subset of the
 * Fetch API's Response interface that api() actually uses:
 *   .ok, .status, .text(), .headers.get('content-type')
 */
function mockResponse({ status, body, contentType }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

/**
 * Runs the real api() function (extracted from public/app.js) inside an
 * isolated VM context with `fetch` mocked to return the given response.
 *
 * The VM context is a separate JS realm, so its Error/Object constructors are
 * not reference-identical to the outer realm's (vm's Error !== node:test's
 * Error). To keep assertions realm-safe, the script serializes the outcome
 * to a plain descriptor ({ ok, value } or { ok:false, message }) using only
 * primitives, which round-trips cleanly across the realm boundary.
 */
async function runApi(mockedResponse) {
  const context = { fetch: async () => mockedResponse, __outcome: undefined };
  vm.createContext(context);
  const script = new vm.Script(`
    ${apiFnSource}
    api('/api/whatever', {})
      .then(value => { __outcome = { ok: true, value }; })
      .catch(err => { __outcome = { ok: false, message: err && err.message }; });
  `);
  script.runInContext(context);
  // Flush the microtask queue so the async function inside the VM resolves.
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  return context.__outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUCCESS CASES
// ─────────────────────────────────────────────────────────────────────────────

test('API-PARSE-001: valid JSON 200 response resolves with parsed data', async () => {
  const outcome = await runApi(mockResponse({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ user: { email: 'admin@mediindex.local' } }),
  }));
  assert.equal(outcome.ok, true, `Expected success, got error: ${outcome.message}`);
  // outcome.value crossed the vm realm boundary as a plain object; compare via
  // JSON serialization to avoid realm-sensitive prototype/reference checks.
  assert.equal(JSON.stringify(outcome.value), JSON.stringify({ user: { email: 'admin@mediindex.local' } }));
});

test('API-PARSE-002: valid JSON 201 response resolves with parsed data', async () => {
  const outcome = await runApi(mockResponse({
    status: 201,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ medicine: { id: 42, name: 'Paracetamol' } }),
  }));
  assert.equal(outcome.ok, true);
  assert.equal(JSON.stringify(outcome.value), JSON.stringify({ medicine: { id: 42, name: 'Paracetamol' } }));
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON ERROR CASES — server-provided {error} message must be preserved
// ─────────────────────────────────────────────────────────────────────────────

test('API-PARSE-003: JSON 400 with {error} preserves the server message', async () => {
  const outcome = await runApi(mockResponse({
    status: 400,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: 'Quantity must be a positive whole number.' }),
  }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, 'Quantity must be a positive whole number.');
});

test('API-PARSE-004: JSON 401 without {error} uses the session-expired message', async () => {
  const outcome = await runApi(mockResponse({
    status: 401,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({}),
  }));
  assert.equal(outcome.message, 'Your session has expired. Please sign in again.');
});

test('API-PARSE-005: JSON 401 WITH {error} still prefers the server message', async () => {
  const outcome = await runApi(mockResponse({
    status: 401,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: 'Authentication required.' }),
  }));
  assert.equal(outcome.message, 'Authentication required.');
});

test('API-PARSE-006: JSON 403 without {error} uses the permission message', async () => {
  const outcome = await runApi(mockResponse({
    status: 403,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({}),
  }));
  assert.equal(outcome.message, 'You do not have permission for this action.');
});

test('API-PARSE-007: JSON 404 without {error} uses the not-found message', async () => {
  const outcome = await runApi(mockResponse({
    status: 404,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({}),
  }));
  assert.equal(outcome.message, 'The requested resource was not found.');
});

test('API-PARSE-008: JSON 500 without {error} uses the server-unavailable message', async () => {
  const outcome = await runApi(mockResponse({
    status: 500,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({}),
  }));
  assert.equal(outcome.message, 'The server is temporarily unavailable. Please try again.');
});

test('API-PARSE-009: JSON 503 (>=500) uses the server-unavailable message', async () => {
  const outcome = await runApi(mockResponse({
    status: 503,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ status: 'error', database: 'unavailable' }),
  }));
  assert.equal(outcome.message, 'The server is temporarily unavailable. Please try again.');
});

// ─────────────────────────────────────────────────────────────────────────────
// NON-JSON RESPONSES — must never leak raw HTML/text or throw a parse error
// ─────────────────────────────────────────────────────────────────────────────

test('API-PARSE-010: non-JSON 500 (plain text) never throws a JSON.parse error', async () => {
  const outcome = await runApi(mockResponse({
    status: 500,
    contentType: 'text/plain',
    body: 'A server error has occurred',
  }));
  assert.equal(outcome.ok, false);
  // Must NOT be the raw "Unexpected token..." parse failure
  assert.doesNotMatch(outcome.message, /Unexpected token/i);
  assert.doesNotMatch(outcome.message, /JSON/i);
  // Must be the clear, generic 500 message
  assert.equal(outcome.message, 'The server is temporarily unavailable. Please try again.');
});

test('API-PARSE-011: non-JSON response (HTML error page) never leaks raw HTML', async () => {
  const outcome = await runApi(mockResponse({
    status: 500,
    contentType: 'text/html; charset=utf-8',
    body: '<html><body><h1>500: INTERNAL_SERVER_ERROR</h1><p>Vercel</p></body></html>',
  }));
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(outcome.message, /<html>/i);
  assert.doesNotMatch(outcome.message, /Vercel/i);
  assert.doesNotMatch(outcome.message, /Unexpected token/i);
  assert.equal(outcome.message, 'The server is temporarily unavailable. Please try again.');
});

test('API-PARSE-012: non-JSON 200 success response fails clearly instead of returning HTML as data', async () => {
  // e.g. an auth gateway (Vercel SSO) intercepting with a 200 HTML login page
  const outcome = await runApi(mockResponse({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<html><body>Redirecting to SSO...</body></html>',
  }));
  assert.equal(outcome.ok, false, 'Must not resolve with raw HTML as the data payload');
  assert.doesNotMatch(outcome.message, /<html>/i);
  assert.equal(outcome.message, 'The server returned an unexpected response.');
});

test('API-PARSE-013: non-JSON 404 (plain text "Not Found") uses the clear 404 message', async () => {
  const outcome = await runApi(mockResponse({
    status: 404,
    contentType: 'text/plain',
    body: 'Not Found',
  }));
  assert.equal(outcome.message, 'The requested resource was not found.');
});

test('API-PARSE-014: malformed JSON body (invalid syntax) with JSON content-type falls back safely', async () => {
  const outcome = await runApi(mockResponse({
    status: 500,
    contentType: 'application/json',
    body: '{not valid json',
  }));
  assert.equal(outcome.ok, false);
  assert.doesNotMatch(outcome.message, /Unexpected token/i);
  assert.equal(outcome.message, 'The server is temporarily unavailable. Please try again.');
});

test('API-PARSE-015: empty body with 204-like success and JSON content-type does not crash', async () => {
  const outcome = await runApi(mockResponse({
    status: 200,
    contentType: 'application/json',
    body: '',
  }));
  // Empty body cannot be parsed as JSON even though content-type claims JSON —
  // must fail clearly rather than throwing an uncaught parse exception.
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, 'The server returned an unexpected response.');
});

test('API-PARSE-016: unrecognized 4xx status without {error} still produces a clear generic message', async () => {
  const outcome = await runApi(mockResponse({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({}),
  }));
  assert.equal(outcome.message, 'Request failed (HTTP 409).');
});
