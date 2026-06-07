import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeAccountEvents } from "@/lib/accountEventBus";
import { authFetch, authFetchWithTimeout } from "@/lib/authFetch";
import { enrichZoneDisplayFields } from "@/lib/zoneDisplay";
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
  /** Single exit bucket for history stats (RF | SL | MANUAL | TP1–TP4). */
  primaryOutcome?: "RF" | "SL" | "MANUAL" | "TP4" | "TP3" | "TP2" | "TP1" | "NONE";
  /** Closed by user/app or MT5 without TP4 automation. */
  manualClose?: boolean;
  /** Closed because broker stop loss was hit (not risk-free SL). */
  slHit?: boolean;
  /** SL on survivor after Risk free — History RF, not SL. */
  riskFreeSlExit?: boolean;
  positionCount: number;
  originalVolume?: number;
  tp1Pct?: number;
  tp2Pct?: number;
  tp3Pct?: number;
  tp4Pct?: number;
  runner1Price?: number | null;
  runner1Lots?: number | null;
  runner2Price?: number | null;
  runner2Lots?: number | null;
  runner3Price?: number | null;
  runner3Lots?: number | null;
  runner1Hit?: boolean;
  runner2Hit?: boolean;
  runner3Hit?: boolean;
  runnerActive?: boolean;
  runner1Notified?: boolean;
  runner2Notified?: boolean;
  runner3Notified?: boolean;
  currentPrice?: number | null;
  nextTp?: 0 | 1 | 2 | 3 | 4;
  nextTpPrice?: number | null;
  pipsToNextTp?: number | null;
  progressPct?: number | null;
}

interface UseZonesOptions {
  includeClosed?: boolean;
  pollIntervalMs?: number;
  /** MetaAPI region for zone trade routes (must match connected account). */
  region?: string;
  /** When true, SSE is live and zone_update events patch state directly.
   *  The poll interval is stretched to 60 s (safety net only). */
  sseConnected?: boolean;
}

function zoneTradeQuery(region?: string): string {
  const r = (region?.trim() || "london");
  return `?region=${encodeURIComponent(r)}`;
}

/** One-way latch so TP pills never revert after a pullback (server or thin SSE). */
function withLatchedHits(
  z: Zone,
  latch: Map<string, { tp1: boolean; tp2: boolean; tp3: boolean; tp4: boolean }>,
): Zone {
  const prev = latch.get(z.zoneId) ?? { tp1: false, tp2: false, tp3: false, tp4: false };
  const next = {
    tp1: prev.tp1 || Boolean(z.tp1Hit),
    tp2: prev.tp2 || Boolean(z.tp2Hit),
    tp3: prev.tp3 || Boolean(z.tp3Hit),
    tp4: prev.tp4 || Boolean(z.tp4Hit),
  };
  latch.set(z.zoneId, next);
  return { ...z, tp1Hit: next.tp1, tp2Hit: next.tp2, tp3Hit: next.tp3, tp4Hit: next.tp4 };
}

