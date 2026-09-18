# MediIndex Backend Architecture Audit Report

**Project:** MediIndex — Intelligent Pharmacy Inventory & Expiry Management Platform  
**Academic Context:** B.Tech Computer Science & Engineering (Major Project-II / PRO423)  
**Audit Date:** September 2026  
**Auditor:** Backend Architecture Specialist  
**Execution Standard:** Zero-modification audit, native test verification, authoritative code inspection.

---

## 1. Executive Summary

A comprehensive architectural audit was performed on the MediIndex backend codebase. The audit inspected `server.js`, `package.json`, relational schema definitions, API contracts, automated test suites, and project documentation.

### Key Audit Findings:
1. **Core Runtime & Logic Quality:** The core local backend (`server.js`) is cleanly structured as a zero-dependency Node.js v22+ application using native `node:http`, `node:sqlite`, `node:crypto`, and `node:fs`.
2. **Test Suite Health:** All **17 automated tests across 5 test suites pass (100% pass rate, 0 failures, 0 skipped, execution duration ~738 ms)**.
3. **Architecture Divergence:** The backend is currently architected as a **single-node, stateful local workstation server**. It relies on an in-memory `Map` for sessions and a local synchronous SQLite file (`data/mediindex.db`).
4. **Mobile & Cloud Gap:** The newly required **Mobile Stock Entry App**, **Device Pairing Mechanism**, **Offline Queue Sync**, **Inter-Pharmacy Networking**, and **Vercel Serverless Migration** are currently unbuilt and require structured, non-breaking architectural evolution.
5. **Documentation Discrepancies:** Multiple documentation files (`PROJECT_STATE.md`, `MODULE_STATUS.md`, `TEST_RESULTS.md`, `API_SPEC.md`) contain stale metrics and out-of-sync module statuses (e.g., test count listed as 14 instead of 17; Store Layout listed as PLANNED despite being fully implemented in code and tests).

---

## 2. Current Architecture & Runtime Breakdown

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Ecosystem                              │
│   ┌──────────────────────────────────┐  ┌───────────────────────────┐   │
│   │    Web Browser Client (SPA)      │  │  Mobile Stock Entry App   │   │
│   │  - Vanilla HTML5/CSS3/ES6+ JS    │  │  (Planned / Unbuilt)      │   │
│   │  - QR Scanner + Canvas Vector    │  │  - Camera QR Scanning     │   │
│   │  - Cookie Session Auth           │  │  - Device Token Auth      │   │
│   └─────────────────┬────────────────┘  └─────────────┬─────────────┘   │
└─────────────────────┼─────────────────────────────────┼─────────────────┘
                      │ Cookie / HTTP                   │ Bearer Token / HTTP
┌─────────────────────▼─────────────────────────────────▼─────────────────┐
│                      MediIndex Server (`server.js`)                     │
│  ┌─────────────────────────────┐  ┌──────────────────────────────────┐  │
│  │ Native HTTP Dispatcher      │  │ Stateful Session Store (Memory)  │  │
│  │ - Route pattern matching    │  │ - `const sessions = new Map()`   │  │
│  │ - JSON body parser          │  │ - 6-hour TTL                     │  │
│  └──────────────┬──────────────┘  └────────────────┬─────────────────┘  │
│                 │                                  │                    │
│  ┌──────────────▼──────────────────────────────────▼─────────────────┐  │
│  │ Core Business Logic Modules                                       │  │
│  │ - Scrypt Auth & RBAC (Admin/Staff)                                │  │
│  │ - Medicine Catalogue & Multi-batch Inventory                      │  │
│  │ - Dynamic Expiry Engine & Persistent Alerts                       │  │
│  │ - Point-of-Sale (POS) with Automated FEFO Allocation              │  │
│  │ - Demand Forecasting (3-period WMA + 95% Safety Stock)            │  │
│  │ - QR Authoritative DB Resolution (`/api/qr/lookup`)               │  │
│  │ - Store Rack & Shelf Layout Spatial Mapping (`/api/layout/shelves`)│  │
│  └──────────────────────────────┬────────────────────────────────────┘  │
└─────────────────────────────────┼───────────────────────────────────────┘
                                  │ Synchronous C++ Binding (`node:sqlite`)
