import type { PendingOrder, Position, Price } from "@/context/TradingContext";
import type { CascadeSettings } from "@/hooks/useCascadeSettings";
import type { Zone } from "@/hooks/useZones";
import { parseZoneIdFromComment } from "@/lib/zoneComments";
import { isTp4LevelEnabled, zoneReachedTpLevel } from "@/lib/zoneStats";

const PIP = 0.1;

function positionDirection(p: Position): "buy" | "sell" {
  return p.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
}

function volumeWeightedEntry(positions: Position[]): number {
  const vol = positions.reduce((s, p) => s + p.volume, 0);
  if (vol <= 0) return positions[0]?.openPrice ?? 0;
  return positions.reduce((s, p) => s + p.openPrice * p.volume, 0) / vol;
}

function buildTpPricesFromSettings(
  anchor: number,
  direction: "buy" | "sell",
  cs: CascadeSettings,
): Pick<Zone, "tp1Price" | "tp2Price" | "tp3Price" | "tp4Price" | "tp1Enabled" | "tp2Enabled" | "tp3Enabled" | "tp4Enabled"> {
  const sign = direction === "buy" ? 1 : -1;
  const r = (v: number) => parseFloat(v.toFixed(2));
  return {
    tp1Price: cs.tp1Enabled ? r(anchor + sign * cs.tp1Pips * PIP) : null,
    tp2Price: cs.tp2Enabled ? r(anchor + sign * cs.tp2Pips * PIP) : null,
    tp3Price: cs.tp3Enabled ? r(anchor + sign * cs.tp3Pips * PIP) : null,
    tp4Price: cs.tp4Enabled && cs.tp4Pips > 0 ? r(anchor + sign * cs.tp4Pips * PIP) : null,
    tp1Enabled: cs.tp1Enabled,
    tp2Enabled: cs.tp2Enabled,
    tp3Enabled: cs.tp3Enabled,
    tp4Enabled: cs.tp4Enabled,
  };
}

/** Recompute TP tally from per-level hit flags (SSE payloads may omit counts). */
export function enrichZoneDisplayFields(zone: Zone): Zone {
  const tp1Enabled = zone.tp1Enabled !== false;
  const tp2Enabled = zone.tp2Enabled !== false;
  const tp3Enabled = zone.tp3Enabled !== false;
  const tp4On = isTp4LevelEnabled(zone);
  const enabledTpCount = [tp1Enabled, tp2Enabled, tp3Enabled, tp4On].filter(Boolean).length;
  const hit = ([1, 2, 3, 4] as const).filter((n) => zoneReachedTpLevel(zone, n)).length;
  return {
    ...zone,
    enabledTpCount: zone.enabledTpCount ?? enabledTpCount,
    hitEnabledTpCount: zone.hitEnabledTpCount ?? hit,
  };
}

/** Client-side progress when the zones API omits live fields. */
export function enrichZoneLiveFields(zone: Zone, price: Price | null): Zone {
  if (zone.status === "CLOSED" || zone.status === "ARMED" || !price || zone.anchorPrice <= 0) return zone;
  if (zone.nextTp && zone.nextTp > 0 && zone.pipsToNextTp != null) return zone;

  const dir = zone.direction;
  const cmp = dir === "buy" ? price.bid : price.ask;
  const tps: (number | null)[] = [zone.tp1Price, zone.tp2Price, zone.tp3Price, zone.tp4Price];
  const enabled = [zone.tp1Enabled !== false, zone.tp2Enabled !== false, zone.tp3Enabled !== false, zone.tp4Enabled !== false];
  const hit = [zone.tp1Hit, zone.tp2Hit, zone.tp3Hit, zone.tp4Hit];

  let nextTp: 0 | 1 | 2 | 3 | 4 = 0;
  if (enabled[0] && !hit[0]) nextTp = 1;
  else if (enabled[1] && !hit[1]) nextTp = 2;
  else if (enabled[2] && !hit[2]) nextTp = 3;
  else if (enabled[3] && !hit[3] && tps[3] != null) nextTp = 4;
  if (nextTp === 0) return { ...zone, currentPrice: cmp };

  const nextPx = tps[nextTp - 1];
  const prevPx = nextTp === 1 ? zone.anchorPrice : (tps[nextTp - 2] ?? zone.anchorPrice);
  if (nextPx == null) return { ...zone, currentPrice: cmp, nextTp };

  const sign = dir === "buy" ? 1 : -1;
  const remaining = (nextPx - cmp) / PIP * sign;
  const pipsToNextTp = Math.round(remaining * 10) / 10;
  let progressPct: number | null = null;
  const span = (nextPx - prevPx) * sign;
  if (span > 0) {
    const travelled = (cmp - prevPx) * sign;
    progressPct = Math.max(0, Math.min(100, (travelled / span) * 100));
  }

  return {
    ...zone,
    currentPrice: cmp,
    nextTp,
    nextTpPrice: parseFloat(nextPx.toFixed(2)),
    pipsToNextTp,
    progressPct,
  };
}

