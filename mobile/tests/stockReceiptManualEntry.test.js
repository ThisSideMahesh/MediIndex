'use strict';
/**
 * Regression tests for the "Stock Receipt (Manual Entry)" production bug.
 *
 * BUG: HomeScreen's "Manual entry" action navigated to StockReceiptScreen
 * with no route params. The screen fell back to { medicineId: 0,
 * batchNumber: '' } and immediately fired an authoritative lookup with those
 * values, which the backend always rejects (medicineId must be > 0) —
 * permanently trapping the user on an error screen with no way to type a
 * real medicine ID or batch number.
 *
 * FIX: extracted manual-entry validation into a standalone module
 * (src/utils/stockReceiptValidation.ts) that mirrors the backend's own
 * validation rules, and gave StockReceiptScreen a real input form that only
 * fires the lookup once the user has supplied a plausible medicineId/
 * batchNumber pair. The form feeds the SAME lookupQrCode()/submitStockReceipt()
 * functions the already-working QR-scan flow uses — no duplicated
 * stock-mutation logic, no backend change.
 *
 * This file cannot render the actual React component (no native test
 * renderer in this project — see tests/helpers/tsLoader.js), so it exercises
 * the real, extracted TypeScript logic directly:
 *   - the manual-entry validation module (used by the screen's submit handler)
 *   - the real API request-building functions (submitStockReceipt, lookupQrCode)
 *   - the real error-classification/message-mapping module (errors.ts)
 * against a scripted fetch double, exactly like the existing home.test.js /
 * pairing.test.js / auth.test.js pattern.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTsLoader } = require('./helpers/tsLoader');
const {
  createSecureStoreStub,
  jsonResponse,
  createFetchRecorder,
  withFetch,
} = require('./helpers/stubs');

global.__DEV__ = true;
process.env.EXPO_PUBLIC_MOBILE_API_BASE_URL = 'http://127.0.0.1:59997';

const DEVICE_TOKEN = 'medidev_' + 'manual'.repeat(6);
const VALID_CREDENTIAL = {
  deviceToken: DEVICE_TOKEN,
  deviceId: 42,
  deviceName: 'Counter Tablet',
  pharmacyId: 7,
  pharmacyName: 'Apollo Andheri',
  pharmacyAddress: '12 Link Road, Andheri West',
  pairedAt: '2026-09-19T10:00:00.000Z',
};

/** Fresh module registry + keystore double per test, matching home.test.js. */
function bootstrap() {
  const secureStoreNative = createSecureStoreStub();
  const loader = createTsLoader({ stubs: { 'expo-secure-store': secureStoreNative } });
  return {
    secureStoreNative,
    store: loader.load('src/storage/secureStore.ts'),
    client: loader.load('src/api/client.ts'),
    deviceToken: loader.load('src/api/deviceToken.ts'),
    errors: loader.load('src/api/errors.ts'),
    stockEntry: loader.load('src/api/stockEntry.ts'),
    qrLookup: loader.load('src/api/qrLookup.ts'),
    idempotency: loader.load('src/utils/idempotency.ts'),
    validation: loader.load('src/utils/stockReceiptValidation.ts'),
  };
}

async function authenticatedBootstrap() {
  const mods = bootstrap();
  await mods.store.deviceCredentialStore.saveCredential(VALID_CREDENTIAL);
  mods.deviceToken.bindDeviceAuthentication();
  return mods;
}

// ═══ A/B/C/D — validation module (used by StockReceiptScreen's manual-entry form) ═══
// This is the module that fixes the bug: it is the ACTUAL validation the
// screen's "Look Up" button runs, mirroring core.js's parseAndValidateQrPayload.

test('MANUAL-001: rejects an empty medicine ID (this is what the old bug effectively submitted: medicineId 0)', () => {
  const { validation } = bootstrap();
  const result = validation.validateManualStockEntry({ medicineIdText: '', batchNumberText: 'PAR-A-2601' });
  assert.equal(result.valid, false);
  assert.match(result.error, /Medicine ID is required/);
});

test('MANUAL-002: rejects a zero or negative medicine ID', () => {
  const { validation } = bootstrap();
  for (const bad of ['0', '-1', '-99']) {
    const result = validation.validateManualStockEntry({ medicineIdText: bad, batchNumberText: 'PAR-A-2601' });
    assert.equal(result.valid, false, `expected "${bad}" to be rejected`);
    assert.match(result.error, /positive whole number/);
  }
});

