import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { getAuthToken } from "@/lib/authToken";
import { lotsToPct, pctToLots } from "@/lib/cascadeTpLots";
import { useTrading } from "@/context/TradingContext";

export const LOT_SIZE_CASCADE_KEY = "lot_size_cascade";

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
  // Signed pip offset of the protective SL from the surviving entry when the
  // user taps Risk Free. Negative = drawdown side (small loss if reversed),
  // positive = profit lock (tighter exit), 0 = exactly at entry. Snapped to
  // 5-pip steps within -30..+30 server-side.
  riskFreePips: number;
  /** Auto SL→break-even after TP1, TP2, or TP3 partial (default TP2). */
  autoBeAtTp: 1 | 2 | 3;
  /** Lots to close at each TP (preferred). Remainder stays for runners. */
  tp1Lots: number;
  tp2Lots: number;
  tp3Lots: number;
  /** Legacy % — derived from lots for server sync; do not edit in UI. */
  tp1Pct: number;
  tp2Pct: number;
  tp3Pct: number;
  tp4Pct: number;
  // Per-TP enabled flags. When false the TP is skipped in the zone engine
  // (pre-marked as already hit at creation) and its pip/pct inputs are greyed.
  tp1Enabled: boolean;
  tp2Enabled: boolean;
  tp3Enabled: boolean;
  tp4Enabled: boolean;
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
  riskFreePips: -10,
  autoBeAtTp: 2,
  tp1Lots: 0.01,
  tp2Lots: 0.01,
  tp3Lots: 0.01,
  tp1Pct: 25,
  tp2Pct: 25,
  tp3Pct: 25,
  tp4Pct: 25,
  tp1Enabled: true,
  tp2Enabled: true,
  tp3Enabled: true,
  tp4Enabled: true,
};

const VALID_RISK_FREE_PIPS = [-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30];

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
    riskFreePips:      `${prefix}risk_free_pips`,
    autoBeAtTp:        `${prefix}auto_be_at_tp`,
    tp1Lots:           `${prefix}zone_tp1_lots`,
    tp2Lots:           `${prefix}zone_tp2_lots`,
    tp3Lots:           `${prefix}zone_tp3_lots`,
    tp1Pct:            `${prefix}zone_tp1_pct`,
    tp2Pct:            `${prefix}zone_tp2_pct`,
    tp3Pct:            `${prefix}zone_tp3_pct`,
    tp4Pct:            `${prefix}zone_tp4_pct`,
    tp1Enabled:        `${prefix}zone_tp1_en`,
    tp2Enabled:        `${prefix}zone_tp2_en`,
    tp3Enabled:        `${prefix}zone_tp3_en`,
    tp4Enabled:        `${prefix}zone_tp4_en`,
  };
}

function cascadeConfigUrl(accountId: string): string {
  return accountId
    ? `${API_BASE}/cascade-config?accountId=${encodeURIComponent(accountId)}`
    : `${API_BASE}/cascade-config`;
}

function buildServerPayload(s: CascadeSettings, cascadeLot: number): Record<string, unknown> {
  const tp1Pct = s.tp1Enabled ? lotsToPct(s.tp1Lots, cascadeLot) : 0;
  const tp2Pct = s.tp2Enabled ? lotsToPct(s.tp2Lots, cascadeLot) : 0;
  const tp3Pct = s.tp3Enabled ? lotsToPct(s.tp3Lots, cascadeLot) : 0;
  const usedPct = tp1Pct + tp2Pct + tp3Pct;
  const tp4Pct = s.tp4Enabled ? Math.max(0, 100 - usedPct) : 0;
  return {
    enabled: s.autoCascadeEnabled,
    numPositions: s.numPositions,
    pipsBetween: s.pipsBetween,
    slPips: s.slPips,
    tp1Pips: s.tp1Pips,
    tp2Pips: s.tp2Pips,
    tp3Pips: s.tp3Pips,
    tp4Pips: s.tp4Pips,
    tp1Pct,
    tp2Pct,
    tp3Pct,
    tp4Pct,
    tp1Enabled: s.tp1Enabled,
    tp2Enabled: s.tp2Enabled,
    tp3Enabled: s.tp3Enabled,
    tp4Enabled: s.tp4Enabled,
    riskFreePips: s.riskFreePips,
    autoBeAtTp: s.autoBeAtTp,
    takeProfitEnabled: s.takeProfitEnabled,
    takeProfitPips: s.takeProfitPips,
  };
}

