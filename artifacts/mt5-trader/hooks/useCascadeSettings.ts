import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface CascadeSettings {
  numPositions: number;
  pipsBetween: number;
  slPips: number;
}

const DEFAULTS: CascadeSettings = {
  numPositions: 3,
  pipsBetween: 50,
  slPips: 100,
};

const KEYS = {
  numPositions: "cascade_num_positions",
  pipsBetween: "cascade_pips_between",
  slPips: "cascade_sl_pips",
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
      const [num, between, sl] = pairs.map((p) => (p[1] ? parseFloat(p[1]) : null));
      setSettings({
        numPositions: num ?? DEFAULTS.numPositions,
        pipsBetween: between ?? DEFAULTS.pipsBetween,
        slPips: sl ?? DEFAULTS.slPips,
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

  const furthestEntry = limitEntries.length > 0
    ? limitEntries[limitEntries.length - 1]
    : marketPrice;
  const stopLoss = direction === "buy"
    ? parseFloat((furthestEntry - slDist).toFixed(2))
    : parseFloat((furthestEntry + slDist).toFixed(2));

  return { limitEntries, stopLoss };
}
