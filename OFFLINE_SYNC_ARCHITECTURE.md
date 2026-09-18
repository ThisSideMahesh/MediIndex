# MediIndex — Offline Synchronization Architecture Specification
## Outbox-Driven Delta Replication, Mathematical Idempotency & Conflict Resolution

**Project:** MediIndex – Pharmacy Insights, POS & Analytics  
**Document Code:** SPEC-OFFLINE-SYNC-V1  
**Status:** 
- **Server-Side Batch Synchronization Protocol & API (`/api/mobile/stock-entry/batch-sync`):** `IMPLEMENTED / VERIFIED` (Phase 4, 15/15 Automated Sync Tests PASS)
- **Mobile Client Outbox & Local Storage (IndexedDB):** `PLANNED / NOT IMPLEMENTED` (Phase 7 Client Implementation)

---

## 1. Domain Overview & Problem Statement

Pharmacies are critical healthcare infrastructure. In community pharmacies, hospital dispensary basements, and rural clinics, Internet connectivity can be intermittent, unstable, or completely offline for extended periods. 

If a pharmacy software platform enforces a synchronous "always-online" cloud dependency:
- Medicine stock intake is halted when Wi-Fi drops.
- Customer point-of-sale checkouts freeze during ISP blackouts.
- Operators bypass the software, leading to untracked manual stock leakages and severe stockouts.

MediIndex solves this by implementing an **Offline-First Outbox Synchronization Protocol** that guarantees continuous local operations while maintaining strict mathematical consistency and financial audit integrity upon reconnection.

---

## 2. Local Device Data vs. Authoritative Server Data

```
┌────────────────────────────────────────┐       ┌────────────────────────────────────────┐
│           LOCAL DEVICE DATA            │       │       AUTHORITATIVE SERVER DATA        │
│          (IndexedDB / SQLite)          │       │      (Central Database / Ledger)       │
├────────────────────────────────────────┤       ├────────────────────────────────────────┤
│ • Read-Only Medicine Master Cache      │       │ • Master Multi-Tenant Database         │
│ • Read-Only Batch & Location Index     │       │ • Global Inventory Balances            │
│ • Local Outbox Queue (Pending Events)  │  ───► │ • Authoritative Audit Log (Movements)  │
│ • Device Pairing Authentication Token  │  ◄─── │ • Global Idempotency Log               │
│ • Ephemeral Sync Status State          │       │ • Fiscal Invoice & Tax Records         │
│ • Cached 2D Store Coordinates          │       │ • Inter-Pharmacy Discovery Index       │
└────────────────────────────────────────┘       └────────────────────────────────────────┘
```

> [!IMPORTANT]
> **Core Distributed Authority Invariant:**
> - **The mobile client owns the local queue state:** It records, queues, retries, and updates the local delivery status of outbox items.
> - **The central server owns the authoritative inventory state:** It validates paired credentials, enforces tenant isolation, computes stock mathematics, logs audit movements, and determines idempotency.

### Categorization of Operations
| Operation | Offline Capability | Rationale | Handling Mechanism |
|---|---|---|---|
| **QR Code Scanning** | **YES (100% Offline)** | QR payload parsing uses local regex/JSON rules. | Client-side parser decodes `MEDIINDEX\|v1\|...`. |
| **Medicine Identification** | **YES (100% Offline)** | Resolved against local cached catalogue snapshot. | Read-only local lookup by `medicineId` and `batchNumber`. |
| **Stock Intake Queuing (`RECEIPT`)** | **YES (100% Offline)** | Ingesting physical stock into known batches. | Stored in local outbox queue with unique `operationId`. |
| **Store Shelf Location Lookup** | **YES (100% Offline)** | 2D coordinates cached in local metadata. | Visual coordinate mapping rendered locally. |
| **Point-of-Sale (POS) Checkout** | **CONDITIONAL** | Allowed for emergency billing with offline sequence prefix. | Queued as local invoice draft; finalized on reconnect. |
| **Initial Device Pairing** | **NO (Online Required)** | Requires admin OTP verification on central server. | One-time online step during initial setup. |
| **Inter-Pharmacy Stock Search** | **NO (Online Required)** | Requires federated queries across external pharmacies. | UI displays "Network Offline — Connect to Search". |

---

## 3. The Synchronization Protocol & Operation Envelope

The sync lifecycle follows a strict state machine:

```
[Local Operation Initiated]
           │
           ▼
[Persist in Local Outbox Queue] ─── (Status: PENDING)
           │
           ▼
[Network Connectivity Detected]
           │
           ▼
[Batch Submission via POST /api/mobile/stock-entry/batch-sync]
           │
     ┌─────┴─────────────────────────┐
     ▼                               ▼
[Server Error (5xx/Timeout)]   [Server Response (200)]
     │                               │
     ▼                               ▼
[Exponential Backoff Retry]    [Inspect Per-Operation Status]
                                     ├─ SYNCED / IDEMPOTENT ──► [Mark SYNCED & Prune]
                                     └─ FAILED ───────────────► [Mark FAILED & Alert]
```

