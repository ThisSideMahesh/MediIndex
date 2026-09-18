# MediIndex Mobile Stock-Entry API Pipeline (MOD-15)

## 1. Executive Summary & Purpose

The **Mobile Stock-Entry API Pipeline** provides a high-throughput, authoritative server-side endpoint (`POST /api/mobile/stock-entry`) for recording medicine stock intakes via physical QR scanning on mobile hardware.

> [!NOTE]
> **Implementation Scope:** This document specifies and validates the **Backend API Pipeline only**. The mobile frontend (camera UI, scanning widgets, React Native/Flutter/Android shells) is **not implemented yet** and will be built in subsequent phases.

---

## 2. Architectural Pipeline & Request Lifecycle

```
Smartphone Camera (QR Scan)
            ↓
   Mobile Stock App (Wi-Fi/LAN)
            ↓
  HTTPS POST /api/mobile/stock-entry
  [Header: X-Device-Token: medidev_...]
            ↓
┌────────────────────────────────────────┐
│  1. Device Authentication Middleware   │
│     - SHA-256 token hash lookup        │
│     - Verify active (revoked == 0)     │
│     - Bind authoritative pharmacy_id   │
└────────────────────────────────────────┘
            ↓
┌────────────────────────────────────────┐
│  2. Input & QR Payload Validation      │
│     - Parse JSON / Pipe-delimited QR   │
│     - Validate app == 'MEDIINDEX'      │
│     - Validate v == 1, medicineId,     │
│       batchNumber                      │
│     - Validate quantity (integer > 0)  │
│     - Reject client pharmacy_id spoof  │
└────────────────────────────────────────┘
            ↓
┌────────────────────────────────────────┐
│  3. Idempotency Check (Pre-flight)     │
│     - Match idempotency_keys record    │
│     - If duplicate: return cached JSON │
│       (idempotent: true)               │
│     - If conflict: reject 409 Conflict │
└────────────────────────────────────────┘
            ↓
┌────────────────────────────────────────┐
│  4. ACID Database Transaction (SQLite) │
│     - BEGIN                            │
│     - Verify medicine in pharmacy      │
│     - Verify batch in medicine         │
│     - UPDATE medicine_batches (+qty)   │
│     - INSERT inventory_movements       │
│       (reason = 'RECEIPT')             │
│     - INSERT idempotency_keys          │
│     - COMMIT                           │
└────────────────────────────────────────┘
            ↓
┌────────────────────────────────────────┐
│  5. Real-Time Response Delivery        │
│     - 200 OK with stock snapshot       │
│     - Background alert refresh         │
└────────────────────────────────────────┘
```

---

## 3. Device Authentication & Tenancy

1. **Zero Password Requirement:** Stock operators do not enter passwords on mobile devices. Authentication uses the pre-paired 256-bit token issued during MOD-14 pairing.
2. **Authoritative Tenancy:** The server extracts the device token from `X-Device-Token` (or `Authorization: Bearer <token>`), computes its SHA-256 hash, and resolves the device row:
   ```sql
   SELECT d.id, d.pharmacy_id, d.paired_by, p.name AS pharmacy_name
   FROM paired_devices d
   JOIN pharmacies p ON p.id = d.pharmacy_id
   WHERE d.token_hash = ? AND d.revoked = 0
   ```
3. **Spoofing Guard:** Any `pharmacy_id` or `pharmacyId` sent in the request body is explicitly rejected with `400 Bad Request`.

---

## 4. QR Code Resolution & Validation

The pipeline reuses the shared `parseAndValidateQrPayload()` helper function:
- **Supported Formats:**
  - Standard JSON object: `{"app":"MEDIINDEX","v":1,"medicineId":1,"batchNumber":"AZI-LOT-2027"}`
  - JSON string: `"{\"app\":\"MEDIINDEX\",...}"`
  - Pipe-delimited string: `"MEDIINDEX|v1|1|AZI-LOT-2027"`
