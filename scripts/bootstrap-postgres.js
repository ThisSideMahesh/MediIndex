/**
 * scripts/bootstrap-postgres.js
 *
 * One-time PostgreSQL bootstrap for a fresh MediIndex database.
 *
 * Usage:
 *   DATABASE_URL='postgresql://user:pass@host:5432/dbname' node scripts/bootstrap-postgres.js
 *
 * What it does (all operations are idempotent — safe to run more than once):
 *   1. Applies db/schema.pg.sql   — CREATE TABLE IF NOT EXISTS, idempotent
 *   2. Seeds demo pharmacy         — skipped if already present
 *   3. Seeds demo admin user       — ON CONFLICT (email) DO NOTHING
 *   4. Seeds demo staff user       — ON CONFLICT (email) DO NOTHING
 *
 * What it NEVER does:
 *   - Drop, truncate, or delete any existing application data
 *   - Print DATABASE_URL, passwords, password hashes, or any secrets
 *   - Modify the Vercel runtime or application startup path
 *
 * Prerequisites:
 *   - DATABASE_URL must be set in the environment
 *   - The target database must be reachable
 *   - node >= 22 (matches engines field in package.json)
 */

'use strict';

const fs      = require('node:fs');
const path    = require('node:path');
const crypto  = require('node:crypto');

// ─── Environment guard ────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  console.error('Usage: DATABASE_URL=\'postgresql://...\' node scripts/bootstrap-postgres.js');
  process.exit(1);
}

// ─── Adapter ──────────────────────────────────────────────────────────────────
// Use the project's own PostgreSQLAdapter — no new dependencies.
const { PostgreSQLAdapter } = require('../db/postgres-adapter');

// ─── Password hashing ─────────────────────────────────────────────────────────
// Must be identical to core.js passwordHash() and SQLiteAdapter.defaultPasswordHash().
// Algorithm: scrypt, 16-byte random hex salt, 64-byte output, stored as "salt:hash".
function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Verification counterpart — identical to core.js passwordMatches().
// Used only for local verification at the end of this script; never called in production.
function passwordMatches(password, stored) {
  const [salt, storedHash] = stored.split(':');
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(
    Buffer.from(actualHash,  'hex'),
    Buffer.from(storedHash,  'hex')
  );
}

// ─── Demo credentials (matches SQLiteAdapter.applySeedData exactly) ───────────
const DEMO_PHARMACY_NAME    = 'MediIndex Demo Pharmacy';
const DEMO_PHARMACY_ADDRESS = 'Chhatrapati Sambhajinagar';
const DEMO_USERS = [
  { fullName: 'Demo Administrator',  email: 'admin@mediindex.local',  role: 'ADMIN',  password: 'MediIndex@2026' },
  { fullName: 'Demo Pharmacy Staff', email: 'staff@mediindex.local', role: 'STAFF',  password: 'MediIndex@2026' },
];

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const adapter = new PostgreSQLAdapter({ connectionString: process.env.DATABASE_URL });
  adapter.initialize();   // synchronous — constructs pool, no network I/O

  // ── Step 1: Apply schema ──────────────────────────────────────────────────
  console.log('[1/3] Applying schema from db/schema.pg.sql ...');
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.pg.sql');
  const schemaSql  = fs.readFileSync(schemaPath, 'utf-8');
  await adapter.exec(schemaSql);
  console.log('      Schema applied (all CREATE TABLE IF NOT EXISTS — idempotent).');

  // ── Step 2 & 3: Seed demo pharmacy and users (atomic transaction) ─────────
  console.log('[2/3] Seeding demo pharmacy and users ...');

  await adapter.transaction(async (client) => {

    // ── Pharmacy ─────────────────────────────────────────────────────────────
    const existing = await client.get(
      'SELECT id FROM pharmacies WHERE name = ?',
      [DEMO_PHARMACY_NAME]
    );

    let pharmacyId;
    if (existing) {
      pharmacyId = existing.id;
      console.log(`      Pharmacy "${DEMO_PHARMACY_NAME}" already exists (id=${pharmacyId}) — skipped.`);
    } else {
      const result = await client.run(
        'INSERT INTO pharmacies (name, address) VALUES (?, ?) RETURNING id',
        [DEMO_PHARMACY_NAME, DEMO_PHARMACY_ADDRESS]
      );
      pharmacyId = result.lastInsertRowid;
      console.log(`      Pharmacy "${DEMO_PHARMACY_NAME}" created (id=${pharmacyId}).`);
    }

    // ── Users ─────────────────────────────────────────────────────────────────
    for (const u of DEMO_USERS) {
      // Check whether this email already exists (to give an accurate status message)
      const existingUser = await client.get(
        'SELECT id, role FROM users WHERE lower(email) = lower(?)',
        [u.email]
      );

      if (existingUser) {
        console.log(`      User "${u.email}" (${u.role}) already exists — skipped.`);
        continue;
      }

      // Compute hash only when actually inserting — avoids a scrypt call for existing users
      const hash = passwordHash(u.password);

      await client.run(
        `INSERT INTO users (pharmacy_id, full_name, email, password_hash, role)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (email) DO NOTHING`,
        [pharmacyId, u.fullName, u.email, hash, u.role]
      );
      console.log(`      User "${u.email}" (${u.role}) created.`);
    }
  });

  // ── Step 3: Verify (read-only — confirms the rows we just created/skipped) ─
  console.log('[3/3] Verifying seed data ...');

  const pharmacy = await adapter.get(
    'SELECT id, name FROM pharmacies WHERE name = ?',
    [DEMO_PHARMACY_NAME]
  );
  if (!pharmacy) throw new Error('Verification failed: demo pharmacy not found after seeding.');

  for (const u of DEMO_USERS) {
    const user = await adapter.get(
      'SELECT id, role, pharmacy_id, password_hash FROM users WHERE lower(email) = lower(?) AND active = 1',
      [u.email]
    );
    if (!user) throw new Error(`Verification failed: ${u.email} not found after seeding.`);
    if (user.role !== u.role) throw new Error(`Verification failed: ${u.email} has wrong role "${user.role}", expected "${u.role}".`);
    if (!passwordMatches(u.password, user.password_hash)) {
      throw new Error(`Verification failed: password for ${u.email} does not verify.`);
    }
    if (Number(user.pharmacy_id) !== Number(pharmacy.id)) {
      throw new Error(`Verification failed: ${u.email} pharmacy_id mismatch.`);
    }
    // Log only safe confirmation — no hash, no password
    console.log(`      Verified: ${u.email} (${user.role}) — password hash verified OK.`);
  }

  console.log('\nBootstrap completed successfully.');
  console.log('Credentials to log in:');
  console.log('  admin@mediindex.local  / MediIndex@2026  (ADMIN)');
  console.log('  staff@mediindex.local  / MediIndex@2026  (STAFF)');

  await adapter.close();
}

main().catch(err => {
  // Never print the error message if it might contain connection string details
  const safe = err.message
    ? err.message.replace(/postgresql?:\/\/[^\s]*/gi, '[REDACTED]')
    : String(err);
  console.error('\nBootstrap FAILED:', safe);
  process.exit(1);
});
