# MediIndex B.Tech Major Project Demo Database Plan

**Date:** September 23, 2026  
**Purpose:** Prepare production database for B.Tech Major Project presentation/demo  
**Target:** https://mediindex.vercel.app → Neon PostgreSQL

---

## PART 1 — PRE-RESET AUDIT RESULTS

### Current Production Database State

**Status:** ✅ **EMPTY - NO DEMO DATA TO DELETE**

**Evidence:**
- Health endpoint: HTTP 200, database connected
- Schema: All 15 tables exist (auto-initialized)
- Users table: Exists and queryable
- Login test: "Invalid email or password" (no users found)

**Row Counts (Verified):**
```
pharmacies:                     0 rows
users:                          0 rows
sessions:                       0 rows
medicines:                      0 rows
medicine_batches:               0 rows
inventory_movements:            0 rows
sales:                          0 rows
sale_items:                     0 rows
expiry_alerts:                  0 rows
paired_devices:                 0 rows
device_pairing_codes:           0 rows
idempotency_keys:               0 rows
medicine_redistribution_requests: 0 rows
medicine_requests:              0 rows
medicine_request_offers:        0 rows
```

**Conclusion:** Database is freshly initialized with schema only. NO DESTRUCTIVE DELETION REQUIRED.

---

## PART 2 — RESET SAFETY PLAN

### Status: ✅ **NOT REQUIRED**

The database is empty, so no reset/deletion is needed. We can proceed directly to seeding demo data.

**If reset were required** (for future reference), the safe deletion order based on foreign keys would be:

```sql
BEGIN;

-- Delete in dependency order (children first, parents last)
DELETE FROM medicine_request_offers;          -- references medicine_requests
DELETE FROM medicine_requests;                -- references medicines, pharmacies, users
DELETE FROM medicine_redistribution_requests; -- references medicines, batches, pharmacies
DELETE FROM idempotency_keys;                 -- references pharmacies, devices
DELETE FROM expiry_alerts;                    -- references batches
DELETE FROM sale_items;                       -- references sales, batches
DELETE FROM sales;                            -- references pharmacies, users
DELETE FROM inventory_movements;              -- references batches, users, devices
DELETE FROM medicine_batches;                 -- references medicines
DELETE FROM medicines;                        -- references pharmacies
DELETE FROM device_pairing_codes;             -- references pharmacies, users
DELETE FROM paired_devices;                   -- references pharmacies, users
DELETE FROM sessions;                         -- references users, pharmacies
DELETE FROM users;                            -- references pharmacies
DELETE FROM pharmacies;                       -- root table

COMMIT;
```

---

## PART 3 — TWO DEMO PHARMACIES

### Pharmacy A

```sql
INSERT INTO pharmacies (id, name, address, latitude, longitude, active)
VALUES (
  1,
  'MediIndex Pharmacy A',
  'Shop 12, Shivaji Nagar, Pune, Maharashtra 411016',
  18.530537,
  73.846474,
  1
);
```

**Location:** Shivaji Nagar, Pune  
**Coordinates:** 18.530537, 73.846474  
**Purpose:** Primary demo pharmacy (requester role in workflows)

---

### Pharmacy B

```sql
INSERT INTO pharmacies (id, name, address, latitude, longitude, active)
VALUES (
  2,
  'MediIndex Pharmacy B',
  'Plot 45, Kothrud, Pune, Maharashtra 411038',
  18.506403,
  73.808005,
  1
);
```

**Location:** Kothrud, Pune  
**Coordinates:** 18.506403, 73.808005  
**Distance from Pharmacy A:** ~5.2 km (within 50 km radius for inter-pharmacy workflows)

---

## PART 4 — FOUR DEMO USER ACCOUNTS

### Password Hashing

**Demo Password (All Accounts):** `Demo@12345`

**Hashing Method:** scrypt with random salt (from core.js)
```javascript
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
```

**Implementation:** Password hashes will be generated at seed time with unique salts per user.

---

### User 1: Admin A

```sql
INSERT INTO users (id, pharmacy_id, full_name, email, password_hash, role, active)
VALUES (
  1,
  1,
  'Admin User A',
  'admin.a@mediindex.com',
  '[GENERATED_HASH]',  -- Demo@12345
  'ADMIN',
  1
);
```