- **Strict Verification Rules:**
  - `app === 'MEDIINDEX'`
  - `v === 1`
  - `medicineId` must be a positive integer
  - `batchNumber` must be a non-empty string up to 80 characters
  - Non-existent or foreign application QR codes are rejected with `400 Bad Request`.

---

## 5. Idempotency, Request Hashing & Concurrency Safety

Mobile Wi-Fi connections in warehouse and storage areas can drop unexpectedly after the server processes an HTTP request but before the client receives the response, or mobile clients might trigger concurrent retry submissions.

### A. Deterministic Request Fingerprint Normalization
To prevent accidental hash mismatch caused by arbitrary formatting, the business payload is normalized strictly before hashing:
```javascript
const requestHash = crypto.createHash('sha256').update(JSON.stringify({
  medicineId: Number(medicineId),
  batchNumber: String(batchNumber).trim(),
  quantity: Number(quantity)
})).digest('hex');
```
Volatile fields (such as timestamps, client metadata, or device labels) are excluded from the hash.

### B. Dual-Stage Concurrency Guard
1. **Pre-flight Check:** Queries `idempotency_keys` before opening a write transaction. If present and hashes match, replays cached response with `"idempotent": true`.
2. **Transaction-Level Locking (`BEGIN IMMEDIATE`):** Obtains a reserved write lock on SQLite. Inside the lock, double-checks `idempotency_keys`. If another thread committed during pre-flight, rolls back and returns the cached result.
3. **Composite Primary Key:** `idempotency_keys` is indexed on `PRIMARY KEY (key, pharmacy_id)`, ensuring cross-tenant isolation and hardware race condition safety.

---

## 6. Inventory Transaction & Strengthened Audit Trail

### Atomic Stock Increment
For batch quantity $Q$ and incoming quantity $N$:
$$\text{New Stock} = Q + N$$

### Dual-Actor Audit Logging
Every intake creates an immutable record in `inventory_movements` capturing both:
- `created_by`: Admin user ID who paired/authorized the mobile device (`device.pairedBy`) to preserve relational foreign key integrity.
- `device_id`: Exact originating mobile hardware ID (`device.id`) for hardware traceability.
- `reason`: `'RECEIPT'`
- `change_quantity`: $N$

---

## 7. Error Handling & HTTP Status Codes

| Status Code | Reason | Example Response |
|---|---|---|
| `401 Unauthorized` | Missing, invalid, or revoked device token | `{"error": "Device authentication required. Invalid or revoked device token."}` |
| `400 Bad Request` | Invalid quantity, malformed QR, or spoofed tenant | `{"error": "Quantity must be a positive whole number greater than zero."}` |
| `404 Not Found` | Medicine or batch not found in authenticated pharmacy | `{"error": "Active medicine ID 1 not found for this pharmacy."}` |
| `409 Conflict` | Idempotency key reused with different parameters | `{"error": "Idempotency key conflict: This key was previously used with a different request payload."}` |

---

## 8. Relationship to Future Offline Batch Synchronization

In future offline mode (Phase 6):
1. Mobile devices will store unscanned/queued stock intakes locally in SQLite/IndexedDB when Wi-Fi is unavailable.
2. When Wi-Fi reconnects, the mobile app will submit each intake using its unique `idempotencyKey` to `POST /api/mobile/stock-entry` (or a dedicated batch endpoint `/api/mobile/stock-entry/batch-sync`).
3. The server's idempotency engine guarantees that network drops during bulk sync will never produce duplicate inventory records.

---

## 9. Verification & Test Evidence

All 11 mobile stock-entry test cases (alongside 21 baseline tests, totaling **32 test cases**) pass deterministically with 0 failures:
- `MOB-STOCK-001` through `MOB-STOCK-011` fully verified in [`tests/mobile-stock-entry.test.js`](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/tests/mobile-stock-entry.test.js).

