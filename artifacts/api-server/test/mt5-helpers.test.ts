import { describe, it, expect } from "vitest";
import {
  computeRiskFreeSl,
  buildCascadeConfigUpdate,
  ZONE_RISK_FREE_PIPS,
} from "../src/routes/mt5";

const PIP = 0.10;
// `pips` is SIGNED: negative = drawdown side (protective), positive = profit side.
// Default ZONE_RISK_FREE_PIPS is negative — protective is the conventional behaviour.
const DEFAULT_ABS_OFFSET = Math.abs(ZONE_RISK_FREE_PIPS) * PIP;
const DEFAULT_IS_PROTECTIVE = ZONE_RISK_FREE_PIPS < 0;

describe("computeRiskFreeSl (POST /risk-free SL placement)", () => {
  it("BUY default (negative pips → protective): SL sits BELOW entry", () => {
    const entry = 3120.55;
    const sl = computeRiskFreeSl("buy", entry);
    expect(DEFAULT_IS_PROTECTIVE).toBe(true);
    expect(sl).toBeLessThan(entry);
    expect(entry - sl).toBeCloseTo(DEFAULT_ABS_OFFSET, 6);
  });

  it("SELL default (negative pips → protective): SL sits ABOVE entry", () => {
    const entry = 3120.55;
    const sl = computeRiskFreeSl("sell", entry);
    expect(sl).toBeGreaterThan(entry);
    expect(sl - entry).toBeCloseTo(DEFAULT_ABS_OFFSET, 6);
  });

  it("BUY with POSITIVE pips: SL sits ABOVE entry (profit lock)", () => {
    const entry = 3000.00;
    const sl = computeRiskFreeSl("buy", entry, 15);
    expect(sl).toBeGreaterThan(entry);
    expect(sl - entry).toBeCloseTo(15 * PIP, 6);
  });

  it("SELL with POSITIVE pips: SL sits BELOW entry (profit lock)", () => {
    const entry = 3000.00;
    const sl = computeRiskFreeSl("sell", entry, 15);
    expect(sl).toBeLessThan(entry);
    expect(entry - sl).toBeCloseTo(15 * PIP, 6);
  });

  it("zero pips: SL placed exactly at entry (true break-even)", () => {
    const entry = 2987.42;
    expect(computeRiskFreeSl("buy", entry, 0)).toBeCloseTo(entry, 2);
    expect(computeRiskFreeSl("sell", entry, 0)).toBeCloseTo(entry, 2);
  });

  it("rounds to 2 decimal places (XAUUSD price precision)", () => {
    const sl = computeRiskFreeSl("buy", 3120.5555, -10);
    expect(sl).toBe(parseFloat(sl.toFixed(2)));
  });

  it("BUY and SELL with the same signed pips mirror around the entry price", () => {
    const entry = 2987.42;
    const buySl = computeRiskFreeSl("buy", entry, -10);
    const sellSl = computeRiskFreeSl("sell", entry, -10);
    expect(entry - buySl).toBeCloseTo(sellSl - entry, 6);
  });

  it("honours a custom pip count when provided", () => {
    const entry = 3000.00;
    const sl = computeRiskFreeSl("buy", entry, -25);
    expect(sl).toBeCloseTo(entry - 25 * PIP, 2);
  });
});

describe("sanitizeRiskFreePips", () => {
  it("snaps to nearest 5-pip step inside -30..+30 range", async () => {
    const { sanitizeRiskFreePips } = await import("../src/routes/mt5");
    expect(sanitizeRiskFreePips(7)).toBe(5);
    expect(sanitizeRiskFreePips(8)).toBe(10);
    expect(sanitizeRiskFreePips(-12)).toBe(-10);
    expect(sanitizeRiskFreePips(-13)).toBe(-15);
  });

  it("clamps to -30..+30 bounds", async () => {
    const { sanitizeRiskFreePips } = await import("../src/routes/mt5");
    expect(sanitizeRiskFreePips(99)).toBe(30);
    expect(sanitizeRiskFreePips(-99)).toBe(-30);
  });

  it("falls back to default for non-numeric input", async () => {
    const { sanitizeRiskFreePips } = await import("../src/routes/mt5");
    expect(sanitizeRiskFreePips("bad")).toBe(ZONE_RISK_FREE_PIPS);
    expect(sanitizeRiskFreePips(null)).toBe(ZONE_RISK_FREE_PIPS);
    expect(sanitizeRiskFreePips(undefined)).toBe(ZONE_RISK_FREE_PIPS);
    expect(sanitizeRiskFreePips(NaN)).toBe(ZONE_RISK_FREE_PIPS);
  });
});