test('MANUAL-003: rejects a non-integer medicine ID', () => {
  const { validation } = bootstrap();
  const result = validation.validateManualStockEntry({ medicineIdText: '1.5', batchNumberText: 'PAR-A-2601' });
  assert.equal(result.valid, false);
  assert.match(result.error, /positive whole number/);
});

test('MANUAL-004: rejects a non-numeric medicine ID', () => {
  const { validation } = bootstrap();
  const result = validation.validateManualStockEntry({ medicineIdText: 'abc', batchNumberText: 'PAR-A-2601' });
  assert.equal(result.valid, false);
  assert.match(result.error, /positive whole number/);
});

test('MANUAL-005: rejects an empty batch number', () => {
  const { validation } = bootstrap();
  const result = validation.validateManualStockEntry({ medicineIdText: '12', batchNumberText: '' });
  assert.equal(result.valid, false);
  assert.match(result.error, /Batch number is required/);
});

test('MANUAL-006: rejects a batch number over 80 characters (matches backend cleanText max)', () => {
  const { validation } = bootstrap();
  const tooLong = 'X'.repeat(81);
  const result = validation.validateManualStockEntry({ medicineIdText: '12', batchNumberText: tooLong });
  assert.equal(result.valid, false);
  assert.match(result.error, /too long/);
});

test('MANUAL-007: accepts a valid medicine ID and batch number, trimmed', () => {
  const { validation } = bootstrap();
  const result = validation.validateManualStockEntry({ medicineIdText: ' 12 ', batchNumberText: ' PAR-A-2601 ' });
  assert.equal(result.valid, true);
  assert.equal(result.medicineId, 12);
  assert.equal(result.batchNumber, 'PAR-A-2601');
  assert.equal(typeof result.medicineId, 'number');
});

test('MANUAL-008: accepts an 80-character batch number exactly (boundary)', () => {
  const { validation } = bootstrap();
  const exactly80 = 'X'.repeat(80);
  const result = validation.validateManualStockEntry({ medicineIdText: '1', batchNumberText: exactly80 });
  assert.equal(result.valid, true);
  assert.equal(result.batchNumber.length, 80);
});

// ═══ B — manual entry builds the correct request (via the SAME functions QR uses) ═══

test('MANUAL-009 (Regression B): a validated manual entry, submitted through submitStockReceipt, produces the exact same request shape the QR flow produces', async () => {
  const mods = await authenticatedBootstrap();
  const validated = mods.validation.validateManualStockEntry({ medicineIdText: '501', batchNumberText: 'AMX-B-2601' });
  assert.equal(validated.valid, true);

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {
    success: true,
    status: 'STOCK_UPDATED',
    idempotent: false,
    medicine: { id: 501, name: 'Amoxicillin', genericName: 'Amoxicillin', category: 'CAPSULE' },
    batch: { id: 900, batchNumber: 'AMX-B-2601', quantityAdded: 40, currentStock: 140, expiryDate: '2027-01-01', sellingPrice: 12.5, location: 'Rack B1' },
    movementId: 4242,
    deviceId: 42,
    timestamp: '2026-09-19T12:00:00.000Z',
  }));

  await withFetch(fetchDouble, () => mods.stockEntry.submitStockReceipt({
    medicineId: validated.medicineId,
    batchNumber: validated.batchNumber,
    quantity: 40,
    idempotencyKey: mods.idempotency.generateIdempotencyKey(),
  }));

  assert.equal(fetchDouble.calls.length, 1);
  const call = fetchDouble.calls[0];
  assert.match(call.url, /\/api\/mobile\/stock-entry$/);
  assert.equal(call.body.qrPayload.app, 'MEDIINDEX');
  assert.equal(call.body.qrPayload.v, 1);
  assert.equal(call.body.qrPayload.medicineId, 501);
  assert.equal(call.body.qrPayload.batchNumber, 'AMX-B-2601');
  assert.equal(call.body.quantity, 40);
  assert.equal(typeof call.body.idempotencyKey, 'string');
  assert.equal(call.init.headers['X-Device-Token'], DEVICE_TOKEN);
});