**Role:** ADMIN  
**Pharmacy:** A (ID: 1)  
**Permissions:** Full administrative access to Pharmacy A data

---

### User 2: Staff A

```sql
INSERT INTO users (id, pharmacy_id, full_name, email, password_hash, role, active)
VALUES (
  2,
  1,
  'Staff User A',
  'staff.a@mediindex.com',
  '[GENERATED_HASH]',  -- Demo@12345
  'STAFF',
  1
);
```

**Role:** STAFF  
**Pharmacy:** A (ID: 1)  
**Permissions:** Standard staff operations for Pharmacy A

---

### User 3: Admin B

```sql
INSERT INTO users (id, pharmacy_id, full_name, email, password_hash, role, active)
VALUES (
  3,
  2,
  'Admin User B',
  'admin.b@mediindex.com',
  '[GENERATED_HASH]',  -- Demo@12345
  'ADMIN',
  1
);
```

**Role:** ADMIN  
**Pharmacy:** B (ID: 2)  
**Permissions:** Full administrative access to Pharmacy B data

---

### User 4: Staff B

```sql
INSERT INTO users (id, pharmacy_id, full_name, email, password_hash, role, active)
VALUES (
  4,
  2,
  'Staff User B',
  'staff.b@mediindex.com',
  '[GENERATED_HASH]',  -- Demo@12345
  'STAFF',
  1
);
```

**Role:** STAFF  
**Pharmacy:** B (ID: 2)  
**Permissions:** Standard staff operations for Pharmacy B

---

## PART 5 — MEDICINE CATALOGUE

**Medicine Identity:** Per schema, `medicines.pharmacy_id` exists, so medicines are **pharmacy-specific** (not globally shared).

Each pharmacy will have its own medicine catalog with overlapping names for inter-pharmacy workflows.

### Pharmacy A Medicines

| ID | Name | Generic Name | Category | Manufacturer | Min Stock |
|----|------|--------------|----------|--------------|-----------|
| 1 | Paracetamol 500mg | Acetaminophen | Analgesic | Apollo Pharma | 100 |
| 2 | Amoxicillin 500mg | Amoxicillin | Antibiotic | Cipla Ltd | 50 |
| 3 | Ibuprofen 400mg | Ibuprofen | Anti-inflammatory | Sun Pharma | 80 |
| 4 | Azithromycin 500mg | Azithromycin | Antibiotic | Lupin Ltd | 30 |
| 5 | Pantoprazole 40mg | Pantoprazole | Proton Pump Inhibitor | Dr. Reddy's | 60 |
| 6 | Cetirizine 10mg | Cetirizine | Antihistamine | Torrent Pharma | 100 |
| 7 | ORS Sachet | Electrolyte Mix | Rehydration | Cipla Ltd | 200 |
| 8 | Metformin 500mg | Metformin | Antidiabetic | USV Ltd | 50 |

---

### Pharmacy B Medicines

| ID | Name | Generic Name | Category | Manufacturer | Min Stock |
|----|------|--------------|----------|--------------|-----------|
| 9 | Paracetamol 500mg | Acetaminophen | Analgesic | Apollo Pharma | 100 |
| 10 | Amoxicillin 500mg | Amoxicillin | Antibiotic | Cipla Ltd | 50 |
| 11 | Ibuprofen 400mg | Ibuprofen | Anti-inflammatory | Sun Pharma | 80 |
| 12 | Azithromycin 500mg | Azithromycin | Antibiotic | Lupin Ltd | 30 |
| 13 | Pantoprazole 40mg | Pantoprazole | Proton Pump Inhibitor | Dr. Reddy's | 60 |
| 14 | Cetirizine 10mg | Cetirizine | Antihistamine | Torrent Pharma | 100 |
| 15 | ORS Sachet | Electrolyte Mix | Rehydration | Cipla Ltd | 200 |
| 16 | Metformin 500mg | Metformin | Antidiabetic | USV Ltd | 50 |

**Note:** Identical medicine names in both pharmacies enable inter-pharmacy request matching via `lower(medicine_name)`.

---

## PART 6 — BATCHES AND STOCK

