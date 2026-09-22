/**
 * Pair Device screen.
 *
 * Exchanges the one-time pairing code issued by a pharmacy ADMIN for a device
 * token, via the existing POST /api/mobile/pairing/complete endpoint.
 *
 * Security properties this screen relies on:
 *  - It never sees the device token. `pairDevice()` stores the token in
 *    SecureStore and returns only the non-secret device/pharmacy identity, so
 *    there is nothing secret here to render, copy or log.
 *  - It never sends a pharmacy id. The server derives the pharmacy from the
 *    pairing code.
 *  - It performs no network call of its own; all traffic goes through the API
 *    layer (api/devicePairing.ts).
 */

import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { theme } from '../components/theme';
import type { RootStackParamList } from '../navigation/RootNavigator';
import {
  PairingError,
  normalizePairingCode,
  pairDevice,
  validateDeviceName,
  validatePairingCode,
  DEVICE_NAME_MAX_LENGTH,
  PAIRING_CODE_MAX_LENGTH,
} from '../api/devicePairing';
import type { DeviceIdentity } from '../storage/secureStore';

type Nav = NativeStackNavigationProp<RootStackParamList, 'PairDevice'>;

/** Non-secret device description sent as `deviceModel`, purely for admin display. */
function describePlatform(): string {
  return `${Platform.OS} ${String(Platform.Version ?? '')}`.trim();
}

type Phase = 'form' | 'submitting' | 'paired';

