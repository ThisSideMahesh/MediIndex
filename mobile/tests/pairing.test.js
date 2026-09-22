'use strict';
/**
 * Phase 7C — device pairing tests.
 *
 * These execute the real TypeScript modules (see helpers/tsLoader.js) against an
 * in-memory `expo-secure-store` double and a scripted `fetch`, so they assert
 * actual behaviour: what gets written to secure storage, what the request body
 * contains, whether a token ever reaches the console.
 *
 * Honest limit: React Native components are still not rendered — that needs a
 * native test renderer, which is Phase 7K. Screen-level guarantees are therefore
 * covered two ways: the decision logic they call is unit-tested directly
 * (startupRoute, devicePairing), and the screen sources are checked statically
 * for the rules that must hold (no raw fetch, no token rendering).
 *
 * Runs under `mobile/tests/` only — the repository-root backend suite is
 * untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTsLoader, MOBILE_ROOT } = require('./helpers/tsLoader');
const {
  createSecureStoreStub,
  jsonResponse,
  rawResponse,
  createFetchRecorder,
  withFetch,
  captureConsole,
} = require('./helpers/stubs');

// React Native injects __DEV__; enable verbose logging so the "nothing secret is
// logged" tests exercise the noisiest possible path.
global.__DEV__ = true;
process.env.EXPO_PUBLIC_MOBILE_API_BASE_URL = 'http://127.0.0.1:59999';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Built by concatenation so no literal credential appears in this file. */
const DEVICE_TOKEN = 'medidev_' + 'a1b2c3d4'.repeat(8);
const OTHER_TOKEN = 'medidev_' + 'f0e1d2c3'.repeat(8);
const PAIRING_CODE = 'MED-' + 'A1B2C3';
const PAIRING_CODE_LOWER = 'med-' + 'a1b2c3';

const PAIRING_SUCCESS_BODY = {
  success: true,
  deviceId: 42,
  deviceName: 'Counter tablet',
  deviceToken: DEVICE_TOKEN,
  pharmacy: { id: 7, name: 'Apollo Andheri', address: '12 Link Road' },
  pairedAt: '2026-09-19T10:00:00.000Z',
};

const VALID_CREDENTIAL = {
  deviceToken: DEVICE_TOKEN,
  deviceId: 42,
  deviceName: 'Counter tablet',
  pharmacyId: 7,
  pharmacyName: 'Apollo Andheri',
  pharmacyAddress: '12 Link Road',
  pairedAt: '2026-09-19T10:00:00.000Z',
};

/** Fresh module registry + keystore double per test, so no state leaks. */
function bootstrap() {
  const secureStoreNative = createSecureStoreStub();
  const loader = createTsLoader({ stubs: { 'expo-secure-store': secureStoreNative } });
  return {
    secureStoreNative,
    store: loader.load('src/storage/secureStore.ts'),
    pairing: loader.load('src/api/devicePairing.ts'),
    client: loader.load('src/api/client.ts'),
    deviceToken: loader.load('src/api/deviceToken.ts'),
    startup: loader.load('src/navigation/startupRoute.ts'),
    logger: loader.load('src/utils/logger.ts'),
    // Same loader instance, so `instanceof ApiError` matches inside the modules.
    errors: loader.load('src/api/errors.ts'),
  };
}

const read = (rel) => fs.readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');

/**
 * Strips block and line comments so a rule is checked against executable code.
 * Documentation legitimately names the things the code must not do (e.g. "never
 * AsyncStorage", "revoke requires an ADMIN session") and must not trip the check.
 */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** All .ts/.tsx/.js/.json files under mobile/, excluding node_modules. */
function sourceFiles() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|json)$/.test(entry.name)) files.push(path.relative(MOBILE_ROOT, full));
    }
  })(MOBILE_ROOT);
  return files;
}

// ═══ Credential store ════════════════════════════════════════════════════════

