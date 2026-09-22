/**
 * Root navigation for the MediIndex mobile app.
 *
 * A single native stack covering every screen the later phases need.
 *
 * Splash is always the entry route. As of Phase 7D it performs a LOCAL
 * secure-storage check followed by server-authoritative verification
 * (GET /api/mobile/auth/verify) before resetting the stack to Home
 * (authenticated), Pair Device (no credential or a rejected one), or an
 * inline retry state (network/server error) — see auth/deviceVerification.ts.
 * `navigation/startupRoute.ts` implements the earlier Phase 7C local-only rule
 * and is kept for its own test coverage, but SplashScreen no longer calls it
 * directly. Doing the decision in a screen rather than in `initialRouteName`
 * avoids rendering a route before the credential is known.
 */

import React from 'react';
import { Pressable, Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { theme } from '../components/theme';
import {
  SplashScreen,
  PairDeviceScreen,
  HomeScreen,
  ScanQrScreen,
  StockReceiptScreen,
  SyncQueueScreen,
  SettingsScreen,
} from '../screens';

/** Route names and their params. Phase 7F/7G will populate StockReceipt params. */
export type RootStackParamList = {
  Splash: undefined;
  PairDevice: undefined;
  Home: undefined;
  ScanQr: undefined;
  /** Phase 7F will pass the scanned target through these params. */
  StockReceipt: { medicineId: number; batchNumber: string } | undefined;
  SyncQueue: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export const ROUTES: Array<{ name: keyof RootStackParamList; title: string }> = [
  { name: 'Splash', title: 'MediIndex' },
  { name: 'PairDevice', title: 'Pair Device' },
  { name: 'Home', title: 'Home' },
  { name: 'ScanQr', title: 'Scan QR' },
  { name: 'StockReceipt', title: 'Stock Receipt' },
  { name: 'SyncQueue', title: 'Sync Queue' },
  { name: 'Settings', title: 'Settings' },
];

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.accent },
          headerTintColor: '#ffffff',
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="Splash" component={SplashScreen} options={{ title: 'MediIndex' }} />
        <Stack.Screen name="PairDevice" component={PairDeviceScreen} options={{ title: 'Pair Device' }} />
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={({ navigation }) => ({
            title: 'Home',
            // Settings is where paired state and "Unpair this device" live, so it
            // needs a reachable entry point while Home is still a placeholder.
            headerRight: () => (
              <Pressable
                onPress={() => navigation.navigate('Settings')}
                accessibilityRole="button"
                accessibilityLabel="Open settings"
                hitSlop={8}
              >
                <Text style={{ color: '#ffffff', fontWeight: '700' }}>Settings</Text>
              </Pressable>
            ),
          })}
        />
        <Stack.Screen name="ScanQr" component={ScanQrScreen} options={{ title: 'Scan QR' }} />
        <Stack.Screen name="StockReceipt" component={StockReceiptScreen} options={{ title: 'Stock Receipt' }} />
        <Stack.Screen name="SyncQueue" component={SyncQueueScreen} options={{ title: 'Sync Queue' }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
