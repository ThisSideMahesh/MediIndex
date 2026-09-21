const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function defaultPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

class SQLiteAdapter {
  constructor(options = {}) {
    this.type = 'sqlite';
    this.dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    this.dbPath = options.dbPath || path.join(this.dataDir, 'mediindex.db');
    this.db = options.databaseSyncInstance || null;
    this.isInitialized = false;
  }

  initialize() {
    if (!this.db) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
    }
    this.applyPragmas();
    this.applySchema();
    this.applyMigrations();
    this.applySeedData();
    this.isInitialized = true;
    return this;
  }

  applyPragmas() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
  }

  applySchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pharmacies (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
        full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('ADMIN', 'STAFF')), active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS medicines (
        id INTEGER PRIMARY KEY, pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
        name TEXT NOT NULL, generic_name TEXT, manufacturer TEXT, category TEXT,
        minimum_stock INTEGER NOT NULL DEFAULT 0 CHECK(minimum_stock >= 0), active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines(name);
      CREATE TABLE IF NOT EXISTS medicine_batches (
        id INTEGER PRIMARY KEY, medicine_id INTEGER NOT NULL REFERENCES medicines(id),
        batch_number TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity >= 0),
        purchase_price REAL NOT NULL DEFAULT 0 CHECK(purchase_price >= 0),
        selling_price REAL NOT NULL CHECK(selling_price >= 0),
        manufacturing_date TEXT, expiry_date TEXT NOT NULL, location TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(medicine_id, batch_number)
      );
      CREATE INDEX IF NOT EXISTS idx_batches_expiry ON medicine_batches(expiry_date);
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES medicine_batches(id),
        change_quantity INTEGER NOT NULL CHECK(change_quantity != 0),
        reason TEXT NOT NULL CHECK(reason IN ('RECEIPT', 'ADJUSTMENT', 'SALE')),
        created_by INTEGER NOT NULL REFERENCES users(id),
        device_id INTEGER REFERENCES paired_devices(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_movements_batch ON inventory_movements(batch_id);
      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY, pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
        invoice_number TEXT NOT NULL UNIQUE, customer_name TEXT, customer_phone TEXT,
        payment_method TEXT NOT NULL DEFAULT 'CASH', total_amount REAL NOT NULL CHECK(total_amount >= 0),
        created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),
        batch_id INTEGER NOT NULL REFERENCES medicine_batches(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
        unit_price REAL NOT NULL CHECK(unit_price >= 0), line_total REAL NOT NULL CHECK(line_total >= 0)
      );
      CREATE TABLE IF NOT EXISTS expiry_alerts (
        id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES medicine_batches(id),
        alert_type TEXT NOT NULL CHECK(alert_type IN ('EXPIRED', 'EXPIRING_SOON', 'LOW_STOCK')),
        acknowledged INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_alert_once ON expiry_alerts(batch_id, alert_type);
      CREATE TABLE IF NOT EXISTS device_pairing_codes (
        id INTEGER PRIMARY KEY, pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
        pairing_code TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0, used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_codes_code ON device_pairing_codes(pairing_code);
      CREATE TABLE IF NOT EXISTS paired_devices (
        id INTEGER PRIMARY KEY, pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
        device_name TEXT NOT NULL, device_model TEXT, token_hash TEXT NOT NULL UNIQUE,
        paired_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_paired_devices_token ON paired_devices(token_hash);
      CREATE INDEX IF NOT EXISTS idx_paired_devices_pharmacy ON paired_devices(pharmacy_id);
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT NOT NULL,
        pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
        device_id INTEGER REFERENCES paired_devices(id),
        endpoint TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (key, pharmacy_id)
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_lookup ON idempotency_keys(key, pharmacy_id);
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS medicine_redistribution_requests (
        id                    INTEGER PRIMARY KEY,
        idempotency_key       TEXT NOT NULL UNIQUE,
        sender_pharmacy_id    INTEGER NOT NULL REFERENCES pharmacies(id),
        recipient_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
        medicine_id           INTEGER NOT NULL REFERENCES medicines(id),
        source_batch_id       INTEGER NOT NULL REFERENCES medicine_batches(id),
        requested_quantity    INTEGER NOT NULL CHECK(requested_quantity > 0),
        reason                TEXT NOT NULL DEFAULT 'NEAR_EXPIRY_REDISTRIBUTION',
        request_type          TEXT NOT NULL DEFAULT 'NEAR_EXPIRY'
                                CHECK(request_type IN ('NEAR_EXPIRY', 'MANUAL')),
        status                TEXT NOT NULL DEFAULT 'PENDING'
                                CHECK(status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
        automatic_request     INTEGER NOT NULL DEFAULT 0,
        automatic_acceptance  INTEGER NOT NULL DEFAULT 0,
        days_until_expiry     INTEGER,
        distance_km           REAL,
        notes                 TEXT,
        created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_redistrib_sender    ON medicine_redistribution_requests(sender_pharmacy_id);
      CREATE INDEX IF NOT EXISTS idx_redistrib_recipient ON medicine_redistribution_requests(recipient_pharmacy_id);
      CREATE INDEX IF NOT EXISTS idx_redistrib_batch     ON medicine_redistribution_requests(source_batch_id);
      CREATE INDEX IF NOT EXISTS idx_redistrib_status    ON medicine_redistribution_requests(status);
    `);
  }

  applyMigrations() {
    try {
      const movementCols = this.db.prepare('PRAGMA table_info(inventory_movements)').all().map(c => c.name);
      if (!movementCols.includes('device_id')) {
        this.db.exec('ALTER TABLE inventory_movements ADD COLUMN device_id INTEGER REFERENCES paired_devices(id)');
      }
      const cols = this.db.prepare('PRAGMA table_info(sales)').all().map(c => c.name);
      if (!cols.includes('customer_name')) this.db.exec('ALTER TABLE sales ADD COLUMN customer_name TEXT');
      if (!cols.includes('customer_phone')) this.db.exec('ALTER TABLE sales ADD COLUMN customer_phone TEXT');
      if (!cols.includes('payment_method')) this.db.exec("ALTER TABLE sales ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'CASH'");

      // Add geographic coordinates to pharmacies (nullable — existing rows keep NULL)
      const pharmCols = this.db.prepare('PRAGMA table_info(pharmacies)').all().map(c => c.name);
      if (!pharmCols.includes('latitude'))  this.db.exec('ALTER TABLE pharmacies ADD COLUMN latitude  REAL');
      if (!pharmCols.includes('longitude')) this.db.exec('ALTER TABLE pharmacies ADD COLUMN longitude REAL');

      // Medicine redistribution requests table (additive — safe for existing DBs)
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
      if (!tables.includes('medicine_redistribution_requests')) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS medicine_redistribution_requests (
            id                    INTEGER PRIMARY KEY,
            idempotency_key       TEXT NOT NULL UNIQUE,
            sender_pharmacy_id    INTEGER NOT NULL REFERENCES pharmacies(id),
            recipient_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
            medicine_id           INTEGER NOT NULL REFERENCES medicines(id),
            source_batch_id       INTEGER NOT NULL REFERENCES medicine_batches(id),
            requested_quantity    INTEGER NOT NULL CHECK(requested_quantity > 0),
            reason                TEXT NOT NULL DEFAULT 'NEAR_EXPIRY_REDISTRIBUTION',
            request_type          TEXT NOT NULL DEFAULT 'NEAR_EXPIRY'
                                    CHECK(request_type IN ('NEAR_EXPIRY', 'MANUAL')),
            status                TEXT NOT NULL DEFAULT 'PENDING'
                                    CHECK(status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
            automatic_request     INTEGER NOT NULL DEFAULT 0,
            automatic_acceptance  INTEGER NOT NULL DEFAULT 0,
            days_until_expiry     INTEGER,
            distance_km           REAL,
            notes                 TEXT,
            created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_redistrib_sender    ON medicine_redistribution_requests(sender_pharmacy_id);
          CREATE INDEX IF NOT EXISTS idx_redistrib_recipient ON medicine_redistribution_requests(recipient_pharmacy_id);
          CREATE INDEX IF NOT EXISTS idx_redistrib_batch     ON medicine_redistribution_requests(source_batch_id);
          CREATE INDEX IF NOT EXISTS idx_redistrib_status    ON medicine_redistribution_requests(status);
        `);
      }
    } catch {}
  }

  applySeedData() {
    const hasPharmacy = this.db.prepare('SELECT id FROM pharmacies LIMIT 1').get();
    if (!hasPharmacy) {
      this.db.prepare('INSERT INTO pharmacies (name, address) VALUES (?, ?)').run('MediIndex Demo Pharmacy', 'Chhatrapati Sambhajinagar');
      const pharmacy = this.db.prepare('SELECT id FROM pharmacies LIMIT 1').get();
      const addUser = this.db.prepare('INSERT INTO users (pharmacy_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
      addUser.run(pharmacy.id, 'Demo Administrator', 'admin@mediindex.local', defaultPasswordHash('MediIndex@2026'), 'ADMIN');
      addUser.run(pharmacy.id, 'Demo Pharmacy Staff', 'staff@mediindex.local', defaultPasswordHash('MediIndex@2026'), 'STAFF');
    }
  }

  query(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  get(sql, params = []) {
    return this.db.prepare(sql).get(...params);
  }

  run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  beginTransaction() {
    this.db.exec('BEGIN');
  }

  beginTransactionImmediate() {
    this.db.exec('BEGIN IMMEDIATE');
  }

  commit() {
    this.db.exec('COMMIT');
  }

  rollback() {
    this.db.exec('ROLLBACK');
  }

  async transaction(callback, isImmediate = false) {
    const startSql = isImmediate ? 'BEGIN IMMEDIATE' : 'BEGIN';
    this.db.exec(startSql);
    try {
      const result = await callback(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  close() {
    if (this.db && typeof this.db.close === 'function') {
      this.db.close();
    }
  }
}

module.exports = { SQLiteAdapter };
