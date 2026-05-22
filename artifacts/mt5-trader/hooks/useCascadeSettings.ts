import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

import { getAuthToken } from "@/lib/authToken";
import { useTrading } from "@/context/TradingContext";

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

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
  saveToServer: () => Promise<boolean>;
}

const CascadeSettingsContext = createContext<CascadeSettingsContextValue | null>(null);

async function pushToServer(s: CascadeSettings, accountId: string): Promise<void> {
  if (!API_BASE) return;
  const url = accountId
    ? `${API_BASE}/cascade-config?accountId=${encodeURIComponent(accountId)}`
    : `${API_BASE}/cascade-config`;
  try {
    await authFetch(url, {
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
    let cancelled = false;
    const load = async () => {
      try {
        const keys = storageKeys(accountId);
        const allKeys = [...Object.values(keys), GLOBAL_AUTO_CASCADE_KEY];
        const pairs = await AsyncStorage.multiGet(allKeys);
        const [num, between, sl, tpEnabled, tpPips, globalAutoEnabled] = pairs.map((p) => p[1]);

        let autoCascadeEnabled = DEFAULTS.autoCascadeEnabled;
        if (globalAutoEnabled !== null) {
          autoCascadeEnabled = globalAutoEnabled === "true";
        } else {
          const legacyKey = accountId ? `cascade_${accountId}_auto_enabled` : "cascade_auto_enabled";
          const [[, legacy]] = await AsyncStorage.multiGet([legacyKey]);
          autoCascadeEnabled = legacy === "true";
          await AsyncStorage.setItem(GLOBAL_AUTO_CASCADE_KEY, String(autoCascadeEnabled));
        }

        if (cancelled) return;

        const storedPips = between ? parseFloat(between) : DEFAULTS.pipsBetween;
        const local: CascadeSettings = {
          numPositions: num ? parseFloat(num) : DEFAULTS.numPositions,
          pipsBetween: VALID_PIPS_BETWEEN.includes(storedPips) ? storedPips : DEFAULTS.pipsBetween,
          slPips: sl ? parseFloat(sl) : DEFAULTS.slPips,
          takeProfitEnabled: tpEnabled === "true",
          takeProfitPips: tpPips ? parseFloat(tpPips) : DEFAULTS.takeProfitPips,
          autoCascadeEnabled,
        };
        setSettings(local);
        void pushToServer(local, accountId);
      } catch (e) {
        console.warn("[CascadeSettings] failed to load from storage:", e);
      }
    };
    void load();
    return () => { cancelled = true; };
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
        [GLOBAL_AUTO_CASCADE_KEY, String(next.autoCascadeEnabled)],
      ]);
      return next;
    });
  }, [accountId]);

  const saveToServer = useCallback(async (): Promise<boolean> => {
    if (!API_BASE) return false;
    const url = accountId
      ? `${API_BASE}/cascade-config?accountId=${encodeURIComponent(accountId)}`
      : `${API_BASE}/cascade-config`;
    try {
      const res = await authFetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: settings.autoCascadeEnabled,
          numPositions: settings.numPositions,
          pipsBetween: settings.pipsBetween,
          slPips: settings.slPips,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [accountId, settings]);

  return React.createElement(
    CascadeSettingsContext.Provider,
    { value: { settings, updateSettings, saveToServer } },
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