const BASE_CONFIG = {
  enabled: false,
  numPositions: 3,
  pipsBetween: 10,
  slPips: 100,
  tp1Pips: 20,
  tp2Pips: 50,
  tp3Pips: 90,
};

describe("buildCascadeConfigUpdate (PUT /cascade-config TP ordering)", () => {
  it("accepts strictly increasing TP1 < TP2 < TP3", () => {
    const result = buildCascadeConfigUpdate(
      { tp1Pips: 15, tp2Pips: 40, tp3Pips: 80 },
      BASE_CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tp1Pips).toBe(15);
      expect(result.config.tp2Pips).toBe(40);
      expect(result.config.tp3Pips).toBe(80);
    }
  });

  it("rejects TP2 <= TP1 with 400", () => {
    const result = buildCascadeConfigUpdate(
      { tp1Pips: 50, tp2Pips: 50, tp3Pips: 90 },
      BASE_CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/strictly increasing/i);
    }
  });

  it("rejects TP3 <= TP2 with 400", () => {
    const result = buildCascadeConfigUpdate(
      { tp1Pips: 20, tp2Pips: 90, tp3Pips: 50 },
      BASE_CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("rejects fully out-of-order TP3 < TP2 < TP1 with 400", () => {
    const result = buildCascadeConfigUpdate(
      { tp1Pips: 90, tp2Pips: 50, tp3Pips: 20 },
      BASE_CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("rejects equal TPs (TP1 == TP2 == TP3) with 400", () => {
    const result = buildCascadeConfigUpdate(
      { tp1Pips: 50, tp2Pips: 50, tp3Pips: 50 },
      BASE_CONFIG,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects when only one TP changes and breaks ordering against current config", () => {
    // current tp2=50; new tp1=60 would make tp1 > tp2 → must reject
    const result = buildCascadeConfigUpdate(
      { tp1Pips: 60 },
      BASE_CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body.tp1Pips).toBe(60);
      expect(result.body.tp2Pips).toBe(50);
    }
  });

  it("ignores non-positive TP values (treated as 'not provided')", () => {
    const result = buildCascadeConfigUpdate(
      { tp1Pips: -5, tp2Pips: 0 },
      BASE_CONFIG,
    );
    // Falls back to current values → still strictly increasing
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tp1Pips).toBe(BASE_CONFIG.tp1Pips);
      expect(result.config.tp2Pips).toBe(BASE_CONFIG.tp2Pips);
    }
  });

  it("merges non-TP fields without affecting TP validation", () => {
    const result = buildCascadeConfigUpdate(
      { enabled: true, slPips: 200 },
      BASE_CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.enabled).toBe(true);
      expect(result.config.slPips).toBe(200);
      expect(result.config.tp1Pips).toBe(BASE_CONFIG.tp1Pips);
    }
  });

  it("rounds fractional TP inputs before validating", () => {
    const result = buildCascadeConfigUpdate(
      { tp1Pips: 19.7, tp2Pips: 49.4, tp3Pips: 89.1 },
      BASE_CONFIG,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tp1Pips).toBe(20);
      expect(result.config.tp2Pips).toBe(49);
      expect(result.config.tp3Pips).toBe(89);
    }
  });

  it("handles null/undefined body without crashing", () => {
    const r1 = buildCascadeConfigUpdate(null, BASE_CONFIG);
    const r2 = buildCascadeConfigUpdate(undefined, BASE_CONFIG);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});