test('PAIR-001: saveCredential writes the credential to SecureStore only', async () => {
  const { store, secureStoreNative } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  const writes = secureStoreNative.__calls.filter((c) => c.op === 'setItemAsync');
  assert.equal(writes.length, 1, 'exactly one secure write');
  assert.equal(writes[0].key, store.DEVICE_CREDENTIAL_KEY);
  assert.equal(writes[0].key, 'mediindex.device.credential.v1', 'versioned key');
  assert.equal(
    writes[0].options.keychainAccessible,
    secureStoreNative.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    'the credential must not migrate to another device via backup',
  );
  // Availability is confirmed before trusting the keystore.
  assert.ok(secureStoreNative.__calls.some((c) => c.op === 'isAvailableAsync'));
});

test('PAIR-002: getCredential and getDeviceToken read back what was stored', async () => {
  const { store } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  const credential = await store.deviceCredentialStore.getCredential();
  assert.deepEqual(credential, VALID_CREDENTIAL);
  assert.equal(await store.deviceCredentialStore.getDeviceToken(), DEVICE_TOKEN);
});

test('PAIR-003: hasCredential reflects stored state without any network call', async () => {
  const { store } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {}));

  await withFetch(fetchDouble, async () => {
    assert.equal(await store.deviceCredentialStore.hasCredential(), false, 'unpaired initially');
    await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
    assert.equal(await store.deviceCredentialStore.hasCredential(), true, 'paired after save');
  });

  assert.equal(fetchDouble.calls.length, 0, 'paired state must be a purely local check');
});

test('PAIR-004: clearCredential deletes the credential from SecureStore', async () => {
  const { store, secureStoreNative } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  assert.equal(secureStoreNative.__items.size, 1);

  await store.deviceCredentialStore.clearCredential();

  assert.equal(secureStoreNative.__items.size, 0, 'nothing left in secure storage');
  assert.equal(await store.deviceCredentialStore.getCredential(), null);
  assert.equal(await store.deviceCredentialStore.getDeviceToken(), null);
  assert.equal(await store.deviceCredentialStore.hasCredential(), false);
  assert.ok(secureStoreNative.__calls.some((c) => c.op === 'deleteItemAsync'));
});

test('PAIR-005: getIdentity never exposes the device token', async () => {
  const { store } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  const identity = await store.deviceCredentialStore.getIdentity();
  assert.ok(identity, 'identity expected');
  assert.equal('deviceToken' in identity, false, 'identity must not carry the token');
  assert.equal(identity.pharmacyName, 'Apollo Andheri');
  assert.equal(identity.deviceId, 42);
  assert.ok(!JSON.stringify(identity).includes(DEVICE_TOKEN));
});

test('PAIR-006: a pairing code can never be stored as the device credential', async () => {
  const { store, secureStoreNative } = bootstrap();

  await assert.rejects(
    () => store.deviceCredentialStore.saveCredential({ ...VALID_CREDENTIAL, deviceToken: PAIRING_CODE }),
    /not a server-issued device token/i,
  );
  await assert.rejects(
    () => store.deviceCredentialStore.saveCredential({ ...VALID_CREDENTIAL, deviceToken: 'locally-invented' }),
    /not a server-issued device token/i,
  );
  await assert.rejects(
    () => store.deviceCredentialStore.saveCredential({ ...VALID_CREDENTIAL, deviceToken: '' }),
    /incomplete device credential/i,
  );
  assert.equal(secureStoreNative.__items.size, 0, 'nothing was stored');
});

test('PAIR-007: an unreadable stored record is discarded, not reused', async () => {
  const { store, secureStoreNative } = bootstrap();
  secureStoreNative.__items.set(store.DEVICE_CREDENTIAL_KEY, '{not valid json');

  assert.equal(await store.deviceCredentialStore.getCredential(), null);
  assert.equal(secureStoreNative.__items.size, 0, 'the corrupt record is cleared');
});