┌─────────────────────────────────▼───────────────────────────────────────┐
│                     Local SQLite Database Engine                        │
│                     `data/mediindex.db` (WAL Mode)                      │
│  - Foreign Keys Enforced (`PRAGMA foreign_keys = ON;`)                  │
│  - Multi-statement ACID Transactions (`BEGIN ... COMMIT / ROLLBACK`)    │
│  - Non-negative integer & check constraints (`CHECK(quantity >= 0)`)    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Implemented Modules vs Requirements Matrix

| Requirement / Module | Intended Functionality | Current Code Status | Verification Evidence |
|---|---|---|---|
| **1. Medicine Master Catalogue** | Master drug inventory, brand/generic names, manufacturer, minimum stock | **IMPLEMENTED** | `server.js` (lines 380-421), `tests/auth.test.js` |
| **2. Batch-wise Inventory Management** | Multi-batch lots, manufacturing/expiry dates, purchase/selling rates, locations | **IMPLEMENTED** | `server.js` (lines 422-464), `tests/auth.test.js` |
| **3. Inventory Movements & Audit Trail** | Full traceability of all stock changes (`RECEIPT`, `ADJUSTMENT`, `SALE`) | **PARTIAL** | DB writes implemented (lines 445, 460, 822); **Missing `GET /api/inventory/movements` endpoint** |
| **4. Expiry Monitoring & Alerts** | Dynamic classification (`EXPIRED`, `EXPIRING_SOON`, `SAFE`), acknowledgment workflow | **IMPLEMENTED** | `server.js` (lines 147-156, 360-379), `tests/auth.test.js` |
| **5. Billing & Point-of-Sale (POS)** | Multi-item billing, invoice numbering (`INV-YYYYMMDD-XXXX`), customer receipt | **IMPLEMENTED** | `server.js` (lines 681-845), `tests/sales.test.js` |
| **6. FEFO Stock Allocation** | Automatic First-Expired, First-Out batch deduction, rollback on insufficient stock, expired sale block | **IMPLEMENTED** | `server.js` (lines 769-797), `tests/sales.test.js` |
| **7. QR Medicine/Batch Identification** | Structured QR payload (`{"app":"MEDIINDEX","v":1,...}`), pure SVG generator, authoritative server lookup | **IMPLEMENTED** | `server.js` (lines 465-578), `public/qr-generator.js`, `tests/qr.test.js` |
| **8. Demand Forecasting (WMA)** | 3-period Weighted Moving Average ($w_1=0.5, w_2=0.3, w_3=0.2$) | **IMPLEMENTED** | `server.js` (lines 158-289, 356-359), `tests/demand.test.js` |
| **9. Safety Stock & Reorder Recommendations** | 95% service level safety stock ($Z=1.65$), hard `"INSUFFICIENT DATA"` reliability guard | **IMPLEMENTED** | `server.js` (lines 205-216, 232-248), `tests/demand.test.js` |
| **10. Pharmacy Analytics & Dashboard** | Aggregated counts, near-expiry, low-stock, revenue metrics | **IMPLEMENTED** | `server.js` (lines 133-145, 355), `tests/auth.test.js` |
| **11. 2D Store & Shelf Map** | 14 standard shelf bays + fallback quarantine bay, spatial inventory mapping | **IMPLEMENTED** | `server.js` (lines 579-680), `tests/layout.test.js` *(Note: docs say planned)* |
| **12. Inter-Pharmacy Connectivity** | Real-time inter-store stock query, transfer requests | **NOT IMPLEMENTED** | Deferred in `MODULE_STATUS.md`; no schema or API endpoints exist. |
| **13. Offline-First Operation** | Standalone operation without internet connectivity | **PARTIAL** | Server operates 100% offline locally on SQLite, but web client lacks Service Worker PWA offline caching. |
| **14. Sync / Cloud Backup** | Periodic cloud synchronization when internet is restored | **NOT IMPLEMENTED** | Documented in `VERCEL_MIGRATION_PLAN.md`, but no backend sync engine or schema exists. |
| **15. Mobile Stock Entry App** | Dedicated mobile UI for scanning and receiving stock | **NOT IMPLEMENTED** | No mobile client or mobile endpoints exist. |
| **16. Smartphone Camera QR Scanning** | Camera stream barcode/QR recognition | **PARTIAL** | Web client has `getUserMedia` scanner in `public/app.js`, but no mobile app integration. |
| **17. Wi-Fi Communication & Device Pairing** | One-time pairing, token authentication, LAN stock entry | **NOT IMPLEMENTED** | Missing pairing handshake, device tables, and mobile API endpoints. |
| **18. Vercel Platform Deployment** | Serverless cloud execution | **NOT IMPLEMENTED** | Current architecture (local SQLite + memory sessions) will fail on Vercel without migration. |

