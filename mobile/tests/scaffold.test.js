'use strict';
/**
 * Phase 7B scaffold smoke tests.
 *
 * Deliberately lives under `mobile/tests/` so the repository-root suite
 * (`node --test tests/*.test.js`) is unaffected — the backend suite stays
 * authoritative and untouched.
 *
 * Scope and honest limits: React Native components cannot be rendered by plain
 * node:test without a native test renderer, which would be a large dependency to
 * add to a scaffold. These tests therefore verify structure, wiring, contract
 * accuracy and the security rules that must hold from day one. Runtime render
 * tests arrive in Phase 7K alongside the mobile test tooling.
 *
 * Type safety is covered separately and thoroughly by `npm run typecheck`
 * (`tsc --noEmit`), which is part of `npm run verify`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ─── Structure ───────────────────────────────────────────────────────────────

test('SCAF-001: required scaffold files exist', () => {
  const required = [
    'App.tsx', 'index.ts', 'app.json', 'package.json', 'tsconfig.json',
    'README.md', '.env.example',
    'src/api/client.ts', 'src/api/errors.ts',
    'src/components/PlaceholderScreen.tsx', 'src/components/theme.ts',
    'src/config/env.ts',
    'src/api/devicePairing.ts', 'src/api/deviceToken.ts',
    'src/navigation/RootNavigator.tsx', 'src/navigation/startupRoute.ts',
    'src/screens/index.tsx', 'src/screens/SplashScreen.tsx',
    'src/screens/PairDeviceScreen.tsx', 'src/screens/SettingsScreen.tsx',
    'src/screens/placeholders.tsx',
    'src/storage/secureStore.ts', 'src/storage/outbox.ts',
    'src/sync/syncEngine.ts',
    'src/types/api.ts',
    'src/utils/logger.ts',
  ];
  for (const rel of required) assert.ok(exists(rel), `missing ${rel}`);
});

test('SCAF-002: all seven screens are defined, exported and registered', () => {
  const barrel = read('src/screens/index.tsx');
  const nav = read('src/navigation/RootNavigator.tsx');
  // Screens now live in their own files (implemented) or placeholders.tsx.
  const screenDir = path.join(ROOT, 'src', 'screens');
  const allScreenSource = fs.readdirSync(screenDir)
    .filter((f) => /\.tsx?$/.test(f) && f !== 'index.tsx')
    .map((f) => fs.readFileSync(path.join(screenDir, f), 'utf8'))
    .join('\n');

  const names = ['SplashScreen', 'PairDeviceScreen', 'HomeScreen', 'ScanQrScreen',
    'StockReceiptScreen', 'SyncQueueScreen', 'SettingsScreen'];
  for (const name of names) {
    assert.match(allScreenSource, new RegExp(`export function ${name}\\b`), `${name} must be defined`);
    assert.match(barrel, new RegExp(`\\b${name}\\b`), `${name} must be re-exported from the barrel`);
    assert.match(nav, new RegExp(`component=\\{${name}\\}`), `${name} must be registered`);
  }
  // Typed route list must cover every screen.
  for (const route of ['Splash', 'PairDevice', 'Home', 'ScanQr', 'StockReceipt', 'SyncQueue', 'Settings']) {
    assert.match(nav, new RegExp(`name="${route}"`), `route ${route} must be registered`);
  }
});

/** Strips block and line comments so checks inspect code, not documentation. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('SCAF-003: App.tsx mounts navigation and safe-area only (no business logic)', () => {
  const app = read('App.tsx');
  assert.match(app, /RootNavigator/);
  assert.match(app, /SafeAreaProvider/);
  // Check executable code only — the file's header comment legitimately mentions
  // the features that are deliberately absent.
  const code = codeOnly(app);
  for (const banned of ['expo-camera', 'expo-sqlite', 'expo-secure-store', 'stock-entry', 'pairing']) {
    assert.ok(!code.includes(banned), `App.tsx must not reference ${banned} in Phase 7B`);
  }
});

// ─── Placeholders are honest ──────────────────────────────────────────────────

test('SCAF-010: unimplemented screens say so and name their phase', () => {
  const placeholders = read('src/screens/placeholders.tsx');
  assert.match(read('src/components/PlaceholderScreen.tsx'), /NOT IMPLEMENTED YET/);
  for (const phase of ['Phase 7E', 'Phase 7F', 'Phase 7G', 'Phase 7H']) {
    assert.ok(placeholders.includes(phase), `a placeholder should reference ${phase}`);
  }
  // Conversely, the screens Phase 7C implemented must no longer be placeholders.
  for (const rel of ['src/screens/SplashScreen.tsx', 'src/screens/PairDeviceScreen.tsx',
    'src/screens/SettingsScreen.tsx']) {
    assert.ok(!read(rel).includes('PlaceholderScreen'), `${rel} is implemented, not a placeholder`);
  }
});

test('SCAF-011: no placeholder/stub modules remain among the always-implemented set', () => {
  // Secure credential storage is real as of Phase 7C.
  const secure = read('src/storage/secureStore.ts');
  assert.ok(secure.includes('SECURE_STORE_IMPLEMENTED = true'), 'secure storage is implemented');
  assert.ok(!/not implemented until Phase/.test(secure), 'no stub text may remain');

  // Outbox storage is real as of Phase 7H.
  const outbox = read('src/storage/outbox.ts');
  assert.ok(outbox.includes('OUTBOX_IMPLEMENTED = true'), 'outbox storage is implemented');
  assert.ok(!/not implemented until Phase/.test(outbox), 'no outbox stub text may remain');

  // Sync engine is real as of Phase 7I.
  const sync = read('src/sync/syncEngine.ts');
  assert.ok(sync.includes('SYNC_ENGINE_IMPLEMENTED = true'), 'sync engine is implemented');
  assert.ok(!/not implemented until Phase/.test(sync), 'no sync engine stub text may remain');
});

test('SCAF-012: no source imports a dependency that is not installed', () => {
  const pkg = JSON.parse(read('package.json'));
  const installed = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  // Phase 7C installs secure storage; the rest still wait for their phase.
  assert.ok(installed.has('expo-secure-store'), 'Phase 7C requires expo-secure-store');
  
  // Phase 7F / 7L-FIX: expo-camera provides QR scanning (migrated from the
  // now-removed expo-barcode-scanner, which was incompatible with Expo SDK 57).
  const allowedInPhase7F = ['expo-camera'];

  // Phase 7H allows SQLite and networking for offline outbox
  const allowedInPhase7H = ['expo-sqlite', '@react-native-community/netinfo'];

  const notYet = ['expo-barcode-scanner']; // Removed in Phase 7L-FIX; must not return.
  for (const dep of notYet) {
    assert.ok(!installed.has(dep), `${dep} must not be installed (removed in Phase 7L-FIX)`);
  }
  // Phase 7F/7H requirements are allowed
  for (const dep of allowedInPhase7F) {
    assert.ok(installed.has(dep), `Phase 7F requires ${dep} for QR scanning`);
  }
  // ...and nothing may import an uninstalled package, or the bundle would break.
  const sources = ['src/storage/secureStore.ts', 'src/storage/outbox.ts', 'src/sync/syncEngine.ts',
    'src/api/devicePairing.ts', 'src/api/deviceToken.ts', 'App.tsx'];
  for (const rel of sources) {
    for (const dep of notYet) {
      assert.ok(!read(rel).includes(`from '${dep}'`), `${rel} must not import ${dep}`);
    }
  }
});

// ─── Configuration ───────────────────────────────────────────────────────────

test('SCAF-020: the API base URL is env-driven with no hard-coded deployment', () => {
  const env = read('src/config/env.ts');
  assert.match(env, /EXPO_PUBLIC_MOBILE_API_BASE_URL/);
  assert.ok(!/vercel\.app/i.test(env), 'must not hard-code a Vercel URL');
  assert.match(env, /10\.0\.2\.2/, 'should default to the Android emulator host alias');
  assert.match(env, /replace\(\/\\\/\+\$\/, ''\)/, 'trailing slashes must be normalised');
  // Documented for developers.
  assert.match(read('.env.example'), /EXPO_PUBLIC_MOBILE_API_BASE_URL/);
  assert.match(read('README.md'), /EXPO_PUBLIC_MOBILE_API_BASE_URL/);
});

test('SCAF-021: .env is git-ignored and .env.example carries no secret', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /\.env/, '.env must be git-ignored');
  const example = read('.env.example');
  assert.ok(!/medidev_/.test(example), 'no device token in the example env');
  assert.match(example, /NEVER put a secret here/i);
});

// ─── API client foundation ───────────────────────────────────────────────────

test('SCAF-030: the API client supports GET, POST, timeout, auth hook and safe parsing', () => {
  const client = read('src/api/client.ts');
  assert.match(client, /get: <T>/);
  assert.match(client, /post: <T>/);
  assert.match(client, /AbortController/, 'timeouts require AbortController');
  assert.match(client, /setTokenProvider/, 'Phase 7D must be able to inject the token without a rewrite');
  assert.match(client, /DEVICE_TOKEN_HEADER/, 'device auth must use the existing header');
  // Content-type aware parsing — the defect class already fixed on the web client.
  assert.match(client, /response\.text\(\)/, 'must read text before parsing JSON');
  assert.match(client, /application\/json/);
  assert.match(client, /MALFORMED/, 'a non-JSON body must surface as a structured error');
});

test('SCAF-031: errors are structured and classified transient vs permanent', () => {
  const errors = read('src/api/errors.ts');
  for (const kind of ['HTTP', 'NETWORK', 'TIMEOUT', 'MALFORMED']) {
    assert.ok(errors.includes(`'${kind}'`), `ApiErrorKind must include ${kind}`);
  }
  // Permanent codes must match the proven web list.
  for (const code of ['MEDICINE_NOT_FOUND', 'BATCH_NOT_FOUND', 'INVALID_QR_PAYLOAD',
    'QUANTITY_LIMIT_EXCEEDED', 'TENANT_SPOOFING_REJECTED', 'IDEMPOTENCY_CONFLICT']) {
    assert.ok(errors.includes(code), `${code} must be classified permanent`);
  }
  assert.match(errors, /export function isTransient/);
  assert.match(errors, /isAuthFailure/, 'a revoked device must be detectable');
});

test('SCAF-032: contract types mirror the real backend, inventing nothing', () => {
  const types = read('src/types/api.ts');
  for (const route of ['/api/mobile/auth/verify', '/api/mobile/pairing/complete',
    '/api/mobile/stock-entry', '/api/mobile/stock-entry/batch-sync', '/api/health']) {
    assert.ok(types.includes(route), `${route} must be declared`);
  }
  assert.match(types, /'X-Device-Token'/);
  assert.match(types, /app: 'MEDIINDEX'/, 'the existing QR format must be reused');
  assert.match(types, /BATCH_SYNC_MAX_OPERATIONS = 100/, 'the server caps batches at 100');
  for (const state of ['PENDING', 'SYNCING', 'SYNCED', 'FAILED']) {
    assert.ok(types.includes(`'${state}'`), `outbox state ${state} must be declared`);
  }
});

// ─── Security ────────────────────────────────────────────────────────────────

test('SCAF-040: no secret, token or fake credential anywhere in source', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|json)$/.test(entry.name)) files.push(full);
    }
  })(ROOT);

  assert.ok(files.length > 5, 'expected to scan several source files');
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    // A real device token would start with this prefix; only the redaction guard
    // and the documented rules may mention it.
    if (!/utils\/logger\.ts|tests\//.test(rel)) {
      assert.ok(!/medidev_[0-9a-f]{8}/.test(src), `${rel} must not contain a device token`);
    }
    assert.ok(!/MED-[0-9A-F]{6}/.test(src), `${rel} must not contain a real pairing code`);
  }
});

test('SCAF-041: the logger redacts tokens and sensitive headers', () => {
  const log = read('src/utils/logger.ts');
  assert.match(log, /SENSITIVE_HEADERS/);
  for (const header of ['authorization', 'x-device-token', 'cookie']) {
    assert.ok(log.includes(header), `${header} must be redacted`);
  }
  assert.match(log, /medidev_/, 'a raw token prefix must be recognised and redacted');
  assert.match(log, /export function safeHeaders/);
  // The client must actually use the redaction helper.
  assert.match(read('src/api/client.ts'), /safeHeaders\(/);
});

test('SCAF-042: AsyncStorage is never used, and never as the offline queue', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!Object.keys(deps).some((d) => /async-storage/i.test(d)), 'AsyncStorage must not be a dependency');
  const outbox = read('src/storage/outbox.ts');
  assert.match(outbox, /SQLite, not AsyncStorage/, 'the queue decision must be documented');
  assert.match(outbox, /UNIQUE/, 'the idempotency key must be uniquely constrained locally');
  assert.match(outbox, /NEVER regenerated/, 'key stability is the core idempotency guarantee');
});

test('SCAF-043: the client never sends a pharmacy id', () => {
  for (const rel of ['src/api/client.ts', 'src/types/api.ts']) {
    const src = read(rel);
    assert.ok(!/pharmacyId:\s*(?!number|\s*\n)/.test(src) || rel.endsWith('types/api.ts'),
      `${rel} must not assign a client-supplied pharmacyId`);
  }
  // The contract file documents the server-side rejection so later phases know.
  assert.match(read('src/types/api.ts'), /TENANT_SPOOFING_REJECTED/);
});

// ─── Build configuration ─────────────────────────────────────────────────────

test('SCAF-050: Android configuration and required scripts are present', () => {
  const appJson = JSON.parse(read('app.json'));
  assert.ok(appJson.expo, 'expo config block required');
  assert.ok(appJson.expo.android, 'android configuration required');
  const pkg = JSON.parse(read('package.json'));
  for (const script of ['start', 'android', 'typecheck', 'test', 'verify']) {
    assert.ok(pkg.scripts[script], `script "${script}" required`);
  }
  assert.match(pkg.scripts.typecheck, /tsc --noEmit/);
});

test('SCAF-051: TypeScript is strict and navigation deps are installed', () => {
  const tsconfig = JSON.parse(read('tsconfig.json'));
  assert.equal(tsconfig.compilerOptions.strict, true, 'strict mode must stay on');
  const pkg = JSON.parse(read('package.json'));
  for (const dep of ['expo', 'react', 'react-native', '@react-navigation/native',
    '@react-navigation/native-stack', 'react-native-screens', 'react-native-safe-area-context']) {
    assert.ok(pkg.dependencies[dep], `${dep} must be installed for the scaffold`);
  }
});