test('PAIR-008: a record missing required fields is treated as unpaired', async () => {
  const { store, secureStoreNative } = bootstrap();
  secureStoreNative.__items.set(
    store.DEVICE_CREDENTIAL_KEY,
    JSON.stringify({ deviceToken: DEVICE_TOKEN, deviceName: 'x' }),
  );
  assert.equal(await store.deviceCredentialStore.getCredential(), null);
});

test('PAIR-009: pairing is refused when secure storage is unavailable', async () => {
  const { store, secureStoreNative } = bootstrap();
  secureStoreNative.__state.available = false;

  await assert.rejects(
    () => store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL),
    (err) => err.name === 'SecureStorageUnavailableError',
  );
  assert.equal(secureStoreNative.__items.size, 0, 'no insecure fallback write');
});

// ═══ Pairing request ═════════════════════════════════════════════════════════

test('PAIR-010: pairDevice posts the documented body to the existing endpoint', async () => {
  const { pairing } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(201, PAIRING_SUCCESS_BODY));

  await withFetch(fetchDouble, () =>
    pairing.pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet', deviceModel: 'android 34' }));

  assert.equal(fetchDouble.calls.length, 1);
  const [call] = fetchDouble.calls;
  assert.match(call.url, /\/api\/mobile\/pairing\/complete$/, 'must use the existing endpoint');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.body, {
    pairingCode: PAIRING_CODE,
    deviceName: 'Counter tablet',
    deviceModel: 'android 34',
  });
  // The server derives the pharmacy from the pairing code.
  assert.equal('pharmacyId' in call.body, false);
  assert.equal('pharmacy_id' in call.body, false);
  // There is no device token yet, so no device auth header may be sent.
  assert.equal(call.init.headers['X-Device-Token'], undefined);
});

test('PAIR-011: the pairing code is normalised before it is sent', async () => {
  const { pairing } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(201, PAIRING_SUCCESS_BODY));

  await withFetch(fetchDouble, () =>
    pairing.pairDevice({ pairingCode: `  ${PAIRING_CODE_LOWER} `, deviceName: ' Counter tablet ' }));

  assert.equal(fetchDouble.calls[0].body.pairingCode, PAIRING_CODE, 'upper-cased, whitespace stripped');
  assert.equal(fetchDouble.calls[0].body.deviceName, 'Counter tablet', 'name trimmed');
});

test('PAIR-012: a successful pairing stores the server-issued device credential', async () => {
  const { pairing, store, secureStoreNative } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(201, PAIRING_SUCCESS_BODY));

  await withFetch(fetchDouble, () =>
    pairing.pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' }));

  const stored = JSON.parse(secureStoreNative.__items.get(store.DEVICE_CREDENTIAL_KEY));
  assert.equal(stored.deviceToken, DEVICE_TOKEN, 'exactly the token the server issued');
  assert.equal(stored.deviceId, 42);
  assert.equal(stored.pharmacyId, 7);
  assert.equal(stored.pharmacyName, 'Apollo Andheri');
  assert.equal(await store.deviceCredentialStore.getDeviceToken(), DEVICE_TOKEN);
});

test('PAIR-013: the pairing code is never persisted as the device credential', async () => {
  const { pairing, secureStoreNative } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(201, PAIRING_SUCCESS_BODY));

  await withFetch(fetchDouble, () =>
    pairing.pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' }));

  for (const value of secureStoreNative.__values()) {
    assert.ok(!value.includes(PAIRING_CODE), 'the pairing code must not reach secure storage');
    assert.ok(!value.toUpperCase().includes('MED-'), 'no pairing-code shaped value stored');
  }
  // And the token is not derived from the code in any way.
  const stored = JSON.parse(secureStoreNative.__values()[0]);
  assert.ok(!stored.deviceToken.includes('A1B2C3'));
});

