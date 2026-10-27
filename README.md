# MediIndex – Pharmacy Insights and Analytics

**B.Tech Major Project-II | Computer Science & Engineering**
**Maharashtra Institute of Technology, Chhatrapati Sambhajinagar**
**Course Code:** PRO423

MediIndex is a full-stack pharmacy inventory management and analytics system built for small and medium independent retail pharmacies. It addresses the operational problems of manual stock tracking, undetected drug expiry, inefficient dispensing, and limited demand visibility by providing:

- A **web application** for inventory, billing, expiry tracking, and analytics
- A **REST API backend** on Node.js with dual database support (SQLite locally, PostgreSQL in production)
- A **React Native mobile app** (Android APK) for QR-based stock entry and offline synchronization
- **Inter-pharmacy collaboration** tools for stock redistribution and medicine requests

> **Live application:** [https://mediindex.vercel.app](https://mediindex.vercel.app)
> **Source code:** [https://github.com/ThisSideMahesh/MediIndex](https://github.com/ThisSideMahesh/MediIndex)

---

## Table of Contents

1. [Live Demo and Access](#1-live-demo-and-access)
2. [Features](#2-features)
3. [Technology Stack](#3-technology-stack)
4. [Architecture](#4-architecture)
5. [Screenshots](#5-screenshots)
6. [Local Installation and Setup](#6-local-installation-and-setup)
7. [API Overview](#7-api-overview)
8. [Testing](#8-testing)
9. [Deployment](#9-deployment)
10. [Repository Structure](#10-repository-structure)
11. [Limitations and Future Enhancements](#11-limitations-and-future-enhancements)
12. [License](#12-license)
13. [Acknowledgements](#13-acknowledgements)

---

## 1. Live Demo and Access

| | |
|---|---|
| **Live website** | [https://mediindex.vercel.app](https://mediindex.vercel.app) |
| **GitHub repository** | [https://github.com/ThisSideMahesh/MediIndex](https://github.com/ThisSideMahesh/MediIndex) |
| **Production branch** | `main` |

The live application requires valid login credentials to access any protected area. Use the demo accounts below.

### Demo Accounts

These are designated demonstration accounts seeded into the production database for project evaluation and presentation. They are not personal accounts.

| Role | Pharmacy A | Pharmacy B |
|---|---|---|
| **Admin** | `admin.a@mediindex.com` | `admin.b@mediindex.com` |
| **Staff** | `staff.a@mediindex.com` | `staff.b@mediindex.com` |
| **Password** | `Demo@12345` | `Demo@12345` |

- **Pharmacy A** — MediIndex Pharmacy A, Shivaji Nagar, Pune
- **Pharmacy B** — MediIndex Pharmacy B, Kothrud, Pune (~5.2 km apart, within inter-pharmacy request range)

> These credentials are valid only while the corresponding demo accounts remain active in the production database. Their live validity has not been independently re-verified at the time of the most recent commit.

**→ [Log in at https://mediindex.vercel.app](https://mediindex.vercel.app)**

---

## 2. Features

### Core Inventory Management

| Feature | Status |
|---|---|
| Medicine catalogue (add, edit, soft-delete, reactivate) | ✅ Implemented |
| Multi-batch stock tracking per medicine | ✅ Implemented |
| Batch attributes: lot number, purchase/selling price, manufacturing date, expiry date, shelf location | ✅ Implemented |
| Inventory stock receipts and manual adjustments with audit trail | ✅ Implemented |
| Minimum stock threshold configuration | ✅ Implemented |

### Expiry Monitoring

| Feature | Status |
|---|---|
| Automatic expiry classification: `EXPIRED`, `EXPIRING_SOON` (≤ 30 days), `SAFE` | ✅ Implemented |
| Persistent expiry alerts with per-alert acknowledgment | ✅ Implemented |
| Dashboard expiry summary | ✅ Implemented |

### Billing and Point of Sale

| Feature | Status |
|---|---|
| Multi-item checkout with customer and payment method | ✅ Implemented |
| FEFO (First Expiry, First Out) automatic batch selection | ✅ Implemented |
| Manual batch override at POS | ✅ Implemented |
| Atomic stock deduction with rollback on insufficient stock | ✅ Implemented |
| Printable invoice receipt | ✅ Implemented |
| Searchable sales history | ✅ Implemented |

### Demand Forecasting

| Feature | Status |
|---|---|
| 3-period **Weighted Moving Average** (WMA) forecasting | ✅ Implemented |
| Weights: w₁ = 0.50 (most recent), w₂ = 0.30, w₃ = 0.20 | ✅ Implemented |
| 30-day replenishment quantity estimate | ✅ Implemented |
| Safety stock at 95% service level (Z = 1.65) | ✅ Implemented |
| Hard guardrail: "INSUFFICIENT DATA" when fewer than 3 periods available | ✅ Implemented |

> The forecasting engine is a **statistical time-series method (Weighted Moving Average)**, not machine learning or AI.

### QR Code Functionality

| Feature | Status |
|---|---|
| Per-batch QR code generation (versioned payload, SVG output) | ✅ Implemented |
| QR lookup by payload: returns medicine and batch details | ✅ Implemented |
| Camera-based QR scanner in the web app | ✅ Implemented |
| Manual payload fallback input | ✅ Implemented |

### Store Map and Shelf Relocation

| Feature | Status |
|---|---|
| 2D interactive floor plan with 14 standard shelf bays | ✅ Implemented |
| Shelf occupancy and batch count per bay | ✅ Implemented |
| Batch shelf relocation dialog with map-based selection | ✅ Implemented |

### Inter-Pharmacy Collaboration

| Feature | Status |
|---|---|
| Automatic near-expiry redistribution request generation | ✅ Implemented |
| Manual medicine shortage requests between pharmacies | ✅ Implemented |
| Offer and partial-cover workflow | ✅ Implemented |
| Request status transitions (PENDING → ACCEPTED → COMPLETED / CANCELLED) | ✅ Implemented |

### Role-Based Access Control

| Role | Capabilities |
|---|---|
| **ADMIN** | Full access: catalogue CRUD, batch management, POS, expiry alerts, demand forecasting, store map, inter-pharmacy, device management |
| **STAFF** | Operational access: stock receipts, POS billing, expiry inspection, search |

Sessions are secured with `HttpOnly; SameSite=Strict` cookies and Scrypt password hashing. Tenant isolation enforces that each pharmacy sees only its own data.

### Mobile Application

| Feature | Status |
|---|---|
| React Native + Expo Android app (package: `com.mediindex.stockentry`) | ✅ Implemented |
| Admin-generated one-time device pairing (10-minute PIN, 256-bit token) | ✅ Implemented |
| QR scan → stock receipt (single item, device-authenticated) | ✅ Implemented |
| Batch offline sync: multiple operations submitted together | ✅ Implemented |
| Server-side idempotency deduplication (prevents duplicate stock entries) | ✅ Implemented |
| Hardware device revocation by admin | ✅ Implemented |

---

## 3. Technology Stack

### Web Application

| Layer | Technology |
|---|---|
| **Frontend** | HTML5, CSS3 (Grid/Flexbox), Vanilla JavaScript ES6+ — zero build step |
| **Backend runtime** | Node.js ≥ 22 using built-in `node:http`, `node:crypto`, `node:fs` |
| **Local database** | SQLite via `node:sqlite` (built-in, zero external dependency) |
| **Production database** | PostgreSQL (Neon serverless) via `pg` driver |
| **Authentication** | Scrypt password hashing, DB-backed session store, HttpOnly cookies |
| **QR engine** | Custom zero-dependency ISO/IEC 18004 SVG generator |
| **Deployment** | Vercel (serverless, via `api/index.js` entrypoint) |

### Mobile Application

| Layer | Technology |
|---|---|
| **Framework** | React Native 0.86 + Expo ~57 |
| **Language** | TypeScript |
| **Navigation** | React Navigation 7 (native stack) |
| **Camera** | `expo-camera` |
| **Secure storage** | `expo-secure-store` |
| **Local DB** | `expo-sqlite` |
| **Network detection** | `@react-native-community/netinfo` |
| **Target platform** | Android (APK: `com.mediindex.stockentry`) |

### Backend Dependencies

```json
"dependencies": {
  "jsdom":   "^30.1.1",   // DOM emulation for server-side tests
  "pg":      "8.13.3",    // PostgreSQL client
  "pngjs":   "^7.0.0",    // PNG processing for QR output
  "qrcode":  "^1.5.4"     // QR code generation helper
}
```

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────┐
│               Web Browser / Mobile App                   │
│  HTML5 + CSS3 + Vanilla JS  │  React Native + Expo       │
└─────────────────┬────────────────────────┬───────────────┘
                  │ HTTP/JSON + Cookies     │ HTTP/JSON + Device Token
┌─────────────────▼────────────────────────▼───────────────┐
│               MediIndex Application Server               │
│           Node.js ≥ 22  ·  core.js / api/index.js        │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────────────┐│
│  │ Auth & RBAC  │ │  FEFO POS  │ │ WMA Demand Forecast  ││
│  │ Scrypt+Sess. │ │  Engine    │ │ (Statistical)        ││
│  └──────────────┘ └────────────┘ └──────────────────────┘│
│  ┌──────────────┐ ┌────────────┐ ┌──────────────────────┐│
│  │ QR Engine    │ │ Store Map  │ │ Inter-Pharmacy API   ││
│  │ ISO/IEC18004 │ │ 14 Bays   │ │ Redistribution       ││
│  └──────────────┘ └────────────┘ └──────────────────────┘│
└─────────────────┬────────────────────────────────────────┘
                  │ Database Adapter (auto-selected)
        ┌─────────┴──────────┐
        │                    │
┌───────▼──────┐    ┌────────▼──────────┐
│  SQLiteAdapter│    │ PostgreSQLAdapter  │
│  (local dev)  │    │ (Vercel/Neon prod) │
│  data/        │    │  DATABASE_URL env  │
│  mediindex.db │    │                   │
└──────────────┘    └───────────────────┘
```

**Adapter selection** is automatic:
- `DATABASE_URL` **not set** → `SQLiteAdapter` (local `data/mediindex.db`)
- `DATABASE_URL` **set** → `PostgreSQLAdapter` (Neon PostgreSQL)

**Vercel deployment**: All requests are rewritten to `api/index.js`, which is the serverless entrypoint that loads `core.js`.

---

## 5. Screenshots

No UI screenshots are currently committed to the repository. To add them:

1. Take screenshots of key views (Dashboard, Inventory, Billing, Store Map, Expiry Alerts, Demand Forecast)
2. Save them to `docs/screenshots/` (create the directory)
3. Reference them in this README using relative paths, for example:

```markdown
![Dashboard](docs/screenshots/dashboard.png)
![Billing POS](docs/screenshots/billing.png)
![Store Map](docs/screenshots/store-map.png)
```

The project logo is available at `public/assets/mediindex-logo.png`.

---

## 6. Local Installation and Setup

### Prerequisites

- **Node.js ≥ 22.0.0** — [nodejs.org](https://nodejs.org/)
- **npm** (bundled with Node.js)
- **Git**

Verify your Node.js version:

```bash
node --version   # must be v22.0.0 or higher
```

### Clone the repository

```bash
git clone https://github.com/ThisSideMahesh/MediIndex.git
cd MediIndex
```

### Install dependencies

```bash
npm install
```

### Environment configuration

Copy the example environment file:

```bash
cp .env.example .env
```

For **local SQLite development**, no further changes are needed — leave `DATABASE_URL` unset.

For **PostgreSQL** (production or staging), set:

```bash
# .env  — never commit real values
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>
```

The backend automatically selects the correct adapter based on whether `DATABASE_URL` is set.

### Database initialization

**SQLite (local):** The database file (`data/mediindex.db`) is created and the schema is applied automatically on first startup. No manual migration step is required.

**PostgreSQL:** Run the bootstrap script to create all tables:

```bash
node scripts/bootstrap-postgres.js
```

> Requires `DATABASE_URL` to be set.

### Start the backend

```bash
# Production mode
npm start           # runs: node core.js

# Development mode (auto-restarts on file changes)
npm run dev         # runs: node --watch core.js
```

The server starts on **http://localhost:3000** by default.

### Using the application

Open [http://localhost:3000](http://localhost:3000) in your browser.

For local development, you will need to create a pharmacy and user account, or seed the database manually using the seed script with a local DATABASE_URL:

```bash
node scripts/seed-production-demo.js
```

After seeding, log in with one of the demo accounts listed in [Section 1](#1-live-demo-and-access).

### Mobile application setup

The mobile app is in the `mobile/` directory and uses Expo.

```bash
cd mobile
npm install

# Start Expo development server
npm start               # expo start

# Run on Android emulator or connected device
npm run android         # expo run:android
```

**Device pairing for stock entry:**
1. Log in to the web app as **ADMIN**
2. Go to **Mobile Devices** → Generate a pairing PIN
3. Enter the PIN in the mobile app within 10 minutes
4. The device is now registered and can submit stock entries

---

## 7. API Overview

The backend exposes a JSON REST API. All protected endpoints require a valid session cookie obtained from `POST /api/auth/login`. Mobile endpoints use a device token header instead.

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Log in with email and password |
| `POST` | `/api/auth/logout` | Invalidate the current session |
| `GET` | `/api/auth/me` | Return the currently authenticated user |

### Core Inventory

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/medicines` | List medicines (with optional search) |
| `POST` | `/api/medicines` | Create a new medicine (ADMIN) |
| `PUT` | `/api/medicines/:id` | Update a medicine (ADMIN) |
| `DELETE` | `/api/medicines/:id` | Soft-delete a medicine (ADMIN) |
| `POST` | `/api/medicines/:id/reactivate` | Restore a soft-deleted medicine (ADMIN) |
| `GET` | `/api/medicines/:id/batches` | List batches for a medicine |
| `POST` | `/api/medicines/:id/batches` | Add a new batch (stock receipt) |
| `POST` | `/api/batches/:id/adjustments` | Manual stock adjustment |
| `PUT` | `/api/batches/:id/location` | Update shelf location for a batch |
| `GET` | `/api/batches/:id/qr` | Generate QR code for a batch |

### Expiry and Alerts

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/expiry-alerts` | List expiry alerts for the pharmacy |
| `POST` | `/api/expiry-alerts/:id/acknowledge` | Acknowledge an alert |

### Billing and Sales

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/sales` | Create a sale (checkout) |
| `GET` | `/api/sales` | List sales history (with search) |
| `GET` | `/api/sales/:id` | Get sale details and line items |

### Analytics and Layout

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/dashboard` | Dashboard summary metrics |
| `GET` | `/api/analytics/demand` | Demand forecast (WMA) for all medicines |
| `GET` | `/api/layout/shelves` | Store map with all 14 shelf bays and stock data |

### QR Codes

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/qr/generate?payload=...` | Generate a QR code SVG (no auth) |
| `POST` | `/api/qr/lookup` | Resolve a QR payload to medicine/batch details |

### Inter-Pharmacy

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/inter-pharmacy/near-expiry/process` | Trigger near-expiry redistribution scan (ADMIN) |
| `GET` | `/api/inter-pharmacy/requests` | List redistribution requests |
| `POST` | `/api/inter-pharmacy/requests/:id/status` | Update request status (ADMIN) |
| `GET` | `/api/inter-pharmacy/medicine-requests/incoming` | List incoming medicine requests |

### Mobile Device API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/mobile/pairing/create` | Generate a pairing PIN (ADMIN) |
| `POST` | `/api/mobile/pairing/complete` | Claim a PIN and receive a device token |
| `GET` | `/api/mobile/devices` | List paired devices (ADMIN) |
| `POST` | `/api/mobile/devices/:id/revoke` | Revoke a device (ADMIN) |
| `GET` | `/api/mobile/auth/verify` | Verify device token validity |
| `POST` | `/api/mobile/stock-entry` | Submit a single QR stock entry |
| `POST` | `/api/mobile/stock-entry/batch-sync` | Submit multiple operations in one request |
| `POST` | `/api/mobile/qr/lookup` | Resolve a QR payload (device-authenticated) |

### Sync

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/sync/stock-receipt` | Idempotent stock receipt sync (session-authenticated) |

### Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check — performs a live database query |

---

## 8. Testing

### Running the test suite

```bash
npm test
```

This runs all test files in `tests/` using Node.js's built-in test runner:

```
node --test --test-concurrency=1 tests/*.test.js
```

### Test coverage areas

The suite covers 29 test files including:

| Test file | Area |
|---|---|
| `auth.test.js` | Login, logout, session management, RBAC |
| `sessions.test.js` | DB-backed session store |
| `sales.test.js` | POS checkout, FEFO, rollback |
| `demand.test.js` | WMA forecasting, safety stock, edge cases |
| `qr.test.js` | QR payload validation and database lookup |
| `layout.test.js` | Store map and shelf data |
| `batch-relocation.test.js` | Shelf location updates |
| `map-loading.test.js` | Relocation map rendering (jsdom) |
| `css-variables.test.js` | CSS variable correctness |
| `relocate-map-rendering.test.js` | DOM rendering regression tests |
| `inter-pharmacy.test.js` | Redistribution and request workflows |
| `mobile-pairing.test.js` | Device pairing and revocation |
| `mobile-stock-entry.test.js` | QR stock entry, idempotency |
| `offline-sync.test.js` | Batch sync, conflict handling |
| `adapters.test.js` | SQLite / PostgreSQL adapter selection |
| `postgres-integration.test.js` | PostgreSQL adapter integration |
| *(+ 13 more files)* | Auth hardening, medicine requests, QR decode, etc. |

### Known test status

The most recent full run produced:

```
tests: 569  |  pass: 410  |  fail: 1  |  skip: 158
```

- **1 pre-existing failure:** `mobile-pairing.test.js` — SQLite UNIQUE constraint on `users.email` caused by test execution order. This failure is unrelated to core functionality and exists before any recent changes.
- **158 skipped:** PostgreSQL integration tests skipped when `POSTGRES_TEST_URL` is not set in the environment.

To run PostgreSQL integration tests, set:

```bash
export POSTGRES_TEST_URL=postgresql://<user>:<pass>@<host>:5432/<testdb>
npm test
```

> Use a **dedicated test database**, never the production database.

---

## 9. Deployment

The application is deployed to **Vercel** as a serverless function.

### How it works

1. All HTTP requests are rewritten to `api/index.js` (configured in `vercel.json`)
2. `api/index.js` is the Vercel-compatible entrypoint that loads `core.js`
3. When `DATABASE_URL` is set in the Vercel environment, the app uses `PostgreSQLAdapter` (Neon)
4. Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, X-XSS-Protection) are set by `vercel.json`

### Required environment variables

Configure these in the Vercel project dashboard under **Settings → Environment Variables**:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Neon or compatible) |
| `NODE_ENV` | Set by Vercel | Automatically set to `production` via `vercel.json` |

> **Never commit `DATABASE_URL` or any database credentials to Git.**

### Deploying

```bash
# Install Vercel CLI if not already installed
npm install -g vercel

# Deploy to production
vercel --prod
```

Or connect the GitHub repository to a Vercel project for automatic deployments on push to `main`.

### Live deployment

**[https://mediindex.vercel.app](https://mediindex.vercel.app)**

---

## 10. Repository Structure

```
MediIndex/
├── api/
│   └── index.js              # Vercel serverless entrypoint
├── core.js                   # Main application: HTTP server, all routes, business logic
├── public/
│   ├── index.html            # Single-page web application shell
│   ├── app.js                # Client-side JavaScript (all UI logic)
│   ├── styles.css            # Responsive CSS (Grid/Flexbox)
│   ├── sync.js               # Client-side sync utilities
│   └── assets/
│       └── mediindex-logo.png
├── mobile/                   # React Native + Expo mobile application
│   ├── App.tsx               # App entry point and navigation
│   ├── app.json              # Expo configuration
│   ├── package.json          # Mobile dependencies
│   ├── assets/               # App icons and splash screen
│   ├── android/              # Android build output (includes release APK)
│   └── tests/                # Mobile-specific test suite
├── tests/                    # Backend test suite (29 files)
├── scripts/
│   ├── seed-production-demo.js   # Seeds demo data into production PostgreSQL
│   ├── verify-demo-setup.js      # Verifies all demo accounts are accessible
│   └── bootstrap-postgres.js     # Creates PostgreSQL schema
├── data/                     # SQLite database directory (local only, git-ignored)
├── .env.example              # Environment variable template
├── vercel.json               # Vercel routing, headers, and environment
└── package.json              # Backend scripts and dependencies
```

**Key files:**

| File | Purpose |
|---|---|
| `core.js` | Entire backend: HTTP router, all API handlers, database adapter selection, auth, business logic |
| `api/index.js` | Thin Vercel wrapper that exports the handler from `core.js` |
| `public/app.js` | All client-side UI logic (inventory, billing, store map, demand forecast) |
| `scripts/seed-production-demo.js` | Seeds two demo pharmacies with medicines, batches, sales history, and users |

---

## 11. Limitations and Future Enhancements

### Current Limitations

- The mobile app targets **Android only**; no iOS build is configured.
- The offline sync client-side outbox (IndexedDB-based queuing in the browser) is **not yet implemented**; offline sync is currently server-side only.
- PostgreSQL integration tests require a separate test database and are skipped without `POSTGRES_TEST_URL`.
- There are **no UI screenshots** committed to the repository.
- One test (`mobile-pairing.test.js`) has a pre-existing failure due to test-ordering state pollution; this does not affect runtime behaviour.
- No `LICENSE` file is present in the repository.

### Planned Enhancements

| Enhancement | Priority |
|---|---|
| Low-stock notification centre with reorder lists and predicted runout dates | P2 |
| Client-side offline outbox (IndexedDB) for the mobile web experience | P2 |
| Academic project report (IEEE citations, ER diagram, DFD, sequence diagrams) | P3 |
| Presentation slides and viva voce preparation guide | P3 |
| Desktop packaging via Electron or Node standalone binary | P3 (deferred) |
| iOS build for the mobile application | Not scheduled |

---

## 12. License

No `LICENSE` file is present in this repository. All rights are reserved by the project author unless otherwise specified. Contact the repository owner for usage permissions.

---

## 13. Acknowledgements

- **Maharashtra Institute of Technology, Chhatrapati Sambhajinagar** — academic supervision and project framework
- **Node.js** — built-in `node:sqlite`, `node:crypto`, and `node:http` APIs that made a zero-external-dependency backend possible
- **Neon** — serverless PostgreSQL hosting for the production deployment
- **Vercel** — hosting and serverless function runtime
- **Expo / React Native** — mobile application framework

---

*MediIndex — B.Tech Major Project-II, PRO423*
*Maharashtra Institute of Technology, Chhatrapati Sambhajinagar*
