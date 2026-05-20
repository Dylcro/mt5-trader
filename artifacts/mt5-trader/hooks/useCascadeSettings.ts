import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

export interface CascadeSettings {
  numPositions: number;
  pipsBetween: number;
  slPips: number;
  takeProfitEnabled: boolean;
  takeProfitPips: number;
  autoCascadeEnabled: boolean;
}

const DEFAULTS: CascadeSettings = {
  numPositions: 3,
  pipsBetween: 50,
  slPips: 100,
  takeProfitEnabled: false,
  takeProfitPips: 30,
  autoCascadeEnabled: false,
};

const KEYS = {
  numPositions: "cascade_num_positions",
  pipsBetween: "cascade_pips_between",
  slPips: "cascade_sl_pips",
  takeProfitEnabled: "cascade_tp_enabled",
  takeProfitPips: "cascade_tp_pips",
  autoCascadeEnabled: "cascade_auto_enabled",
};

interface CascadeSettingsContextValue {
  settings: CascadeSettings;
  updateSettings: (partial: Partial<CascadeSettings>) => void;
}

const CascadeSettingsContext = createContext<CascadeSettingsContextValue | null>(null);

async function pushToServer(s: CascadeSettings): Promise<void> {
  if (!API_BASE) return;
  try {
    await fetch(`${API_BASE}/cascade-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: s.autoCascadeEnabled,
        numPositions: s.numPositions,
        pipsBetween: s.pipsBetween,
        slPips: s.slPips,
      }),
    });
  } catch {
    // Non-fatal — server may be unreachable on first load
  }
}

export function CascadeSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<CascadeSettings>(DEFAULTS);

  useEffect(() => {
    // Load from AsyncStorage first for instant display, then reconcile with server
    AsyncStorage.multiGet(Object.values(KEYS)).then((pairs) => {
      const [num, between, sl, tpEnabled, tpPips, autoEnabled] = pairs.map((p) => p[1]);
      const local: CascadeSettings = {
        numPositions: num ? parseFloat(num) : DEFAULTS.numPositions,
        pipsBetween: between ? parseFloat(between) : DEFAULTS.pipsBetween,
        slPips: sl ? parseFloat(sl) : DEFAULTS.slPips,
        takeProfitEnabled: tpEnabled === "true",
        takeProfitPips: tpPips ? parseFloat(tpPips) : DEFAULTS.takeProfitPips,
        autoCascadeEnabled: autoEnabled === "true",
      };
      setSettings(local);

      // Then fetch server config and update the auto-cascade toggle + cascade params
      if (API_BASE) {
        fetch(`${API_BASE}/cascade-config`)
          .then((r) => r.ok ? r.json() : null)
          .then((remote: { enabled?: boolean; numPositions?: number; pipsBetween?: number; slPips?: number } | null) => {
            if (!remote) return;
            setSettings((prev) => ({
              ...prev,
              autoCascadeEnabled: remote.enabled ?? prev.autoCascadeEnabled,
              numPositions: remote.numPositions ?? prev.numPositions,
              pipsBetween: remote.pipsBetween ?? prev.pipsBetween,
              slPips: remote.slPips ?? prev.slPips,
            }));
          })
          .catch(() => {});
      }
    });
  }, []);

  const updateSettings = useCallback((partial: Partial<CascadeSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      AsyncStorage.multiSet([
        [KEYS.numPositions, String(next.numPositions)],
        [KEYS.pipsBetween, String(next.pipsBetween)],
        [KEYS.slPips, String(next.slPips)],
        [KEYS.takeProfitEnabled, String(next.takeProfitEnabled)],
        [KEYS.takeProfitPips, String(next.takeProfitPips)],
        [KEYS.autoCascadeEnabled, String(next.autoCascadeEnabled)],
      ]);
      void pushToServer(next);
      return next;
    });
  }, []);

  return React.createElement(
    CascadeSettingsContext.Provider,
    { value: { settings, updateSettings } },
    children
  );
}

export function useCascadeSettings() {
  const ctx = useContext(CascadeSettingsContext);
  if (!ctx) throw new Error("useCascadeSettings must be used inside CascadeSettingsProvider");
  return ctx;
}

const PIP = 0.10;

export function buildCascadeLevels(
  marketPrice: number,
  direction: "buy" | "sell",
  settings: CascadeSettings
): { limitEntries: number[]; stopLoss: number } {
  const { numPositions, pipsBetween, slPips } = settings;
  const step = pipsBetween * PIP;
  const slDist = slPips * PIP;

  const limitEntries: number[] = [];
  for (let i = 1; i < numPositions; i++) {
    const price = direction === "buy"
      ? parseFloat((marketPrice - i * step).toFixed(2))
      : parseFloat((marketPrice + i * step).toFixed(2));
    limitEntries.push(price);
  }

  const stopLoss = direction === "buy"
    ? parseFloat((marketPrice - slDist).toFixed(2))
    : parseFloat((marketPrice + slDist).toFixed(2));

  return { limitEntries, stopLoss };
}
