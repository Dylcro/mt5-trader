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

/** TP4 with 0 pips / no price — final slice is manual in MT5, not an automated ladder level. */
export function isAutomatedTp4Level(
  z: Pick<Zone, "tp4Enabled" | "tp4Price">,
): boolean {
  if (z.tp4Enabled === false) return false;
  return z.tp4Price != null && z.tp4Price > 0;
}

/** How a closed zone ended (exit reason) — separate from day/week TP reach stats. */
export type ZonePrimaryOutcome = "SL" | "MANUAL" | "TP4" | "TP3" | "TP2" | "TP1" | "NONE";

/** Classify exit reason for a closed zone (optional card label). */
export function zonePrimaryOutcome(z: Zone): ZonePrimaryOutcome {
  if (z.primaryOutcome) return z.primaryOutcome;
  if (z.status !== "CLOSED") return "NONE";
  if (z.slHit) return "SL";
  if (z.manualClose) return "MANUAL";
  const final = z.finalTpReached ?? 0;
  if (final >= 4 && isAutomatedTp4Level(z)) return "TP4";
  if (final >= 3 && z.tp3Enabled !== false) return "TP3";
  if (final >= 2 && z.tp2Enabled !== false) return "TP2";
  if (final >= 1 && z.tp1Enabled !== false) return "TP1";
  return "MANUAL";
}

/** True only when this TP level was enabled and all prior ladder levels were hit. */
export function zoneReachedTpLevel(z: Zone, level: 1 | 2 | 3 | 4): boolean {
  if (level === 1) return z.tp1Enabled !== false && Boolean(z.tp1Hit);
  if (level === 2) return zoneReachedTpLevel(z, 1) && z.tp2Enabled !== false && Boolean(z.tp2Hit);
  if (level === 3) return zoneReachedTpLevel(z, 2) && z.tp3Enabled !== false && Boolean(z.tp3Hit);
  return zoneReachedTpLevel(z, 3) && isAutomatedTp4Level(z) && Boolean(z.tp4Hit);
}

/**
 * Day/week stats: count closed zones that reached TP{n} at least once.
 * One zone that hits TP1+TP2 adds +1 to TP1 and +1 to TP2 (not +1 per ladder entry).
 */
export function countZonesReachedTp(zones: Zone[], level: 1 | 2 | 3 | 4): number {
  return zones.filter((z) => zoneReachedTpLevel(z, level)).length;
}

/** @alias countZonesReachedTp */
export const countTpHits = countZonesReachedTp;

export function countManualCloses(zones: Zone[]): number {
  return zones.filter((z) => Boolean(z.manualClose)).length;
}

export function countSlHits(zones: Zone[]): number {
  return zones.filter((z) => Boolean(z.slHit)).length;
}

/** Enabled TP levels this zone reached (for card pill, e.g. 3/4). */
export function zoneTpLevelsHit(z: Zone): { hit: number; enabled: number } {
  const levels = [1, 2, 3, 4] as const;
  const enabled = levels.filter((n) =>
    n === 4 ? isAutomatedTp4Level(z) : z[`tp${n}Enabled` as keyof Zone] !== false,
  ).length;
  const hit = levels.filter((n) => zoneReachedTpLevel(z, n)).length;
  return {
    hit: z.hitEnabledTpCount ?? hit,
    enabled: z.enabledTpCount ?? enabled,
  };
}

export function primaryOutcomeLabel(outcome: ZonePrimaryOutcome): string {
  if (outcome === "NONE") return "—";
  return outcome;
}

export function primaryOutcomePillStyle(
  outcome: ZonePrimaryOutcome,
): "green" | "gold" | "grey" | "red" {
  if (outcome === "SL") return "red";
  if (outcome === "MANUAL") return "gold";
  if (outcome === "TP4" || outcome === "TP3") return "green";
  if (outcome === "TP2") return "gold";
  if (outcome === "TP1") return "grey";
  return "grey";
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
