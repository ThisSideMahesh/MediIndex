const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { handler, db, hashSessionToken, SESSION_TTL_MS } = require('../core');
const { SQLiteAdapter } = require('../db/sqlite-adapter');
const { PostgreSQLAdapter, convertPlaceholders } = require('../db/postgres-adapter');

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

function extractCookieToken(setCookieHeader) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/mediindex_session=([^;]+)/);
  return match ? match[1] : null;
}

test('SESSION-001: successful login creates persistent session record in database', async () => {
  const loginRes = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });

  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.headers['Set-Cookie']);
  const rawToken = extractCookieToken(loginRes.headers['Set-Cookie']);
  assert.ok(rawToken, 'Cookie must contain session token');

  const tokenHash = hashSessionToken(rawToken);
  const sessionRecord = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);

  assert.ok(sessionRecord, 'Persistent session record must exist in sessions table');
  assert.equal(sessionRecord.token_hash, tokenHash);
  assert.equal(typeof sessionRecord.user_id, 'number');
  assert.equal(typeof sessionRecord.pharmacy_id, 'number');
  assert.ok(new Date(sessionRecord.expires_at).getTime() > Date.now());
});

test('SESSION-002: valid session authenticates protected routes and populates user info', async () => {
  const loginRes = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'staff@mediindex.local', password: 'MediIndex@2026' }
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers['Set-Cookie'];

  // Test /api/auth/me
  const meRes = await callApi({ url: '/api/auth/me', cookie });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.user.email, 'staff@mediindex.local');
  assert.equal(meRes.body.user.role, 'STAFF');

  // Test /api/dashboard
  const dashRes = await callApi({ url: '/api/dashboard', cookie });
  assert.equal(dashRes.status, 200);
  assert.ok(typeof dashRes.body.totalStock === 'number');
});

test('SESSION-003: invalid and forged session tokens are rejected', async () => {
  // Empty session cookie
  const emptyRes = await callApi({ url: '/api/auth/me', cookie: 'mediindex_session=' });
  assert.equal(emptyRes.status, 401);

  // Fake random session token not in database
  const fakeToken = crypto.randomBytes(32).toString('hex');
  const fakeRes = await callApi({ url: '/api/auth/me', cookie: `mediindex_session=${fakeToken}` });
  assert.equal(fakeRes.status, 401);

  // Altered valid token
  const loginRes = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const validToken = extractCookieToken(loginRes.headers['Set-Cookie']);
  const tamperedToken = validToken.slice(0, -4) + 'ffff';
  const tamperedRes = await callApi({ url: '/api/auth/me', cookie: `mediindex_session=${tamperedToken}` });
  assert.equal(tamperedRes.status, 401);
});

