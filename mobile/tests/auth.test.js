'use strict';
/**
 * Phase 7D — authentication and device security tests.
 *
 * Tests the server-authoritative authentication lifecycle: stored credential
 * verification, authentication failure handling, and startup routing decisions.
 *
 * Uses the same TypeScript execution approach as Phase 7C, with mocked
 * SecureStore and scripted fetch responses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTsLoader } = require('./helpers/tsLoader');
const {
  createSecureStoreStub,
  jsonResponse,
  rawResponse,
  createFetchRecorder,
  withFetch,
  captureConsole,
} = require('./helpers/stubs');

// React Native injects __DEV__; enable verbose logging.
global.__DEV__ = true;
process.env.EXPO_PUBLIC_MOBILE_API_BASE_URL = 'http://127.0.0.1:59998';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DEVICE_TOKEN = 'medidev_' + 'fake'.repeat(8);
const VALID_CREDENTIAL = {
  deviceToken: DEVICE_TOKEN,
  deviceId: 42,
  deviceName: 'Counter tablet',
  pharmacyId: 7,
  pharmacyName: 'Apollo Andheri',
  pharmacyAddress: '12 Link Road',
  pairedAt: '2026-09-19T10:00:00.000Z',
};

const VALID_VERIFY_RESPONSE = {
  valid: true,
  device: {
    id: 42,
    name: 'Counter tablet',
    model: 'android 34',
    createdAt: '2026-09-19T10:00:00.000Z',
    lastSeenAt: '2026-09-19T12:00:00.000Z',
  },
  pharmacy: {
    id: 7,
    name: 'Apollo Andheri',
    address: '12 Link Road',
  },
};

/** Fresh module registry + keystore double per test. */
function bootstrap() {
  const secureStoreNative = createSecureStoreStub();
  const loader = createTsLoader({ stubs: { 'expo-secure-store': secureStoreNative } });
  return {
    secureStoreNative,
    store: loader.load('src/storage/secureStore.ts'),
    verification: loader.load('src/auth/deviceVerification.ts'),
    authState: loader.load('src/auth/authState.ts'),
    client: loader.load('src/api/client.ts'),
    deviceToken: loader.load('src/api/deviceToken.ts'),
    errors: loader.load('src/api/errors.ts'),
  };
}

// ═══ Device verification ═════════════════════════════════════════════════════

test('AUTH-001: no SecureStore credential returns no_credential', async () => {
  const { verification } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {}));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'no_credential');
  assert.equal(fetchDouble.calls.length, 0, 'no network call when no credential exists');
});

test('AUTH-002: SecureStore credential exists triggers server verification', async () => {
  const { verification, store, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication(); // Wire token provider

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, VALID_VERIFY_RESPONSE));

  await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(fetchDouble.calls.length, 1);
  assert.equal(fetchDouble.calls[0].url, 'http://127.0.0.1:59998/api/mobile/auth/verify');
  assert.equal(fetchDouble.calls[0].init.method, 'GET');
  assert.equal(fetchDouble.calls[0].init.headers['X-Device-Token'], DEVICE_TOKEN);
});

test('AUTH-003: valid server verification returns success with identity', async () => {
  const { verification, store, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, VALID_VERIFY_RESPONSE));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, true);
  assert.equal(result.identity.deviceId, 42);
  assert.equal(result.identity.pharmacyName, 'Apollo Andheri');
  assert.equal(result.identity.deviceModel, 'android 34');
});

test('AUTH-004: invalid device credential clears SecureStore', async () => {
  const { verification, store, secureStoreNative, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() =>
    jsonResponse(401, { error: 'Invalid or revoked device token.' }));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'auth_invalid');
  assert.equal(secureStoreNative.__items.size, 0, 'credential must be cleared');
  assert.equal(await store.deviceCredentialStore.hasCredential(), false);
});

test('AUTH-005: revoked device credential clears SecureStore', async () => {
  const { verification, store, secureStoreNative, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() =>
    jsonResponse(400, { error: 'Device revoked.', code: 'DEVICE_REVOKED' }));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'auth_invalid');
  assert.equal(secureStoreNative.__items.size, 0, 'revoked credential must be cleared');
});

test('AUTH-006: temporary network failure retains credential', async () => {
  const { verification, store, secureStoreNative, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
  });

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'network_error');
  assert.equal(secureStoreNative.__items.size, 1, 'credential must NOT be cleared on network error');
  assert.equal(await store.deviceCredentialStore.hasCredential(), true);
});

test('AUTH-007: HTTP 500 retains credential', async () => {
  const { verification, store, secureStoreNative, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() =>
    jsonResponse(503, { error: 'Database temporarily unavailable.' }));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'network_error');
  assert.equal(secureStoreNative.__items.size, 1, 'HTTP 5xx must not unpair device');
});

test('AUTH-008: unrelated HTTP 400 retains credential', async () => {
  const { verification, store, secureStoreNative, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() =>
    jsonResponse(400, { error: 'Invalid request format.', code: 'INVALID_INPUT' }));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'network_error');
  assert.equal(secureStoreNative.__items.size, 1, 'unrelated 400 must not unpair device');
});

