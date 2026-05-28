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
  // Zone TP pip distances from the cascade market entry. tp4Pips = 0 means
  // "leave the last 25% open" (manual close). Persisted globally and reused
  // for every cascade until the user changes them.
  tp1Pips: number;
  tp2Pips: number;
  tp3Pips: number;
  tp4Pips: number;
}

const DEFAULTS: CascadeSettings = {
  numPositions: 3,
  pipsBetween: 10,
  slPips: 100,
  takeProfitEnabled: false,
  takeProfitPips: 30,
  autoCascadeEnabled: false,
  tp1Pips: 20,
  tp2Pips: 60,
  tp3Pips: 100,
  tp4Pips: 0,
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
    tp1Pips:           `${prefix}zone_tp1_pips`,
    tp2Pips:           `${prefix}zone_tp2_pips`,
    tp3Pips:           `${prefix}zone_tp3_pips`,
    tp4Pips:           `${prefix}zone_tp4_pips`,
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
        const [num, between, sl, tpEnabled, tpPips, tp1, tp2, tp3, tp4, globalAutoEnabled] = pairs.map((p) => p[1]);

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
          tp1Pips: tp1 ? parseFloat(tp1) : DEFAULTS.tp1Pips,
          tp2Pips: tp2 ? parseFloat(tp2) : DEFAULTS.tp2Pips,
          tp3Pips: tp3 ? parseFloat(tp3) : DEFAULTS.tp3Pips,
          tp4Pips: tp4 != null ? parseFloat(tp4) : DEFAULTS.tp4Pips,
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
        [keys.tp1Pips, String(next.tp1Pips)],
        [keys.tp2Pips, String(next.tp2Pips)],
        [keys.tp3Pips, String(next.tp3Pips)],
        [keys.tp4Pips, String(next.tp4Pips)],
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
