/**
 * Stock Receipt Data Model for Phase 7G Online Stock Entry
 * 
 * Represents a mobile stock receipt operation that will be submitted
 * to the authoritative backend API.
 */

export interface StockReceiptRequest {
  /** Medicine ID from QR scan or lookup */
  medicineId: number;
  
  /** Batch number from QR scan or lookup */
  batchNumber: string;
  
  /** Quantity to add to stock (positive integer only) */
  quantity: number;
  
  /** Stable idempotency key for retry safety */
  idempotencyKey: string;
}

export interface StockReceiptResponse {
  success: true;
  status: 'STOCK_UPDATED';
  idempotent: boolean;
  medicine: {
    id: number;
    name: string;
    genericName: string;
    category: string;
  };
  batch: {
    id: number;
    batchNumber: string;
    quantityAdded: number;
    currentStock: number;
    expiryDate: string;
    sellingPrice: number;
    location: string;
  };
  movementId: number;
  deviceId: number;
  timestamp: string;
}

export type StockReceiptState = 
  | 'IDLE'
  | 'SUBMITTING' 
  | 'SUCCESS'
  | 'QUEUED'  // New: Successfully queued offline
  | 'ERROR';

export interface StockReceiptContext {
  /** Current operation state */
  state: StockReceiptState;
  
  /** Medicine/batch identity from QR scan */
  medicineId: number;
  batchNumber: string;
  
  /** User-entered quantity */
  quantity: number;
  
  /** Generated idempotency key for this operation */
  idempotencyKey: string | null;
  
  /** Success response data (online only) */
  result: StockReceiptResponse | null;
  
  /** Offline queue record (offline only, or after a network failure mid-submit) */
  queuedRecord: {
    id: string;
    operationId: string;
  } | null;

  /**
   * Why this receipt ended up queued rather than confirmed online.
   * 'OFFLINE': the device was already offline before any request was attempted.
   * 'NETWORK_FAILURE': the device appeared online, but the request itself failed
   *   (dropped connection, timeout) before a server response was received — the
   *   server may or may not have processed it; the queued idempotency key is
   *   what makes the eventual sync safe either way (Phase 7J requirement 13).
   */
  queuedReason: 'OFFLINE' | 'NETWORK_FAILURE' | null;
  
  /** Error information */
  error: string | null;
  
  /** Loading/authoritative medicine context */
  medicineContext: {
    name?: string;
    genericName?: string;
    category?: string;
    batch?: {
      currentStock?: number;
      expiryDate?: string;
      location?: string;
    };
  } | null;
}