test('MANUAL-010 (Regression B): manual entry never sends pharmacyId/pharmacy_id, matching the QR flow', async () => {
  const mods = await authenticatedBootstrap();
  const validated = mods.validation.validateManualStockEntry({ medicineIdText: '77', batchNumberText: 'BATCH-77' });

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {
    success: true, status: 'STOCK_UPDATED', idempotent: false,
    medicine: { id: 77, name: 'Test', genericName: 'Test', category: 'TABLET' },
    batch: { id: 1, batchNumber: 'BATCH-77', quantityAdded: 5, currentStock: 5, expiryDate: '2027-01-01', sellingPrice: 1, location: 'A1' },
    movementId: 1, deviceId: 42, timestamp: '2026-09-19T12:00:00.000Z',
  }));

  await withFetch(fetchDouble, () => mods.stockEntry.submitStockReceipt({
    medicineId: validated.medicineId,
    batchNumber: validated.batchNumber,
    quantity: 5,
    idempotencyKey: 'manual-test-key-1',
  }));

  const body = fetchDouble.calls[0].body;
  assert.equal('pharmacyId' in body, false);
  assert.equal('pharmacy_id' in body, false);
  assert.equal('pharmacyId' in body.qrPayload, false);
});

// ═══ C — manual entry handles a successful response identically to QR entry ═══

test('MANUAL-011 (Regression C): successful manual-entry submission returns the authoritative server result', async () => {
  const mods = await authenticatedBootstrap();

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {
    success: true,
    status: 'STOCK_UPDATED',
    idempotent: false,
    medicine: { id: 12, name: 'Paracetamol 500mg', genericName: 'Paracetamol', category: 'TABLET' },
    batch: { id: 300, batchNumber: 'PAR-A-2601', quantityAdded: 100, currentStock: 350, expiryDate: '2027-06-01', sellingPrice: 2.5, location: 'Rack A1' },
    movementId: 8001,
    deviceId: 42,
    timestamp: '2026-09-19T12:30:00.000Z',
  }));

  const response = await withFetch(fetchDouble, () => mods.stockEntry.submitStockReceipt({
    medicineId: 12,
    batchNumber: 'PAR-A-2601',
    quantity: 100,
    idempotencyKey: 'manual-success-key',
  }));

  assert.equal(response.success, true);
  assert.equal(response.batch.currentStock, 350);
  assert.equal(response.batch.quantityAdded, 100);
  assert.equal(response.movementId, 8001);
  assert.equal(mods.stockEntry.getNewStockLevel(response), 350);
  assert.equal(mods.stockEntry.getAddedQuantity(response), 100);
  assert.equal(mods.stockEntry.isIdempotentResponse(response), false);
});

// ═══ D — manual entry handles API errors with specific, safe messages (Task 4) ═══

test('MANUAL-012 (Regression D): "medicine not found" (typo in manual entry) maps to a specific, safe message, not a generic one', async () => {
  const { errors } = bootstrap();

  const err = new errors.ApiError('HTTP', 'Active medicine ID 99999 not found for this pharmacy.', { status: 404 });
  const message = errors.toStockReceiptUserMessage(err);

  assert.equal(message, 'Active medicine ID 99999 not found for this pharmacy.');
  // Must not leak anything beyond the reviewed, safe backend message.
  assert.doesNotMatch(message, /at\s+\S+\.js:\d+/);
  assert.doesNotMatch(message, /SELECT|INSERT|UPDATE/i);
});

test('MANUAL-013 (Regression D): "batch not found" (typo in manual entry) maps to a specific, safe message', () => {
  const { errors } = bootstrap();

  const err = new errors.ApiError('HTTP', "Batch 'BADBATCH' not found for medicine 'Amoxicillin'.", { status: 404 });
  const message = errors.toStockReceiptUserMessage(err);

  assert.equal(message, "Batch 'BADBATCH' not found for medicine 'Amoxicillin'.");
});

test('MANUAL-014 (Regression D): "invalid quantity" maps to the specific backend message', () => {
  const { errors } = bootstrap();

  const err = new errors.ApiError('HTTP', 'Quantity must be a positive whole number greater than zero.', { status: 400 });
  const message = errors.toStockReceiptUserMessage(err);

  assert.equal(message, 'Quantity must be a positive whole number greater than zero.');
});

test('MANUAL-015 (Regression D): "device revoked" maps to the specific backend message', () => {
  const { errors } = bootstrap();

  const err = new errors.ApiError('HTTP', 'Device has been revoked or is no longer authorized.', { status: 400 });
  const message = errors.toStockReceiptUserMessage(err);

  assert.equal(message, 'Device has been revoked or is no longer authorized.');
});

