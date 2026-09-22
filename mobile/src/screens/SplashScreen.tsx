/**
 * Startup screen — server-authoritative device verification.
 *
 * Phase 7D lifecycle:
 *  1. Check SecureStore for a device credential
 *  2. If none: navigate to Pair Device
 *  3. If exists: verify against GET /api/mobile/auth/verify
 *  4. If server accepts: navigate to Home
 *  5. If server rejects: clear credential, navigate to Pair Device
 *  6. If network/server error: show auth error (do not unpair)
 *
 * The server is authoritative — a stored credential may be invalid/revoked.
 * Network failures do not automatically unpair the device.
 */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { theme } from '../components/theme';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { verifyStoredDevice, resolveAuthenticatedRoute } from '../auth/deviceVerification';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Splash'>;

type Phase = 'checking' | 'verifying' | 'error';

export function SplashScreen() {
  const navigation = useNavigation<Nav>();
  const [phase, setPhase] = React.useState<Phase>('checking');
  const [error, setError] = React.useState<string | null>(null);

  const performVerification = React.useCallback(async () => {
    setPhase('checking');
    setError(null);

    const result = await verifyStoredDevice();
    if (result.success || result.reason === 'no_credential') {
      // Success or no local credential: navigate immediately
      const route = resolveAuthenticatedRoute(result);
      navigation.reset({ index: 0, routes: [{ name: route }] });
      return;
    }

    if (result.reason === 'auth_invalid') {
      // Server rejected credential (it was cleared): go to pairing
      navigation.reset({ index: 0, routes: [{ name: 'PairDevice' }] });
      return;
    }

    // Network/server error: show error, allow retry
    setPhase('error');
    setError(result.error || 'Could not verify this device.');
  }, [navigation]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      // Brief delay so the splash is visible even on fast networks
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (cancelled) return;
      setPhase('verifying');
      await performVerification();
    })();
    return () => {
      cancelled = true;
    };
  }, [performVerification]);

  const retry = React.useCallback(() => {
    void performVerification();
  }, [performVerification]);

  if (phase === 'error') {
    return (
      <View style={styles.root}>
        <Text style={styles.title}>MediIndex</Text>
        <Text style={styles.subtitle}>Stock Entry</Text>

        <View style={styles.errorCard}>
          <Text style={styles.errorText}>Authentication Error</Text>
          <Text style={styles.errorMessage}>{error}</Text>
          <Pressable
            style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel="Retry device verification"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>MediIndex</Text>
      <Text style={styles.subtitle}>Stock Entry</Text>
      <ActivityIndicator
        style={styles.spinner}
        color={theme.colors.accent}
        accessibilityLabel={
          phase === 'checking'
            ? 'Checking for stored device credential'
            : 'Verifying device with server'
        }
      />
      <Text style={styles.status}>
        {phase === 'checking' ? 'Checking this device…' : 'Verifying with server…'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background },
  title: { fontSize: 32, fontWeight: '700', color: theme.colors.accentDark },
  subtitle: { fontSize: theme.font.body, color: theme.colors.muted, marginTop: theme.spacing.xs },
  spinner: { marginTop: theme.spacing.xl },
  status: { marginTop: theme.spacing.md, fontSize: theme.font.sm, color: theme.colors.muted },
  errorCard: {
    marginTop: theme.spacing.xl,
    backgroundColor: theme.colors.dangerBg,
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
    maxWidth: 300,
    alignItems: 'center',
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.font.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorMessage: {
    color: theme.colors.danger,
    fontSize: theme.font.sm,
    textAlign: 'center',
    marginTop: theme.spacing.sm,
    lineHeight: 20,
  },
  retryButton: {
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  retryButtonPressed: { backgroundColor: theme.colors.accentDark },
  retryButtonText: { color: '#ffffff', fontSize: theme.font.sm, fontWeight: '700' },
});