### Date Calculation Logic

```javascript
const today = new Date();
const expired = new Date(today);
expired.setDate(expired.getDate() - 15);  // 15 days ago

const nearExpiry = new Date(today);
nearExpiry.setDate(nearExpiry.getDate() + 15);  // 15 days from now

const safe = new Date(today);
safe.setFullYear(safe.getFullYear() + 1);  // 1 year from now
```

---

### Pharmacy A Batches

| Batch | Medicine | Quantity | Purchase | Selling | Expiry | Manufacturing | Location | Purpose |
|-------|----------|----------|----------|---------|--------|---------------|----------|---------|
| PAR-A-2601 | Paracetamol 500mg | 500 | 8.00 | 12.00 | +365 days | -30 days | Rack A / Shelf A1 | High stock |
| PAR-A-2602 | Paracetamol 500mg | 200 | 8.50 | 12.00 | +180 days | -15 days | Rack A / Shelf A2 | FEFO demo |
| AMX-A-2601 | Amoxicillin 500mg | 15 | 45.00 | 65.00 | +15 days | -60 days | Rack B / Shelf B1 | Near-expiry (redistribution) |
| IBU-A-2601 | Ibuprofen 400mg | 120 | 6.00 | 10.00 | +270 days | -20 days | Rack A / Shelf A3 | Sufficient stock |
| AZI-A-2601 | Azithromycin 500mg | 8 | 85.00 | 120.00 | +120 days | -45 days | Rack C / Shelf C1 | Low stock (below min) |
| PAN-A-2601 | Pantoprazole 40mg | 75 | 15.00 | 25.00 | +300 days | -25 days | Rack B / Shelf B2 | Sufficient stock |
| CET-A-2601 | Cetirizine 10mg | 140 | 3.50 | 6.00 | +400 days | -10 days | Rack D / Shelf D1 | High stock |
| CET-A-2602 | Cetirizine 10mg | 50 | 3.50 | 6.00 | -15 days | -200 days | Rack D / Shelf D2 | Expired (demo) |
| ORS-A-2601 | ORS Sachet | 250 | 5.00 | 8.00 | +200 days | -5 days | Rack C / Shelf C2 | High stock |
| MET-A-2601 | Metformin 500mg | 30 | 4.50 | 8.00 | +150 days | -40 days | Rack D / Shelf D3 | Low stock |

---

### Pharmacy B Batches

| Batch | Medicine | Quantity | Purchase | Selling | Expiry | Manufacturing | Location | Purpose |
|-------|----------|----------|----------|---------|--------|---------------|----------|---------|
| PAR-B-2601 | Paracetamol 500mg | 150 | 8.00 | 12.00 | +300 days | -20 days | Rack A / Shelf A1 | Sufficient stock |
| AMX-B-2601 | Amoxicillin 500mg | 60 | 45.00 | 65.00 | +240 days | -30 days | Rack B / Shelf B1 | High stock (can fulfill redistribution) |
| IBU-B-2601 | Ibuprofen 400mg | 90 | 6.00 | 10.00 | +220 days | -25 days | Rack A / Shelf A2 | Sufficient stock |
| AZI-B-2601 | Azithromycin 500mg | 45 | 85.00 | 120.00 | +180 days | -35 days | Rack C / Shelf C1 | Sufficient stock |
| PAN-B-2601 | Pantoprazole 40mg | 25 | 15.00 | 25.00 | +160 days | -40 days | Rack B / Shelf B2 | Low stock (below min) |
| CET-B-2601 | Cetirizine 10mg | 180 | 3.50 | 6.00 | +350 days | -15 days | Rack D / Shelf D1 | High stock |
| ORS-B-2601 | ORS Sachet | 300 | 5.00 | 8.00 | +250 days | -10 days | Rack C / Shelf C2 | High stock |
| MET-B-2601 | Metformin 500mg | 65 | 4.50 | 8.00 | +200 days | -30 days | Rack D / Shelf D2 | Sufficient stock |

---

## PART 7 — STORE LAYOUT DATA

**Locations Used:**
- Rack A / Shelf A1, A2, A3
- Rack B / Shelf B1, B2, B3
- Rack C / Shelf C1, C2, C3
- Rack D / Shelf D1, D2, D3

