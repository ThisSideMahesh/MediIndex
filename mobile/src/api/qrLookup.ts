/**
 * QR Lookup API Service
 * 
 * Provides device-authenticated lookup of medicine and batch information
 * from scanned QR codes via POST /api/mobile/qr/lookup endpoint.
 */

import { apiClient } from './client';
import { API_ROUTES, QrLookupRequest, QrLookupResponse } from '../types/api';
import type { ParsedQRPayload } from '../utils/qrParser';

/**
 * Look up medicine and batch information from a parsed QR payload.
 * Uses device token authentication and returns authoritative server data.
 * 
 * @param parsedQR - Validated QR payload containing medicineId and batchNumber
 * @returns Server response with medicine and batch details, or error information
 */
export async function lookupQrCode(parsedQR: ParsedQRPayload): Promise<QrLookupResponse> {
  const request: QrLookupRequest = {
    qrPayload: {
      app: 'MEDIINDEX',
      v: 1,
      medicineId: parsedQR.medicineId,
      batchNumber: parsedQR.batchNumber,
    },
  };

  return apiClient.post<QrLookupResponse>(API_ROUTES.qrLookup, request, {
    authenticated: true,
  });
}