import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

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

/**
 * Builds the cascade levels from the current market price.
 * The first order is always a market order (placed instantly).
 * The remaining (numPositions - 1) orders are limit orders placed
 * below market for buys, or above market for sells.
 * All orders share the same stop loss.
 */
export function buildCascadeLevels(
  marketPrice: number,
  direction: "buy" | "sell",
  settings: CascadeSettings
): { limitEntries: number[]; stopLoss: number } {
  const { numPositions, pipsBetween, slPips } = settings;
  const step = pipsBetween * PIP;
  const slDist = slPips * PIP;

  // Limit entries start one interval away from market price
  const limitEntries: number[] = [];
  for (let i = 1; i < numPositions; i++) {
    const price = direction === "buy"
      ? parseFloat((marketPrice - i * step).toFixed(2))
      : parseFloat((marketPrice + i * step).toFixed(2));
    limitEntries.push(price);
  }

  // SL is measured from the furthest limit entry (or market if no limits)
  const furthestEntry = limitEntries.length > 0
    ? limitEntries[limitEntries.length - 1]
    : marketPrice;
  const stopLoss = direction === "buy"
    ? parseFloat((furthestEntry - slDist).toFixed(2))
    : parseFloat((furthestEntry + slDist).toFixed(2));

  return { limitEntries, stopLoss };
}