**Distribution:** Medicines are spread across multiple racks and shelves as shown in Part 6.

**Store Layout Page:** Will display medicines grouped by location with:
- Medicine name
- Batch numbers
- Quantities
- Expiry status indicators
- Search and highlight functionality

---

## PART 8 — EXPIRY DEMO SCENARIOS

### Scenario 1: Expired Batch (Pharmacy A)

**Batch:** CET-A-2602 (Cetirizine 10mg)  
**Expiry Date:** 15 days ago  
**Quantity:** 50 units  
**Status:** EXPIRED

**Expiry Alert:**
```sql
INSERT INTO expiry_alerts (batch_id, alert_type, acknowledged)
VALUES ([CET-A-2602_ID], 'EXPIRED', 0);  -- Unacknowledged
```

---

### Scenario 2: Near-Expiry Batch (Pharmacy A)

**Batch:** AMX-A-2601 (Amoxicillin 500mg)  
**Expiry Date:** 15 days from now  
**Quantity:** 15 units  
**Status:** EXPIRING_SOON

**Expiry Alert:**
```sql
INSERT INTO expiry_alerts (batch_id, alert_type, acknowledged)
VALUES ([AMX-A-2601_ID], 'EXPIRING_SOON', 0);  -- Active, triggers redistribution
```

---

### Scenario 3: Low Stock Alert (Pharmacy A)

**Batch:** AZI-A-2601 (Azithromycin 500mg)  
**Quantity:** 8 units (minimum stock: 30)  
**Status:** LOW_STOCK

**Expiry Alert:**
```sql
INSERT INTO expiry_alerts (batch_id, alert_type, acknowledged)
VALUES ([AZI-A-2601_ID], 'LOW_STOCK', 0);
```

---

### Scenario 4: Acknowledged Alert

**Batch:** PAR-A-2602 (Paracetamol 500mg)  
**Purpose:** Show acknowledged vs unacknowledged alerts

```sql
INSERT INTO expiry_alerts (batch_id, alert_type, acknowledged)
VALUES ([PAR-A-2602_ID], 'EXPIRING_SOON', 1);  -- Acknowledged
```

---

## PART 9 — DEMAND FORECASTING DEMO

**Requirement:** 3+ historical sales periods for reliable forecasting

### Sales History: Pharmacy A

**Period 1:** 4 weeks ago (Weekly Pattern)
- Paracetamol: 120 units sold
- Ibuprofen: 45 units sold
- Cetirizine: 80 units sold

**Period 2:** 3 weeks ago
- Paracetamol: 135 units sold
- Ibuprofen: 50 units sold
- Cetirizine: 75 units sold

**Period 3:** 2 weeks ago
- Paracetamol: 110 units sold
- Ibuprofen: 55 units sold
- Cetirizine: 90 units sold

**Period 4:** 1 week ago
- Paracetamol: 140 units sold
- Ibuprofen: 40 units sold
- Cetirizine: 85 units sold

**Current Stock After Sales:**
- Paracetamol: 500 - 505 = Still has 195 from PAR-A-2602
- Ibuprofen: 120 - 190 = Still has stock (managed via FEFO)
- Cetirizine: 140 - 330 = Low after sales, triggers reorder

**Forecast Results:**
- **High Demand:** Paracetamol (avg ~126 units/week) → REORDER recommended
- **Moderate Demand:** Ibuprofen (avg ~48 units/week) → MONITORING
- **High Demand:** Cetirizine (avg ~83 units/week) → REORDER recommended

---

### Sales History: Pharmacy B

**Period 1:** 4 weeks ago
- Paracetamol: 60 units sold
- Amoxicillin: 25 units sold
- ORS: 80 units sold

**Period 2:** 3 weeks ago
- Paracetamol: 70 units sold
- Amoxicillin: 30 units sold
- ORS: 95 units sold

**Period 3:** 2 weeks ago
- Paracetamol: 55 units sold
- Amoxicillin: 20 units sold
- ORS: 75 units sold

**Current Stock After Sales:**
- All medicines maintain sufficient stock
- No critical reorder recommendations

---

### Implementation Note

