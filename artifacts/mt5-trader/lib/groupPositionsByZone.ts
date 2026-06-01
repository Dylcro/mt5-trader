import type { PendingOrder, Position } from "@/context/TradingContext";
import type { Zone } from "@/hooks/useZones";
import { parseZoneIdFromComment } from "@/lib/zoneComments";

export type ZoneBucket = {
  zoneId: string;
  zone?: Zone;
  positions: Position[];
  pending: PendingOrder[];
};

export function groupPositionsByZone(
  activeZones: Zone[],
  positions: Position[],
  pendingOrders: PendingOrder[],
): { buckets: ZoneBucket[]; orphanPositions: Position[]; orphanPending: PendingOrder[] } {
  const zoneById = new Map<string, Zone>();
  for (const z of activeZones) zoneById.set(z.zoneId, z);

  const buckets = new Map<string, ZoneBucket>();

  const ensure = (zoneId: string): ZoneBucket => {
    let b = buckets.get(zoneId);
    if (!b) {
      b = { zoneId, zone: zoneById.get(zoneId), positions: [], pending: [] };
      buckets.set(zoneId, b);
    }
    return b;
  };

  for (const z of activeZones) {
    ensure(z.zoneId).zone = z;
  }

  const orphanPositions: Position[] = [];
  const orphanPending: PendingOrder[] = [];

  for (const p of positions) {
    const zid = parseZoneIdFromComment(p.comment);
    if (zid) ensure(zid).positions.push(p);
    else orphanPositions.push(p);
  }

  for (const o of pendingOrders) {
    const zid = parseZoneIdFromComment(o.comment);
    if (zid) ensure(zid).pending.push(o);
    else orphanPending.push(o);
  }

  const list = Array.from(buckets.values()).filter(
    (b) => b.positions.length > 0 || b.pending.length > 0,
  );

  list.sort((a, b) => {
    const ta = a.zone?.createdAt ?? 0;
    const tb = b.zone?.createdAt ?? 0;
    return tb - ta;
  });

  return { buckets: list, orphanPositions, orphanPending };
}
