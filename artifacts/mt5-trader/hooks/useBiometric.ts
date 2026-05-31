import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform } from "react-native";

const KEY_ENABLED = "biometric_lock_enabled";

export interface BiometricState {
  available: boolean;
  enabled: boolean;
  locked: boolean;
  loading: boolean;
  setEnabled: (value: boolean) => Promise<void>;
  unlock: () => Promise<boolean>;
  lock: () => void;
}

export function useBiometric(): BiometricState {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (Platform.OS === "web") {
        if (!cancelled) {
          setAvailable(false);
          setEnabledState(false);
          setLoading(false);
        }
        return;
      }
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      const stored = await AsyncStorage.getItem(KEY_ENABLED);
      if (!cancelled) {
        setAvailable(hasHardware && enrolled);
        setEnabledState(stored === "true" && hasHardware && enrolled);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLocked(false);
      return;
    }
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        setLocked(true);
      }
    });
    return () => sub.remove();
  }, [enabled]);

  const setEnabled = useCallback(async (value: boolean) => {
    if (value && !available) return;
    await AsyncStorage.setItem(KEY_ENABLED, value ? "true" : "false");
    setEnabledState(value);
    if (!value) setLocked(false);
  }, [available]);

  const unlock = useCallback(async (): Promise<boolean> => {
    if (!enabled || Platform.OS === "web") {
      setLocked(false);
      return true;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock XAUUSD Trader",
      cancelLabel: "Cancel",
      disableDeviceFallback: false,
    });
    if (result.success) {
      setLocked(false);
      return true;
    }
    return false;
  }, [enabled]);

  const lock = useCallback(() => {
    if (enabled) setLocked(true);
  }, [enabled]);

  return {
    available,
    enabled,
    locked: enabled && locked,
    loading,
    setEnabled,
    unlock,
    lock,
  };
}