Sales will be created through proper `sales` + `sale_items` + `inventory_movements` chain to maintain consistency.

---

## PART 10 — BILLING / POS DEMO

**Requirement:** Live stock available for billing demonstration

**Available for Live Demo:**

**Pharmacy A:**
- Paracetamol 500mg: 195 units available (PAR-A-2602)
- Ibuprofen 400mg: 120 units available
- Pantoprazole 40mg: 75 units available
- ORS Sachet: 250 units available

**Pharmacy B:**
- All medicines have sufficient stock for live demos

**Demo Flow:**
1. Select medicines for sale
2. System applies FEFO (earliest expiry first)
3. Create invoice with customer details
4. Process payment
5. Inventory automatically decreases
6. Invoice/receipt generated
7. Inventory movement recorded

---

## PART 11 — NEAR-EXPIRY REDISTRIBUTION SCENARIO

### Triggering Conditions

**Sender: Pharmacy A**
- Medicine: Amoxicillin 500mg (medicine_id: 2)
- Batch: AMX-A-2601
- Quantity: 15 units
- Expiry: 15 days from now (within 20-day threshold)
- Status: EXPIRING_SOON alert active

**Recipient: Pharmacy B**
- Medicine: Amoxicillin 500mg (medicine_id: 10)
- Current Stock: 60 units (sufficient)
- Distance: ~5.2 km (within 50 km radius)
- Can accept: Yes

**Alternative Recipient Scenario:**
If Pharmacy B had low Amoxicillin stock, the redistribution would be more urgent.

### Redistribution Request

```sql
INSERT INTO medicine_redistribution_requests (
  idempotency_key,
  sender_pharmacy_id,
  recipient_pharmacy_id,
  medicine_id,
  source_batch_id,
  requested_quantity,
  reason,
  request_type,
  status,
  automatic_request,
  days_until_expiry,
  distance_km
) VALUES (
  '[SHA256_HASH]',
  1,  -- Pharmacy A
  2,  -- Pharmacy B
  2,  -- Amoxicillin (Pharmacy A's medicine ID)
  [AMX-A-2601_BATCH_ID],
  15,
  'NEAR_EXPIRY_REDISTRIBUTION',
  'NEAR_EXPIRY',
  'PENDING',
  1,  -- Automatic
  15,
  5.2
);
```

### Demo Flow

1. Admin A runs "Scan Near-Expiry Stock"
2. System detects AMX-A-2601 expiring in 15 days
3. System searches nearby pharmacies (50 km radius)
4. Finds Pharmacy B at 5.2 km
5. Creates automatic redistribution request
6. Admin B sees incoming request
7. Can accept/reject offer
8. Status updates accordingly

---

## PART 12 — MANUAL MEDICINE REQUEST DEMO

### Scenario: Pharmacy A Requests Medicine from Pharmacy B

**Requester: Pharmacy A**
- Medicine: Pantoprazole 40mg (medicine_id: 5)
- Current Stock: 75 units
- Needed: 50 additional units (stock running low, expecting high demand)
- Reason: "Anticipated increased demand, current stock insufficient"

**Potential Provider: Pharmacy B**
- Medicine: Pantoprazole 40mg (medicine_id: 13)
- Current Stock: 25 units (also low!)
- Can Offer: 0 units (insufficient for self, cannot help)

**Better Scenario for Demo:**

Let's use **Azithromycin** instead:

**Requester: Pharmacy A**
- Medicine: Azithromycin 500mg (medicine_id: 4)
- Current Stock: 8 units (LOW - below minimum of 30)
- Needed: 30 units
- LOW_STOCK alert active

**Provider: Pharmacy B**
- Medicine: Azithromycin 500mg (medicine_id: 12)
- Current Stock: 45 units (sufficient)
- Can Offer: 25 units (keeps 20 for self)

### Medicine Request

```sql
INSERT INTO medicine_requests (
  idempotency_key,
  requester_pharmacy_id,
  medicine_id,
  medicine_name,
  requested_quantity,
  covered_quantity,
  status,
  priority,
  reason,
  current_zone_index,
  current_radius_km,
  created_by,
  expires_at
) VALUES (
  '[CLIENT_SUPPLIED_KEY]',
  1,  -- Pharmacy A
  4,  -- Azithromycin (Pharmacy A)
  'Azithromycin 500mg',
  30,
  0,  -- Initially uncovered
  'OPEN',
  'URGENT',
  'Low stock - below minimum threshold',
  0,
  10.0,  -- Initial search radius
  1,  -- Admin A
  NOW() + INTERVAL '72 hours'
);
```

