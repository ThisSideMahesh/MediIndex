/**
 * Settings / diagnostics screen — Phase 7D authentication state.
 *
 * Shows whether this device is paired and authenticated against the server.
 * Authentication status is checked each time the screen gains focus, so revoked
 * devices are discovered promptly.
 *
 * What is deliberately NOT here:
 *  - The device token. It is never read for display and never rendered.
 *  - A server-side revoke call. The backend's revoke operation requires an
 *    ADMIN web session, not a device token.
 */

import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { theme } from '../components/theme';
import { config } from '../config/env';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { unpairDevice } from '../api/devicePairing';
import { verifyStoredDevice } from '../auth/deviceVerification';
import type { DeviceIdentity } from '../auth/authState';
import { SECURE_STORE_IMPLEMENTED } from '../storage/secureStore';
import { OUTBOX_IMPLEMENTED } from '../storage/outbox';
import { SYNC_ENGINE_IMPLEMENTED } from '../sync/syncEngine';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Settings'>;

type AuthStatus = 'checking' | 'authenticated' | 'unpaired' | 'auth_error';

export function SettingsScreen() {
  const navigation = useNavigation<Nav>();
  const [authStatus, setAuthStatus] = React.useState<AuthStatus>('checking');
  const [identity, setIdentity] = React.useState<DeviceIdentity | null>(null);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const [unpairing, setUnpairing] = React.useState(false);

  const checkAuthStatus = React.useCallback(async () => {
    setAuthStatus('checking');
    setAuthError(null);
    setIdentity(null);

    const result = await verifyStoredDevice();
    if (result.success) {
      setAuthStatus('authenticated');
      setIdentity(result.identity);
    } else if (result.reason === 'no_credential' || result.reason === 'auth_invalid') {
      setAuthStatus('unpaired');
    } else {
      setAuthStatus('auth_error');
      setAuthError(result.error || 'Authentication check failed.');
    }
  }, []);

  // Re-check auth status when the screen gains focus
  useFocusEffect(
    React.useCallback(() => {
      void checkAuthStatus();
    }, [checkAuthStatus]),
  );

  const performUnpair = React.useCallback(async () => {
    setUnpairing(true);
    try {
      await unpairDevice();
      setAuthStatus('unpaired');
      setIdentity(null);
      navigation.reset({ index: 0, routes: [{ name: 'PairDevice' }] });
    } catch (err) {
      Alert.alert(
        'Could not unpair',
        err instanceof Error ? err.message : 'The stored credential could not be removed.',
      );
    } finally {
      setUnpairing(false);
    }
  }, [navigation]);

  const confirmUnpair = React.useCallback(() => {
    Alert.alert(
      'Unpair this device?',
      'The stored credential will be deleted from this device and it will stop being able to submit stock. '
        + 'You will need a new pairing code to set it up again.\n\n'
        + 'This does not revoke the device on the server — ask a pharmacy administrator to revoke it in MediIndex if the device is lost or reassigned.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unpair', style: 'destructive', onPress: () => void performUnpair() },
      ],
    );
  }, [performUnpair]);

  const pairingRows: Array<[string, string]> = (() => {
    if (authStatus === 'checking') return [['Status', 'Checking…']];
    if (authStatus === 'auth_error') return [['Status', 'Authentication error']];
    if (authStatus === 'unpaired') return [['Status', 'Not paired']];
    if (authStatus === 'authenticated' && identity) {
      return [
        ['Status', 'Paired and authenticated'],
        ['Pharmacy', identity.pharmacyName],
        ...(identity.pharmacyAddress ? ([['Address', identity.pharmacyAddress]] as Array<[string, string]>) : []),
        ['Device name', identity.deviceName],
        ['Device number', `#${identity.deviceId}`],
        ['Last verified', new Date().toLocaleTimeString()],
      ];
    }
    return [['Status', 'Unknown']];
  })();

  const diagnosticRows: Array<[string, string]> = [
    ['API base URL', config.apiBaseUrl],
    ['URL source', config.apiBaseUrlFromEnv ? 'EXPO_PUBLIC_MOBILE_API_BASE_URL' : 'built-in default'],
    ['Request timeout', `${config.requestTimeoutMs} ms`],
    ['Debug logging', config.debugLogging ? 'on' : 'off'],
    ['Secure storage', SECURE_STORE_IMPLEMENTED ? 'ready' : 'pending'],
    ['Offline outbox', OUTBOX_IMPLEMENTED ? 'ready' : 'pending (Phase 7H)'],
    ['Sync engine', SYNC_ENGINE_IMPLEMENTED ? 'ready' : 'pending (Phase 7I)'],
  ];

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <Text style={styles.sectionHeading}>Authentication</Text>
      <View style={styles.card}>
        {pairingRows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={styles.rowValue}>{value}</Text>
          </View>
        ))}
      </View>

      {authStatus === 'auth_error' && authError && (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{authError}</Text>
          <Pressable
            style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
            onPress={checkAuthStatus}
            accessibilityRole="button"
            accessibilityLabel="Retry authentication check"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      )}

      {authStatus === 'authenticated' ? (
        <>
          <Pressable
            style={({ pressed }) => [
              styles.dangerButton,
              pressed && styles.dangerButtonPressed,
              unpairing && styles.dangerButtonDisabled,
            ]}
            onPress={confirmUnpair}
            disabled={unpairing}
            accessibilityRole="button"
            accessibilityLabel="Unpair this device"
            accessibilityHint="Deletes the stored credential from this device"
            accessibilityState={{ disabled: unpairing, busy: unpairing }}
          >
            <Text style={styles.dangerButtonText}>
              {unpairing ? 'Unpairing…' : 'Unpair this device'}
            </Text>
          </Pressable>
          <Text style={styles.note}>
            Unpairing removes the credential from this device only. To revoke the
            device on the server, a pharmacy administrator revokes it in the
            MediIndex web app.
          </Text>
        </>
      ) : authStatus === 'unpaired' ? (
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={() => navigation.navigate('PairDevice')}
          accessibilityRole="button"
          accessibilityLabel="Pair this device"
        >
          <Text style={styles.buttonText}>Pair this device</Text>
        </Pressable>
      ) : null}

      <Text style={styles.sectionHeading}>Diagnostics</Text>
      <View style={styles.card}>
        {diagnosticRows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={styles.rowValue}>{value}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.note}>
        The device credential is held in this device&apos;s secure storage and is
        never displayed, copied or logged.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg },
  title: { fontSize: theme.font.title, fontWeight: '700', color: theme.colors.ink },
  sectionHeading: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.accentDark,
    letterSpacing: 0.5,
    marginTop: theme.spacing.lg,
  },
  card: {
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.line,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
  },
  row: {
    paddingVertical: theme.spacing.sm + 2,
    borderBottomColor: theme.colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: 12, color: theme.colors.muted, fontWeight: '600' },
  rowValue: { fontSize: theme.font.body, color: theme.colors.ink, marginTop: 2 },
  button: {
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonPressed: { backgroundColor: theme.colors.accentDark },
  buttonText: { color: '#ffffff', fontSize: theme.font.body, fontWeight: '700' },
  dangerButton: {
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.danger,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  dangerButtonPressed: { backgroundColor: theme.colors.dangerBg },
  dangerButtonDisabled: { opacity: 0.6 },
  dangerButtonText: { color: theme.colors.danger, fontSize: theme.font.body, fontWeight: '700' },
  errorCard: {
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.dangerBg,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
  },
  errorText: { color: theme.colors.danger, fontSize: theme.font.sm, lineHeight: 20 },
  retryButton: {
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    alignSelf: 'flex-start',
  },
  retryButtonPressed: { backgroundColor: theme.colors.accentDark },
  retryButtonText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  note: {
    marginTop: theme.spacing.md,
    fontSize: 12,
    color: theme.colors.muted,
    fontStyle: 'italic',
    lineHeight: 18,
  },
});