test('MANUAL-016 (Regression D): "device not paired" (401) still uses the AUTHENTICATION category message, not the raw body', async () => {
  const { errors } = bootstrap();

  const err = new errors.ApiError('HTTP', 'Device authentication required. Invalid or revoked device token.', { status: 401 });
  const message = errors.toStockReceiptUserMessage(err);

  // 401 classifies as AUTHENTICATION, not PERMANENT — the allow-list only
  // applies to PERMANENT failures. This must remain the dedicated,
  // re-pairing-focused message, unchanged from toUserMessage().
  assert.equal(errors.classifyError(err), 'AUTHENTICATION');
  assert.equal(message, 'This device needs to be paired again before it can sync stock receipts.');
});

test('MANUAL-017 (Regression D): network failure still uses the generic retry message (unchanged from toUserMessage)', () => {
  const { errors } = bootstrap();

  const err = new errors.ApiError('NETWORK', 'Could not reach the MediIndex server. Check your connection.');
  const message = errors.toStockReceiptUserMessage(err);

  assert.equal(errors.classifyError(err), 'RETRYABLE');
  assert.equal(message, 'Could not reach the MediIndex server. This will be retried automatically.');
});

test('MANUAL-018 (Regression D): an UNRECOGNISED permanent error message falls back to the safe generic text, never echoed verbatim', () => {
  const { errors } = bootstrap();

  // Simulates a message that was NOT reviewed/allow-listed — e.g. a future
  // backend change, or (worst case) a raw internal error that leaked through
  // with a 400/404/409 status. Must NOT be shown verbatim.
  const err = new errors.ApiError('HTTP', 'duplicate key value violates unique constraint "pk_idempotency_keys"', { status: 409 });
  const message = errors.toStockReceiptUserMessage(err);

  assert.notEqual(message, 'duplicate key value violates unique constraint "pk_idempotency_keys"');
  assert.doesNotMatch(message, /constraint|pk_/);
  assert.equal(message, 'This stock receipt could not be processed and needs attention.');
});

test('MANUAL-019 (Regression D): a raw 500 error is never echoed verbatim', () => {
  const { errors } = bootstrap();

  const err = new errors.ApiError('HTTP', 'Internal server error: Cannot read properties of undefined', { status: 500 });
  const message = errors.toStockReceiptUserMessage(err);

  assert.notEqual(message, 'Internal server error: Cannot read properties of undefined');
});

// ═══ E — manual entry preserves idempotency exactly like QR entry ═══

test('MANUAL-020 (Regression E): manual-entry submission includes a generated idempotency key', async () => {
  const mods = await authenticatedBootstrap();
  const key = mods.idempotency.generateIdempotencyKey();
  assert.equal(mods.idempotency.isValidIdempotencyKey(key), true);

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {
    success: true, status: 'STOCK_UPDATED', idempotent: false,
    medicine: { id: 1, name: 'X', genericName: 'X', category: 'TABLET' },
    batch: { id: 1, batchNumber: 'B1', quantityAdded: 1, currentStock: 1, expiryDate: '2027-01-01', sellingPrice: 1, location: 'A1' },
    movementId: 1, deviceId: 42, timestamp: '2026-09-19T12:00:00.000Z',
  }));

  await withFetch(fetchDouble, () => mods.stockEntry.submitStockReceipt({
    medicineId: 1, batchNumber: 'B1', quantity: 1, idempotencyKey: key,
  }));

  assert.equal(fetchDouble.calls[0].body.idempotencyKey, key);
});

test('MANUAL-021 (Regression E): retrying a failed manual-entry submission reuses the SAME idempotency key', async () => {
  const mods = await authenticatedBootstrap();
  const key = mods.idempotency.generateIdempotencyKey();

  let attempt = 0;
  const fetchDouble = createFetchRecorder(() => {
    attempt += 1;
    if (attempt === 1) throw new Error('network blip');
    return jsonResponse(200, {
      success: true, status: 'STOCK_UPDATED', idempotent: false,
      medicine: { id: 1, name: 'X', genericName: 'X', category: 'TABLET' },
      batch: { id: 1, batchNumber: 'B1', quantityAdded: 1, currentStock: 1, expiryDate: '2027-01-01', sellingPrice: 1, location: 'A1' },
      movementId: 1, deviceId: 42, timestamp: '2026-09-19T12:00:00.000Z',
    });
  });

  await withFetch(fetchDouble, async () => {
    await assert.rejects(() => mods.stockEntry.submitStockReceipt({
      medicineId: 1, batchNumber: 'B1', quantity: 1, idempotencyKey: key,
    }));
    // Retry with the SAME key — exactly what handleRetry() in
    // StockReceiptScreen.tsx does (it never regenerates the key on retry).
    const result = await mods.stockEntry.submitStockReceipt({
      medicineId: 1, batchNumber: 'B1', quantity: 1, idempotencyKey: key,
    });
    assert.equal(result.success, true);
  });

  assert.equal(fetchDouble.calls.length, 2);
  assert.equal(fetchDouble.calls[0].body.idempotencyKey, key);
  assert.equal(fetchDouble.calls[1].body.idempotencyKey, key);
});

