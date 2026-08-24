# MediIndex Project State

**Project Name:** MEDIINDEX — Intelligent Pharmacy Inventory & Expiry Management Platform  
**Academic Context:** B.Tech Computer Science & Engineering (PRO423 — Major Project-II), Maharashtra Institute of Technology, Chhatrapati Sambhajinagar  
**Last Updated:** August 2026  
**Primary Repository:** [https://github.com/ThisSideMahesh/MediIndex](https://github.com/ThisSideMahesh/MediIndex)

---

## 1. Project Overview & Current Phase

- **Current Phase:** Phase 3 — Advanced Analytics & Operational Modules Complete.
- **Core Architecture:** Offline-first, Zero-dependency Node.js runtime (v22+) + SQLite local transactional database (WAL mode) + Semantic HTML5/CSS3/Vanilla JS single-page client.
- **Academic Classification:** Applied Computer Science / Healthcare Information Systems / Software Product Development.

---

## 2. Verified Implementation Status

| Feature / Module | Verification Standard | Current State |
|---|---|---|
| **Zero-dependency Runtime** | Node.js built-ins (`node:sqlite`, `node:crypto`, `node:http`) | IMPLEMENTED / VERIFIED |
| **Authentication & RBAC** | Scrypt salt+hash, 6-hour HttpOnly/SameSite session cookies, ADMIN & STAFF roles | IMPLEMENTED / VERIFIED |
| **Medicine Management** | Master catalogue CRUD, generic name, manufacturer, minimum stock tracking | IMPLEMENTED / VERIFIED |
| **Batch Management** | Multi-batch per medicine, lot numbers, purchase/selling price, manufacturing/expiry dates, shelf locations | IMPLEMENTED / VERIFIED |
| **Expiry Monitoring** | Dynamic batch-level expiry calculation (`EXPIRED`, `EXPIRING_SOON`, `SAFE`), persistent alert table, acknowledge workflow | IMPLEMENTED / VERIFIED |
| **Inventory Movements** | Audit trail recording all stock receipts, sales, and manual adjustments | IMPLEMENTED / VERIFIED |
| **Dashboard Metrics** | Real-time SQL aggregation for total medicines, total stock, expired batches, near-expiry, low-stock count, today's sales | IMPLEMENTED / VERIFIED |
| **Billing & Transactions (POS)** | Atomic multi-item checkout, FEFO/manual batch dispensing, stock deduction, rollback protection, receipt view | IMPLEMENTED / VERIFIED |
| **Demand Forecasting (WMA)** | 3-period Weighted Moving Average ($w_1=0.50, w_2=0.30, w_3=0.20$), 95% service safety stock, hard "INSUFFICIENT DATA" guardrail | IMPLEMENTED / VERIFIED |
| **QR Code Identification** | Versioned QR payload, pure SVG sticker generator, authoritative database resolution, webcam scanner & manual fallback | IMPLEMENTED / VERIFIED |

---

## 3. In Progress (Next Phases)

- **P2: 2D Store & Shelf Map (MOD-11):** Interactive visual rack and shelf locator.
- **P3: Academic Major Project Report & Viva Preparation:** Final B.Tech documentation and examiner defense preparation.

---

## 4. Deferred / Future Scope (P3)

- **Cloud Backup & Inter-Pharmacy Network (MOD-12):** Multi-store sync protocol (Deferred to preserve offline-first stability).
- **Electron / Desktop Packaging (MOD-13):** Single executable distribution bundle (Post-MVP packaging).

---

## 5. Active Known Issues & Mitigations

- **Test Concurrency:** Test runner executes sequentially with `--test-concurrency=1` to allow clean SQLite database access during in-process tests.
- **Data Integrity:** Strict SQL constraints (`CHECK(quantity >= 0)`), SQLite Write-Ahead Logging (`PRAGMA journal_mode = WAL`), and database-level transactions ensure zero inventory drift.