---

## 4. Test Execution Status & Verification

The existing automated test suite was executed via native Node.js test runner:
```bash
npm test # (node --test --test-concurrency=1 tests/*.test.js)
```

### Exact Results:
- **Total Tests Executed:** 17
- **Passed:** 17 (100%)
- **Failed:** 0
- **Skipped:** 0
- **Todo / Cancelled:** 0
- **Total Test Suites:** 5 files (`auth.test.js`, `demand.test.js`, `layout.test.js`, `qr.test.js`, `sales.test.js`)
- **Execution Duration:** ~738 ms

### Detailed Test Verification Breakdown:
1. `auth.test.js` (5 tests):
   - Scrypt password hashing & salt validation (`PASS`)
   - Valid admin login & `HttpOnly` session cookie issuance (`PASS`)
   - Invalid password & unauthenticated route rejection (`PASS`)
   - Medicine CRUD, batch ingestion, search, and soft-delete (`PASS`)
   - Expiry alert generation and acknowledgment (`PASS`)
2. `demand.test.js` (3 tests):
   - Unauthenticated access rejection (`PASS`)
   - Insufficient historical periods hard reliability guard (`PASS`)
   - 3-period Weighted Moving Average mathematical precision & safety stock ($Z=1.65$) (`PASS`)
3. `layout.test.js` (3 tests):
   - Unauthenticated access rejection (`PASS`)
   - Shelf layout schema & spatial batch mapping (`PASS`)
   - Custom unassigned location fallback bay grouping (`PASS`)
4. `qr.test.js` (4 tests):
   - Unauthenticated access rejection (`PASS`)
   - Batch QR payload generation & printable sticker formatting (`PASS`)
   - Authoritative database lookup via JSON Object, JSON String, and Pipe String (`PASS`)
   - Security rejection of foreign app codes, invalid versions, and missing IDs (`PASS`)
5. `sales.test.js` (2 tests):
   - Point-of-Sale FEFO multi-batch stock allocation, inventory deduction, movement logging, and invoice generation (`PASS`)
   - Prevention of selling expired drug batches (`PASS`)

---

## 5. Database Status & Concurrency Model

### 5.1 Current Database Architecture
- **Engine:** SQLite 3 via Node.js native `node:sqlite` (`DatabaseSync` class).
- **Physical File:** `data/mediindex.db`.
- **Concurrency Mode:** Write-Ahead Logging (`PRAGMA journal_mode = WAL;`) with 5000ms busy timeout (`PRAGMA busy_timeout = 5000;`).
- **Referential Integrity:** Enforced via `PRAGMA foreign_keys = ON;`.
- **Tables (8 Total):**
  1. `pharmacies` (Tenancy boundary)
  2. `users` (Admin/Staff credentials and roles)
  3. `medicines` (Master catalogue, soft-deleted via `active = 0`)
  4. `medicine_batches` (Physical inventory with `UNIQUE(medicine_id, batch_number)`)
  5. `inventory_movements` (Immutable audit trail of receipts, adjustments, sales)
  6. `sales` (Invoice headers)
  7. `sale_items` (Line items linked to specific batches)
  8. `expiry_alerts` (Unique alerts with `UNIQUE(batch_id, alert_type)`)

### 5.2 Transaction & Concurrency Model
- **ACID Transactions:** Used in POS billing (`POST /api/sales`) and batch adjustments (`POST /api/batches/:id/adjustments`) via explicit `db.exec('BEGIN')` ... `db.exec('COMMIT')` / `db.exec('ROLLBACK')`.
- **Stock Guardrails:** Database-level constraint `CHECK(quantity >= 0)` prevents overselling or race condition negative balances.
- **Limitation:** In the current single-process Node server, `DatabaseSync` executes synchronously on the event loop. In high-concurrency or serverless multi-instance environments, separate worker processes cannot coordinate transactions across independent local SQLite files.

---

## 6. Security Status