test('MANUAL-022 (Regression E): server-replayed idempotent response is surfaced as idempotent', async () => {
  const mods = await authenticatedBootstrap();

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {
    success: true, status: 'IDEMPOTENT', idempotent: true,
    medicine: { id: 1, name: 'X', genericName: 'X', category: 'TABLET' },
    batch: { id: 1, batchNumber: 'B1', quantityAdded: 1, currentStock: 1, expiryDate: '2027-01-01', sellingPrice: 1, location: 'A1' },
    movementId: 1, deviceId: 42, timestamp: '2026-09-19T12:00:00.000Z',
  }));

  const response = await withFetch(fetchDouble, () => mods.stockEntry.submitStockReceipt({
    medicineId: 1, batchNumber: 'B1', quantity: 1, idempotencyKey: 'replayed-key',
  }));

  assert.equal(mods.stockEntry.isIdempotentResponse(response), true);
});

// ═══ F — manual entry remains tenant-scoped exactly like QR entry ═══

test('MANUAL-023 (Regression F): manual-entry lookup uses device-token authentication, not a client-supplied pharmacy', async () => {
  const mods = await authenticatedBootstrap();

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {
    valid: true,
    authoritative: true,
    medicine: { id: 501, name: 'Amoxicillin', genericName: 'Amoxicillin', manufacturer: 'X', category: 'CAPSULE', minimumStock: 10 },
    batch: { id: 900, batchNumber: 'AMX-B-2601', quantity: 100, purchasePrice: 5, sellingPrice: 12.5, manufacturingDate: '2026-01-01', expiryDate: '2027-01-01', expiryStatus: 'VALID', location: 'Rack B1' },
  }));

  const parsedManualEntry = mods.validation.validateManualStockEntry({ medicineIdText: '501', batchNumberText: 'AMX-B-2601' });
  assert.equal(parsedManualEntry.valid, true);

  const result = await withFetch(fetchDouble, () => mods.qrLookup.lookupQrCode({
    app: 'MEDIINDEX', v: 1, medicineId: parsedManualEntry.medicineId, batchNumber: parsedManualEntry.batchNumber,
  }));

  assert.equal(result.valid, true);
  const call = fetchDouble.calls[0];
  // Pharmacy is derived server-side from this header — never from the body.
  assert.equal(call.init.headers['X-Device-Token'], DEVICE_TOKEN);
  assert.equal('pharmacyId' in call.body, false);
  assert.equal('pharmacyId' in call.body.qrPayload, false);
});

test('MANUAL-024 (Regression F): manual-entry submission without a paired device is rejected as an authentication failure, never silently scoped to a default pharmacy', async () => {
  const mods = bootstrap(); // NOT authenticatedBootstrap — no credential saved
  mods.deviceToken.bindDeviceAuthentication();

  const fetchDouble = createFetchRecorder(() => jsonResponse(401, {
    error: 'Device authentication required. Invalid or revoked device token.',
  }));

  await withFetch(fetchDouble, async () => {
    await assert.rejects(
      () => mods.stockEntry.submitStockReceipt({
        medicineId: 1, batchNumber: 'B1', quantity: 1, idempotencyKey: 'no-device-key',
      }),
      (err) => {
        assert.ok(err instanceof mods.errors.ApiError);
        assert.equal(err.isAuthFailure, true);
        return true;
      },
    );
  });

  // No X-Device-Token header should have been sent (there is no credential).
  assert.equal('X-Device-Token' in (fetchDouble.calls[0].init.headers || {}), false);
});

// ═══ G — the existing QR stock receipt behavior is unchanged by this fix ═══

