/**
 * Mobile Devices — Admin Web UI backing tests.
 *
 * These tests cover the gaps left by tests/mobile-pairing.test.js once the
 * web dashboard gained an admin-only "Mobile Devices" section:
 *   - STAFF must be rejected (403) from the device list and revoke endpoints,
 *     not just from pairing-code creation (already covered elsewhere).
 *   - The list/revoke responses consumed by the new UI never leak the raw
 *     device token or the token hash.
 *   - The dashboard's static assets (index.html / app.js) never reference or
 *     render a device token field, as a regression guard for the "do not
 *     expose the device token in the web UI" requirement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { handler, db } = require('../core');

function callApi({ method, url, body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method || 'GET';
    req.url = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}), ...headers };
    const res = {
      headers: {},
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
      end(payload) { resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : undefined }); }
    };
    handler(req, res).catch(reject);
    if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

async function login(email) {
  const res = await callApi({ method: 'POST', url: '/api/auth/login', body: { email, password: 'MediIndex@2026' } });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return res.headers['Set-Cookie'];
}

test('MOBUI-001: STAFF cannot list mobile devices (403)', async () => {
  const staffCookie = await login('staff@mediindex.local');
  const res = await callApi({ method: 'GET', url: '/api/mobile/devices', cookie: staffCookie });
  assert.equal(res.status, 403);
});

test('MOBUI-002: unauthenticated request cannot list mobile devices (401)', async () => {
  const res = await callApi({ method: 'GET', url: '/api/mobile/devices' });
  assert.equal(res.status, 401);
});

test('MOBUI-003: STAFF cannot revoke a device (403), even for an existing device id', async () => {
  const adminCookie = await login('admin@mediindex.local');
  const staffCookie = await login('staff@mediindex.local');

  const codeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
  assert.equal(codeRes.status, 201);
  const claimRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: { pairingCode: codeRes.body.pairingCode, deviceName: 'MOBUI Staff-Revoke-Test Device' }
  });
  assert.equal(claimRes.status, 201);
  const deviceId = claimRes.body.deviceId;

  const staffRevokeRes = await callApi({ method: 'POST', url: `/api/mobile/devices/${deviceId}/revoke`, cookie: staffCookie });
  assert.equal(staffRevokeRes.status, 403);

  // Device must remain active since the STAFF revoke attempt was rejected.
  const adminList = await callApi({ method: 'GET', url: '/api/mobile/devices', cookie: adminCookie });
  const device = adminList.body.devices.find(d => d.id === deviceId);
  assert.ok(device);
  assert.equal(device.revoked, 0);

  db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
});

test('MOBUI-004: device list response never includes a token or token_hash field', async () => {
  const adminCookie = await login('admin@mediindex.local');
  const codeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
  const claimRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: { pairingCode: codeRes.body.pairingCode, deviceName: 'MOBUI Token-Leak-Test Device' }
  });
  assert.equal(claimRes.status, 201);
  const deviceId = claimRes.body.deviceId;

  const listRes = await callApi({ method: 'GET', url: '/api/mobile/devices', cookie: adminCookie });
  assert.equal(listRes.status, 200);
  const device = listRes.body.devices.find(d => d.id === deviceId);
  assert.ok(device);
  for (const key of Object.keys(device)) {
    assert.doesNotMatch(key.toLowerCase(), /token/, `device list leaked a token-shaped field: ${key}`);
  }

  db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
});

test('MOBUI-005: revoke response never includes a token or token_hash field', async () => {
  const adminCookie = await login('admin@mediindex.local');
  const codeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
  const claimRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: { pairingCode: codeRes.body.pairingCode, deviceName: 'MOBUI Revoke-Response-Test Device' }
  });
  const deviceId = claimRes.body.deviceId;

  const revokeRes = await callApi({ method: 'POST', url: `/api/mobile/devices/${deviceId}/revoke`, cookie: adminCookie });
  assert.equal(revokeRes.status, 200);
  const serialized = JSON.stringify(revokeRes.body).toLowerCase();
  assert.doesNotMatch(serialized, /medidev_/, 'revoke response leaked a raw device token');
  assert.ok(!('token_hash' in (revokeRes.body.device || {})), 'revoke response leaked token_hash');

  db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
});

test('MOBUI-006: pairing-code creation response never includes a device token (only the one-time code)', async () => {
  const adminCookie = await login('admin@mediindex.local');
  const codeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
  assert.equal(codeRes.status, 201);
  assert.ok(codeRes.body.pairingCode);
  assert.equal(codeRes.body.deviceToken, undefined);
  assert.equal(codeRes.body.token, undefined);
  assert.equal(codeRes.body.tokenHash, undefined);

  db.prepare('DELETE FROM device_pairing_codes WHERE pairing_code = ?').run(codeRes.body.pairingCode);
});

test('MOBUI-007: dashboard static assets never render or reference a device token field', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  // Guard against a future regression where someone wires up `res.deviceToken`,
  // `res.device.tokenHash`, or similar into the Mobile Devices UI.
  assert.doesNotMatch(appJs, /deviceToken/, 'app.js references a deviceToken field');
  assert.doesNotMatch(appJs, /token_hash/, 'app.js references a token_hash field');
  assert.doesNotMatch(indexHtml, /device.?token/i, 'index.html references a device token field');

  // The Mobile Devices section and its trigger must actually exist.
  assert.match(indexHtml, /id="mobile-devices-view"/);
  assert.match(indexHtml, /data-view="mobile-devices"/);
  assert.match(appJs, /loadMobileDevices/);
});
