# MediIndex — Inter-Pharmacy Network Architecture Specification
## Federated Availability Discovery, Stock Transfer Requests & Privacy Guardrails

**Project:** MediIndex – Pharmacy Insights, POS & Analytics  
**Document Code:** SPEC-INTER-PHARMACY-V1  
**Status:** ARCHITECTURAL SPECIFICATION & PRIVACY MODEL  

---

## 1. Executive Summary & Purpose

In community healthcare, critical medicines (e.g. specialized anti-venom, rare pediatric antibiotics, or emergency oncological injectables) frequently face localized stockouts. A pharmacist turning away a patient with an urgent prescription currently relies on inefficient manual phone calls to nearby competitors.

The **MediIndex Inter-Pharmacy Network** is a federated, privacy-preserving inventory discovery and stock-request protocol. It enables connected pharmacies within a geographical district to search for medicine availability across partner stores and initiate formal stock-transfer requests without exposing proprietary business data.

> [!IMPORTANT]
> **Defensive Scope Boundary:** This is an operational inventory-sharing and transfer-coordination tool, **NOT** a social network, marketplace, or advertising platform.

---

## 2. End-to-End Business Workflow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                               PHARMACY A (REQUESTING STORE)                             │
│                                                                                         │
│   1. Patient arrives with prescription for "RareMed 500mg".                             │
│   2. Local stock is ZERO. Pharmacist opens "Inter-Pharmacy Network Search".             │
│   3. Queries: "RareMed" or Generic Name "Rarecillin".                                   │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │ HTTPS Query (Authorized Token)
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                        CENTRAL CLOUD DISCOVERY GATEWAY (VERCEL)                         │
│                                                                                         │
│   4. Verifies Pharmacy A is authenticated & connected with partner stores.              │
│   5. Filters database for active pharmacies with matching medicine & opt-in sharing.    │
│   6. Strips all sensitive pricing, customer records, and supplier data.                 │
│   7. Returns sanitized availability list.                                               │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │ Sanitized JSON Response
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                PHARMACY A (SEARCH RESULTS)                              │
│                                                                                         │
│   • Pharmacy B (City Central Branch) — In Stock (25+ units) — Last Synced: 5 mins ago   │
│   • Pharmacy C (Station Road Branch) — Low Stock (4 units)   — Last Synced: 2 hours ago │
│                                                                                         │
│   [Action Button: Initiate Stock Transfer Request (10 units) -> Pharmacy B]            │
└───────────────────────────────────────────┬─────────────────────────────────────────────┘
                                            │ POST /api/network/transfers/request
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                               PHARMACY B (RECEIVING STORE)                              │
│                                                                                         │
│   8. Dashboard Alert: "Stock Request: Pharmacy A requests 10 units of RareMed 500mg"    │
│   9. Pharmacist reviews stock and clicks [ACCEPT TRANSFER] or [DECLINE].                │
│  10. If accepted, local stock is reserved; formal transfer dispatch note generated.     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Strict Privacy & Data Isolation Boundaries

To maintain trust and prevent anti-competitive exposure, strict data classification rules are enforced at the database query layer:

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                 DATA PRIVACY BOUNDARY                                 │
├───────────────────────────────────────────┬───────────────────────────────────────────┤
│ 🟢 PUBLIC TO CONNECTED PARTNERS           │ 🔴 STRICTLY PRIVATE (NEVER EXPOSED)       │
├───────────────────────────────────────────┼───────────────────────────────────────────┤
│ • Medicine Name & Generic Formula         │ • Purchase / Wholesale Cost Prices        │
│ • Strength & Dosage Form (e.g. 500mg Tab) │ • Profit Margins & Markups                │
│ • Partner Pharmacy Name & City / Address  │ • Customer PII & Phone Numbers            │
│ • Partner Contact Phone Number            │ • Sales Revenue & Daily POS Invoices      │
│ • Availability Indicator (or Unit Count)  │ • Supplier & Wholesaler Identities        │
│ • Last Synchronization Timestamp          │ • Internal Batch Shelf Coordinates        │
└───────────────────────────────────────────┴───────────────────────────────────────────┘
```

---

## 4. Minimum Viable Relational Schema

```sql
-- 1. Mutual Connection Directory
CREATE TABLE IF NOT EXISTS pharmacy_connections (
  id INTEGER PRIMARY KEY,
  requester_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  receiver_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  status TEXT NOT NULL CHECK(status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'BLOCKED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requester_pharmacy_id, receiver_pharmacy_id)
);

-- 2. Inventory Sharing Configuration per Pharmacy
CREATE TABLE IF NOT EXISTS shared_inventory_settings (
  pharmacy_id INTEGER PRIMARY KEY REFERENCES pharmacies(id),
  is_discoverable INTEGER NOT NULL DEFAULT 1,
  share_exact_quantities INTEGER NOT NULL DEFAULT 1, -- 1: exact count (e.g. 24), 0: bucketed ('IN_STOCK' / 'LOW_STOCK')
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Stock Transfer Requests
CREATE TABLE IF NOT EXISTS stock_transfers (
  id INTEGER PRIMARY KEY,
  transfer_number TEXT NOT NULL UNIQUE, -- E.g. TRF-20260903-001
  source_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),   -- Providing store
  destination_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id), -- Requesting store
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  requested_quantity INTEGER NOT NULL CHECK(requested_quantity > 0),
  status TEXT NOT NULL CHECK(status IN ('REQUESTED', 'APPROVED', 'DISPATCHED', 'RECEIVED', 'REJECTED', 'CANCELLED')),
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. API Endpoints Specification

| Method | Endpoint | Authorization | Description |
|---|---|---|---|
| `GET` | `/api/network/search?q=Amoxicillin` | Logged-in Staff/Admin | Searches medicine stock across connected partner pharmacies. |
| `GET` | `/api/network/connections` | Admin only | Lists active, pending, and received connection requests. |
| `POST` | `/api/network/connections/request` | Admin only | Sends a connection invite to a target pharmacy via license ID/name. |
| `POST` | `/api/network/connections/:id/respond` | Admin only | Accepts or declines an incoming connection request. |
| `POST` | `/api/network/transfers/request` | Logged-in Staff/Admin | Dispatches a formal stock transfer request to a partner store. |
| `GET` | `/api/network/transfers` | Logged-in Staff/Admin | Lists incoming and outgoing transfer requests with status flags. |
| `POST` | `/api/network/transfers/:id/status` | Admin only | Transitions transfer state (`APPROVED`, `DISPATCHED`, `RECEIVED`). |

---

## 6. Implementation Readiness for Phase 6

This architecture strictly decouples internal pharmacy operations from inter-store queries. Internal FEFO deductions, sales invoices, and stock receipts function autonomously regardless of whether a pharmacy opts into the inter-pharmacy network.
