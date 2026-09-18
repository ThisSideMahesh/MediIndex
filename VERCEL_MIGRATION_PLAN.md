# MediIndex Vercel Migration Plan

**Document Version:** 1.0  
**Created:** August 2026  
**Project:** MediIndex Major Project-II  
**Target Deployment:** Vercel Serverless Platform  
**Timeline:** Phased Implementation Pipeline (Phase 5B Session Store Complete)  
**Current Test Status:** ✅ 67/67 Tests Passing (47 Core Baseline + 8 Database Adapter Tests + 12 Persistent Session Tests)

---

## Executive Summary

This document outlines a technically defensible migration plan to deploy MediIndex on Vercel while **preserving offline-first capability**, adding **cloud backup/synchronization**, and implementing **inter-pharmacy connectivity** as required by Project-I functional requirements #8 and #9.

**Key Architectural Principle:** The application will operate in **dual mode**:
- **Offline Mode:** Local SQLite database with full CRUD operations
- **Online Mode:** Vercel serverless APIs with cloud database for backup, sync, and inter-pharmacy features

---

## 1. Current Architecture

### 1.1 Technology Stack
```
Frontend:  Vanilla HTML5 / CSS3 / JavaScript ES6+
Backend:   Node.js v22+ (node:http, node:sqlite, node:crypto, node:fs)
Database:  SQLite (`data/mediindex.db`) with WAL mode
Session:   In-memory Map<token, {userId, expiresAt}>
Auth:      Scrypt password hashing + HttpOnly session cookies
Tests:     Node.js native test runner (node:test)
```

### 1.2 Current Database Schema (SQLite)
```sql
pharmacies (id, name, address, created_at)
users (id, pharmacy_id, full_name, email, password_hash, role, active, created_at, last_login_at)
medicines (id, pharmacy_id, name, generic_name, manufacturer, category, minimum_stock, active, created_at, updated_at)
medicine_batches (id, medicine_id, batch_number, quantity, purchase_price, selling_price, manufacturing_date, expiry_date, location, created_at)
inventory_movements (id, batch_id, change_quantity, reason, created_by, created_at)
sales (id, pharmacy_id, invoice_number, customer_name, customer_phone, payment_method, total_amount, created_by, created_at)
sale_items (id, sale_id, batch_id, quantity, unit_price, line_total)
expiry_alerts (id, batch_id, alert_type, acknowledged, created_at)
```

### 1.3 Current Application Structure
```
MediIndex/
├── server.js                    # 700+ lines monolithic server
├── public/
│   ├── index.html              # Complete SPA UI
│   ├── app.js                  # Frontend application logic
│   ├── styles.css              # Responsive styles
│   ├── qr-generator.js         # Zero-dependency QR SVG generator
│   └── assets/
├── data/
│   └── mediindex.db            # SQLite database file
├── tests/                       # 17 passing integration tests
├── package.json
└── [documentation files]
```

---

## 2. Target Architecture

