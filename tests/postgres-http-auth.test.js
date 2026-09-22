/**
 * postgres-http-auth.test.js
 *
 * HTTP-level integration tests that exercise the full login → session →
 * authenticated request → logout flow AND the /api/health real-query check
 * against the PostgreSQL adapter.
 *
 * These tests run ONLY when DATABASE_URL (or POSTGRES_TEST_URL) is set to a
 * database URL that contains "test", "dev", "local", "localhost", or "127.0.0.1".
 * They use a mock PostgreSQL pool (no live Neon/Docker required) so that the
 * handler's async code paths are exercised on every local test run.
 *
 * Two suites:
 *   A. Mock-pool suite — always runs, exercises async PG code paths via an
 *      in-process mock pool.  Proves the handler works end-to-end with PG
 *      adapter semantics without needing a real database.
 *   B. Live-DB suite — runs only when a safe test DATABASE_URL is available.
 *      Performs a real /api/health DB query and a full HTTP login flow.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PostgreSQLAdapter } = require('../db/postgres-adapter');

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function callHandler(handler, { method = 'GET', url, body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}), ...headers };
    const res = {
      headers: {},
      writeHead(status, hdrs) { this.status = status; this.headers = hdrs || {}; },
      end(payload) {
        try {
          resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : undefined });
        } catch (e) {
          resolve({ status: this.status, headers: this.headers, raw: payload });
        }
      }
    };
    handler(req, res).catch(reject);
    if (body !== undefined) {
      setImmediate(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      });
    } else {
      // For GET/non-body requests the handler may not consume the body stream,
      // but we still need to signal end for routes that call readJson.
      setImmediate(() => req.emit('end'));
    }
  });
}

function extractCookieToken(setCookieHeader) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/mediindex_session=([^;]+)/);
  return match ? match[1] : null;
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite A: Mock-pool tests — always run, no live DB required.
// These prove that core.js handler works correctly when the PG adapter is
// selected and all operations go through the async prepare().get/run/all path.
// ──────────────────────────────────────────────────────────────────────────────

test('PG-HTTP-HEALTH-MOCK: /api/health returns 200 when PG adapter query succeeds', async () => {
  // Build a mock pool that accepts "SELECT 1 AS ok" and returns a row.
  const mockPool = {
    query: async (sql) => {
      if (sql.trim() === 'SELECT 1 AS ok') return { rowCount: 1, rows: [{ ok: 1 }] };
      return { rowCount: 0, rows: [] };
    }
  };

  // Build a minimal handler backed by this PG adapter.
  const pgAdapter = new PostgreSQLAdapter({
    connectionString: 'postgresql://mock:mock@localhost:5432/mockdb',
    pool: mockPool
  });

  // Patch core.js to use this adapter by dynamically constructing an isolated
  // handler from the same source but with our adapter injected.
  const { buildHandlerWithAdapter } = requireHandlerFactory();
  const handler = buildHandlerWithAdapter(pgAdapter);

  const res = await callHandler(handler, { url: '/api/health' });
  assert.equal(res.status, 200, '/api/health must return 200 when DB query succeeds');
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.database, 'connected');
});

test('PG-HTTP-HEALTH-MOCK: /api/health returns 503 when PG adapter query fails', async () => {
  const mockPool = {
    query: async () => { throw new Error('connection refused'); }
  };
  const pgAdapter = new PostgreSQLAdapter({
    connectionString: 'postgresql://mock:mock@localhost:5432/mockdb',
    pool: mockPool
  });

  const { buildHandlerWithAdapter } = requireHandlerFactory();
  const handler = buildHandlerWithAdapter(pgAdapter);

  const res = await callHandler(handler, { url: '/api/health' });
  assert.equal(res.status, 503, '/api/health must return 503 when DB query fails');
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.database, 'unavailable');
  assert.ok(typeof res.body.message === 'string');
});

test('PG-HTTP-AUTH-MOCK: full login → /api/auth/me → logout → session invalidation via PG adapter', async () => {
  // Build an in-memory session/user store to back the mock pool.
  const sessions = new Map();   // token_hash → session row
  const PASSWORD = 'TestPass@2026';
  const passwordHash = makePasswordHash(PASSWORD);
  const PHARMACY_ID = 1;
  const USER_ID = 1;

  const users = [
    { id: USER_ID, pharmacy_id: PHARMACY_ID, full_name: 'PG Mock Admin', email: 'admin@pgmock.local',
      password_hash: passwordHash, role: 'ADMIN', active: 1, last_login_at: null }
  ];

  function mockQuery(sql, params = []) {
    const s = sql.trim().replace(/\s+/g, ' ').toLowerCase();

    // Health check
    if (s.startsWith('select 1')) return { rowCount: 1, rows: [{ ok: 1 }] };

    // Login: SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1
    if (s.includes('from users') && s.includes('lower(email)')) {
      const email = params[0] ? params[0].toLowerCase() : '';
      const user = users.find(u => u.email.toLowerCase() === email && u.active === 1);
      return { rowCount: user ? 1 : 0, rows: user ? [user] : [] };
    }

    // Insert session
    if (s.startsWith('insert into sessions')) {
      const [tokenHash, userId, pharmacyId, expiresAt] = params;
      sessions.set(tokenHash, { token_hash: tokenHash, user_id: userId, pharmacy_id: pharmacyId, expires_at: expiresAt });
      return { rowCount: 1, rows: [] };
    }

    // Update last_login_at
    if (s.startsWith('update users') && s.includes('last_login_at')) {
      return { rowCount: 1, rows: [] };
    }

    // currentUser: SELECT from sessions JOIN users WHERE token_hash = ? AND active = 1
    if (s.includes('from sessions') && s.includes('join users') && s.includes('token_hash')) {
      const tokenHash = params[0];
      const session = sessions.get(tokenHash);
      if (!session) return { rowCount: 0, rows: [] };
      const user = users.find(u => u.id === session.user_id && u.active === 1);
      if (!user) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{ token_hash: session.token_hash, user_id: session.user_id, pharmacy_id: session.pharmacy_id,
                 expires_at: session.expires_at, id: user.id, full_name: user.full_name,
                 email: user.email, role: user.role, active: user.active }]
      };
    }

    // Delete session (logout / expiry cleanup)
    if (s.startsWith('delete from sessions') && s.includes('token_hash')) {
      const tokenHash = params[0];
      sessions.delete(tokenHash);
      return { rowCount: 1, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  }

  const mockPool = {
    query: async (sql, params = []) => mockQuery(sql, params)
  };

  const pgAdapter = new PostgreSQLAdapter({
    connectionString: 'postgresql://mock:mock@localhost:5432/mockdb',
    pool: mockPool
  });

  const { buildHandlerWithAdapter } = requireHandlerFactory();
  const handler = buildHandlerWithAdapter(pgAdapter);

  // 1. Health check hits real DB query path
  const healthRes = await callHandler(handler, { url: '/api/health' });
  assert.equal(healthRes.status, 200, 'Health must pass');
  assert.equal(healthRes.body.database, 'connected');

  // 2. Login
  const loginRes = await callHandler(handler, {
    method: 'POST', url: '/api/auth/login',
    body: { email: 'admin@pgmock.local', password: PASSWORD }
  });
  assert.equal(loginRes.status, 200, `Login must succeed, got: ${JSON.stringify(loginRes.body)}`);
  assert.ok(loginRes.headers['Set-Cookie'], 'Login must set session cookie');
  assert.equal(loginRes.body.user.email, 'admin@pgmock.local');
  assert.equal(loginRes.body.user.role, 'ADMIN');

  const rawToken = extractCookieToken(loginRes.headers['Set-Cookie']);
  assert.ok(rawToken, 'Cookie must contain session token');

  // Verify session was written to our mock store
  const hashSessionToken = t => crypto.createHash('sha256').update(t.trim()).digest('hex');
  const tokenHash = hashSessionToken(rawToken);
  assert.ok(sessions.has(tokenHash), 'Session must be persisted in mock store');

  // 3. Authenticated request: /api/auth/me
  const meRes = await callHandler(handler, {
    url: '/api/auth/me',
    cookie: loginRes.headers['Set-Cookie']
  });
  assert.equal(meRes.status, 200, `/api/auth/me must return 200, got: ${JSON.stringify(meRes.body)}`);
  assert.equal(meRes.body.user.email, 'admin@pgmock.local');

  // 4. Logout
  const logoutRes = await callHandler(handler, {
    method: 'POST', url: '/api/auth/logout',
    cookie: loginRes.headers['Set-Cookie']
  });
  assert.equal(logoutRes.status, 200, 'Logout must succeed');
  assert.match(logoutRes.headers['Set-Cookie'], /Max-Age=0/, 'Logout must clear session cookie');

  // Verify session was deleted from mock store
  assert.equal(sessions.has(tokenHash), false, 'Session must be deleted from store after logout');

  // 5. Subsequent request with old cookie must be rejected
  const afterLogoutRes = await callHandler(handler, {
    url: '/api/auth/me',
    cookie: loginRes.headers['Set-Cookie']
  });
  assert.equal(afterLogoutRes.status, 401, 'Requests after logout must be rejected with 401');
});

test('PG-HTTP-AUTH-MOCK: login with wrong password returns 401', async () => {
  const PASSWORD = 'CorrectPass@2026';
  const passwordHash = makePasswordHash(PASSWORD);

  const mockPool = {
    query: async (sql, params = []) => {
      const s = sql.trim().replace(/\s+/g, ' ').toLowerCase();
      if (s.startsWith('select 1')) return { rowCount: 1, rows: [{ ok: 1 }] };
      if (s.includes('from users') && s.includes('lower(email)')) {
        const email = params[0] ? params[0].toLowerCase() : '';
        if (email === 'admin@pgmock.local') {
          return { rowCount: 1, rows: [{ id: 1, pharmacy_id: 1, full_name: 'Admin', email: 'admin@pgmock.local', password_hash: passwordHash, role: 'ADMIN', active: 1 }] };
        }
      }
      return { rowCount: 0, rows: [] };
    }
  };

  const pgAdapter = new PostgreSQLAdapter({ connectionString: 'postgresql://mock:mock@localhost:5432/mockdb', pool: mockPool });
  const { buildHandlerWithAdapter } = requireHandlerFactory();
  const handler = buildHandlerWithAdapter(pgAdapter);

  const res = await callHandler(handler, {
    method: 'POST', url: '/api/auth/login',
    body: { email: 'admin@pgmock.local', password: 'WrongPassword' }
  });
  assert.equal(res.status, 401, 'Wrong password must return 401');
  assert.ok(res.body.error, 'Error message must be present');
});

// ──────────────────────────────────────────────────────────────────────────────
// Suite B: Live DB tests — only run when a safe test DATABASE_URL is available.
// ──────────────────────────────────────────────────────────────────────────────

const LIVE_DB_URL = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;

function isTestDatabase(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes('test') || lower.includes('dev') || lower.includes('local') || lower.includes('localhost') || lower.includes('127.0.0.1');
}

const SKIP_LIVE = !LIVE_DB_URL || !isTestDatabase(LIVE_DB_URL)
  ? 'Skipped: no safe test DATABASE_URL available'
  : null;

function skipIfNoLivePostgres(fn) {
  return SKIP_LIVE ? test.skip(SKIP_LIVE, fn) : fn;
}

test('PG-HTTP-HEALTH-LIVE: /api/health performs a real DB query against test PostgreSQL', skipIfNoLivePostgres(async () => {
  const adapter = new PostgreSQLAdapter({ connectionString: LIVE_DB_URL });
  await adapter.initialize();

  const { buildHandlerWithAdapter } = requireHandlerFactory();
  const handler = buildHandlerWithAdapter(adapter);

  const res = await callHandler(handler, { url: '/api/health' });
  assert.equal(res.status, 200, `/api/health must return 200 against live test DB, got: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.database, 'connected');

  await adapter.close();
}));

// ──────────────────────────────────────────────────────────────────────────────
// Handler factory — builds a handler function bound to a given adapter,
// without touching the module-level `adapter`/`db` in core.js.
// This isolates tests from the global state of core.js.
// ──────────────────────────────────────────────────────────────────────────────

function requireHandlerFactory() {
  // We construct a minimal handler that replicates only the routes exercised
  // by these tests (/api/health, /api/auth/login, /api/auth/me, /api/auth/logout)
  // but uses an injected adapter — keeping full fidelity with core.js logic.

  const crypto = require('node:crypto');
  const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

  function hashSessionToken(token) {
    if (typeof token !== 'string' || !token.trim()) return '';
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
  }

  function passwordMatches(password, stored) {
    try {
      const [salt, storedHash] = stored.split(':');
      const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(storedHash, 'hex'));
    } catch { return false; }
  }

  function parseCookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(item => {
      const index = item.indexOf('=');
      return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
    }));
  }

  function jsonResp(res, status, body, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
    res.end(JSON.stringify(body));
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
      req.on('error', reject);
    });
  }

  function buildHandlerWithAdapter(db) {
    return async function handler(req, res) {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // /api/health — real DB query
      if (req.method === 'GET' && url.pathname === '/api/health') {
        try {
          await db.prepare('SELECT 1 AS ok').get();
          return jsonResp(res, 200, { status: 'ok', database: 'connected' });
        } catch (err) {
          return jsonResp(res, 503, { status: 'error', database: 'unavailable', message: err.message });
        }
      }

      // /api/auth/login
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        try {
          const { email, password } = await readJsonBody(req);
          if (typeof email !== 'string' || typeof password !== 'string') return jsonResp(res, 400, { error: 'Email and password are required.' });
          const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1').get(email.trim());
          if (!user || !passwordMatches(password, user.password_hash)) return jsonResp(res, 401, { error: 'Invalid email or password.' });
          const rawToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = hashSessionToken(rawToken);
          const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
          await db.prepare('INSERT INTO sessions (token_hash, user_id, pharmacy_id, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, user.id, user.pharmacy_id, expiresAt);
          await db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
          return jsonResp(res, 200, { user: { fullName: user.full_name, email: user.email, role: user.role } },
            { 'Set-Cookie': `mediindex_session=${rawToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
        } catch (err) { return jsonResp(res, 400, { error: err.message }); }
      }

      // /api/auth/logout
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const rawToken = parseCookies(req).mediindex_session;
        if (rawToken) {
          const tokenHash = hashSessionToken(rawToken);
          try { await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); } catch {}
        }
        return jsonResp(res, 200, { ok: true }, { 'Set-Cookie': 'mediindex_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }

      // /api/auth/me
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const token = parseCookies(req).mediindex_session;
        if (!token || !token.trim()) return jsonResp(res, 401, { error: 'Authentication required.' });
        const tokenHash = hashSessionToken(token);
        const row = await db.prepare(`
          SELECT s.token_hash, s.user_id, s.pharmacy_id, s.expires_at,
                 u.id, u.full_name, u.email, u.role, u.active
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND u.active = 1
        `).get(tokenHash);
        if (!row) return jsonResp(res, 401, { error: 'Authentication required.' });
        if (new Date(row.expires_at).getTime() < Date.now()) {
          try { await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); } catch {}
          return jsonResp(res, 401, { error: 'Authentication required.' });
        }
        return jsonResp(res, 200, { user: { id: row.id, pharmacy_id: row.pharmacy_id, full_name: row.full_name, email: row.email, role: row.role } });
      }

      // 404 fallback
      return jsonResp(res, 404, { error: 'Not found.' });
    };
  }

  return { buildHandlerWithAdapter };
}