test('AUTH-009: centralized auth failure handler clears credential', async () => {
  const { client, store, secureStoreNative, deviceToken, errors } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() =>
    jsonResponse(401, { error: 'Invalid or revoked device token.' }));

  await withFetch(fetchDouble, async () => {
    try {
      await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
      assert.fail('Expected auth failure');
    } catch (err) {
      assert.ok(err instanceof errors.ApiError);
      assert.equal(err.isAuthFailure, true);
    }
  });

  assert.equal(secureStoreNative.__items.size, 0, 'auth failure handler must clear credential');
});

test('AUTH-010: no authentication retry loop after credential cleared', async () => {
  const { client, store, deviceToken, errors } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() =>
    jsonResponse(401, { error: 'Invalid or revoked device token.' }));

  await withFetch(fetchDouble, async () => {
    // First request: auth failure, credential cleared
    try {
      await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
      assert.fail('Expected auth failure');
    } catch (err) {
      assert.ok(err instanceof errors.ApiError);
    }

    // Second request: no token sent (credential was cleared)
    try {
      await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
    } catch (err) {
      // This request may still fail, but it should not send a token
    }
  });

  assert.equal(fetchDouble.calls.length, 2);
  assert.equal(fetchDouble.calls[0].init.headers['X-Device-Token'], DEVICE_TOKEN, 'first request has token');
  assert.equal(fetchDouble.calls[1].init.headers['X-Device-Token'], undefined, 'second request has no token');
});

// ═══ Logging and secrets ═════════════════════════════════════════════════════

test('AUTH-011: device tokens never appear in logs', async () => {
  const { verification, store, client, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder((url, init, index) =>
    index === 0
      ? jsonResponse(200, VALID_VERIFY_RESPONSE)
      : jsonResponse(401, { error: 'Invalid token.' }));

  const { output } = await captureConsole(() =>
    withFetch(fetchDouble, async () => {
      await verification.verifyStoredDevice();
      try {
        await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
      } catch {
        // Expected auth failure
      }
    }));

  assert.ok(output.length > 0, 'logging was active');
  assert.ok(!output.includes(DEVICE_TOKEN), 'device token must never be logged');
  assert.ok(!/medidev_[0-9a-f]{8}/.test(output), 'no token-shaped value in logs');
});

test('AUTH-012: no raw token in navigation parameters or app state', () => {
  const { verification, authState } = bootstrap();
  
  // Startup routing function never receives or returns tokens
  const routeHome = verification.resolveAuthenticatedRoute({ success: true, identity: {} });
  const routePair = verification.resolveAuthenticatedRoute({ success: false, reason: 'no_credential' });
  assert.equal(routeHome, 'Home');
  assert.equal(routePair, 'PairDevice');

  // Auth state model never contains raw tokens
  const state = authState.INITIAL_AUTH_STATE;
  assert.equal('deviceToken' in state, false);
  assert.equal('pairingCode' in state, false);
  assert.equal(state.status, 'UNPAIRED');
});

// ═══ Authentication state ════════════════════════════════════════════════════

test('AUTH-013: auth state transitions correctly', () => {
  const { authState } = bootstrap();
  let state = { ...authState.INITIAL_AUTH_STATE };

  const setState = (updater) => {
    state = typeof updater === 'function' ? updater(state) : updater;
  };
  const actions = authState.createAuthActions(setState);

  assert.equal(state.status, 'UNPAIRED');

  actions.startVerification();
  assert.equal(state.status, 'VERIFYING');
  assert.equal(state.isVerifying, true);

  const identity = { deviceId: 42, pharmacyName: 'Test' };
  actions.setAuthenticated(identity);
  assert.equal(state.status, 'AUTHENTICATED');
  assert.equal(state.identity.deviceId, 42);
  assert.equal(state.isVerifying, false);

  actions.setAuthInvalid();
  assert.equal(state.status, 'AUTH_INVALID');
  assert.equal(state.identity, null);

  actions.setAuthError('Network timeout');
  assert.equal(state.status, 'AUTH_ERROR');
  assert.equal(state.error, 'Network timeout');

  actions.setUnpaired();
  assert.equal(state.status, 'UNPAIRED');
  assert.equal(state.identity, null);
  assert.equal(state.error, null);
});

// ═══ Startup routing ═════════════════════════════════════════════════════════

test('AUTH-014: successful verification routes to Home', async () => {
  const { verification, store } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, VALID_VERIFY_RESPONSE));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());
  const route = verification.resolveAuthenticatedRoute(result);

  assert.equal(route, 'Home');
});

test('AUTH-015: no credential routes to PairDevice', async () => {
  const { verification } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {}));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());
  const route = verification.resolveAuthenticatedRoute(result);

  assert.equal(route, 'PairDevice');
});

test('AUTH-016: auth invalid routes to PairDevice', async () => {
  const { verification, store } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  const fetchDouble = createFetchRecorder(() =>
    jsonResponse(401, { error: 'Invalid or revoked device token.' }));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());
  const route = verification.resolveAuthenticatedRoute(result);

  assert.equal(route, 'PairDevice');
});

