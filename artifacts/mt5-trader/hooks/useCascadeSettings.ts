import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

export interface CascadeSettings {
  numPositions: number;
  pipsBetween: number;
  slPips: number;
}

const DEFAULTS: CascadeSettings = {
  numPositions: 3,
  pipsBetween: 20,
  slPips: 10,
};

const KEYS = {
  numPositions: "cascade_num_positions",
  pipsBetween: "cascade_pips_between",
  slPips: "cascade_sl_pips",
};

export function useCascadeSettings() {
  const [settings, setSettingsState] = useState<CascadeSettings>(DEFAULTS);

  useEffect(() => {
    AsyncStorage.multiGet(Object.values(KEYS)).then((pairs) => {
      const [num, between, sl] = pairs.map((p) => (p[1] ? parseFloat(p[1]) : null));
      setSettingsState({
        numPositions: num ?? DEFAULTS.numPositions,
        pipsBetween: between ?? DEFAULTS.pipsBetween,
        slPips: sl ?? DEFAULTS.slPips,
      });
    });
  }, []);

  const updateSettings = useCallback((partial: Partial<CascadeSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...partial };
      AsyncStorage.multiSet([
        [KEYS.numPositions, String(next.numPositions)],
        [KEYS.pipsBetween, String(next.pipsBetween)],
        [KEYS.slPips, String(next.slPips)],
      ]);
      return next;
    });
  }, []);

  return { settings, updateSettings };
}

// XAUUSD: 1 pip = $0.10
const PIP = 0.10;

export function buildCascadeLevels(
  firstPrice: number,
  direction: "buy" | "sell",
  settings: CascadeSettings
): { entries: number[]; stopLoss: number } {
  const { numPositions, pipsBetween, slPips } = settings;
  const step = pipsBetween * PIP;
  const slDist = slPips * PIP;

  const entries: number[] = [];
  for (let i = 0; i < numPositions; i++) {
    const price = direction === "buy"
      ? parseFloat((firstPrice - i * step).toFixed(2))
      : parseFloat((firstPrice + i * step).toFixed(2));
    entries.push(price);
  }

  const lastEntry = entries[entries.length - 1];
  const stopLoss = direction === "buy"
    ? parseFloat((lastEntry - slDist).toFixed(2))
    : parseFloat((lastEntry + slDist).toFixed(2));

  return { entries, stopLoss };
}
