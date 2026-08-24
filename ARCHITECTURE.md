# MediIndex System Architecture

## 1. High-Level Architecture Overview

MediIndex is architected as an **offline-first, zero-dependency medical inventory and pharmacy management platform**. It is designed specifically for independent and small-to-medium pharmacies where network unreliability and operational continuity are primary considerations.

```
┌────────────────────────────────────────────────────────┐
│                   Web Browser Client                   │
│   (Semantic HTML5, CSS3 Grid/Flexbox, Vanilla JS ES6+) │
│   - ISO/IEC 18004 Zero-Dependency QR Vector Engine     │
│   - HTML5 Canvas Viewfinder + Manual Barcode Fallback  │
└───────────────────────────▲────────────────────────────┘
                            │ HTTP/1.1 (JSON API + Cookies)
┌───────────────────────────▼────────────────────────────┐
│              MediIndex Application Server              │
│       (Node.js Built-in HTTP, Crypto, and FS)          │
│  ┌─────────────────┐ ┌─────────────────┐ ┌───────────┐ │
│  │ Auth & Sessions │ │ Business Logic  │ │ FEFO POS  │ │
│  │ (Scrypt + Map)  │ │ (Catalogue/Exp) │ │ Engine    │ │
│  └─────────────────┘ └─────────────────┘ └───────────┘ │
│  ┌───────────────────────────────────────────────────┐ │
│  │     Statistical Demand Forecasting Engine (WMA)   │ │
│  ├───────────────────────────────────────────────────┤ │
│  │     Authoritative QR Validation & Ingestion Engine │ │
│  └───────────────────────────────────────────────────┘ │
└───────────────────────────▲────────────────────────────┘
                            │ node:sqlite DatabaseSync (WAL Mode)
┌───────────────────────────▼────────────────────────────┐
│                SQLite Local Database                   │
│               (`data/mediindex.db`)                    │
│   - Strict foreign keys enabled (`PRAGMA foreign_keys`)│
│   - Write-Ahead Logging (`PRAGMA journal_mode = WAL`)  │
│   - Atomic multi-statement ACID transactions           │
│   - Automated indexes for high-throughput queries      │
└────────────────────────────────────────────────────────┘
```

---

## 2. Technical Stack & Justification

| Layer | Chosen Technology | Architectural Justification | Alternatives Considered & Why Rejected |
|---|---|---|---|
| **Runtime** | **Node.js (v22+)** | Utilizes modern built-in capabilities (`node:sqlite`, `node:crypto`, `node:http`), eliminating third-party dependency vulnerabilities (`node_modules` bloat, supply chain risks) and ensuring deterministic execution across any evaluation machine. | External Express/Fastify rejected for zero-dependency baseline simplicity. |
| **Database** | **SQLite (via `node:sqlite`)** | Embedded, serverless, zero-configuration relational database engine with full ACID compliance, zero network latency, and simple single-file backups. Ideal for local pharmacy POS workstations. | PostgreSQL / MongoDB rejected due to external server setup overhead on student evaluation systems. |
| **Authentication** | **Scrypt + Server Sessions** | Salted cryptographic password hashing with timing-safe comparison (`crypto.timingSafeEqual`) and server-side stateful session tokens held in `HttpOnly; SameSite=Strict` cookies. | Plaintext passwords / stateless JWTs rejected due to token revocation and client-side storage vulnerabilities. |
| **Forecasting Engine** | **Weighted Moving Average (WMA)** | Explainable statistical time-series forecasting with deterministic mathematical properties and safety stock estimation at 95% service level. | Black-box deep learning / complex ML models rejected due to lack of extensive multi-year training datasets in single-store environments and viva indefensibility. |
| **QR Engine** | **ISO/IEC 18004 Vector Generator** | Zero-dependency pure JavaScript matrix generator rendering crisp SVG stickers with authoritative database-bound resolution. | Heavy client-side NPM packaging or third-party cloud QR generation APIs rejected to preserve offline-first integrity. |
| **Frontend** | **Vanilla HTML5/CSS3/JS** | Fast rendering, zero build steps, instant reloads, and clean semantic structure. Responsive layout adapted for desktop point-of-sale workstations and touch displays. | React / Vue build pipelines avoided to prevent packaging complexity during viva demos. |

---

## 3. Demand Forecasting Methodology (MOD-09)

### 3.1 Academic Classification & Defensibility
In accordance with academic integrity guidelines, this component is formally classified as:
> **Demand Forecasting using Weighted Moving Average (WMA) with Historical Sales and Safety Stock Analysis** (Statistical Time-Series Forecasting).