export function useZones(accountId: string, options: UseZonesOptions = {}) {
  const { includeClosed = false, pollIntervalMs = 5_000, sseConnected = false, region } = options;
  // SSE zone_update events are the primary source of zone changes.
  // When connected: 60 s safety net (SSE handles all real-time updates).
  // When disconnected: 15 s fallback cadence (aligned with SSE fallback contract).
  const effectivePollMs = sseConnected ? 60_000 : 15_000;
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const hitLatch = useRef<Map<string, { tp1: boolean; tp2: boolean; tp3: boolean; tp4: boolean }>>(new Map());

  const mergeZoneList = useCallback((prev: Zone[], incoming: Zone[]): Zone[] => {
    const byId = new Map(prev.map((z) => [z.zoneId, z]));
    for (const z of incoming) {
      const existing = byId.get(z.zoneId);
      byId.set(z.zoneId, existing
        ? enrichZoneDisplayFields(withLatchedHits({ ...existing, ...z }, hitLatch.current))
        : enrichZoneDisplayFields(withLatchedHits(z, hitLatch.current)));
    }
    const merged = Array.from(byId.values());
    const filtered = includeClosed ? merged : merged.filter((z) => z.status !== "CLOSED");
    const ids = new Set(filtered.map((z) => z.zoneId));
    for (const id of hitLatch.current.keys()) {
      if (!ids.has(id)) hitLatch.current.delete(id);
    }
    return filtered;
  }, [includeClosed]);

  const applyZonesFromApi = useCallback((data: unknown, prev: Zone[] = []) => {
    const list = Array.isArray(data) ? (data as Zone[]) : [];
    return mergeZoneList(prev, list);
  }, [mergeZoneList]);

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
      const data = await res.json();
      setZones((prev) => applyZonesFromApi(data, prev));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, [accountId, includeClosed, applyZonesFromApi]);

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
        if (update.status === "CLOSED") {
          hitLatch.current.delete(update.zoneId!);
          if (includeClosed) {
            setZones((prev) => {
              const existing = prev.find((z) => z.zoneId === update.zoneId);
              const merged = {
                ...existing,
                ...update,
                status: "CLOSED" as const,
                closedAt: update.closedAt ?? existing?.closedAt ?? Date.now(),
              } as Zone;
              if (!merged.zoneId) return prev;
              const without = prev.filter((z) => z.zoneId !== update.zoneId);
              return [...without, enrichZoneDisplayFields(withLatchedHits(merged, hitLatch.current))];
            });
          } else {
            setZones((prev) => prev.filter((z) => z.zoneId !== update.zoneId));
          }
          return;
        }
        setZones((prev) => {
          const existing = prev.find((z) => z.zoneId === update.zoneId);
          if (existing) {
            return prev.map((z) => {
              if (z.zoneId !== update.zoneId) return z;
              return enrichZoneDisplayFields(withLatchedHits({ ...z, ...update }, hitLatch.current));
            });
          }
          return [...prev, enrichZoneDisplayFields(withLatchedHits(update as Zone, hitLatch.current))];
        });
      } else if (type === "runner_alert") {
        // Handled by positions screen banner — no zone list patch needed here.
      } else if (type === "deal" || type === "pending_order") {
        void refresh();
      }
    });
  }, [accountId, refresh, includeClosed]);

  const riskFree = useCallback(async (
    zoneId: string,
    opts?: { riskFreePips?: number },
  ): Promise<{ ok: boolean; message?: string }> => {
    if (!API_BASE || !accountId) return { ok: false, message: "No account" };
    try {
      const res = await authFetchWithTimeout(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones/${encodeURIComponent(zoneId)}/risk-free${zoneTradeQuery(region)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts?.riskFreePips != null ? { riskFreePips: opts.riskFreePips } : {}),
        },
      );
      const data = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string };
      void refresh();
      if (res.ok && data.ok) return { ok: true };
      return { ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [accountId, region, refresh]);

  const closeZone = useCallback(async (
    zoneId: string,
  ): Promise<{ ok: boolean; message?: string; closedCount?: number }> => {
    if (!API_BASE || !accountId) return { ok: false, message: "No account" };
    try {
      const res = await authFetchWithTimeout(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones/${encodeURIComponent(zoneId)}/close${zoneTradeQuery(region)}`,
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
  }, [accountId, region, refresh]);

  // Cancel pending cascade limit orders for the zone without touching open
  // positions. Powers the "Delete Orders" button on each zone card.
  const closeAllWorst = useCallback(async (
    zoneId: string,
  ): Promise<{ ok: boolean; message?: string; closedCount?: number }> => {
    if (!API_BASE || !accountId) return { ok: false, message: "No account" };
    try {
      const res = await authFetchWithTimeout(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones/${encodeURIComponent(zoneId)}/close-worst${zoneTradeQuery(region)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const raw = await res.text();
      let data: {
        ok?: boolean; message?: string; error?: string;
        closedCount?: number; skipped?: boolean; bestPositionId?: string;
      } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        const hint = res.headers.get("content-type")?.includes("text/html")
          ? "Server returned HTML — publish the latest API on Replit (close-worst route missing)."
          : "Invalid server response.";
        return { ok: false, message: hint };
      }
      void refresh();
      const succeeded = data.ok === true
        || data.skipped === true
        || (typeof data.bestPositionId === "string" && data.bestPositionId.length > 0);
      if (res.ok && succeeded) {
        return { ok: true, closedCount: data.closedCount ?? 0 };
      }
      if (data.error || data.message) {
        return { ok: false, message: data.message ?? data.error };
      }
      if (res.status === 404) {
        return { ok: false, message: "Close All Worst API not found — merge and publish the latest API on Replit." };
      }
      return {
        ok: false,
        message: res.ok
          ? "Unexpected server response — publish the latest API on Replit."
          : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [accountId, region, refresh]);

  const cancelZoneOrders = useCallback(async (
    zoneId: string,
  ): Promise<{ ok: boolean; message?: string; cancelledCount?: number }> => {
    if (!API_BASE || !accountId) return { ok: false, message: "No account" };
    try {
      const res = await authFetchWithTimeout(
        `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones/${encodeURIComponent(zoneId)}/cancel-pending${zoneTradeQuery(region)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      const data = await res.json().catch(() => ({})) as {
        ok?: boolean; message?: string; error?: string; cancelledCount?: number; zoneClosed?: boolean;
      };
      void refresh();
      if (res.ok && data.ok) {
        return { ok: true, cancelledCount: data.cancelledCount };
      }
      return { ok: false, message: data.message ?? data.error ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [accountId, region, refresh]);

  return { zones, loading, error, refresh, riskFree, closeZone, closeAllWorst, cancelZoneOrders };
}

export function sortZonesRunnerLast(zones: Zone[]): Zone[] {
  return [...zones].sort((a, b) => {
    if (a.runnerActive && !b.runnerActive) return 1;
    if (!a.runnerActive && b.runnerActive) return -1;
    return 0;
  });
}