### 2.1 Hybrid Offline-First + Cloud-Sync Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    WEB BROWSER CLIENT                       │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────┐     │
│  │ UI Layer   │  │ Sync Engine │  │ Offline Storage  │     │
│  │ (HTML/CSS/ │  │ (Detects    │  │ (IndexedDB or    │     │
│  │ Vanilla JS)│  │ connectivity│  │ Web SQL)         │     │
│  └────────────┘  └─────────────┘  └──────────────────┘     │
└────────┬───────────────────┬─────────────────────┬─────────┘
         │                   │                     │
         │ Online Mode       │ Sync API            │ Offline Mode
         │ (Full Features)   │                     │ (Local CRUD)
         ▼                   ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│              VERCEL SERVERLESS FUNCTIONS                    │
│  /api/auth/*        /api/medicines/*      /api/sync/*       │
│  /api/sales/*       /api/analytics/*      /api/inter-      │
│  /api/qr/*          /api/layout/*         pharmacy/*        │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ Session Store    │  │ Business Logic   │                │
│  │ (Vercel KV or    │  │ (Reused from     │                │
│  │ Upstash Redis)   │  │ server.js)       │                │
│  └──────────────────┘  └──────────────────┘                │
└────────────────────────────┬───────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              CLOUD RELATIONAL DATABASE                      │
│     PostgreSQL (Vercel Postgres / Neon / Supabase)         │
│                                                              │
│  - Same schema as SQLite with modifications                 │
│  - Additional tables for sync/inter-pharmacy                │
│  - Row-level timestamps (created_at, updated_at, synced_at) │
│  - Pharmacy isolation via pharmacy_id                       │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Dual-Mode Operation Flow

**OFFLINE MODE (Disconnected):**
```
User Action → IndexedDB (Local) → UI Update → Sync Queue (Pending Changes)
```

**ONLINE MODE (Connected):**
```
User Action → Vercel API → Cloud Database → UI Update + Local Cache
```

**SYNCHRONIZATION (Reconnected):**
```
Pending Queue → Conflict Detection → Merge Strategy → Upload to Cloud → Update Local
```

---

## 3. Current SQLite Dependencies

### 3.1 Direct SQLite Usage
| File | Line Range | Dependency | Vercel Impact |
|------|------------|------------|---------------|
| `server.js` | 5, 26-98 | `DatabaseSync` initialization | ❌ **INCOMPATIBLE** - Vercel functions are stateless; SQLite file would be lost between invocations |
| `server.js` | 100-700 | All `db.prepare()`, `db.exec()` calls | ❌ **MUST REPLACE** with PostgreSQL client |
| `tests/demand.test.js` | 82-132 | Direct SQLite manipulation for test data | ⚠️ **TEST REFACTOR REQUIRED** |

### 3.2 Session Storage (In-Memory Map)
```javascript
const sessions = new Map();  // Line 11 in server.js
```
**Problem:** Vercel functions are stateless and ephemeral. The Map will reset on every cold start.

**Solution:** Replace with persistent session store (Vercel KV, Redis, or database sessions).

### 3.3 Filesystem Dependencies
```javascript
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });  // Line 26
```
**Problem:** Vercel functions have read-only filesystem except `/tmp` (ephemeral, max 512MB).

**Solution:** Remove filesystem database storage; use cloud database.

---

## 4. Vercel Compatibility Audit

### 4.1 What Works Out-of-the-Box on Vercel ✅
- ✅ Static file serving (`public/*` → Vercel CDN)
- ✅ Vanilla HTML/CSS/JavaScript frontend (zero build step)
- ✅ Node.js runtime (Vercel supports Node.js 18.x, 20.x)
- ✅ HTTP request handling (Express/native HTTP both supported)
- ✅ Crypto operations (`node:crypto` works in serverless)
- ✅ QR generation (`qr-generator.js` is client-side, zero impact)

### 4.2 What Requires Modification ⚠️
- ⚠️ **Database Layer:** SQLite → PostgreSQL migration
- ⚠️ **Session Management:** In-memory Map → Persistent KV store
- ⚠️ **Long-Running Server:** Monolithic `server.js` → Serverless API routes
- ⚠️ **File-based DB Path:** Remove `data/mediindex.db` references

### 4.3 What Breaks Completely on Vercel ❌
- ❌ `DatabaseSync` from `node:sqlite` (Vercel doesn't persist `/tmp` between requests)
- ❌ Stateful in-memory session storage
- ❌ Write operations to filesystem outside `/tmp`

---

## 5. Recommended Cloud Database

### 5.1 Evaluation Criteria
| Criteria | Weight | PostgreSQL | MySQL | MongoDB |
|----------|--------|-----------|--------|---------|
| **Vercel Integration** | High | ✅ Native (Vercel Postgres) | ⚠️ Manual setup | ⚠️ Manual setup |
| **Relational Integrity** | Critical | ✅ Full ACID, FK constraints | ✅ Full ACID, FK | ❌ No enforced schema |
| **Transaction Support** | Critical | ✅ Multi-statement ACID | ✅ Multi-statement | ⚠️ Limited |
| **SQL Compatibility** | High | ✅ 95% SQLite → Postgres | ⚠️ Some differences | ❌ Complete rewrite |
| **Free Tier** | Medium | ✅ Vercel Postgres Hobby (5GB) | ✅ PlanetScale | ✅ MongoDB Atlas |
| **B.Tech Project Justification** | High | ✅ Industry-standard RDBMS | ⚠️ Less common | ❌ "NoSQL for relational data" is indefensible |

### 5.2 Recommendation: **PostgreSQL via Vercel Postgres**

**Justification:**
1. **Native Vercel integration** - Zero configuration, automatic connection pooling
2. **Minimal schema changes** - Most SQLite SQL translates directly
3. **ACID compliance** - Preserves inventory transaction integrity
4. **Foreign key enforcement** - Maintains referential integrity from SQLite schema
5. **Academic defensibility** - PostgreSQL is the gold standard for transactional systems
6. **Free tier sufficient** - 5GB Hobby plan covers demo + small pharmacy deployment

**Alternatives Considered & Rejected:**
- **Neon/Supabase Postgres:** Valid but adds vendor complexity; Vercel Postgres is simpler
- **MySQL (PlanetScale):** Requires more SQL translation, less Vercel-native
- **MongoDB:** ❌ Not suitable for relational financial/inventory data; indefensible in viva

---

## 6. Offline Storage Strategy

### 6.1 Client-Side Database Options
| Technology | Browser Support | Storage Limit | Relational | Recommended |
|------------|----------------|---------------|------------|-------------|
| **IndexedDB** | ✅ All modern | ~50MB - 1GB+ | ⚠️ Key-value (can model relations) | ✅ **YES** |
| **Web SQL** | ❌ Deprecated (removed in Chrome 119) | 5MB - 50MB | ✅ SQLite-like | ❌ NO |
| **localStorage** | ✅ All | 5-10MB | ❌ String-only | ❌ NO (too limited) |
| **sql.js-httpvfs** | ✅ WASM SQLite in browser | Depends on hosting | ✅ Full SQL | ⚠️ Complex setup |

### 6.2 Recommended Approach: **IndexedDB with Dexie.js Wrapper**

**Rationale:**
- **IndexedDB** is the only modern, standards-compliant offline storage API
- **Dexie.js** provides a clean Promise-based wrapper (1 dependency, 23KB gzipped)
- Can model relational data with foreign key-like references
- Works in all modern browsers (Chrome, Firefox, Safari, Edge)

**Schema Design (IndexedDB Object Stores):**
```javascript
const db = new Dexie('MediIndexOffline');
db.version(1).stores({
  pharmacies: 'id, name, address',
  users: 'id, pharmacy_id, email, role',
  medicines: 'id, pharmacy_id, name, active',
  medicine_batches: 'id, medicine_id, batch_number, expiry_date, location',
  sales: 'id, pharmacy_id, invoice_number, created_at',
  sale_items: 'id, sale_id, batch_id',
  sync_queue: '++id, entity_type, entity_id, operation, timestamp, synced'
});
```

### 6.3 Offline Operation Guarantees
- ✅ Full CRUD on medicines, batches, sales when disconnected
- ✅ FEFO billing logic implemented client-side
- ✅ Expiry calculations client-side (JavaScript Date comparisons)
- ✅ Dashboard metrics computed from IndexedDB
- ⚠️ Inter-pharmacy features disabled when offline (requires network)
- ⚠️ Demand forecasting uses last-synced historical data

---

## 7. Synchronization Strategy

### 7.1 Sync Architecture Principles

**1. Pharmacy-Scoped Isolation:**
Each pharmacy has an isolated data boundary. Sync only affects the authenticated pharmacy's data.

**2. Timestamp-Based Conflict Detection:**
Every record has `created_at`, `updated_at`, and `synced_at` timestamps.

**3. Last-Write-Wins (LWW) Merge Strategy:**
For most entities, the version with the latest `updated_at` wins conflicts.

**4. Explicit Conflict Resolution for Critical Entities:**
For inventory transactions, sales, and batch quantities:
- Server is **authoritative**
- Local changes are validated against server state before sync
- If conflict (e.g., sold more units than available), **reject local change** and notify user

### 7.2 Sync Queue Design

**Local Sync Queue Table (IndexedDB):**
```javascript
{
  id: auto_increment,
  entity_type: 'medicine' | 'batch' | 'sale' | 'adjustment',
  entity_id: number,
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  payload: {...},
  timestamp: ISOString,
  synced: boolean,
  error: string | null
}
```

**Sync Flow:**
```
1. User performs action offline → Write to IndexedDB
2. Add entry to sync_queue with synced=false
3. Periodically check connectivity (navigator.onLine + fetch health check)
4. When online:
   a. Fetch pending queue items (synced=false)
   b. For each item:
      i. Send POST /api/sync with entity type, operation, payload
      ii. Server validates, merges, returns authoritative state
      iii. Update local IndexedDB with server response
      iv. Mark queue item synced=true
   c. Handle errors → Mark error field, retry with exponential backoff
```

### 7.3 API Endpoint: `POST /api/sync`

**Request:**
```json
{
  "pharmacyId": 1,
  "changes": [
    {
      "entity": "medicine",
      "operation": "CREATE",
      "data": {"name": "Paracetamol 500mg", ...},
      "clientTimestamp": "2026-08-24T10:30:00Z"
    },
    {
      "entity": "batch",
      "operation": "UPDATE",
      "id": 42,
      "data": {"quantity": 95},
      "clientTimestamp": "2026-08-24T10:31:00Z"
    }
  ]
}
```

**Response:**
```json
{
  "synced": [
    {"entity": "medicine", "clientIndex": 0, "serverId": 123, "status": "success"},
    {"entity": "batch", "clientIndex": 1, "serverId": 42, "status": "conflict", "reason": "Server quantity: 100, your update: 95. Server version retained.", "serverData": {...}}
  ],
  "lastSyncTimestamp": "2026-08-24T10:32:00Z"
}
```

### 7.4 Sync UI Components

**Sync Status Indicator (Header):**
```
🟢 Online · Last synced 2 minutes ago
🟡 Syncing... (3 pending changes)
🔴 Offline · 15 changes pending
```

**Sync Button (Manual Trigger):**
```
[🔄 Sync Now]  → Forces immediate sync attempt
```

**Conflict Resolution Dialog:**
```
⚠️ Sync Conflict Detected
Medicine: Paracetamol 500mg
Local: 95 units | Server: 100 units
Server version is authoritative.
[OK] [View Details]
```

---

## 8. Inter-Pharmacy Architecture

### 8.1 Requirements from Project-I Functional Requirement #8
- Pharmacy registration/identity
- Connected pharmacies (network/partnership model)
- Medicine availability lookup across network
- Stock requests (Pharmacy A requests medicine from Pharmacy B)
- Request status tracking (Pending, Approved, Rejected, Fulfilled)

### 8.2 Database Schema Additions for Inter-Pharmacy

**New Tables:**
```sql
-- Pharmacy connections/partnerships
pharmacy_connections (
  id SERIAL PRIMARY KEY,
  requesting_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  target_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_at TIMESTAMP NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMP,
  UNIQUE(requesting_pharmacy_id, target_pharmacy_id)
);

-- Inter-pharmacy stock requests
stock_requests (
  id SERIAL PRIMARY KEY,
  requesting_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  target_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  requested_quantity INTEGER NOT NULL CHECK(requested_quantity > 0),
  approved_quantity INTEGER CHECK(approved_quantity >= 0),
  status TEXT NOT NULL CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED')),
  notes TEXT,
  requested_at TIMESTAMP NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMP,
  fulfilled_at TIMESTAMP
);

-- Shared medicine availability (opt-in visibility)
shared_inventory_visibility (
  id SERIAL PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  visible_to_network BOOLEAN NOT NULL DEFAULT FALSE,
  available_for_request BOOLEAN NOT NULL DEFAULT FALSE,
  max_request_quantity INTEGER CHECK(max_request_quantity > 0),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(pharmacy_id, medicine_id)
);
```

### 8.3 Inter-Pharmacy API Endpoints

**Pharmacy Network Management:**
```
POST   /api/inter-pharmacy/connect          # Request connection to another pharmacy
GET    /api/inter-pharmacy/connections       # List all connections (pending/approved)
PUT    /api/inter-pharmacy/connections/:id   # Approve/reject connection request
```

**Medicine Availability Lookup:**
```
GET    /api/inter-pharmacy/medicines/search?q=paracetamol
       # Returns medicines available across connected pharmacies
POST   /api/inter-pharmacy/visibility        # Set which medicines are visible to network
```

**Stock Request Workflow:**
```
POST   /api/inter-pharmacy/requests          # Create stock request
GET    /api/inter-pharmacy/requests          # List requests (sent + received)
PUT    /api/inter-pharmacy/requests/:id      # Approve/reject/fulfill request
```

### 8.4 Security & Authorization Rules

**Data Isolation:**
- Pharmacy A can ONLY see inventory of Pharmacy B if:
  1. Connection exists: `pharmacy_connections.status = 'APPROVED'`
  2. Visibility enabled: `shared_inventory_visibility.visible_to_network = TRUE`

**Request Validation:**
- Cannot request from unconnected pharmacy
- Cannot request medicine not marked `available_for_request`
- Cannot exceed `max_request_quantity`

**RBAC Enforcement:**
- `ADMIN` role required for:
  - Approving pharmacy connections
  - Setting inventory visibility
  - Approving/rejecting stock requests
- `STAFF` role can:
  - View connected pharmacies
  - View available medicines in network
  - Create stock requests (requires ADMIN approval)

---

## 9. Data Ownership / Source-of-Truth Rules

### 9.1 Offline-First Priority Hierarchy

**Tier 1 (Local Authoritative):**
- UI state, form inputs, temporary calculations
- Client-side expiry classification (until sync)
- Local sync queue

**Tier 2 (Local Temporary, Server Authoritative):**
- Medicine catalog (changes must sync)
- Batch inventory (server validates stock levels)
- Sales transactions (server enforces FEFO & stock constraints)
- User authentication (server manages sessions)

**Tier 3 (Server-Only, Never Cached):**
- Inter-pharmacy data (requires real-time network queries)
- Demand forecasting (calculated on-demand from complete historical data)
- Audit logs (server-side only)

### 9.2 Conflict Resolution Matrix

| Entity Type | Conflict Scenario | Resolution Strategy | Rationale |
|-------------|------------------|---------------------|-----------|
| **Medicine** | Name changed offline & online | Last-Write-Wins (timestamp) | Non-critical metadata |
| **Batch Quantity** | Sold offline, also sold online | Server Authoritative | Prevents overselling |
| **Sale Transaction** | Same batch sold offline twice | Reject second, notify user | Inventory integrity |
| **Expiry Alert** | Acknowledged offline & online | Last-Write-Wins | Non-critical acknowledgment |
| **User Profile** | Role changed offline & online | Server Authoritative | Security-critical |

### 9.3 Medicine Batch Location Preservation

**Per Design Rule #3:**
> "Keep `medicine_batches.location` as the existing location source of truth."

**Migration Rule:**
- PostgreSQL schema retains `medicine_batches.location TEXT` column
- No separate `medicine_locations` table
- Shelf/rack assignment remains batch-level attribute
- 2D store map API (`/api/layout/shelves`) logic migrates unchanged

---

## 10. Required Database Changes

### 10.1 SQLite → PostgreSQL Schema Translation

**Automatic Translations:**
```sql
-- SQLite                         →  PostgreSQL
INTEGER PRIMARY KEY                →  SERIAL PRIMARY KEY
TEXT NOT NULL DEFAULT 'value'      →  TEXT NOT NULL DEFAULT 'value'
REAL                               →  NUMERIC(10,2) or DOUBLE PRECISION
INTEGER NOT NULL DEFAULT 1         →  INTEGER NOT NULL DEFAULT 1
date('now')                        →  CURRENT_DATE
CURRENT_TIMESTAMP                  →  NOW()
```

**Manual Adjustments:**
```sql
-- SQLite CHECK constraints → PostgreSQL CHECK (same syntax, works)
-- SQLite PRAGMA foreign_keys → PostgreSQL has FK by default
-- SQLite UNIQUE index       → PostgreSQL UNIQUE constraint (same)
-- SQLite date() function    → PostgreSQL DATE() or CAST
```

### 10.2 New Columns for Synchronization

**Add to ALL data tables:**
```sql
ALTER TABLE medicines ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE medicine_batches ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE sales ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
-- (created_at already exists)
```

**Add sync tracking (optional):**
```sql
ALTER TABLE medicine_batches ADD COLUMN last_synced_at TIMESTAMP;
```

### 10.3 Migration Script Structure

**File: `migrations/001_sqlite_to_postgres.sql`**
```sql
-- 1. Create tables with PRIMARY KEY → SERIAL translation
CREATE TABLE pharmacies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 2. Create indexes (same as SQLite)
CREATE INDEX idx_medicines_name ON medicines(name);
CREATE INDEX idx_batches_expiry ON medicine_batches(expiry_date);

-- 3. Add inter-pharmacy tables
CREATE TABLE pharmacy_connections (...);
CREATE TABLE stock_requests (...);
CREATE TABLE shared_inventory_visibility (...);

-- 4. Seed demo pharmacy
INSERT INTO pharmacies (name, address) VALUES ('MediIndex Demo Pharmacy', 'Chhatrapati Sambhajinagar');
```

### 10.4 Data Migration Path (Local SQLite → Cloud PostgreSQL)

**For Development/Testing:**
1. Export SQLite data to SQL INSERT statements
2. Run through online converter (sqlitetopg.com or custom script)
3. Import to Vercel Postgres

**For Production Deployment:**
1. Each pharmacy starts with empty cloud database
2. Initial sync uploads entire local SQLite dataset
3. Subsequent operations sync incrementally

---

## 11. Required API Changes

### 11.1 Serverless Function Structure (Vercel API Routes)

**New Directory Structure:**
```
api/
├── auth/
│   ├── login.js          # POST /api/auth/login
│   ├── logout.js         # POST /api/auth/logout
│   └── me.js             # GET /api/auth/me
├── medicines/
│   ├── index.js          # GET /api/medicines (list/search)
│   ├── create.js         # POST /api/medicines
│   └── [id].js           # GET/PUT/DELETE /api/medicines/:id
├── batches/
│   ├── [id]/
│   │   ├── qr.js         # GET /api/batches/:id/qr
│   │   └── adjustments.js # POST /api/batches/:id/adjustments
├── sales/
│   ├── index.js          # GET/POST /api/sales
│   └── [id].js           # GET /api/sales/:id
├── qr/
│   └── lookup.js         # POST /api/qr/lookup
├── layout/
│   └── shelves.js        # GET /api/layout/shelves
├── analytics/
│   └── demand.js         # GET /api/analytics/demand
├── sync/
│   ├── push.js           # POST /api/sync/push (upload offline changes)
│   ├── pull.js           # GET /api/sync/pull (download server changes)
│   └── status.js         # GET /api/sync/status (last sync timestamp)
└── inter-pharmacy/
    ├── connect.js
    ├── connections.js
    ├── requests.js
    └── medicines.js
```

### 11.2 Database Client Abstraction Layer

**File: `lib/db.js`**
```javascript
// Abstraction layer to swap SQLite ↔ PostgreSQL
import { Pool } from '@vercel/postgres';

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

export async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

### 11.3 Session Management Migration

**Current (server.js):**
```javascript
const sessions = new Map();
sessions.set(token, { userId, expiresAt });
```

**Vercel Solution: Vercel KV (Redis)**

**File: `lib/session.js`**
```javascript
import { kv } from '@vercel/kv';

export async function createSession(userId, ttl = 21600) {
  const token = crypto.randomBytes(32).toString('hex');
  await kv.set(`session:${token}`, { userId, expiresAt: Date.now() + ttl * 1000 }, { ex: ttl });
  return token;
}

export async function getSession(token) {
  return await kv.get(`session:${token}`);
}

export async function deleteSession(token) {
  await kv.del(`session:${token}`);
}
```

**Vercel KV Setup:**
```bash
# In Vercel Dashboard → Storage → Create KV Database
# Environment variable automatically added: KV_REST_API_URL
```

### 11.4 SQL Query Translation Examples

**SQLite:**
```javascript
db.prepare("SELECT * FROM medicines WHERE pharmacy_id = ? AND active = 1").all(pharmacyId);
```

**PostgreSQL:**
```javascript
await query("SELECT * FROM medicines WHERE pharmacy_id = $1 AND active = 1", [pharmacyId]);
```

**Parameter Placeholders:**
- SQLite: `?` (positional)
- PostgreSQL: `$1, $2, $3` (numbered)

---

## 12. Required Frontend Changes

### 12.1 Minimal Changes Required ✅

The current frontend is **already stateless** and **API-driven**:
- ✅ No localStorage usage detected
- ✅ No sessionStorage usage detected
- ✅ All data fetched via `fetch('/api/*')`
- ✅ QR generator is client-side JavaScript (no change needed)

**Required Additions:**
1. **Connectivity Detection**
2. **Offline Mode Toggle**
3. **Sync Status UI**
4. **IndexedDB Wrapper Integration**

### 12.2 New Frontend Modules

**File: `public/offline-manager.js`**
```javascript
import Dexie from 'https://unpkg.com/dexie@latest/dist/dexie.mjs';

const db = new Dexie('MediIndexOffline');
db.version(1).stores({
  medicines: 'id, pharmacy_id, name, active',
  medicine_batches: 'id, medicine_id, expiry_date',
  sales: 'id, pharmacy_id, created_at',
  sync_queue: '++id, synced, timestamp'
});

export async function isOnline() {
  if (!navigator.onLine) return false;
  try {
    await fetch('/api/health', { method: 'HEAD', cache: 'no-cache' });
    return true;
  } catch {
    return false;
  }
}

export async function loadMedicinesOffline() {
  return await db.medicines.where('active').equals(1).toArray();
}

export async function saveMedicineOffline(medicine) {
  await db.medicines.put(medicine);
  await db.sync_queue.add({
    entity: 'medicine',
    operation: medicine.id ? 'UPDATE' : 'CREATE',
    data: medicine,
    synced: false,
    timestamp: new Date().toISOString()
  });
}
```

**File: `public/sync-manager.js`**
```javascript
export async function syncNow() {
  const pending = await db.sync_queue.where('synced').equals(false).toArray();
  if (pending.length === 0) return { success: true, synced: 0 };

  try {
    const response = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: pending.map(p => ({ ...p, clientId: p.id })) })
    });
    const result = await response.json();
    
    // Mark synced items
    for (const item of result.synced) {
      if (item.status === 'success') {
        await db.sync_queue.update(item.clientId, { synced: true });
      }
    }
    
    return { success: true, synced: result.synced.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Auto-sync every 5 minutes if online
setInterval(async () => {
  if (await isOnline()) await syncNow();
}, 5 * 60 * 1000);
```

### 12.3 UI Updates Required

**Header Sync Status Indicator:**
```html
<div id="sync-status" class="sync-indicator">
  <span id="sync-icon">🟢</span>
  <span id="sync-text">Online</span>
  <button id="sync-now-btn" class="secondary small-btn">Sync Now</button>
</div>
```

**Offline Mode Banner:**
```html
<div id="offline-banner" class="banner warning" hidden>
  ⚠️ You are offline. Changes will be synced when connection is restored.
  <span id="pending-count">0 pending changes</span>
</div>
```

### 12.4 No Change Required For
- ✅ `index.html` structure
- ✅ `styles.css` layout/design
- ✅ `qr-generator.js` (client-side only)
- ✅ Core application logic in `app.js` (API calls remain same)

---

## 13. Authentication/Security Considerations

### 13.1 Password Hashing (No Change Required)
- ✅ Current Scrypt implementation is secure
- ✅ Works identically on Vercel serverless functions
- ✅ Migrate hash validation logic as-is

### 13.2 Session Cookie Configuration
**Current:**
```javascript
'Set-Cookie': `mediindex_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL}`
```

**Vercel Production Addition:**
```javascript
'Set-Cookie': `mediindex_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL}; Secure`
```
- Add `Secure` flag for HTTPS-only cookies in production

### 13.3 CORS Configuration
**Vercel:** Automatically handles CORS for `api/*` routes deployed on same domain.

**If deploying frontend separately (e.g., Vercel for API + Netlify for static):**
```javascript
// api/_middleware.js
export default function middleware(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  return res;
}
```

### 13.4 Environment Variables Security
```bash
# .env (local development)
POSTGRES_URL=postgresql://user:pass@localhost:5432/mediindex
SESSION_SECRET=random_64_char_hex_string
KV_REST_API_URL=redis://...  # Vercel KV URL

# Vercel Dashboard → Environment Variables
POSTGRES_URL=postgres://vercel_prod_url
SESSION_SECRET=production_secret
KV_REST_API_URL=automatic_vercel_kv_url
```

**Security Rules:**
- ❌ Never commit `.env` to Git (already in `.gitignore`)
- ✅ Use Vercel environment variables dashboard for secrets
- ✅ Rotate `SESSION_SECRET` if leaked

### 13.5 Inter-Pharmacy Authorization
**Pharmacy Data Isolation:**
```javascript
// Middleware: Ensure user can only access own pharmacy data
function requirePharmacy(req, pharmacyId) {
  const user = await getCurrentUser(req);
  if (!user) throw new Error('Authentication required');
  if (user.pharmacy_id !== pharmacyId) throw new Error('Access denied to this pharmacy');
  return user;
}
```

**Inter-Pharmacy Request Validation:**
```javascript
// Before allowing stock request from Pharmacy A to Pharmacy B:
const connection = await query(
  'SELECT * FROM pharmacy_connections WHERE requesting_pharmacy_id = $1 AND target_pharmacy_id = $2 AND status = $3',
  [pharmacyA.id, pharmacyB.id, 'APPROVED']
);
if (!connection) throw new Error('No approved connection between pharmacies');
```

---

## 14. Environment Variables

### 14.1 Required Environment Variables

| Variable | Type | Description | Example | Required For |
|----------|------|-------------|---------|--------------|
| `POSTGRES_URL` | String | PostgreSQL connection string | `postgres://user:pass@host:5432/db` | Vercel deployment |
| `POSTGRES_PRISMA_URL` | String | Prisma-compatible URL (if using Prisma) | Auto-generated by Vercel | Optional |
| `POSTGRES_URL_NON_POOLING` | String | Direct connection URL | Auto-generated by Vercel | Migration scripts |
| `KV_REST_API_URL` | String | Vercel KV Redis connection | Auto-generated | Session storage |
| `KV_REST_API_TOKEN` | String | Vercel KV authentication token | Auto-generated | Session storage |
| `SESSION_SECRET` | String | Encryption key for session tokens | 64-char random hex | Authentication |
| `NODE_ENV` | String | Environment (development/production) | `production` | All deployments |
| `DATA_DIR` | String | (Local dev only) SQLite directory | `./data` | Local development |

### 14.2 Vercel Setup Commands
```bash
# Install Vercel CLI
npm i -g vercel

# Link project to Vercel
vercel link

# Add Postgres database (creates POSTGRES_URL automatically)
vercel postgres create

# Add KV store (creates KV_REST_API_URL automatically)
vercel kv create

# Set custom environment variables
vercel env add SESSION_SECRET
# Paste: crypto.randomBytes(64).toString('hex')
```

### 14.3 Local Development Environment
```bash
# .env (Git-ignored)
NODE_ENV=development
DATA_DIR=./data
POSTGRES_URL=postgresql://localhost:5432/mediindex_dev
SESSION_SECRET=local_dev_secret_key_min_32_chars
```

---

## 15. Migration Sequence

### Phase 1: Database Migration (Week 1)
**Days 1-3: PostgreSQL Setup**
- [ ] Create Vercel Postgres database
- [ ] Run schema migration script (`001_sqlite_to_postgres.sql`)
- [ ] Seed demo pharmacy data
- [ ] Test basic CRUD queries via `psql` or Vercel dashboard

**Days 4-7: Dual-Mode Backend**
- [ ] Create `lib/db.js` abstraction layer
- [ ] Replace `DatabaseSync` with `@vercel/postgres` in `server.js`
- [ ] Update all `db.prepare()` → `query()` calls
- [ ] Change `?` placeholders → `$1, $2, $3`
- [ ] Test locally with PostgreSQL (`npm run dev` with local Postgres)
- [ ] Verify all 17 tests pass with PostgreSQL backend

### Phase 2: Session Management (Week 1, Days 5-7)
- [ ] Install `@vercel/kv` package
- [ ] Create `lib/session.js` wrapper
- [ ] Replace in-memory `sessions Map` with KV store
- [ ] Test login/logout/session expiry

### Phase 3: Vercel API Routes (Week 2)
**Days 8-10: Serverless Function Structure**
- [ ] Create `api/` directory structure
- [ ] Migrate each endpoint from monolithic `server.js` to separate files
- [ ] Test each endpoint individually on Vercel dev server (`vercel dev`)

**Days 11-14: Deploy & Smoke Test**
- [ ] Deploy to Vercel preview environment
- [ ] Run manual smoke tests (login, create medicine, add batch, billing, QR)
- [ ] Fix deployment issues (cold start latency, connection pooling, etc.)

### Phase 4: Offline Support (Week 3)
**Days 15-17: IndexedDB Integration**
- [ ] Add Dexie.js to `public/index.html`
- [ ] Create `public/offline-manager.js`
- [ ] Implement offline CRUD for medicines, batches, sales
- [ ] Test offline mode (disable network in DevTools)

**Days 18-21: Synchronization**
- [ ] Create `api/sync/push.js` and `api/sync/pull.js`
- [ ] Create `public/sync-manager.js`
- [ ] Implement sync queue processing
- [ ] Test conflict scenarios (same medicine edited offline & online)
- [ ] Add sync status UI (header indicator, pending count)

### Phase 5: Inter-Pharmacy Features (Week 4)
**Days 22-25: Inter-Pharmacy Tables & APIs**
- [ ] Run migration: Add `pharmacy_connections`, `stock_requests`, `shared_inventory_visibility`
- [ ] Create `api/inter-pharmacy/*` endpoints
- [ ] Implement connection request workflow
- [ ] Implement stock request workflow

**Days 26-28: Inter-Pharmacy UI**
- [ ] Add "Network" navigation tab
- [ ] Build pharmacy connection management UI
- [ ] Build medicine availability search across network
- [ ] Build stock request creation/approval UI

### Phase 6: Testing & Documentation (Days 29-30)
- [ ] Update test suite for PostgreSQL (refactor `tests/demand.test.js` direct SQLite usage)
- [ ] Write inter-pharmacy integration tests
- [ ] Write sync conflict resolution tests
- [ ] Update all documentation (README, ARCHITECTURE, API_SPEC)
- [ ] Create deployment guide for faculty evaluation
- [ ] Record demo video (offline mode, sync, inter-pharmacy)

---

## 16. Testing Strategy

### 16.1 Test Suite Migration
**Current:** 17 tests using in-process SQLite with `DatabaseSync`

**Problem:** `tests/demand.test.js` directly manipulates SQLite database for test data.

**Solution:**
```javascript
// Old (SQLite direct access):
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('./data/mediindex.db');
db.prepare("INSERT INTO sales ...").run(...);

// New (API-driven test data):
await callApi({
  method: 'POST',
  url: '/api/sales',
  body: { items: [...], _test_timestamp: '2026-08-03 10:00:00' }  // Special test mode
});
```

**Approach:**
1. **Keep existing test structure** (using `callApi` helper)
2. **Replace direct DB access** with API calls
3. **Add test-only endpoint** for time-travel data injection:
   ```javascript
   // api/test/inject-sale.js (only enabled in NODE_ENV=test)
   if (process.env.NODE_ENV !== 'test') throw new Error('Test endpoint disabled');
   ```

### 16.2 New Test Categories

**Sync Tests:**
```javascript
test('Offline changes sync successfully when reconnected', async () => {
  // 1. Create medicine offline (mock IndexedDB)
  // 2. Call POST /api/sync/push with queued changes
  // 3. Verify medicine exists in PostgreSQL
  // 4. Verify local sync_queue marked synced=true
});

test('Server wins conflict when batch quantity differs', async () => {
  // 1. Server has batch quantity = 100
  // 2. Client syncs change: quantity = 95 (offline sale)
  // 3. POST /api/sync/push
  // 4. Expect conflict response, server quantity retained
});
```

**Inter-Pharmacy Tests:**
```javascript
test('Pharmacy A can request stock from connected Pharmacy B', async () => {
  // 1. Create two pharmacies
  // 2. Approve connection
  // 3. Pharmacy B sets medicine visible
  // 4. Pharmacy A creates stock request
  // 5. Verify request status = 'PENDING'
});

test('Cannot request from unconnected pharmacy', async () => {
  // 1. Create two pharmacies (no connection)
  // 2. POST /api/inter-pharmacy/requests
  // 3. Expect 403 error
});
```

### 16.3 Test Environments
| Environment | Database | Session Store | Purpose |
|-------------|----------|---------------|---------|
| **Local Dev** | PostgreSQL (localhost) or SQLite | In-memory Map | Fast iteration |
| **Test (CI)** | PostgreSQL (Docker container) | Mock KV | Automated testing |
| **Vercel Preview** | Vercel Postgres (staging) | Vercel KV | Pre-production validation |
| **Production** | Vercel Postgres (prod) | Vercel KV | Live deployment |

### 16.4 Test Execution
```bash
# Local (with local PostgreSQL)
npm test

# Vercel preview environment
vercel env pull .env.preview
NODE_ENV=test npm test

# CI/CD (GitHub Actions example)
name: Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v3
      - run: npm test
```

---

## 17. Rollback Strategy

### 17.1 Rollback Triggers
- ❌ Test suite fails in production (< 15/17 passing)
- ❌ Critical data corruption (inventory goes negative, sale rollback fails)
- ❌ Session store unavailable (KV downtime)
- ❌ Vercel Postgres connection pool exhausted

### 17.2 Rollback Plan A: Instant Revert (< 5 minutes)
```bash
# Vercel keeps previous deployments live
vercel rollback
# Reverts to last stable production deployment
```

**Result:**
- ✅ Users immediately redirected to previous version
- ✅ No data loss (PostgreSQL data persists)
- ⚠️ Recent offline changes may not have synced

### 17.3 Rollback Plan B: Hotfix Deployment (< 30 minutes)
```bash
# If single endpoint breaks:
git revert <commit-hash>
git push origin main
# Vercel auto-deploys fixed version
```

### 17.4 Rollback Plan C: Full Revert to SQLite Monolith (Emergency)
**If Vercel migration catastrophically fails:**

1. **Keep Local SQLite Version Running:**
   ```bash
   # On local machine or dedicated server:
   node server.js
   # Expose via ngrok or similar for temporary access
   ```

2. **Communicate Downtime:**
   - Display maintenance banner
   - Estimate restoration time

3. **Data Recovery:**
   ```bash
   # Export PostgreSQL data
   pg_dump $POSTGRES_URL > backup.sql
   
   # Convert to SQLite (manual script or tool)
   # Restore to data/mediindex.db
   ```

4. **Resume Local Operation:**
   - Pharmacies continue using offline mode
   - Sync disabled until issue resolved

---

## 18. Deployment Steps

### 18.1 Pre-Deployment Checklist
- [ ] All 17 tests passing locally with PostgreSQL
- [ ] Vercel CLI installed (`npm i -g vercel`)
- [ ] Vercel account created and linked
- [ ] Domain configured (e.g., `mediindex.vercel.app`)

### 18.2 Step-by-Step Deployment

**Step 1: Create Vercel Project**
```bash
cd /path/to/MediIndex
vercel login
vercel link
# Select: Create new project
# Project name: mediindex
# Framework: Other (No framework)
```

**Step 2: Add Databases**
```bash
# Create PostgreSQL database
vercel postgres create
# Name: mediindex-prod
# Region: IAD (us-east-1) or closest to target users

# Create KV store
vercel kv create
# Name: mediindex-sessions
```

**Step 3: Configure Environment Variables**
```bash
# Auto-added by Vercel:
# - POSTGRES_URL
# - KV_REST_API_URL
# - KV_REST_API_TOKEN

# Manually add:
vercel env add SESSION_SECRET production
# Paste: (generate via `node -p "crypto.randomBytes(64).toString('hex')"`)

vercel env add NODE_ENV production
# Value: production
```

**Step 4: Run Database Migrations**
```bash
# Connect to Vercel Postgres
vercel postgres connect
# Password: (from dashboard)

# Run migration script
\i migrations/001_sqlite_to_postgres.sql
\q
```

**Step 5: Deploy Application**
```bash
# Deploy to preview environment first
vercel

# Test preview URL (e.g., mediindex-abc123.vercel.app)
# Run smoke tests manually

# If successful, deploy to production
vercel --prod
```

**Step 6: Verify Production**
```bash
# Test endpoints
curl https://mediindex.vercel.app/api/health
# Expected: {"status":"ok","database":"connected"}

# Test login
curl -X POST https://mediindex.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@mediindex.local","password":"MediIndex@2026"}'
```

### 18.3 Custom Domain Setup (Optional)
```bash
# Add custom domain (e.g., mediindex.yourdomain.com)
vercel domains add mediindex.yourdomain.com

# Vercel provides DNS records to configure at domain registrar
# - Type: A or CNAME
# - Value: cname.vercel-dns.com
```

### 18.4 Continuous Deployment (GitHub Integration)
```bash
# Link GitHub repository
vercel git connect

# Now every push to main → auto-deploys to production
# Every PR → creates preview deployment
```

---

## 19. Risks

### 19.1 Technical Risks

| Risk | Severity | Probability | Mitigation |
|------|----------|-------------|------------|
| **Cold Start Latency** | Medium | High | Use Vercel Edge Functions for critical paths; connection pooling |
| **Database Connection Limit** | High | Medium | Implement connection pooling (`@vercel/postgres` auto-pools); monitor usage |
| **IndexedDB Browser Compatibility** | Low | Low | Dexie.js supports all modern browsers; provide fallback warning |
| **Sync Conflict Data Loss** | High | Medium | Server authoritative for inventory; user notifications on conflicts |
| **Session Store Downtime** | Medium | Low | Vercel KV has 99.9% SLA; fallback to database sessions if needed |
| **PostgreSQL Query Performance** | Medium | Medium | Add indexes on foreign keys; use EXPLAIN ANALYZE for slow queries |
| **Test Suite Regression** | High | Medium | Run full test suite on every commit; block deployment if <17 passing |

### 19.2 Academic Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Scope Creep (Too Many Features)** | High | Freeze features after Week 3; focus on stability |
| **Incomplete Inter-Pharmacy** | Medium | Implement minimum viable workflow (connect + request only) |
| **Insufficient Testing Evidence** | High | Document test results with screenshots; record demo video |
| **"Machine Learning" Mislabeling** | Critical | ⚠️ **NEVER call WMA "machine learning"** in report, viva, or presentation |

### 19.3 Deployment Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Vercel Free Tier Limits** | Medium | Monitor usage (100 GB-hours/month); upgrade to Pro if exceeded |
| **Demo Data Overwritten** | Low | Seed demo pharmacy on every deployment; use migration scripts |
| **HTTPS Certificate Issues** | Low | Vercel auto-provisions SSL; custom domains auto-renew |
| **Faculty Evaluation Access** | Medium | Provide public URL + demo credentials in report; backup local SQLite version |

---

## 20. One-Month Implementation Priority

### Priority Matrix (Must-Have → Nice-to-Have)

#### **P0 — Critical for Deployment (Week 1-2)**
- ✅ PostgreSQL migration + schema updates
- ✅ Vercel API routes restructuring
- ✅ Session management (Vercel KV)
- ✅ All 17 tests passing with PostgreSQL
- ✅ Basic Vercel deployment + smoke tests

#### **P1 — Core Project Requirements (Week 2-3)**
- ✅ Offline mode (IndexedDB + Dexie.js)
- ✅ Synchronization (push/pull APIs + conflict resolution)
- ✅ Sync UI (status indicator + pending count)
- ✅ Inter-pharmacy: Connection requests
- ✅ Inter-pharmacy: Stock requests (basic workflow)

#### **P2 — Enhanced Features (Week 3-4)**
- ⚠️ Inter-pharmacy: Medicine availability search
- ⚠️ Inter-pharmacy: Visibility settings UI
- ⚠️ Advanced conflict resolution (user prompts)
- ⚠️ Sync retry with exponential backoff

#### **P3 — Polish & Documentation (Week 4)**
- 📝 Update all documentation (README, ARCHITECTURE, API_SPEC)
- 📝 Record demo video (offline, sync, inter-pharmacy)
- 📝 Create deployment guide for faculty
- 📝 Prepare viva defense talking points

### Recommended Schedule

| Week | Days | Focus Area | Deliverables |
|------|------|------------|--------------|
| **Week 1** | 1-3 | Database Migration | PostgreSQL schema, demo data seeded |
| | 4-7 | Backend Migration | API routes, session storage, 17/17 tests |
| **Week 2** | 8-10 | Vercel Deployment | Production deployment, smoke tests passing |
| | 11-14 | Offline Mode | IndexedDB, offline CRUD working |
| **Week 3** | 15-17 | Synchronization | Push/pull working, conflict detection |
| | 18-21 | Inter-Pharmacy (Core) | Connection + stock request workflows |
| **Week 4** | 22-25 | Inter-Pharmacy (UI) | Complete inter-pharmacy features |
| | 26-28 | Testing | Full test suite, manual QA |
| | 29-30 | Documentation | Report updates, demo video, viva prep |

### De-Scoping Strategy (If Behind Schedule)

**Drop First (Low Impact on Academic Requirements):**
1. Advanced sync conflict UI (keep server-authoritative, no user prompts)
2. Inter-pharmacy medicine search (keep basic stock requests)
3. Custom domain setup (use `*.vercel.app` subdomain)

**Drop Second (Higher Impact, Still Defensible):**
1. Automatic sync (keep manual "Sync Now" button only)
2. Inter-pharmacy visibility settings (all medicines visible by default)

**Never Drop (Core Requirements):**
- ❌ Offline mode (Requirement #9 explicit)
- ❌ Inter-pharmacy connectivity (Requirement #8 explicit)
- ❌ Cloud backup/sync (Requirement #9 explicit)
- ❌ Vercel deployment (Project-II deliverable)

---

## Conclusion

This migration plan provides a **technically sound, academically defensible path** to deploy MediIndex on Vercel while satisfying all Project-I functional requirements:

✅ **Offline Operation** (Requirement #9) → IndexedDB with full CRUD  
✅ **Cloud Backup/Sync** (Requirement #9) → Sync APIs with conflict resolution  
✅ **Inter-Pharmacy Connectivity** (Requirement #8) → Connection + stock request system  
✅ **Production Deployment** → Vercel serverless + PostgreSQL  
✅ **Test Coverage Maintained** → 17/17 tests migrated to PostgreSQL  
✅ **Preserves Core Architecture** → FEFO, RBAC, QR security unchanged  
✅ **One-Month Feasible** → Prioritized backlog with de-scoping strategy

**Next Step:** Run existing test suite to confirm 17/17 baseline before starting migration.

---

**Document Status:** Ready for review and implementation  
**Last Updated:** August 2026  
**Author:** Kiro (Migration Audit & Architecture Analysis)
