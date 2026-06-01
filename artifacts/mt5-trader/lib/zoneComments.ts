/** Client-side zone ID + MT5 order comment helpers (mirrors api-server). */

export function newCascadeZoneId(): string {
  return `z_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildCascadeComment(zoneId: string, leg: number, total: number): string {
  return `Cascade|${zoneId}|${leg}/${total}`;
}

export type TpDisplayState = "pending" | "hit" | "disabled";

export function tpDisplayState(enabled: boolean, hit: boolean): TpDisplayState {
  if (!enabled) return "disabled";
  if (hit) return "hit";
  return "pending";
}