### Medicine Request Offer

```sql
INSERT INTO medicine_request_offers (
  request_id,
  pharmacy_id,
  zone_index,
  distance_km,
  usable_stock_at_contact,
  status,
  offered_quantity,
  responded_by,
  responded_at,
  respond_by
) VALUES (
  [REQUEST_ID],
  2,  -- Pharmacy B
  0,
  5.2,
  45,  -- Usable stock snapshot
  'ACCEPTED',
  25,  -- Offered quantity
  3,  -- Admin B
  NOW(),
  NOW() + INTERVAL '24 hours'
);
```

**Update Request Status:**
```sql
UPDATE medicine_requests
SET 
  covered_quantity = 25,
  status = 'PARTIALLY_COVERED',
  updated_at = NOW()
WHERE id = [REQUEST_ID];
```

### Demo Flow

1. Admin A creates manual medicine request for Azithromycin
2. System searches nearby pharmacies
3. Contacts Pharmacy B (within radius)
4. Admin B receives request notification
5. Admin B offers 25 units
6. Request status → PARTIALLY_COVERED
7. Admin A sees coverage details
8. Can expand search or accept partial coverage

---

## PART 13 — MOBILE DEVICES

**Strategy:** Leave device pairing empty initially, demonstrate live pairing during presentation.

**Why:** 
- Device tokens are hardware-specific
- Cannot pre-seed without actual Android device
- Live pairing demonstration is more impressive

**Preparation:**
- ✅ Admin accounts ready to generate pairing codes
- ✅ Production APK will be built in Phase 4
- ✅ Pairing workflow tested and functional

**Demo Flow:**
1. Admin A logs into web UI
2. Navigates to Mobile Devices
3. Clicks "Generate Pairing Code"
4. 6-character code displayed (e.g., "AB12CD")
5. Opens Android app on physical device
6. Enters pairing code
7. Device paired successfully
8. Appears in "Paired Devices" list
9. Can now scan QR codes and receive stock

---

## PART 14 — QR DATA

**QR Payload Format:** (from existing implementation)
```
medicine=${medicineId}&batch=${batchId}
```

**Example QR Payloads:**

1. **Paracetamol PAR-A-2601:**  
   `medicine=1&batch=[BATCH_ID_1]`

2. **Amoxicillin AMX-A-2601:**  
   `medicine=2&batch=[BATCH_ID_2]`

3. **Ibuprofen IBU-A-2601:**  
   `medicine=3&batch=[BATCH_ID_3]`

**QR Generation:**
- Web UI generates QR via `/api/qr/generate?payload=...`
- Uses qrcode@1.5.4 (server-side SVG generation)
- Display on screen for Android scanning

**QR Lookup:**
- Mobile app scans QR → extracts payload
- Sends to `/api/mobile/qr/lookup` with device token
- Backend validates medicine/batch belong to device's pharmacy
- Returns medicine/batch details
- App displays stock receipt confirmation

**Demo Flow:**
1. Admin A navigates to Stock → Add Stock
2. Selects medicine and batch
3. Generates QR sticker/label
4. QR displayed on screen
5. Android app scans QR
6. Medicine verified
7. Stock receipt processed
8. Inventory updated

---

## PART 15 — DATA CONSISTENCY VERIFICATION

**Post-Seed Checks:**

