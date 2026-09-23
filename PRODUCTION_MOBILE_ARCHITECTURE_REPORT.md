# Production Mobile Architecture Investigation Report

**Date:** 2026-09-23  
**Goal:** Enable Android APK to work against Vercel/Neon production environment

---

## 1. CURRENT MOBILE API URL MECHANISM

### Environment Variable Configuration

**File:** `mobile/src/config/env.ts`

**Mechanism:**
```typescript
const DEFAULT_API_BASE_URL = 'http://10.0.2.2:3000'; // Android emulator default
const fromEnv = process.env.EXPO_PUBLIC_MOBILE_API_BASE_URL;
const apiBaseUrl = fromEnv?.trim() || DEFAULT_API_BASE_URL;
```

**Source Priority:**
1. `EXPO_PUBLIC_MOBILE_API_BASE_URL` environment variable
2. Fallback: `http://10.0.2.2:3000` (Android emulator → host)

**Current Local Configuration:** `mobile/.env`
```
EXPO_PUBLIC_MOBILE_API_BASE_URL=http://172.20.10.5:3000
```

**Build-Time Behavior:**
- Expo inlines `EXPO_PUBLIC_*` variables into the bundle at build time
- The URL becomes **hardcoded** in the compiled JavaScript bundle
- Runtime environment changes do NOT affect already-built APKs

**Key Insight:** ✅ **The architecture already supports environment-specific builds.**

The URL is read from environment at build time, so we can:
- Build **local APK** with `http://172.20.10.5:3000`
- Build **production APK** with `https://mediindex-production.vercel.app`

---

## 2. CURRENT VERCEL PRODUCTION URL

### Status: ❌ **NOT CONFIGURED**

**Evidence:**
- No `.vercel/` directory exists
- No production URL documented in README.md
- No `PRODUCTION_DEPLOYMENT_NOTES.md` file
- Git history shows Vercel preview deployments but no production domain

**Available Information:**
- Repository: `https://github.com/ThisSideMahesh/MediIndex`
- Vercel integration appears active (based on git commits)
- Preview deployments working (per git history)

**Actual Production URL:** ❓ **UNKNOWN**

**Likely Format:**
- Option A: `https://mediindex.vercel.app` (if custom domain not configured)
- Option B: `https://medi-index-*.vercel.app` (if using generated subdomain)
- Option C: Custom domain (e.g., `https://mediindex.example.com`)

**Required Action:** User must provide actual Vercel production URL.

---

## 3. PREVIEW VS PRODUCTION DISTINCTION

### Vercel Deployment Types

**Preview Deployments:**
- URL Pattern: `https://mediindex-git-{branch}-{user}.vercel.app`
- Created for: Every git push to non-production branches
- Deployment Protection: ✅ **ENABLED** (SSO/authentication required)
- Purpose: Testing, code review, staging
- **Status:** Cannot be used for mobile app (SSO blocks API access)

**Production Deployment:**
- URL Pattern: `https://mediindex.vercel.app` or custom domain
- Created for: Git pushes to `main` or manual promotion
- Deployment Protection: ⚠️ **User-configurable** (typically disabled for public APIs)
- Purpose: Live production environment
- **Status:** Should work for mobile app (no SSO by default)

### Current State

**Mobile App Constraint:**
```
From mobile/.env.example:
# NOTE: the MediIndex Vercel Preview is behind Deployment Protection (SSO), which
# a mobile device cannot authenticate through. Point this at a local server or an
# unprotected deployment. Do not attempt to bypass SSO.
```

**Implication:** Mobile app requires production deployment URL, not preview URL.

---

## 4. REQUIRED ENVIRONMENT/BUILD CHANGES

### Option A: Environment-Specific .env Files (RECOMMENDED)

**Structure:**
```
mobile/
  .env.local          # Local development (git-ignored)
  .env.production     # Production build (git-ignored)
  .env.example        # Documentation
```

**Local:** `mobile/.env.local`
```bash
EXPO_PUBLIC_MOBILE_API_BASE_URL=http://172.20.10.5:3000
```

**Production:** `mobile/.env.production`
```bash
EXPO_PUBLIC_MOBILE_API_BASE_URL=https://mediindex.vercel.app
```

