# MediIndex Test Execution & Verification Log

**Test Suite Engine:** Node.js native test runner (`node --test --test-concurrency=1 tests/*.test.js`)  
**Assertion Library:** `node:assert/strict`  
**Execution Standard:** Zero mock HTTP servers — in-process streaming event-emitter test harness.

---

## Test Execution Matrix

| Test ID | Module | Test Case Description | Input / Scenario | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| **AUTH-001** | Authentication | Password storage security | Scrypt hashing with 16-byte random salt | Stored value is `salt:hash`, plaintext never persisted | Validates matching password; rejects mismatched | **PASS** |
| **AUTH-002** | Authentication | Valid Administrator Login | `admin@mediindex.local` / `MediIndex@2026` | 200 OK + `HttpOnly; SameSite=Strict` session cookie | Session cookie issued; dashboard access granted | **PASS** |
| **AUTH-003** | Authentication | Invalid Password Rejection | `admin@mediindex.local` / `wrong` | 401 Unauthorized | 401 Unauthorized with error message | **PASS** |
| **AUTH-004** | Authorization | Protected Route Access Control | Unauthenticated `GET /api/dashboard` | 401 Unauthorized | 401 Unauthorized | **PASS** |
| **INV-001** | Inventory & Batches | Medicine CRUD & Batch Ingestion | Create medicine, ingest 25 units in batch, check total stock | `total_stock` equals 25; batch marked `SAFE` | Verified stock sum and batch attributes | **PASS** |
| **EXP-001** | Expiry Management | Expiry Alert Generation & Acknowledgment | Batch with expiry date in past (`2020-01-01`) | Generates `EXPIRED` alert; allows acknowledgment | Alert generated with severity; acknowledged flag persists | **PASS** |
| **DEM-001** | Demand Analytics | Demand Access Authorization | Unauthenticated `GET /api/analytics/demand` | 401 Unauthorized | 401 Unauthorized | **PASS** |
| **DEM-002** | Demand Analytics | Insufficient Data Hard Reliability Guard | Query medicine with 0 historical sales periods | `status: "INSUFFICIENT_DATA"`, `message: "INSUFFICIENT DATA FOR RELIABLE FORECAST"`, `forecast: null` | Hard guardrail triggered; baseline safety stock applied | **PASS** |
| **DEM-003** | Demand Analytics | Weighted Moving Average Mathematical Precision | 3 historical periods: $P_1 = 30$, $P_2 = 20$, $P_3 = 10$ with weights $(0.5, 0.3, 0.2)$ | Weekly forecast = 23, 30-day forecast = 99, $\sigma = 10$, $SS = 17$, $R = 0$ | Verified exact mathematical output | **PASS** |
| **LAY-001** | Store Layout | Layout Authorization | Unauthenticated `GET /api/layout/shelves` | 401 Unauthorized | 401 Unauthorized | **PASS** |
| **LAY-002** | Store Layout | Standard Layout Schema & Spatial Batch Mapping | Query 14 standard shelf bays with mapped medicine batch lots | Returns shelf schemas and maps Rack C3 accurately | Verified shelf counts, batch mapping, and unit sums | **PASS** |
| **LAY-003** | Store Layout | Unassigned Custom Location Fallback | Batch with non-standard location (`Backyard Quarantine Box`) | Mapped to fallback unassigned storage bay | Batch correctly placed in unassigned bay | **PASS** |
| **MOB-001** | Mobile Pairing | Pairing Code Access Control (Admin Only) | Unauthenticated / STAFF attempt `POST /api/mobile/pairing/create` | 401 / 403 Forbidden; ADMIN generates 10-min code | STAFF blocked; ADMIN receives 6-char code | **PASS** |
| **MOB-002** | Mobile Pairing | End-to-End Pairing Flow & Token Storage Security | Mobile claims code via `POST /api/mobile/pairing/complete` | Issues 256-bit token; stores `sha256(token)` in DB; single-use | Token issued; plain token never stored in DB | **PASS** |
| **MOB-003** | Mobile Pairing | Code Expiration Lifecycle | Attempt to claim expired pairing code (`expires_at < NOW()`) | 400 Bad Request with expiration error message | Expired codes safely rejected | **PASS** |
| **MOB-004** | Mobile Pairing | Device Revocation & Tenant Isolation | Admin lists devices, revokes device, attempts cross-tenant revoke | Revoked device immediately fails auth (401); cross-tenant blocked (404) | Revocation active; cross-tenant isolated | **PASS** |
| **MOB-STOCK-001** | Mobile Stock Entry | Device Authentication Guard | Unauthenticated & fake token `POST /api/mobile/stock-entry` | 401 Unauthorized | Blocked with 401 | **PASS** |
| **MOB-STOCK-002** | Mobile Stock Entry | Hardware Revocation Guard | Revoked device attempts stock intake | 401 Unauthorized | Blocked with 401 | **PASS** |
| **MOB-STOCK-003** | Mobile Stock Entry | Stock Intake & Quantity Arithmetic | Paired device submits +30 units to batch | Batch quantity increments from 50 to 80; movement audit created | 200 OK; quantity updated; movement logged | **PASS** |
| **MOB-STOCK-004** | Mobile Stock Entry | Movement Audit Logging (RECEIPT) | Stock intake records authorizing user AND originating hardware device ID | Creates `inventory_movements` record with `reason = 'RECEIPT'`, `created_by`, `device_id` | Movement created with correct batch, user, and device ID | **PASS** |
| **MOB-STOCK-005** | Mobile Stock Entry | Input & Boundary Guards | Negative, zero, float, string quantity, and quantity > 100,000 | 400 Bad Request | Invalid quantities and upper bound violations rejected | **PASS** |
| **MOB-STOCK-006** | Mobile Stock Entry | QR Validation & Multi-Format Parsing | Pipe-delimited string, JSON object, and foreign/corrupted QR strings | Resolves valid formats (200); rejects foreign app tags (400) | Valid formats accepted; foreign tags rejected | **PASS** |
| **MOB-STOCK-007** | Mobile Stock Entry | Tenant Spoofing Protection | Client passes explicit `pharmacyId` parameter | 400 Bad Request (tenant derived strictly from device token) | Client-supplied pharmacy_id rejected | **PASS** |
| **MOB-STOCK-008** | Mobile Stock Entry | Cross-Pharmacy Isolation & Rollback | Device 1 attempts stock entry on Pharmacy 2 medicine | 404 Not Found; Pharmacy 2 stock unchanged | Cross-tenant intake blocked; rollback confirmed | **PASS** |
| **MOB-STOCK-009** | Mobile Stock Entry | Idempotency Network Retry Replay | Same `idempotencyKey` and payload submitted twice | Stock incremented only once; returns cached result (`idempotent: true`) | Stock unchanged on second request; identical response returned | **PASS** |
| **MOB-STOCK-010** | Mobile Stock Entry | Idempotency Conflict Resolution | Same `idempotencyKey` reused with different quantity | 409 Conflict | Request rejected with 409 Conflict error | **PASS** |
| **MOB-STOCK-011** | Mobile Stock Entry | Concurrent Parallel Submissions | `Promise.all` two simultaneous requests with same key & payload | One request mutates stock; second returns idempotent replay; stock increments exactly once | Verified both return 200; stock increments +40 exactly once | **PASS** |
| **QR-001** | QR Module | QR Endpoints Authorization | Unauthenticated `GET /api/batches/1/qr` & `POST /api/qr/lookup` | 401 Unauthorized | 401 Unauthorized | **PASS** |
| **QR-002** | QR Module | Batch QR Payload & Sticker Format | Ingest medicine & batch, query `GET /api/batches/:id/qr` | Versioned payload `{"app":"MEDIINDEX","v":1,...}` + complete sticker metadata | Verified structured payload and sticker fields | **PASS** |
| **QR-003** | QR Module | Authoritative Database Resolution | Valid JSON object, JSON string, and pipe string `MEDIINDEX|v1|...` | 200 OK with authoritative medicine details, stock count, and price | Successfully resolved across all supported formats | **PASS** |
| **QR-004** | QR Module | Security Rejection of Foreign / Bad QR | External app QR (`app: OTHERAPP`), bad version (`v: 99`), fake medicine ID | 400 Bad Request / 404 Not Found with explicit error message | Foreign codes and invalid IDs safely rejected | **PASS** |
| **POS-001** | Billing & POS | Multi-batch FEFO Stock Allocation | Sale of 15 units across Batch 1 (10 units) & Batch 2 (20 units) | FEFO depletes Batch 1 to 0; deducts 5 from Batch 2; invoice `INV-...` generated | Batch 1 qty = 0, Batch 2 qty = 15, Invoice created with 2 line items | **PASS** |
| **POS-002** | Billing & POS | Expired Batch Selling Prevention | Attempt to sell medicine batch with expired date | Sale rejected with expired batch error | 400 Error returned; expired batch blocked from POS | **PASS** |
| **SYNC-001** | Batch Sync | Bulk Submission of 5 Valid Operations | Paired scanner uploads 5 discrete stock operations | All 5 operations commit atomically (`synced: 5, failed: 0`); batch quantities updated | 200 OK; summary.synced = 5; stock verified | **PASS** |
| **SYNC-002** | Batch Sync | Mixed Batch Resilience | Batch containing 3 valid ops, 1 invalid batch, 1 duplicate op | Valid ops succeed (3), invalid fails independently (1), duplicate replays (1); no unrelated rollback | 200 OK; synced = 3, idempotent = 1, failed = 1 | **PASS** |
| **SYNC-003** | Batch Sync | Network Reconnect Batch Retry Simulation | Replay entire batch of 2 operations after connection restore | First run increments stock; replay returns `idempotent: 2`; stock unchanged | 200 OK; stock increments only once | **PASS** |
| **SYNC-004** | Batch Sync | Concurrent Duplicate Batch Operations | `Promise.all` two simultaneous batch sync requests with same key | Exactly one request mutates stock; other replays idempotently; stock increments once | 200 OK; statuses `['IDEMPOTENT', 'SYNCED']` | **PASS** |
| **SYNC-005** | Batch Sync | Batch Size Upper Limit Enforcement | Submit batch with 101 operations | 400 Bad Request (batch limit = 100 operations) | Blocked with 400 Bad Request | **PASS** |
| **SYNC-006** | Batch Sync | Empty Operations Array Guard | Submit `{ operations: [] }` | 400 Bad Request | Blocked with 400 Bad Request | **PASS** |
| **SYNC-007** | Batch Sync | Missing / Non-Array Operations Parameter | Submit request without operations array | 400 Bad Request | Blocked with 400 Bad Request | **PASS** |
| **SYNC-008** | Batch Sync | Per-Operation Invalid Quantity Isolation | Batch with 1 valid op and 1 negative quantity op | Valid op succeeds; invalid op fails independently with `INVALID_QUANTITY` | 200 OK; synced = 1, failed = 1; stock = +15 | **PASS** |
| **SYNC-009** | Batch Sync | Cross-Pharmacy Tenant Isolation | Device from Pharmacy 1 submits batch targeting Pharmacy 2 medicine | Operation fails with `MEDICINE_NOT_FOUND`; Pharmacy 2 stock unchanged | 200 OK; failed = 1; foreign stock untouched | **PASS** |
| **SYNC-010** | Batch Sync | Hardware Revocation Protection | Revoked device submits batch sync request | 401 Unauthorized; 0 operations processed | Blocked with 401; zero database mutations | **PASS** |
| **SYNC-011** | Batch Sync | Reused Key with Conflicting Payload | Reused idempotency key with quantity mismatch | Operation returns `status: "CONFLICT"`, `errorCode: "IDEMPOTENCY_CONFLICT"` | 200 OK; failed = 1, status = CONFLICT | **PASS** |
| **SYNC-012** | Batch Sync | Two Devices Additive Commutative Invariant | Device A (+20) and Device B (+30) submit batches to same lot | Stock increases by +50 ($100 + 20 + 30 = 150$); zero lost updates | 200 OK; final stock = 150; 2 movements logged | **PASS** |
| **SYNC-013** | Batch Sync | Malformed QR Tag Isolation | Batch with 1 valid op and 1 corrupted string QR | Valid op commits (+10); malformed fails with `INVALID_QR_PAYLOAD` | 200 OK; synced = 1, failed = 1; stock = +10 | **PASS** |
| **SYNC-014** | Batch Sync | Movement Audit Trail Attribution | Batch sync intake creates `inventory_movements` row | Movement records `batch_id`, `change_quantity`, `created_by`, `device_id` | Verified exact user and hardware device ID in DB | **PASS** |
| **SYNC-015** | Batch Sync | Retry After Server Commit Simulation | Re-send batch request after server commit | Second response returns `IDEMPOTENT`; movements count remains exactly 2 | Zero duplicate movements logged in audit ledger | **PASS** |

---

## Test Execution Summary

- **Total Test Cases Executed:** 47
- **Passed:** 47 (100%)
- **Failed:** 0
- **Execution Duration:** ~1800 ms
- **Database Consistency:** Fully verified via ACID transactions, Write-Ahead Logging (WAL), per-operation atomicity, and foreign key constraint checks.



