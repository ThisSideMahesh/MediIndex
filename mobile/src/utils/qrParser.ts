/**
 * Mobile QR Parser
 * 
 * Reuses the exact backend QR semantics from core.js parseAndValidateQrPayload().
 * Supports both JSON and pipe formats as confirmed by the backend implementation.
 * 
 * Validates structure locally but does NOT fabricate medicine information.
 * QR identifies medicineId and batchNumber only - all other data comes from server.
 */

export interface ParsedQRPayload {
  medicineId: number;
  batchNumber: string;
}

export class QRParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QRParseError';
  }
}

/**
 * Clean text utility (simplified version of backend cleanText for batchNumber validation)
 */
function cleanText(value: unknown, fieldName: string, options: { required?: boolean; max?: number } = {}): string {
  if (value === null || value === undefined || value === '') {
    if (options.required) {
      throw new QRParseError(`${fieldName} is required.`);
    }
    return '';
  }
  
  const str = String(value).trim();
  if (options.required && !str) {
    throw new QRParseError(`${fieldName} cannot be empty.`);
  }
  
  if (options.max && str.length > options.max) {
    throw new QRParseError(`${fieldName} exceeds maximum length of ${options.max} characters.`);
  }
  
  return str;
}

/**
 * Parse and validate QR payload using exact backend semantics.
 * 
 * Supports:
 * - JSON format: {"app":"MEDIINDEX","v":1,"medicineId":123,"batchNumber":"ABC123"}
 * - Pipe format: MEDIINDEX|v1|123|ABC123
 * 
 * @param raw - Raw QR code content (string or object)
 * @returns Parsed and validated payload
 * @throws QRParseError for invalid payloads
 */
export function parseAndValidateQrPayload(raw: unknown): ParsedQRPayload {
  let payload: any = raw;
  
  if (typeof payload === 'string') {
    try {
      // Try JSON parse first
      payload = JSON.parse(payload.trim());
    } catch {
      // Fall back to pipe format
      const parts = payload.trim().split('|');
      if (parts.length >= 4 && parts[0] === 'MEDIINDEX') {
        payload = {
          app: parts[0],
          v: Number(parts[1].replace(/^v/i, '')) || 1,
          medicineId: Number(parts[2]),
          batchNumber: parts[3]
        };
      } else {
        throw new QRParseError('QR payload is not recognized as a valid MediIndex code.');
      }
    }
  }

  if (!payload || typeof payload !== 'object') {
    throw new QRParseError('Invalid QR payload structure.');
  }

  if (payload.app !== 'MEDIINDEX') {
    throw new QRParseError('Unrecognized application tag. Expected MEDIINDEX.');
  }

  if (Number(payload.v) !== 1) {
    throw new QRParseError(`Unsupported QR version: ${payload.v}. Expected version 1.`);
  }

  const medicineId = Number(payload.medicineId);
  if (!Number.isInteger(medicineId) || medicineId <= 0) {
    throw new QRParseError('Invalid medicine ID in QR payload.');
  }

  const batchNumber = cleanText(payload.batchNumber, 'Batch number', { required: true, max: 80 });

  return { medicineId, batchNumber };
}

/**
 * Check if a scanned value looks like it could be a MediIndex QR code
 * before attempting full parsing (for quick filtering).
 */
export function looksLikeMediIndexQR(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  
  const trimmed = raw.trim();
  
  // Check pipe format
  if (trimmed.startsWith('MEDIINDEX|')) return true;
  
  // Check JSON format
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && parsed.app === 'MEDIINDEX';
  } catch {
    return false;
  }
}