test('PAIR-014: pairDevice returns non-secret identity only', async () => {
  const { pairing } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(201, PAIRING_SUCCESS_BODY));

  const identity = await withFetch(fetchDouble, () =>
    pairing.pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' }));

  assert.equal('deviceToken' in identity, false, 'the screen must never receive the token');
  assert.ok(!JSON.stringify(identity).includes(DEVICE_TOKEN));
  assert.equal(identity.pharmacyName, 'Apollo Andheri');
  assert.equal(identity.deviceId, 42);
});

// ═══ Pairing failures ════════════════════════════════════════════════════════

const SERVER_REJECTIONS = [
  ['Invalid or unrecognized pairing code.', 'PAIRING_CODE_INVALID'],
  ['This pairing code has already been used.', 'PAIRING_CODE_USED'],
  ['This pairing code has expired.', 'PAIRING_CODE_EXPIRED'],
  ['This pairing code has already been claimed.', 'PAIRING_CODE_CLAIMED'],
];

for (const [serverMessage, expectedCode] of SERVER_REJECTIONS) {
  test(`PAIR-020 [${expectedCode}]: a 400 rejection stores nothing and explains itself`, async () => {
    const { pairing, secureStoreNative } = bootstrap();
    const fetchDouble = createFetchRecorder(() => jsonResponse(400, { error: serverMessage }));

    await withFetch(fetchDouble, async () => {
      const err = await pairing
        .pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' })
        .then(() => null, (e) => e);

      assert.ok(err, 'pairing must reject');
      assert.equal(err.name, 'PairingError');
      assert.equal(err.code, expectedCode);
      assert.equal(err.needsNewCode, true, 'the user needs a fresh code');
      assert.notEqual(err.message, serverMessage, 'copy must be rewritten for the user');
      assert.ok(err.message.length > 20, 'the message must actually explain the next step');
    });

    assert.equal(secureStoreNative.__items.size, 0, 'a failed pairing must store nothing');
  });
}

test('PAIR-021: a network failure stores nothing and is marked retryable', async () => {
  const { pairing, secureStoreNative } = bootstrap();
  const fetchDouble = createFetchRecorder(() => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
  });

  await withFetch(fetchDouble, async () => {
    const err = await pairing
      .pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' })
      .then(() => null, (e) => e);
    assert.equal(err.code, 'NETWORK');
    assert.equal(err.retryable, true);
    assert.equal(err.needsNewCode, false, 'the code is unspent — the request never landed');
  });

  assert.equal(secureStoreNative.__items.size, 0);
});

test('PAIR-022: a 201 without a device token is not treated as paired', async () => {
  const { pairing, secureStoreNative } = bootstrap();
  const { deviceToken: _omitted, ...withoutToken } = PAIRING_SUCCESS_BODY;
  const fetchDouble = createFetchRecorder(() => jsonResponse(201, withoutToken));

  await withFetch(fetchDouble, async () => {
    const err = await pairing
      .pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' })
      .then(() => null, (e) => e);
    assert.equal(err.code, 'MALFORMED_RESPONSE');
    assert.match(err.message, /still unpaired/i);
  });

  assert.equal(secureStoreNative.__items.size, 0, 'no credential fabricated from a bad response');
});

test('PAIR-023: a non-JSON response stores nothing (SSO page, proxy, crash)', async () => {
  const { pairing, secureStoreNative } = bootstrap();
  const fetchDouble = createFetchRecorder(() =>
    rawResponse(200, '<html><body>Authentication Required</body></html>', 'text/html'));

  await withFetch(fetchDouble, async () => {
    const err = await pairing
      .pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' })
      .then(() => null, (e) => e);
    assert.equal(err.code, 'MALFORMED_RESPONSE');
    assert.equal(err.retryable, true);
  });

  assert.equal(secureStoreNative.__items.size, 0);
});

