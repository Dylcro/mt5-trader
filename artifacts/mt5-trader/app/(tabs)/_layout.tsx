import { BlurView } from "expo-blur";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Redirect, Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import React, { useEffect } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import AIAssistantPanel from "@/components/AIAssistantPanel";
import BiometricLockScreen from "@/components/BiometricLockScreen";
import SessionWarningBanner from "@/components/SessionWarningBanner";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useTrading } from "@/context/TradingContext";
import { setAuthTokenGetter } from "@/lib/authToken";

function TabChrome({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.root}>
      <SessionWarningBanner />
      <View style={styles.tabs}>{children}</View>
      <AIAssistantPanel />
      <BiometricLockScreen />
    </View>
  );
}

function NativeTabLayout() {
  return (
    <TabChrome>
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

function ClassicTabLayout() {
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const insets = useSafeAreaInsets();

  return (
    <TabChrome>
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
              <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
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

  useEffect(() => {
    if (!isSignedIn) return;
    setAuthTokenGetter(() => getToken());
    void reconnectFromServer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  if (!isLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0A0A0F", justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator color="#C9A84C" />
      </View>
    );
  }

  if (!isSignedIn) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout />;
  }
  return <ClassicTabLayout />;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.dark.background,
  },
  tabs: {
    flex: 1,
  },
});
