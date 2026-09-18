# MediIndex Backend Implementation Roadmap

**Project:** MediIndex — Intelligent Pharmacy Inventory & Expiry Management Platform  
**Target Milestone:** Major Project-II / Vercel Cloud & Mobile Ecosystem  
**Guiding Principle:** Strict preservation of existing 17 passing tests and offline local workstation functionality at every phase.

---

## Roadmap Overview

```
Phase 1: Preserve Baseline & Modular Architecture Foundation
   ↓
Phase 2: Audit Logs & Inventory Movement Query API
   ↓
Phase 3: Database Abstraction & Production Schema Extension
   ↓
Phase 4: Mobile Device Registration & One-Time Pairing Engine
   ↓
Phase 5: Dedicated Mobile Stock Entry & Idempotency Pipeline
   ↓
Phase 6: Offline Mobile Queue & Bi-directional Synchronization
   ↓
Phase 7: Inter-Pharmacy Network & Distributed Stock Inquiries
   ↓
Phase 8: Vercel Serverless Architecture & Dual-Mode Deployment
   ↓
Phase 9: Frontend Web UI Integration & Device Management Console
   ↓
Phase 10: Comprehensive Security Hardening & Penetration Testing
   ↓
Phase 11: End-to-End Evaluation & Academic Defense Preparation
```

---

## Phase 1: Preserve Baseline & Architecture Foundation

- **Objective:** Refactor monolithic `server.js` into modular subsystems (controllers, middleware, services) without altering any external HTTP contracts, request/response formats, or breaking existing 17 tests.
- **Files / Modules Likely Affected:**
  - `server.js` (refactored entrypoint)
  - `src/db.js` (SQLite connection & initialization)
  - `src/auth.js` (Scrypt hashing, session validation)
  - `src/routes/*.js` (decoupled route handlers)
  - `package.json`
- **Database Changes:** None.
- **API Changes:** None (100% backward compatible).
- **Tests Required:** Full execution of `tests/*.test.js` to ensure 17/17 pass without regressions.
- **Dependencies:** Node.js v22+ built-in modules only.
- **Risks:** Route mapping mismatches during modularization. Mitigated by continuous regression test execution.

---

## Phase 2: Audit Logs & Inventory Movement Query API

- **Objective:** Expose the existing `inventory_movements` database records through a secure, paginated REST API endpoint for pharmacy administration.
- **Files / Modules Likely Affected:**
  - `src/routes/inventory.js` (or `server.js`)
  - `tests/inventory.test.js` (new test suite)
  - `API_SPEC.md`
- **Database Changes:** Add index `idx_movements_created` on `inventory_movements(created_at DESC)` for high-throughput pagination.
- **API Changes:**
  - `GET /api/inventory/movements?batchId=...&reason=...&limit=50&offset=0` (Role: `ADMIN`, `STAFF`)
- **Tests Required:**
  - Unauthenticated access rejection (401).
  - Verification of movement logs generated on batch create, adjustment, and POS sale.
- **Dependencies:** Phase 1 foundation.
- **Risks:** Large movement history payload size. Mitigated by enforcing strict `LIMIT` and cursor-based pagination.

---

## Phase 3: Production Database Architecture & Schema Extension

- **Objective:** Extend the relational schema to support mobile device pairings, idempotency keys, change tracking for sync, and prepare multi-database support (SQLite local + PostgreSQL cloud).
- **Files / Modules Likely Affected:**
  - `src/db.js`
  - `DATABASE_SCHEMA.md`
- **Database Changes:**
  - Create table `paired_devices`:
    ```sql
    CREATE TABLE IF NOT EXISTS paired_devices (
      id INTEGER PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      device_id TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      device_model TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      paired_by INTEGER NOT NULL REFERENCES users(id),
      paired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_active_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT
    );
    ```
  - Create table `device_pairing_codes`:
    ```sql
    CREATE TABLE IF NOT EXISTS device_pairing_codes (
      id INTEGER PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      pairing_code TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      claimed_by_device_id TEXT
    );
    ```
  - Create table `idempotency_keys`:
    ```sql
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      device_id TEXT REFERENCES paired_devices(device_id),
      request_path TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ```