export function PairDeviceScreen() {
  const navigation = useNavigation<Nav>();

  const [pairingCode, setPairingCode] = React.useState('');
  const [deviceName, setDeviceName] = React.useState('');
  const [phase, setPhase] = React.useState<Phase>('form');
  const [error, setError] = React.useState<PairingError | null>(null);
  const [identity, setIdentity] = React.useState<DeviceIdentity | null>(null);

  const submitting = phase === 'submitting';

  const codeProblem = React.useMemo(
    () => (pairingCode ? validatePairingCode(pairingCode) : null),
    [pairingCode],
  );
  const canSubmit =
    !submitting && !validatePairingCode(pairingCode) && !validateDeviceName(deviceName);

  const onSubmit = React.useCallback(async () => {
    if (submitting) return;
    setError(null);
    setPhase('submitting');
    try {
      const paired = await pairDevice({
        pairingCode,
        deviceName,
        deviceModel: describePlatform(),
      });
      setIdentity(paired);
      setPhase('paired');
      // Clear the pairing code from component state: it is spent, and there is
      // no reason to keep it in memory.
      setPairingCode('');
    } catch (err) {
      setError(
        err instanceof PairingError
          ? err
          : new PairingError('SERVER', 'Pairing failed unexpectedly. Please try again.'),
      );
      setPhase('form');
    }
  }, [deviceName, pairingCode, submitting]);

  const onContinue = React.useCallback(() => {
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  }, [navigation]);

  if (phase === 'paired' && identity) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <View style={styles.successBadge}>
          <Text style={styles.successBadgeText}>DEVICE PAIRED</Text>
        </View>

        <Text style={styles.title}>Pairing complete</Text>
        <Text style={styles.body}>
          This device is now linked to the pharmacy below. Its credential is stored
          in this device&apos;s secure hardware storage and is never shown again.
        </Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Pharmacy</Text>
            <Text style={styles.rowValue}>{identity.pharmacyName}</Text>
          </View>
          {identity.pharmacyAddress ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Address</Text>
              <Text style={styles.rowValue}>{identity.pharmacyAddress}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Device name</Text>
            <Text style={styles.rowValue}>{identity.deviceName}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Device number</Text>
            <Text style={styles.rowValue}>#{identity.deviceId}</Text>
          </View>
        </View>

        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={onContinue}
          accessibilityRole="button"
          accessibilityLabel="Continue to the home screen"
        >
          <Text style={styles.buttonText}>Continue</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Pair this device</Text>
        <Text style={styles.body}>
          Ask a pharmacy administrator to generate a pairing code in MediIndex, then
          enter it below. Codes are valid for 10 minutes and work only once.
        </Text>

        <Text style={styles.label} nativeID="pairing-code-label">
          Pairing code
        </Text>
        <TextInput
          style={[styles.input, styles.codeInput, codeProblem && styles.inputError]}
          value={pairingCode}
          onChangeText={(text) => setPairingCode(normalizePairingCode(text))}
          placeholder="MED-XXXXXX"
          placeholderTextColor={theme.colors.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          maxLength={PAIRING_CODE_MAX_LENGTH}
          editable={!submitting}
          accessibilityLabel="Pairing code"
          accessibilityHint="Ten character code beginning with MED"
          accessibilityLabelledBy="pairing-code-label"
          returnKeyType="next"
        />
        {codeProblem ? (
          <Text style={styles.fieldHint} accessibilityLiveRegion="polite">
            {codeProblem.message}
          </Text>
        ) : null}

        <Text style={styles.label} nativeID="device-name-label">
          Device name
        </Text>
        <TextInput
          style={styles.input}
          value={deviceName}
          onChangeText={setDeviceName}
          placeholder="Counter tablet"
          placeholderTextColor={theme.colors.muted}
          autoCorrect={false}
          maxLength={DEVICE_NAME_MAX_LENGTH}
          editable={!submitting}
          accessibilityLabel="Device name"
          accessibilityHint="A name staff will recognise in the device list"
          accessibilityLabelledBy="device-name-label"
          returnKeyType="done"
          onSubmitEditing={canSubmit ? onSubmit : undefined}
        />

        {error ? (
          <View style={styles.errorBox} accessibilityLiveRegion="polite">
            <Text style={styles.errorText}>{error.message}</Text>
            {error.needsNewCode ? (
              <Text style={styles.errorHint}>A new pairing code is needed to continue.</Text>
            ) : null}
          </View>
        ) : null}

        <Pressable
          style={({ pressed }) => [
            styles.button,
            pressed && styles.buttonPressed,
            !canSubmit && styles.buttonDisabled,
          ]}
          onPress={onSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel={submitting ? 'Pairing in progress' : 'Pair this device'}
          accessibilityState={{ disabled: !canSubmit, busy: submitting }}
        >
          {submitting ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.buttonText}>Pair device</Text>
          )}
        </Pressable>

        <Text style={styles.footnote}>
          Pairing links this device to one pharmacy. The credential it receives is
          stored only in this device&apos;s secure storage and is never displayed.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg },
  title: { fontSize: theme.font.title, fontWeight: '700', color: theme.colors.ink },
  body: {
    fontSize: theme.font.body,
    color: theme.colors.muted,
    lineHeight: 21,
    marginTop: theme.spacing.sm,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.ink,
    marginTop: theme.spacing.lg,
    marginBottom: theme.spacing.xs,
  },
  input: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.line,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 4,
    fontSize: theme.font.body,
    color: theme.colors.ink,
  },
  codeInput: { letterSpacing: 2, fontWeight: '700' },
  inputError: { borderColor: theme.colors.danger },
  fieldHint: { marginTop: theme.spacing.xs, fontSize: 12, color: theme.colors.danger },
  errorBox: {
    marginTop: theme.spacing.lg,
    backgroundColor: theme.colors.dangerBg,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
  },
  errorText: { color: theme.colors.danger, fontSize: theme.font.sm, lineHeight: 20, fontWeight: '600' },
  errorHint: { color: theme.colors.danger, fontSize: 12, marginTop: theme.spacing.xs },
  button: {
    marginTop: theme.spacing.lg,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonPressed: { backgroundColor: theme.colors.accentDark },
  buttonDisabled: { backgroundColor: theme.colors.line },
  buttonText: { color: '#ffffff', fontSize: theme.font.body, fontWeight: '700' },
  footnote: {
    marginTop: theme.spacing.lg,
    fontSize: 12,
    color: theme.colors.muted,
    fontStyle: 'italic',
    lineHeight: 18,
  },
  successBadge: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.successBg,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    marginBottom: theme.spacing.sm,
  },
  successBadgeText: {
    color: theme.colors.successText,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  card: {
    marginTop: theme.spacing.md,
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
});
