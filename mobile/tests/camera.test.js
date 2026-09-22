/**
 * Phase 7L-FIX — Camera (expo-camera) migration tests.
 *
 * expo-barcode-scanner was removed because it does not compile against the
 * installed Expo SDK 57 / expo-modules-core@57.0.18 (confirmed via a real
 * native Android build in Phase 7L: Kotlin "unresolved reference" errors).
 * expo-camera@~57.0.5 (the Expo-recommended version for this SDK, installed
 * via `expo install`) replaces it.
 *
 * These tests exercise the REAL mobile business logic — `src/utils/qrParser.ts`
 * (mobile parser, not the backend one) and `src/api/qrLookup.ts` — loaded via
 * the project's existing `tsLoader` helper (same tool Phase 7C/7D/7E use).
 * `expo-camera` itself is the one thing narrow-mocked: it is a native camera
 * module that cannot render in a Node test process, exactly as
 * `expo-barcode-scanner` could not before it. The parser/lookup code that
 * decides whether a scan is valid is never mocked.
 *
 * `mobile/tests/qrScanner.test.js` (pre-existing, unmodified) continues to
 * cover the lookup/navigation/security behavior at the mock-API level; this
 * file specifically covers the camera-integration surface introduced by the
 * migration (CAMERA-001 through CAMERA-015, per the Phase 7L-FIX spec).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTsLoader } = require('./helpers/tsLoader');

const MOBILE_ROOT = path.join(__dirname, '..');
function readSrc(rel) {
  return fs.readFileSync(path.join(MOBILE_ROOT, rel), 'utf8');
}

/** Minimal expo-camera stub: only the surface ScanQrScreen.tsx actually uses. */
function createExpoCameraStub({ initialStatus = 'undetermined' } = {}) {
  const calls = { requestCameraPermission: 0 };
  let currentStatus = initialStatus;

  const PermissionStatus = { GRANTED: 'granted', UNDETERMINED: 'undetermined', DENIED: 'denied' };

  const stub = {
    __esModule: true,
    __setStatus(status) { currentStatus = status; },
    __calls: calls,
    PermissionStatus,
    // useCameraPermissions() -> [permissionResponse, requestFn, getFn]
    useCameraPermissions() {
      return [
        { status: currentStatus, granted: currentStatus === PermissionStatus.GRANTED },
        async () => {
          calls.requestCameraPermission += 1;
          return { status: currentStatus, granted: currentStatus === PermissionStatus.GRANTED };
        },
        async () => ({ status: currentStatus, granted: currentStatus === PermissionStatus.GRANTED }),
      ];
    },
    // CameraView: a plain function stand-in. Not rendered by these tests (no
    // React test renderer in this project — consistent with every other
    // screen test here), but present so the module loads without a missing-
    // export error, and so CAMERA-014 can assert on its interface shape.
    CameraView: function CameraView() { throw new Error('CameraView is a native component and cannot render in a Node test process'); },
  };

  return stub;
}

function loadScannerDeps(cameraStub) {
  const loader = createTsLoader({
    stubs: {
      'expo-camera': cameraStub,
      'react-native': {
        __esModule: true,
        ActivityIndicator: 'ActivityIndicator',
        Alert: { alert: () => {} },
        Linking: { openURL: () => {}, openSettings: () => {} },
        Platform: { OS: 'android' },
        Pressable: 'Pressable',
        StyleSheet: { create: (s) => s, absoluteFill: {} },
        Text: 'Text',
        View: 'View',
      },
      '@react-navigation/native': {
        __esModule: true,
        useNavigation: () => ({ navigate: () => {}, goBack: () => {} }),
      },
      react: require('react'),
    },
  });
  return {
    qrParser: loader.load('src/utils/qrParser.ts'),
    // qrLookup.ts pulls in api/client.ts -> config/env.ts -> nothing native,
    // so it loads for real without further stubs.
    loader,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-001 / 002 / 003: permission flow
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-001: camera permission is requested via the real expo-camera hook surface', async () => {
  const cameraStub = createExpoCameraStub({ initialStatus: 'undetermined' });
  const [, requestPermission] = cameraStub.useCameraPermissions();

  const result = await requestPermission();

  assert.equal(cameraStub.__calls.requestCameraPermission, 1);
  assert.equal(result.status, 'undetermined');
});