**Build Commands:** (requires EAS Build setup)
```bash
# Local development APK
npm run build:local

# Production APK
npm run build:production
```

**Implementation:**
- Install EAS CLI: `npm install -g eas-cli`
- Create `mobile/eas.json` with build profiles
- Configure environment loading per profile

---

### Option B: EAS Build Profiles (PRODUCTION STANDARD)

**File:** `mobile/eas.json` (create new)
```json
{
  "build": {
    "local": {
      "android": {
        "buildType": "apk",
        "env": {
          "EXPO_PUBLIC_MOBILE_API_BASE_URL": "http://172.20.10.5:3000"
        }
      }
    },
    "production": {
      "android": {
        "buildType": "apk",
        "env": {
          "EXPO_PUBLIC_MOBILE_API_BASE_URL": "https://mediindex.vercel.app"
        }
      }
    }
  }
}
```

**Build Commands:**
```bash
# Build local APK
eas build --platform android --profile local --local

# Build production APK
eas build --platform android --profile production
```

**Advantages:**
- Industry-standard approach for Expo apps
- Clean separation of environments
- No manual .env file switching
- Supports iOS when needed

---

### Option C: Manual .env Switching (NOT RECOMMENDED)

**Process:**
1. Copy `mobile/.env.production` to `mobile/.env`
2. Build APK
3. Restore `mobile/.env.local` to `mobile/.env`

**Issues:**
- Error-prone
- Easy to forget which environment is active
- Doesn't scale with team development

**Verdict:** ❌ Avoid this approach

---

## 5. REQUIRED PRODUCTION DATABASE/DEVICE SETUP

### A. Vercel Production Backend Status

**Database:** ✅ **PostgreSQL (Neon) — Already Configured**

**Evidence:**
- `db/postgres-adapter.js` exists
- Adapter selection: `process.env.DATABASE_URL ? 'postgres' : 'sqlite'`
- Vercel backend will use PostgreSQL if `DATABASE_URL` is set in Vercel dashboard

**Assumption:** Vercel production deployment has `DATABASE_URL` configured (user must confirm)

---

### B. Production Database Data Requirements

**Schema:** ✅ **Identical to Local** (same SQL schema)

**Required Data:**
1. **Pharmacies Table:**
   - At least one pharmacy record
   - Example: `INSERT INTO pharmacies (name, address) VALUES ('Demo Pharmacy', '123 Main St')`

2. **Users Table:**
   - At least one ADMIN user for web login
   - Password hashed with bcrypt
   - Associated with pharmacy_id

3. **Medicines Table:**
   - Test medicines for QR generation/scanning
   - Each medicine owned by a pharmacy_id

4. **Medicine_Batches Table:**
   - Batches associated with medicines
   - Required fields: batch_number, quantity, expiry_date, location

5. **Paired_Devices Table:**
   - EMPTY initially (devices will be paired via mobile app)

**Current Status:** ❓ **UNKNOWN**

User must verify production database is seeded with:
- At least 1 pharmacy
- At least 1 admin user
- At least 1 medicine
- At least 1 batch

---

### C. Device Pairing Process

**Architecture:** ✅ **Stateless, database-backed, backend-independent**

**Flow:**
```
1. Admin logs into Vercel web UI
2. Admin generates pairing code: POST /api/mobile/pairing/create
3. Mobile app receives pairing code from user
4. Mobile app claims code: POST /api/mobile/pairing/complete
5. Backend creates paired_devices record in production PostgreSQL
6. Backend returns device token (stored in SecureStore)
7. Mobile app uses device token for all subsequent requests
```

**Key Properties:**
- ✅ Device token is database-backed (stored in production PostgreSQL)
- ✅ No dependency on local SQLite
- ✅ Works identically against local or Vercel backend
- ✅ Tenant isolation enforced (device.pharmacy_id)

**Requirements:**
1. Production backend must be running
2. Admin user must exist in production database
3. Mobile device must reach production backend URL
4. Mobile app must be built with production API URL

**New Pairing Required:** ✅ **YES**

Local device is paired to local SQLite database. For production:
1. Re-pair device to production backend
2. New device token will be stored in SecureStore (replaces local token)
3. All API calls will now use production backend