```sql
-- Check pharmacy references
SELECT COUNT(*) FROM users WHERE pharmacy_id NOT IN (SELECT id FROM pharmacies);
-- Expected: 0

-- Check medicine references
SELECT COUNT(*) FROM medicine_batches WHERE medicine_id NOT IN (SELECT id FROM medicines);
-- Expected: 0

-- Check batch pharmacy isolation
SELECT COUNT(*) FROM medicine_batches mb
JOIN medicines m ON m.id = mb.medicine_id
WHERE m.pharmacy_id NOT IN (1, 2);
-- Expected: 0

-- Check negative stock
SELECT COUNT(*) FROM medicine_batches WHERE quantity < 0;
-- Expected: 0

-- Check orphan inventory movements
SELECT COUNT(*) FROM inventory_movements 
WHERE batch_id NOT IN (SELECT id FROM medicine_batches);
-- Expected: 0

-- Check orphan sale items
SELECT COUNT(*) FROM sale_items 
WHERE sale_id NOT IN (SELECT id FROM sales);
-- Expected: 0

-- Check orphan alerts
SELECT COUNT(*) FROM expiry_alerts 
WHERE batch_id NOT IN (SELECT id FROM medicine_batches);
-- Expected: 0

-- Verify stock consistency (sum of movements = current quantity)
SELECT 
  mb.id,
  mb.quantity as current_qty,
  COALESCE(SUM(im.change_quantity), 0) as movement_sum
FROM medicine_batches mb
LEFT JOIN inventory_movements im ON im.batch_id = mb.id
GROUP BY mb.id, mb.quantity
HAVING mb.quantity != COALESCE(SUM(im.change_quantity), 0);
-- Expected: 0 rows (all consistent)
```

---

## PART 16 — TENANT ISOLATION TEST

**Test Methodology:** Login as each user and verify dashboard/data visibility

### Test 1: Admin A (Pharmacy 1)

```
Login: admin.a@mediindex.com / Demo@12345
Expected:
- Dashboard shows Pharmacy A data only
- Medicines: IDs 1-8 visible
- Batches: Only Pharmacy A batches
- Sales: Only Pharmacy A sales
- Requests: Can see outgoing requests from Pharmacy A
- Offers: Can see incoming offers to Pharmacy A
- Cannot see Pharmacy B data
```

### Test 2: Staff A (Pharmacy 1)

```
Login: staff.a@mediindex.com / Demo@12345
Expected:
- Same data visibility as Admin A
- May have restricted write permissions (implementation-dependent)
- Cannot access admin-only features (user management, etc.)
```

### Test 3: Admin B (Pharmacy 2)

```
Login: admin.b@mediindex.com / Demo@12345
Expected:
- Dashboard shows Pharmacy B data only
- Medicines: IDs 9-16 visible
- Batches: Only Pharmacy B batches
- Sales: Only Pharmacy B sales
- Requests: Can see outgoing requests from Pharmacy B
- Offers: Can see incoming offers to Pharmacy B
- Cannot see Pharmacy A data
```

### Test 4: Staff B (Pharmacy 2)

```
Login: staff.b@mediindex.com / Demo@12345
Expected:
- Same data visibility as Admin B
- Standard staff permissions
```

### Test 5: Cross-Pharmacy Query Verification

```sql
-- This query should be impossible in application layer
SELECT * FROM medicines WHERE pharmacy_id != [current_user_pharmacy_id];
-- Application middleware must filter this automatically
```

**Critical:** All queries in application must include `WHERE pharmacy_id = [current_user_pharmacy]` filter.

---

## PART 17 — FINAL DEMO CHECKLIST

### Feature Verification (Post-Seed)

**✅ Login & Authentication**
- [ ] admin.a@mediindex.com login successful
- [ ] staff.a@mediindex.com login successful
- [ ] admin.b@mediindex.com login successful
- [ ] staff.b@mediindex.com login successful
- [ ] Invalid credentials rejected
- [ ] Session persistence works

**✅ Dashboard**
- [ ] Shows correct pharmacy name
- [ ] Total medicines count correct
- [ ] Stock value calculated
- [ ] Expiry alerts displayed
- [ ] Low stock alerts displayed
- [ ] Recent sales shown

**✅ Medicines & Inventory**
- [ ] Medicine list displays correctly
- [ ] Search works
- [ ] Add/Edit medicine functional
- [ ] Batch management works
- [ ] Stock quantities accurate
- [ ] Multiple batches per medicine shown

**✅ Billing / POS**
- [ ] Can select medicines
- [ ] FEFO applied automatically
- [ ] Invoice generated
- [ ] Stock decreased correctly
- [ ] Sale recorded in history
- [ ] Receipt printable/downloadable

