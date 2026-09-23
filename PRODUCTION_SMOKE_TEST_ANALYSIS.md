# Production Smoke Test Analysis

**Date**: 2026-09-19  
**Target**: https://mediindex.vercel.app  
**Database**: Neon PostgreSQL  

## Executive Summary

Production smoke test revealed that **5 endpoints tested do not exist in the application**. This is NOT a deployment failure — the smoke test script was testing incorrect endpoint paths.

## Findings

### ✅ Working Endpoints

| Endpoint | Status | Notes |
|----------|--------|-------|
| `GET /api/health` | ✅ 200 | Database connected |
| `POST /api/auth/login` | ✅ 200 | All 4 demo accounts working |
| `GET /api/dashboard` | ✅ 200 | Data present |
| `GET /api/medicines` | ✅ 200 | Medicine list |
| `GET /api/expiry-alerts` | ✅ 200 | Expiry alerts present |
| `GET /api/mobile/devices` | ✅ 200 | Device list |
| `GET /api/qr/generate` | ✅ 200 | QR code generation |

### ❌ Non-Existent Endpoints (Tested but Never Implemented)

| Tested Path | Status | Actual Implementation |
|-------------|--------|----------------------|
| `GET /api/medicines/batches` | 404 | **Does not exist** - batches are accessed via `GET /api/medicines/:id/batches` |
| `GET /api/demand/forecast` | 404 | **Does not exist** - demand is at `GET /api/analytics/demand` |
| `GET /api/layout` | 404 | **Does not exist** - layout is at `GET /api/layout/shelves` |
| `GET /api/redistribution/near-expiry` | 404 | **Does not exist** - redistribution is triggered via `POST /api/inter-pharmacy/near-expiry/process` and retrieved via `GET /api/inter-pharmacy/requests` |
| `GET /api/requests` | 404 | **Does not exist** - requests are at `GET /api/inter-pharmacy/medicine-requests` |

## Correct Endpoint Mapping

### Batches
- ❌ `GET /api/medicines/batches` (does not exist)
- ✅ `GET /api/medicines/:id/batches` (actual route)
- **Example**: `GET /api/medicines/1/batches`

### Demand Forecast
- ❌ `GET /api/demand/forecast` (does not exist)
- ✅ `GET /api/analytics/demand` (actual route)

### Store Layout
- ❌ `GET /api/layout` (does not exist)
- ✅ `GET /api/layout/shelves` (actual route)

### Near-Expiry Redistribution
- ❌ `GET /api/redistribution/near-expiry` (does not exist)
- ✅ `POST /api/inter-pharmacy/near-expiry/process` (trigger scan)
- ✅ `GET /api/inter-pharmacy/requests?role=SENDER` (get outgoing requests)
- ✅ `GET /api/inter-pharmacy/requests?role=RECIPIENT` (get incoming requests)

### Medicine Requests
- ❌ `GET /api/requests` (does not exist)
- ✅ `GET /api/inter-pharmacy/medicine-requests` (own requests)
- ✅ `GET /api/inter-pharmacy/medicine-requests/incoming` (incoming requests)

## Authentication Results

All 4 demo accounts authenticate successfully:

| Email | Password | Role | Status |
|-------|----------|------|--------|
| `admin.a@mediindex.com` | `Demo@12345` | ADMIN | ✅ Working |
| `staff.a@mediindex.com` | `Demo@12345` | STAFF | ✅ Working |
| `admin.b@mediindex.com` | `Demo@12345` | ADMIN | ✅ Working |
| `staff.b@mediindex.com` | `Demo@12345` | STAFF | ✅ Working |

**Session Token**: Passed via `Set-Cookie` header as `mediindex_session` (HttpOnly, SameSite=Strict)

## Tenant Isolation

**Status**: ⚠️ Cannot verify with current smoke test script

**Reason**: Smoke test expects `/api/medicines` to return an array, but actual response is:
```json
{
  "medicines": [ /* array of medicine objects */ ]
}
```

The test script tries to access response as array directly instead of `response.medicines`.

## Demo Data Verification

**Seeded Data**:
- 2 pharmacies (A and B)
- 4 users (2 per pharmacy)
- 16 medicines
- 18 batches
- 7 historical sales
- 4 expiry alerts
- 1 redistribution request
- 1 medicine request with 1 offer

