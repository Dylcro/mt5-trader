import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

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
