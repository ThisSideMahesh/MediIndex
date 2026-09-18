# MediIndex Project State

**Project Name:** MEDIINDEX — Intelligent Pharmacy Inventory & Expiry Management Platform  
**Academic Context:** B.Tech Computer Science & Engineering (PRO423 — Major Project-II), Maharashtra Institute of Technology, Chhatrapati Sambhajinagar  
**Last Updated:** August 2026  
**Primary Repository:** [https://github.com/ThisSideMahesh/MediIndex](https://github.com/ThisSideMahesh/MediIndex)

---

## 1. Project Overview & Current Phase

- **Current Phase:** Phase 5C — PostgreSQL + Vercel Serverless Integration Prepared (76/76 core tests passing + 9 PostgreSQL integration tests ready).
- **Core Architecture:** Edge-Cloud Hybrid Architecture (Local Offline SQLite Node + Serverless Vercel Cloud Adapter with PostgreSQL).
- **Academic Classification:** Applied Computer Science / Healthcare Information Systems / Software Product Development.

---

## 2. Verified Implementation Status

| Feature / Module | Verification Standard | Current State |
|---|---|---|
| **Zero-dependency Runtime** | Node.js built-ins (`node:sqlite`, `node:crypto`, `node:http`) | IMPLEMENTED / VERIFIED |
| **Authentication & RBAC (MOD-03)** | Scrypt salt+hash, persistent database session store (`sessions` table with SHA-256 token hashes, 6-hour TTL, zero in-memory Map dependency), 6-hour HttpOnly/SameSite=Strict session cookies, ADMIN & STAFF roles (`tests/sessions.test.js` PASS 12/12) | IMPLEMENTED / VERIFIED |
| **Medicine Management** | Master catalogue CRUD, generic name, manufacturer, minimum stock tracking | IMPLEMENTED / VERIFIED |
| **Batch Management** | Multi-batch per medicine, lot numbers, purchase/selling price, manufacturing/expiry dates, shelf locations | IMPLEMENTED / VERIFIED |
| **Expiry Monitoring** | Dynamic batch-level expiry calculation (`EXPIRED`, `EXPIRING_SOON`, `SAFE`), persistent alert table, acknowledge workflow | IMPLEMENTED / VERIFIED |
| **Inventory Movements** | Dual-actor audit trail recording stock receipts, sales, adjustments, and originating device IDs | IMPLEMENTED / VERIFIED |
| **Dashboard Metrics** | Real-time SQL aggregation for total medicines, total stock, expired batches, near-expiry, low-stock count, today's sales | IMPLEMENTED / VERIFIED |
| **Billing & Transactions (POS)** | Atomic multi-item checkout, FEFO/manual batch dispensing, stock deduction, rollback protection, receipt view | IMPLEMENTED / VERIFIED |
| **Demand Forecasting (WMA)** | 3-period Weighted Moving Average ($w_1=0.50, w_2=0.30, w_3=0.20$), 95% service safety stock, hard "INSUFFICIENT DATA" guardrail | IMPLEMENTED / VERIFIED |
| **QR Code Identification** | Versioned QR payload, pure SVG sticker generator, authoritative database resolution, webcam scanner & manual fallback | IMPLEMENTED / VERIFIED |
| **2D Shelf Locator Map (MOD-11)** | 14 standard shelf bays + fallback quarantine bay, spatial inventory mapping (`/api/layout/shelves`) | IMPLEMENTED / VERIFIED |
| **Mobile Device Pairing (MOD-14)** | Admin-generated 10-min single-use PIN, 256-bit token hashes, hardware revocation, tenant isolation (`/api/mobile/pairing/*`) | IMPLEMENTED / VERIFIED |
| **Mobile Stock-Entry API (MOD-15)** | High-throughput QR scan stock entry with DB-backed idempotency, concurrent locking (`BEGIN IMMEDIATE`), movement audit, tenant isolation | IMPLEMENTED / VERIFIED |
| **Offline Synchronization Engine (MOD-16)** | Server-side batch synchronization API (`/api/mobile/stock-entry/batch-sync`), per-operation atomicity, idempotency deduplication, conflict protection (`tests/offline-sync.test.js` PASS). *Mobile IndexedDB client outbox planned in Phase 7.* | IMPLEMENTED / VERIFIED (Server Sync) |
| **Vercel Cloud Adapter (MOD-17)** | Dual database abstraction layer (`SQLiteAdapter` + `PostgreSQLAdapter`), parameterized conversion (`?` to `$1`), connection lifecycle, transaction rollback semantics, cloud DDL schema mapping, persistent session store (`tests/adapters.test.js` PASS 8/8, `tests/sessions.test.js` PASS 12/12). | IN DEVELOPMENT / PARTIALLY IMPLEMENTED (Phase 5B Complete) |
| **Inter-Pharmacy Federated Network (MOD-12)** | Privacy-preserving medicine availability search, connection handshake, stock transfer workflow | ARCHITECTED & AUDITED |

---

## 3. Phased Implementation Roadmap (Phases 4 - 9)

- **Phase 4:** Offline Synchronization Engine & Batch Sync Endpoint (`/api/mobile/stock-entry/batch-sync`) — *COMPLETE*.
- **Phase 5A:** PostgreSQL Persistence Adapter Foundation (`SQLiteAdapter` + `PostgreSQLAdapter` + Cloud Schema Mapping) — *COMPLETE*.
- **Phase 5B:** Persistent Session Store & Database-Backed Authentication Migration (`sessions` table, SHA-256 token hashing, stateless serverless compatibility) — *COMPLETE*.
- **Phase 5C:** PostgreSQL + Vercel Serverless Integration (`vercel.json`, PostgreSQL integration test suite, environment configuration, deployment readiness) — *PREPARED / NOT LIVE VERIFIED*.
- **Phase 6:** Inter-Pharmacy Federated Medicine Availability Discovery & Stock Transfer Coordination.
- **Phase 7:** Mobile Stock-Entry Frontend UI (PWA Camera Scanner & Local Outbox Queue).
- **Phase 8:** Full End-to-End System Integration & Hybrid Edge-Cloud E2E Verification.
- **Phase 9:** Security Hardening, Production Deployment, and Final B.Tech Major Project Defense.

---

## 5. Active Known Issues & Mitigations

- **Test Concurrency:** Test runner executes sequentially with `--test-concurrency=1` to allow clean SQLite database access during in-process tests.
- **Data Integrity:** Strict SQL constraints (`CHECK(quantity >= 0)`), SQLite Write-Ahead Logging (`PRAGMA journal_mode = WAL`), and database-level transactions ensure zero inventory drift.