### 3.1 Future Mobile Client Outbox Data Model (IndexedDB Envelope)

In the future mobile PWA/client (Phase 7), local operations will be persisted in an IndexedDB object store (`outbox_operations`) before transmission:

| Field Name | Type | Description |
|---|---|---|
| `operationId` | String (UUID) | Unique client-generated identifier for this local operation record. |
| `idempotencyKey` | String (UUID) | Authoritative idempotency key sent to the server for deduplication. |
| `operationType` | String | Operation classification (e.g., `'STOCK_RECEIPT'`). |
| `qrPayload` | Object / String | Scanned QR data (`{ app, v, medicineId, batchNumber }` or pipe string). |
| `quantity` | Number (Integer) | Intake quantity ($1 \le Q \le 100,000$). |
| `clientCreatedAt` | String (ISO-8601) | Timestamp when the operator performed the scan offline. |
| `retryCount` | Number | Integer counter of transmission attempts. |
| `localStatus` | String (Enum) | `'PENDING'`, `'SYNCING'`, `'SYNCED'`, `'FAILED_RETRYABLE'`, `'FAILED_FATAL'`. |
| `lastError` | String / Null | Error code or message returned by the server on failure. |
| `syncedAt` | String / Null | Timestamp when the server confirmed synchronization. |

### 3.2 Implemented Server Batch Synchronization Request (`POST /api/mobile/stock-entry/batch-sync`)

```json
{
  "operations": [
    {
      "operationId": "op-9102-4a11-8299-123456789abc",
      "idempotencyKey": "idem-stock-8891-20260903-01",
      "qrPayload": {
        "app": "MEDIINDEX",
        "v": 1,
        "medicineId": 14,
        "batchNumber": "AMOX-LOT-2028"
      },
      "quantity": 50,
      "clientCreatedAt": "2026-09-03T01:25:10.000Z"
    }
  ]
}
```

### 3.3 Authority Separation: Client-Provided vs. Server-Derived Fields

| Field Name | Origin | Mutability by Client | Security Validation Rule |
|---|---|---|---|
| `operationId` | Client | Provided | Non-empty string (max 120 chars). |
| `idempotencyKey` | Client | Provided | Unique client idempotency key (max 120 chars). Authoritative retry identity. |
| `qrPayload` | Client | Provided | Validated via `parseAndValidateQrPayload()`. |
| `quantity` | Client | Provided | Must be integer $1 \le N \le 100,000$. |
| `clientCreatedAt` | Client | Provided | ISO-8601 timestamp for client-side auditing (informational only). |
| **`pharmacyId`** | **Server** | **FORBIDDEN from Client** | Authoritatively derived from `paired_devices.pharmacy_id`. Rejects client `pharmacy_id`. |
| **`deviceId`** | **Server** | **FORBIDDEN from Client** | Authoritatively derived from authenticated token. |
| **`userId`** | **Server** | **FORBIDDEN from Client** | Authoritatively derived from `paired_devices.paired_by`. |
| **`serverReceivedAt`**| **Server** | **FORBIDDEN from Client** | Authoritative database `CURRENT_TIMESTAMP`. |
| **`movementId`** | **Server** | **FORBIDDEN from Client** | Generated via `inventory_movements` auto-increment. |

---

## 4. Mathematical Commutativity of Stock Receipts

A foundational design principle in distributed systems is avoiding **Last-Write-Wins (LWW)** on numerical state.

### 4.1 The Flawed Approach: Absolute State Replication
If Device A and Device B both scan stock offline starting from an initial stock of 100:
- Device A adds 30 units $\rightarrow$ records absolute stock = 130.
- Device B adds 20 units $\rightarrow$ records absolute stock = 120.
- If synced via absolute state overwriting, the server stock becomes 120 or 130 (depending on which sync finishes last), losing 20 or 30 units of real inventory.

### 4.2 The Correct Approach: Additive Commutative Delta Events
MediIndex models every stock intake as a discrete, signed relative delta event:
$$\Delta Q = +N \quad (N \in \mathbb{Z}^+)$$

The authoritative stock balance $Q(t)$ at time $t$ is defined as the sum of initial stock $Q_0$ and all discrete events:
$$Q(t) = Q_0 + \sum_{i=1}^{k} \Delta Q_{\text{receipt}, i} - \sum_{j=1}^{m} S_{\text{sale}, j}$$

Because addition over the integers $(\mathbb{Z}, +)$ is **associative** and **commutative**:
$$\Delta Q_A + \Delta Q_B = \Delta Q_B + \Delta Q_A$$

Regardless of the order in which Device A and Device B establish network connection and sync their outbox queues:
$$\text{Final Stock} = 100 + 30 + 20 = 150$$

Each operation is recorded as an independent row in `inventory_movements`, ensuring 100% financial and physical ledger auditability.

---

