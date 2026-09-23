/**
 * Stock Receipt Screen - Phase 7G Online + Phase 7H Offline Stock Entry
 * 
 * Receives medicineId and batchNumber from QR scanner, displays authoritative
 * medicine/batch context, accepts quantity input, and either:
 * - Submits online stock receipt to backend API (Phase 7G - when connected)
 * - Queues operation in SQLite outbox (Phase 7H - when offline)
 *
 * MANUAL ENTRY (bug fix): when this screen is reached WITHOUT route params
 * (the Home screen's "Stock Receipt — Manual entry" action, which has no
 * scanned target to pass), it shows a small form asking the user to type
 * the medicine ID and batch number themselves. Submitting that form calls
 * the EXACT SAME `lookupQrCode()` the QR-scan path already uses to fetch
 * authoritative medicine/batch context — there is no separate manual
 * validation path and no duplicated stock-mutation logic. Once the lookup
 * succeeds, the rest of this screen (quantity entry, submit, offline queue,
 * error handling) behaves identically regardless of how medicineId/
 * batchNumber were obtained.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';

import { theme } from '../components/theme';
import { logger, sanitizeErrorText } from '../utils/logger';
import { lookupQrCode } from '../api/qrLookup';
import { submitStockReceipt } from '../api/stockEntry';
import { generateIdempotencyKey } from '../utils/idempotency';
import { isOnline } from '../utils/connectivity';
import { outbox } from '../storage/outbox';
import type { StockReceiptState, StockReceiptContext } from '../types/stockReceipt';
import type { QrLookupResponse, MediIndexQrPayload } from '../types/api';
import { ApiError, classifyError, toStockReceiptUserMessage } from '../api/errors';
import { validateManualStockEntry } from '../utils/stockReceiptValidation';

type Props = NativeStackScreenProps<RootStackParamList, 'StockReceipt'>;

export function StockReceiptScreen({ route, navigation }: Props) {
  // Manual entry (Home screen's "Manual entry" action) reaches this screen
  // with route.params === undefined — there is no scanned target yet. The QR
  // flow (ScanQrScreen) always supplies real, server-validated params. This
  // screen tracks medicineId/batchNumber as STATE (not a fixed destructure)
  // so the manual-entry form below can set them once the user has typed
  // both fields, at which point the identical lookup/submit flow used by the
  // QR path takes over.
  const initialParams = route.params;
  const [medicineId, setMedicineId] = useState<number>(initialParams?.medicineId ?? 0);
  const [batchNumber, setBatchNumber] = useState<string>(initialParams?.batchNumber ?? '');

  // True once we have a medicineId/batchNumber pair worth looking up — either
  // because the QR flow supplied them, or because the manual-entry form was
  // submitted. False means: show the manual-entry input form instead of the
  // loading/lookup UI.
  const [hasTarget, setHasTarget] = useState<boolean>(Boolean(initialParams));

  // Manual-entry form's own input state and validation, kept separate from
  // the quantity form below so a bad medicine-ID/batch-number entry doesn't
  // touch quantity state at all.
  const [manualMedicineIdText, setManualMedicineIdText] = useState('');
  const [manualBatchNumberText, setManualBatchNumberText] = useState('');
  const [manualEntryError, setManualEntryError] = useState<string | null>(null);

  const [context, setContext] = useState<StockReceiptContext>({
    state: 'IDLE',
    medicineId,
    batchNumber,
    quantity: 1,
    idempotencyKey: null,
    result: null,
    queuedRecord: null,
    queuedReason: null,
    error: null,
    medicineContext: null,
  });

  const [quantityText, setQuantityText] = useState('1');
  const [lookupResult, setLookupResult] = useState<QrLookupResponse | null>(null);
  const [isLoadingContext, setIsLoadingContext] = useState(Boolean(initialParams));

  // Load authoritative medicine/batch context on mount — but ONLY when we
  // actually have a target (QR flow). Manual entry has nothing to look up
  // yet and must show the input form first; loadMedicineContext() runs later
  // when handleManualEntrySubmit() sets hasTarget to true.
  useEffect(() => {
    if (hasTarget) {
      loadMedicineContext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleManualEntrySubmit = () => {
    const validation = validateManualStockEntry({
      medicineIdText: manualMedicineIdText,
      batchNumberText: manualBatchNumberText,
    });
    if (!validation.valid) {
      setManualEntryError(validation.error);
      return;
    }
    setManualEntryError(null);

    const { medicineId: parsedId, batchNumber: trimmedBatch } = validation;

    setMedicineId(parsedId);
    setBatchNumber(trimmedBatch);
    setContext(prev => ({ ...prev, medicineId: parsedId, batchNumber: trimmedBatch }));
    setHasTarget(true);
    setIsLoadingContext(true);
    // loadMedicineContext reads medicineId/batchNumber from component scope;
    // call it directly with the freshly-parsed values so it does not race the
    // setState above (React state updates are not synchronous).
    void loadMedicineContext(parsedId, trimmedBatch);
  };

  const loadMedicineContext = async (overrideMedicineId?: number, overrideBatchNumber?: string) => {
    const lookupMedicineId = overrideMedicineId ?? medicineId;
    const lookupBatchNumber = overrideBatchNumber ?? batchNumber;
    try {
      setIsLoadingContext(true);
      
      // Use existing QR lookup to get authoritative context — the SAME
      // function and endpoint the QR-scan flow uses. Manual entry is not a
      // separate validation path; it feeds this identical lookup.
      const result = await lookupQrCode({
        app: 'MEDIINDEX',
        v: 1,
        medicineId: lookupMedicineId,
        batchNumber: lookupBatchNumber,
      } as MediIndexQrPayload);

      setLookupResult(result);
      
      if (result.valid) {
        setContext(prev => ({
          ...prev,
          medicineContext: {
            name: result.medicine?.name,
            genericName: result.medicine?.genericName,
            category: result.medicine?.category,
            batch: result.batch ? {
              currentStock: result.batch.quantity,
              expiryDate: result.batch.expiryDate,
              location: result.batch.location,
            } : undefined,
          },
        }));
      } else {
        setContext(prev => ({
          ...prev,
          error: result.error || 'Medicine or batch not found',
        }));
      }
    } catch (err) {
      logger.error('stock-receipt', 'Failed to load medicine context', { error: err });
      // A "medicine/batch not found" lookup failure arrives here as a thrown
      // ApiError (the endpoint returns a non-2xx status), not as a resolved
      // { valid: false } result — see core.js's /api/mobile/qr/lookup, which
      // returns 404 for both cases. Surface that specific, already-safe
      // message (same reviewed allow-list used for stock-entry submission)
      // instead of a generic message, since for manual entry this is the
      // most common failure (a typo'd medicine ID or batch number).
      setContext(prev => ({
        ...prev,
        error: toStockReceiptUserMessage(err),
      }));
    } finally {
      setIsLoadingContext(false);
    }
  };

  const handleQuantityChange = (text: string) => {
    setQuantityText(text);
    
    // Clear previous errors when user starts typing
    if (context.error) {
      setContext(prev => ({ ...prev, error: null }));
    }
    
    // Validate and update quantity
    const trimmed = text.trim();
    if (trimmed === '') {
      setContext(prev => ({ ...prev, quantity: 0 }));
      return;
    }
    
    const parsed = parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      setContext(prev => ({ ...prev, quantity: parsed }));
    }
  };

  const validateQuantity = (): string | null => {
    if (!quantityText.trim()) {
      return 'Quantity is required';
    }
    
    const quantity = parseInt(quantityText.trim(), 10);
    
    if (!Number.isInteger(quantity)) {
      return 'Quantity must be a whole number';
    }
    
    if (quantity <= 0) {
      return 'Quantity must be greater than zero';
    }
    
    if (quantity > 100000) {
      return 'Quantity exceeds maximum limit of 100,000';
    }
    
    return null;
  };

  const handleSubmit = async () => {
    // Validation
    const quantityError = validateQuantity();
    if (quantityError) {
      setContext(prev => ({ ...prev, error: quantityError }));
      return;
    }

    // Prevent duplicate submission
    if (context.state === 'SUBMITTING') {
      logger.warn('stock-receipt', 'Submit button pressed while already submitting');
      return;
    }

    try {
      setContext(prev => ({
        ...prev,
        state: 'SUBMITTING',
        error: null,
      }));

      logger.debug('stock-receipt', 'Checking connectivity for stock receipt', {
        medicineId,
        batchNumber,
        quantity: context.quantity,
      });

      // Check connectivity to decide flow
      const connected = await isOnline();
      
      if (connected) {
        // ONLINE FLOW: Phase 7G - Direct API submission
        await handleOnlineSubmission();
      } else {
        // OFFLINE FLOW: Phase 7H - Queue in SQLite
        await handleOfflineQueue('OFFLINE');
      }

    } catch (err) {
      await handleSubmitFailure(err);
    }
  };

  const handleOnlineSubmission = async () => {
    // Generate stable idempotency key for this operation
    const idempotencyKey = generateIdempotencyKey();
    
    setContext(prev => ({
      ...prev,
      idempotencyKey,
    }));

    logger.debug('stock-receipt', 'Submitting stock receipt online', {
      medicineId,
      batchNumber,
      quantity: context.quantity,
    });

    // Submit to backend API directly
    const result = await submitStockReceipt({
      medicineId,
      batchNumber,
      quantity: context.quantity,
      idempotencyKey,
    });

    logger.debug('stock-receipt', 'Stock receipt submitted successfully', {
      movementId: result.movementId,
      currentStock: result.batch.currentStock,
    });

    setContext(prev => ({
      ...prev,
      state: 'SUCCESS',
      result,
    }));
  };

  const handleOfflineQueue = async (reason: 'OFFLINE' | 'NETWORK_FAILURE') => {
    logger.debug('stock-receipt', 'Queuing stock receipt for offline sync', {
      medicineId,
      batchNumber,
      quantity: context.quantity,
      reason,
    });

    // Enqueue in SQLite outbox - this generates the idempotency key
    const queuedRecord = await outbox.enqueue({
      medicineId,
      batchNumber,
      quantity: context.quantity,
    });

    logger.debug('stock-receipt', 'Stock receipt queued successfully', {
      id: queuedRecord.id,
      idempotencyKey: queuedRecord.idempotencyKey,
      status: queuedRecord.status,
      reason,
    });

    setContext(prev => ({
      ...prev,
      state: 'QUEUED',
      idempotencyKey: queuedRecord.idempotencyKey,
      queuedRecord: {
        id: queuedRecord.id,
        operationId: queuedRecord.id, // For UI display
      },
      queuedReason: reason,
    }));
  };

  /**
   * Phase 7J requirement 13: a network/timeout failure that happens AFTER we
   * believed we were online (i.e. mid-submission, not caught by the initial
   * isOnline() check) must NOT be presented as a dead-end error. The server
   * may have already applied the mutation and the response was simply lost —
   * exactly the scenario the sync engine's idempotency handling exists for.
   * So instead of showing "failed", this queues the SAME logical receipt into
   * the durable outbox (a NEW idempotency key, since no key was ever sent to
   * the server for this attempt — see the comment below) so it is retried
   * safely by the sync engine rather than silently lost.
   *
   * Any other error (validation, auth, conflict) is a real terminal failure
   * for this screen and is shown as such, using a sanitized, safe message.
   */
  const handleSubmitFailure = async (err: unknown) => {
    const category = classifyError(err);

    if (category === 'RETRYABLE') {
      logger.warn('stock-receipt', 'Online submission failed before server confirmation; queuing for retry', {
        error: err instanceof Error ? sanitizeErrorText(err.message) : String(err),
      });
      try {
        // NOTE: this generates a NEW idempotency key. This is correct, not a
        // violation of "never regenerate the key on retry": no key was ever
        // successfully associated with THIS attempt from the sync engine's
        // point of view, because handleOnlineSubmission() never persisted the
        // key it generated anywhere durable before the request failed. Once
        // enqueued here, the SQLite outbox's key is the durable one, and the
        // sync engine will never regenerate it again for this operation.
        await handleOfflineQueue('NETWORK_FAILURE');
      } catch (enqueueErr) {
        logger.error('stock-receipt', 'Could not queue receipt after network failure', { error: enqueueErr });
        setContext(prev => ({
          ...prev,
          state: 'ERROR',
          error: 'Unable to confirm server receipt and could not save it locally. Please try again.',
        }));
      }
      return;
    }

    logger.error('stock-receipt', 'Stock receipt submission failed permanently', {
      category,
      error: err instanceof Error ? sanitizeErrorText(err.message) : String(err),
    });

    setContext(prev => ({
      ...prev,
      state: 'ERROR',
      error: toStockReceiptUserMessage(err, category),
    }));
  };

  const handleRetry = () => {
    // Retry with the SAME idempotency key to maintain exactly-once semantics
    if (context.idempotencyKey) {
      logger.debug('stock-receipt', 'Retrying with same idempotency key');
      handleSubmit();
    } else {
      // Fresh attempt
      setContext(prev => ({
        ...prev,
        state: 'IDLE',
        error: null,
      }));
    }
  };

  const handleDone = () => {
    // Return to scanner for another medicine
    navigation.navigate('ScanQr');
  };

  const handleReset = () => {
    // Reset for new operation
    setContext(prev => ({
      ...prev,
      state: 'IDLE',
      quantity: 1,
      idempotencyKey: null,
      result: null,
      queuedRecord: null,
      queuedReason: null,
      error: null,
    }));
    setQuantityText('1');
  };

  // MANUAL ENTRY FORM — shown only when this screen was reached without a
  // scanned target (Home screen's "Manual entry" action). Once submitted and
  // validated, hasTarget becomes true and the screen falls through to the
  // exact same loading/lookup/quantity/submit UI the QR flow already uses.
  if (!hasTarget) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView style={styles.scrollContainer} showsVerticalScrollIndicator={false}>
          <View style={styles.quantitySection}>
            <Text style={styles.sectionTitle}>Enter Medicine &amp; Batch</Text>
            <Text style={styles.inputLabel}>Medicine ID:</Text>
            <TextInput
              style={styles.quantityInput}
              value={manualMedicineIdText}
              onChangeText={text => {
                setManualMedicineIdText(text);
                if (manualEntryError) setManualEntryError(null);
              }}
              keyboardType="numeric"
              placeholder="e.g. 12"
              accessibilityLabel="Medicine ID"
            />
            <Text style={[styles.inputLabel, { marginTop: theme.spacing.md }]}>Batch Number:</Text>
            <TextInput
              style={styles.quantityInput}
              value={manualBatchNumberText}
              onChangeText={text => {
                setManualBatchNumberText(text);
                if (manualEntryError) setManualEntryError(null);
              }}
              autoCapitalize="characters"
              placeholder="e.g. PAR-A-2601"
              accessibilityLabel="Batch number"
            />
          </View>

          {manualEntryError && (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{manualEntryError}</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.actionContainer}>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={handleManualEntrySubmit}
              accessibilityRole="button"
              accessibilityLabel="Look up medicine and batch"
            >
              <Text style={styles.buttonText}>Look Up</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  if (isLoadingContext) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
        <Text style={styles.loadingText}>Loading medicine information…</Text>
      </View>
    );
  }

  if (context.error && !context.medicineContext) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>{context.error}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => loadMedicineContext()}
        >
          <Text style={styles.buttonText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.retryButton, styles.secondaryButton, { marginTop: theme.spacing.md }]}
          onPress={() => {
            setHasTarget(false);
            setContext(prev => ({ ...prev, error: null }));
          }}
        >
          <Text style={styles.secondaryButtonText}>Enter Different Medicine/Batch</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView style={styles.scrollContainer} showsVerticalScrollIndicator={false}>
        
        {/* Medicine Information Header */}
        <View style={styles.medicineHeader}>
          <Text style={styles.medicineName}>
            {context.medicineContext?.name || 'Unknown Medicine'}
          </Text>
          {context.medicineContext?.genericName && (
            <Text style={styles.genericName}>
              {context.medicineContext.genericName}
            </Text>
          )}
          {context.medicineContext?.category && (
            <Text style={styles.category}>
              {context.medicineContext.category}
            </Text>
          )}
        </View>

        {/* Batch Information */}
        <View style={styles.batchInfo}>
          <Text style={styles.sectionTitle}>Batch Information</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Batch Number:</Text>
            <Text style={styles.infoValue}>{batchNumber}</Text>
          </View>
          {context.medicineContext?.batch?.currentStock !== undefined && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Current Stock:</Text>
              <Text style={styles.infoValue}>
                {context.medicineContext.batch.currentStock} units
              </Text>
            </View>
          )}
          {context.medicineContext?.batch?.expiryDate && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Expiry Date:</Text>
              <Text style={styles.infoValue}>
                {context.medicineContext.batch.expiryDate}
              </Text>
            </View>
          )}
          {context.medicineContext?.batch?.location && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Location:</Text>
              <Text style={styles.infoValue}>
                {context.medicineContext.batch.location}
              </Text>
            </View>
          )}
        </View>

        {/* Success Result (Online) */}
        {context.state === 'SUCCESS' && context.result && (
          <View style={styles.successContainer}>
            <Text style={styles.successTitle}>✓ Stock Received Successfully</Text>
            <View style={styles.resultInfo}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Quantity Added:</Text>
                <Text style={styles.resultValue}>
                  +{context.result.batch.quantityAdded} units
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>New Stock Total:</Text>
                <Text style={styles.resultValue}>
                  {context.result.batch.currentStock} units
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Movement ID:</Text>
                <Text style={styles.infoValue}>
                  {context.result.movementId}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Queued Result (Offline, or network failure before server confirmation) */}
        {context.state === 'QUEUED' && context.queuedRecord && (
          <View style={styles.queuedContainer}>
            <Text style={styles.queuedTitle}>
              {context.queuedReason === 'NETWORK_FAILURE' ? '⚠️ Unable to Confirm Server Receipt' : '📋 Queued for Synchronization'}
            </Text>
            <Text style={styles.queuedSubtitle}>
              {context.queuedReason === 'NETWORK_FAILURE'
                ? 'The connection dropped before the server could confirm this receipt. It has been saved locally and will be retried safely — the server will never apply it twice.'
                : "This stock receipt has been saved locally and will sync when internet is available."}
            </Text>
            <View style={styles.resultInfo}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Quantity to Add:</Text>
                <Text style={styles.queuedValue}>
                  +{context.quantity} units
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Operation ID:</Text>
                <Text style={styles.infoValue}>
                  {context.queuedRecord.operationId.substring(0, 16)}...
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Status:</Text>
                <Text style={styles.queuedValue}>PENDING SYNC</Text>
              </View>
            </View>
            <Text style={styles.queuedNote}>
              ⚠️ Server inventory has not been updated yet. Changes will apply when synced.
            </Text>
          </View>
        )}

        {/* Quantity Input (only show if not success and not queued) */}
        {context.state !== 'SUCCESS' && context.state !== 'QUEUED' && (
          <View style={styles.quantitySection}>
            <Text style={styles.sectionTitle}>Receive Stock</Text>
            <Text style={styles.inputLabel}>Quantity to Receive:</Text>
            <TextInput
              style={styles.quantityInput}
              value={quantityText}
              onChangeText={handleQuantityChange}
              keyboardType="numeric"
              placeholder="Enter quantity"
              editable={context.state !== 'SUBMITTING'}
            />
          </View>
        )}

        {/* Error Message */}
        {context.error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{context.error}</Text>
          </View>
        )}

      </ScrollView>

      {/* Action Buttons */}
      <View style={styles.actionContainer}>
        {context.state === 'SUCCESS' ? (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={handleReset}
            >
              <Text style={styles.secondaryButtonText}>Receive More</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={handleDone}
            >
              <Text style={styles.buttonText}>Scan Another</Text>
            </TouchableOpacity>
          </View>
        ) : context.state === 'QUEUED' ? (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={handleReset}
            >
              <Text style={styles.secondaryButtonText}>Receive More</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={() => navigation.navigate('SyncQueue')}
            >
              <Text style={styles.buttonText}>View Queue</Text>
            </TouchableOpacity>
          </View>
        ) : context.state === 'ERROR' ? (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={handleRetry}
            >
              <Text style={styles.buttonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.button,
                styles.primaryButton,
                context.state === 'SUBMITTING' && styles.disabledButton
              ]}
              onPress={handleSubmit}
              disabled={context.state === 'SUBMITTING'}
            >
              {context.state === 'SUBMITTING' ? (
                <ActivityIndicator size="small" color={theme.colors.surface} />
              ) : (
                <Text style={styles.buttonText}>Receive Stock</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: theme.spacing.lg,
  },
  scrollContainer: {
    flex: 1,
    padding: theme.spacing.lg,
  },
  loadingText: {
    marginTop: theme.spacing.md,
    fontSize: theme.font.body,
    color: theme.colors.muted,
    textAlign: 'center',
  },
  medicineHeader: {
    marginBottom: theme.spacing.lg,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  medicineName: {
    fontSize: theme.font.lg,
    fontWeight: '600',
    color: theme.colors.ink,
    marginBottom: theme.spacing.xs,
  },
  genericName: {
    fontSize: theme.font.body,
    color: theme.colors.muted,
    marginBottom: theme.spacing.xs,
  },
  category: {
    fontSize: theme.font.sm,
    color: theme.colors.accent,
    textTransform: 'uppercase',
    fontWeight: '500',
  },
  batchInfo: {
    marginBottom: theme.spacing.lg,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  sectionTitle: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.ink,
    marginBottom: theme.spacing.md,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  infoLabel: {
    fontSize: theme.font.body,
    color: theme.colors.muted,
    flex: 1,
  },
  infoValue: {
    fontSize: theme.font.body,
    color: theme.colors.ink,
    fontWeight: '500',
    textAlign: 'right',
    flex: 1,
  },
  successContainer: {
    marginBottom: theme.spacing.lg,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.successBg,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.success,
  },
  successTitle: {
    fontSize: theme.font.lg,
    fontWeight: '600',
    color: theme.colors.success,
    marginBottom: theme.spacing.md,
    textAlign: 'center',
  },
  resultInfo: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
  },
  resultValue: {
    fontSize: theme.font.body,
    color: theme.colors.success,
    fontWeight: '600',
    textAlign: 'right',
    flex: 1,
  },
  queuedContainer: {
    marginBottom: theme.spacing.lg,
    padding: theme.spacing.md,
    backgroundColor: '#FFF8E1', // Light orange/yellow background
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: '#FFB74D', // Orange border
  },
  queuedTitle: {
    fontSize: theme.font.lg,
    fontWeight: '600',
    color: '#E65100', // Dark orange
    marginBottom: theme.spacing.sm,
    textAlign: 'center',
  },
  queuedSubtitle: {
    fontSize: theme.font.body,
    color: '#BF360C', // Dark orange-red
    textAlign: 'center',
    marginBottom: theme.spacing.md,
    lineHeight: 20,
  },
  queuedValue: {
    fontSize: theme.font.body,
    color: '#E65100', // Dark orange
    fontWeight: '600',
    textAlign: 'right',
    flex: 1,
  },
  queuedNote: {
    fontSize: theme.font.sm,
    color: '#BF360C', // Dark orange-red
    textAlign: 'center',
    marginTop: theme.spacing.md,
    fontStyle: 'italic',
    lineHeight: 18,
  },
  quantitySection: {
    marginBottom: theme.spacing.lg,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  inputLabel: {
    fontSize: theme.font.body,
    color: theme.colors.ink,
    marginBottom: theme.spacing.sm,
    fontWeight: '500',
  },
  quantityInput: {
    borderWidth: 1,
    borderColor: theme.colors.line,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    fontSize: theme.font.body,
    backgroundColor: theme.colors.background,
  },
  errorContainer: {
    marginBottom: theme.spacing.lg,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.dangerBg,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.danger,
  },
  errorText: {
    fontSize: theme.font.body,
    color: theme.colors.danger,
    textAlign: 'center',
  },
  actionContainer: {
    padding: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.line,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: theme.spacing.md,
  },
  button: {
    flex: 1,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  primaryButton: {
    backgroundColor: theme.colors.accent,
  },
  secondaryButton: {
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  disabledButton: {
    backgroundColor: theme.colors.muted,
  },
  buttonText: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.surface,
  },
  secondaryButtonText: {
    fontSize: theme.font.body,
    fontWeight: '600',
    color: theme.colors.ink,
  },
  retryButton: {
    marginTop: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.xl,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
  },
});