---

## 6. BACKEND CHANGES REQUIRED

### Analysis: ❌ **NO BACKEND CHANGES REQUIRED**

**Device Authentication:**
```javascript
async function currentDevice(req) {
  const rawToken = parseDeviceToken(req); // Reads X-Device-Token header
  const tokenHash = hashDeviceToken(rawToken);
  const row = await db.prepare(`
    SELECT d.id, d.pharmacy_id, d.device_name, ...
    FROM paired_devices d
    JOIN pharmacies p ON p.id = d.pharmacy_id
    WHERE d.token_hash = ? AND d.revoked = 0
  `).get(tokenHash);
  // Returns device with pharmacy_id
}
```

**QR Lookup:**
```javascript
const medicine = await db.prepare(`
  SELECT id, name, generic_name, manufacturer, category, minimum_stock
  FROM medicines
  WHERE id = ? AND pharmacy_id = ? AND active = 1
`).get(medicineId, device.pharmacyId);
```

**Key Points:**
- ✅ Device authentication is **database-backed** (not session-based)
- ✅ Works identically with SQLite or PostgreSQL
- ✅ Tenant isolation via `pharmacy_id` foreign keys
- ✅ No hardcoded local paths
- ✅ No Vercel-specific code paths

**Verification:**
- Mobile app sends: `X-Device-Token` header
- Backend queries: `paired_devices` table (PostgreSQL or SQLite)
- Backend enforces: `pharmacy_id` isolation
- No changes needed for production

---

### Deployment Protection Compatibility

**Question:** Does mobile device-token authentication work independently of Vercel SSO?

**Answer:** ✅ **YES — COMPLETELY INDEPENDENT**

**Evidence:**
```javascript
// Vercel Deployment Protection: Applied at Vercel edge/proxy layer
// Protects: Web UI (HTML pages, assets)
// Does NOT protect: API endpoints (if configured correctly)

// Mobile Authentication: Applied in core.js handler
function currentDevice(req) {
  const rawToken = parseDeviceToken(req); // X-Device-Token header
  // No dependency on Vercel session
  // No dependency on browser cookies
  // No dependency on SSO
}
```

**Implication:**
- Production deployment should **exclude** `/api/*` from Deployment Protection
- OR: Use production deployment (no Deployment Protection by default)
- Mobile device tokens work independently of web SSO

**Recommended Vercel Configuration:**
- **Preview:** Deployment Protection ON (web UI only, exclude `/api/*`)
- **Production:** Deployment Protection OFF (public API with device auth)

---

## 7. PRODUCTION DEPLOYMENT VERIFICATION

### Prerequisites Checklist

**Vercel Production:**
- [ ] Production deployment exists
- [ ] Production URL identified (e.g., `https://mediindex.vercel.app`)
- [ ] `DATABASE_URL` configured in Vercel dashboard (Neon connection string)
- [ ] Deployment Protection: OFF or excludes `/api/*`

**Neon PostgreSQL:**
- [ ] Database created
- [ ] Schema applied (via `db/schema.pg.sql`)
- [ ] Seed data loaded:
  - [ ] At least 1 pharmacy
  - [ ] At least 1 admin user
  - [ ] At least 1 medicine
  - [ ] At least 1 batch

**API Endpoints Reachable:**
```bash
# Test from development machine
curl https://mediindex.vercel.app/api/health
# Expected: {"status":"ok","database":"connected","adapter":"postgres"}

curl -X POST https://mediindex.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"YourPassword123"}'
# Expected: Session cookie + 200 OK
```

---

## 8. MOBILE BUILD PROCESS

### Current Build Method

**No EAS Build configured:**
- No `mobile/eas.json` exists
- No build profiles defined
- Current approach: Local development with `expo run:android`

**Local Development Flow:**
```bash
cd mobile
npm start              # Expo dev server
npm run android        # Build and install on connected device
```

**Production Build Required:**
- Install EAS CLI: `npm install -g eas-cli`
- Configure `eas.json` with profiles
- Build production APK with production API URL

---

### Recommended Production Build Configuration