function mergeServerConfig(
  local: CascadeSettings,
  raw: Record<string, unknown>,
  cascadeLot: number,
): CascadeSettings {
  const pickNum = (key: string, cur: number) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key] as number) ? (raw[key] as number) : cur;
  const pickBool = (key: string, cur: boolean) =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : cur;
  const autoBe = pickNum("autoBeAtTp", local.autoBeAtTp);
  const storedPips = pickNum("pipsBetween", local.pipsBetween);
  const riskFree = pickNum("riskFreePips", local.riskFreePips);
  const tp1Pct = pickNum("tp1Pct", local.tp1Pct);
  const tp2Pct = pickNum("tp2Pct", local.tp2Pct);
  const tp3Pct = pickNum("tp3Pct", local.tp3Pct);
  const tp4Pct = pickNum("tp4Pct", local.tp4Pct);
  const tp1Enabled = pickBool("tp1Enabled", local.tp1Enabled);
  const tp2Enabled = pickBool("tp2Enabled", local.tp2Enabled);
  const tp3Enabled = pickBool("tp3Enabled", local.tp3Enabled);
  const tp4Enabled = pickBool("tp4Enabled", local.tp4Enabled);
  const hasLots = (key: string) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key] as number);
  return {
    ...local,
    autoCascadeEnabled: pickBool("enabled", local.autoCascadeEnabled),
    numPositions: pickNum("numPositions", local.numPositions),
    pipsBetween: VALID_PIPS_BETWEEN.includes(storedPips) ? storedPips : local.pipsBetween,
    slPips: pickNum("slPips", local.slPips),
    takeProfitEnabled: pickBool("takeProfitEnabled", local.takeProfitEnabled),
    takeProfitPips: pickNum("takeProfitPips", local.takeProfitPips),
    tp1Pips: pickNum("tp1Pips", local.tp1Pips),
    tp2Pips: pickNum("tp2Pips", local.tp2Pips),
    tp3Pips: pickNum("tp3Pips", local.tp3Pips),
    tp4Pips: pickNum("tp4Pips", local.tp4Pips),
    riskFreePips: VALID_RISK_FREE_PIPS.includes(riskFree) ? riskFree : local.riskFreePips,
    autoBeAtTp: autoBe === 3 ? 3 : autoBe === 1 || autoBe === 2 ? 2 : local.autoBeAtTp,
    tp1Pct,
    tp2Pct,
    tp3Pct,
    tp4Pct,
    tp1Lots: hasLots("tp1Lots") ? (raw.tp1Lots as number)
      : tp1Enabled ? pctToLots(cascadeLot, tp1Pct) : 0,
    tp2Lots: hasLots("tp2Lots") ? (raw.tp2Lots as number)
      : tp2Enabled ? pctToLots(cascadeLot, tp2Pct) : 0,
    tp3Lots: hasLots("tp3Lots") ? (raw.tp3Lots as number)
      : tp3Enabled ? pctToLots(cascadeLot, tp3Pct) : 0,
    tp1Enabled,
    tp2Enabled,
    tp3Enabled,
    tp4Enabled,
  };
}

async function fetchFromServer(accountId: string): Promise<Record<string, unknown> | null> {
  if (!API_BASE) return null;
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const res = await authFetch(cascadeConfigUrl(accountId));
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pushToServer(s: CascadeSettings, accountId: string, cascadeLot: number): Promise<void> {
  if (!API_BASE) return;
  const token = await getAuthToken();
  if (!token) return;
  try {
    await authFetch(cascadeConfigUrl(accountId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildServerPayload(s, cascadeLot)),
    });
  } catch {
    // Non-fatal — server may be unreachable
  }
}

export type SaveToServerResult = { ok: true } | { ok: false; message: string };

