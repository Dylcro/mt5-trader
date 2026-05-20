import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

import { useTrading } from "@/context/TradingContext";

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
  pipsBetween: 10,
  slPips: 100,
  takeProfitEnabled: false,
  takeProfitPips: 30,
  autoCascadeEnabled: false,
};

const VALID_PIPS_BETWEEN = [5, 10, 15, 20];

// autoCascadeEnabled is a device-level toggle — stored under a fixed global key
// so it is never reset when the accountId changes on first connect.
const GLOBAL_AUTO_CASCADE_KEY = "cascade_auto_enabled_global";

function storageKeys(accountId: string) {
  const prefix = accountId ? `cascade_${accountId}_` : "cascade_";
  return {
    numPositions:      `${prefix}num_positions`,
    pipsBetween:       `${prefix}pips_between`,
    slPips:            `${prefix}sl_pips`,
    takeProfitEnabled: `${prefix}tp_enabled`,
    takeProfitPips:    `${prefix}tp_pips`,
  };
}

interface CascadeSettingsContextValue {
  settings: CascadeSettings;
  updateSettings: (partial: Partial<CascadeSettings>) => void;
}

const CascadeSettingsContext = createContext<CascadeSettingsContextValue | null>(null);

async function pushToServer(s: CascadeSettings, accountId: string): Promise<void> {
  if (!API_BASE) return;
  const url = accountId
    ? `${API_BASE}/cascade-config?accountId=${encodeURIComponent(accountId)}`
    : `${API_BASE}/cascade-config`;
  try {
    await fetch(url, {
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
  const { accountId } = useTrading();
  const [settings, setSettings] = useState<CascadeSettings>(DEFAULTS);

  useEffect(() => {
    const keys = storageKeys(accountId);
    // Load per-account keys + global autoCascadeEnabled key together
    const allKeys = [...Object.values(keys), GLOBAL_AUTO_CASCADE_KEY];
    AsyncStorage.multiGet(allKeys).then((pairs) => {
      const [num, between, sl, tpEnabled, tpPips, autoEnabled] = pairs.map((p) => p[1]);
      const storedPips = between ? parseFloat(between) : DEFAULTS.pipsBetween;

      // Also migrate the old per-account auto_enabled key if the global key is not yet set
      // so existing users don't lose their toggle state after this update.
      const legacyAutoKey = accountId ? `cascade_${accountId}_auto_enabled` : "cascade_auto_enabled";
      const resolveAutoEnabled = async () => {
        if (autoEnabled !== null) return autoEnabled === "true";
        const [[, legacy]] = await AsyncStorage.multiGet([legacyAutoKey]);
        return legacy === "true";
      };

      void resolveAutoEnabled().then((autoCascadeEnabled) => {
        const local: CascadeSettings = {
          numPositions: num ? parseFloat(num) : DEFAULTS.numPositions,
          // Migrate: if stored value is not one of the valid pill options (e.g. old default of 50), reset to 10
          pipsBetween: VALID_PIPS_BETWEEN.includes(storedPips) ? storedPips : DEFAULTS.pipsBetween,
          slPips: sl ? parseFloat(sl) : DEFAULTS.slPips,
          takeProfitEnabled: tpEnabled === "true",
          takeProfitPips: tpPips ? parseFloat(tpPips) : DEFAULTS.takeProfitPips,
          autoCascadeEnabled,
        };
        setSettings(local);
        // Push local settings to server so the server always has the latest config
        void pushToServer(local, accountId);
      });
    });
  }, [accountId]);

  const updateSettings = useCallback((partial: Partial<CascadeSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      const keys = storageKeys(accountId);
      AsyncStorage.multiSet([
        [keys.numPositions, String(next.numPositions)],
        [keys.pipsBetween, String(next.pipsBetween)],
        [keys.slPips, String(next.slPips)],
        [keys.takeProfitEnabled, String(next.takeProfitEnabled)],
        [keys.takeProfitPips, String(next.takeProfitPips)],
        // autoCascadeEnabled is device-global — always written to the same key
        [GLOBAL_AUTO_CASCADE_KEY, String(next.autoCascadeEnabled)],
      ]);
      void pushToServer(next, accountId);
      return next;
    });
  }, [accountId]);

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