**File:** `mobile/eas.json` (create)
```json
{
  "cli": {
    "version": ">= 15.0.0"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      },
      "env": {
        "EXPO_PUBLIC_MOBILE_API_BASE_URL": "http://172.20.10.5:3000"
      }
    },
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    },
    "production": {
      "android": {
        "buildType": "apk"
      },
      "env": {
        "EXPO_PUBLIC_MOBILE_API_BASE_URL": "https://mediindex.vercel.app"
      }
    }
  },
  "submit": {
    "production": {}
  }
}
```

**Build Commands:**
```bash
# Development APK (local backend)
cd mobile
eas build --platform android --profile development --local

# Production APK (Vercel backend)
eas build --platform android --profile production

# Note: --local flag builds on your machine (faster, no EAS servers needed)
# Without --local, builds on EAS cloud (requires EAS account)
```

---

## 9. STEP-BY-STEP PRODUCTION SETUP

### Phase 1: Verify Production Backend

1. **Identify Vercel production URL:**
   - Check Vercel dashboard
   - Or ask: "What is the MediIndex production URL?"

2. **Test production API:**
   ```bash
   curl https://[PRODUCTION-URL]/api/health
   # Expected: {"status":"ok","database":"connected","adapter":"postgres"}
   ```

3. **Verify database has data:**
   ```bash
   # Login to production web UI
   # Navigate to medicines list
   # Confirm at least 1 medicine exists
   ```

---

### Phase 2: Configure Mobile Build

1. **Install EAS CLI:**
   ```bash
   npm install -g eas-cli
   eas login
   ```

2. **Create `mobile/eas.json`:** (see configuration above)

3. **Update `mobile/.gitignore`:**
   ```
   .env.local
   .env.production
   ```

4. **Create `mobile/.env.production`:**
   ```bash
   EXPO_PUBLIC_MOBILE_API_BASE_URL=https://[PRODUCTION-URL]
   ```

---

### Phase 3: Build Production APK

1. **Build APK:**
   ```bash
   cd mobile
   eas build --platform android --profile production
   ```

2. **Download APK:**
   - EAS will provide download URL
   - Install on Android device

3. **Verify APK configuration:**
   - Open app
   - Check settings/about (if available)
   - Or: Attempt to pair (will fail if URL wrong)

---

### Phase 4: Pair Device to Production

1. **Admin logs into production web UI:**
   ```
   https://[PRODUCTION-URL]/
   ```

2. **Generate pairing code:**
   - Navigate to Mobile Devices section
   - Click "Generate Pairing Code"
   - Note code (e.g., `MED-A1B2C3`)

3. **Pair mobile device:**
   - Open production APK
   - Enter pairing code
   - Confirm successful pairing

4. **Verify device shows in web UI:**
   - Refresh Mobile Devices list
   - Confirm device appears with status "Active"

---

### Phase 5: Test Production QR Flow

1. **Generate QR from production web UI:**
   - Login to `https://[PRODUCTION-URL]/`
   - Navigate to medicine with batch
   - Generate QR sticker

2. **Scan with production APK:**
   - Open mobile app
   - Scan QR code
   - **Expected:** ✅ "Medicine Verified" with correct data

3. **Test stock receipt:**
   - Scan QR
   - Navigate to Stock Receipt
   - Enter quantity
   - Submit
   - **Expected:** ✅ "Stock receipt successful"

---

## 10. SECURITY CONSIDERATIONS

### API URL Security

**Safe to Hardcode:**
- ✅ Production API URL (public HTTPS endpoint)
- Example: `https://mediindex.vercel.app`

**Never Hardcode:**
- ❌ `DATABASE_URL` (stays in Vercel environment)
- ❌ Device tokens (stored in SecureStore at runtime)
- ❌ Pairing codes (ephemeral, user-entered)
- ❌ Admin passwords (user-managed)

### Authentication Architecture

**Device Token Storage:**
- ✅ Stored in: `expo-secure-store` (encrypted device storage)
- ✅ Never logged
- ✅ Never sent in URL parameters
- ✅ Only sent in: `X-Device-Token` header

**Backend Verification:**
```javascript
// Device token is hashed before database lookup
const tokenHash = hashDeviceToken(rawToken); // SHA-256
const device = await db.get('... WHERE token_hash = ?', [tokenHash]);
```

