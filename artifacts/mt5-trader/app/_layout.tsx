import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CascadeToast } from "@/components/CascadeToast";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { captureException, initSentry } from "@/lib/sentry";
import { AuthProvider } from "@/context/AuthContext";
import { TradingProvider } from "@/context/TradingContext";
import { CascadeSettingsProvider } from "@/hooks/useCascadeSettings";
import { HapticSettingsProvider } from "@/hooks/useHapticSettings";
import { DisplayCurrencyProvider } from "@/hooks/useDisplayCurrency";
import { NotificationSettingsProvider } from "@/hooks/useNotificationSettings";
import { useNotificationDeepLink } from "@/hooks/useNotificationDeepLink";

SplashScreen.preventAutoHideAsync();
initSentry();

const queryClient = new QueryClient();

function RootLayoutNav() {
  useNotificationDeepLink();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="join" options={{ headerShown: false }} />
      <Stack.Screen
        name="support"
        options={{
          headerShown: false,
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <AuthProvider>
      <SafeAreaProvider>
        <ErrorBoundary onError={(error) => captureException(error, { componentStack: true })}>
          <QueryClientProvider client={queryClient}>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <StatusBar style="dark" />
              <KeyboardProvider>
                <TradingProvider>
                  <DisplayCurrencyProvider>
                  <HapticSettingsProvider>
                    <CascadeSettingsProvider>
                      <NotificationSettingsProvider>
                        <RootLayoutNav />
                        <CascadeToast />
                      </NotificationSettingsProvider>
                    </CascadeSettingsProvider>
                  </HapticSettingsProvider>
                  </DisplayCurrencyProvider>
                </TradingProvider>
              </KeyboardProvider>
            </GestureHandlerRootView>
          </QueryClientProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </AuthProvider>
  );
}