| Security Vector | Current Implementation | Evaluation | Vulnerabilities / Weaknesses |
|---|---|---|---|
| **Password Storage** | Scrypt Key Derivation (64-byte key, 16-byte random salt) | **EXCELLENT** | None. Salted hashes formatted as `salt:hash`. Plaintext is never stored. |
| **Password Comparison** | `crypto.timingSafeEqual` | **EXCELLENT** | Timing-attack resistant. |
| **Session Security** | 64-character random hex token in `HttpOnly; SameSite=Strict; Path=/` cookie | **GOOD** | Prevents XSS token exfiltration. |
| **Session Persistence** | In-memory `Map` (`const sessions = new Map()`) | **CRITICAL RISK** | All logged-in sessions are wiped when the process restarts or across serverless instances. |
| **Role-Based Access Control** | `requireRole(res, user, 'ADMIN', 'STAFF')` | **GOOD** | Route-level role checking works as intended. |
| **Input Sanitization** | `cleanText()`, `nonNegative()`, parameterized SQL queries (`?`) | **EXCELLENT** | SQL injection is blocked across all endpoints. |
| **Mobile Authentication** | None | **MISSING** | No mechanism currently exists for mobile devices to authenticate without interactive user session cookies. |

---

## 7. Mobile Stock Entry App Gap Analysis

The new requirement specifies a **lightweight Mobile Stock Entry App** communicating over Wi-Fi/Internet without interactive username/password login on every launch.

### 7.1 Missing Architecture Components
1. **Pharmacy-Device Relationship:** No table exists to register and manage trusted hardware devices.
2. **One-Time Pairing Handshake:** No mechanism exists for a pharmacy admin to generate a short-lived, single-use pairing code (e.g., 6-character PIN expiring in 10 minutes) on the web dashboard to bind a mobile device.
3. **Secure Device Credentials:** No persistent device token authentication exists. Device tokens must be hashed (`sha256(device_token)`) in the database, with the plain token stored securely on the mobile device (e.g., iOS Keychain / Android EncryptedSharedPreferences).
4. **Device Revocation:** Admins cannot currently inspect paired devices or revoke a lost/stolen device's access.
5. **Dedicated Mobile Stock-Entry API:** Currently, adding batch stock requires `POST /api/medicines/:id/batches` which requires interactive session cookies and full medicine ID knowledge. A mobile app scanning a QR code needs a streamlined endpoint:
   - `POST /api/mobile/stock-entry`
   - Accepts either `qr_payload` or `medicine_id` + `batch_number`, quantity, expiry date, purchase price, selling price, and rack location.
6. **Idempotency & Duplicate Prevention:** Wi-Fi retries on mobile networks can submit duplicate receipts. The backend needs an `idempotency_keys` table to guarantee that retried network packets do not double-increment stock.
7. **Offline Mobile Queue & Conflict Handling:** When mobile workers enter stock in a Wi-Fi dead zone (e.g., basement cold storage), submissions must queue locally on the device and batch-sync with timestamps when connectivity returns.

---

## 8. Offline & Synchronization Gap Analysis

### 8.1 Current Offline Capability
- The backend runs 100% offline on local hardware because all database queries and QR vector calculations are executed locally.

### 8.2 Missing Sync Architecture
- **No Client Service Worker:** The browser SPA (`public/index.html`) requires an active HTTP connection to `127.0.0.1:3000`. If the browser tab is reloaded without the server running, it will fail.
- **No Cloud Synchronization Engine:** There is no mechanism to replicate local SQLite transactions to a cloud database (or vice versa).
- **No Change Data Capture (CDC):** Tables lack `version`, `sync_status`, `deleted_at`, or `client_updated_at` columns necessary for delta synchronization and multi-master conflict resolution (LWW — Last Write Wins or CRDT).

---

## 9. Inter-Pharmacy Connectivity Gap Analysis

- **Current State:** Completely absent (intentionally deferred in Phase 1).
- **Required Architecture:** 
  - A secure central broker or federated API where Pharmacy A can query medicine availability at nearby Pharmacy B (within the same network/chain).
  - Strict data isolation: Pharmacy A must only see stock availability and generic names, never financial margins, supplier purchase rates, or customer medical records of Pharmacy B.

---

## 10. Vercel Serverless Deployment Risks

Deploying the current repository to Vercel without architectural changes introduces **major failure modes**:

1. **Stateful In-Memory Sessions (`sessions` Map):**
   - *Risk:* In Vercel serverless functions, each HTTP request can be routed to a newly spawned micro-container. In-memory `sessions.get(token)` will fail randomly (returning 401 Unauthorized) because memory is not shared across lambda instances.
