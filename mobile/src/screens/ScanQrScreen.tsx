/**
 * Phase 7F — MediIndex Mobile QR Scanner
 *
 * QR scanner with camera permissions, barcode scanning, and authoritative lookup.
 * Reuses existing MediIndex QR format and performs server validation.
 * 
 * Flow:
 * 1. Request camera permission
 * 2. Show camera preview with scanning overlay
 * 3. Parse scanned QR using existing backend semantics
 * 4. Perform authenticated lookup via POST /api/mobile/qr/lookup
 * 5. Display authoritative results with navigation to Stock Receipt
 */

import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, PermissionStatus } from 'expo-camera';
import type { BarcodeScanningResult } from 'expo-camera';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { theme } from '../components/theme';
import { logger } from '../utils/logger';
import { parseAndValidateQrPayload, looksLikeMediIndexQR, QRParseError } from '../utils/qrParser';
import { lookupQrCode } from '../api/qrLookup';
import { ApiError } from '../api/errors';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { QrLookupResponse } from '../types/api';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ScanQr'>;

type ScanState = 'REQUESTING_PERMISSION' | 'PERMISSION_DENIED' | 'SCANNING' | 'PROCESSING' | 'RESULT' | 'ERROR';

interface ScanQrScreenState {
  scanState: ScanState;
  permissionStatus: PermissionStatus | null;
  lookupResult: QrLookupResponse | null;
  errorMessage: string | null;
  scannedData: string | null;
  scanLocked: boolean; // Prevent duplicate scans
}