test('PAIR-024: a 5xx is reported as a server problem and stores nothing', async () => {
  const { pairing, secureStoreNative } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(503, { error: 'Database unavailable.' }));

  await withFetch(fetchDouble, async () => {
    const err = await pairing
      .pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' })
      .then(() => null, (e) => e);
    assert.equal(err.code, 'SERVER');
    assert.equal(err.retryable, true);
  });
  assert.equal(secureStoreNative.__items.size, 0);
});

test('PAIR-025: a keystore write failure is reported and leaves the device unpaired', async () => {
  const { pairing, store, secureStoreNative } = bootstrap();
  secureStoreNative.__state.failWrite = true;
  const fetchDouble = createFetchRecorder(() => jsonResponse(201, PAIRING_SUCCESS_BODY));

  await withFetch(fetchDouble, async () => {
    const err = await pairing
      .pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' })
      .then(() => null, (e) => e);
    assert.equal(err.code, 'STORAGE_FAILED');
    assert.match(err.message, /new pairing code/i, 'the spent code must be explained');
  });

  assert.equal(await store.deviceCredentialStore.hasCredential(), false);
});

test('PAIR-026: local validation rejects bad input before any network call', async () => {
  const { pairing } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(201, PAIRING_SUCCESS_BODY));

  await withFetch(fetchDouble, async () => {
    for (const input of [
      { pairingCode: '', deviceName: 'Counter tablet' },
      { pairingCode: 'NOT-A-CODE', deviceName: 'Counter tablet' },
      { pairingCode: 'MED-' + 'ZZZZZZ', deviceName: 'Counter tablet' },
      { pairingCode: PAIRING_CODE, deviceName: '   ' },
    ]) {
      const err = await pairing.pairDevice(input).then(() => null, (e) => e);
      assert.ok(err, `expected rejection for ${JSON.stringify(input)}`);
      assert.equal(err.name, 'PairingError');
    }
  });

  assert.equal(fetchDouble.calls.length, 0, 'invalid input must not reach the server');
});

test('PAIR-027: the pairing code validator matches the server generator exactly', () => {
  const { pairing } = bootstrap();
  assert.equal(pairing.validatePairingCode(PAIRING_CODE), null);
  assert.equal(pairing.validatePairingCode(PAIRING_CODE_LOWER), null, 'lower case is accepted');
  assert.ok(pairing.validatePairingCode('MED-' + 'A1B2C'), 'five characters is not a code');
  assert.ok(pairing.validatePairingCode('MED-' + 'A1B2C3D'), 'seven characters is not a code');
  assert.ok(pairing.validatePairingCode('XYZ-' + 'A1B2C3'), 'wrong prefix is not a code');
  assert.ok(pairing.validatePairingCode('MED-' + 'A1B2G3'), 'G is not a hex character');
  assert.equal(pairing.normalizePairingCode(' med - a1b2c3 '.replace(/ - /g, '-')), PAIRING_CODE);
});

// ═══ Secret hygiene ══════════════════════════════════════════════════════════

test('PAIR-030: the device token is never written to the console', async () => {
  const { pairing, client, deviceToken } = bootstrap();
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder((url, init, index) =>
    index === 0
      ? jsonResponse(201, PAIRING_SUCCESS_BODY)
      : jsonResponse(200, { valid: true, device: {}, pharmacy: {} }));

  const { output } = await captureConsole(() =>
    withFetch(fetchDouble, async () => {
      await pairing.pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' });
      // An authenticated call is where a token could most easily leak.
      await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
      await pairing.getPairedIdentity();
      await pairing.unpairDevice();
    }));

  assert.ok(output.length > 0, 'logging was active, so this test is not vacuous');
  assert.ok(!output.includes(DEVICE_TOKEN), 'the device token must never be logged');
  assert.ok(!output.includes(PAIRING_CODE), 'the pairing code must never be logged');
  assert.ok(!/medidev_[0-9a-f]{8}/.test(output), 'no token-shaped value in the log');
});

