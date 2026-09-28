# MediIndex — Intelligent Pharmacy Inventory & Expiry Management Platform

**Academic Project:** B.Tech Computer Science & Engineering (Final Year / Major Project-II / PRO423)  
**Institution:** Maharashtra Institute of Technology, Chhatrapati Sambhajinagar  
**Classification:** Applied Software System / Healthcare Management & Inventory Optimization  
**GitHub Repository:** [https://github.com/ThisSideMahesh/MediIndex](https://github.com/ThisSideMahesh/MediIndex)

---

## 1. Project Overview

**MediIndex** is a lightweight, zero-dependency, offline-ready medical store management system designed for small and medium independent retail pharmacies. It eliminates stockouts, overstocking, and drug expiration on pharmacy shelves through:

1. **Multi-Batch Inventory Tracking:** Detailed management of medicine batches, lot numbers, purchase/selling prices, manufacturing/expiry dates, and physical shelf locations.
2. **Automated Expiry Classification & Alerts:** Dynamic categorization of all lots into `EXPIRED`, `EXPIRING_SOON` (<= 30 days), and `SAFE` with acknowledged status tracking.
3. **Point-of-Sale (POS) & FEFO Dispensing:** Transactional billing with First-Expired, First-Out (FEFO) automated allocation, explicit batch overrides, atomic stock reduction, and printable invoice receipts.
4. **Audit Trail Logging:** Every stock receipt, manual inventory adjustment, and sale is recorded in `inventory_movements` with cashier traceability.
5. **Role-Based Access Control (RBAC):** Built-in security with `ADMIN` and `STAFF` roles, salted Scrypt password hashing, and HttpOnly session cookies.

---

## 2. Technical Stack

- **Runtime Environment:** Node.js (v22+) — Built-in native APIs only (`node:http`, `node:sqlite`, `node:crypto`, `node:fs`).
- **Database Engine:** Embedded SQLite (`data/mediindex.db`) with active foreign key constraints (`PRAGMA foreign_keys = ON;`) and multi-statement ACID transactions.
- **Frontend Architecture:** Semantic HTML5, Responsive CSS3 Grid/Flexbox with print media styles, and Vanilla JavaScript ES6+. Zero build steps, zero node_modules bloat, instant execution.
- **Test Harness:** Node.js native test runner (`node:test`, `node:assert/strict`).

---

## 3. Quick Start & Execution

### Prerequisites
- Node.js version 22.0.0 or higher.
- No external npm packages are needed (`npm install` is not required).

### Running the Application Locally
```bash
# Start the production server
node server.js

# Or start in watch mode for development
npm run dev
```
Open your browser and navigate to: **`http://127.0.0.1:3000`**

### Running the Automated Test Suite
```bash
npm test
```
All 7 unit and integration tests will execute in-process via `node:test`.

---

## 4. Default Demo Accounts

For local evaluation and viva demonstration, deterministic demo accounts are pre-seeded:

| Role | Email Address | Password | Permissions |
|---|---|---|---|
| **Administrator** | `admin.a@mediindex.com` & 'admin.b@mediindex.com' | `Demo@12345` | Full access: master catalogue CRUD, batch stock, POS billing, expiry alerts, adjustments |
| **Pharmacy Staff** | `staff.a@mediindex.com` | `Demo@12345` | Operational access: batch stock receipt, POS billing, expiry inspection, search |

---

## 5. Documentation Map

- [PROJECT_STATE.md](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/PROJECT_STATE.md): Current phase, verified modules, active milestones.
- [MODULE_STATUS.md](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/MODULE_STATUS.md): Complete module status matrix and verification evidence.
- [ARCHITECTURE.md](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/ARCHITECTURE.md): System architecture, component boundaries, and trust model.
- [DATABASE_SCHEMA.md](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/DATABASE_SCHEMA.md): Complete relational entity models, fields, and constraints.
- [API_SPEC.md](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/API_SPEC.md): REST endpoint contracts and sample JSON payloads.
- [TEST_RESULTS.md](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/TEST_RESULTS.md): Executed test matrix and validation evidence.
- [DECISIONS.md](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/DECISIONS.md): Architectural decisions and rationale.
- [TODO.md](file:///Users/thisside_mahesh/Projects/MediIndex%20-%20code/MediIndex/TODO.md): Roadmap prioritized by P0, P1, P2, and P3 milestones.