function syntheticZoneFromPositions(
  zoneId: string,
  positions: Position[],
  cs: CascadeSettings,
): Zone | null {
  if (positions.length === 0) return null;
  const direction = positionDirection(positions[0]!);
  const anchorPrice = volumeWeightedEntry(positions);
  const tps = buildTpPricesFromSettings(anchorPrice, direction, cs);
  const enabledTpCount = [tps.tp1Enabled, tps.tp2Enabled, tps.tp3Enabled, tps.tp4Enabled].filter(Boolean).length;
  return {
    zoneId,
    direction,
    anchorPrice,
    ...tps,
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    tp4Hit: false,
    enabledTpCount,
    hitEnabledTpCount: 0,
    cashoutDone: false,
    status: "OPEN",
    createdAt: Date.now(),
    positionCount: positions.length,
    originalVolume: positions.reduce((s, p) => s + p.volume, 0),
  };
}

export function groupPositionsByZoneId(positions: Position[]): Map<string, Position[]> {
  const map = new Map<string, Position[]>();
  for (const p of positions) {
    const zid = parseZoneIdFromComment(p.comment);
    if (!zid) continue;
    const arr = map.get(zid) ?? [];
    arr.push(p);
    map.set(zid, arr);
  }
  return map;
}

function groupPendingByZoneId(orders: PendingOrder[]): Map<string, PendingOrder[]> {
  const map = new Map<string, PendingOrder[]>();
  for (const o of orders) {
    const zid = parseZoneIdFromComment(o.comment);
    if (!zid) continue;
    const arr = map.get(zid) ?? [];
    arr.push(o);
    map.set(zid, arr);
  }
  return map;
}

/** Active zones for Positions/Dashboard: API rows + MT5 comments (positions + pending). */
export function buildDisplayActiveZones(
  apiZones: Zone[],
  positions: Position[],
  cs: CascadeSettings,
  price: Price | null,
  pendingOrders: PendingOrder[] = [],
): Zone[] {
  const apiById = new Map(apiZones.map((z) => [z.zoneId, z]));
  const closedIds = new Set(
    apiZones.filter((z) => z.status === "CLOSED").map((z) => z.zoneId),
  );
  const active = apiZones.filter((z) => z.status === "OPEN" || z.status === "RISK_FREE" || z.status === "ARMED");
  const byComment = groupPositionsByZoneId(positions);
  const byPending = groupPendingByZoneId(pendingOrders);
  const seen = new Set<string>();
  const out: Zone[] = [];

  for (const z of active) {
    seen.add(z.zoneId);
    const linked = byComment.get(z.zoneId) ?? [];
    const merged: Zone = enrichZoneDisplayFields({
      ...z,
      positionCount: linked.length > 0 ? linked.length : z.positionCount,
    });
    out.push(enrichZoneLiveFields(merged, price));
  }

  const discoverFromMt5 = (zoneId: string, linked: Position[]) => {
    if (seen.has(zoneId)) return;
    const apiRow = apiById.get(zoneId);
    if (apiRow && (apiRow.status === "OPEN" || apiRow.status === "RISK_FREE" || apiRow.status === "ARMED")) {
      return;
    }
    if (closedIds.has(zoneId) && linked.length === 0) return;
    const syn = syntheticZoneFromPositions(zoneId, linked, cs);
    if (!syn) return;
    const status = apiRow?.status === "RISK_FREE"
      ? "RISK_FREE"
      : apiRow?.status === "ARMED"
        ? "ARMED"
        : "OPEN";
    out.push(enrichZoneLiveFields(enrichZoneDisplayFields({ ...syn, status }), price));
    seen.add(zoneId);
  };

  for (const [zoneId, linked] of byComment) {
    discoverFromMt5(zoneId, linked);
  }

  for (const zoneId of byPending.keys()) {
    if (seen.has(zoneId) || closedIds.has(zoneId)) continue;
    const apiRow = apiById.get(zoneId);
    if (apiRow?.status === "OPEN" || apiRow?.status === "RISK_FREE" || apiRow?.status === "ARMED") continue;
    const syn = syntheticZoneFromPositions(zoneId, [], cs);
    if (!syn) continue;
    out.push(enrichZoneLiveFields(enrichZoneDisplayFields({
      ...syn,
      status: apiRow?.status === "ARMED" ? "ARMED" : "ARMED",
      positionCount: 0,
    }), price));
    seen.add(zoneId);
  }

  return out.sort((a, b) => {
    if (a.runnerActive && !b.runnerActive) return 1;
    if (!a.runnerActive && b.runnerActive) return -1;
    return 0;
  });
}

export function positionsWithoutZone(positions: Position[], zoneIds: Set<string>): Position[] {
  return positions.filter((p) => {
    const zid = parseZoneIdFromComment(p.comment);
    return !zid || !zoneIds.has(zid);
  });
}

export function pendingWithoutZone(orders: PendingOrder[], zoneIds: Set<string>): PendingOrder[] {
  return orders.filter((o) => {
    const zid = parseZoneIdFromComment(o.comment);
    return !zid || !zoneIds.has(zid);
  });
}
