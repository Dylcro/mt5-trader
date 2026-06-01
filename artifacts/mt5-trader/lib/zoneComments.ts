/** Client-side zone ID + MT5 order comment helpers (mirrors api-server). */

export function newCascadeZoneId(): string {
  return `z_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildCascadeComment(zoneId: string, leg: number, total: number): string {
  return `Cascade|${zoneId}|${leg}/${total}`;
}

export function parseZoneIdFromComment(comment: string | undefined | null): string | null {
  if (!comment) return null;
  const pipeMatch = comment.match(/^Cascade\|([^|]+)\|\d+\/\d+$/);
  if (pipeMatch?.[1]) return pipeMatch[1];
  return null;
}

export function parseCascadeLeg(comment: string | undefined | null): {
  zoneId: string;
  leg: number;
  total: number;
} | null {
  if (!comment) return null;
  const m = comment.match(/^Cascade\|([^|]+)\|(\d+)\/(\d+)$/);
  if (!m?.[1]) return null;
  return { zoneId: m[1], leg: Number(m[2]), total: Number(m[3]) };
}

export type TpDisplayState = "pending" | "hit" | "disabled";

export function tpDisplayState(enabled: boolean, hit: boolean): TpDisplayState {
  if (!enabled) return "disabled";
  if (hit) return "hit";
  return "pending";
}
