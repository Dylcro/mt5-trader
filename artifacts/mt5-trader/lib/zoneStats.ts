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
    const ts = z.closedAt ?? z.createdAt;
    return ts >= start;
  });
}

export function countTpHits(zones: Zone[], level: 1 | 2 | 3): number {
  const key = `tp${level}Hit` as const;
  return zones.filter((z) => Boolean(z[key])).length;
}

/** Win = closed zone with positive realized P&L; falls back to TP1 hit for legacy rows. */
export function isZoneWin(z: Zone): boolean {
  if (typeof z.closedPnl === "number") return z.closedPnl > 0;
  return Boolean(z.tp1Hit);
}

export function winRatePct(zones: Zone[]): number | null {
  if (zones.length === 0) return null;
  const wins = zones.filter(isZoneWin).length;
  return Math.round((wins / zones.length) * 100);
}

export function tp2HitRatePct(zones: Zone[]): number | null {
  if (zones.length === 0) return null;
  const hits = zones.filter((z) => z.tp2Hit).length;
  return Math.round((hits / zones.length) * 100);
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
