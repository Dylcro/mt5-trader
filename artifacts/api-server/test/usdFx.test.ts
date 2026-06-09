import { describe, it, expect, vi, beforeEach } from "vitest";
import { convertUsdAmount, isPlausibleUsdFxRate, usdToTargetRate } from "../src/lib/usdFx.js";

describe("usdFx", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("convertUsdAmount multiplies by rate", () => {
    expect(convertUsdAmount(264, 0.74)).toBeCloseTo(195.36, 2);
    expect(convertUsdAmount(100, 1)).toBe(100);
  });

  it("usdToTargetRate returns 1 for USD", async () => {
    const fetchPrice = vi.fn();
    const r = await usdToTargetRate("t", "london", "acc", "USD", fetchPrice);
    expect(r).toEqual({ rate: 1, currency: "USD" });
    expect(fetchPrice).not.toHaveBeenCalled();
  });

  it("usdToTargetRate uses USD{TARGET} mid when available", async () => {
    const fetchPrice = vi.fn(async (_t, _r, _a, sym: string) => {
      if (sym === "USDJPY") return { bid: 149, ask: 151 };
      return null;
    });
    const r = await usdToTargetRate("t", "london", "acc", "JPY", fetchPrice);
    expect(r.currency).toBe("JPY");
    expect(r.rate).toBeCloseTo(150, 5);
  });

  it("usdToTargetRate inverts {TARGET}USD when direct pair missing", async () => {
    const fetchPrice = vi.fn(async (_t, _r, _a, sym: string) => {
      if (sym === "GBPUSD") return { bid: 1.24, ask: 1.26 };
      return null;
    });
    const r = await usdToTargetRate("t", "london", "acc2", "GBP", fetchPrice);
    expect(r.currency).toBe("GBP");
    expect(r.rate).toBeCloseTo(1 / 1.25, 5);
  });

  it("rejects gold-scale tick mistaken for USDGBP", async () => {
    expect(isPlausibleUsdFxRate("GBP", 2650)).toBe(false);
    const fetchPrice = vi.fn(async (_t, _r, _a, sym: string) => {
      if (sym === "USDGBP") return { bid: 2650, ask: 2651 };
      if (sym === "GBPUSD") return { bid: 1.24, ask: 1.26 };
      return null;
    });
    const r = await usdToTargetRate("t", "london", "acc3", "GBP", fetchPrice);
    expect(r.rate).toBeCloseTo(0.8, 2);
  });
});