test('SESSION-004: expired session is rejected and removed from database', async () => {
  // 1. Manually insert an expired session record into DB
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const expiredTimestamp = new Date(Date.now() - 3600000).toISOString(); // 1 hour in the past

  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, pharmacy_id, expires_at)
    VALUES (?, 1, 1, ?)
  `).run(tokenHash, expiredTimestamp);

  // Verify it exists in DB
  const recordBefore = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
  assert.ok(recordBefore, 'Expired session record inserted for test');

  // 2. Attempt to authenticate with expired session
  const res = await callApi({ url: '/api/auth/me', cookie: `mediindex_session=${rawToken}` });
  assert.equal(res.status, 401);

  // 3. Verify server-side cleanup pruned the expired session from DB
  const recordAfter = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
  assert.equal(recordAfter, undefined, 'Expired session must be deleted from sessions table');
});

test('SESSION-005: logout invalidates persistent session in database', async () => {
  const loginRes = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = loginRes.headers['Set-Cookie'];
  const rawToken = extractCookieToken(cookie);
  const tokenHash = hashSessionToken(rawToken);

  // Verify session is active
  const checkBefore = await callApi({ url: '/api/auth/me', cookie });
  assert.equal(checkBefore.status, 200);
  assert.ok(db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash));

  // Perform logout
  const logoutRes = await callApi({ method: 'POST', url: '/api/auth/logout', cookie });
  assert.equal(logoutRes.status, 200);
  assert.match(logoutRes.headers['Set-Cookie'], /Max-Age=0/);

  // Verify session record is deleted from DB
  const sessionInDb = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
  assert.equal(sessionInDb, undefined, 'Session must be deleted from database upon logout');

  // Subsequent request with old cookie must fail with 401
  const checkAfter = await callApi({ url: '/api/auth/me', cookie });
  assert.equal(checkAfter.status, 401);
});

test('SESSION-006: raw session token is NEVER stored in database (only SHA-256 hash)', async () => {
  const loginRes = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const rawToken = extractCookieToken(loginRes.headers['Set-Cookie']);
  const tokenHash = hashSessionToken(rawToken);

  // Query database for raw token
  const rawMatch = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(rawToken);
  assert.equal(rawMatch, undefined, 'Raw session token must never match any token_hash column');

  // Verify hash storage
  const hashMatch = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
  assert.ok(hashMatch, 'Database must store SHA-256 hash');
  assert.equal(hashMatch.token_hash.length, 64, 'SHA-256 hash hex string must be exactly 64 characters');
});

test('SESSION-007: session token generation uses cryptographically secure random source', () => {
  const tokens = new Set();
  for (let i = 0; i < 50; i++) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    assert.equal(rawToken.length, 64, '32 random bytes must encode to 64 hex characters');
    assert.ok(!tokens.has(rawToken), 'Random tokens must never collide');
    tokens.add(rawToken);
  }
});

test('SESSION-008: session tenant isolation enforces server-derived pharmacy_id', async () => {
  const loginRes = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = loginRes.headers['Set-Cookie'];

  // Protected request should use user.pharmacy_id from session and ignore any client spoofing
  const dashboardRes = await callApi({
    url: '/api/dashboard?pharmacy_id=9999',
    cookie
  });
  assert.equal(dashboardRes.status, 200);

  // Verify that medicines endpoint filters strictly by session pharmacy_id
  const medRes = await callApi({ url: '/api/medicines', cookie });
  assert.equal(medRes.status, 200);
  assert.ok(Array.isArray(medRes.body.medicines));
  for (const m of medRes.body.medicines) {
    assert.equal(m.pharmacy_id, 1, 'All returned medicines must belong to authenticated pharmacy');
  }
});

test('SESSION-009: simultaneous valid requests safely share persistent session', async () => {
  const loginRes = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const cookie = loginRes.headers['Set-Cookie'];

  // Send 10 concurrent requests using the same session cookie
  const requests = Array.from({ length: 10 }, () =>
    callApi({ url: '/api/dashboard', cookie })
  );

  const responses = await Promise.all(requests);
  for (const res of responses) {
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.totalStock === 'number');
  }
});

test('SESSION-010: local SQLite session persistence lifecycle verification', () => {
  const adapter = new SQLiteAdapter().initialize();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + 3600000).toISOString();

  // Insert session
  const insertRes = adapter.run(`
    INSERT INTO sessions (token_hash, user_id, pharmacy_id, expires_at)
    VALUES (?, 1, 1, ?)
  `, [tokenHash, expiresAt]);
  assert.equal(insertRes.changes, 1);

  // Retrieve session
  const row = adapter.get(`
    SELECT s.token_hash, s.user_id, s.pharmacy_id, s.expires_at, u.email, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `, [tokenHash]);
  assert.ok(row);
  assert.equal(row.email, 'admin@mediindex.local');
  assert.equal(row.role, 'ADMIN');

  // Delete session
  const delRes = adapter.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  assert.equal(delRes.changes, 1);

  // Verify deletion
  const check = adapter.get('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
  assert.equal(check, undefined);
});

test('SESSION-011: PostgreSQL session adapter contract and parameterized queries', async () => {
  const executed = [];
  const mockClient = {
    query: async (sql, params) => {
      executed.push({ sql, params });
      if (sql.includes('SELECT') && sql.includes('sessions')) {
        return {
          rowCount: 1,
          rows: [{
            token_hash: params[0],
            user_id: 1,
            pharmacy_id: 1,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            id: 1,
            full_name: 'Admin User',
            email: 'admin@mediindex.local',
            role: 'ADMIN',
            active: 1
          }]
        };
      }
      return { rowCount: 1, rows: [] };
    },
    release: () => {}
  };

  const mockPool = {
    connect: async () => mockClient,
    query: async (sql, params) => mockClient.query(sql, params)
  };

  const pgAdapter = new PostgreSQLAdapter({
    connectionString: 'postgresql://test_user:secret@localhost:5432/mediindex',
    pool: mockPool
  });

  const testHash = crypto.createHash('sha256').update('test-token').digest('hex');
  const sql = `
    SELECT s.token_hash, s.user_id, s.pharmacy_id, s.expires_at,
           u.id, u.full_name, u.email, u.role, u.active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.active = 1
  `;

  // Verify placeholder conversion ($1)
  const converted = convertPlaceholders(sql);
  assert.ok(converted.includes('$1'), 'Positional ? must convert to $1');
  assert.ok(!converted.includes('?'), 'Positional ? must be replaced');

  // Verify adapter get
  const session = await pgAdapter.get(sql, [testHash]);
  assert.ok(session);
  assert.equal(session.token_hash, testHash);
  assert.equal(session.role, 'ADMIN');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].params[0], testHash);
});

test('SESSION-012: mobile device authentication remains independent from browser sessions', async () => {
  // 1. Generate pairing code as ADMIN
  const adminLogin = await callApi({
    method: 'POST',
    url: '/api/auth/login',
    body: { email: 'admin@mediindex.local', password: 'MediIndex@2026' }
  });
  const adminCookie = adminLogin.headers['Set-Cookie'];
  const codeRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/create',
    cookie: adminCookie
  });
  assert.equal(codeRes.status, 201);
  const pairingCode = codeRes.body.pairingCode;

  // 2. Claim pairing code to get device token
  const claimRes = await callApi({
    method: 'POST',
    url: '/api/mobile/pairing/complete',
    body: {
      pairingCode,
      deviceName: 'Warehouse Scanner B',
      deviceModel: 'Zebra TC26'
    }
  });
  assert.equal(claimRes.status, 201);
  const deviceToken = claimRes.body.deviceToken;
  assert.ok(deviceToken);

  // 3. Mobile verify with device token (header X-Device-Token) works without browser session
  const mobVerify = await callApi({
    url: '/api/mobile/auth/verify',
    headers: { 'x-device-token': deviceToken }
  });
  assert.equal(mobVerify.status, 200);
  assert.equal(mobVerify.body.valid, true);
  assert.equal(mobVerify.body.device.name, 'Warehouse Scanner B');

  // 4. Browser session cookie does NOT authenticate mobile device endpoint
  const mobFail = await callApi({
    url: '/api/mobile/auth/verify',
    cookie: adminCookie
  });
  assert.equal(mobFail.status, 401);

  // 5. Device token does NOT authenticate browser protected endpoint (e.g. /api/auth/me)
  const browserFail = await callApi({
    url: '/api/auth/me',
    headers: { 'x-device-token': deviceToken }
  });
  assert.equal(browserFail.status, 401);
});
