# MediIndex — Vercel Cloud Deployment & Persistence Architecture
## Serverless Compatibility, Database Adapter Layer & PostgreSQL Schema Mapping

**Project:** MediIndex – Pharmacy Insights, POS & Analytics  
**Document Code:** SPEC-VERCEL-DEPLOY-V1  
**Status:** CLOUD ARCHITECTURAL SPECIFICATION  

---

## 1. Executive Summary

Deploying MediIndex to the **Vercel Cloud Platform** enables high-availability global access, instant SSL provisioning, edge asset delivery, and centralized inter-pharmacy intelligence. However, Vercel's execution model is **stateless serverless computing**.

This document outlines the exact architectural modifications required to transition MediIndex from a local disk-bound SQLite setup into a 100% serverless-compatible cloud application without changing the existing business logic, authentication semantics, or API contracts.

---

## 2. Serverless Execution Constraints on Vercel

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       VERCEL SERVERLESS RUNTIME REALITY                     │
├───────────────────────────────────┬─────────────────────────────────────────┤
│ Serverless Property               │ Impact on MediIndex                     │
├───────────────────────────────────┼─────────────────────────────────────────┤
│ Ephemeral MicroVM Containers      │ Local files (`mediindex.db`) are wiped  │
│                                   │ when lambdas scale to zero or recycle.  │
├───────────────────────────────────┼─────────────────────────────────────────┤
│ Multi-Instance Concurrency        │ Two concurrent requests execute on      │
│                                   │ separate physical nodes with no shared  │
│                                   │ in-memory state or shared disk files.   │
├───────────────────────────────────┼─────────────────────────────────────────┤
│ Short-Lived Execution Lifespan    │ Background loops or long-lived daemons  │
│ (Max duration 10s - 60s)          │ cannot run indefinitely.                │
├───────────────────────────────────┼─────────────────────────────────────────┤
│ Read-Only Deployment Bundle       │ Writing to the project directory is     │
│                                   │ forbidden at runtime (only `/tmp` open).│
└───────────────────────────────────┴─────────────────────────────────────────┘
```

**Conclusion:** The local SQLite database file `mediindex.db` cannot serve as the authoritative persistent database on Vercel. Centralized cloud persistence (Managed PostgreSQL) is mandatory for cloud deployments.

---

## 3. Recommended Cloud Architecture for Major Project

To keep the architecture simple, robust, cost-effective, and academic-defense-ready:

- **Frontend Hosting:** Vercel Global Edge Network (Static CDN for `public/*`).
- **Serverless API Layer:** Node.js Serverless Function mapping `/api/*` requests to the unified `handler(req, res)` router.
- **Managed Database Layer:** **PostgreSQL** (e.g., Neon Serverless Postgres, Supabase, or Vercel Postgres) accessed via connection pooling over SSL.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                 VERCEL CLOUD                                 │
│                                                                              │
│   ┌────────────────────────────────┐    ┌────────────────────────────────┐   │
│   │       Vercel Static Edge       │    │     Vercel Serverless API      │   │
│   │         (HTML/CSS/JS)          │    │      (`api/index.js` Router)   │   │
│   └────────────────────────────────┘    └───────────────┬────────────────┘   │
└─────────────────────────────────────────────────────────┼────────────────────┘
                                                          │ Connection Pool
                                                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                       MANAGED POSTGRESQL CLOUD DATABASE                      │
│                                                                              │
│   • Multi-Tenant Relational Tables (Identical 11 Tables Schema)              │
│   • Row-Level Locking via `SELECT ... FOR UPDATE` (FEFO Deductions)          │
│   • Composite Unique Indexes (`idempotency_keys(key, pharmacy_id)`)          │
│   • Secure SSL Connection Strings (`DATABASE_URL`)                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Dual-Mode Database Adapter Pattern

To maintain the ability to run **offline/locally with zero configuration** while simultaneously supporting **cloud deployment on Vercel**, MediIndex will utilize an abstraction adapter:

```javascript
// db.js (Conceptual Architecture)
const isCloud = Boolean(process.env.DATABASE_URL);

let db;
if (isCloud) {
  const { Pool } = require('pg');
  db = new PostgresAdapter(new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }));
} else {
  const { DatabaseSync } = require('node:sqlite');
  db = new SqliteAdapter(new DatabaseSync(process.env.DB_PATH || './mediindex.db'));
}

module.exports = db;
```

---

## 5. PostgreSQL Schema & Dialect Mapping

The 11 SQLite tables map directly to standard ANSI PostgreSQL with 100% relational parity:

| SQLite Feature | PostgreSQL Equivalent | Notes |
|---|---|---|
| `INTEGER PRIMARY KEY` | `BIGSERIAL PRIMARY KEY` | Standard auto-incrementing surrogate key. |
| `TEXT` | `TEXT` / `VARCHAR` | UTF-8 string storage. |
| `REAL` | `NUMERIC(12, 2)` / `DOUBLE PRECISION` | Exact decimal precision for currency/prices. |
| `CURRENT_TIMESTAMP` | `CURRENT_TIMESTAMP` | Standard ISO timestamp with timezone. |
| `CHECK(...)` | `CHECK(...)` | Supported natively in PostgreSQL DDL. |
| `BEGIN IMMEDIATE` | `BEGIN; SELECT ... FOR UPDATE;` | PostgreSQL explicit row-level locking for atomic deductions. |

---

## 6. Vercel File Structure & Routing

```
/MediIndex
  ├── api/
  │    └── index.js             # Vercel entry point forwarding to server.handler
  ├── public/                   # Static Single Page App (Served automatically by Vercel CDN)
  │    ├── index.html
  │    ├── app.js
  │    └── styles.css
  ├── server.js                 # Unified core application & route handler
  ├── vercel.json               # Vercel routing & headers configuration
  ├── package.json
  └── tests/                    # In-process test suite (runs in CI and locally)
```

### `vercel.json` Specification
```json
{
  "version": 2,
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/index.js" },
    { "source": "/(.*)", "destination": "/public/$1" }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-XSS-Protection", "value": "1; mode=block" }
      ]
    }
  ]
}
```

---

## 7. Migration Checklist & Status
 
1. [x] **Database Adapter Layer Foundation (Phase 5A):** Implemented `db/sqlite-adapter.js`, `db/postgres-adapter.js`, and factory `db/index.js`.
2. [x] **PostgreSQL DDL Schema (Phase 5A):** Authored complete cluster schema script in `db/schema.pg.sql`.
3. [x] **Safe Connection Handling (Phase 5A):** Parameterized queries (`convertPlaceholders`), credentials masking, and URL validation.
4. [x] **Transaction Isolation Model (Phase 5A):** Documented row-level write-safety model (`SELECT ... FOR UPDATE` on `medicine_batches`).
5. [x] **Serverless Entrypoint Wrapper (Phase 5A):** Minimal `api/index.js` routing to `server.js` handler.
6. [x] **Adapter Test Suite (Phase 5A):** Added 8 focused adapter tests (`tests/adapters.test.js` PASS 8/8).
7. [x] **Cloud Session Persistence (Phase 5B):** Migrated in-memory session Map to database-backed `sessions` table with SHA-256 hashed tokens (`tests/sessions.test.js` PASS 12/12; full test suite 67/67 PASS).
8. [x] **Vercel Configuration (Phase 5C):** Created `vercel.json` with routes, builds, and security headers.
9. [x] **PostgreSQL Integration Test Suite (Phase 5C):** Implemented 9 comprehensive tests covering schema, authentication, transactions, idempotency, and tenant isolation (`tests/postgres-integration.test.js`).
10. [x] **Environment Configuration (Phase 5C):** Created `.env.example` with DATABASE_URL documentation.
11. [ ] **Live PostgreSQL Verification (Phase 5C Pending):** Requires DATABASE_URL configuration for integration test execution.
12. [ ] **Vercel Preview Deployment (Phase 5C Pending):** Deploy test preview branch to Vercel and verify against cloud PostgreSQL.

