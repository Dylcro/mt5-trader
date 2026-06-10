/** Shared lot-step helpers for cascade TP sizing (0.01 broker step). */
export const LOT_STEP = 0.01;

export function roundLot(v: number): number {
  return Math.max(0, Math.round(v / LOT_STEP) * LOT_STEP);
}

export function pctToLots(cascadeLot: number, pct: number): number {
  if (!(cascadeLot > 0) || !(pct > 0)) return 0;
  return roundLot(cascadeLot * pct / 100);
}

export function lotsToPct(lots: number, cascadeLot: number): number {
  if (!(cascadeLot > 0) || !(lots > 0)) return 0;
  return Math.min(100, Math.round((lots / cascadeLot) * 100));
}

export type TpLotsSlice = {
  tp1Enabled: boolean;
  tp2Enabled: boolean;
  tp3Enabled: boolean;
  tp1Lots: number;
  tp2Lots: number;
  tp3Lots: number;
};

export function sumEnabledTpLots(t: TpLotsSlice): number {
  let sum = 0;
  if (t.tp1Enabled) sum += t.tp1Lots;
  if (t.tp2Enabled) sum += t.tp2Lots;
  if (t.tp3Enabled) sum += t.tp3Lots;
  return roundLot(sum);
}

export function runnerRemainderLots(t: TpLotsSlice, cascadeLot: number): number {
  return Math.max(0, roundLot(cascadeLot - sumEnabledTpLots(t)));
}

export function validateTpLots(
  t: TpLotsSlice,
  cascadeLot: number,
): { ok: true } | { ok: false; message: string } {
  if (!(cascadeLot >= LOT_STEP)) {
    return { ok: false, message: "Set cascade lot size to at least 0.01 first." };
  }
  const sum = sumEnabledTpLots(t);
  if (sum > cascadeLot + 1e-9) {
    return {
      ok: false,
      message: `TP lots total ${sum.toFixed(2)} exceeds cascade lot ${cascadeLot.toFixed(2)}. Lower a TP lot or increase cascade size.`,
    };
  }
  if (t.tp1Enabled && t.tp1Lots < LOT_STEP) {
    return { ok: false, message: "TP1 needs at least 0.01 lot when enabled." };
  }
  if (t.tp2Enabled && t.tp2Lots < LOT_STEP) {
    return { ok: false, message: "TP2 needs at least 0.01 lot when enabled." };
  }
  if (t.tp3Enabled && t.tp3Lots < LOT_STEP) {
    return { ok: false, message: "TP3 needs at least 0.01 lot when enabled." };
  }
  return { ok: true };
}

export type TpPipsSlice = {
  tp1Enabled: boolean;
  tp2Enabled: boolean;
  tp3Enabled: boolean;
  tp4Enabled: boolean;
  tp1Pips: number;
  tp2Pips: number;
  tp3Pips: number;
  tp4Pips: number;
};

/** Only enabled TP levels need strictly increasing pip distances. */
export function validateEnabledTpPips(cs: TpPipsSlice): boolean {
  const rows = [
    { en: cs.tp1Enabled !== false, pips: cs.tp1Pips },
    { en: cs.tp2Enabled !== false, pips: cs.tp2Pips },
    { en: cs.tp3Enabled !== false, pips: cs.tp3Pips },
    { en: cs.tp4Enabled !== false && cs.tp4Pips > 0, pips: cs.tp4Pips },
  ];
  const active = rows.filter((r) => r.en).map((r) => r.pips);
  if (active.length === 0) return true;  // all-off is valid; downstream handles no partial closes
  if (active.some((p) => !(p > 0))) return false;
  for (let i = 1; i < active.length; i++) {
    if (active[i] <= active[i - 1]) return false;
  }
  return true;
}
