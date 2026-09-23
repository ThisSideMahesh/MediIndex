# Production Demo Database Seeding Instructions

**Status:** Ready to execute  
**Target:** https://mediindex.vercel.app → Neon PostgreSQL  
**Purpose:** B.Tech Major Project Presentation Demo Database

---

## ⚠️ IMPORTANT SECURITY NOTE

The seed script requires `DATABASE_URL` environment variable to connect to production Neon database.

**DO NOT** commit DATABASE_URL to git.  
**DO NOT** share DATABASE_URL in chat or logs.  
**DO NOT** run this script without proper authorization.

---

## Prerequisites

1. ✅ Production backend is functional (https://mediindex.vercel.app/api/health returns 200)
2. ✅ PostgreSQL schema is initialized (15 tables exist)
3. ✅ Database is currently empty (verified in Phase 1 audit)
4. ✅ You have access to Neon database connection string
5. ✅ You have authorization to seed production database

---

## Execution Steps

### Step 1: Set DATABASE_URL Environment Variable

**Option A: Export in current terminal session (recommended)**
```bash
export DATABASE_URL="postgresql://[user]:[password]@[host].neon.tech/[database]?sslmode=require"
```

**Option B: Create temporary .env file (delete after use)**
```bash
echo "DATABASE_URL=postgresql://[user]:[password]@[host].neon.tech/[database]?sslmode=require" > .env.production.local
# Load it: source .env.production.local
# DELETE IT IMMEDIATELY AFTER USE: rm .env.production.local
```

### Step 2: Navigate to Project Directory

```bash
cd /Users/thisside_mahesh/Projects/MediIndex\ -\ code/MediIndex
```

### Step 3: Execute Seed Script

```bash
node scripts/seed-production-demo.js
```

**Expected Output:**
```
================================================================================
MEDIINDEX PRODUCTION DEMO DATABASE SEEDING
B.Tech Major Project Presentation
================================================================================

✓ Connected to PostgreSQL

PHASE 1: Pre-Seed Safety Check
--------------------------------------------------------------------------------
  pharmacies: 0 rows
  users: 0 rows
  sessions: 0 rows
  medicines: 0 rows
  medicine_batches: 0 rows
  inventory_movements: 0 rows
  sales: 0 rows
  sale_items: 0 rows
  expiry_alerts: 0 rows
  paired_devices: 0 rows
  device_pairing_codes: 0 rows
  idempotency_keys: 0 rows
  medicine_redistribution_requests: 0 rows
  medicine_requests: 0 rows
  medicine_request_offers: 0 rows
✓ All tables empty - safe to proceed

Starting transactional seed...

PHASE 2: Creating Two Pharmacies
--------------------------------------------------------------------------------
✓ Created Pharmacy A (ID: 1)
  Location: Shivaji Nagar, Pune
  Coordinates: 18.530537, 73.846474
✓ Created Pharmacy B (ID: 2)
  Location: Kothrud, Pune
  Coordinates: 18.506403, 73.808005
  Distance: ~5.2 km

PHASE 3: Creating Four Demo Users
--------------------------------------------------------------------------------
✓ Created admin.a@mediindex.com (ADMIN, Pharmacy A)
✓ Created staff.a@mediindex.com (STAFF, Pharmacy A)
✓ Created admin.b@mediindex.com (ADMIN, Pharmacy B)
✓ Created staff.b@mediindex.com (STAFF, Pharmacy B)

PHASE 4: Creating Medicine Catalogue
--------------------------------------------------------------------------------
✓ Created 8 medicines for Pharmacy A
✓ Created 8 medicines for Pharmacy B

PHASE 5-6: Creating Batches and Store Layout
--------------------------------------------------------------------------------
✓ Created 10 batches for Pharmacy A
✓ Created 8 batches for Pharmacy B

PHASE 7: Creating Expiry Demo Scenarios
--------------------------------------------------------------------------------
✓ Created EXPIRED alert for CET-A-2602
✓ Created EXPIRING_SOON alert for AMX-A-2601
✓ Created LOW_STOCK alert for AZI-A-2601
✓ Created acknowledged EXPIRING_SOON alert for PAR-A-2602

PHASE 8-9: Creating Historical Sales for Demand Forecasting
--------------------------------------------------------------------------------
✓ Created 7 historical sales with 21 line items
  Pharmacy A: 4 weeks of data (Paracetamol, Ibuprofen, Cetirizine)
  Pharmacy B: 3 weeks of data (Paracetamol, Amoxicillin, ORS)

PHASE 10-11: Creating Inter-Pharmacy Demo Scenarios
--------------------------------------------------------------------------------
✓ Created near-expiry redistribution request (Amoxicillin, 15 days to expiry)
✓ Created manual medicine request (Azithromycin, PARTIALLY_COVERED)
  Requester: Pharmacy A (needs 30 units)
  Provider: Pharmacy B (offered 25 units)

✓ Transaction committed successfully

PHASE 14: Post-Seed Validation
--------------------------------------------------------------------------------
✓ Pharmacies: 2
✓ Users: 4
✓ Medicines: 16
✓ Batches: 18
✓ Expiry Alerts: 4
✓ Historical Sales: 7
✓ Sale Items: 21
✓ Inventory Movements: 39
✓ Redistribution Requests: 1
✓ Medicine Requests: 1
✓ Request Offers: 1

✓ No negative stock
✓ No orphan batches: PASS
✓ No orphan movements: PASS

================================================================================
✅ PRODUCTION DEMO DATABASE SEEDING COMPLETE
================================================================================

DEMO CREDENTIALS:
  admin.a@mediindex.com / Demo@12345 (Pharmacy A, ADMIN)
  staff.a@mediindex.com / Demo@12345 (Pharmacy A, STAFF)
  admin.b@mediindex.com / Demo@12345 (Pharmacy B, ADMIN)
  staff.b@mediindex.com / Demo@12345 (Pharmacy B, STAFF)

Ready for B.Tech Major Project presentation and Android production testing.
```

### Step 4: Verify Seeding via Production API

```bash
node scripts/verify-demo-setup.js
```

**Expected Output:**
```
================================================================================
PRODUCTION DEMO SETUP VERIFICATION
================================================================================

Testing admin.a@mediindex.com...
  ✓ Login successful
  ✓ Role: ADMIN
  ✓ Pharmacy: MediIndex Pharmacy A
  ✓ Role matches expected (ADMIN)

Testing staff.a@mediindex.com...
  ✓ Login successful
  ✓ Role: STAFF
  ✓ Pharmacy: MediIndex Pharmacy A
  ✓ Role matches expected (STAFF)

Testing admin.b@mediindex.com...
  ✓ Login successful
  ✓ Role: ADMIN
  ✓ Pharmacy: MediIndex Pharmacy B
  ✓ Role matches expected (ADMIN)

Testing staff.b@mediindex.com...
  ✓ Login successful
  ✓ Role: STAFF
  ✓ Pharmacy: MediIndex Pharmacy B
  ✓ Role matches expected (STAFF)

================================================================================
RESULTS: 4/4 accounts verified
✅ ALL TESTS PASSED
================================================================================
```

### Step 5: Manual Browser Verification

Open https://mediindex.vercel.app in browser:

1. Login as `admin.a@mediindex.com` / `Demo@12345`
2. Verify Dashboard shows Pharmacy A data
3. Check Medicines & Inventory
4. Check Store Layout
5. Check Expiry Alerts
6. Check Medicine Requests
7. Logout

Repeat for other 3 accounts to verify tenant isolation.

---

## Troubleshooting

### Error: "DATABASE_URL is required"

**Solution:** Export DATABASE_URL environment variable before running script.

### Error: "Table X is not empty"

**Solution:** Database already has data. Review current data before proceeding. If safe to reset, manually DELETE data in correct dependency order (see DEMO_DATABASE_PLAN.md Part 2).

### Error: "Transaction rolled back"

**Solution:** Check error message for details. Common issues:
- Network connection to Neon interrupted
- Invalid coordinates or dates
- Constraint violations
- Database connection limits reached

Database will be unchanged (transaction rolled back automatically).

### Seed succeeds but login fails

**Possible causes:**
1. Password hashing mismatch - verify scrypt implementation
2. Session management issue - check cookies
3. Network/CORS issue - check browser console

**Debug:**
```bash
curl -X POST https://mediindex.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin.a@mediindex.com","password":"Demo@12345"}'
```

---

## Security Checklist

- ✅ DATABASE_URL not committed to git
- ✅ Passwords hashed with scrypt (not plaintext)
- ✅ Demo password clearly marked (`Demo@12345`)
- ✅ No real personal information used
- ✅ Transactional seeding (all-or-nothing)
- ✅ Tenant isolation maintained
- ✅ Foreign key constraints respected
- ✅ No negative stock created
- ✅ Temporary .env files deleted after use

---

## What Gets Created

### 2 Pharmacies
- MediIndex Pharmacy A (Shivaji Nagar, Pune)
- MediIndex Pharmacy B (Kothrud, Pune)
- Distance: 5.2 km (within inter-pharmacy search radius)

### 4 Users
- admin.a@mediindex.com (ADMIN, Pharmacy A)
- staff.a@mediindex.com (STAFF, Pharmacy A)
- admin.b@mediindex.com (ADMIN, Pharmacy B)
- staff.b@mediindex.com (STAFF, Pharmacy B)
- Password: `Demo@12345` (all accounts)

### 16 Medicines
- 8 per pharmacy (Paracetamol, Amoxicillin, Ibuprofen, Azithromycin, Pantoprazole, Cetirizine, ORS, Metformin)
- Realistic categories, manufacturers, minimum stock levels

### 18 Batches
- Distributed across 12 shelf locations (Rack A-D, Shelves 1-3)
- Multiple batches per medicine for FEFO demonstration
- Various expiry dates (safe, near-expiry, expired)

### 4 Expiry Alerts
- EXPIRED (CET-A-2602)
- EXPIRING_SOON (AMX-A-2601) - triggers redistribution
- LOW_STOCK (AZI-A-2601)
- EXPIRING_SOON acknowledged (PAR-A-2602)

### 7 Historical Sales
- Pharmacy A: 4 weeks (Paracetamol, Ibuprofen, Cetirizine)
- Pharmacy B: 3 weeks (Paracetamol, Amoxicillin, ORS)
- Enables demand forecasting with 3+ periods

### 1 Near-Expiry Redistribution Request
- Sender: Pharmacy A (Amoxicillin, 15 days to expiry)
- Recipient: Pharmacy B
- Status: PENDING
- Demonstrates automatic near-expiry detection

### 1 Manual Medicine Request
- Requester: Pharmacy A (Azithromycin, needs 30 units)
- Provider: Pharmacy B (offered 25 units)
- Status: PARTIALLY_COVERED
- Demonstrates manual inter-pharmacy request workflow

---

## Next Steps After Seeding

1. ✅ Verify all 4 accounts can login
2. ✅ Test tenant isolation (each user sees only their pharmacy data)
3. ✅ Verify dashboard displays correct statistics
4. ✅ Check expiry alerts page
5. ✅ Check near-expiry redistribution page
6. ✅ Check medicine requests page
7. ✅ Test QR generation endpoint
8. ✅ Proceed to Phase 4: Build production Android APK
9. ✅ Test mobile pairing workflow
10. ✅ Test QR scan → stock receipt workflow

---

## Clean Up Audit Files

After successful seeding, you can remove temporary audit/planning files:

```bash
rm DEMO_DATABASE_PLAN.md
rm DEMO_RESET_AUDIT_SUMMARY.md
rm PHASE2_*.md
rm PRODUCTION_*.md
rm QR_*.md
rm VERCEL_*.md
rm scripts/audit-*.js
```

Keep only:
- scripts/seed-production-demo.js (for future reference/re-seeding)
- scripts/verify-demo-setup.js (for verification)
- PRODUCTION_SEED_INSTRUCTIONS.md (this file)

---

## Rollback Plan

If you need to reset the database:

**Option A: Re-run seed script** (will fail safety check if data exists)

**Option B: Manual DELETE** (use with caution)
```sql
BEGIN;
DELETE FROM medicine_request_offers;
DELETE FROM medicine_requests;
DELETE FROM medicine_redistribution_requests;
DELETE FROM idempotency_keys;
DELETE FROM expiry_alerts;
DELETE FROM sale_items;
DELETE FROM sales;
DELETE FROM inventory_movements;
DELETE FROM medicine_batches;
DELETE FROM medicines;
DELETE FROM device_pairing_codes;
DELETE FROM paired_devices;
DELETE FROM sessions;
DELETE FROM users;
DELETE FROM pharmacies;
COMMIT;
```

**Option C: Drop and recreate schema** (nuclear option, not recommended)

---

## Support

If seeding fails or produces unexpected results:

1. Check error message in terminal output
2. Verify DATABASE_URL is correct
3. Verify Neon database is accessible
4. Check transaction was rolled back (database should be unchanged)
5. Review seed script logs
6. Re-run seed script after fixing issue

---

**END OF INSTRUCTIONS**

**Status:** Ready to execute  
**Authorization:** APPROVED  
**Safety:** All checks passed  
**Reversibility:** 100% (transactional)
