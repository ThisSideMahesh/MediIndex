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

-- =====================================================================
-- INTER-PHARMACY NEAR-EXPIRY REDISTRIBUTION (additive migration)
-- =====================================================================

-- Add geographic coordinates to pharmacies (nullable — existing rows keep NULL)
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS latitude  NUMERIC(9,6);
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);

-- 13. Medicine Redistribution Requests
-- Created automatically when a near-expiry batch is detected AND a nearby
-- pharmacy with an identified stock need is found.
-- Does NOT transfer inventory — physical transfer is a separate workflow.
CREATE TABLE IF NOT EXISTS medicine_redistribution_requests (
    id                   SERIAL PRIMARY KEY,
    idempotency_key      VARCHAR(64) NOT NULL UNIQUE,   -- SHA-256(sender|recipient|medicine|batch)
    sender_pharmacy_id   INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    recipient_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    medicine_id          INTEGER NOT NULL REFERENCES medicines(id)   ON DELETE CASCADE,
    source_batch_id      INTEGER NOT NULL REFERENCES medicine_batches(id) ON DELETE CASCADE,
    requested_quantity   INTEGER NOT NULL CHECK (requested_quantity > 0),
    reason               VARCHAR(60) NOT NULL DEFAULT 'NEAR_EXPIRY_REDISTRIBUTION',
    request_type         VARCHAR(20) NOT NULL DEFAULT 'NEAR_EXPIRY'
                             CHECK (request_type IN ('NEAR_EXPIRY', 'MANUAL')),
    status               VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                             CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
    automatic_request    SMALLINT NOT NULL DEFAULT 0 CHECK (automatic_request IN (0, 1)),
    automatic_acceptance SMALLINT NOT NULL DEFAULT 0 CHECK (automatic_acceptance IN (0, 1)),
    days_until_expiry    INTEGER,
    distance_km          NUMERIC(8, 3),   -- Haversine distance at time of creation
    notes                TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_redistrib_sender    ON medicine_redistribution_requests(sender_pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_redistrib_recipient ON medicine_redistribution_requests(recipient_pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_redistrib_batch     ON medicine_redistribution_requests(source_batch_id);
CREATE INDEX IF NOT EXISTS idx_redistrib_status    ON medicine_redistribution_requests(status);

-- =====================================================================
-- MANUAL MEDICINE REQUESTS — PROGRESSIVE GEOGRAPHIC SEARCH (additive migration)
-- =====================================================================
-- Kept deliberately SEPARATE from medicine_redistribution_requests:
--   * medicine_redistribution_requests = AUTOMATIC near-expiry redistribution,
--     one row per sender->recipient pair, always tied to a source batch.
--   * medicine_requests (+ offers)     = MANUAL requests, one request with N
--     offers from multiple pharmacies, partial coverage, no source batch.
-- Merging them would require making source_batch_id nullable and would leave
-- nowhere to track covered_quantity, so the two workflows stay independent.
--
-- MEDICINE IDENTITY (MVP): medicines.id is per-pharmacy (medicines.pharmacy_id),
-- so it cannot identify the same medicine across pharmacies. Cross-pharmacy
-- matching therefore uses lower(medicine_name), consistent with the existing
-- near-expiry workflow. No second medicine identity system is introduced.
-- This means MVP REQUIRES IDENTICAL MEDICINE NAMING ACROSS PHARMACIES.
--
-- NO INVENTORY MOVEMENT: an accepted offer records a commitment only. Nothing
-- here updates medicine_batches or writes inventory_movements. Physical
-- transfer remains a separate future controlled workflow.

-- Pharmacy activation flag. Existing rows become active automatically via the
-- DEFAULT, so no backfill is required and no row is invalidated.
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS active SMALLINT NOT NULL DEFAULT 1;

-- 14. Manual Medicine Requests
-- One row per manual request raised by a pharmacy needing stock.
CREATE TABLE IF NOT EXISTS medicine_requests (
    id                    SERIAL PRIMARY KEY,
    idempotency_key       VARCHAR(64) NOT NULL UNIQUE,   -- client-supplied; dedupes creation retries
    requester_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    medicine_id           INTEGER NOT NULL REFERENCES medicines(id)  ON DELETE CASCADE,
    medicine_name         VARCHAR(255) NOT NULL,         -- denormalised cross-pharmacy match key
    requested_quantity    INTEGER NOT NULL CHECK (requested_quantity > 0),
    covered_quantity      INTEGER NOT NULL DEFAULT 0 CHECK (covered_quantity >= 0),
    status                VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                              CHECK (status IN ('OPEN', 'PARTIALLY_COVERED', 'FULLY_COVERED',
                                                'NO_COVERAGE', 'CANCELLED', 'EXPIRED')),
    priority              VARCHAR(10) NOT NULL DEFAULT 'NORMAL'
                              CHECK (priority IN ('NORMAL', 'URGENT')),
    reason                TEXT,
    current_zone_index    INTEGER NOT NULL DEFAULT 0,    -- index into MEDICINE_REQUEST_ZONES_KM
    current_radius_km     NUMERIC(8, 3) NOT NULL,
    created_by            INTEGER NOT NULL REFERENCES users(id),
    expires_at            TIMESTAMPTZ NOT NULL,          -- request TTL (72h default)
    created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Database-level backstop: coverage can never exceed what was requested,
    -- independent of application logic. Pairs with the conditional-UPDATE (CAS)
    -- used when applying an offer.
    CONSTRAINT ck_mreq_coverage CHECK (covered_quantity <= requested_quantity)
);
CREATE INDEX IF NOT EXISTS idx_mreq_requester ON medicine_requests(requester_pharmacy_id, status);
CREATE INDEX IF NOT EXISTS idx_mreq_status    ON medicine_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_mreq_medicine  ON medicine_requests(medicine_id);

-- 15. Manual Medicine Request Offers
-- One row per (request, contacted pharmacy). Created when a pharmacy is
-- contacted during progressive geographic search; updated when it responds.
-- A pharmacy with zero usable stock is still contactable and still gets a row,
-- so the requester can see it was asked and did not have the medicine.
CREATE TABLE IF NOT EXISTS medicine_request_offers (
    id                      SERIAL PRIMARY KEY,
    request_id              INTEGER NOT NULL REFERENCES medicine_requests(id) ON DELETE CASCADE,
    pharmacy_id             INTEGER NOT NULL REFERENCES pharmacies(id)        ON DELETE CASCADE,
    zone_index              INTEGER NOT NULL,              -- zone this pharmacy was reached in
    distance_km             NUMERIC(8, 3) NOT NULL,        -- real Haversine distance at contact time
    usable_stock_at_contact INTEGER NOT NULL,              -- snapshot; 0 is valid. Drives expansion decisions
    status                  VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                                CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED',
                                                  'SUPERSEDED', 'EXPIRED')),
    offered_quantity        INTEGER CHECK (offered_quantity IS NULL OR offered_quantity > 0),
    decline_reason          TEXT,
    responded_by            INTEGER REFERENCES users(id),
    responded_at            TIMESTAMPTZ,
    respond_by              TIMESTAMPTZ NOT NULL,          -- offer response window (24h default)
    contacted_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Idempotency anchor: a pharmacy can hold at most one offer row per request,
    -- so repeated offer/decline submissions and concurrent expansion passes
    -- cannot create duplicates.
    CONSTRAINT uq_mreq_offer UNIQUE (request_id, pharmacy_id),
    -- An ACCEPTED offer must carry a quantity.
    CONSTRAINT ck_mreq_offer_accepted_qty CHECK (status <> 'ACCEPTED' OR offered_quantity IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mreq_offer_request  ON medicine_request_offers(request_id, status);
CREATE INDEX IF NOT EXISTS idx_mreq_offer_pharmacy ON medicine_request_offers(pharmacy_id, status);
