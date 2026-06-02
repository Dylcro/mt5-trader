import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeAccountEvents } from "@/lib/accountEventBus";
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
  tp1Enabled?: boolean;
  tp2Enabled?: boolean;
  tp3Enabled?: boolean;
  tp4Enabled?: boolean;
  enabledTpCount?: number;
  hitEnabledTpCount?: number;
  // True when TP2 fired but the broker rejected true break-even (SL at entry)
  // because price had retraced through entry. The engine applied the safest
  // protective SL it could and will keep trying to upgrade to true BE on
  // every tick. Surfaced as a warning chip on the active-zone card.
  tp2SlIsBestEffort?: boolean;
  cashoutDone: boolean;
  status: "OPEN" | "RISK_FREE" | "CLOSED" | "ARMED";
  createdAt: number;
  closedAt?: number | null;
  /** Broker realized P&L for the zone (profit+commission+swap). Set when zone closes. */
  closedPnl?: number | null;
  finalTpReached?: 0 | 1 | 2 | 3 | 4;
  /** Single exit bucket for history stats (SL | MANUAL | TP1–TP4). */
  primaryOutcome?: "SL" | "MANUAL" | "TP4" | "TP3" | "TP2" | "TP1" | "NONE";
  /** Closed by user/app or MT5 without TP4 automation. */
  manualClose?: boolean;
  /** Closed because broker stop loss was hit. */
  slHit?: boolean;
  positionCount: number;
  originalVolume?: number;
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
  /** When true, SSE is live and zone_update events patch state directly.
   *  The poll interval is stretched to 60 s (safety net only). */
  sseConnected?: boolean;
}

export function useZones(accountId: string, options: UseZonesOptions = {}) {
  const { includeClosed = false, pollIntervalMs = 5_000, sseConnected = false } = options;
  // SSE zone_update events are the primary source of zone changes.
  // When connected: 60 s safety net (SSE handles all real-time updates).
  // When disconnected: 15 s fallback cadence (aligned with SSE fallback contract).
  const effectivePollMs = sseConnected ? 60_000 : 15_000;
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
    const id = setInterval(() => void refresh(), effectivePollMs);
    return () => clearInterval(id);
  }, [accountId, effectivePollMs, refresh]);

  // Subscribe to SSE-driven zone events via the module-level accountEventBus.
  // zone_update → patch the matching zone in-place for instant TP/status changes.
  // deal        → re-fetch all zones so position counts stay accurate.
  useEffect(() => {
    if (!accountId) return;
    return subscribeAccountEvents(accountId, (type, data) => {
      if (type === "zone_update") {
        const update = data as Partial<Zone> & { zoneId?: string };
        if (!update.zoneId) return;
        setZones(prev =>
          prev.map((z) => {
            if (z.zoneId !== update.zoneId) return z;
            const next: Zone = { ...z, ...update };
            if (update.status === "CLOSED") {
              if (next.closedAt == null || next.closedAt <= 0) {
                next.closedAt = Date.now();
              }
            }
            return next;
          }),
        );
      } else if (type === "deal") {
        void refresh();
      }
    });
  }, [accountId, refresh]);

  const riskFree = useCallback(async (
    zoneId: string,
    opts: { riskFreePips?: number } = {},
  ): Promise<{ ok: boolean; message?: string }> => {
    if (!API_BASE || !accountId) return { ok: false, message: "No account" };
    try {
      const body: Record<string, unknown> = {};
      if (opts.riskFreePips !== undefined) body.riskFreePips = opts.riskFreePips;
      const res = await authFetch(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones/${encodeURIComponent(zoneId)}/risk-free`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string };
      void refresh();
      if (res.ok && data.ok) return { ok: true };
      return { ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [accountId, refresh]);

  const closeZone = useCallback(async (
    zoneId: string,
  ): Promise<{ ok: boolean; message?: string; closedCount?: number }> => {
    if (!API_BASE || !accountId) return { ok: false, message: "No account" };
    try {
      const res = await authFetch(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones/${encodeURIComponent(zoneId)}/close`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const data = await res.json().catch(() => ({})) as {
        ok?: boolean; message?: string; error?: string; closedCount?: number;
      };
      void refresh();
      if (res.ok && data.ok) return { ok: true, closedCount: data.closedCount };
      return { ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [accountId, refresh]);

  // Cancel pending cascade limit orders for the zone without touching open
  // positions. Powers the "Delete Orders" button on each zone card.
  const cancelZoneOrders = useCallback(async (
    zoneId: string,
  ): Promise<{ ok: boolean; message?: string; cancelledCount?: number }> => {
    if (!API_BASE || !accountId) return { ok: false, message: "No account" };
    try {
      const res = await authFetch(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones/${encodeURIComponent(zoneId)}/cancel-pending`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const data = await res.json().catch(() => ({})) as {
        ok?: boolean; message?: string; error?: string; cancelledCount?: number; zoneClosed?: boolean;
      };
      await refresh();
      if (res.ok && data.ok) {
        if (data.zoneClosed) {
          setZones((prev) => prev.filter((z) => z.zoneId !== zoneId));
        }
        return { ok: true, cancelledCount: data.cancelledCount };
      }
      return { ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [accountId, refresh]);

  return { zones, loading, error, refresh, riskFree, closeZone, cancelZoneOrders };
}
