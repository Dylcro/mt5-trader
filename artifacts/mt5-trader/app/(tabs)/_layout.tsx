import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Redirect, Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import React, { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import AIAssistantPanel from "@/components/AIAssistantPanel";
import BiometricLockScreen from "@/components/BiometricLockScreen";
import OnboardingModal from "@/components/OnboardingModal";
import SessionWarningBanner from "@/components/SessionWarningBanner";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useTrading } from "@/context/TradingContext";
import { useOnboardingGate } from "@/hooks/useOnboardingGate";
import { setAuthTokenGetter } from "@/lib/authToken";

function TabChrome({
  children,
  showOnboarding,
  onOnboardingComplete,
}: {
  children: React.ReactNode;
  showOnboarding: boolean;
  onOnboardingComplete: () => void;
}) {
  const { signIn, signUp } = useAuth();
  const { connect, status, errorMsg } = useTrading();
  const statusRef = useRef(status);
  const errorRef = useRef(errorMsg);

  useEffect(() => {
    statusRef.current = status;
    errorRef.current = errorMsg;
  }, [status, errorMsg]);

  const onSignIn = useCallback(async (email: string, password: string) => {
    const res = await signIn(email, password);
    if (res.error) throw new Error(res.error);
  }, [signIn]);

  const onCreateAccount = useCallback(async (email: string, password: string) => {
    const name = email.split("@")[0]?.trim() || "Trader";
    const res = await signUp(name, email, password);
    if (res.error) throw new Error(res.error);
  }, [signUp]);

  const onConnectMT5 = useCallback(
    async (creds: { login: string; password: string; server: string }) => {
      await connect(creds);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const s = statusRef.current;
        if (s === "connected") return;
        if (s === "error") {
          throw new Error(errorRef.current || "Connection failed");
        }
      }
      throw new Error("Connection timed out — try again.");
    },
    [connect],
  );

  return (
    <View style={styles.root}>
      <SessionWarningBanner />
      <View style={styles.tabs}>{children}</View>
      <AIAssistantPanel />
      <BiometricLockScreen />
      <OnboardingModal
        visible={showOnboarding}
        onComplete={onOnboardingComplete}
        onSignIn={onSignIn}
        onCreateAccount={onCreateAccount}
        onConnectMT5={onConnectMT5}
      />
    </View>
  );
}

function NativeTabLayout({
  showOnboarding,
  onOnboardingComplete,
}: {
  showOnboarding: boolean;
  onOnboardingComplete: () => void;
}) {
  return (
    <TabChrome showOnboarding={showOnboarding} onOnboardingComplete={onOnboardingComplete}>
      <NativeTabs>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf={{ default: "chart.line.uptrend.xyaxis", selected: "chart.line.uptrend.xyaxis.circle.fill" }} />
          <NativeTabs.Trigger.Label>Trade</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="dashboard">
          <NativeTabs.Trigger.Icon sf={{ default: "square.grid.2x2", selected: "square.grid.2x2.fill" }} />
          <NativeTabs.Trigger.Label>Dashboard</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="positions">
          <NativeTabs.Trigger.Icon sf={{ default: "list.bullet.rectangle", selected: "list.bullet.rectangle.fill" }} />
          <NativeTabs.Trigger.Label>Positions</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="history">
          <NativeTabs.Trigger.Icon sf={{ default: "clock", selected: "clock.fill" }} />
          <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="settings">
          <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
          <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </TabChrome>
  );
}

