import React, { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ClerkProvider, ClerkLoaded, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { setAuthTokenGetter, setBaseUrl } from '@workspace/api-client-react';
import {
  useFonts,
} from '@expo-google-fonts/dm-sans';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import { InstrumentSerif_400Regular } from '@expo-google-fonts/instrument-serif';
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
} from '@expo-google-fonts/ibm-plex-mono';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

const apiDomain = process.env.EXPO_PUBLIC_DOMAIN;
if (!apiDomain) {
  throw new Error('EXPO_PUBLIC_DOMAIN is required to connect to the ASC Spatial API.');
}
setBaseUrl(`https://${apiDomain}`);

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

function RootLayoutNav() {
  const { getToken, userId, isLoaded } = useAuth();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    queryClient.clear();
    setReady(true);
    return () => { setAuthTokenGetter(null); };
  }, [getToken, userId]);
  if (!isLoaded || !ready) return null;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    InstrumentSerif_400Regular,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <ClerkProvider
                publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!}
                tokenCache={tokenCache}
                proxyUrl={process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined}
              >
              <ClerkLoaded>
                <RootLayoutNav />
              </ClerkLoaded>
              </ClerkProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