test('PAIR-031: the logger redacts tokens, pairing codes and auth headers', () => {
  const { logger } = bootstrap();
  const redacted = JSON.stringify(logger.redact({
    deviceToken: DEVICE_TOKEN,
    pairingCode: PAIRING_CODE,
    nested: { token: OTHER_TOKEN, bare: DEVICE_TOKEN },
    safe: 'Apollo Andheri',
  }));

  assert.ok(!redacted.includes(DEVICE_TOKEN));
  assert.ok(!redacted.includes(OTHER_TOKEN));
  assert.ok(!redacted.includes('A1B2C3'));
  assert.ok(redacted.includes('Apollo Andheri'), 'non-secrets stay readable');

  const headers = logger.safeHeaders({ 'X-Device-Token': DEVICE_TOKEN, Accept: 'application/json' });
  assert.equal(headers['X-Device-Token'], '[redacted]');
  assert.equal(headers.Accept, 'application/json');
});

// ═══ Token provider wiring ═══════════════════════════════════════════════════

test('PAIR-040: the stored token reaches the API client as X-Device-Token', async () => {
  const { pairing, client, deviceToken } = bootstrap();
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder((url, init, index) =>
    index === 0 ? jsonResponse(201, PAIRING_SUCCESS_BODY) : jsonResponse(200, { valid: true }));

  await withFetch(fetchDouble, async () => {
    await pairing.pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' });
    await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
  });

  const authCall = fetchDouble.calls[1];
  assert.equal(authCall.init.headers['X-Device-Token'], DEVICE_TOKEN);
});

test('PAIR-041: an unpaired device sends no device token', async () => {
  const { client, deviceToken } = bootstrap();
  deviceToken.bindDeviceAuthentication();
  const fetchDouble = createFetchRecorder(() => jsonResponse(200, { status: 'ok' }));

  await withFetch(fetchDouble, () =>
    client.apiClient.get('/api/health', { authenticated: true }));

  assert.equal(fetchDouble.calls[0].init.headers['X-Device-Token'], undefined);
});

test('PAIR-042: after unpairing, requests stop carrying the token', async () => {
  const { pairing, client, deviceToken } = bootstrap();
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder((url, init, index) =>
    index === 0 ? jsonResponse(201, PAIRING_SUCCESS_BODY) : jsonResponse(200, { valid: true }));

  await withFetch(fetchDouble, async () => {
    await pairing.pairDevice({ pairingCode: PAIRING_CODE, deviceName: 'Counter tablet' });
    await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
    await pairing.unpairDevice();
    await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
  });

  assert.equal(fetchDouble.calls[1].init.headers['X-Device-Token'], DEVICE_TOKEN, 'before unpair');
  assert.equal(fetchDouble.calls[2].init.headers['X-Device-Token'], undefined, 'after unpair');
});

// ═══ Unpair ══════════════════════════════════════════════════════════════════

test('PAIR-050: unpairDevice deletes the credential and calls no server endpoint', async () => {
  const { pairing, store, secureStoreNative } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {}));

  await withFetch(fetchDouble, () => pairing.unpairDevice());

  assert.equal(secureStoreNative.__items.size, 0, 'credential securely deleted');
  assert.equal(await pairing.getPairedIdentity(), null);
  // The backend revoke route requires an ADMIN web session, not a device token,
  // so the mobile app must not attempt it.
  assert.equal(fetchDouble.calls.length, 0, 'unpair is local only');
});

test('PAIR-051: a keystore delete failure surfaces instead of silently "succeeding"', async () => {
  const { pairing, store, secureStoreNative } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  secureStoreNative.__state.failDelete = true;

  await assert.rejects(() => pairing.unpairDevice(), /could not remove the stored device credential/i);
});

// ═══ Startup routing ═════════════════════════════════════════════════════════

test('PAIR-060: resolveStartRoute maps paired state to the opening screen', () => {
  const { startup } = bootstrap();
  assert.equal(startup.resolveStartRoute(true), 'Home');
  assert.equal(startup.resolveStartRoute(false), 'PairDevice');
});

