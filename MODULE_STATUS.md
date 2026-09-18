# MediIndex Module Status Register

This register is the single source of truth for the implementation and testing status of all MediIndex modules.

**Status Levels:**
- `IMPLEMENTED / VERIFIED`: Confirmed by code, automated tests, and runtime verification.
- `IN DEVELOPMENT`: Active work in progress.
- `PLANNED`: Formal design approved; scheduled for development.
- `DEFERRED`: Intentionally postponed to protect core MVP quality.
- `NOT IMPLEMENTED`: Out of scope or not yet started.

---

## Module Status Matrix

| Module ID | Module Name | Priority | Current Status | Verification Evidence |
|---|---|---|---|---|
| **MOD-01** | **Foundation & Runtime Engine** | P0 | IMPLEMENTED / VERIFIED | Node.js (>=22) built-in HTTP server, zero third-party dependencies, health check at `/api/health`. |
| **MOD-02** | **Database & Persistence Layer** | P0 | IMPLEMENTED / VERIFIED | SQLite (`data/mediindex.db`) schema with foreign key enforcement, indexes, and seeded demo pharmacy. |
| **MOD-03** | **Authentication & RBAC** | P0 | IMPLEMENTED / VERIFIED | Scrypt salt+hash password verification, persistent DB session store (`sessions` table with SHA-256 token hashes, 6-hour TTL, zero in-memory Map dependency), 6-hour HttpOnly/SameSite=Strict session cookies, ADMIN and STAFF authorization (`tests/auth.test.js` PASS, `tests/sessions.test.js` PASS 12/12). |
| **MOD-04** | **Medicine Catalogue Management** | P0 | IMPLEMENTED / VERIFIED | CRUD operations, minimum stock thresholds, generic search via `/api/medicines`. |
| **MOD-05** | **Batch & Lot Stock Management** | P0 | IMPLEMENTED / VERIFIED | Multi-batch mapping, manufacturing/expiry dates, pricing, shelf locations, inventory receipts, and adjustment transactions. |
| **MOD-06** | **Expiry Classification & Alerts** | P0 | IMPLEMENTED / VERIFIED | Dynamic categorization (`EXPIRED`, `EXPIRING_SOON`, `SAFE`), persistent alerts table, acknowledgment tracking. |
| **MOD-07** | **Billing & Point-of-Sale (POS)** | P0 | IMPLEMENTED / VERIFIED | Multi-item checkout, FEFO/manual batch selection, atomic stock deduction, rollback on insufficient stock, invoice generation (`tests/sales.test.js` PASS). |
| **MOD-08** | **Dashboard & Executive Analytics** | P0 | IMPLEMENTED / VERIFIED | Real-time live counts and revenue metrics computed directly from SQLite queries. |
| **MOD-09** | **Demand Forecasting & Replenishment** | P1 | IMPLEMENTED / VERIFIED | 3-period Weighted Moving Average (WMA: $w_1=0.50, w_2=0.30, w_3=0.20$), safety stock at 95% service level, and hard "INSUFFICIENT DATA" guardrail (`tests/demand.test.js` PASS). |
| **MOD-10** | **QR Identification & Stock Entry** | P1 | IMPLEMENTED / VERIFIED | Structured versioned QR payload (`{"app":"MEDIINDEX","v":1,...}`), pure SVG generator, authoritative database resolution, and POS/inventory integration (`tests/qr.test.js` PASS). |
| **MOD-11** | **2D Shelf Locator Map** | P2 | IMPLEMENTED / VERIFIED | 14 standard shelf bays + unassigned fallback bay spatial mapping (`/api/layout/shelves`, `tests/layout.test.js` PASS). |
| **MOD-12** | **Cloud Sync & Inter-Pharmacy Network** | P3 | DEFERRED | Deferred to prioritize a robust, defensible offline-first local system. |
| **MOD-13** | **Desktop Packaging (Electron)** | P3 | DEFERRED | Can be wrapped over existing client without altering backend contracts. |
| **MOD-14** | **Mobile Device Registration & Pairing** | P1 | IMPLEMENTED / VERIFIED | Admin-generated single-use 10-min PINs, 256-bit token hashes, hardware revocation, tenant isolation (`tests/mobile-pairing.test.js` PASS). |
| **MOD-15** | **Mobile Stock-Entry API Pipeline** | P1 | IMPLEMENTED / VERIFIED | High-throughput QR scan stock entry with DB-backed idempotency deduplication, atomic stock increments, audit trail, and strict multi-tenant isolation (`tests/mobile-stock-entry.test.js` PASS). |
| **MOD-16** | **Offline Synchronization Engine** | P1 | IMPLEMENTED / VERIFIED | Server-side batch stock synchronization endpoint (`POST /api/mobile/stock-entry/batch-sync`), per-operation atomicity, idempotency deduplication, multi-tenant isolation (`tests/offline-sync.test.js` PASS 15/15). *Mobile IndexedDB client outbox planned in Phase 7.* |
| **MOD-17** | **Cloud / Vercel PostgreSQL Persistence Adapter** | P1 | PREPARED / NOT LIVE VERIFIED | Dual database abstraction layer (`SQLiteAdapter` + `PostgreSQLAdapter`), parameterized conversion (`?` to `$1`), connection lifecycle, transaction rollback semantics, cloud DDL schema mapping, persistent session store, Vercel serverless entrypoint (`api/index.js`), vercel.json configuration, security headers, PostgreSQL integration test suite (9 tests ready), environment-based adapter selection (`tests/adapters.test.js` PASS 8/8, `tests/sessions.test.js` PASS 12/12, `tests/postgres-integration.test.js` 9 tests implemented, pending DATABASE_URL for live verification). *Full live cloud deployment verification scheduled for Phase 5C completion with DATABASE_URL provisioning.* |

