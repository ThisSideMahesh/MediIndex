/**
 * Mobile Stock Entry API Service - Phase 7G Online Stock Receipt
 * 
 * Provides authenticated API calls to the backend stock-entry endpoint
 * using the existing device-token authentication and centralized error handling.
 * 
 * CRITICAL: This service uses the EXISTING backend endpoint POST /api/mobile/stock-entry
 * and does NOT create a new endpoint.
 */

import { apiClient } from './client';
import { API_ROUTES } from '../types/api';
import type { StockReceiptRequest, StockReceiptResponse } from '../types/stockReceipt';
import { logger } from '../utils/logger';

/**
 * Submits a stock receipt to the authoritative backend API.
 * 
 * Uses the existing POST /api/mobile/stock-entry endpoint with:
 * - Device token authentication (X-Device-Token header)
 * - QR payload format matching backend expectations
 * - Idempotency key for exactly-once semantics
 * - Pharmacy identity derived server-side from device token
 * 
 * @param request Stock receipt request with medicine ID, batch, quantity, and idempotency key
 * @returns Promise resolving to authoritative backend response
 * @throws ApiError for network, authentication, validation, or server errors
 */
export async function submitStockReceipt(request: StockReceiptRequest): Promise<StockReceiptResponse> {
  const { medicineId, batchNumber, quantity, idempotencyKey } = request;

  logger.debug('stock-entry', 'Submitting stock receipt request', {
    medicineId,
    batchNumber,
    quantity,
    hasIdempotencyKey: !!idempotencyKey,
  });

  // Construct request body matching exact backend expectations
  const requestBody = {
    qrPayload: {
      app: 'MEDIINDEX',
      v: 1,
      medicineId,
      batchNumber,
    },
    quantity,
    idempotencyKey,
  };

  // Submit to existing backend endpoint with device authentication
  const response = await apiClient.post<StockReceiptResponse>(
    API_ROUTES.stockEntry,
    requestBody,
    { authenticated: true }
  );

  logger.debug('stock-entry', 'Stock receipt submitted successfully', {
    movementId: response.movementId,
    currentStock: response.batch.currentStock,
    idempotent: response.idempotent,
  });

  return response;
}

/**
 * Type guard to check if a response indicates idempotent replay.
 * Used for distinguishing between new operations and retries.
 */
export function isIdempotentResponse(response: StockReceiptResponse): boolean {
  return response.idempotent === true;
}

/**
 * Extracts the new stock level from a successful stock receipt response.
 * Useful for UI updates and verification.
 */
export function getNewStockLevel(response: StockReceiptResponse): number {
  return response.batch.currentStock;
}

/**
 * Extracts the quantity that was added from a successful response.
 * Useful for confirmation displays.
 */
export function getAddedQuantity(response: StockReceiptResponse): number {
  return response.batch.quantityAdded;
}