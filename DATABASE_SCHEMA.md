# MediIndex Database Schema & ER Model

**Database Engine:** SQLite (persisted at `data/mediindex.db` via `node:sqlite DatabaseSync`)  
**Integrity Policy:** Strict foreign key checks enabled (`PRAGMA foreign_keys = ON;`)

---

## Entity Relationship Table Specifications

### 1. `pharmacies`
Tenancy boundary for the pharmacy store.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Unique pharmacy identifier |
| `name` | `TEXT` | `NOT NULL` | Registered store name |
| `address` | `TEXT` | - | Store address |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Registration timestamp |

### 2. `users`
Accounts for system administrators and pharmacy staff.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | User ID |
| `pharmacy_id` | `INTEGER` | `NOT NULL REFERENCES pharmacies(id)` | Associated pharmacy |
| `full_name` | `TEXT` | `NOT NULL` | Full name of user |
| `email` | `TEXT` | `NOT NULL UNIQUE` | User login email |
| `password_hash` | `TEXT` | `NOT NULL` | Scrypt salt and hash (`salt:hash`) |
| `role` | `TEXT` | `NOT NULL CHECK(role IN ('ADMIN', 'STAFF'))` | Authorization role |
| `active` | `INTEGER` | `NOT NULL DEFAULT 1` | 1 = active, 0 = deactivated |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Account creation timestamp |
| `last_login_at` | `TEXT` | - | Last successful authentication |