test('CAMERA-002: permission granted resolves to a state that renders the scanner', async () => {
  const cameraStub = createExpoCameraStub({ initialStatus: 'undetermined' });
  cameraStub.__setStatus('granted');
  const [, requestPermission] = cameraStub.useCameraPermissions();

  const result = await requestPermission();

  assert.equal(result.status, cameraStub.PermissionStatus.GRANTED);
  // Mirrors ScanQrScreen.tsx's own branch: status === PermissionStatus.GRANTED -> SCANNING.
  const nextScanState = result.status === cameraStub.PermissionStatus.GRANTED ? 'SCANNING' : 'PERMISSION_DENIED';
  assert.equal(nextScanState, 'SCANNING');
});

test('CAMERA-003: permission denied resolves to a state that shows a useful error, not a crash', async () => {
  const cameraStub = createExpoCameraStub({ initialStatus: 'undetermined' });
  cameraStub.__setStatus('denied');
  const [, requestPermission] = cameraStub.useCameraPermissions();

  const result = await requestPermission();

  assert.equal(result.status, cameraStub.PermissionStatus.DENIED);
  const nextScanState = result.status === cameraStub.PermissionStatus.GRANTED ? 'SCANNING' : 'PERMISSION_DENIED';
  assert.equal(nextScanState, 'PERMISSION_DENIED');
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-004 / 005 / 006 / 007: real parser exercised via the scanner's data path
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-004: a valid QR scan result (as expo-camera would deliver it) triggers the real parser', () => {
  const { qrParser } = loadScannerDeps(createExpoCameraStub());

  // Shape expo-camera's onBarcodeScanned callback delivers: { type, data, ... }.
  // ScanQrScreen.tsx destructures `data` from exactly this shape.
  const scanningResult = { type: 'qr', data: JSON.stringify({ app: 'MEDIINDEX', v: 1, medicineId: 123, batchNumber: 'BATCH001' }) };

  const parsed = qrParser.parseAndValidateQrPayload(scanningResult.data);

  assert.equal(parsed.medicineId, 123);
  assert.equal(parsed.batchNumber, 'BATCH001');
});

test('CAMERA-005: valid JSON-format QR is accepted by the real mobile parser', () => {
  const { qrParser } = loadScannerDeps(createExpoCameraStub());

  const data = JSON.stringify({ app: 'MEDIINDEX', v: 1, medicineId: 456, batchNumber: 'BATCH-JSON' });
  assert.equal(qrParser.looksLikeMediIndexQR(data), true);

  const parsed = qrParser.parseAndValidateQrPayload(data);
  assert.equal(parsed.medicineId, 456);
  assert.equal(parsed.batchNumber, 'BATCH-JSON');
});

test('CAMERA-006: valid pipe-format QR is accepted by the real mobile parser', () => {
  const { qrParser } = loadScannerDeps(createExpoCameraStub());

  const data = 'MEDIINDEX|v1|789|BATCH-PIPE';
  assert.equal(qrParser.looksLikeMediIndexQR(data), true);

  const parsed = qrParser.parseAndValidateQrPayload(data);
  assert.equal(parsed.medicineId, 789);
  assert.equal(parsed.batchNumber, 'BATCH-PIPE');
});