test('MANUAL-025 (Regression G): a QR-derived medicineId/batchNumber (already validated by the scanner) still submits identically after this fix', async () => {
  const mods = await authenticatedBootstrap();

  // This is exactly what ScanQrScreen already does after a successful scan:
  // it has real, server-confirmed medicineId/batchNumber, not user-typed text.
  const scannedMedicineId = 501;
  const scannedBatchNumber = 'AMX-B-2601';

  const fetchDouble = createFetchRecorder(() => jsonResponse(200, {
    success: true, status: 'STOCK_UPDATED', idempotent: false,
    medicine: { id: scannedMedicineId, name: 'Amoxicillin', genericName: 'Amoxicillin', category: 'CAPSULE' },
    batch: { id: 900, batchNumber: scannedBatchNumber, quantityAdded: 20, currentStock: 120, expiryDate: '2027-01-01', sellingPrice: 12.5, location: 'Rack B1' },
    movementId: 5000, deviceId: 42, timestamp: '2026-09-19T12:00:00.000Z',
  }));

  const response = await withFetch(fetchDouble, () => mods.stockEntry.submitStockReceipt({
    medicineId: scannedMedicineId,
    batchNumber: scannedBatchNumber,
    quantity: 20,
    idempotencyKey: mods.idempotency.generateIdempotencyKey(),
  }));

  assert.equal(response.success, true);
  assert.equal(response.batch.currentStock, 120);
  const call = fetchDouble.calls[0];
  assert.equal(call.body.qrPayload.medicineId, scannedMedicineId);
  assert.equal(call.body.qrPayload.batchNumber, scannedBatchNumber);
});

test('MANUAL-026 (Regression G): the QR-scan validation logic in ScanQrScreen.tsx still forwards its result to StockReceipt with real params, unchanged by this fix', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'ScanQrScreen.tsx'), 'utf8');

  assert.match(src, /navigation\.navigate\('StockReceipt',\s*\{/, 'QR flow must still navigate with explicit params');
  assert.match(src, /medicineId:\s*state\.lookupResult\.medicine\.id/, 'QR flow must still pass the server-confirmed medicineId');
  assert.match(src, /batchNumber:\s*state\.lookupResult\.batch\.batchNumber/, 'QR flow must still pass the server-confirmed batchNumber');
});

// ═══ Source-level regression guards for the actual bug (no render harness available) ═══

test('MANUAL-027 (bug regression): StockReceiptScreen.tsx no longer auto-fires a lookup using a hard fallback of medicineId 0', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'StockReceiptScreen.tsx'), 'utf8');

  // The exact buggy line this test guards against reappearing:
  //   const { medicineId, batchNumber } = route.params || { medicineId: 0, batchNumber: '' };
  //   useEffect(() => { loadMedicineContext(); }, []);   <-- unconditional
  assert.doesNotMatch(
    src,
    /route\.params\s*\|\|\s*\{\s*medicineId:\s*0/,
    'must not silently fall back to a hard-coded invalid medicineId of 0',
  );
});

test('MANUAL-028 (bug regression): StockReceiptScreen.tsx provides a manual-entry input form when there is no route target', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'StockReceiptScreen.tsx'), 'utf8');

  assert.match(src, /if\s*\(!hasTarget\)/, 'must branch on whether a target was supplied before attempting any lookup');
  assert.match(src, /accessibilityLabel="Medicine ID"/, 'manual entry must expose a real Medicine ID input');
  assert.match(src, /accessibilityLabel="Batch number"/, 'manual entry must expose a real Batch number input');
  assert.match(src, /validateManualStockEntry/, 'manual entry must validate through the shared validation module, not ad hoc logic');
});

test('MANUAL-029 (bug regression): the mount-time lookup effect only fires when a target already exists', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'StockReceiptScreen.tsx'), 'utf8');

  assert.match(
    src,
    /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(hasTarget\)\s*\{\s*loadMedicineContext\(\);/,
    'the mount effect must gate the automatic lookup on hasTarget, not fire unconditionally',
  );
});

test('MANUAL-030 (bug regression): manual entry and QR entry converge on the same submitStockReceipt/lookupQrCode calls — no duplicated stock-mutation logic', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'StockReceiptScreen.tsx'), 'utf8');

  // Exactly one call site for each in actual code — proves there is no
  // second, parallel "manual" implementation of the API call. Strip
  // comments first so doc comments that merely mention the function name
  // (e.g. "the EXACT SAME lookupQrCode() the QR-scan path already uses")
  // don't inflate the count.
  const codeOnly = src
    .split('\n')
    .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  const submitCalls = codeOnly.match(/[^.]submitStockReceipt\(/g) || [];
  const lookupCalls = codeOnly.match(/[^.]lookupQrCode\(/g) || [];
  assert.equal(submitCalls.length, 1, 'submitStockReceipt must be called from exactly one place');
  assert.equal(lookupCalls.length, 1, 'lookupQrCode must be called from exactly one place');
});
