import { describe, expect, it } from "vitest";

import { validateCascadeLots } from "./cascadeLots";

describe("validateCascadeLots", () => {
  it("splits 0.04 into four 0.01 slices at 25% each", () => {
    const slices = validateCascadeLots(
      0.04,
      { tp1Pct: 25, tp2Pct: 25, tp3Pct: 25, tp4Pct: 25 },
      { tp1Price: 2610, tp2Price: 2620, tp3Price: 2630, tp4Price: 2640 },
    );
    expect(slices).toHaveLength(4);
    expect(slices.map((s) => s.lot)).toEqual([0.01, 0.01, 0.01, 0.01]);
  });

  it("omits disabled levels and manual TP4 without price", () => {
    const slices = validateCascadeLots(
      0.04,
      { tp1Pct: 25, tp2Pct: 25, tp3Pct: 25, tp4Pct: 0, tp4Enabled: false },
      { tp1Price: 2610, tp2Price: 2620, tp3Price: 2630 },
    );
    expect(slices).toHaveLength(3);
    expect(slices.find((s) => s.level === 4)).toBeUndefined();
  });
});
