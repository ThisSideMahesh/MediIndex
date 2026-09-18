# MediIndex Backend API Gap Analysis

**Project:** MediIndex — Intelligent Pharmacy Inventory & Expiry Management Platform  
**Document:** API Contract & Gap Analysis Register  
**Scope:** Complete inventory of current REST endpoints, planned mobile endpoints, synchronization mechanisms, and security specifications.

---

## 1. Complete API Endpoint & Module Gap Analysis Table

| Existing / Proposed Endpoint | Current Status | Required Future Behavior | Missing Functionality | Security Considerations | Tests Required |
|---|---|---|---|---|---|
| `GET /api/health` | **IMPLEMENTED** | Return JSON status, db connectivity, and runtime mode (`LOCAL` vs `CLOUD`). | Report sync queue status and cloud connectivity state. | Public endpoint; must not expose internal paths or credentials. | Health check assertion. |
| `POST /api/auth/login` | **IMPLEMENTED** | Verify Scrypt password, set 6h HttpOnly cookie, return user profile. | Add IP rate-limiting and brute-force lockout (5 failed attempts). | Constant-time password comparison (`timingSafeEqual`), SameSite=Strict cookies. | `auth.test.js` (valid login, wrong password rejection, salt isolation). |
| `POST /api/auth/logout` | **IMPLEMENTED** | Clear session from server Map/DB and clear client cookie. | Support invalidating across distributed instances (cloud mode). | Destroy session token server-side immediately. | Session destruction test. |
| `GET /api/auth/me` | **IMPLEMENTED** | Return current authenticated user profile and permissions. | Include pharmacy metadata and active device count. | Requires valid session cookie. | Authenticated profile retrieval. |
| `GET /api/dashboard` | **IMPLEMENTED** | Return real-time aggregated metrics (total meds, stock, expired, low-stock, today sales). | Add cache headers (ETag / Cache-Control: 10s) and mobile summary view. | Pharmacy tenancy isolation (`WHERE pharmacy_id = ?`). | Metric aggregation accuracy. |
| `GET /api/medicines` | **IMPLEMENTED** | Search and list medicines (`?q=term`) with live total stock calculation. | Add pagination (`limit`, `offset`), category filter, and sorting options. | Tenancy filter; sanitized search query (`%term%`). | Search by brand and generic name. |
| `POST /api/medicines` | **IMPLEMENTED** | Create master catalogue item (Admin only). | Support generic drug auto-classification and barcode pre-registration. | Role check (`ADMIN` only); validate positive `minimum_stock`. | Admin authorization, constraint check. |
| `PUT /api/medicines/:id` | **IMPLEMENTED** | Update medicine metadata (Admin only). | Broadcast update event to connected local clients / mobile cache. | Role check (`ADMIN` only); check tenancy ownership. | Update propagation test. |
| `DELETE /api/medicines/:id` | **IMPLEMENTED** | Soft-delete medicine (`active = 0`). | Prevent soft-deleting medicines with active positive batch stock. | Role check (`ADMIN` only); verify batches quantity sum. | Soft-delete verification. |
| `GET /api/medicines/:id/batches` | **IMPLEMENTED** | List all batches for a medicine with dynamic expiry status. | Add sort by expiry date (`FEFO` order) and shelf location filter. | Authenticated (`ADMIN`, `STAFF`); tenancy check. | Multi-batch listing & status computation. |
| `POST /api/medicines/:id/batches` | **IMPLEMENTED** | Add new batch stock lot, log movement `'RECEIPT'`. | Support barcode scanner auto-fill and supplier invoice reference. | Check positive selling price, valid `YYYY-MM-DD` dates, unique batch number per medicine. | Batch ingestion & audit log creation. |
| `POST /api/batches/:id/adjustments` | **IMPLEMENTED** | Increment/decrement stock with reason `'ADJUSTMENT'`. | Add mandatory adjustment reason notes (e.g., "Damaged", "Audit correction"). | Role check (`ADMIN`, `STAFF`); atomic transaction; prevent negative stock balance. | Negative stock prevention & audit movement. |
| `GET /api/batches/:id/qr` | **IMPLEMENTED** | Generate versioned QR payload and printable sticker metadata. | Add batch printing endpoint for multiple labels simultaneously. | Authenticated session; verify batch ownership. | Versioned QR payload format (`{"app":"MEDIINDEX","v":1,...}`). |
| `POST /api/qr/lookup` | **IMPLEMENTED** | Authoritative database resolution of scanned QR code (JSON or Pipe format). | Return shelf location coordinates and FEFO priority warning if an older batch exists. | Treat QR strictly as identifier; never trust price/stock from client. Authoritative DB fetch. | Format parsing (JSON, string, pipe) & security rejection of foreign QR. |
| `GET /api/layout/shelves` | **IMPLEMENTED** | Map 14 standard pharmacy bays + unassigned storage with live batch counts. | Allow custom shelf/rack configuration via Admin settings UI. | Authenticated session; tenancy isolation. | Spatial mapping & fallback bay test. |
| `GET /api/expiry-alerts` | **IMPLEMENTED** | Filter alerts (`?status=ALL|EXPIRED|EXPIRING_SOON&acknowledged=...`). | Add email/SMS digest trigger for near-expiry drugs. | Pharmacy tenancy filter; dynamic alert table refresh. | Alert categorization & acknowledged filtering. |
| `POST /api/expiry-alerts/:id/acknowledge`| **IMPLEMENTED** | Mark alert as acknowledged (`acknowledged = 1`). | Record acknowledging user ID and timestamp. | Role check (`ADMIN`, `STAFF`); tenancy validation. | Acknowledgment state persistence. |
| `GET /api/sales` | **IMPLEMENTED** | List recent sales transactions and invoices (`?q=term`). | Add date-range filters (`startDate`, `endDate`), cashier filter, and payment method filter. | Authenticated session; tenancy isolation. | Sales list retrieval & invoice search. |
| `GET /api/sales/:id` | **IMPLEMENTED** | Fetch full invoice detail with all line items and batch allocations. | Add PDF invoice export generation endpoint. | Verify sale belongs to requester's pharmacy. | Invoice itemization verification. |
| `POST /api/sales` | **IMPLEMENTED** | Atomic POS checkout with FEFO allocation, stock decrement, and invoice creation. | Support customer loyalty lookup, split payments, and digital receipt SMS. | Atomic ACID transaction (`BEGIN...COMMIT`); check non-expired; rollback on insufficient stock. | `sales.test.js` (FEFO multi-batch, insufficient stock rollback, expired block). |
| `GET /api/analytics/demand` | **IMPLEMENTED** | 3-period WMA demand forecasting & 95% safety stock recommendations. | Support configurable forecasting period (monthly / quarterly) and supplier lead-time input. | Authenticated session; mathematical reliability guard (`INSUFFICIENT_DATA` when < 3 periods). | `demand.test.js` (math precision, guardrail verification). |
| `GET /api/inventory/movements` | **MISSING** (Schema exists) | Return paginated audit log of all stock receipts, sales, and adjustments. | Filter by date range, batch ID, medicine ID, reason (`RECEIPT`, `SALE`, `ADJUSTMENT`), and cashier. | High-volume audit data; must require authentication and pagination. | Unauthenticated rejection, filter validation, pagination correctness. |
| `POST /api/devices/pairing/generate` | **NEW / REQUIRED** (Mobile) | Admin generates 6-digit alphanumeric pairing PIN (valid 10 mins). | Pairing code stored in `device_pairing_codes` with expiry timestamp. | Role check (`ADMIN` only); rate limit code generation. | Admin code generation, expiry validation. |
| `POST /api/devices/pairing/claim` | **NEW / REQUIRED** (Mobile) | Mobile app submits pairing PIN + device UUID + model; receives `device_token`. | Verify PIN, record device in `paired_devices`, generate SHA-256 token hash, return plain token once. | Rate-limit PIN attempts (max 3 tries per IP); secure high-entropy random token (256-bit). | Successful pairing, expired PIN rejection, brute-force lockout. |
| `GET /api/devices` | **NEW / REQUIRED** (Mobile) | Admin views list of all paired mobile devices and last active timestamps. | Display device name, model, paired date, last active IP, and revocation status. | Role check (`ADMIN` only); tenancy filter. | Admin device list retrieval. |
| `DELETE /api/devices/:id/revoke` | **NEW / REQUIRED** (Mobile) | Admin revokes mobile device authorization immediately. | Set `revoked = 1`, `revoked_at = CURRENT_TIMESTAMP`; invalidate token. | Role check (`ADMIN` only); immediately block revoked tokens. | Immediate 401 Unauthorized for revoked device token. |
| `POST /api/mobile/stock-entry` | **NEW / REQUIRED** (Mobile) | High-throughput stock receipt endpoint for smartphone QR scanner. | Accepts QR payload or medicine ID, batch details, quantity, price, location; updates stock atomically. | Authentication via `X-Device-Token` header; `idempotency_key` deduplication; DB validation. | Valid stock entry, duplicate request idempotency check, invalid token rejection. |
| `POST /api/mobile/stock-entry/batch-sync`| **NEW / REQUIRED** (Mobile) | Synchronize multiple queued offline stock receipts recorded in mobile local storage. | Process array of entries; return per-item status (`SUCCESS`, `DUPLICATE`, `FAILED`). | `X-Device-Token` auth; individual idempotency keys; partial failure handling. | Multi-item sync, duplicate item skipping, error reporting. |
| `GET /api/network/search` | **NEW / REQUIRED** (Inter-Pharmacy) | Query peer pharmacies in network for emergency medicine availability. | Return matching pharmacies, generic formulation, distance, and available stock units. | Inter-store token auth; strict field masking (hide financial costs, purchase rates, patient records). | Network search authorization, data masking verification. |
| `POST /api/sync/push` & `POST /api/sync/pull`| **NEW / REQUIRED** (Cloud) | Bi-directional synchronization between local SQLite store and cloud PostgreSQL database. | Delta change synchronization with timestamp-based conflict resolution (LWW). | Cloud API key / mTLS authentication; data encryption in transit (TLS 1.3). | Delta sync consistency, conflict resolution tests. |

---

## 2. Authentication & Authorization Security Model

### Web Browser Client Model:
- **Protocol:** HTTP/1.1 or HTTP/2 over HTTPS (TLS).
- **Authentication:** Scrypt-salted password verification -> Stateful 64-character session token.
- **Transport:** Cookie (`mediindex_session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=21600`).
- **Authorization:** `ADMIN` (Master catalog CRUD, settings, device management) vs `STAFF` (POS billing, stock receipt, alert inspection).

### Mobile Stock Entry App Model:
- **Protocol:** Wi-Fi LAN / Internet HTTP REST API.
- **Authentication:** One-time pairing PIN -> Persistent 256-bit cryptographic `device_token`.
- **Storage:** Secure hardware keystore (iOS Keychain / Android EncryptedSharedPreferences).
- **Transport:** Header `X-Device-Token: <token>`.
- **Authorization:** Bound strictly to `pharmacy_id`; scoped to stock entry, QR resolution, and catalogue lookup. Cannot perform administrative user management or delete records.
- **Authoritative Rule:** Wi-Fi connection is purely transport. All permissions and data validity are authoritatively verified by the MediIndex backend.
