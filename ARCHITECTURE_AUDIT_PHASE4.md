# MediIndex — Phase 4 Architecture Audit Report
## Systems Architecture, Offline-First Feasibility, Cloud Topology & Inter-Pharmacy Design

**Project:** MediIndex – Pharmacy Insights, POS & Analytics Platform  
**Academic Context:** B.Tech Major Project-II  
**Audit Date:** September 2026  
**Audited Baseline:** 32/32 Automated Tests Passing (100% Pass Rate)  
**Document Status:** ARCHITECTURAL AUDIT & FORMAL DESIGN (NO IMPLEMENTATION COMMENCED)

---

## 1. Executive Summary

MediIndex is a specialized, multi-tenant pharmacy management and intelligence platform designed for independent community pharmacies and multi-branch pharmacy networks. Following the completion and hardening of **MOD-14 (Mobile Device One-Time Pairing)** and **MOD-15 (Mobile Stock-Entry API Pipeline)**, the system features a verified core comprising authentication, medicine cataloguing, multi-batch FEFO inventory deduction, demand forecasting (Weighted Moving Average), expiry monitoring, 2D store shelf location, QR code identification, and device-authenticated stock intakes.

This Phase 4 Architecture Audit rigorously evaluates the transition from a single-node, local SQLite system into a robust **hybrid offline-first / cloud-distributed architecture** supporting:
1. **Durable Local Operation (Offline-First):** Uninterrupted scanning, medicine identification, and stock receipt queuing during network blackouts.
2. **Deterministic Asynchronous Synchronization:** Outbox-driven sync with mathematical idempotency and conflict-free delta reconciliation.
3. **Stateless Serverless Execution (Vercel):** Migration from local disk-bound SQLite to serverless-compatible pooled cloud persistence (PostgreSQL).
4. **Inter-Pharmacy Federated Network:** Privacy-preserving cross-pharmacy medicine availability queries and inter-store stock transfers.

---

## 2. Audit of Current Source Code & Runtime Architecture

A comprehensive line-by-line inspection of [`server.js`](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/server.js), [`public/app.js`](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/public/app.js), and database access layers yielded the following architectural inventory:

### 2.1 Server Startup & Process Lifecycle
- **HTTP Engine:** Node.js native `node:http` server instantiated via `http.createServer((req, res) => handler(req, res))`. Zero third-party web frameworks (no Express/Fastify).
- **Process Model:** Single-process, event-loop-driven daemon listening on `PORT = process.env.PORT || 3000`.
- **Database Engine:** Node.js built-in `node:sqlite` (`DatabaseSync`) establishing synchronous local file connections at `DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mediindex.db')`.
- **Concurrency Mode:** SQLite Write-Ahead Logging (`PRAGMA journal_mode = WAL`) with busy timeout `PRAGMA busy_timeout = 5000`.

### 2.2 Session Management & Authentication
- **User Sessions:** Stateful relational storage in `sessions` table (`session_token`, `user_id`, `expires_at`). Authenticated via `HttpOnly; SameSite=Strict` cookie (`mediindex_session`).
- **Mobile Hardware Tokens:** Stateful storage in `paired_devices` table. Authentication uses 256-bit cryptographically random tokens passed via `X-Device-Token` or `Authorization: Bearer <token>`, resolved by computing `sha256(token)` against `paired_devices.token_hash`.
- **Tenancy Authority:** The server resolves `pharmacy_id` strictly from the session/device record. Any client-provided `pharmacy_id` in request payloads is rejected with `400 Bad Request`.

### 2.3 Transaction Boundaries & Mutation Logic
- **ACID Controls:** Critical multi-table updates (e.g., POS sales deduction, mobile stock intake) execute inside synchronous transactions using `db.exec('BEGIN IMMEDIATE')`, `db.exec('COMMIT')`, and `db.exec('ROLLBACK')`.
- **Idempotency Guard:** `idempotency_keys` table indexed on `PRIMARY KEY (key, pharmacy_id)` caches transaction outputs keyed by `sha256(normalizedPayload)`.
- **Audit Logging:** Every inventory mutation generates an immutable record in `inventory_movements` with `reason IN ('RECEIPT', 'ADJUSTMENT', 'SALE')`, `created_by` (authorizing user), and `device_id` (originating mobile hardware).

---

## 3. Subsystem Categorization & Vercel Serverless Compatibility

