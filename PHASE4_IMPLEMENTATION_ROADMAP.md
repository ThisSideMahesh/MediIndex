# MediIndex — Phase 4 to Phase 9 Implementation Roadmap
## Phased Execution Strategy, Dependency Graph, Risk Mitigation & Completion Gates

**Project:** MediIndex – Pharmacy Insights, POS & Analytics  
**Document Code:** ROADMAP-PHASE4-TO-FINAL  
**Status:** FORMAL IMPLEMENTATION ROADMAP & PHASE SPECIFICATION  

---

## 1. Roadmap Overview & Execution Timeline

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              PHASED IMPLEMENTATION PIPELINE                             │
├───────────────────┬───────────────────┬───────────────────┬─────────────────────────────┤
│ PHASE 4           │ PHASE 5           │ PHASE 6           │ PHASE 7                     │
│ Offline Sync      │ Cloud Adapter     │ Inter-Pharmacy    │ Mobile Frontend             │
│ Batch Protocol    │ PostgreSQL/Vercel │ Federated Network │ PWA Camera UI               │
├───────────────────┼───────────────────┼───────────────────┼─────────────────────────────┤
│ • Batch sync API  │ • DB adapter      │ • Discovery search│ • HTML5/JS Camera scanner   │
│ • Outbox schema   │ • Cloud schema    │ • Transfer requests│ • Local outbox queue (IDB)  │
│ • Conflict tests  │ • Vercel router   │ • Privacy guards  │ • Sync status badge         │
└─────────┬─────────┴─────────┬─────────┴─────────┬─────────┴──────────────┬──────────────┘
          │                   │                   │                        │
          └───────────────────┼───────────────────┴────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ PHASE 8: Full Integration & Hybrid Edge-Cloud Verification                              │
│ PHASE 9: Security Audit, Vercel Production Deployment & Academic Defense Preparation   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Detailed Phase Specifications

### Phase 4: Offline Synchronization Engine & Batch Sync Protocol
- **Objective:** Enable multi-operation bulk synchronization for queued stock intakes and verify conflict resolution rules.
- **Files Affected:** `server.js`, `tests/offline-sync.test.js`, `API_SPEC.md`.
- **Database Changes:** None required (reuses existing `idempotency_keys` and `inventory_movements` with `device_id`).
- **API Changes:** Add `POST /api/mobile/stock-entry/batch-sync`.
- **Tests Required:**
  - `SYNC-001`: Bulk submission of 5 distinct operations in single envelope.
  - `SYNC-002`: Partial failure handling (3 valid, 1 invalid batch, 1 duplicate).
  - `SYNC-003`: Network disconnect during batch sync and idempotent retry.
- **Dependencies:** MOD-14, MOD-15.
- **Risks:** High volume of batch items causing transaction timeout. (Mitigation: Enforce batch size limit of 100 operations per request).
- **Completion Criteria:** Batch sync endpoint processes bulk envelopes atomically; 100% tests pass.

---

### Phase 5: Cloud Persistence Adapter & Vercel Serverless Layer
- **Objective:** Decouple local SQLite dependency to enable seamless deployment on Vercel with Managed PostgreSQL.
- **Files Affected:** `server.js`, `db.js`, `api/index.js`, `vercel.json`, `package.json`.
- **Database Changes:** PostgreSQL schema initialization script (`schema.sql`) with relational parity to the 11 SQLite tables.
- **API Changes:** Transparent database adapter handling both synchronous SQLite (local) and asynchronous PostgreSQL pool (cloud).
- **Tests Required:**
  - `CLOUD-001`: PostgreSQL connection pooling and transaction commit/rollback.
  - `CLOUD-002`: Serverless cold-start verification and stateless token parsing.
  - `CLOUD-003`: Concurrent row-level locking during FEFO sale (`SELECT ... FOR UPDATE`).
- **Dependencies:** Phase 4.
- **Risks:** SQL dialect divergence between SQLite and PostgreSQL. (Mitigation: Use strictly ANSI-compliant SQL queries and parameterized statements).
- **Completion Criteria:** Application boots and passes all tests under both `DATABASE_URL` (PostgreSQL) and local SQLite.

---

### Phase 6: Inter-Pharmacy Federated Network & Stock Transfers
- **Objective:** Allow connected pharmacies to discover medicine availability and initiate formal stock-transfer requests without leaking proprietary data.
- **Files Affected:** `server.js`, `public/app.js`, `tests/inter-pharmacy.test.js`.
- **Database Changes:** Tables `pharmacy_connections`, `shared_inventory_settings`, `stock_transfers`.
- **API Changes:**
  - `GET /api/network/search`
  - `GET /api/network/connections`, `POST /api/network/connections/request`, `POST /api/network/connections/:id/respond`
  - `POST /api/network/transfers/request`, `GET /api/network/transfers`, `POST /api/network/transfers/:id/status`
- **Tests Required:**
  - `NET-001`: Connection handshake authorization between Pharmacy A and Pharmacy B.
  - `NET-002`: Search sanitization (purchase price and customer PII strictly hidden).
  - `NET-003`: Stock transfer dispatch and destination intake lifecycle.
- **Dependencies:** Phase 5.
- **Risks:** Unauthorized cross-tenant data scraping. (Mitigation: Enforce mutual handshake requirement before opening catalog visibility).
- **Completion Criteria:** Multi-branch search returns sanitized stock availability; transfer requests successfully transition states.

---

### Phase 7: Mobile Stock-Entry Frontend UI (PWA / Camera Scanner)
- **Objective:** Implement the dedicated mobile operator view with HTML5/WebRTC camera QR scanning, offline outbox storage (IndexedDB), and sync status.
- **Files Affected:** `public/mobile.html`, `public/mobile.js`, `public/styles.css`.
- **Database Changes:** Client-side IndexedDB database (`mediindex_offline_store`).
- **API Changes:** Consumes existing `/api/mobile/*` endpoints.
- **Tests Required:**
  - Browser camera stream integration tests.
  - IndexedDB outbox persistence and offline network toggle tests.
  - One-time device pairing UI flow.
- **Dependencies:** Phase 4.
- **Risks:** Camera permission denial on mobile browsers. (Mitigation: Provide manual input fallback alongside camera view).
- **Completion Criteria:** Mobile view scans QR codes in real-time and queues/syncs stock entries seamlessly.

---

### Phase 8: Full End-to-End System Integration
- **Objective:** Validate end-to-end user journeys spanning mobile QR intake, desktop POS sale with FEFO, demand analytics recalculation, and inter-pharmacy transfers.
- **Files Affected:** Full repository audit and end-to-end integration test suites.
- **Tests Required:** Full suite of 45+ comprehensive end-to-end tests across local and cloud environments.
- **Completion Criteria:** Zero defects across POS, inventory, analytics, mobile, and inter-pharmacy workflows.

---

### Phase 9: Security Audit, Vercel Production Deployment & Academic Defense
- **Objective:** Execute final vulnerability scans, deploy live production instance on Vercel, and prepare presentation artifacts for Major Project-II evaluation.
- **Deliverables:** Live Vercel deployment URL, complete architectural documentation, demonstration video, and slide deck.
- **Completion Criteria:** 100% test pass rate, verified SSL certificates, production database backups active, and full project defense readiness.
