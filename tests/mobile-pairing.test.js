const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handler, passwordHash, hashDeviceToken, db } = require('../core');

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

test('Mobile Device Pairing: Access Control on Pairing Code Generation (ADMIN only)', async () => {
  // 1. Unauthenticated request must be rejected (401)
  const unauthRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create' });
  assert.equal(unauthRes.status, 401);

  // 2. STAFF login
  const staffLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' } });
  assert.equal(staffLogin.status, 200);
  const staffCookie = staffLogin.headers['Set-Cookie'];

  // STAFF cannot generate pairing code (403 Forbidden)
  const staffCreateRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: staffCookie });
  assert.equal(staffCreateRes.status, 403);

  // 3. ADMIN login
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers['Set-Cookie'];

  // ADMIN can generate pairing code (201 Created)
  const adminCreateRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
  assert.equal(adminCreateRes.status, 201);
  assert.ok(adminCreateRes.body.pairingCode);
  assert.ok(adminCreateRes.body.pairingCode.startsWith('MED-'));
  assert.equal(adminCreateRes.body.expiresInSeconds, 600);
  assert.ok(adminCreateRes.body.expiresAt);

  // Clean up
  db.prepare('DELETE FROM device_pairing_codes WHERE pairing_code = ?').run(adminCreateRes.body.pairingCode);
});

test('Mobile Device Pairing: End-to-End Pairing Flow, Token Issuance, and Security Storage', async () => {
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  // 1. Admin generates pairing code
  const codeRes = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: adminCookie });
  assert.equal(codeRes.status, 201);
  const pairingCode = codeRes.body.pairingCode;

  // 2. Mobile device claims pairing code
  const claimRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: {
      pairingCode,
      deviceName: 'Warehouse Scanner A1',
      deviceModel: 'Zebra TC26'
    }
  });

  assert.equal(claimRes.status, 201);
  assert.equal(claimRes.body.success, true);
  assert.equal(claimRes.body.deviceName, 'Warehouse Scanner A1');
  assert.ok(claimRes.body.deviceId);
  assert.ok(claimRes.body.deviceToken);
  assert.ok(claimRes.body.deviceToken.startsWith('medidev_'));
  assert.equal(claimRes.body.pharmacy.name, 'MediIndex Demo Pharmacy');

  const rawToken = claimRes.body.deviceToken;
  const deviceId = claimRes.body.deviceId;

  // 3. Verify security: Raw device token is NEVER stored in database plaintext
  const storedDevice = db.prepare('SELECT * FROM paired_devices WHERE id = ?').get(deviceId);
  assert.ok(storedDevice);
  assert.notEqual(storedDevice.token_hash, rawToken);
  assert.equal(storedDevice.token_hash, hashDeviceToken(rawToken));

  // 4. Verify device authentication via X-Device-Token header
  const verifyRes = await callApi({
    method: 'GET',
    url: '/api/mobile/auth/verify',
    headers: { 'x-device-token': rawToken }
  });
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.body.valid, true);
  assert.equal(verifyRes.body.device.id, deviceId);
  assert.equal(verifyRes.body.device.name, 'Warehouse Scanner A1');
  assert.equal(verifyRes.body.pharmacy.name, 'MediIndex Demo Pharmacy');

  // 5. Verify device authentication via Authorization Bearer header
  const verifyBearerRes = await callApi({
    method: 'GET',
    url: '/api/mobile/auth/verify',
    headers: { 'authorization': `Bearer ${rawToken}` }
  });
  assert.equal(verifyBearerRes.status, 200);
  assert.equal(verifyBearerRes.body.valid, true);

  // 6. Invalid token rejection
  const invalidTokenRes = await callApi({
    method: 'GET',
    url: '/api/mobile/auth/verify',
    headers: { 'x-device-token': 'medidev_fake_invalid_token_1234567890' }
  });
  assert.equal(invalidTokenRes.status, 401);

  // 7. Single-use guarantee: Re-using the same pairing code must fail
  const reuseRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: {
      pairingCode,
      deviceName: 'Rogue Device Copy'
    }
  });
  assert.equal(reuseRes.status, 400);
  assert.match(reuseRes.body.error, /already been used|claimed/i);

  // 8. Invalid / non-existent pairing code rejection
  const badCodeRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: {
      pairingCode: 'MED-NONEXISTENT',
      deviceName: 'Invalid Code Test'
    }
  });
  assert.equal(badCodeRes.status, 400);
  assert.match(badCodeRes.body.error, /Invalid or unrecognized/i);

  // Clean up
  db.prepare('DELETE FROM paired_devices WHERE id = ?').run(deviceId);
  db.prepare('DELETE FROM device_pairing_codes WHERE pairing_code = ?').run(pairingCode);
});

