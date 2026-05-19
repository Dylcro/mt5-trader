import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface CascadeSettings {
  numPositions: number;
  pipsBetween: number;
  slPips: number;
  autoCloseLimitsEnabled: boolean;
  autoCloseLimitsPips: number;
  takeProfitEnabled: boolean;
  takeProfitPips: number;
  autoTriggerEnabled: boolean;
}

const DEFAULTS: CascadeSettings = {
  numPositions: 3,
  pipsBetween: 50,
  slPips: 40,
  autoCloseLimitsEnabled: false,
  autoCloseLimitsPips: 10,
  takeProfitEnabled: true,
  takeProfitPips: 40,
  autoTriggerEnabled: false,
};

const KEYS = {
  numPositions: "cascade_num_positions",
  pipsBetween: "cascade_pips_between",
  slPips: "cascade_sl_pips",
  autoCloseLimitsEnabled: "cascade_auto_close_enabled",
  autoCloseLimitsPips: "cascade_auto_close_pips",
  takeProfitEnabled: "cascade_tp_enabled",
  takeProfitPips: "cascade_tp_pips",
  autoTriggerEnabled: "cascade_auto_trigger",
};

interface CascadeSettingsContextValue {
  settings: CascadeSettings;
  updateSettings: (partial: Partial<CascadeSettings>) => void;
}

const CascadeSettingsContext = createContext<CascadeSettingsContextValue | null>(null);

export function CascadeSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<CascadeSettings>(DEFAULTS);

  useEffect(() => {
    AsyncStorage.multiGet(Object.values(KEYS)).then((pairs) => {
      const [num, between, sl, autoClose, autoClosePips, tpEnabled, tpPips, autoTrigger] = pairs.map((p) => p[1]);
      setSettings({
        numPositions: num ? parseFloat(num) : DEFAULTS.numPositions,
        pipsBetween: between ? parseFloat(between) : DEFAULTS.pipsBetween,
        slPips: sl ? parseFloat(sl) : DEFAULTS.slPips,
        autoCloseLimitsEnabled: autoClose === "true",
        autoCloseLimitsPips: autoClosePips ? parseFloat(autoClosePips) : DEFAULTS.autoCloseLimitsPips,
        takeProfitEnabled: tpEnabled === "true",
        takeProfitPips: tpPips ? parseFloat(tpPips) : DEFAULTS.takeProfitPips,
        autoTriggerEnabled: autoTrigger === "true",
      });
    });
  }, []);

  const updateSettings = useCallback((partial: Partial<CascadeSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      AsyncStorage.multiSet([
        [KEYS.numPositions, String(next.numPositions)],
        [KEYS.pipsBetween, String(next.pipsBetween)],
        [KEYS.slPips, String(next.slPips)],
        [KEYS.autoCloseLimitsEnabled, String(next.autoCloseLimitsEnabled)],
        [KEYS.autoCloseLimitsPips, String(next.autoCloseLimitsPips)],
        [KEYS.takeProfitEnabled, String(next.takeProfitEnabled)],
        [KEYS.takeProfitPips, String(next.takeProfitPips)],
        [KEYS.autoTriggerEnabled, String(next.autoTriggerEnabled)],
      ]);
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
): { limitEntries: number[]; stopLoss: number; takeProfit?: number } {
  const { numPositions, pipsBetween, slPips, takeProfitEnabled, takeProfitPips } = settings;
  const step = pipsBetween * PIP;
  const slDist = slPips * PIP;
  const tpDist = takeProfitPips * PIP;

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

  // TP is the same absolute price for all orders in the cascade (shared target)
  const takeProfit = takeProfitEnabled && takeProfitPips > 0
    ? (direction === "buy"
        ? parseFloat((marketPrice + tpDist).toFixed(2))
        : parseFloat((marketPrice - tpDist).toFixed(2)))
    : undefined;

  return { limitEntries, stopLoss, takeProfit };
}
