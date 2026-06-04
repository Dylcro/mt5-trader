/** Per-leg lot split for native broker TP sub-positions (0.01 lot step, carry remainder). */

export type TpSliceConfig = {
  tp1Pct: number;
  tp2Pct: number;
  tp3Pct: number;
  tp4Pct: number;
  tp1Enabled?: boolean;
  tp2Enabled?: boolean;
  tp3Enabled?: boolean;
  tp4Enabled?: boolean;
};

export type TpPriceConfig = {
  tp1Price: number;
  tp2Price: number;
  tp3Price: number;
  tp4Price?: number;
};

export type NativeTpSlice = {
  level: 1 | 2 | 3 | 4;
  lot: number;
  tpPrice?: number;
};

const LOT_STEP = 0.01;

function roundLot(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Split one cascade leg's lot into broker sub-positions (one per enabled TP level).
 * Disabled levels (pct 0) are omitted. Manual TP4 omits tpPrice when tp4Price is absent.
 */
export function validateCascadeLots(
  legLot: number,
  pcts: TpSliceConfig,
  prices: TpPriceConfig,
): NativeTpSlice[] {
  if (!(legLot >= LOT_STEP)) return [];

  const levels: { level: 1 | 2 | 3 | 4; pct: number; price?: number }[] = [
    { level: 1, pct: pcts.tp1Pct, price: prices.tp1Price },
    { level: 2, pct: pcts.tp2Pct, price: prices.tp2Price },
    { level: 3, pct: pcts.tp3Pct, price: prices.tp3Price },
    { level: 4, pct: pcts.tp4Pct, price: prices.tp4Price },
  ];

  const enabled = levels.filter((l) => {
    const on =
      l.level === 1 ? pcts.tp1Enabled !== false
        : l.level === 2 ? pcts.tp2Enabled !== false
          : l.level === 3 ? pcts.tp3Enabled !== false
            : pcts.tp4Enabled !== false;
    return on && l.pct > 0;
  });

  if (enabled.length === 0) return [];

  const slices: NativeTpSlice[] = [];
  let carry = 0;
  let placedSum = 0;

  for (let i = 0; i < enabled.length; i++) {
    const { level, pct, price } = enabled[i]!;
    const isLast = i === enabled.length - 1;
    const rawUnrounded = legLot * (pct / 100) + carry;

    if (rawUnrounded < LOT_STEP) {
      if (isLast) {
        const remainder = roundLot(legLot - placedSum);
        if (remainder >= LOT_STEP) {
          slices.push({
            level,
            lot: remainder,
            tpPrice: level === 4 && price == null ? undefined : price,
          });
        }
      } else {
        carry = rawUnrounded;
      }
      continue;
    }

    let lot = roundLot(rawUnrounded);
    if (isLast) {
      const remainder = roundLot(legLot - placedSum);
      if (remainder >= LOT_STEP) lot = remainder;
    }
    if (lot < LOT_STEP) continue;

    placedSum = roundLot(placedSum + lot);
    slices.push({
      level,
      lot,
      tpPrice: level === 4 && price == null ? undefined : price,
    });
  }

  return slices;
}
