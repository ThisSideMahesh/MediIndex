/**
 * Validation for the Stock Receipt manual-entry form (medicine ID + batch
 * number, typed directly by the user rather than obtained from a QR scan).
 *
 * Extracted as a standalone, dependency-free module — no React/React Native
 * import — so it mirrors the backend's own validation rules exactly and can
 * be exercised directly in tests without a component-rendering harness
 * (matching the rest of this codebase: `utils/idempotency.ts`'s
 * `isValidIdempotencyKey`, `utils/qrParser.ts`, etc.).
 *
 * Rules mirror `core.js`'s `parseAndValidateQrPayload()`:
 *   - medicineId: positive integer (`!Number.isInteger(medicineId) || medicineId <= 0` is rejected)
 *   - batchNumber: non-empty, trimmed, max 80 characters (`cleanText(..., { required: true, max: 80 })`)
 *
 * Validating client-side to these exact rules only produces a friendlier,
 * faster error for an obviously-bad entry (e.g. a blank field) — the server
 * remains the sole source of truth for whether a medicineId/batchNumber pair
 * actually exists for the authenticated device's pharmacy.
 */

export interface ManualStockEntryInput {
  medicineIdText: string;
  batchNumberText: string;
}

export interface ManualStockEntryValid {
  valid: true;
  medicineId: number;
  batchNumber: string;
}

export interface ManualStockEntryInvalid {
  valid: false;
  error: string;
}

export type ManualStockEntryResult = ManualStockEntryValid | ManualStockEntryInvalid;

const MAX_BATCH_NUMBER_LENGTH = 80;

/**
 * Validates and normalizes manual-entry form input.
 *
 * Returns a discriminated union rather than throwing, so callers (the
 * screen's submit handler, and tests) can branch on `.valid` without a
 * try/catch for what is routine form validation, not an exceptional error.
 */
export function validateManualStockEntry(input: ManualStockEntryInput): ManualStockEntryResult {
  const idText = input.medicineIdText.trim();
  const batchText = input.batchNumberText.trim();

  if (!idText) {
    return { valid: false, error: 'Medicine ID is required' };
  }

  const medicineId = Number(idText);
  if (!Number.isInteger(medicineId) || medicineId <= 0) {
    return { valid: false, error: 'Medicine ID must be a positive whole number' };
  }

  if (!batchText) {
    return { valid: false, error: 'Batch number is required' };
  }

  if (batchText.length > MAX_BATCH_NUMBER_LENGTH) {
    return { valid: false, error: 'Batch number is too long' };
  }

  return { valid: true, medicineId, batchNumber: batchText };
}
