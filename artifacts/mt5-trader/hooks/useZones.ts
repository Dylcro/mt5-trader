import { useCallback, useEffect, useRef, useState } from "react";

import { getAuthToken } from "@/lib/authToken";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

export interface Zone {
  zoneId: string;
  direction: "buy" | "sell";
  anchorPrice: number;
  // Absolute TP prices (tp4 optional — null = left for manual close).
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
  tp4Price: number | null;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  tp4Hit: boolean;
  cashoutDone: boolean;
  status: "OPEN" | "RISK_FREE" | "CLOSED";
  createdAt: number;
  closedAt?: number | null;
  finalTpReached?: 0 | 1 | 2 | 3 | 4;
  positionCount: number;
  currentPrice?: number | null;
  nextTp?: 0 | 1 | 2 | 3 | 4;
  nextTpPrice?: number | null;
  pipsToNextTp?: number | null;
  progressPct?: number | null;
}

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

interface UseZonesOptions {
  includeClosed?: boolean;
  pollIntervalMs?: number;
}

export function useZones(accountId: string, options: UseZonesOptions = {}) {
  const { includeClosed = false, pollIntervalMs = 5_000 } = options;
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!API_BASE || !accountId || inFlight.current) return;
    inFlight.current = true;
    try {
      const qs = includeClosed ? "?includeClosed=true" : "";
      const res = await authFetch(`${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones${qs}`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as Zone[];
      setZones(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, [accountId, includeClosed]);

  useEffect(() => {
    if (!API_BASE || !accountId) {
      setZones([]);
      return;
    }
    setLoading(true);
    void refresh().finally(() => setLoading(false));
    const id = setInterval(() => void refresh(), pollIntervalMs);
    return () => clearInterval(id);
  }, [accountId, pollIntervalMs, refresh]);

  const riskFree = useCallback(async (zoneId: string): Promise<{ ok: boolean; message?: string }> => {
    if (!API_BASE || !accountId) return { ok: false, message: "No account" };
    try {
      const res = await authFetch(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones/${encodeURIComponent(zoneId)}/risk-free`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string };
      void refresh();
      if (res.ok && data.ok) return { ok: true };
      return { ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [accountId, refresh]);

  return { zones, loading, error, refresh, riskFree };
}
