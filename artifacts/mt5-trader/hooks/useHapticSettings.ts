import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Platform } from "react-native";

const STORAGE_KEY = "pref_haptic_enabled";
const DEFAULT_HAPTIC_ENABLED = true;

interface HapticSettingsContextValue {
  hapticEnabled: boolean;
  setHapticEnabled: (enabled: boolean) => void;
}

const HapticSettingsContext = createContext<HapticSettingsContextValue | null>(null);

export function HapticSettingsProvider({ children }: { children: React.ReactNode }) {
  const [hapticEnabled, setHapticEnabledState] = useState(DEFAULT_HAPTIC_ENABLED);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((val) => {
      if (val !== null) {
        setHapticEnabledState(val === "true");
      }
    });
  }, []);

  const setHapticEnabled = useCallback((enabled: boolean) => {
    setHapticEnabledState(enabled);
    AsyncStorage.setItem(STORAGE_KEY, String(enabled));
  }, []);

  return React.createElement(
    HapticSettingsContext.Provider,
    { value: { hapticEnabled, setHapticEnabled } },
    children
  );
}

export function useHapticSettings() {
  const ctx = useContext(HapticSettingsContext);
  if (!ctx) throw new Error("useHapticSettings must be used inside HapticSettingsProvider");
  return ctx;
}

export type AppHapticKind = "selection" | "light" | "medium" | "heavy" | "success" | "warning" | "error";

/** Fire haptics only when the user has haptic feedback enabled (skipped on web). */
export async function triggerAppHaptic(enabled: boolean, kind: AppHapticKind = "medium"): Promise<void> {
  if (Platform.OS === "web" || !enabled) return;
  try {
    if (kind === "selection") await Haptics.selectionAsync();
    else if (kind === "light") await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (kind === "medium") await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else if (kind === "heavy") await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    else if (kind === "success") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === "warning") await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch {
    // Haptics unavailable on some devices/simulators.
  }
}
