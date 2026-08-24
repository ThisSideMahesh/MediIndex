# MediIndex Project Task List (TODO)

## Priority 0 (P0) — Core MVP Functionality (Critical)

- [x] **MOD-01 & MOD-02:** Node.js v22+ built-in HTTP server & SQLite initialization with schema constraints.
- [x] **MOD-03:** Scrypt password hashing, session cookies, and RBAC (`ADMIN` vs `STAFF`).
- [x] **MOD-04 & MOD-05:** Medicine catalog CRUD and multi-batch stock tracking.
- [x] **MOD-06:** Expiry classification (`EXPIRED`, `EXPIRING_SOON`, `SAFE`) and alert acknowledgment.
- [x] **MOD-07:** Atomic Point-of-Sale (POS) billing with FEFO stock deduction and rollback on insufficient stock.
- [x] **MOD-08:** Live dashboard metrics powered by direct database aggregation.
- [x] **P0 Automated Testing:** Unit and integration test suite covering auth, inventory, expiry, and billing.

---

## Priority 1 (P1) — Advanced Analytical & Operational Features

- [x] **MOD-09: Demand Forecasting Module:**
  - [x] Implement historical sales data aggregation endpoint (`/api/analytics/demand`).
  - [x] Implement 3-period Weighted Moving Average (WMA: $w_1=0.50, w_2=0.30, w_3=0.20$) for 30-day replenishment recommendations.
  - [x] Add statistical safety stock calculation at 95% service level ($Z = 1.65$).
  - [x] Add hard reliability guardrail (`"INSUFFICIENT DATA FOR RELIABLE FORECAST"`) when periods < 3.
  - [x] Add automated test suite for WMA and edge cases (`tests/demand.test.js`).
- [x] **MOD-10: QR Code Identification & Scanning Module:**
  - [x] Implement versioned QR payload specification (`{"app":"MEDIINDEX","v":1,"medicineId":...,"batchNumber":...}`).
  - [x] Built pure zero-dependency ISO/IEC 18004 SVG QR generator for printable pharmacy stickers (`public/qr-generator.js`).
  - [x] Implement authoritative database lookup endpoint (`POST /api/qr/lookup`).
  - [x] Build camera stream scanner + manual payload input fallback on POS and Inventory views.
  - [x] Add automated test suite covering security rejection, format parsing, and database verification (`tests/qr.test.js`).
- [x] **Sales History & Invoicing:**
  - [x] Add searchable invoice history with customer and payment filtering.
  - [x] Add printable/downloadable invoice receipt layout.

---

## Priority 2 (P2) — Enhancements & Visual Tooling

- [ ] **MOD-11: 2D Store & Shelf Map:**
  - [ ] Interactive 2D rack visualizer highlighting medicine shelf locations.
- [ ] **Low-Stock Notification Center:**
  - [ ] Dedicated view for reorder lists based on minimum stock and predicted runout dates.

---

## Priority 3 (P3) — Academic Deliverables & Packaging

- [ ] **Academic Documentation:**
  - [ ] Prepare Major Project-II Report adhering to MIT CS guidelines (10+ verified IEEE citations, strict formatting).
  - [ ] Generate standard architecture, ER, DFD Level 0/1, and sequence diagrams.
- [ ] **Presentation & Viva Prep:**
  - [ ] Final viva voce question-and-answer defense guide (`VIVA_PREP.md`).
  - [ ] Professional presentation slides outline (`PRESENTATION.md`).
- [ ] **Optional Desktop Packaging:**
  - [ ] Package as standalone desktop binary using Electron or Node standalone executable.