- **API Changes:** None directly; prepares data layer.
- **Tests Required:** Schema migration and constraint verification tests.
- **Dependencies:** Phase 1.
- **Risks:** Schema migration corruption. Mitigated by `CREATE TABLE IF NOT EXISTS` checks and backup scripts.

---

## Phase 4: Mobile Device Pairing & Authorization Engine

- **Objective:** Implement the one-time device pairing workflow enabling mobile devices to securely communicate with the pharmacy backend over Wi-Fi without repetitive password logins.
- **Files / Modules Likely Affected:**
  - `src/routes/devices.js`
  - `src/middleware/deviceAuth.js`
  - `tests/device-pairing.test.js` (new test suite)
- **Database Changes:** Utilizes `paired_devices` and `device_pairing_codes`.
- **API Changes:**
  - `POST /api/devices/pairing/generate` (Admin only — generates 6-char PIN valid for 10 mins).
  - `POST /api/devices/pairing/claim` (Public/LAN — submits PIN, device UUID, device name; receives high-entropy `device_token`).
  - `GET /api/devices` (Admin only — lists all paired devices, status, last active).
  - `DELETE /api/devices/:id/revoke` (Admin only — immediately revokes device token).
- **Tests Required:**
  - Admin generates pairing code; valid device claims code and receives token.
  - Expired and already-used pairing codes are rejected.
  - Revoked device token is rejected with 401 Unauthorized.
  - Token hashing test: Plain device token is never stored in DB.
- **Dependencies:** Phase 3.
- **Risks:** Weak PIN brute forcing. Mitigated by 10-minute expiry, rate limiting, and 3-attempt lockouts.

---

## Phase 5: Dedicated Mobile Stock-Entry API & Idempotency Pipeline

- **Objective:** Build the specialized, high-throughput stock ingestion endpoint designed for mobile barcode/QR camera scanning workflows.
- **Files / Modules Likely Affected:**
  - `src/routes/mobile.js`
  - `tests/mobile-stock-entry.test.js` (new test suite)
- **Database Changes:** Records to `medicine_batches`, `inventory_movements`, `idempotency_keys`.
- **API Changes:**
  - `POST /api/mobile/stock-entry` (Auth: `X-Device-Token` header)
    ```json
    {
      "idempotencyKey": "uuid-v4",
      "qrPayload": { "app": "MEDIINDEX", "v": 1, "medicineId": 1, "batchNumber": "LOT-1" },
      "quantity": 50,
      "purchasePrice": 12.0,
      "sellingPrice": 20.0,
      "expiryDate": "2027-12-31",
      "manufacturingDate": "2025-01-01",
      "location": "Rack A1"
    }
    ```
- **Tests Required:**
  - Valid device token ingests new batch and increments stock.
  - Ingestion appends `inventory_movements` record with reason `'RECEIPT'` attributed to device.
  - Retried request with identical `idempotencyKey` returns cached result without double-incrementing stock.
  - Unpaired / invalid token is rejected.
- **Dependencies:** Phase 4.
- **Risks:** Concurrency collisions on rapid scanning. Mitigated by ACID transaction wrapping and idempotency caching.

---

## Phase 6: Offline Mobile Queue & Bi-directional Synchronization

- **Objective:** Enable mobile app to queue stock entries offline (e.g. in warehouse basement) and batch-synchronize when Wi-Fi reconnects.
- **Files / Modules Likely Affected:**
  - `src/routes/mobile.js`
  - `tests/mobile-sync.test.js` (new test suite)
- **Database Changes:** Add `client_timestamp` tracking to movements.
- **API Changes:**
  - `POST /api/mobile/stock-entry/batch-sync` (Auth: `X-Device-Token`)
    - Accepts array of queued stock items with individual idempotency keys.
    - Processes atomically or itemized with per-item status response (`SUCCESS`, `DUPLICATE`, `FAILED`).
- **Tests Required:**
  - Batch of 10 items syncs successfully.
  - Partial batch failure handling (valid items processed, invalid items reported).
  - Duplicate batch submission idempotency check.