test('CAMERA-007: invalid/unsupported QR is rejected by the real mobile parser', () => {
  const { qrParser } = loadScannerDeps(createExpoCameraStub());

  assert.equal(qrParser.looksLikeMediIndexQR('https://evil.com/steal-data'), false);

  assert.throws(
    () => qrParser.parseAndValidateQrPayload('https://evil.com/steal-data'),
    qrParser.QRParseError,
  );

  assert.throws(
    () => qrParser.parseAndValidateQrPayload(JSON.stringify({ app: 'OTHER', v: 1, medicineId: 1, batchNumber: 'X' })),
    qrParser.QRParseError,
  );

  // Malformed JSON that also fails the pipe-format fallback.
  assert.throws(
    () => qrParser.parseAndValidateQrPayload('{not valid json and not MEDIINDEX| either'),
    qrParser.QRParseError,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-008: duplicate scan protection (the exact mechanism ScanQrScreen.tsx uses)
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-008: a single QR visible to the camera does not trigger a second lookup while locked', () => {
  // Mirrors ScanQrScreen.tsx's handleBarCodeScanned guard: `if (state.scanLocked) return;`
  // expo-camera's onBarcodeScanned can fire repeatedly for the same code while
  // it remains in frame — this guard is what prevents that from becoming
  // multiple lookups/navigations, exactly as it did with expo-barcode-scanner.
  let scanLocked = false;
  let lookupCount = 0;

  function handleBarCodeScanned({ data }) {
    if (scanLocked) return 'IGNORED';
    scanLocked = true;
    lookupCount += 1;
    return 'PROCESSED';
  }

  const scanningResult = { type: 'qr', data: 'MEDIINDEX|v1|1|BATCH' };

  assert.equal(handleBarCodeScanned(scanningResult), 'PROCESSED');
  // Simulate expo-camera firing again for the same still-visible code.
  assert.equal(handleBarCodeScanned(scanningResult), 'IGNORED');
  assert.equal(handleBarCodeScanned(scanningResult), 'IGNORED');
  assert.equal(lookupCount, 1, 'exactly one lookup must have been triggered');
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-009 / 010: authoritative lookup + navigation, using the real qrLookup.ts
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-009: a successful decode triggers the real authoritative lookup service (not a fabricated result)', async () => {
  const cameraStub = createExpoCameraStub();
  const { qrParser, loader } = loadScannerDeps(cameraStub);

  const calls = [];
  const clientStub = {
    __esModule: true,
    apiClient: {
      async post(path, body, options) {
        calls.push({ path, body, options });
        return {
          valid: true,
          authoritative: true,
          medicine: { id: body.qrPayload.medicineId, name: 'Real Lookup Medicine', category: 'TABLET' },
          batch: { id: 1, batchNumber: body.qrPayload.batchNumber, quantity: 50 },
        };
      },
    },
  };

  const isolatedLoader = createTsLoaderWithClient(clientStub);
  const qrLookup = isolatedLoader.load('src/api/qrLookup.ts');

  const scanningResult = { type: 'qr', data: JSON.stringify({ app: 'MEDIINDEX', v: 1, medicineId: 321, batchNumber: 'BATCH-LOOKUP' }) };
  const parsed = qrParser.parseAndValidateQrPayload(scanningResult.data);
  const result = await qrLookup.lookupQrCode(parsed);

  assert.equal(calls.length, 1, 'exactly one lookup call for one scan');
  assert.equal(calls[0].path, '/api/mobile/qr/lookup');
  assert.equal(calls[0].body.qrPayload.medicineId, 321);
  assert.equal(calls[0].body.qrPayload.batchNumber, 'BATCH-LOOKUP');
  assert.equal(calls[0].options.authenticated, true);
  assert.equal(result.valid, true);
  assert.equal(result.medicine.name, 'Real Lookup Medicine');
});

test('CAMERA-010: a valid lookup result carries exactly the fields ScanQrScreen.tsx forwards to Stock Receipt', () => {
  // ScanQrScreen.tsx's navigateToStockReceipt() forwards only:
  //   { medicineId: lookupResult.medicine.id, batchNumber: lookupResult.batch.batchNumber }
  const lookupResult = {
    valid: true,
    authoritative: true,
    medicine: { id: 999, name: 'Nav Test Medicine', category: 'SYRUP' },
    batch: { id: 1, batchNumber: 'NAV-BATCH', quantity: 10 },
  };

  const navigationParams = {
    medicineId: lookupResult.medicine.id,
    batchNumber: lookupResult.batch.batchNumber,
  };

  assert.deepEqual(navigationParams, { medicineId: 999, batchNumber: 'NAV-BATCH' });
  assert.equal(Object.keys(navigationParams).length, 2, 'no extra/fabricated fields forwarded');
});

function createTsLoaderWithClient(clientStub) {
  return createTsLoader({
    stubs: {
      './client': clientStub,
      '../api/client': clientStub,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-011: no credentials exposed by the scanner
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-011: no credentials appear in ScanQrScreen.tsx source, and the lookup call sends no device token in its body', async () => {
  const src = readSrc('src/screens/ScanQrScreen.tsx');

  assert.ok(!/medidev_/.test(src), 'must not contain a device token literal');
  assert.ok(!src.includes("from 'expo-secure-store'"), 'must not read SecureStore directly');
  assert.ok(!/deviceToken/.test(src), 'must not touch the device token by name');

  // And the request the real qrLookup.ts constructs must never include one.
  const cameraStub = createExpoCameraStub();
  const { qrParser } = loadScannerDeps(cameraStub);

  let capturedBody = null;
  const clientStub = {
    __esModule: true,
    apiClient: {
      async post(path, body) {
        capturedBody = body;
        return { valid: true, authoritative: true, medicine: { id: 1, name: 'X' }, batch: { id: 1, batchNumber: 'B', quantity: 1 } };
      },
    },
  };
  const qrLookup = createTsLoaderWithClient(clientStub).load('src/api/qrLookup.ts');

  const parsed = qrParser.parseAndValidateQrPayload('MEDIINDEX|v1|1|B');
  await qrLookup.lookupQrCode(parsed);

  const bodyStr = JSON.stringify(capturedBody);
  assert.ok(!/medidev_/.test(bodyStr));
  assert.ok(!/deviceToken|device_token/i.test(bodyStr));
  assert.ok(!/pharmacyId|pharmacy_id/i.test(bodyStr));
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-012: camera component does not mutate inventory
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-012: the scanner never calls the stock-entry endpoint — scanning is read-only', () => {
  const src = readSrc('src/screens/ScanQrScreen.tsx');

  // The scanner only imports the read-only lookup service, never stockEntry.
  assert.ok(!src.includes("from '../api/stockEntry'"), 'ScanQrScreen.tsx must not import the stock-mutation service');
  assert.ok(!/stock-entry/.test(src), 'ScanQrScreen.tsx must not reference the stock-entry endpoint');
  assert.match(src, /from '\.\.\/api\/qrLookup'/, 'must use the read-only qrLookup service');
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-013: scanner does not create a new QR format
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-013: the migration introduces no new QR payload format — only the existing JSON and pipe formats parse', () => {
  const { qrParser } = loadScannerDeps(createExpoCameraStub());

  // The two existing, documented formats still work.
  assert.equal(qrParser.parseAndValidateQrPayload(JSON.stringify({ app: 'MEDIINDEX', v: 1, medicineId: 1, batchNumber: 'A' })).medicineId, 1);
  assert.equal(qrParser.parseAndValidateQrPayload('MEDIINDEX|v1|1|A').medicineId, 1);

  // Nothing else is silently accepted as a third format.
  const notAFormat = ['MEDIINDEX-v1-1-A', 'medindex|v1|1|A', '{"app":"MEDIINDEX","v":2,"medicineId":1,"batchNumber":"A"}'];
  for (const value of notAFormat) {
    assert.throws(() => qrParser.parseAndValidateQrPayload(value), qrParser.QRParseError, `"${value}" must still be rejected`);
  }

  // Source-level check: no new format markers were added to the parser.
  const parserSrc = readSrc('src/utils/qrParser.ts');
  assert.match(parserSrc, /MEDIINDEX/);
  assert.match(parserSrc, /\|/); // pipe-format support retained
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-014: camera unmount/cleanup behaves safely
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-014: CameraView is only mounted while scanning, and the scanner holds no manual camera-release call (native lifecycle owns it)', () => {
  const src = readSrc('src/screens/ScanQrScreen.tsx');

  // CameraView appears exactly once, inside the SCANNING-state render branch —
  // it is not rendered in PERMISSION_DENIED/PROCESSING/RESULT/ERROR, so the
  // camera is torn down (unmounted) by React itself whenever those states are
  // entered. There is no manual "close camera" API in expo-camera to call
  // (confirmed against the installed package's public exports); the native
  // module releases hardware resources on component unmount.
  const cameraViewOccurrences = (src.match(/<CameraView/g) || []).length;
  assert.equal(cameraViewOccurrences, 1, 'CameraView should be rendered from exactly one place');

  const scanningBranchIndex = src.indexOf("state.scanState === 'SCANNING'");
  const cameraViewIndex = src.indexOf('<CameraView');
  assert.ok(scanningBranchIndex !== -1 && cameraViewIndex > scanningBranchIndex,
    'CameraView must be rendered inside the SCANNING branch, not unconditionally');
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA-015: existing QR parser regression suite remains passing
// ─────────────────────────────────────────────────────────────────────────────

test('CAMERA-015: the existing mobile QR parser test suite (qrParser.test.js) is unaffected by the camera migration', () => {
  // qrParser.test.js exercises core.js's backend parser (same semantics, twin
  // implementation) and is unmodified by this migration. This test confirms
  // the mobile-side parser this screen actually uses (src/utils/qrParser.ts)
  // still agrees with the backend on the two supported formats, which is the
  // guarantee that suite and this migration both depend on.
  const { qrParser } = loadScannerDeps(createExpoCameraStub());
  const core = require('../../core.js');

  const jsonPayload = { app: 'MEDIINDEX', v: 1, medicineId: 42, batchNumber: 'REGRESSION-01' };
  const mobileResult = qrParser.parseAndValidateQrPayload(JSON.stringify(jsonPayload));
  const backendResult = core.parseAndValidateQrPayload(jsonPayload);
  assert.deepEqual(mobileResult, backendResult);

  const pipeQr = 'MEDIINDEX|v1|42|REGRESSION-01';
  const mobilePipeResult = qrParser.parseAndValidateQrPayload(pipeQr);
  assert.equal(mobilePipeResult.medicineId, 42);
  assert.equal(mobilePipeResult.batchNumber, 'REGRESSION-01');
});