| Codebase Component | Runtime Category | Offline Capability | Cloud / Vercel Compatibility | Architectural Verdict |
|---|---|---|---|---|
| **Static Web SPA (`public/*`)** | Client-side Asset | Full (via Cache/Service Worker) | Compatible (Static CDN Edge) | **Deployable directly to Vercel CDN.** |
| **HTTP Request Router (`server.js`)** | Node.js Runtime | Local Edge only | Compatible (Vercel Serverless Function) | **Wrap `handler(req, res)` into API route.** |
| **Scrypt Password & Token Hashing** | Native Crypto | Full | Fully Compatible (Stateless CPU) | **Zero architectural change required.** |
| **WMA Demand Forecasting Engine** | Compute Logic | Full (with local data) | Fully Compatible (Stateless CPU) | **Zero architectural change required.** |
| **Local SQLite File (`mediindex.db`)** | Local Storage | Full (Edge device) | **INCOMPATIBLE with Serverless** | **MUST NOT be deployed as writable cloud DB.** |
| **Stateful DB Sessions (`sessions`)** | Database Table | Local only | Compatible if DB is remote | **Migrate persistence to Cloud PostgreSQL.** |
| **Idempotency Log (`idempotency_keys`)**| Database Table | Local only | Compatible if DB is remote | **Migrate persistence to Cloud PostgreSQL.** |
| **Inter-Pharmacy Catalogue Discovery**| Federated Network| Network dependent | Requires Central Cloud DB | **Requires Cloud Database aggregation.** |

### Detailed Explanation of Vercel Serverless Incompatibility (Local SQLite)
1. **Ephemeral Containers:** Vercel executes serverless functions inside isolated micro-containers. The local disk filesystem (`/tmp`) is ephemeral and destroyed when instances scale down or recycle.
2. **Multi-Instance State Drift:** Concurrent user requests trigger separate serverless invocations running on physically distinct microVMs. Two concurrent Lambdas writing to separate local SQLite files would diverge instantly, causing catastrophic financial and inventory data loss.
3. **Cross-Invocation File Locking:** SQLite WAL mode relies on POSIX shared memory (`.shm`) and file locks (`.wal`), which do not cross network boundaries or serverless instance boundaries.

---

## 4. Proposed Hybrid Target Architecture

To satisfy both **offline-first local pharmacy reliability** and **cloud-based inter-pharmacy intelligence**, MediIndex will adopt a two-tier **Edge-Cloud Hybrid Architecture**:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 PHARMACY LOCAL EDGE                                      │
│                                                                                         │
│   ┌───────────────────────────┐                ┌──────────────────────────────────┐     │
│   │   Mobile Stock Scanner    │                │      Desktop POS & Management    │     │
│   │   (PWA / Android Camera)  │                │      (Vanilla SPA / Local Server)│     │
│   └─────────────┬─────────────┘                └────────────────┬─────────────────┘     │
│                 │ (Wi-Fi / Local REST)                          │                       │
│                 ▼                                               ▼                       │
│   ┌───────────────────────────────────────────────────────────────────────────────┐     │
│   │                      LOCAL EDGE NODE / PERSISTENCE LAYER                      │     │
│   │  - Local SQLite DB (`mediindex.db`) / IndexedDB Outbox Queue                  │     │
│   │  - Instant Zero-Latency Billing & FEFO Stock Allocations                      │     │
│   │  - Local Offline Stock-Entry Queue (`client_stock_queue`)                     │     │
│   └───────────────────────────────────────┬───────────────────────────────────────┘     │
└───────────────────────────────────────────┼─────────────────────────────────────────────┘
                                            │ HTTPS / TLS (Asynchronous Sync Outbox)
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                  CLOUD PLATFORM (VERCEL)                                │
│                                                                                         │
│   ┌───────────────────────────────────────────────────────────────────────────────┐     │
│   │                     VERCEL SERVERLESS EDGE API ROUTER                         │     │
│   │  - Stateless Node.js Serverless Functions (`/api/*`)                          │     │
│   │  - Device & User Token Authentication Gateway                                 │     │
│   │  - Synchronizer & Idempotency Delta Engine (`/api/sync/push`, `/api/sync/pull`)│     │
│   │  - Inter-Pharmacy Network Discovery Gateway (`/api/network/*`)                │     │
│   └───────────────────────────────────────┬───────────────────────────────────────┘     │
│                                           │ Connection Pool (SSL)                       │
│                                           ▼                                             │
│   ┌───────────────────────────────────────────────────────────────────────────────┐     │
│   │                 CENTRAL CLOUD DATABASE (MANAGED POSTGRESQL)                   │     │
│   │  - Authoritative Global Ledger (Multi-Tenant Segregation by `pharmacy_id`)    │     │
│   │  - ACID Transactions with `SELECT ... FOR UPDATE` Row-Level Locking           │     │
│   │  - Master Idempotency & Movement Audit Registry                               │     │
│   │  - Federated Inter-Pharmacy Stock Catalog Index                               │     │
│   └───────────────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Summary of Audit Findings

1. **Current Baseline Defensibility:** The current Node.js + SQLite implementation is 100% verified, clean, and robust for single-node local operation (32/32 tests pass).
2. **Local Edge Value:** Retaining the local SQLite database for on-premise single-pharmacy deployments guarantees instant POS checkout times and true offline survival during ISP outages.
3. **Cloud Strategy:** Cloud deployment to Vercel requires decoupling the storage layer into a managed PostgreSQL database, leaving the core business rules and API contracts identical.
4. **Synchronization Model:** Offline stock entry and billing must be synchronized via an additive, outbox-driven delta protocol with strict server-side validation.
5. **No Production Code Disruption:** This audit strictly preserves the existing 32/32 test suite without modifying production runtime code.