2. **Ephemeral SQLite Filesystem (`node:sqlite DatabaseSync`):**
   - *Risk:* Vercel's execution environment has a read-only root filesystem and an ephemeral `/tmp` directory that is destroyed upon container teardown. Any inventory changes written to `mediindex.db` will be permanently erased.
3. **Monolithic HTTP Listener (`http.createServer`):**
   - *Risk:* Vercel expects serverless route handlers (e.g., Next.js App Router, Express adapter, or `/api/[...route].js` lambdas), not a continuously listening `server.listen(PORT)` process.
4. **Dual-Mode Architectural Requirement:**
   - *Resolution:* To meet project requirements, MediIndex must operate in **Dual Mode**:
     - *Local Mode:* SQLite + local HTTP server for 100% offline pharmacy operations.
     - *Cloud Mode (Vercel):* Serverless functions connected to a serverless cloud database (e.g., Neon PostgreSQL / Turso libSQL) with stateless JWT or Redis-backed sessions.

---

## 11. Documentation Inconsistencies Identified

| File | Documented Statement | Actual Code State | Impact |
|---|---|---|---|
| `TEST_RESULTS.md` | "Total Test Cases Executed: 14" | **17 tests exist and execute** across 5 test files. | Minor documentation lag. |
| `MODULE_STATUS.md` | MOD-11 (2D Shelf Locator Map) is `PLANNED` | **MOD-11 is FULLY IMPLEMENTED** in `server.js` (lines 579-680) and tested in `tests/layout.test.js`. | Under-reporting project completion. |
| `PROJECT_STATE.md` | P2: 2D Store & Shelf Map (MOD-11) is `In Progress` | Fully implemented and verified. | Under-reporting project completion. |
| `API_SPEC.md` | Omits `/api/layout/shelves` endpoint | `/api/layout/shelves` exists and returns full shelf layout schema. | Missing API documentation. |
| `API_SPEC.md` | Does not document `inventory_movements` reading | `inventory_movements` is populated on stock receipt, adjustment, and sale, but has no `GET` endpoint. | Incomplete API feature. |

---

## 12. Technical Debt & Code Quality Summary

1. **Monolithic `server.js`:** The backend is currently housed in a single 853-line file combining HTTP routing, database setup, HTML static file serving, business logic, and math algorithms. While manageable for MVP, modularizing into controllers, services, and middleware is necessary before adding mobile pairing and cloud sync.
2. **Missing Inventory Movement Query Endpoint:** Audit logs are diligently written to `inventory_movements`, but cashiers/admins cannot view historical logs via the API.
3. **Lack of Idempotency Headers:** POS checkout and batch adjustments do not enforce client idempotency keys, creating duplicate transaction risks on flaky Wi-Fi networks.

---

## 13. Recommended Implementation Order

To maintain 100% backward compatibility and test stability while adding new capabilities:

1. **Phase 1: Backend Foundation Refactoring & Audit Endpoint (Zero Breaking Changes)**
   - Add `GET /api/inventory/movements` endpoint.
   - Modularize internal route handlers without breaking existing endpoints or tests.
2. **Phase 2: Mobile Device Management & One-Time Pairing Engine**
   - Implement `paired_devices` and `device_pairing_codes` schema.
   - Add admin pairing code generation (`POST /api/devices/pairing/generate`).
   - Add device registration handshake (`POST /api/devices/pairing/claim`).
   - Add token verification middleware (`X-Device-Token` header).
3. **Phase 3: Dedicated Mobile Stock Entry & Idempotency Engine**
   - Add `POST /api/mobile/stock-entry` with QR payload resolution and batch ingestion.
   - Add `idempotency_keys` table for duplicate protection.
   - Add batch sync endpoint for queued offline entries (`POST /api/mobile/stock-entry/batch-sync`).
4. **Phase 4: Database Abstraction & Dual-Engine Adapter**
   - Create a database adapter interface supporting both local SQLite (WAL mode) and Cloud PostgreSQL (Neon / Supabase).
5. **Phase 5: Vercel Serverless Packaging & Cloud Sync**
   - Add stateless token authentication (JWT / signed tokens) for Vercel lambdas.
   - Package `/api` endpoints for Vercel deployment while preserving local `server.js` standalone execution.
6. **Phase 6: Inter-Pharmacy Network & Academic Documentation**
   - Implement inter-pharmacy lookup APIs.
   - Finalize Project-II documentation, IEEE citations, and viva preparation guides.
