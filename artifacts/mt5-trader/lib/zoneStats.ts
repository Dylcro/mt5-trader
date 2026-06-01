import type { Zone } from "@/hooks/useZones";

export type Period = "today" | "week";

export function periodStartMs(period: Period): number {
  const now = new Date();
  if (period === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff).getTime();
}

export function filterClosedZonesByPeriod(zones: Zone[], period: Period): Zone[] {
  const start = periodStartMs(period);
  return zones.filter((z) => {
    if (z.status !== "CLOSED") return false;
    // Prefer close time — createdAt alone excludes zones opened earlier but closed today.
    if (z.closedAt != null && z.closedAt > 0) return z.closedAt >= start;
    return z.createdAt >= start;
  });
}

export function countTpHits(zones: Zone[], level: 1 | 2 | 3): number {
  const key = `tp${level}Hit` as const;
  return zones.filter((z) => Boolean(z[key])).length;
}

export function countManualCloses(zones: Zone[]): number {
  return zones.filter((z) => Boolean(z.manualClose)).length;
}

export function countSlHits(zones: Zone[]): number {
  return zones.filter((z) => Boolean(z.slHit)).length;
}

/** Win = closed zone with positive realized P&L; falls back to TP hits when P&L not settled yet. */
export function isZoneWin(z: Zone): boolean {
  if (typeof z.closedPnl === "number" && Number.isFinite(z.closedPnl)) {
    return z.closedPnl > 0;
  }
  if (z.finalTpReached != null && z.finalTpReached >= 1) return true;
  return Boolean(z.tp1Hit || z.tp2Hit || z.tp3Hit || z.tp4Hit);
}

export function winRatePct(zones: Zone[]): number | null {
  if (zones.length === 0) return null;
  const wins = zones.filter(isZoneWin).length;
  return Math.round((wins / zones.length) * 100);
}

/** Average realized P&L per closed zone (uses settled closedPnl rows). */
export function avgClosedZonePnl(zones: Zone[]): number | null {
  const withPnl = zones.filter(
    (z) => typeof z.closedPnl === "number" && Number.isFinite(z.closedPnl),
  );
  if (withPnl.length === 0) return null;
  const sum = withPnl.reduce((s, z) => s + (z.closedPnl as number), 0);
  return Math.round((sum / withPnl.length) * 100) / 100;
}

/** Fallback avg when per-zone P&L is not settled — total realized / closed zone count. */
export function avgClosedZonePnlFromTotal(
  zones: Zone[],
  periodRealizedPnl: number | null,
): number | null {
  const direct = avgClosedZonePnl(zones);
  if (direct != null) return direct;
  if (
    zones.length > 0 &&
    periodRealizedPnl != null &&
    Number.isFinite(periodRealizedPnl)
  ) {
    return Math.round((periodRealizedPnl / zones.length) * 100) / 100;
  }
  return null;
}

export function tpPillStyle(hits: number): "green" | "gold" | "grey" {
  if (hits >= 3) return "green";
  if (hits === 2) return "gold";
  return "grey";
}

export function isPositionRiskFree(
  direction: "buy" | "sell",
  entry: number,
  stopLoss: number | undefined,
  zoneStatus?: Zone["status"],
): boolean {
  if (zoneStatus === "RISK_FREE") return true;
  if (stopLoss == null) return false;
  const eps = 0.005;
  return direction === "buy" ? stopLoss >= entry - eps : stopLoss <= entry + eps;
}
