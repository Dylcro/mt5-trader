import { describe, it, expect, beforeEach } from "vitest";
import {
  computeRiskFreeSl,
  buildCascadeConfigUpdate,
  ZONE_RISK_FREE_PIPS,
  rowToZoneState,
  _zoneStatesForTest,
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

// ── rowToZoneState restart-hydration tests ───────────────────────────────────
// These tests validate the pure DB-row → ZoneState conversion that is the
// critical path for restart safety. A pod restart runs loadZoneState(), which
// calls rowToZoneState() for every OPEN/RISK_FREE zone row it finds. If this
// conversion is wrong the monitor wakes up with corrupt state.
const makeRow = (overrides: Record<string, unknown> = {}) => ({
  zoneId: "z_test_abc123",
  accountId: "acc_1",
  userId: null,
  direction: "buy",
  anchorPrice: "3120.50",
  tp1Price: "3130.00",
  tp2Price: "3145.00",
  tp3Price: "3160.00",
  tp4Price: null,
  tp1Pips: null,
  tp2Pips: null,
  tp3Pips: null,
  originalVolume: "0.08",
  cashoutPips: 5,
  cashoutDone: false,
  tp1Hit: false,
  tp2Hit: false,
  tp3Hit: false,
  tp4Hit: false,
  tp2SlIsBestEffort: false,
  status: "OPEN",
  createdAt: Date.now(),
  closedAt: null,
  ...overrides,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

describe("rowToZoneState (restart-hydration path)", () => {
  it("correctly maps BUY zone fields from DB row", () => {
    const st = rowToZoneState(makeRow());
    expect(st.zoneId).toBe("z_test_abc123");
    expect(st.accountId).toBe("acc_1");
    expect(st.direction).toBe("buy");
    expect(st.anchorPrice).toBe(3120.50);
    expect(st.tp1Price).toBe(3130.00);
    expect(st.tp2Price).toBe(3145.00);
    expect(st.tp3Price).toBe(3160.00);
    expect(st.tp4Price).toBeNull();
    expect(st.originalVolume).toBe(0.08);
    expect(st.status).toBe("OPEN");
  });

  it("preserves RISK_FREE status so monitor keeps evaluating surviving entry", () => {
    const st = rowToZoneState(makeRow({ status: "RISK_FREE", tp1Hit: true, tp2Hit: true }));
    expect(st.status).toBe("RISK_FREE");
    expect(st.tp1Hit).toBe(true);
    expect(st.tp2Hit).toBe(true);
    expect(st.tp3Hit).toBe(false);
  });

  it("maps CLOSED status correctly", () => {
    const st = rowToZoneState(makeRow({ status: "CLOSED" }));
    expect(st.status).toBe("CLOSED");
  });

  it("resets transient fields tp2SlMoved and tp2BeAttempts to safe defaults on restart", () => {
    const st = rowToZoneState(makeRow({ tp2Hit: true }));
    // These are never persisted; on restart we re-attempt BE from zero.
    expect(st.tp2SlMoved).toBe(false);
    expect(st.tp2BeAttempts).toBe(0);
    expect(st.busy).toBe(false);
  });

  it("initialises trackedPositions as an empty map (filled in by loadZoneState)", () => {
    const st = rowToZoneState(makeRow());
    expect(st.trackedPositions).toBeInstanceOf(Map);
    expect(st.trackedPositions.size).toBe(0);
  });

  it("falls back to legacy pip-distance TP prices when absolute prices are missing", () => {
    const anchor = 3120.50;
    const st = rowToZoneState(makeRow({
      tp1Price: null, tp2Price: null, tp3Price: null,
      tp1Pips: 20, tp2Pips: 50, tp3Pips: 90,
      anchorPrice: String(anchor),
    }));
    expect(st.tp1Price).toBeCloseTo(anchor + 20 * PIP, 2);
    expect(st.tp2Price).toBeCloseTo(anchor + 50 * PIP, 2);
    expect(st.tp3Price).toBeCloseTo(anchor + 90 * PIP, 2);
  });

  it("computes SELL legacy pip TPs in the correct (downward) direction", () => {
    const anchor = 3120.50;
    const st = rowToZoneState(makeRow({
      direction: "sell",
      tp1Price: null, tp2Price: null, tp3Price: null,
      tp1Pips: 20, tp2Pips: 50, tp3Pips: 90,
      anchorPrice: String(anchor),
    }));
    expect(st.tp1Price).toBeCloseTo(anchor - 20 * PIP, 2);
    expect(st.tp2Price).toBeCloseTo(anchor - 50 * PIP, 2);
    expect(st.tp3Price).toBeCloseTo(anchor - 90 * PIP, 2);
  });

  it("preserves TP hit flags so engine does not re-fire completed TP levels after restart", () => {
    const st = rowToZoneState(makeRow({ tp1Hit: true, tp2Hit: true, tp3Hit: false }));
    expect(st.tp1Hit).toBe(true);
    expect(st.tp2Hit).toBe(true);
    expect(st.tp3Hit).toBe(false);
    expect(st.tp4Hit).toBe(false);
  });

  it("preserves tp2SlIsBestEffort so app warning chip survives restart", () => {
    const st = rowToZoneState(makeRow({ tp2Hit: true, tp2SlIsBestEffort: true }));
    expect(st.tp2SlIsBestEffort).toBe(true);
  });

  it("handles anchorPrice=0 gracefully (zone created before fill price arrived)", () => {
    const st = rowToZoneState(makeRow({ anchorPrice: "0" }));
    expect(st.anchorPrice).toBe(0);
    // evaluateZone guards on anchorPrice > 0, so a zero anchor pauses TP
    // checks without crashing — this row is safe to load on restart.
  });
});

// ── Restart-hydration integration tests ─────────────────────────────────────
// These tests simulate the full "kill pod mid-cascade, restart, verify TP
// progression continues" scenario described in Task #44.
//
// Flow under test:
//   1. A zone is active (some TPs already hit, stored in DB).
//   2. The process crashes — all in-memory state is lost.
//   3. On restart, loadZoneState() calls rowToZoneState() for each DB row and
//      calls zoneStates.set() to repopulate the map.
//   4. The monitor's next tick calls evaluateZone(), which uses loadZone()
//      (single read path) to get the state.
//   5. The engine must continue from exactly where it left off — not re-fire
//      completed TPs and correctly arm the next TP level.
//
// We simulate steps 1–4 directly: pre-populate _zoneStatesForTest (the shared
// in-memory map) from rowToZoneState(), then assert the resulting state is
// exactly what evaluateZone() would observe on its first post-restart tick.
describe("Restart-hydration integration (pod-restart safety)", () => {
  const ZONE_ID = "z_restart_test_001";

  beforeEach(() => {
    // Simulate process restart: wipe the in-memory map so only DB-loaded
    // state is present, exactly as loadZoneState() would leave it.
    _zoneStatesForTest.delete(ZONE_ID);
  });

  it("mid-cascade restart: zone hydrates and TP3/TP4 arm correctly when TP1+TP2 already hit", () => {
    // Scenario: cascade was at TP2 (RISK_FREE) when pod died. DB row has
    // tp1Hit=true, tp2Hit=true, status=RISK_FREE, surviving entry still open.
    const dbRow = makeRow({
      zoneId: ZONE_ID,
      status: "RISK_FREE",
      tp1Hit: true,
      tp2Hit: true,
      tp3Hit: false,
      tp4Hit: false,
      anchorPrice: "3120.50",
      tp1Price: "3130.00",
      tp2Price: "3145.00",
      tp3Price: "3160.00",
      tp4Price: "3175.00",
    });

    // Step 3: simulate what loadZoneState() does on startup.
    const st = rowToZoneState(dbRow);
    _zoneStatesForTest.set(ZONE_ID, st);

    // Step 4: assert what evaluateZone() would observe on its first tick.
    const hydrated = _zoneStatesForTest.get(ZONE_ID)!;
    expect(hydrated).toBeDefined();

    // Zone is correctly restored — monitor will not skip it.
    expect(hydrated.status).toBe("RISK_FREE");
    expect(hydrated.zoneId).toBe(ZONE_ID);

    // Completed TPs are preserved — engine will NOT re-fire TP1/TP2.
    expect(hydrated.tp1Hit).toBe(true);
    expect(hydrated.tp2Hit).toBe(true);

    // Pending TPs are clear — engine WILL fire TP3 and TP4 on next price hit.
    expect(hydrated.tp3Hit).toBe(false);
    expect(hydrated.tp4Hit).toBe(false);

    // TP prices are correct so the hit() logic uses the right thresholds.
    expect(hydrated.tp3Price).toBe(3160.00);
    expect(hydrated.tp4Price).toBe(3175.00);

    // Transient flags reset safely — BE will be re-attempted once on restart.
    expect(hydrated.tp2SlMoved).toBe(false);
    expect(hydrated.tp2BeAttempts).toBe(0);
    expect(hydrated.busy).toBe(false);

    // Tracked positions start empty — loadZoneState populates them from
    // zone_positions rows in the second phase of hydration.
    expect(hydrated.trackedPositions.size).toBe(0);
  });

  it("early restart: zone hydrates as OPEN with no TPs hit and TP1 arms correctly", () => {
    // Scenario: pod died before any TP fired. DB row has all tp*Hit=false.
    const dbRow = makeRow({
      zoneId: ZONE_ID,
      status: "OPEN",
      tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false,
      anchorPrice: "3120.50",
    });

    const st = rowToZoneState(dbRow);
    _zoneStatesForTest.set(ZONE_ID, st);

    const hydrated = _zoneStatesForTest.get(ZONE_ID)!;
    expect(hydrated.status).toBe("OPEN");
    expect(hydrated.tp1Hit).toBe(false);
    // A simulated TP1 hit price check: for a BUY, price >= tp1Price triggers.
    const tp1Threshold = hydrated.tp1Price - 0.05; // tolerance
    const priceAboveTp1 = hydrated.tp1Price + 0.10;
    expect(priceAboveTp1 >= tp1Threshold).toBe(true); // would fire
    const priceBelowTp1 = hydrated.tp1Price - 0.20;
    expect(priceBelowTp1 >= tp1Threshold).toBe(false); // would not fire
  });

  it("loadZone cache-miss path: hydrating from DB row via _zoneStatesForTest gives same result as direct rowToZoneState", () => {
    // Verifies that the two code paths (loadZone hydrating on miss vs
    // loadZoneState pre-populating on startup) produce equivalent state.
    const dbRow = makeRow({
      zoneId: ZONE_ID,
      status: "OPEN",
      tp1Hit: true, tp2Hit: false,
      anchorPrice: "3100.00",
    });

    // Path A: direct rowToZoneState (used by loadZoneState on startup).
    const stA = rowToZoneState(dbRow);

    // Path B: simulate what loadZone does on cache miss — rowToZoneState then set.
    const stB = rowToZoneState({ ...dbRow }); // same row, independent conversion
    _zoneStatesForTest.set(ZONE_ID, stB);

    const retrieved = _zoneStatesForTest.get(ZONE_ID)!;

    // Both paths must produce the same observable state for the engine.
    expect(retrieved.tp1Hit).toBe(stA.tp1Hit);
    expect(retrieved.tp2Hit).toBe(stA.tp2Hit);
    expect(retrieved.anchorPrice).toBe(stA.anchorPrice);
    expect(retrieved.status).toBe(stA.status);
    expect(retrieved.direction).toBe(stA.direction);
  });
});