test('PAIR-061: a paired device starts on Home, an unpaired one on Pair Device', async () => {
  const { startup, store } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {}));

  await withFetch(fetchDouble, async () => {
    assert.equal(await startup.determineStartRoute(), 'PairDevice', 'no credential -> Pair Device');
    await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
    assert.equal(await startup.determineStartRoute(), 'Home', 'credential -> Home');
  });

  assert.equal(fetchDouble.calls.length, 0, 'startup must not call a protected endpoint to decide');
});

test('PAIR-062: an unreadable keystore fails safe to Pair Device', async () => {
  const { startup, secureStoreNative } = bootstrap();
  secureStoreNative.__state.failRead = true;
  assert.equal(await startup.determineStartRoute(), 'PairDevice');
});

test('PAIR-063: the Splash screen delegates the decision and resets the stack', () => {
  const splash = read('src/screens/SplashScreen.tsx');
  assert.match(splash, /resolveAuthenticatedRoute/, 'routing logic is not duplicated in the screen');
  assert.match(splash, /navigation\.reset\(/, 'reset prevents navigating back to Splash');
  assert.match(splash, /verifyStoredDevice/, 'Phase 7D performs server verification');
});

// ═══ Storage rules (static) ══════════════════════════════════════════════════

test('PAIR-070: AsyncStorage is neither installed nor referenced', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!Object.keys(deps).some((d) => /async-storage/i.test(d)));
  for (const rel of sourceFiles()) {
    if (rel.startsWith('tests/')) continue;
    assert.ok(!/AsyncStorage/.test(codeOnly(read(rel))), `${rel} must not use AsyncStorage`);
  }
});

test('PAIR-071: the credential never touches SQLite', () => {
  const secure = codeOnly(read('src/storage/secureStore.ts'));
  assert.ok(!/sqlite/i.test(secure), 'the credential store must not reference SQLite');
  // The outbox (Phase 7H SQLite user) must have nothing to do with credentials.
  const outbox = codeOnly(read('src/storage/outbox.ts'));
  assert.ok(!/deviceToken|credential/i.test(outbox), 'the SQLite outbox must hold no credential');
  const pkg = JSON.parse(read('package.json'));
  // Phase 7H allows expo-sqlite for outbox storage
  assert.ok(pkg.dependencies['expo-sqlite'], 'expo-sqlite is installed in Phase 7H');
});

test('PAIR-072: no credential, token or pairing code is hard-coded in the app', () => {
  for (const rel of sourceFiles()) {
    if (rel.startsWith('tests/')) continue;
    const src = read(rel);
    // A real token is the prefix plus hex; the bare prefix constant is allowed.
    assert.ok(!/medidev_[0-9a-f]{8}/.test(src), `${rel} must not contain a device token`);
    assert.ok(!/MED-[0-9A-F]{6}/.test(src), `${rel} must not contain a real pairing code`);
  }
});

test('PAIR-073: only the credential store talks to expo-secure-store', () => {
  for (const rel of sourceFiles()) {
    if (rel.startsWith('tests/') || rel === 'package.json' || rel === 'app.json') continue;
    if (rel === 'src/storage/secureStore.ts') continue;
    assert.ok(
      !read(rel).includes("from 'expo-secure-store'"),
      `${rel} must go through the credential store, not SecureStore directly`,
    );
  }
  assert.match(read('src/storage/secureStore.ts'), /from 'expo-secure-store'/);
  assert.match(read('package.json'), /"expo-secure-store"/);
  assert.match(read('app.json'), /expo-secure-store/, 'the config plugin must be registered');
});

