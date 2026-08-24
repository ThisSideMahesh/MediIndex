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
| `created_by` | `INTEGER` | `NOT NULL REFERENCES users(id)` | User who executed the change |
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