## 5. Conflict Resolution Matrix for 9 Critical Scenarios

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CONFLICT RESOLUTION ENGINE                                     │
├──────────────────────────────┬───────────────────────────────┬───────────────────────────────────┤
│ Scenario                     │ Server Resolution Behavior    │ Client Outbox Action              │
├──────────────────────────────┼───────────────────────────────┼───────────────────────────────────┤
│ 1. Concurrent stock intake   │ Commutative delta (+N1, +N2). │ Both marked SYNCED. Stock = +N1+N2│
│ 2. Stale snapshot on device  │ Delta applied to live stock.  │ Marked SYNCED. UI updates total.  │
│ 3. Duplicate network retry   │ Idempotency replay (200 OK).  │ Marked SYNCED (no double intake). │
│ 4. Reused key, diff payload  │ 409 Conflict rejection.       │ Marked FAILED_CONFLICT (Alert).   │
│ 5. Device revoked offline    │ 401 Unauthorized rejection.   │ Frozen in queue (Admin review).   │
│ 6. Batch deactivated offline │ 404 Not Found rejection.      │ Moved to ERROR_REVIEW queue.      │
│ 7. Expiry/Price updated      │ Stock increments; alerts sync.│ Marked SYNCED.                    │
│ 8. Network drop before ACK   │ Re-sent key hits replay cache.│ Marked SYNCED on second attempt.  │
│ 9. Multi-device same pharmacy│ Isolated hardware attribution.│ All devices synced cleanly.       │
└──────────────────────────────┴───────────────────────────────┴───────────────────────────────────┘
```

### Detailed Breakdown of Conflict Handling

1. **Two Devices Adding Stock to the Same Batch:**
   - Both devices submit additive delta payloads ($+N_1, +N_2$).
   - The server processes each inside independent atomic transactions with `BEGIN IMMEDIATE`.
   - Result: Stock increases by $N_1 + N_2$. Two distinct movement records are logged with corresponding `device_id` values.
2. **Device Submits Stale Inventory Snapshot:**
   - Because stock entry submits relative $\Delta Q$ rather than target absolute stock, stale cached totals on the client do not corrupt the server inventory.
3. **Duplicate Network Retry (Same `idempotencyKey` + Same Payload):**
   - Server checks `idempotency_keys` table.
   - Matches existing `request_hash` $\rightarrow$ returns cached `200 OK` with `"idempotent": true`.
   - Result: Zero database modification; client marks local outbox record as `SYNCED`.
4. **Reused Idempotency Key with Different Payload:**
   - Server detects `request_hash` mismatch for the same key $\rightarrow$ returns `409 Conflict`.
   - Client halts that specific item and alerts the operator to avoid data corruption.
5. **Device Revoked While Operations Remain Queued:**
   - Device attempts sync $\rightarrow$ server checks `paired_devices.revoked = 1` $\rightarrow$ returns `401 Unauthorized`.
   - The mobile client preserves the queued items locally in a locked `QUARANTINE` state. An administrator can inspect or re-pair the device to authorize ingestion.
6. **Batch Deactivated / Deleted Before Synchronization:**
   - Server checks `medicines.active = 1` and `medicine_batches` existence.
   - If not found $\rightarrow$ rolls back transaction and returns `404 Not Found`.
   - The client marks the item as `MANUAL_INTERVENTION_REQUIRED` for supervisor resolution.
7. **Medicine / Batch Changed While Device Was Offline:**
   - Stock delta attaches to the primary key `batch_id`. Expiry alerts and demand forecasting automatically recalculate upon commit.
8. **Network Disconnect After Server Commit but Before Client ACK:**
   - The server successfully commits stock +25 and saves idempotency key.
   - Client disconnects before reading HTTP 200 response $\rightarrow$ local status remains `PENDING`.
   - Upon reconnect, client re-sends the same envelope $\rightarrow$ server returns cached response $\rightarrow$ client marks `SYNCED`.
9. **Multiple Mobile Devices in Same Pharmacy:**
   - Each hardware device has a distinct `device_id`.
   - In `inventory_movements`, each row attributes the originating device (`device_id`) while retaining the authorizing admin user (`created_by`).

---

## 6. UI Synchronization State & Recovery Indicators

The mobile frontend must provide transparent synchronization indicators:

| Status Badge | Visual Indicator | Meaning | User Action |
|---|---|---|---|
| `ONLINE` | 🟢 Green Pill | Connected to server; real-time sync active. | Normal scanning. |
| `OFFLINE (N Queued)` | 🟠 Amber Pill | Disconnected; operations queued locally. | Continue scanning; keep device powered. |
| `SYNCING...` | 🔵 Blue Spinner | Flushing outbox queue to server. | Maintain connection. |
| `SYNC ERROR (1)` | 🔴 Red Pill | Item rejected (e.g., inactive batch / 409). | Tap to view conflict details and resolve. |
| `DEVICE REVOKED` | 🔒 Lock Icon | Device token revoked by administrator. | Contact pharmacy admin for re-pairing. |