test('AUTH-017: network error routes to PairDevice (no credential left)', async () => {
  const { verification, store } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  const fetchDouble = createFetchRecorder(() => {
    throw new Error('Network unreachable');
  });

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());
  const route = verification.resolveAuthenticatedRoute(result);

  // Network error keeps credential but app cannot proceed to Home without
  // successful verification, so routes to PairDevice where user can retry.
  assert.equal(route, 'PairDevice');
});

// ═══ Token provider integration ══════════════════════════════════════════════

test('AUTH-018: authenticated requests use current credential after pairing', async () => {
  const { client, store, deviceToken } = bootstrap();
  deviceToken.bindDeviceAuthentication();

  // Start unpaired
  const fetchDouble = createFetchRecorder((url, init, index) => {
    if (index === 0) return jsonResponse(200, {}); // First call: no token sent
    return jsonResponse(200, VALID_VERIFY_RESPONSE); // Second call: token sent
  });

  await withFetch(fetchDouble, async () => {
    // Request 1: no credential exists
    await client.apiClient.get('/api/health', { authenticated: true });

    // Simulate pairing
    await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

    // Request 2: credential now available
    await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
  });

  assert.equal(fetchDouble.calls[0].init.headers['X-Device-Token'], undefined, 'no token before pairing');
  assert.equal(fetchDouble.calls[1].init.headers['X-Device-Token'], DEVICE_TOKEN, 'token after pairing');
});

test('AUTH-019: pairing credential is never used as auth token', async () => {
  const { store } = bootstrap();
  const PAIRING_CODE = 'FAKE-123456';

  // Attempt to store a pairing code as the device token (should be rejected)
  await assert.rejects(
    () => store.deviceCredentialStore.saveCredential({
      ...VALID_CREDENTIAL,
      deviceToken: PAIRING_CODE,
    }),
    /not a server-issued device token/i,
  );
});

test('AUTH-020: verification uses exact backend-required header', async () => {
  const { verification, store, deviceToken } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication(); // Wire token provider

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, VALID_VERIFY_RESPONSE));

  await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  const call = fetchDouble.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:59998/api/mobile/auth/verify');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers['X-Device-Token'], DEVICE_TOKEN);
  assert.equal(call.init.body, undefined, 'verification is GET with no body');
});

test('AUTH-021: network timeout does not unpair device', async () => {
  const { verification, store, secureStoreNative } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  const fetchDouble = createFetchRecorder(() => {
    throw Object.assign(new Error('AbortError'), { name: 'AbortError' });
  });

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'network_error');
  assert.equal(secureStoreNative.__items.size, 1, 'timeout must not clear credential');
});

test('AUTH-022: generic server failure does not unpair device', async () => {
  const { verification, store, secureStoreNative } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);

  const fetchDouble = createFetchRecorder(() => jsonResponse(500, { error: 'Internal server error.' }));

  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'network_error');
  assert.equal(secureStoreNative.__items.size, 1, '500 error must not clear credential');
});

test('AUTH-023: revocation discovered in later authenticated request clears credential', async () => {
  const { client, store, secureStoreNative, deviceToken, errors } = bootstrap();
  await store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  deviceToken.bindDeviceAuthentication();

  // Simulate: verification succeeds, but a later stock entry request discovers revocation
  const fetchDouble = createFetchRecorder((url, init, index) =>
    index === 0
      ? jsonResponse(200, VALID_VERIFY_RESPONSE)
      : jsonResponse(401, { error: 'Device has been revoked by administrator.' }));

  await withFetch(fetchDouble, async () => {
    // Verification passes
    await client.apiClient.get('/api/mobile/auth/verify', { authenticated: true });
    assert.equal(await store.deviceCredentialStore.hasCredential(), true, 'credential exists after verification');

    // Later request fails with auth error
    try {
      await client.apiClient.post('/api/mobile/stock-entry', { qrPayload: {}, quantity: 1 }, { authenticated: true });
      assert.fail('Expected auth failure');
    } catch (err) {
      assert.ok(err instanceof errors.ApiError);
      assert.equal(err.isAuthFailure, true);
    }
  });

  assert.equal(secureStoreNative.__items.size, 0, 'credential cleared after auth failure in later request');
});

test('AUTH-024: already-cleared credentials remain safely unpaired', async () => {
  const { verification, store } = bootstrap();
  // Start with no credential
  const result = await verification.verifyStoredDevice();
  assert.equal(result.success, false);
  assert.equal(result.reason, 'no_credential');
  
  // Multiple calls to clear are safe
  await store.deviceCredentialStore.clearCredential();
  await store.deviceCredentialStore.clearCredential();
  assert.equal(await store.deviceCredentialStore.hasCredential(), false);
});

test('AUTH-025: startup skips protected APIs when no local credential exists', async () => {
  const { verification } = bootstrap();
  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {}));

  // No credential exists, so verification should not make any network calls
  const result = await withFetch(fetchDouble, () => verification.verifyStoredDevice());

  assert.equal(result.success, false);
  assert.equal(result.reason, 'no_credential');
  assert.equal(fetchDouble.calls.length, 0, 'no network calls when no credential exists');
});