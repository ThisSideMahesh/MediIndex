/**
 * Type definitions mirroring the EXISTING MediIndex mobile backend contracts.
 *
 * Every shape here was read off the server implementation in `core.js` — nothing
 * is invented. Later phases consume these; Phase 7B only declares them.
 *
 * Endpoints (all already implemented and tested server-side):
 *   POST /api/mobile/pairing/create           (session, ADMIN)
 *   POST /api/mobile/pairing/complete         (pairing code is the credential)
 *   GET  /api/mobile/auth/verify              (device token)
 *   POST /api/mobile/stock-entry              (device token, idempotent)
 *   POST /api/mobile/stock-entry/batch-sync   (device token, idempotent per op)
 *   GET  /api/health                          (public)
 */

// ─── Endpoint paths ──────────────────────────────────────────────────────────

export const API_ROUTES = {
  health: '/api/health',
  deviceVerify: '/api/mobile/auth/verify',
  pairingComplete: '/api/mobile/pairing/complete',
  qrLookup: '/api/mobile/qr/lookup',
  stockEntry: '/api/mobile/stock-entry',
  stockEntryBatchSync: '/api/mobile/stock-entry/batch-sync',
} as const;

/**
 * Header the server accepts for device authentication.
 * `core.js` reads `x-device-token` first, then `Authorization: Bearer <token>`.
 */
export const DEVICE_TOKEN_HEADER = 'X-Device-Token';

// ─── QR payload (existing MediIndex format — do NOT invent a second one) ─────

/** Canonical JSON form emitted by GET /api/batches/:id/qr. */
export interface MediIndexQrPayload {
  app: 'MEDIINDEX';
  v: 1;
  medicineId: number;
  batchNumber: string;
}

/** The two fields the server extracts from any accepted QR form. */
export interface ParsedQrTarget {
  medicineId: number;
  batchNumber: string;
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

export interface PairingCompleteRequest {
  pairingCode: string;
  deviceName: string;
  deviceModel?: string;
}

export interface PairedPharmacy {
  id: number;
  name: string;
  address: string | null;
}

/** 201 response. `deviceToken` is returned exactly once and must go to SecureStore. */
export interface PairingCompleteResponse {
  success: true;
  deviceId: number;
  deviceName: string;
  deviceToken: string;
  pharmacy: PairedPharmacy;
  pairedAt: string;
}

export interface DeviceVerifyResponse {
  valid: true;
  device: {
    id: number;
    name: string;
    model: string | null;
    createdAt: string;
    lastSeenAt: string | null;
  };
  pharmacy: PairedPharmacy;
}

// ─── QR Lookup ───────────────────────────────────────────────────────────────

/** Request body for POST /api/mobile/qr/lookup */
export interface QrLookupRequest {
  qrPayload: MediIndexQrPayload | string | object;
}

export interface MedicineInfo {
  id: number;
  name: string;
  genericName?: string;
  manufacturer?: string;
  category?: string;
  minimumStock?: number;
}

export interface BatchInfo {
  id: number;
  batchNumber: string;
  quantity: number;
  purchasePrice?: number;
  sellingPrice?: number;
  manufacturingDate?: string;
  expiryDate?: string;
  expiryStatus?: 'VALID' | 'NEAR_EXPIRY' | 'EXPIRED';
  location?: string;
}

/** Response from POST /api/mobile/qr/lookup */
export interface QrLookupResponse {
  valid: boolean;
  authoritative: boolean;
  medicine?: MedicineInfo;
  batch?: BatchInfo;
  error?: string;
}

// ─── Stock entry ─────────────────────────────────────────────────────────────

/**
 * Request body for POST /api/mobile/stock-entry.
 * The pharmacy is derived server-side from the device token — a client that
 * sends `pharmacyId`/`pharmacy_id` is rejected with TENANT_SPOOFING_REJECTED.
 */
export interface StockEntryRequest {
  qrPayload: MediIndexQrPayload | string;
  quantity: number;
  idempotencyKey: string;
}

export interface StockEntryBatchInfo {
  id: number;
  batchNumber: string;
  quantityAdded: number;
  currentStock: number;
}

export interface StockEntryResponse {
  movementId: number;
  batch: StockEntryBatchInfo;
  timestamp: string;
  /** Present and true when the server replayed a cached idempotent result. */
  idempotent?: boolean;
}

// ─── Batch sync ──────────────────────────────────────────────────────────────

/** Max operations the server accepts in one batch-sync call. */
export const BATCH_SYNC_MAX_OPERATIONS = 100;

export interface BatchSyncOperation extends StockEntryRequest {
  /** Echoed back in the matching result so the client can reconcile rows. */
  operationId: string;
}

export interface BatchSyncRequest {
  operations: BatchSyncOperation[];
}

export type BatchSyncResultStatus = 'SYNCED' | 'IDEMPOTENT' | 'FAILED' | 'CONFLICT';

export interface BatchSyncResult {
  operationId: string;
  status: BatchSyncResultStatus;
  idempotent?: boolean;
  movementId?: number;
  batchId?: number;
  batchNumber?: string;
  quantityAdded?: number;
  currentStock?: number;
  timestamp?: string;
  errorCode?: MediIndexErrorCode;
  message?: string;
}

export interface BatchSyncResponse {
  success: true;
  deviceId: number;
  pharmacyId: number;
  summary: { total: number; synced: number; idempotent: number; failed: number };
  results: BatchSyncResult[];
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Error codes emitted by the existing backend. */
export type MediIndexErrorCode =
  | 'BATCH_NOT_FOUND'
  | 'DEVICE_REVOKED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_INPUT'
  | 'INVALID_QR_PAYLOAD'
  | 'INVALID_QUANTITY'
  | 'MEDICINE_NOT_FOUND'
  | 'OPERATION_ERROR'
  | 'QUANTITY_LIMIT_EXCEEDED'
  | 'QUANTITY_REQUIRED'
  | 'TENANT_SPOOFING_REJECTED';

/** Generic server error envelope: `{ error, code?, details? }`. */
export interface ApiErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}

export interface HealthResponse {
  status: string;
  database: string;
}

// ─── Local outbox states (Phase 7H/7I will implement the queue itself) ───────

export type OutboxStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';
