import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthToken } from "@/lib/authToken";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

export type CandleTimeframe = "1m" | "5m" | "15m" | "1h";

export interface OhlcCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function useCandles(
  accountId: string,
  timeframe: CandleTimeframe,
  limit = 200,
) {
  const [candles, setCandles] = useState<OhlcCandle[]>([]);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const fetchCandles = useCallback(async () => {
    if (!API_BASE || !accountId || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const token = await getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/candles?timeframe=${timeframe}&limit=${limit}`,
        { headers },
      );
      if (!res.ok) return;
      const data = (await res.json()) as Array<{
        time: string;
        open: number;
        high: number;
        low: number;
        close: number;
      }>;
      setCandles(
        data.map((c) => ({
          time: Math.floor(new Date(c.time).getTime() / 1000),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
    } catch {
      // silently ignore — chart stays on last known data
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [accountId, timeframe, limit]);

  useEffect(() => {
    void fetchCandles();
    const id = setInterval(() => void fetchCandles(), 30_000);
    return () => clearInterval(id);
  }, [fetchCandles]);

  return { candles, loading, refetch: fetchCandles };
}