interface CascadeSettingsContextValue {
  settings: CascadeSettings;
  cascadeLotSize: number;
  setCascadeLotSize: (lots: number) => void;
  updateSettings: (partial: Partial<CascadeSettings>) => void;
  saveToServer: () => Promise<SaveToServerResult>;
}

const CascadeSettingsContext = createContext<CascadeSettingsContextValue | null>(null);

export function CascadeSettingsProvider({ children }: { children: React.ReactNode }) {
  const { accountId } = useTrading();
  const [settings, setSettings] = useState<CascadeSettings>(DEFAULTS);
  const [cascadeLotSize, setCascadeLotSizeState] = useState(0.04);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cascadeLotRef = useRef(cascadeLotSize);
  cascadeLotRef.current = cascadeLotSize;

  const setCascadeLotSize = useCallback((lots: number) => {
    const v = Math.max(0.01, Math.round(lots * 100) / 100);
    setCascadeLotSizeState(v);
    void AsyncStorage.setItem(LOT_SIZE_CASCADE_KEY, String(v));
  }, []);

  useEffect(() => {
    void AsyncStorage.getItem(LOT_SIZE_CASCADE_KEY).then((v) => {
      const parsed = v ? parseFloat(v) : NaN;
      if (Number.isFinite(parsed) && parsed >= 0.01) setCascadeLotSizeState(parsed);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const keys = storageKeys(accountId);
        const allKeys = [...Object.values(keys), GLOBAL_AUTO_CASCADE_KEY, LOT_SIZE_CASCADE_KEY];
        const record = await AsyncStorage.getMany(allKeys);
        const lotRaw = record[LOT_SIZE_CASCADE_KEY];
        const cascadeLot = lotRaw != null && Number.isFinite(parseFloat(lotRaw))
          ? Math.max(0.01, parseFloat(lotRaw))
          : cascadeLotRef.current;

        const [num, between, sl, tpEnabled, tpPips, tp1, tp2, tp3, tp4, riskFree, autoBe, tp1Lots, tp2Lots, tp3Lots, tp1Pct, tp2Pct, tp3Pct, tp4Pct, tp1En, tp2En, tp3En, tp4En, globalAutoEnabled] = allKeys.map((k) => record[k]);

        let autoCascadeEnabled = DEFAULTS.autoCascadeEnabled;
        if (globalAutoEnabled !== null) {
          autoCascadeEnabled = globalAutoEnabled === "true";
        } else {
          const legacyKey = accountId ? `cascade_${accountId}_auto_enabled` : "cascade_auto_enabled";
          const legacyRecord = await AsyncStorage.getMany([legacyKey]);
          const legacy = legacyRecord[legacyKey];
          autoCascadeEnabled = legacy === "true";
          await AsyncStorage.setItem(GLOBAL_AUTO_CASCADE_KEY, String(autoCascadeEnabled));
        }

        const storedPips = between ? parseFloat(between) : DEFAULTS.pipsBetween;
        let local: CascadeSettings = {
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
          riskFreePips: (() => {
            if (riskFree == null) return DEFAULTS.riskFreePips;
            const parsed = parseFloat(riskFree);
            return VALID_RISK_FREE_PIPS.includes(parsed) ? parsed : DEFAULTS.riskFreePips;
          })(),
          autoBeAtTp: (() => {
            const n = autoBe != null ? parseInt(autoBe, 10) : DEFAULTS.autoBeAtTp;
            if (n === 3) return 3 as const;
            if (n === 1 || n === 2) return 2 as const;
            return DEFAULTS.autoBeAtTp;
          })(),
          tp1Pct: tp1Pct != null ? parseFloat(tp1Pct) : DEFAULTS.tp1Pct,
          tp2Pct: tp2Pct != null ? parseFloat(tp2Pct) : DEFAULTS.tp2Pct,
          tp3Pct: tp3Pct != null ? parseFloat(tp3Pct) : DEFAULTS.tp3Pct,
          tp4Pct: tp4Pct != null ? parseFloat(tp4Pct) : DEFAULTS.tp4Pct,
          tp1Lots: tp1Lots != null ? parseFloat(tp1Lots)
            : pctToLots(cascadeLot, tp1Pct != null ? parseFloat(tp1Pct) : DEFAULTS.tp1Pct),
          tp2Lots: tp2Lots != null ? parseFloat(tp2Lots)
            : pctToLots(cascadeLot, tp2Pct != null ? parseFloat(tp2Pct) : DEFAULTS.tp2Pct),
          tp3Lots: tp3Lots != null ? parseFloat(tp3Lots)
            : pctToLots(cascadeLot, tp3Pct != null ? parseFloat(tp3Pct) : DEFAULTS.tp3Pct),
          tp1Enabled: tp1En != null ? tp1En === "true" : DEFAULTS.tp1Enabled,
          tp2Enabled: tp2En != null ? tp2En === "true" : DEFAULTS.tp2Enabled,
          tp3Enabled: tp3En != null ? tp3En === "true" : DEFAULTS.tp3Enabled,
          tp4Enabled: tp4En != null ? tp4En === "true" : DEFAULTS.tp4Enabled,
        };

        const serverCfg = await fetchFromServer(accountId);
        if (serverCfg) {
          local = mergeServerConfig(local, serverCfg, cascadeLot);
        }

        if (cancelled) return;
        setCascadeLotSizeState(cascadeLot);
        setSettings(local);
      } catch (e) {
        console.warn("[CascadeSettings] failed to load from storage:", e);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [accountId]);

  const persistLocal = useCallback((next: CascadeSettings) => {
    const keys = storageKeys(accountId);
    AsyncStorage.setMany({
      [keys.numPositions]: String(next.numPositions),
      [keys.pipsBetween]: String(next.pipsBetween),
      [keys.slPips]: String(next.slPips),
      [keys.takeProfitEnabled]: String(next.takeProfitEnabled),
      [keys.takeProfitPips]: String(next.takeProfitPips),
      [keys.tp1Pips]: String(next.tp1Pips),
      [keys.tp2Pips]: String(next.tp2Pips),
      [keys.tp3Pips]: String(next.tp3Pips),
      [keys.tp4Pips]: String(next.tp4Pips),
      [keys.riskFreePips]: String(next.riskFreePips),
      [keys.autoBeAtTp]: String(next.autoBeAtTp),
      [keys.tp1Lots]: String(next.tp1Lots),
      [keys.tp2Lots]: String(next.tp2Lots),
      [keys.tp3Lots]: String(next.tp3Lots),
      [keys.tp1Pct]: String(next.tp1Pct),
      [keys.tp2Pct]: String(next.tp2Pct),
      [keys.tp3Pct]: String(next.tp3Pct),
      [keys.tp4Pct]: String(next.tp4Pct),
      [keys.tp1Enabled]: String(next.tp1Enabled),
      [keys.tp2Enabled]: String(next.tp2Enabled),
      [keys.tp3Enabled]: String(next.tp3Enabled),
      [keys.tp4Enabled]: String(next.tp4Enabled),
      [GLOBAL_AUTO_CASCADE_KEY]: String(next.autoCascadeEnabled),
    });
  }, [accountId]);

  const schedulePush = useCallback((next: CascadeSettings) => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      void pushToServer(next, accountId, cascadeLotRef.current);
    }, 400);
  }, [accountId]);

  const updateSettings = useCallback((partial: Partial<CascadeSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      persistLocal(next);
      schedulePush(next);
      return next;
    });
  }, [accountId, persistLocal, schedulePush]);

  const saveToServer = useCallback(async (): Promise<SaveToServerResult> => {
    if (!API_BASE) {
      return { ok: false, message: "API URL not configured." };
    }
    const token = await getAuthToken();
    if (!token) {
      return { ok: false, message: "Sign in to save settings to the server." };
    }
    try {
      const res = await authFetch(cascadeConfigUrl(accountId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildServerPayload(settings, cascadeLotSize)),
      });
      if (res.ok) return { ok: true };
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, message: body.error ?? `Server rejected settings (${res.status})` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Network error" };
    }
  }, [accountId, settings, cascadeLotSize]);

  useEffect(() => () => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
  }, []);

  return React.createElement(
    CascadeSettingsContext.Provider,
    { value: { settings, cascadeLotSize, setCascadeLotSize, updateSettings, saveToServer } },
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