### 3. `medicines`
Master catalogue entries for medicines.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Medicine identifier |
| `pharmacy_id` | `INTEGER` | `NOT NULL REFERENCES pharmacies(id)` | Store tenancy |
| `name` | `TEXT` | `NOT NULL` | Brand / trade name |
| `generic_name` | `TEXT` | - | Active pharmaceutical ingredient |
| `manufacturer` | `TEXT` | - | Pharmaceutical manufacturer |
| `category` | `TEXT` | - | Drug formulation / category |
| `minimum_stock` | `INTEGER` | `NOT NULL DEFAULT 0 CHECK(minimum_stock >= 0)` | Reorder warning threshold |
| `active` | `INTEGER` | `NOT NULL DEFAULT 1` | Soft-delete flag |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Record creation timestamp |
| `updated_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Last updated timestamp |

*Index:* `idx_medicines_name` on `medicines(name)`.

### 4. `medicine_batches`
Physical inventory stock grouped by batch/lot number and expiry.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Batch identifier |
| `medicine_id` | `INTEGER` | `NOT NULL REFERENCES medicines(id)` | Parent medicine |
| `batch_number` | `TEXT` | `NOT NULL` | Batch/Lot number |
| `quantity` | `INTEGER` | `NOT NULL CHECK(quantity >= 0)` | Remaining units in stock |
| `purchase_price`| `REAL` | `NOT NULL DEFAULT 0 CHECK(purchase_price >= 0)` | Cost price per unit (INR) |
| `selling_price` | `REAL` | `NOT NULL CHECK(selling_price >= 0)` | Retail sale price per unit (INR) |
| `manufacturing_date` | `TEXT` | - | Format `YYYY-MM-DD` |
| `expiry_date` | `TEXT` | `NOT NULL` | Format `YYYY-MM-DD` |
| `location` | `TEXT` | - | Shelf / Rack position |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Stock receipt timestamp |

*Constraints & Indexes:* `UNIQUE(medicine_id, batch_number)`; `idx_batches_expiry` on `medicine_batches(expiry_date)`.

### 5. `inventory_movements`
Audit trail of all inventory quantity modifications.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Movement record ID |
| `batch_id` | `INTEGER` | `NOT NULL REFERENCES medicine_batches(id)` | Affected batch |
| `change_quantity` | `INTEGER` | `NOT NULL CHECK(change_quantity != 0)` | Delta quantity (+ receipt, - sale) |
| `reason` | `TEXT` | `NOT NULL CHECK(reason IN ('RECEIPT', 'ADJUSTMENT', 'SALE'))` | Operation category |
| `created_by` | `INTEGER` | `NOT NULL REFERENCES users(id)` | User who authorized the change |
| `device_id` | `INTEGER` | `REFERENCES paired_devices(id)` | Originating mobile hardware device (if mobile receipt) |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Timestamp of change |

*Index:* `idx_movements_batch` on `inventory_movements(batch_id)`.

### 6. `sales`
Header records for customer billing transactions.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Sale ID |
| `pharmacy_id` | `INTEGER` | `NOT NULL REFERENCES pharmacies(id)` | Pharmacy store |
| `invoice_number` | `TEXT` | `NOT NULL UNIQUE` | Unique formatted invoice string |
| `customer_name` | `TEXT` | - | Patient / Customer name |
| `customer_phone`| `TEXT` | - | Contact number |
| `payment_method`| `TEXT` | `NOT NULL DEFAULT 'CASH'` | Cash / UPI / Card |
| `total_amount` | `REAL` | `NOT NULL CHECK(total_amount >= 0)` | Final bill sum in INR |
| `created_by` | `INTEGER` | `NOT NULL REFERENCES users(id)` | Cashier / User ID |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Transaction timestamp |

### 7. `sale_items`
Line items associated with a sale invoice.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Line item ID |
| `sale_id` | `INTEGER` | `NOT NULL REFERENCES sales(id)` | Parent sale record |
| `batch_id` | `INTEGER` | `NOT NULL REFERENCES medicine_batches(id)` | Specific batch sold |
| `quantity` | `INTEGER` | `NOT NULL CHECK(quantity > 0)` | Sold quantity |
| `unit_price` | `REAL` | `NOT NULL CHECK(unit_price >= 0)` | Unit sale price applied |
| `line_total` | `REAL` | `NOT NULL CHECK(line_total >= 0)` | Line total in INR |

### 8. `expiry_alerts`
Generated alerts for expired and near-expiry batches.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Alert ID |
| `batch_id` | `INTEGER` | `NOT NULL REFERENCES medicine_batches(id)` | Subject batch |
| `alert_type` | `TEXT` | `NOT NULL CHECK(alert_type IN ('EXPIRED', 'EXPIRING_SOON', 'LOW_STOCK'))` | Alert classification |
| `acknowledged` | `INTEGER` | `NOT NULL DEFAULT 0` | 0 = Pending, 1 = Acknowledged |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Alert creation timestamp |

*Constraint:* `UNIQUE(batch_id, alert_type)`.

### 9. `device_pairing_codes`
Short-lived single-use pairing codes generated by administrators to register mobile hardware devices.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Record identifier |
| `pharmacy_id` | `INTEGER` | `NOT NULL REFERENCES pharmacies(id)` | Associated pharmacy |
| `pairing_code` | `TEXT` | `NOT NULL UNIQUE` | 6-character alphanumeric PIN (e.g. `MED-A9F2`) |
| `created_by` | `INTEGER` | `NOT NULL REFERENCES users(id)` | Admin user who generated code |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Code generation timestamp |
| `expires_at` | `TEXT` | `NOT NULL` | Expiration timestamp (10 min TTL) |
| `used` | `INTEGER` | `NOT NULL DEFAULT 0` | 0 = Unused, 1 = Claimed |
| `used_at` | `TEXT` | - | Timestamp when pairing completed |

*Index:* `idx_pairing_codes_code` on `device_pairing_codes(pairing_code)`.

### 10. `paired_devices`
Hardware mobile devices authorized to access the pharmacy backend.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `INTEGER` | `PRIMARY KEY` | Device identifier |
| `pharmacy_id` | `INTEGER` | `NOT NULL REFERENCES pharmacies(id)` | Pharmacy tenancy |
| `device_name` | `TEXT` | `NOT NULL` | User-friendly label (e.g. `Warehouse Scanner 1`) |
| `device_model`| `TEXT` | - | Hardware model / OS metadata |
| `token_hash` | `TEXT` | `NOT NULL UNIQUE` | SHA-256 hash of 256-bit device token |
| `paired_by` | `INTEGER` | `NOT NULL REFERENCES users(id)` | Admin who generated original code |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Pairing timestamp |
| `last_seen_at`| `TEXT` | - | Last active request timestamp |
| `revoked` | `INTEGER` | `NOT NULL DEFAULT 0` | 0 = Active, 1 = Revoked |
| `revoked_at` | `TEXT` | - | Revocation timestamp |

*Indexes:* `idx_paired_devices_token` on `paired_devices(token_hash)`, `idx_paired_devices_pharmacy` on `paired_devices(pharmacy_id)`.

### 11. `idempotency_keys`
Prevents duplicate inventory mutations from network retries and guarantees idempotent request processing.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `key` | `TEXT` | `PRIMARY KEY` | Client-supplied unique key (e.g. UUID) |
| `pharmacy_id` | `INTEGER` | `NOT NULL REFERENCES pharmacies(id)` | Pharmacy tenant isolation scope |
| `device_id` | `INTEGER` | `REFERENCES paired_devices(id)` | Mobile hardware device origin |
| `endpoint` | `TEXT` | `NOT NULL` | API route (e.g. `/api/mobile/stock-entry`) |
| `request_hash` | `TEXT` | `NOT NULL` | SHA-256 hash of normalized request parameters |
| `response_status`| `INTEGER` | `NOT NULL` | HTTP status code to replay |
| `response_body` | `TEXT` | `NOT NULL` | Serialized JSON response to replay |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Initial transaction timestamp |

*Index:* `idx_idempotency_lookup` on `idempotency_keys(key, pharmacy_id)`.

### 12. `sessions`
Persistent browser session store for local SQLite and cloud PostgreSQL serverless workers.
| Column | Type | Constraints | Description |
|---|---|---|---|
| `token_hash` | `TEXT` | `PRIMARY KEY` | SHA-256 hash of 256-bit random session token |
| `user_id` | `INTEGER` | `NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Authenticated user ID |
| `pharmacy_id` | `INTEGER` | `NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE` | Derived pharmacy tenancy |
| `expires_at` | `TEXT` | `NOT NULL` | Session expiry timestamp (ISO-8601, 6 hours TTL) |
| `created_at` | `TEXT` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Session creation timestamp |
| `last_accessed_at` | `TEXT` | - | Sliding window activity timestamp |