**Verification Status**: ⚠️ Smoke test cannot verify demo scenarios because tested endpoints don't exist.

## Android APK Configuration

### Current Status: ⚠️ BLOCKED

**Production URL**: `https://mediindex.vercel.app`

**Required Mobile Endpoints**:
- ✅ `POST /api/mobile/qr/lookup` (exists)
- ✅ `POST /api/mobile/stock-entry` (exists)
- ✅ `POST /api/mobile/stock-entry/batch-sync` (exists)
- ✅ `GET /api/mobile/devices` (exists)

**Blocker**: Android APK requires device pairing first.

**Device Pairing Process**:
1. Admin creates pairing code via web UI (not yet implemented in UI)
2. Mobile app scans/enters pairing code
3. Mobile app calls pairing endpoint (need to verify this endpoint exists)
4. Mobile app receives device token
5. Mobile app uses device token for all subsequent requests

**Missing from Verification**:
- Device pairing endpoint existence
- Device pairing workflow in web UI
- Mobile device token generation

## Production Readiness Assessment

### ✅ Core Infrastructure
- [x] Vercel deployment working
- [x] Neon PostgreSQL connected
- [x] Health check operational
- [x] Schema applied
- [x] Demo data seeded

### ✅ Authentication & Authorization
- [x] Login working for all 4 accounts
- [x] Session tokens via HttpOnly cookies
- [x] Role-based access control (ADMIN/STAFF)
- [ ] Tenant isolation verification (test script needs fix)

### ⚠️ API Endpoints
- [x] Core endpoints working (health, auth, dashboard, medicines, expiry-alerts)
- [x] Mobile endpoints exist (qr/lookup, stock-entry, batch-sync)
- [ ] Advanced endpoints not yet tested with correct paths
- [ ] Device pairing workflow needs verification

### ⚠️ B.Tech Presentation Readiness
- [x] Backend operational
- [x] Authentication working
- [x] QR generation working
- [ ] Need to verify all demo scenarios with correct endpoint paths
- [ ] Need to verify device pairing for Android APK
- [ ] Web UI needs verification (all features accessible)

## Recommendations

### 1. Update Smoke Test Script (PRIORITY: HIGH)
Create `scripts/production-smoke-test-v2.js` with correct endpoint paths:
- Use `/api/analytics/demand` instead of `/api/demand/forecast`
- Use `/api/layout/shelves` instead of `/api/layout`
- Use `/api/inter-pharmacy/*` endpoints instead of short paths
- Fix medicines response parsing to access `response.medicines` array

### 2. Verify Device Pairing (PRIORITY: HIGH)
- Check if device pairing endpoint exists in core.js
- Verify web UI has pairing code generation
- Test full mobile pairing workflow

### 3. Run Corrected Smoke Test (PRIORITY: HIGH)
Execute updated smoke test with correct paths to verify:
- Demand forecasting data
- Store layout with 14 shelves
- Near-expiry redistribution requests
- Medicine requests between pharmacies
- Tenant isolation with correct response parsing

### 4. Android APK Configuration (PRIORITY: MEDIUM)
After device pairing verification:
- Configure APK with `EXPO_PUBLIC_MOBILE_API_BASE_URL=https://mediindex.vercel.app`
- Test pairing flow
- Test QR scanning
- Test stock entry

### 5. Web UI Verification (PRIORITY: MEDIUM)
Manual testing of web interface:
- Dashboard displays correct data
- Medicine management works
- Batch management works
- Expiry alerts visible
- Sales creation works
- Inter-pharmacy features accessible

## Conclusion

**Production deployment is functional** but smoke test script has incorrect endpoint paths. The 404 errors are NOT deployment failures — they are testing endpoints that were never implemented with those exact paths.

**Next Actions**:
1. ✅ Document endpoint mapping (DONE - this document)
2. ⏳ Update smoke test script with correct paths
3. ⏳ Verify device pairing workflow
4. ⏳ Run corrected verification
5. ⏳ Configure Android APK after pairing verification

**Estimated Time to Production-Ready**: 1-2 hours (assuming device pairing exists)

---

**Generated**: 2026-09-19  
**Status**: Analysis Complete, Awaiting Corrected Verification
