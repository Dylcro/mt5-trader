import { useCallback, useEffect, useRef, useState } from "react";

import { getAuthToken } from "@/lib/authToken";
import { periodStartMs, type Period } from "@/lib/zoneStats";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

export function useRealizedPnl(
  accountId: string,
  period: Period,
  region: string,
  refreshKey = 0,
) {
  const [pnl, setPnl] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!API_BASE || !accountId) {
      setPnl(null);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const since = periodStartMs(period);
      const token = await getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const qs = new URLSearchParams({
        since: String(since),
        region: region || "london",
      });
      const res = await fetch(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/realized-pnl?${qs}`,
        { headers },
      );
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setPnl(null);
        return;
      }
      const data = (await res.json()) as { pnl?: number };
      setPnl(typeof data.pnl === "number" ? data.pnl : 0);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setPnl(null);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [accountId, period, region]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  return { pnl, loading, error, refresh };
}
