import type { PendingOrder, Position } from "@/context/TradingContext";
import { parseZoneIdFromComment } from "@/lib/zoneComments";

/** Keeps Cascade comments when MetaAPI REST omits them after app resume. */
export class PositionMetaCache {
  private positionComments = new Map<string, string>();
  private orderComments = new Map<string, string>();
  private positionZoneIds = new Map<string, string>();

  clear(): void {
    this.positionComments.clear();
    this.orderComments.clear();
    this.positionZoneIds.clear();
  }

  zoneIdForPosition(positionId: string): string | undefined {
    return this.positionZoneIds.get(positionId);
  }

  getPositionZoneIds(): ReadonlyMap<string, string> {
    return this.positionZoneIds;
  }

  mergePositions(positions: Position[]): Position[] {
    return positions.map((p) => {
      if (p.comment) {
        this.positionComments.set(p.id, p.comment);
        const zid = parseZoneIdFromComment(p.comment);
        if (zid) this.positionZoneIds.set(p.id, zid);
        return p;
      }
      const cached = this.positionComments.get(p.id);
      if (!cached) return p;
      const zid = parseZoneIdFromComment(cached);
      if (zid) this.positionZoneIds.set(p.id, zid);
      return { ...p, comment: cached };
    });
  }

  mergePendingOrders(orders: PendingOrder[]): PendingOrder[] {
    return orders.map((o) => {
      if (o.comment) {
        this.orderComments.set(o.id, o.comment);
        return o;
      }
      const cached = this.orderComments.get(o.id);
      return cached ? { ...o, comment: cached } : o;
    });
  }
}