**Tenant Isolation:**
```javascript
// All queries enforce pharmacy_id
WHERE medicine_id = ? AND pharmacy_id = device.pharmacyId
```

**No Changes Required:** ✅ Current implementation is production-ready

---

## 11. DEPLOYMENT PROTECTION CONFIGURATION

### Current State

**Vercel Preview:**
- Deployment Protection: ✅ **ENABLED** (SSO required)
- Effect: Blocks mobile app API access

**Vercel Production:**
- Deployment Protection: ❓ **UNKNOWN** (likely disabled by default)
- Required: Must be disabled for `/api/*` or entirely

### Recommended Configuration

**Option A: Disable Deployment Protection for Production**
```
Vercel Dashboard → Project Settings → Deployment Protection
→ Production: OFF
```

**Option B: Exclude API Paths (if supported)**
```
Deployment Protection Rules:
- Protect: /*, /_next/*, /assets/*
- Exclude: /api/*
```

**User Action Required:**
- Check Vercel dashboard
- Confirm production Deployment Protection status
- Disable if necessary for mobile API access

---

## 12. EXPECTED DIFFERENCES: LOCAL VS PRODUCTION

### Local Environment

| Component | Value |
|-----------|-------|
| Backend URL | `http://172.20.10.5:3000` |
| Database | SQLite (`data/mediindex.db`) |
| Pharmacy | ID=1 "MediIndex Demo Pharmacy" |
| Device Token | Paired to local database |
| Data | Local seed data |

### Production Environment

| Component | Value |
|-----------|-------|
| Backend URL | `https://mediindex.vercel.app` |
| Database | PostgreSQL (Neon) |
| Pharmacy | ID=? (production pharmacy) |
| Device Token | Paired to production database |
| Data | Production seed data |

### Key Difference

**Medicine IDs are pharmacy-scoped:**
- Local `medicineId=1` ≠ Production `medicineId=1`
- Each environment has independent data
- QR codes are environment-specific

**Workflow:**
- **Local:** Generate QR from local web → Scan with local APK → ✅ Works
- **Production:** Generate QR from production web → Scan with production APK → ✅ Works
- **Cross-environment:** Generate QR from production → Scan with local APK → ❌ Fails (expected)

---

## SUMMARY & REQUIRED ACTIONS

### What We Know

✅ **Mobile API URL mechanism:** Environment variable at build time  
✅ **Device authentication:** Database-backed, works with PostgreSQL  
✅ **Tenant isolation:** Enforced via pharmacy_id  
✅ **QR implementation:** Working correctly  
✅ **Backend compatibility:** No changes required  

### What We Don't Know

❓ **Vercel production URL:** User must provide  
❓ **Production database status:** Seeded? Schema applied?  
❓ **Deployment Protection:** Disabled for production API?  
❓ **Neon configuration:** Connection string set in Vercel?  

### Required Information from User

**CRITICAL — Need Answers:**

1. **What is the Vercel production URL?**
   - Format: `https://mediindex.vercel.app` or custom domain

2. **Is production database seeded?**
   - At least 1 pharmacy
   - At least 1 admin user
   - At least 1 medicine with batch

3. **Is Deployment Protection disabled for production?**
   - Check: Vercel Dashboard → Settings → Deployment Protection

4. **Is `DATABASE_URL` configured in Vercel?**
   - Check: Vercel Dashboard → Settings → Environment Variables

### Implementation Plan (After Information Received)

**Phase 1: Configure Build** (5 minutes)
- Create `mobile/eas.json`
- Add production profile with correct URL

**Phase 2: Build Production APK** (10-15 minutes)
- Run: `eas build --platform android --profile production`
- Download APK

**Phase 3: Pair & Test** (5 minutes)
- Generate pairing code from production web
- Pair device with production APK
- Test QR scan + stock receipt

**Total Time:** ~20-25 minutes (after prerequisites confirmed)

---

## RECOMMENDATION

**DO NOT PROCEED** with implementation until user provides:

1. ✅ Vercel production URL
2. ✅ Confirmation that production database is seeded
3. ✅ Confirmation that production API is publicly accessible

**Reason:** Building production APK without correct URL wastes build time (10-15 minutes per build).

**Next Step:** Request production environment details from user.