*Indexes:* `idx_sessions_user` on `sessions(user_id)`, `idx_sessions_expires` on `sessions(expires_at)`.

---

## PostgreSQL Cloud Persistence Mapping (Phase 5A)

### Type & Dialect Correspondences

| SQLite (Local Node) | PostgreSQL (Cloud Cluster) | Architectural Rationale |
|---|---|---|
| `INTEGER PRIMARY KEY` | `SERIAL PRIMARY KEY` | Auto-increment sequence generator in PostgreSQL. |
| `TEXT` (ISO-8601 strings) | `TIMESTAMPTZ` / `DATE` | Native timezone-aware timestamps and calendar date arithmetic (`INTERVAL`). |
| `REAL` | `NUMERIC(12, 2)` | Exact fixed-point arithmetic for currency (avoids IEEE 754 floating-point rounding drifts). |
| `INTEGER` (Flags `0`/`1`) | `SMALLINT` (`0`/`1`) | Compact representation for boolean/status flags with check constraints. |
| `date('now')` / `julianday()` | `CURRENT_DATE` / `NOW() - date` | Native PostgreSQL date functions and date range operators. |
| Positional `?` | Parameterized `$1, $2, ...` | Handled transparently by `db/postgres-adapter.js` `convertPlaceholders()`. |

### Cloud-Specific Table: `sessions` (Phase 5B Session Store)

| Column | Type | Constraints | Description |
|---|---|---|---|
| `token_hash` | `VARCHAR(64)` | `PRIMARY KEY` | SHA-256 hash of random 256-bit session token |
| `user_id` | `INTEGER` | `NOT NULL REFERENCES users(id) ON DELETE CASCADE` | Associated authenticated user |
| `pharmacy_id` | `INTEGER` | `NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE` | Authoritative tenant identifier |
| `expires_at` | `TIMESTAMPTZ` | `NOT NULL` | Session expiry (6 hours from issuance) |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT CURRENT_TIMESTAMP` | Session start timestamp |
| `last_accessed_at` | `TIMESTAMPTZ` | - | Sliding window activity timestamp |

*DDL Source File:* Refer to [db/schema.pg.sql](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/db/schema.pg.sql) for the full PostgreSQL schema script.


