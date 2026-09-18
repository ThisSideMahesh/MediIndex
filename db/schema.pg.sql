-- =====================================================================
-- MEDIINDEX — POSTGRESQL CLUSTER SCHEMA (PHASE 5A FOUNDATION)
-- Target Environment: Vercel Postgres / Neon / AWS RDS / Supabase
-- Target Engine: PostgreSQL 15+
-- =====================================================================

-- 1. Pharmacies (Tenant Root)
CREATE TABLE IF NOT EXISTS pharmacies (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users (Authentication & RBAC)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'STAFF')),
    active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_pharmacy ON users(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 3. Cloud Sessions Store (For Stateless Serverless Worker Verification)
CREATE TABLE IF NOT EXISTS sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 4. Medicines Catalogue
CREATE TABLE IF NOT EXISTS medicines (
    id SERIAL PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    generic_name VARCHAR(255),
    manufacturer VARCHAR(255),
    category VARCHAR(100),
    minimum_stock INTEGER NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
    active SMALLINT NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_medicines_pharmacy ON medicines(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_medicines_name ON medicines(name);
CREATE INDEX IF NOT EXISTS idx_medicines_generic ON medicines(generic_name);

-- 5. Paired Mobile Devices (Hardware Pairing & Revocation)
CREATE TABLE IF NOT EXISTS paired_devices (
    id SERIAL PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    device_name VARCHAR(100) NOT NULL,
    device_model VARCHAR(100),
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    paired_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ,
    revoked SMALLINT NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paired_devices_token ON paired_devices(token_hash);
CREATE INDEX IF NOT EXISTS idx_paired_devices_pharmacy ON paired_devices(pharmacy_id);

-- 6. Device Pairing Codes (Single-Use 10-Minute Ephemeral PINs)
CREATE TABLE IF NOT EXISTS device_pairing_codes (
    id SERIAL PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    pairing_code VARCHAR(50) NOT NULL UNIQUE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    used SMALLINT NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
    used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pairing_codes_code ON device_pairing_codes(pairing_code);
CREATE INDEX IF NOT EXISTS idx_pairing_codes_pharmacy ON device_pairing_codes(pharmacy_id);

-- 7. Medicine Batches & Lots
CREATE TABLE IF NOT EXISTS medicine_batches (
    id SERIAL PRIMARY KEY,
    medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    batch_number VARCHAR(100) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    purchase_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (purchase_price >= 0),
    selling_price NUMERIC(12, 2) NOT NULL CHECK (selling_price >= 0),
    manufacturing_date DATE,
    expiry_date DATE NOT NULL,
    location VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_medicine_batch UNIQUE (medicine_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON medicine_batches(expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_medicine ON medicine_batches(medicine_id);

-- 8. Dual-Actor Inventory Movements Audit Trail
CREATE TABLE IF NOT EXISTS inventory_movements (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES medicine_batches(id) ON DELETE CASCADE,
    change_quantity INTEGER NOT NULL CHECK (change_quantity != 0),
    reason VARCHAR(30) NOT NULL CHECK (reason IN ('RECEIPT', 'ADJUSTMENT', 'SALE')),
    created_by INTEGER NOT NULL REFERENCES users(id),
    device_id INTEGER REFERENCES paired_devices(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_movements_batch ON inventory_movements(batch_id);
CREATE INDEX IF NOT EXISTS idx_movements_device ON inventory_movements(device_id);

-- 9. Sales (Invoices)
CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    invoice_number VARCHAR(100) NOT NULL UNIQUE,
    customer_name VARCHAR(150),
    customer_phone VARCHAR(50),
    payment_method VARCHAR(50) NOT NULL DEFAULT 'CASH',
    total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_pharmacy_created ON sales(pharmacy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_number);

-- 10. Sale Items (Line-item Dispensation Breakdown)
CREATE TABLE IF NOT EXISTS sale_items (
    id SERIAL PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    batch_id INTEGER NOT NULL REFERENCES medicine_batches(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_batch ON sale_items(batch_id);

-- 11. Expiry & Low-Stock Alerts Table
CREATE TABLE IF NOT EXISTS expiry_alerts (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES medicine_batches(id) ON DELETE CASCADE,
    alert_type VARCHAR(30) NOT NULL CHECK (alert_type IN ('EXPIRED', 'EXPIRING_SOON', 'LOW_STOCK')),
    acknowledged SMALLINT NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_expiry_alert UNIQUE (batch_id, alert_type)
);
CREATE INDEX IF NOT EXISTS idx_expiry_alerts_batch ON expiry_alerts(batch_id);

-- 12. Idempotency Store (Network Replay Deduplication)
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(128) NOT NULL,
    pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES paired_devices(id) ON DELETE SET NULL,
    endpoint VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_idempotency_keys PRIMARY KEY (key, pharmacy_id)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_lookup ON idempotency_keys(key, pharmacy_id);