test('PAIR-074: the app never calls the ADMIN-only revoke or create endpoints', () => {
  for (const rel of sourceFiles()) {
    if (rel.startsWith('tests/')) continue;
    const src = codeOnly(read(rel));
    assert.ok(!/\/api\/mobile\/devices/.test(src), `${rel} must not call the ADMIN device routes`);
    assert.ok(!/pairing\/(create|generate)/.test(src), `${rel} must not create pairing codes`);
    // A revoke *path segment*. The DEVICE_REVOKED error code is a server
    // response the client must recognise, and is deliberately not matched here.
    assert.ok(!/\/revoke/i.test(src), `${rel} must not call a device revoke endpoint`);
  }
});

test('PAIR-075: screens hold no raw network calls and never render the token', () => {
  const screenDir = path.join(MOBILE_ROOT, 'src', 'screens');
  const screens = fs.readdirSync(screenDir).filter((f) => /\.tsx?$/.test(f));
  assert.ok(screens.length >= 4, 'expected several screen files');
  for (const file of screens) {
    const src = fs.readFileSync(path.join(screenDir, file), 'utf8');
    assert.ok(!/\bfetch\(/.test(src), `${file} must call the API layer, not fetch directly`);
    assert.ok(!/deviceToken/.test(src), `${file} must not touch the device token`);
    assert.ok(!src.includes("from 'expo-secure-store'"), `${file} must not read SecureStore directly`);
  }
});

test('PAIR-076: unpair is documented as local-only, with the reason', () => {
  const pairingSrc = read('src/api/devicePairing.ts');
  assert.match(pairingSrc, /ADMIN/, 'the reason unpair is local must be recorded');
  assert.match(pairingSrc, /revoke/i);
  const settings = read('src/screens/SettingsScreen.tsx');
  assert.match(settings, /Unpair this device/);
  assert.match(settings, /administrator/i, 'the user must be told how server-side revoke happens');
});

test('PAIR-077: reading state never throws, even when the keystore misbehaves', async () => {
  const { store, startup, secureStoreNative } = bootstrap();
  // A corrupt record that also cannot be deleted: the honest answer is "unpaired",
  // not an exception thrown out of a read.
  secureStoreNative.__items.set(store.DEVICE_CREDENTIAL_KEY, 'not json');
  secureStoreNative.__state.failDelete = true;

  assert.equal(await store.deviceCredentialStore.getCredential(), null);
  assert.equal(await store.deviceCredentialStore.getDeviceToken(), null);
  assert.equal(await store.deviceCredentialStore.hasCredential(), false);
  assert.equal(await store.deviceCredentialStore.getIdentity(), null);
  assert.equal(await startup.determineStartRoute(), 'PairDevice');
});

test('PAIR-080: a revoked or rejected credential is cleared, not retried', async () => {
  // The two ways the server signals a dead credential.
  const authFailures = [
    ['401 rejection', { status: 401 }],
    ['DEVICE_REVOKED code', { status: 400, code: 'DEVICE_REVOKED' }],
  ];

  for (const [label, opts] of authFailures) {
    const { pairing, store, errors } = bootstrap();
    await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

    const cleared = await pairing.handleAuthFailure(
      new errors.ApiError('HTTP', 'Invalid or revoked device token.', opts),
    );

    assert.equal(cleared, true, `${label} must discard the credential`);
    assert.equal(await store.deviceCredentialStore.hasCredential(), false, label);
  }
});

test('PAIR-081: a transient failure must not unpair a working device', async () => {
  const { pairing, store, errors } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  for (const error of [
    new errors.ApiError('HTTP', 'The MediIndex server is temporarily unavailable.', { status: 503 }),
    new errors.ApiError('NETWORK', 'Could not reach the MediIndex server.'),
    new errors.ApiError('TIMEOUT', 'Request timed out.'),
    new Error('something else entirely'),
  ]) {
    assert.equal(await pairing.handleAuthFailure(error), false);
    assert.equal(
      await store.deviceCredentialStore.hasCredential(),
      true,
      'only an auth failure may unpair the device',
    );
  }
});
