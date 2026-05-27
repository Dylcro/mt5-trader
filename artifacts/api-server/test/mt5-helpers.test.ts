import { describe, it, expect } from "vitest";
import {
  computeRiskFreeSl,
  buildCascadeConfigUpdate,
  ZONE_RISK_FREE_PIPS,
} from "../src/routes/mt5";

const PIP = 0.10;
const EXPECTED_OFFSET = ZONE_RISK_FREE_PIPS * PIP;

describe("computeRiskFreeSl (POST /risk-free SL placement)", () => {
  it("BUY: moves SL ABOVE entry by exactly ZONE_RISK_FREE_PIPS * PIP", () => {
    const entry = 3120.55;
    const sl = computeRiskFreeSl("buy", entry);
    expect(sl).toBeGreaterThan(entry);
    expect(sl).toBeCloseTo(entry + EXPECTED_OFFSET, 2);
    expect(sl - entry).toBeCloseTo(EXPECTED_OFFSET, 6);
  });

  it("SELL: moves SL BELOW entry by exactly ZONE_RISK_FREE_PIPS * PIP", () => {
    const entry = 3120.55;
    const sl = computeRiskFreeSl("sell", entry);
    expect(sl).toBeLessThan(entry);
    expect(sl).toBeCloseTo(entry - EXPECTED_OFFSET, 2);
    expect(entry - sl).toBeCloseTo(EXPECTED_OFFSET, 6);
  });

  it("rounds to 2 decimal places (XAUUSD price precision)", () => {
    const sl = computeRiskFreeSl("buy", 3120.5555);
    expect(sl).toBe(parseFloat(sl.toFixed(2)));
  });

  it("BUY and SELL are exact mirror images around the entry price", () => {
    const entry = 2987.42;
    const buySl = computeRiskFreeSl("buy", entry);
    const sellSl = computeRiskFreeSl("sell", entry);
    expect(buySl - entry).toBeCloseTo(entry - sellSl, 6);
  });

  it("honours a custom pip count when provided", () => {
    const entry = 3000.00;
    const sl = computeRiskFreeSl("buy", entry, 25);
    expect(sl).toBeCloseTo(entry + 25 * PIP, 2);
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