test('Mobile Device Pairing: Code Expiration Lifecycle', async () => {
  const crypto = require('node:crypto');
  const adminLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const adminCookie = adminLogin.headers['Set-Cookie'];

  // Insert an already-expired pairing code with a dynamic unique PIN
  const expiredCode = 'MED-EXP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const pastDate = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute in the past
  const pharmacyId = 1;
  const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@mediindex.local'").get();

  const insertRes = db.prepare(`
    INSERT INTO device_pairing_codes (pharmacy_id, pairing_code, created_by, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(pharmacyId, expiredCode, adminUser.id, pastDate);

  // Attempt to claim expired code
  const claimRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: {
      pairingCode: expiredCode,
      deviceName: 'Expired Code Device'
    }
  });

  assert.equal(claimRes.status, 400);
  assert.match(claimRes.body.error, /expired/i);

  // Clean up
  db.prepare('DELETE FROM device_pairing_codes WHERE id = ?').run(Number(insertRes.lastInsertRowid));
});

test('Mobile Device Pairing: Device Management, Revocation, and Multi-Tenant Isolation', async () => {
  // 1. Create a secondary pharmacy and secondary admin for multi-tenancy testing
  db.prepare("INSERT INTO pharmacies (name, address) VALUES ('Secondary Branch Pharmacy', 'Pune')").run();
  const secondaryPharmacy = db.prepare("SELECT id FROM pharmacies WHERE name = 'Secondary Branch Pharmacy'").get();
  const secondaryAdminHash = passwordHash('MediIndex@2026');
  db.prepare("INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, 'Branch Admin', 'branch@mediindex.local', ?, 'ADMIN')").run(secondaryPharmacy.id, secondaryAdminHash);

  // Login as primary admin
  const primaryLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' } });
  const primaryCookie = primaryLogin.headers['Set-Cookie'];

  // Login as secondary admin
  const secondaryLogin = await callApi({ method: 'POST', url: '/api/auth/login', body: { email: 'branch@mediindex.local', password: 'MediIndex@2026' } });
  const secondaryCookie = secondaryLogin.headers['Set-Cookie'];

  // 2. Primary admin pairs a device for Pharmacy 1
  const code1Res = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: primaryCookie });
  const claim1Res = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: { pairingCode: code1Res.body.pairingCode, deviceName: 'Primary Pharmacy iPad' }
  });
  assert.equal(claim1Res.status, 201);
  const primaryDeviceId = claim1Res.body.deviceId;
  const primaryToken = claim1Res.body.deviceToken;

  // 3. Secondary admin pairs a device for Pharmacy 2
  const code2Res = await callApi({ method: 'POST', url: '/api/mobile/pairing/create', cookie: secondaryCookie });
  const claim2Res = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: { pairingCode: code2Res.body.pairingCode, deviceName: 'Branch Pharmacy Android' }
  });
  assert.equal(claim2Res.status, 201);
  const secondaryDeviceId = claim2Res.body.deviceId;
  const secondaryToken = claim2Res.body.deviceToken;

  // 4. Primary admin lists devices: must see primary device, MUST NOT see secondary device
  const primaryDevicesList = await callApi({ method: 'GET', url: '/api/mobile/devices', cookie: primaryCookie });
  assert.equal(primaryDevicesList.status, 200);
  const hasPrimary = primaryDevicesList.body.devices.some(d => d.id === primaryDeviceId);
  const hasSecondaryInPrimary = primaryDevicesList.body.devices.some(d => d.id === secondaryDeviceId);
  assert.equal(hasPrimary, true);
  assert.equal(hasSecondaryInPrimary, false, 'Tenant isolation violation: Primary admin saw secondary pharmacy device');

  // Verify list never leaks token_hash
  assert.equal(primaryDevicesList.body.devices[0].token_hash, undefined);

  // 5. Cross-Tenant Revocation Protection: Primary admin attempts to revoke Secondary Pharmacy device (must return 404)
  const illegalRevokeRes = await callApi({
    method: 'POST',
    url: `/api/mobile/devices/${secondaryDeviceId}/revoke`,
    cookie: primaryCookie
  });
  assert.equal(illegalRevokeRes.status, 404);

  // 6. Valid Device Revocation by Owner
  const validRevokeRes = await callApi({
    method: 'POST',
    url: `/api/mobile/devices/${primaryDeviceId}/revoke`,
    cookie: primaryCookie
  });
  assert.equal(validRevokeRes.status, 200);
  assert.equal(validRevokeRes.body.ok, true);

  // 7. Revoked device immediately rejected from mobile verification endpoint (401 Unauthorized)
  const postRevokeAuthRes = await callApi({
    method: 'GET',
    url: '/api/mobile/auth/verify',
    headers: { 'x-device-token': primaryToken }
  });
  assert.equal(postRevokeAuthRes.status, 401);
  assert.match(postRevokeAuthRes.body.error, /Invalid or revoked/i);

  // Secondary device remains valid
  const secondaryAuthRes = await callApi({
    method: 'GET',
    url: '/api/mobile/auth/verify',
    headers: { 'x-device-token': secondaryToken }
  });
  assert.equal(secondaryAuthRes.status, 200);
  assert.equal(secondaryAuthRes.body.valid, true);
  assert.equal(secondaryAuthRes.body.pharmacy.name, 'Secondary Branch Pharmacy');

  // Clean up secondary pharmacy
  db.prepare('DELETE FROM paired_devices WHERE pharmacy_id = ?').run(secondaryPharmacy.id);
  db.prepare('DELETE FROM device_pairing_codes WHERE pharmacy_id = ?').run(secondaryPharmacy.id);
  db.prepare('DELETE FROM users WHERE pharmacy_id = ?').run(secondaryPharmacy.id);
  db.prepare('DELETE FROM pharmacies WHERE id = ?').run(secondaryPharmacy.id);
});