It is not represented as black-box Artificial Intelligence or Deep Learning, ensuring that the system is 100% explainable and defensible during technical viva voce examinations.

### 3.2 Mathematical Formulation

1. **Periodic Aggregation:**
   Sales quantities are aggregated weekly ($t = 1, 2, \dots, N$) for each active medicine:
   $$S_t = \sum_{\text{sales in week } t} \text{quantity\_sold}$$

2. **Weighted Moving Average (WMA):**
   For medicines with at least 3 historical sales periods ($P_1, P_2, P_3$, where $P_1$ is the most recent period), weights are allocated linearly to give higher importance to recent consumption trends:
   - $w_1 = 0.50$ (Most recent period)
   - $w_2 = 0.30$ (Preceding period)
   - $w_3 = 0.20$ (Three periods prior)
   $$\sum_{i=1}^3 w_i = 1.0$$

   $$\hat{D}_{\text{week}} = w_1 S_1 + w_2 S_2 + w_3 S_3$$
   $$\hat{D}_{30} = \text{round}\left(\hat{D}_{\text{week}} \times \frac{30}{7}\right)$$

3. **Safety Stock ($SS$) Calculation:**
   To account for demand variance across lead time ($L = 1$ week) at a 95% service level ($Z = 1.65$):
   $$\sigma_D = \sqrt{\frac{(S_1 - \bar{S})^2 + (S_2 - \bar{S})^2 + (S_3 - \bar{S})^2}{2}}$$
   $$SS = \max\left(m.\text{minimum\_stock}, \text{round}(1.65 \times \sigma_D)\right)$$

4. **Replenishment Recommendation ($R$):**
   $$R = \max\left(0, \hat{D}_{30} + SS - \text{current\_stock}\right)$$

5. **Hard Reliability Guardrail:**
   If a medicine has fewer than 3 historical sales periods ($\text{periods} < 3$):
   - Status: `INSUFFICIENT_DATA`
   - Explicit Message: `"INSUFFICIENT DATA FOR RELIABLE FORECAST"`
   - Safety stock defaults to $m.\text{minimum\_stock}$ and $R = \max(0, m.\text{minimum\_stock} - \text{current\_stock})$.

---

## 4. QR Identification & Security Architecture (MOD-10)

### 4.1 Security Boundary & Authoritative Truth Principle
A fundamental architectural principle of MediIndex is that **client-provided QR codes are treated strictly as identifiers, not authoritative data containers**:
1. The QR payload contains only non-sensitive identifying keys:
   ```json
   {
     "app": "MEDIINDEX",
     "v": 1,
     "medicineId": 1,
     "batchNumber": "AZI-LOT-2027"
   }
   ```
2. **Never Trust QR Data Directly:** A malicious, modified, or stale QR code may claim a discounted selling price, fictitious stock quantity, or altered expiry date.
3. **Database Resolution:** Upon scanning, the server resolves `medicineId` and `batchNumber` against the SQLite database, returning the authoritative live stock count, true unit price, active shelf location, and verified expiry status (`EXPIRED`, `EXPIRING_SOON`, `SAFE`).

### 4.2 Scanner Architecture & Fallback Strategy
- **Webcam Viewfinder:** Employs HTML5 `navigator.mediaDevices.getUserMedia` for video stream capture.
- **Manual Input / Emulation Fallback:** Provides an explicit manual code input field and quick-select database test chips, ensuring 100% testability during academic evaluations on headless/sandbox machines.

---

## 5. Data Integrity & Dispensing Rules

### 5.1 FEFO (First-Expired, First-Out) Dispensing
When medicines are sold, the inventory management engine enforces **FEFO dispensing**:
1. Batches with the nearest valid expiry date are prioritized and allocated first.
2. Expired batches (`date(expiry_date) < date('now')`) are strictly disqualified from active sale.
3. If an explicit batch is selected by the pharmacist or scanned via QR, the system verifies availability and logs the specific batch ID.

### 5.2 Atomic Sales Transactions
Every sale operation executes within a strict SQLite database transaction (`BEGIN ... COMMIT / ROLLBACK`):
- Checks that all requested quantities do not exceed available batch stock (`CHECK(quantity >= 0)`).
- If any line item exceeds stock, the entire transaction is rolled back immediately with an informative error message.
- For valid sales:
  - Generates a unique invoice number (`INV-YYYYMMDD-XXXX`).
  - Writes to `sales` and `sale_items`.
  - Decrements batch quantity in `medicine_batches`.
  - Appends audit records to `inventory_movements` with reason `'SALE'`.
  - Automatically recalculates dynamic expiry alerts and low-stock indicators.