function ClassicTabLayout({
  showOnboarding,
  onOnboardingComplete,
}: {
  showOnboarding: boolean;
  onOnboardingComplete: () => void;
}) {
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const insets = useSafeAreaInsets();

  return (
    <TabChrome showOnboarding={showOnboarding} onOnboardingComplete={onOnboardingComplete}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: Colors.dark.gold,
          tabBarInactiveTintColor: Colors.dark.tabIconDefault,
          tabBarStyle: {
            position: "absolute",
            backgroundColor: isIOS ? "transparent" : Colors.dark.card,
            borderTopWidth: 1,
            borderTopColor: Colors.dark.border,
            elevation: 0,
            paddingBottom: isWeb ? 0 : insets.bottom,
            ...(isWeb ? { height: 84 } : {}),
          },
          tabBarBackground: () =>
            isIOS ? (
              <BlurView intensity={80} tint="light" style={StyleSheet.absoluteFill} />
            ) : isWeb ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.dark.card }]} />
            ) : null,
          tabBarLabelStyle: {
            fontFamily: "Inter_500Medium",
            fontSize: 10,
            marginTop: -2,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Trade",
            tabBarIcon: ({ color, size }) =>
              Platform.OS === "ios" ? (
                <SymbolView name="chart.line.uptrend.xyaxis" tintColor={color} size={size} />
              ) : (
                <MaterialCommunityIcons name="chart-line" size={size} color={color} />
              ),
          }}
        />
        <Tabs.Screen
          name="dashboard"
          options={{
            title: "Dashboard",
            tabBarIcon: ({ color, size }) =>
              Platform.OS === "ios" ? (
                <SymbolView name="square.grid.2x2" tintColor={color} size={size} />
              ) : (
                <Feather name="grid" size={size} color={color} />
              ),
          }}
        />
        <Tabs.Screen
          name="positions"
          options={{
            title: "Positions",
            tabBarIcon: ({ color, size }) =>
              Platform.OS === "ios" ? (
                <SymbolView name="list.bullet.rectangle" tintColor={color} size={size} />
              ) : (
                <Feather name="list" size={size} color={color} />
              ),
          }}
        />
        <Tabs.Screen
          name="history"
          options={{
            title: "History",
            tabBarIcon: ({ color, size }) =>
              Platform.OS === "ios" ? (
                <SymbolView name="clock" tintColor={color} size={size} />
              ) : (
                <Feather name="clock" size={size} color={color} />
              ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color, size }) =>
              Platform.OS === "ios" ? (
                <SymbolView name="gearshape" tintColor={color} size={size} />
              ) : (
                <Feather name="settings" size={size} color={color} />
              ),
          }}
        />
      </Tabs>
    </TabChrome>
  );
}

export default function TabLayout() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const { reconnectFromServer } = useTrading();
  const { show: showOnboarding, ready: onboardingReady, complete: completeOnboarding } =
    useOnboardingGate();

  useEffect(() => {
    if (!isSignedIn) return;
    setAuthTokenGetter(() => getToken());
    void reconnectFromServer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  if (!isLoaded || !onboardingReady) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={Colors.dark.gold} />
      </View>
    );
  }

  if (showOnboarding) {
    return (
      <OnboardingOnly
        onComplete={completeOnboarding}
      />
    );
  }

  if (!isSignedIn) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  if (isLiquidGlassAvailable()) {
    return (
      <NativeTabLayout
        showOnboarding={false}
        onOnboardingComplete={completeOnboarding}
      />
    );
  }
  return (
    <ClassicTabLayout
      showOnboarding={false}
      onOnboardingComplete={completeOnboarding}
    />
  );
}

/** Full-screen onboarding before tabs (includes in-wizard auth + MT5 connect). */
function OnboardingOnly({ onComplete }: { onComplete: () => void }) {
  const { signIn, signUp } = useAuth();
  const { connect, status, errorMsg } = useTrading();
  const statusRef = useRef(status);
  const errorRef = useRef(errorMsg);

  useEffect(() => {
    statusRef.current = status;
    errorRef.current = errorMsg;
  }, [status, errorMsg]);

  const onSignIn = useCallback(async (email: string, password: string) => {
    const res = await signIn(email, password);
    if (res.error) throw new Error(res.error);
  }, [signIn]);

  const onCreateAccount = useCallback(async (email: string, password: string) => {
    const name = email.split("@")[0]?.trim() || "Trader";
    const res = await signUp(name, email, password);
    if (res.error) throw new Error(res.error);
  }, [signUp]);

  const onConnectMT5 = useCallback(
    async (creds: { login: string; password: string; server: string }) => {
      await connect(creds);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const s = statusRef.current;
        if (s === "connected") return;
        if (s === "error") {
          throw new Error(errorRef.current || "Connection failed");
        }
      }
      throw new Error("Connection timed out — try again.");
    },
    [connect],
  );

  return (
    <View style={styles.root}>
      <OnboardingModal
        visible
        onComplete={onComplete}
        onSignIn={onSignIn}
        onCreateAccount={onCreateAccount}
        onConnectMT5={onConnectMT5}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.dark.background,
  },
  tabs: {
    flex: 1,
  },
  loading: {
    flex: 1,
    backgroundColor: Colors.dark.background,
    justifyContent: "center",
    alignItems: "center",
  },
});
