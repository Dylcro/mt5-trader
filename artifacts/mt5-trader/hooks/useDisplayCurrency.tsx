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
import { getAuthToken } from "@/lib/authToken";
import { formatCompactMoney as formatCompactMoneyLib, formatMoney as formatMoneyLib } from "@/lib/formatters";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

interface DisplayCurrencyContextValue {
  currency: DisplayCurrency;
  brokerCurrency: DisplayCurrency | null;
  setCurrency: (c: DisplayCurrency) => Promise<void>;
  /** Amount already in display currency (balance, closed P&L, etc.). */
  formatMoney: (n: number, opts?: { signed?: boolean; decimals?: number }) => string;
  /** XAUUSD risk quoted in USD — converted using live FX before formatting. */
  formatUsdMoney: (usd: number, opts?: { signed?: boolean; decimals?: number }) => string;
  formatCompactMoney: (n: number) => string;
  usdToDisplayRate: number;
}

const Ctx = createContext<DisplayCurrencyContextValue | null>(null);

export function DisplayCurrencyProvider({ children }: { children: React.ReactNode }) {
  const { accountInfo, status, accountId, region } = useTrading();
  const [currency, setCurrencyState] = useState<DisplayCurrency>("USD");
  const [ready, setReady] = useState(false);
  const [usdToDisplayRate, setUsdToDisplayRate] = useState(1);

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

  useEffect(() => {
    if (currency === "USD") {
      setUsdToDisplayRate(1);
      return;
    }
    if (!API_BASE || status !== "connected" || !accountId) {
      setUsdToDisplayRate(1);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await getAuthToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const rgn = encodeURIComponent(region || "london");
        const res = await fetch(
          `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/display-fx?to=${currency}&region=${rgn}`,
          { headers },
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { rate?: number };
        const rate = Number(data.rate);
        const plausible =
          currency === "JPY"
            ? rate >= 50 && rate <= 300
            : rate >= 0.25 && rate <= 2.5;
        if (!cancelled && Number.isFinite(rate) && rate > 0 && plausible) {
          setUsdToDisplayRate(rate);
        }
      } catch {
        if (!cancelled) setUsdToDisplayRate(1);
      }
    })();
    return () => { cancelled = true; };
  }, [currency, status, accountId, region]);

  const formatMoney = useCallback(
    (n: number, opts?: { signed?: boolean; decimals?: number }) =>
      formatMoneyLib(n, { ...opts, currency }),
    [currency],
  );

  const formatUsdMoney = useCallback(
    (usd: number, opts?: { signed?: boolean; decimals?: number }) =>
      formatMoneyLib(usd * usdToDisplayRate, { ...opts, currency }),
    [currency, usdToDisplayRate],
  );

  const formatCompactMoney = useCallback(
    (n: number) => formatCompactMoneyLib(n, currency),
    [currency],
  );

  const value = useMemo(
    () => ({
      currency,
      brokerCurrency,
      setCurrency,
      formatMoney,
      formatUsdMoney,
      formatCompactMoney,
      usdToDisplayRate,
    }),
    [currency, brokerCurrency, setCurrency, formatMoney, formatUsdMoney, formatCompactMoney, usdToDisplayRate],
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
