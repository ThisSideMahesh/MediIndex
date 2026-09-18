# MediIndex — Requirements Traceability Matrix (RTM)
## Complete Academic Traceability from Project-I Specification to Phase 4 Baseline & Final Defense

**Project:** MediIndex – Pharmacy Insights, POS & Analytics  
**Document Code:** RTM-MAJOR-PROJECT-II  
**Status:** COMPREHENSIVE REQUIREMENTS TRACEABILITY MATRIX  

---

## 1. Master Requirements Traceability Table

| Req # | Project-I Requirement | Current Module | Current Status | Missing Implementation / Work Remaining | Proposed Future Module | Verification Method |
|---|---|---|---|---|---|---|
| **REQ-01** | Medicine Master Catalogue | MOD-03 Catalogue | **IMPLEMENTED & VERIFIED** | None. Full CRUD, active flags, category/dosage tracking complete. | None (Core Complete) | Automated tests (`INV-001`) |
| **REQ-02** | Multi-Batch Inventory Management | MOD-04 Inventory | **IMPLEMENTED & VERIFIED** | None. Multiple lots per medicine with individual costs, selling prices, and expiries. | None (Core Complete) | Automated tests (`INV-001`, `POS-001`) |
| **REQ-03** | Inventory Movement / Audit Logging | MOD-05 Audit Log | **IMPLEMENTED & VERIFIED** | None. Immutable ledger logging `RECEIPT`, `ADJUSTMENT`, `SALE` with user and device attribution. | None (Core Complete) | Automated tests (`MOB-STOCK-004`, `POS-001`) |
| **REQ-04** | Expiry Monitoring & Alerts | MOD-06 Expiry | **IMPLEMENTED & VERIFIED** | None. Real-time categorization into `EXPIRED`, `EXPIRING_SOON` (<30 days), and `LOW_STOCK`. | None (Core Complete) | Automated tests (`EXP-001`) |
| **REQ-05** | Billing / Point-of-Sale (POS) | MOD-07 POS | **IMPLEMENTED & VERIFIED** | Offline emergency invoice sequence caching for PWA. | Phase 4/7 Frontend Integration | Automated tests (`POS-001`, `POS-002`) |
| **REQ-06** | FEFO (First-Expired, First-Out) Deduction | MOD-07 FEFO Engine | **IMPLEMENTED & VERIFIED** | None. Strict mathematical sorting by `expiry_date ASC` across multiple lots with atomic rollback. | None (Core Complete) | Automated tests (`POS-001`, `POS-002`) |
| **REQ-07** | QR-based Medicine/Batch Identification | MOD-08 QR Engine | **IMPLEMENTED & VERIFIED** | Mobile camera scanning UI component. | Phase 7 Mobile Frontend UI | Automated tests (`QR-001` to `QR-004`, `MOB-STOCK-006`) |
| **REQ-08** | Demand Forecasting (WMA) | MOD-09 Demand Analytics | **IMPLEMENTED & VERIFIED** | None. Mathematically verified Weighted Moving Average with weights $(0.5, 0.3, 0.2)$. | None (Core Complete) | Automated tests (`DEM-001` to `DEM-003`) |
| **REQ-09** | Safety Stock & Reorder Levels | MOD-09 Reorder Math | **IMPLEMENTED & VERIFIED** | None. Calculated from historical standard deviation $\sigma$ and supplier lead time formulas. | None (Core Complete) | Automated tests (`DEM-003`) |
| **REQ-10** | Pharmacy Business Analytics | MOD-10 Analytics | **IMPLEMENTED & VERIFIED** | None. Revenue charts, low-stock summaries, and expiry breakdowns in dashboard. | None (Core Complete) | Automated tests & Dashboard E2E |
| **REQ-11** | 2D Store / Shelf Layout Locator | MOD-11 Shelf Locator | **IMPLEMENTED & VERIFIED** | Interactive visual SVG grid rendering in mobile stock entry view. | Phase 7 Mobile View | Automated tests (`LAY-001` to `LAY-003`) |
| **REQ-12** | Mobile Device One-Time Pairing | MOD-14 Mobile Pairing | **IMPLEMENTED & VERIFIED** | None. Admin 6-char OTP generation, 256-bit token issuance, and hardware revocation. | None (Core Complete) | Automated tests (`MOB-001` to `MOB-004`) |
| **REQ-13** | Mobile Stock-Entry Backend API Pipeline | MOD-15 Stock Entry API | **IMPLEMENTED & VERIFIED** | Mobile camera client & offline outbox sync endpoint. | Phase 4 Sync & Phase 7 UI | Automated tests (`MOB-STOCK-001` to `MOB-STOCK-011`) |
| **REQ-14** | Offline Operation & Reconnection Sync | MOD-16 Offline Sync | **PARTIALLY IMPLEMENTED (Server Sync Verified)** | **Server-side sync API:** IMPLEMENTED & VERIFIED (`/api/mobile/stock-entry/batch-sync`, tests `SYNC-001` to `SYNC-015`).<br>**Mobile client offline queue (IndexedDB):** NOT IMPLEMENTED / PLANNED. | Phase 7 Mobile Outbox UI | Automated sync tests (`SYNC-001` to `SYNC-015`) |
| **REQ-15** | Cloud Deployment & Serverless Persistence | MOD-17 Cloud Adapter | **IN DEVELOPMENT / DESIGNED & AUDITED** | Phase 5A Foundation Complete (Dual adapters + PostgreSQL schema mapping + 8 adapter tests). Cloud Session Migration & Live Vercel verification scheduled for Phase 5B/5C. | Phase 5 Cloud Persistence | Adapter tests (`ADAPTER-001` to `ADAPTER-008`), Vercel preview deployment tests & CI database tests |
| **REQ-16** | Inter-Pharmacy Federated Network | MOD-12 Inter-Pharmacy | **DESIGNED & AUDITED** | Connection handshake tables, discovery search API, and transfer request routing. | Phase 6 Inter-Pharmacy Network | Cross-tenant network search & transfer tests |

---

## 2. Status Summary of Requirements

- **Fully Implemented & Verified in Codebase (55/55 Tests):**
  - Core Pharmacy Catalogue & Inventory (REQ-01, REQ-02, REQ-03, REQ-04)
  - Sales & Mathematical Algorithms (REQ-05, REQ-06, REQ-08, REQ-09, REQ-10)
  - Physical Store Spatial Management (REQ-11)
  - QR Code System & Mobile Backend API (REQ-07, REQ-12, REQ-13)
  - Server-Side Batch Synchronization Engine (REQ-14 Server Protocol / MOD-16)
  - Database Persistence Adapter Foundation (REQ-15 Phase 5A / MOD-17)
- **Formally Audited & Architecture-Designed (Ready for Phased Execution):**
  - Mobile Local Offline Queue & PWA Camera Scanner (REQ-14 Client Outbox / Phase 7)
  - Cloud Session Store Migration & Live Vercel Integration (REQ-15 Phase 5B/5C)
  - Inter-Pharmacy Medicine Sharing Network (REQ-16 / Phase 6)
- **Permanently Deferred Requirements:** **NONE**. All Project-I promised requirements are actively tracked with clear architectural paths to completion.
