# MediIndex REST API Specification

All protected endpoints require a valid `mediindex_session` cookie established via `/api/auth/login`.

---

## Endpoint Summary

| HTTP Method | Route Path | Access Level | Description | Status |
|---|---|---|---|---|
| `GET` | `/api/health` | Public | System health and database connectivity | IMPLEMENTED |
| `POST` | `/api/auth/login` | Public | Authenticates credentials and issues session cookie | IMPLEMENTED |
| `POST` | `/api/auth/logout` | Session | Invalidates session and clears cookie | IMPLEMENTED |
| `GET` | `/api/auth/me` | Session | Returns current authenticated user profile | IMPLEMENTED |
| `GET` | `/api/dashboard` | Session | Aggregated inventory, expiry, and sales metrics | IMPLEMENTED |
| `GET` | `/api/analytics/demand` | Session | 3-period WMA demand forecast and safety stock recommendations | IMPLEMENTED |
| `GET` | `/api/batches/:id/qr` | Session | Generates structured QR payload and printable sticker metadata | IMPLEMENTED |
| `POST` | `/api/qr/lookup` | Session | Validates QR code and returns authoritative database records | IMPLEMENTED |
| `GET` | `/api/medicines` | Session | Search and list medicines (`?q=term`) | IMPLEMENTED |
| `POST` | `/api/medicines` | Admin | Create new medicine catalogue entry | IMPLEMENTED |
| `PUT` | `/api/medicines/:id` | Admin | Update medicine metadata | IMPLEMENTED |
| `DELETE` | `/api/medicines/:id` | Admin | Soft-deactivate medicine | IMPLEMENTED |
| `GET` | `/api/medicines/:id/batches` | Session | List all batches for a medicine | IMPLEMENTED |
| `POST` | `/api/medicines/:id/batches` | Session | Add new batch inventory stock | IMPLEMENTED |
| `POST` | `/api/batches/:id/adjustments` | Session | Adjust physical stock with audit trail | IMPLEMENTED |
| `GET` | `/api/expiry-alerts` | Session | Filter alerts (`?status=ALL|EXPIRED|EXPIRING_SOON`) | IMPLEMENTED |
| `POST` | `/api/expiry-alerts/:id/acknowledge` | Session | Acknowledge specific expiry alert | IMPLEMENTED |
| `POST` | `/api/sales` | Session | Process point-of-sale checkout (FEFO / batch) | IMPLEMENTED |
| `GET` | `/api/sales` | Session | List recent sales transactions and receipts | IMPLEMENTED |
| `GET` | `/api/sales/:id` | Session | Fetch full invoice details with line items | IMPLEMENTED |

---

## Key Payload Specifications

### 1. Batch QR Generation: `GET /api/batches/:id/qr`

**Response (200 OK):**
```json
{
  "payload": {
    "app": "MEDIINDEX",
    "v": 1,
    "medicineId": 1,
    "batchNumber": "AZI-LOT-2027"
  },
  "payloadString": "{\"app\":\"MEDIINDEX\",\"v\":1,\"medicineId\":1,\"batchNumber\":\"AZI-LOT-2027\"}",
  "sticker": {
    "medicineId": 1,
    "medicineName": "Azithromycin 500mg",
    "genericName": "Azithromycin",
    "category": "Tablet",
    "batchNumber": "AZI-LOT-2027",
    "expiryDate": "2027-06-30",
    "sellingPrice": 25,
    "currentStock": 50,
    "location": "Rack C3"
  }
}
```

---

### 2. QR Authoritative Lookup: `POST /api/qr/lookup`

**Request:**
```json
{
  "payload": {
    "app": "MEDIINDEX",
    "v": 1,
    "medicineId": 1,
    "batchNumber": "AZI-LOT-2027"
  }
}
```
*(Accepts either JSON object, JSON string, or pipe-delimited `MEDIINDEX|v1|1|AZI-LOT-2027`)*

**Response (200 OK):**
```json
{
  "valid": true,
  "authoritative": true,
  "medicine": {
    "id": 1,
    "name": "Azithromycin 500mg",
    "genericName": "Azithromycin",
    "manufacturer": "Cipla Ltd",
    "category": "Tablet",
    "minimumStock": 10
  },
  "batch": {
    "id": 4,
    "batchNumber": "AZI-LOT-2027",
    "quantity": 50,
    "purchasePrice": 15,
    "sellingPrice": 25,
    "manufacturingDate": "2024-06-01",
    "expiryDate": "2027-06-30",
    "expiryStatus": "SAFE",
    "location": "Rack C3"
  }
}
```
