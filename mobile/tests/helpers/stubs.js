'use strict';
/**
 * Test doubles for Phase 7C.
 *
 *  - `createSecureStoreStub()` — an in-memory stand-in for `expo-secure-store`
 *    that records every call, so tests can assert exactly what was written and
 *    can simulate an unavailable or failing keystore.
 *  - `jsonResponse()` / `rawResponse()` — minimal `fetch` Response doubles.
 *  - `captureConsole()` — records everything the logger emits, so tests can
 *    prove a device token never reaches the console.
 */

/** Fake Android Keystore / iOS Keychain. Marked `__esModule` so it is not copied. */
function createSecureStoreStub() {
  const items = new Map();
  const calls = [];
  const state = {
    available: true,
    failRead: false,
    failWrite: false,
    failDelete: false,
    availabilityThrows: false,
  };

  const stub = {
    __esModule: true,
    // Introspection for tests (not part of the real module surface).
    __items: items,
    __calls: calls,
    __state: state,
    __reset() {
      items.clear();
      calls.length = 0;
      state.available = true;
      state.failRead = false;
      state.failWrite = false;
      state.failDelete = false;
      state.availabilityThrows = false;
    },
    /** Every value currently held, for leak assertions. */
    __values() {
      return Array.from(items.values());
    },

    WHEN_UNLOCKED: 'WHEN_UNLOCKED',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',

    async isAvailableAsync() {
      calls.push({ op: 'isAvailableAsync' });
      if (state.availabilityThrows) throw new Error('keystore unavailable');
      return state.available;
    },
    async setItemAsync(key, value, options) {
      calls.push({ op: 'setItemAsync', key, value, options });
      if (state.failWrite) throw new Error('keystore write failed');
      items.set(key, value);
    },
    async getItemAsync(key) {
      calls.push({ op: 'getItemAsync', key });
      if (state.failRead) throw new Error('keystore read failed');
      return items.has(key) ? items.get(key) : null;
    },
    async deleteItemAsync(key) {
      calls.push({ op: 'deleteItemAsync', key });
      if (state.failDelete) throw new Error('keystore delete failed');
      items.delete(key);
    },
    canUseBiometricAuthentication() {
      return false;
    },
  };

  return stub;
}

/** A JSON fetch Response double. */
function jsonResponse(status, body) {
  return rawResponse(status, JSON.stringify(body), 'application/json');
}

/** A Response double with an arbitrary body and content type. */
function rawResponse(status, body, contentType) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    async text() {
      return body;
    },
  };
}

/**
 * Records a scripted sequence of fetch calls.
 * `handler(url, init, callIndex)` returns a Response double, or throws to
 * simulate a transport failure.
 */
function createFetchRecorder(handler) {
  const calls = [];
  const fn = async (url, init) => {
    const index = calls.length;
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined });
    return handler(url, init, index);
  };
  fn.calls = calls;
  return fn;
}

/** Installs a fetch double for the duration of `run()`, then restores. */
async function withFetch(fetchDouble, run) {
  const original = global.fetch;
  global.fetch = fetchDouble;
  try {
    return await run();
  } finally {
    global.fetch = original;
  }
}

/** Captures console output produced while `run()` executes. */
async function captureConsole(run) {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const record = (level) => (...args) => {
    lines.push(
      `${level} ` + args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' '),
    );
  };
  console.log = record('log');
  console.warn = record('warn');
  console.error = record('error');
  try {
    const result = await run();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
}

module.exports = {
  createSecureStoreStub,
  jsonResponse,
  rawResponse,
  createFetchRecorder,
  withFetch,
  captureConsole,
};