export function ScanQrScreen() {
  const navigation = useNavigation<Nav>();

  // expo-camera's public permission API is the `useCameraPermissions` hook
  // (there is no longer a standalone exported `requestPermissionsAsync`, as
  // expo-barcode-scanner had). `requestCameraPermission` here is the hook's
  // own imperative request function — same permission model, same underlying
  // OS permission, just obtained through the current package's real API.
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [state, setState] = React.useState<ScanQrScreenState>({
    scanState: 'REQUESTING_PERMISSION',
    permissionStatus: null,
    lookupResult: null,
    errorMessage: null,
    scannedData: null,
    scanLocked: false,
  });

  const requestPermission = React.useCallback(async () => {
    setState(prev => ({ ...prev, scanState: 'REQUESTING_PERMISSION' }));

    try {
      const response = await requestCameraPermission();
      const status = response.status;
      setState(prev => ({ ...prev, permissionStatus: status }));

      if (status === PermissionStatus.GRANTED) {
        setState(prev => ({ ...prev, scanState: 'SCANNING', scanLocked: false }));
      } else {
        setState(prev => ({ ...prev, scanState: 'PERMISSION_DENIED' }));
      }
    } catch (err) {
      logger.error('scanner', 'Permission request failed', { error: err });
      setState(prev => ({ 
        ...prev, 
        scanState: 'ERROR', 
        errorMessage: 'Failed to request camera permission.' 
      }));
    }
  }, [requestCameraPermission]);

  const openSettings = React.useCallback(() => {
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:');
    } else {
      Linking.openSettings();
    }
  }, []);

  const handleBarCodeScanned = React.useCallback(async ({ data }: BarcodeScanningResult) => {
    // Duplicate scan protection
    if (state.scanLocked) {
      logger.debug('scanner', 'Ignoring duplicate scan event');
      return;
    }

    // Quick filter for non-MediIndex QR codes
    if (!looksLikeMediIndexQR(data)) {
      logger.debug('scanner', 'Scanned data does not look like MediIndex QR code');
      return;
    }

    // Lock scanner to prevent duplicate requests
    setState(prev => ({ ...prev, scanLocked: true, scanState: 'PROCESSING', scannedData: data }));
    logger.debug('scanner', 'Processing scanned QR code');

    try {
      // Parse QR payload using backend semantics
      const parsedQR = parseAndValidateQrPayload(data);
      logger.debug('scanner', 'QR parsed successfully', { medicineId: parsedQR.medicineId });

      // Perform authoritative lookup
      const lookupResult = await lookupQrCode(parsedQR);
      logger.debug('scanner', 'QR lookup completed', { valid: lookupResult.valid });

      setState(prev => ({
        ...prev,
        scanState: 'RESULT',
        lookupResult,
        errorMessage: null,
      }));
    } catch (err) {
      let errorMessage = 'An unexpected error occurred.';
      
      if (err instanceof QRParseError) {
        errorMessage = err.message;
        logger.debug('scanner', 'QR parse error', { error: err.message });
      } else if (err instanceof ApiError) {
        if (err.isAuthFailure) {
          // Auth failures are handled centrally by the API client
          // This should trigger navigation back to pairing
          errorMessage = 'Device authentication failed. Please pair your device again.';
        } else if (err.kind === 'NETWORK') {
          errorMessage = 'Internet connection required to verify this medicine.';
        } else if (err.kind === 'TIMEOUT') {
          errorMessage = 'Request timed out. Please try again.';
        } else {
          errorMessage = err.message;
        }
        logger.warn('scanner', 'API error during lookup', { kind: err.kind, message: err.message });
      } else {
        logger.error('scanner', 'Unexpected error during QR processing', { error: err });
      }

      setState(prev => ({
        ...prev,
        scanState: 'ERROR',
        errorMessage,
        lookupResult: null,
      }));
    }
  }, [state.scanLocked]);

  const resetScanner = React.useCallback(() => {
    setState(prev => ({
      ...prev,
      scanState: 'SCANNING',
      scanLocked: false,
      lookupResult: null,
      errorMessage: null,
      scannedData: null,
    }));
  }, []);

  const navigateToStockReceipt = React.useCallback(() => {
    if (state.lookupResult?.valid && state.lookupResult.medicine && state.lookupResult.batch) {
      navigation.navigate('StockReceipt', {
        medicineId: state.lookupResult.medicine.id,
        batchNumber: state.lookupResult.batch.batchNumber,
      });
    }
  }, [navigation, state.lookupResult]);

  // Request permission on mount
  React.useEffect(() => {
    void requestPermission();
  }, [requestPermission]);

  // Render permission request state
  if (state.scanState === 'REQUESTING_PERMISSION') {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
        <Text style={styles.statusText}>Requesting camera permission…</Text>
      </View>
    );
  }

  // Render permission denied state
  if (state.scanState === 'PERMISSION_DENIED') {
    return (
      <View style={styles.centerContainer}>
        <View style={styles.messageCard}>
          <Text style={styles.messageTitle}>Camera Permission Required</Text>
          <Text style={styles.messageText}>
            MediIndex needs camera access to scan QR codes on medicine packaging.
          </Text>
          <View style={styles.buttonContainer}>
            <Pressable
              style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
              onPress={requestPermission}
            >
              <Text style={styles.primaryButtonText}>Grant Permission</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed]}
              onPress={openSettings}
            >
              <Text style={styles.secondaryButtonText}>Open Settings</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // Render scanning state
  if (state.scanState === 'SCANNING') {
    return (
      <View style={styles.scanContainer}>
        <CameraView
          style={styles.camera}
          facing="back"
          // Only QR is enabled — this app never needs to recognise product
          // barcodes (EAN/UPC/etc.), so no other symbology is turned on.
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          // Duplicate-scan protection (requirement #8) is enforced inside
          // handleBarCodeScanned via `state.scanLocked`, exactly as before —
          // the camera component itself only detects/decodes, matching
          // requirement #4 ("the camera should only detect/decode the QR
          // payload"; validation/business logic stays in qrParser/qrLookup).
          onBarcodeScanned={handleBarCodeScanned}
        />
        <View style={styles.overlay}>
          <View style={styles.scanningFrame}>
            <View style={[styles.corner, styles.cornerTopLeft]} />
            <View style={[styles.corner, styles.cornerTopRight]} />
            <View style={[styles.corner, styles.cornerBottomLeft]} />
            <View style={[styles.corner, styles.cornerBottomRight]} />
          </View>
          <View style={styles.instructionsContainer}>
            <Text style={styles.instructionsTitle}>Scan Medicine QR Code</Text>
            <Text style={styles.instructionsText}>
              Position the QR code within the frame. Only MediIndex QR codes will be recognized.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  // Render processing state
  if (state.scanState === 'PROCESSING') {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
        <Text style={styles.statusText}>Verifying medicine information…</Text>
      </View>
    );
  }

  // Render error state
  if (state.scanState === 'ERROR') {
    return (
      <View style={styles.centerContainer}>
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Scan Error</Text>
          <Text style={styles.errorMessage}>{state.errorMessage}</Text>
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
            onPress={resetScanner}
          >
            <Text style={styles.primaryButtonText}>Try Again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Render result state
  if (state.scanState === 'RESULT' && state.lookupResult) {
    const { lookupResult } = state;
    
    if (!lookupResult.valid) {
      return (
        <View style={styles.centerContainer}>
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Medicine Not Found</Text>
            <Text style={styles.errorMessage}>
              {lookupResult.error || 'The scanned QR code does not correspond to a medicine in this pharmacy.'}
            </Text>
            <Pressable
              style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
              onPress={resetScanner}
            >
              <Text style={styles.primaryButtonText}>Scan Again</Text>
            </Pressable>
          </View>
        </View>
      );
    }

    const { medicine, batch } = lookupResult;
    
    return (
      <View style={styles.resultContainer}>
        <View style={styles.resultCard}>
          <Text style={styles.resultTitle}>Medicine Verified</Text>
          
          {medicine && (
            <View style={styles.infoSection}>
              <Text style={styles.sectionTitle}>Medicine Information</Text>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Name</Text>
                <Text style={styles.infoValue}>{medicine.name}</Text>
              </View>
              {medicine.genericName && (
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Generic Name</Text>
                  <Text style={styles.infoValue}>{medicine.genericName}</Text>
                </View>
              )}
              {medicine.manufacturer && (
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Manufacturer</Text>
                  <Text style={styles.infoValue}>{medicine.manufacturer}</Text>
                </View>
              )}
              {medicine.category && (
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Category</Text>
                  <Text style={styles.infoValue}>{medicine.category}</Text>
                </View>
              )}
            </View>
          )}

          {batch && (
            <View style={styles.infoSection}>
              <Text style={styles.sectionTitle}>Batch Information</Text>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Batch Number</Text>
                <Text style={styles.infoValue}>{batch.batchNumber}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Current Stock</Text>
                <Text style={styles.infoValue}>{batch.quantity} units</Text>
              </View>
              {batch.expiryDate && (
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Expiry Date</Text>
                  <View style={styles.expiryContainer}>
                    <Text style={styles.infoValue}>{batch.expiryDate}</Text>
                    {batch.expiryStatus && (
                      <View style={[
                        styles.statusBadge, 
                        batch.expiryStatus === 'EXPIRED' && styles.statusExpired,
                        batch.expiryStatus === 'NEAR_EXPIRY' && styles.statusNearExpiry,
                        batch.expiryStatus === 'VALID' && styles.statusValid,
                      ]}>
                        <Text style={[
                          styles.expiryStatusText, 
                          batch.expiryStatus === 'EXPIRED' && styles.statusTextExpired,
                          batch.expiryStatus === 'NEAR_EXPIRY' && styles.statusTextNearExpiry,
                          batch.expiryStatus === 'VALID' && styles.statusTextValid,
                        ]}>
                          {batch.expiryStatus === 'EXPIRED' ? 'Expired' :
                           batch.expiryStatus === 'NEAR_EXPIRY' ? 'Near Expiry' : 'Valid'}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              )}
              {batch.location && (
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Location</Text>
                  <Text style={styles.infoValue}>{batch.location}</Text>
                </View>
              )}
            </View>
          )}
          
          <Text style={styles.verifiedText}>✓ Information verified by server</Text>
        </View>

        <View style={styles.buttonContainer}>
          <Pressable
            style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
            onPress={navigateToStockReceipt}
          >
            <Text style={styles.primaryButtonText}>Continue to Stock Receipt</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed]}
            onPress={resetScanner}
          >
            <Text style={styles.secondaryButtonText}>Scan Again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.background,
  },
  scanContainer: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanningFrame: {
    width: 250,
    height: 250,
    backgroundColor: 'transparent',
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: '#ffffff',
    borderWidth: 3,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderRightWidth: 0,
    borderTopWidth: 0,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderLeftWidth: 0,
    borderTopWidth: 0,
  },
  instructionsContainer: {
    position: 'absolute',
    bottom: 100,
    left: theme.spacing.lg,
    right: theme.spacing.lg,
  },
  instructionsTitle: {
    fontSize: theme.font.lg,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  instructionsText: {
    fontSize: theme.font.sm,
    color: '#ffffff',
    textAlign: 'center',
    opacity: 0.9,
    lineHeight: 20,
  },
  messageCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    maxWidth: 320,
    alignItems: 'center',
  },
  messageTitle: {
    fontSize: theme.font.lg,
    fontWeight: '700',
    color: theme.colors.ink,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  messageText: {
    fontSize: theme.font.sm,
    color: theme.colors.muted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: theme.spacing.lg,
  },
  errorCard: {
    backgroundColor: theme.colors.dangerBg,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    maxWidth: 320,
    alignItems: 'center',
  },
  errorTitle: {
    fontSize: theme.font.lg,
    fontWeight: '700',
    color: theme.colors.danger,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  errorMessage: {
    fontSize: theme.font.sm,
    color: theme.colors.danger,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: theme.spacing.lg,
  },
  statusText: {
    fontSize: theme.font.sm,
    color: theme.colors.muted,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
  },
  resultContainer: {
    flex: 1,
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.background,
  },
  resultCard: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
  },
  resultTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: theme.colors.success,
    textAlign: 'center',
    marginBottom: theme.spacing.lg,
  },
  infoSection: {
    marginBottom: theme.spacing.lg,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.accentDark,
    letterSpacing: 0.5,
    marginBottom: theme.spacing.sm,
    textTransform: 'uppercase',
  },
  infoRow: {
    paddingVertical: theme.spacing.sm,
    borderBottomColor: theme.colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  infoLabel: {
    fontSize: 12,
    color: theme.colors.muted,
    fontWeight: '600',
    marginBottom: 2,
  },
  infoValue: {
    fontSize: theme.font.body,
    color: theme.colors.ink,
  },
  expiryContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statusBadge: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 4,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
  },
  statusExpired: {
    backgroundColor: theme.colors.dangerBg,
    borderColor: theme.colors.danger,
  },
  statusNearExpiry: {
    backgroundColor: '#FFF3CD',
    borderColor: '#FFEEBA',
  },
  statusValid: {
    backgroundColor: theme.colors.successBg,
    borderColor: theme.colors.success,
  },
  expiryStatusText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statusTextExpired: {
    color: theme.colors.danger,
  },
  statusTextNearExpiry: {
    color: '#856404',
  },
  statusTextValid: {
    color: theme.colors.success,
  },
  verifiedText: {
    fontSize: theme.font.sm,
    color: theme.colors.success,
    textAlign: 'center',
    fontWeight: '600',
    marginTop: theme.spacing.md,
  },
  buttonContainer: {
    gap: theme.spacing.md,
    paddingTop: theme.spacing.md,
  },
  primaryButton: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  primaryButtonPressed: {
    backgroundColor: theme.colors.accentDark,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: theme.font.body,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.line,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  secondaryButtonPressed: {
    backgroundColor: theme.colors.accentBg,
  },
  secondaryButtonText: {
    color: theme.colors.accent,
    fontSize: theme.font.body,
    fontWeight: '700',
  },
});