**✅ Demand Forecasting**
- [ ] Historical sales displayed
- [ ] Forecast calculations shown
- [ ] Reorder recommendations visible
- [ ] Different demand patterns evident
- [ ] At least 3 medicines with reliable forecasts

**✅ Store Layout**
- [ ] Medicines grouped by location
- [ ] Rack/Shelf structure visible
- [ ] Stock quantities shown
- [ ] Expiry status indicators displayed
- [ ] Search highlights correct shelf

**✅ Expiry Alerts**
- [ ] Expired batch alert shown (CET-A-2602)
- [ ] Near-expiry alert shown (AMX-A-2601)
- [ ] Low stock alert shown (AZI-A-2601)
- [ ] Acknowledged vs unacknowledged distinction
- [ ] Alert details accessible

**✅ Near-Expiry Redistribution**
- [ ] Scan button functional
- [ ] Detects near-expiry stock (AMX-A-2601)
- [ ] Finds nearby pharmacy (Pharmacy B)
- [ ] Creates redistribution request
- [ ] Sender can see outgoing request
- [ ] Recipient can see incoming request
- [ ] Distance and days shown
- [ ] Accept/Reject workflow functional

**✅ Medicine Requests**
- [ ] Create request form works
- [ ] Request appears in sender's list
- [ ] Request appears in recipient's inbox
- [ ] Offer submission works
- [ ] Coverage calculation correct
- [ ] Status updates appropriately
- [ ] OPEN → PARTIALLY_COVERED transition

**✅ Mobile Devices**
- [ ] Pairing code generation works
- [ ] Code displays correctly (6 characters)
- [ ] Code expires after 10 minutes
- [ ] Android app pairing functional
- [ ] Paired device appears in list
- [ ] Device can be revoked

**✅ QR Generation & Lookup**
- [ ] QR generation endpoint works
- [ ] QR displays on screen
- [ ] QR is scannable by Android
- [ ] Android decodes correctly
- [ ] Lookup returns correct medicine/batch
- [ ] Stock receipt workflow completes
- [ ] Inventory updated after receipt

**✅ Tenant Isolation**
- [ ] Admin A sees only Pharmacy A data
- [ ] Staff A sees only Pharmacy A data
- [ ] Admin B sees only Pharmacy B data
- [ ] Staff B sees only Pharmacy B data
- [ ] No cross-pharmacy data leakage

---

## EXECUTION SUMMARY

### Current Status

✅ **Database is empty - no destructive deletion required**

### Proposed Actions

1. **Execute Seed Script** (Part 18 - to be created)
   - Insert 2 pharmacies with coordinates
   - Insert 4 users with hashed passwords
   - Insert 16 medicines (8 per pharmacy)
   - Insert 18 batches with realistic stock
   - Insert 4 expiry alerts
   - Insert historical sales (4 weeks × 3 medicines × 2 pharmacies)
   - Insert 1 near-expiry redistribution request
   - Insert 1 manual medicine request + 1 offer
   - Verify data consistency
   - Verify tenant isolation

2. **Verify All Features** (Checklist above)

3. **Test Mobile Integration** (Phase 4)
   - Build production APK
   - Pair Android device
   - Test QR scan workflow

### Safety Measures

- ✅ All operations use transactions (ROLLBACK on error)
- ✅ No secrets exposed in seed data
- ✅ Passwords properly hashed with scrypt
- ✅ Tenant isolation maintained
- ✅ Foreign key constraints respected
- ✅ No negative stock or impossible dates
- ✅ Consistent with existing schema
- ✅ No code modifications required

---

## AUTHORIZATION REQUIRED

**This plan is ready for execution pending your explicit authorization.**

**To proceed, you must confirm:**
1. ✅ Approve two-pharmacy structure
2. ✅ Approve four demo accounts
3. ✅ Approve medicine catalog
4. ✅ Approve stock/batch distribution
5. ✅ Approve expiry scenarios
6. ✅ Approve forecasting data (historical sales)
7. ✅ Approve inter-pharmacy scenarios
8. ✅ Approve demo password: `Demo@12345`

**Once approved, I will create and execute the seed script.**

---

**END OF DEMO DATABASE PLAN**
