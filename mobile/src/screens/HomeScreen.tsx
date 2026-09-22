/**
 * Phase 7E — MediIndex Mobile Home Dashboard
 *
 * The main navigation hub after successful device authentication. Displays
 * authoritative pharmacy and device information from the server, provides
 * quick actions for scanning and stock receipt, and handles loading/error states.
 *
 * Uses only verified data from GET /api/mobile/auth/verify. Does NOT display
 * fake inventory metrics or fabricated dashboard numbers.
 */

import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { theme } from '../components/theme';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { verifyStoredDevice } from '../auth/deviceVerification';
import { createAuthActions, INITIAL_AUTH_STATE } from '../auth/authState';
import type { AuthState, DeviceIdentity } from '../auth/authState';
import { apiClient } from '../api/client';
import { deviceCredentialStore } from '../storage/secureStore';
import { logger } from '../utils/logger';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>;

export function HomeScreen() {
  const navigation = useNavigation<Nav>();
  const [authState, setAuthState] = React.useState<AuthState>(INITIAL_AUTH_STATE);
  const [refreshing, setRefreshing] = React.useState(false);
  const actions = React.useMemo(() => createAuthActions(setAuthState), []);

  const loadData = React.useCallback(async () => {
    actions.startVerification();
    
    const result = await verifyStoredDevice();
    if (result.success) {
      actions.setAuthenticated(result.identity);
    } else if (result.reason === 'no_credential' || result.reason === 'auth_invalid') {
      // User should not reach Home if unpaired, but handle gracefully
      actions.setUnpaired();
      navigation.reset({ index: 0, routes: [{ name: 'PairDevice' }] });
    } else {
      // Network/server error: show error, allow retry
      actions.setAuthError(result.error || 'Could not load pharmacy information.');
    }
  }, [actions, navigation]);

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }, [loadData]);

  const retryLoad = React.useCallback(() => {
    void loadData();
  }, [loadData]);

  // Load data when screen gains focus
  useFocusEffect(
    React.useCallback(() => {
      void loadData();
    }, [loadData]),
  );

  // Set up centralized auth failure handling.
  //
  // NOTE on why this clears the credential itself (Phase 7K fix): the app-wide
  // handler is a single slot (see api/client.ts's `setAuthFailureHandler` doc
  // comment). The startup binding registers the
  // credential-clearing handler once at launch, but while Home is mounted this
  // effect intentionally replaces it so the app can also navigate straight
  // back to Pair Device rather than just updating local state. Because there
  // is only one slot, THIS handler must also clear the credential —
  // otherwise a rejected-credential response that arrives while Home is
  // mounted (e.g. from a background sync pass) would update Home's local
  // state and navigate, but leave the rejected credential in SecureStore,
  // where it would keep being sent (and keep being rejected) until the user
  // happened to reopen Settings or restart the app. Previously this effect
  // reset the slot to nothing on unmount, which was worse: after leaving
  // Home, no handler at all remained registered, so a later rejection
  // anywhere else silently cleared nothing. This effect no longer resets the
  // slot on unmount, so the original startup handler (or whichever screen's
  // handler was last registered) remains active rather than being replaced
  // with nothing.
  React.useEffect(() => {
    const handleAuthFailure = async () => {
      logger.warn('home', 'Authentication failed; clearing credential and redirecting to pairing');
      try {
        await deviceCredentialStore.clearCredential();
      } catch (err) {
        logger.warn('home', 'Could not clear the rejected device credential', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      actions.setUnpaired();
      navigation.reset({ index: 0, routes: [{ name: 'PairDevice' }] });
    };

    apiClient.setAuthFailureHandler(handleAuthFailure);
  }, [actions, navigation]);

  const navigateToScanQr = React.useCallback(() => {
    navigation.navigate('ScanQr');
  }, [navigation]);

  const navigateToStockReceipt = React.useCallback(() => {
    navigation.navigate('StockReceipt');
  }, [navigation]);

  const navigateToSettings = React.useCallback(() => {
    navigation.navigate('Settings');
  }, [navigation]);

  const navigateToSyncQueue = React.useCallback(() => {
    navigation.navigate('SyncQueue');
  }, [navigation]);

  if (authState.status === 'VERIFYING') {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator
          size="large"
          color={theme.colors.accent}
          accessibilityLabel="Loading pharmacy information"
        />
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }

  if (authState.status === 'AUTH_ERROR') {
    return (
      <View style={styles.centerContainer}>
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Connection Error</Text>
          <Text style={styles.errorMessage}>
            {authState.error || 'Could not load pharmacy information.'}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
            onPress={retryLoad}
            accessibilityRole="button"
            accessibilityLabel="Retry loading data"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (authState.status !== 'AUTHENTICATED' || !authState.identity) {
    // Should not happen in normal flow, but handle gracefully
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorMessage}>Authentication required</Text>
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={() => navigation.navigate('PairDevice')}
          accessibilityRole="button"
          accessibilityLabel="Go to device pairing"
        >
          <Text style={styles.buttonText}>Pair Device</Text>
        </Pressable>
      </View>
    );
  }

  const identity = authState.identity;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={theme.colors.accent}
          title="Pull to refresh"
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.appTitle}>MediIndex</Text>
        <Text style={styles.pharmacyName}>{identity.pharmacyName}</Text>
        <Text style={styles.statusText}>Device authenticated</Text>
      </View>

      {/* Quick Actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.actionGrid}>
          <Pressable
            style={({ pressed }) => [styles.actionCard, pressed && styles.actionCardPressed]}
            onPress={navigateToScanQr}
            accessibilityRole="button"
            accessibilityLabel="Scan medicine QR code"
          >
            <View style={styles.actionIcon}>
              <Text style={styles.actionIconText}>📱</Text>
            </View>
            <Text style={styles.actionTitle}>Scan Medicine</Text>
            <Text style={styles.actionSubtitle}>Scan QR codes</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.actionCard, pressed && styles.actionCardPressed]}
            onPress={navigateToStockReceipt}
            accessibilityRole="button"
            accessibilityLabel="Enter stock receipt"
          >
            <View style={styles.actionIcon}>
              <Text style={styles.actionIconText}>📋</Text>
            </View>
            <Text style={styles.actionTitle}>Stock Receipt</Text>
            <Text style={styles.actionSubtitle}>Manual entry</Text>
          </Pressable>
        </View>
      </View>

      {/* Sync Status Placeholder */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sync Status</Text>
        <View style={styles.card}>
          <Text style={styles.placeholderText}>
            Offline synchronization will appear here in Phase 7H/7I
          </Text>
          <Pressable
            style={({ pressed }) => [styles.linkButton, pressed && styles.linkButtonPressed]}
            onPress={navigateToSyncQueue}
            accessibilityRole="button"
            accessibilityLabel="View sync queue"
          >
            <Text style={styles.linkButtonText}>View Sync Queue →</Text>
          </Pressable>
        </View>
      </View>

      {/* Pharmacy & Device Info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Pharmacy & Device</Text>
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Pharmacy</Text>
            <Text style={styles.infoValue}>{identity.pharmacyName}</Text>
          </View>
          {identity.pharmacyAddress && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Address</Text>
              <Text style={styles.infoValue}>{identity.pharmacyAddress}</Text>
            </View>
          )}
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Device</Text>
            <Text style={styles.infoValue}>{identity.deviceName}</Text>
          </View>
          {identity.deviceModel && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Model</Text>
              <Text style={styles.infoValue}>{identity.deviceModel}</Text>
            </View>
          )}
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Status</Text>
            <Text style={[styles.infoValue, styles.statusAuthenticated]}>Authenticated</Text>
          </View>
        </View>
      </View>

      {/* Settings Link */}
      <View style={styles.section}>
        <Pressable
          style={({ pressed }) => [styles.settingsButton, pressed && styles.settingsButtonPressed]}
          onPress={navigateToSettings}
          accessibilityRole="button"
          accessibilityLabel="Open settings"
        >
          <Text style={styles.settingsButtonText}>Settings</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    padding: theme.spacing.lg,
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.spacing.lg,
    backgroundColor: theme.colors.background,
  },
  header: {
    alignItems: 'center',
    marginBottom: theme.spacing.xl,
  },
  appTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: theme.colors.accentDark,
    marginBottom: theme.spacing.xs,
  },
  pharmacyName: {
    fontSize: theme.font.lg,
    fontWeight: '600',
    color: theme.colors.ink,
    textAlign: 'center',
    marginBottom: theme.spacing.xs,
  },
  statusText: {
    fontSize: theme.font.sm,
    color: theme.colors.muted,
  },
  section: {
    marginBottom: theme.spacing.xl,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.accentDark,
    letterSpacing: 0.5,
    marginBottom: theme.spacing.sm,
    textTransform: 'uppercase',
  },
  actionGrid: {
    flexDirection: 'row',
    gap: theme.spacing.md,
  },
  actionCard: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.line,
    borderWidth: 1,
    borderRadius: theme.radius.lg,
    padding: theme.spacing.lg,
    alignItems: 'center',
    minHeight: 120,
    justifyContent: 'center',
  },
  actionCardPressed: {
    backgroundColor: theme.colors.accentBg,
    borderColor: theme.colors.accent,
  },
  actionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.colors.accentBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.sm,
  },
  actionIconText: {
    fontSize: 24,
  },
  actionTitle: {
    fontSize: theme.font.body,
    fontWeight: '700',
    color: theme.colors.ink,
    textAlign: 'center',
    marginBottom: theme.spacing.xs,
  },
  actionSubtitle: {
    fontSize: 12,
    color: theme.colors.muted,
    textAlign: 'center',
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.line,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
  },
  placeholderText: {
    fontSize: theme.font.sm,
    color: theme.colors.muted,
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  linkButton: {
    alignSelf: 'center',
  },
  linkButtonPressed: {
    opacity: 0.7,
  },
  linkButtonText: {
    fontSize: theme.font.sm,
    color: theme.colors.accent,
    fontWeight: '600',
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
  statusAuthenticated: {
    color: theme.colors.success,
    fontWeight: '600',
  },
  button: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonPressed: {
    backgroundColor: theme.colors.accentDark,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: theme.font.body,
    fontWeight: '700',
  },
  settingsButton: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.line,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  settingsButtonPressed: {
    backgroundColor: theme.colors.accentBg,
  },
  settingsButtonText: {
    color: theme.colors.accent,
    fontSize: theme.font.body,
    fontWeight: '700',
  },
  loadingText: {
    fontSize: theme.font.sm,
    color: theme.colors.muted,
    marginTop: theme.spacing.sm,
  },
  errorCard: {
    backgroundColor: theme.colors.dangerBg,
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
    maxWidth: 300,
    alignItems: 'center',
  },
  errorTitle: {
    color: theme.colors.danger,
    fontSize: theme.font.lg,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  errorMessage: {
    color: theme.colors.danger,
    fontSize: theme.font.sm,
    textAlign: 'center',
    marginBottom: theme.spacing.md,
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  retryButtonPressed: {
    backgroundColor: theme.colors.accentDark,
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: theme.font.sm,
    fontWeight: '700',
  },
});