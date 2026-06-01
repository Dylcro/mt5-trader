import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useTrading } from "@/context/TradingContext";
import {
  DISPLAY_CURRENCY_STORAGE_KEY,
  normalizeDisplayCurrency,
  type DisplayCurrency,
} from "@/lib/displayCurrency";
import { formatCompactMoney as formatCompactMoneyLib, formatMoney as formatMoneyLib } from "@/lib/formatters";

interface DisplayCurrencyContextValue {
  currency: DisplayCurrency;
  brokerCurrency: DisplayCurrency | null;
  setCurrency: (c: DisplayCurrency) => Promise<void>;
  formatMoney: (n: number, opts?: { signed?: boolean; decimals?: number }) => string;
  formatCompactMoney: (n: number) => string;
}

const Ctx = createContext<DisplayCurrencyContextValue | null>(null);

export function DisplayCurrencyProvider({ children }: { children: React.ReactNode }) {
  const { accountInfo, status } = useTrading();
  const [currency, setCurrencyState] = useState<DisplayCurrency>("USD");
  const [ready, setReady] = useState(false);

  const brokerCurrency = useMemo(
    () => (accountInfo?.currency ? normalizeDisplayCurrency(accountInfo.currency) : null),
    [accountInfo?.currency],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY);
        if (cancelled) return;
        if (saved) {
          setCurrencyState(normalizeDisplayCurrency(saved));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // First run: no saved preference → match MT5 account currency when connected.
  useEffect(() => {
    if (!ready || status !== "connected" || !brokerCurrency) return;
    void (async () => {
      const saved = await AsyncStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY);
      if (!saved) {
        setCurrencyState(brokerCurrency);
        await AsyncStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, brokerCurrency);
      }
    })();
  }, [ready, status, brokerCurrency]);

  const setCurrency = useCallback(async (c: DisplayCurrency) => {
    setCurrencyState(c);
    await AsyncStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, c);
  }, []);

  const formatMoney = useCallback(
    (n: number, opts?: { signed?: boolean; decimals?: number }) =>
      formatMoneyLib(n, { ...opts, currency }),
    [currency],
  );

  const formatCompactMoney = useCallback(
    (n: number) => formatCompactMoneyLib(n, currency),
    [currency],
  );

  const value = useMemo(
    () => ({ currency, brokerCurrency, setCurrency, formatMoney, formatCompactMoney }),
    [currency, brokerCurrency, setCurrency, formatMoney, formatCompactMoney],
  );

  return React.createElement(Ctx.Provider, { value }, children);
}

export function useDisplayCurrency() {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useDisplayCurrency must be used inside DisplayCurrencyProvider");
  }
  return ctx;
}