- **Dependencies:** Phase 5.
- **Risks:** Clock skew between mobile device and server. Mitigated by server authoritative timestamping.

---

## Phase 7: Inter-Pharmacy Network & Stock Availability Lookup

- **Objective:** Enable secure federated stock discovery across participating community pharmacies.
- **Files / Modules Likely Affected:**
  - `src/routes/network.js`
  - `tests/inter-pharmacy.test.js`
- **Database Changes:**
  - Create table `inter_pharmacy_peers` (Registered peer endpoints and public keys).
  - Create table `transfer_requests` (Stock transfer inquiries).
- **API Changes:**
  - `GET /api/network/search?genericName=...&radiusKm=10` (Searches network for emergency stock).
  - `POST /api/network/transfer-request` (Requests stock transfer between stores).
- **Tests Required:**
  - Stock search queries return only generic name, formulation, and quantity available (prices and patient data masked).
  - Network authorization and peer authentication checks.
- **Dependencies:** Phase 1-3.
- **Risks:** Data leakage between competing pharmacies. Mitigated by strict field projection whitelist.

---

## Phase 8: Vercel Serverless Architecture & Dual-Mode Deployment

- **Objective:** Package the backend for deployment on Vercel Serverless while preserving 100% offline standalone execution.
- **Files / Modules Likely Affected:**
  - `api/[...route].js` (Vercel Serverless entrypoint)
  - `vercel.json` (Vercel routing & headers configuration)
  - `src/config.js` (Dual-mode environment switch: `LOCAL_OFFLINE` vs `CLOUD_SERVERLESS`)
  - `src/db-cloud.js` (PostgreSQL / Neon / Turso database adapter)
- **Database Changes:** PostgreSQL schema mirroring SQLite schema for cloud mode.
- **API Changes:** Support stateless signed JWTs in addition to cookie sessions for serverless cold starts.
- **Tests Required:**
  - Cloud database adapter integration tests.
  - Serverless function handler simulated invocation tests.
- **Dependencies:** Phases 1-6.
- **Risks:** Serverless cold starts and connection exhaustion. Mitigated by connection pooling (e.g. Neon serverless driver / Prisma / pooling proxy).

---

## Phase 9: Frontend Web UI Integration & Device Management Console

- **Objective:** Add UI panels to the MediIndex Web Dashboard for managing paired mobile devices and viewing inventory audit trails.
- **Files / Modules Likely Affected:**
  - `public/index.html`
  - `public/app.js`
  - `public/styles.css`
- **UI Components Added:**
  - "Paired Devices" management tab (generate PIN, list active devices, revoke button).
  - "Inventory Movement Audit Log" tab (filterable history of receipts, sales, adjustments).
- **Tests Required:** Browser interaction and UI integration verification.
- **Dependencies:** Phases 2 & 4.
- **Risks:** UI complexity. Mitigated by clean vanilla JS modular view rendering.

---

## Phase 10: Security Hardening & Penetration Testing

- **Objective:** Audit the entire system against OWASP Top 10 API Security Risks.
- **Activities:**
  - Rate limiting on auth and pairing endpoints (`POST /api/auth/login`, `POST /api/devices/pairing/claim`).
  - Token entropy verification.
  - Timing attack analysis on device token comparison (`crypto.timingSafeEqual`).
  - SQL injection fuzzing on all endpoints.
  - Cross-Site Request Forgery (CSRF) & SameSite validation.
- **Tests Required:** Security test suite (`tests/security.test.js`).
- **Dependencies:** All previous phases.

---

## Phase 11: End-to-End Evaluation & Academic Defense Preparation

- **Objective:** Finalize all academic deliverables for B.Tech Major Project-II defense.
- **Deliverables:**
  - Comprehensive Major Project Report adhering to MIT CS guidelines.
  - Complete architecture, ER, DFD Level 0/1, and Sequence diagrams.
  - Viva Voce examiner defense guide (`VIVA_PREP.md`).
  - Automated demonstration script seeding realistic 3-month pharmacy data.
