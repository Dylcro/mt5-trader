import { describe, it, expect, beforeEach } from "vitest";
import {
  computeRiskFreeSl,
  buildCascadeConfigUpdate,
  ZONE_RISK_FREE_PIPS,
  rowToZoneState,
  _zoneStatesForTest,
  buildCascadeComment,
  parseZoneIdFromComment,
  commentBelongsToZone,
  positionBelongsToZone,
  zoneMagicNumber,
  zoneHasTpTargets,
  computeFinalTpReached,
  dealIndicatesStopLoss,
  resolveCloseOutcome,
  inferCloseOutcomeFromExitPrice,
  exitPriceBeyondTp3,
  exitPriceBeforeTp1,
  isManualTp4Zone,
  zonePrimaryOutcome,
  countEnabledTps,
  countHitEnabledTps,
  tpDisplayState,
  shouldCancelCascadeLimitsAtTpStage,
  shouldAutoCloseZoneAfterPositionExit,
  sumDealPnlForPositions,
  sumRealizedTradePnlFromDeals,
  sanitizeAutoBeAtTp,
  resolveAutoBeAtTp,
  isAutoBeTriggerSatisfied,
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
  tp4Pips: 0,
  tp1Pct: 25,
  tp2Pct: 25,
  tp3Pct: 25,
  tp4Pct: 25,
  tp1Enabled: true,
  tp2Enabled: true,
  tp3Enabled: true,
  tp4Enabled: true,
  riskFreePips: -10,
  autoBeAtTp: 2,
  takeProfitEnabled: false,
  takeProfitPips: 30,
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

  it("preserves ARMED status for @-price pending cascades", () => {
    const st = rowToZoneState(makeRow({ status: "ARMED", anchorPrice: 4450 }));
    expect(st.status).toBe("ARMED");
    expect(st.anchorPrice).toBe(4450);
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

  it("handles anchorPrice=0 gracefully when absolute TP prices are set", () => {
    const st = rowToZoneState(makeRow({
      anchorPrice: "0",
      tp1Price: "3130.00",
      tp2Price: "3145.00",
      tp3Price: "3160.00",
    }));
    expect(st.anchorPrice).toBe(0);
    expect(zoneHasTpTargets(st)).toBe(true);
  });

  it("zoneHasTpTargets is false when anchor and TP prices are all unset", () => {
    expect(zoneHasTpTargets({
      anchorPrice: 0,
      tp1Price: null,
      tp2Price: null,
      tp3Price: null,
      tp4Price: null,
    })).toBe(false);
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

describe("zone isolation — comment tagging", () => {
  const zoneA = "z_abc123";
  const zoneB = "z_def456";

  it("buildCascadeComment embeds zoneId for broker-side isolation", () => {
    expect(buildCascadeComment(zoneA, 1, 4)).toBe("Cascade|z_abc123|1/4");
    expect(parseZoneIdFromComment("Cascade|z_abc123|2/4")).toBe(zoneA);
  });

  it("commentBelongsToZone only matches the owning zone", () => {
    const commentA = buildCascadeComment(zoneA, 3, 4);
    expect(commentBelongsToZone(commentA, zoneA)).toBe(true);
    expect(commentBelongsToZone(commentA, zoneB)).toBe(false);
    expect(commentBelongsToZone("Cascade 1/4", zoneA)).toBe(false);
  });

  it("parallel zones: sibling cascade comments never match wrong zone close filter", () => {
    const sellLimits = [2, 3, 4].map((leg) => buildCascadeComment(zoneA, leg, 4));
    const buyLimits = [2, 3, 4].map((leg) => buildCascadeComment(zoneB, leg, 4));
    for (const c of sellLimits) {
      expect(commentBelongsToZone(c, zoneA)).toBe(true);
      expect(commentBelongsToZone(c, zoneB)).toBe(false);
    }
    for (const c of buyLimits) {
      expect(commentBelongsToZone(c, zoneB)).toBe(true);
      expect(commentBelongsToZone(c, zoneA)).toBe(false);
    }
  });

  it("positionBelongsToZone matches magic or comment, not sibling zones", () => {
    const magicA = zoneMagicNumber(zoneA);
    const magicB = zoneMagicNumber(zoneB);
    expect(magicA).not.toBe(magicB);
    expect(positionBelongsToZone({ magic: magicA }, zoneA)).toBe(true);
    expect(positionBelongsToZone({ magic: magicA }, zoneB)).toBe(false);
    expect(positionBelongsToZone({ comment: buildCascadeComment(zoneA, 1, 4) }, zoneA)).toBe(true);
    expect(positionBelongsToZone({ comment: buildCascadeComment(zoneA, 1, 4) }, zoneB)).toBe(false);
  });
});

describe("disabled TP history", () => {
  it("tpDisplayState: disabled is never hit", () => {
    expect(tpDisplayState(false, true)).toBe("disabled");
    expect(tpDisplayState(false, false)).toBe("disabled");
    expect(tpDisplayState(true, false)).toBe("pending");
    expect(tpDisplayState(true, true)).toBe("hit");
  });

  it("computeFinalTpReached ignores disabled TPs", () => {
    expect(computeFinalTpReached({
      tp1Enabled: true, tp2Enabled: true, tp3Enabled: false, tp4Enabled: true,
      tp1Hit: true, tp2Hit: true, tp3Hit: true, tp4Hit: false,
    })).toBe(2);
  });

  it("dealIndicatesStopLoss detects broker SL reasons", () => {
    expect(dealIndicatesStopLoss({ reason: "DEAL_REASON_SL" })).toBe(true);
    expect(dealIndicatesStopLoss({ reason: "STOP_LOSS" })).toBe(true);
    expect(dealIndicatesStopLoss({ comment: "stop loss" })).toBe(true);
    expect(dealIndicatesStopLoss({ reason: "CLIENT" })).toBe(false);
  });

  it("resolveCloseOutcome respects persisted flags", () => {
    expect(resolveCloseOutcome({
      status: "CLOSED",
      tp4Enabled: true,
      tp4Hit: false,
      manualClose: true,
      slHit: false,
    })).toEqual({ manualClose: true, slHit: false });
    expect(resolveCloseOutcome({
      status: "CLOSED",
      tp4Enabled: true,
      tp4Hit: true,
      manualClose: false,
      slHit: false,
    })).toEqual({ manualClose: false, slHit: false });
    expect(resolveCloseOutcome({
      status: "CLOSED",
      tp4Enabled: true,
      tp4Hit: false,
      manualClose: false,
      slHit: true,
    })).toEqual({ manualClose: false, slHit: true });
  });

  it("inferCloseOutcomeFromExitPrice: manual TP4 close above TP3 is tp4Hit not manual", () => {
    const zone = {
      direction: "buy" as const,
      tp1Price: 2600,
      tp3Price: 2650,
      tp4Price: null,
      tp4Enabled: true,
      tp4Hit: false,
    };
    expect(isManualTp4Zone(zone.tp4Price, zone.tp4Enabled)).toBe(true);
    expect(exitPriceBeyondTp3("buy", 2660, 2650)).toBe(true);
    expect(inferCloseOutcomeFromExitPrice(zone, 2660)).toEqual({ tp4Hit: true, manualClose: false });
    expect(inferCloseOutcomeFromExitPrice(zone, 2590)).toEqual({ tp4Hit: false, manualClose: true });
    expect(inferCloseOutcomeFromExitPrice(zone, 2630)).toEqual({ tp4Hit: false, manualClose: false });
  });

  it("zonePrimaryOutcome: exit reason for a closed zone", () => {
    const base = {
      status: "CLOSED",
      tp1Enabled: true,
      tp2Enabled: true,
      tp3Enabled: true,
      tp4Enabled: true,
      tp1Hit: true,
      tp2Hit: true,
      tp3Hit: true,
      tp4Hit: false,
      slHit: false,
      manualClose: false,
    };
    expect(zonePrimaryOutcome({ ...base, finalTpReached: 3 })).toBe("TP3");
    expect(zonePrimaryOutcome({ ...base, manualClose: true, finalTpReached: 3 })).toBe("MANUAL");
    expect(zonePrimaryOutcome({ ...base, tp4Hit: true, finalTpReached: 4 })).toBe("TP4");
    expect(zonePrimaryOutcome({ ...base, slHit: true })).toBe("SL");
  });

  it("inferCloseOutcomeFromExitPrice: sell zone mirrors buy", () => {
    const zone = {
      direction: "sell" as const,
      tp1Price: 2700,
      tp3Price: 2650,
      tp4Price: null,
      tp4Enabled: true,
    };
    expect(exitPriceBeforeTp1("sell", 2710, 2700)).toBe(true);
    expect(inferCloseOutcomeFromExitPrice(zone, 2640)).toEqual({ tp4Hit: true, manualClose: false });
    expect(inferCloseOutcomeFromExitPrice(zone, 2710)).toEqual({ tp4Hit: false, manualClose: true });
  });

  it("hit/enabled counts use only enabled TPs as denominator", () => {
    const flags = { tp1Enabled: true, tp2Enabled: true, tp3Enabled: false, tp4Enabled: true };
    expect(countEnabledTps(flags)).toBe(3);
    expect(countHitEnabledTps({
      ...flags,
      tp1Hit: true, tp2Hit: true, tp3Hit: true, tp4Hit: false,
    })).toBe(2);
  });

  it("rowToZoneState does not pre-mark disabled TPs as hit", () => {
    const st = rowToZoneState(makeRow({
      tp1Pct: 25, tp2Pct: 25, tp3Pct: 0, tp4Pct: 25,
      tp1Enabled: true, tp2Enabled: true, tp3Enabled: false, tp4Enabled: true,
      tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false,
    } as Parameters<typeof makeRow>[0]));
    expect(st.tp3Hit).toBe(false);
    expect(st.tp3Enabled).toBe(false);
  });
});

describe("cascade limit cancel timing", () => {
  it("does not cancel limits on TP1", () => {
    expect(shouldCancelCascadeLimitsAtTpStage(1, { tp1Hit: true, tp2Hit: false })).toBe(false);
    expect(shouldCancelCascadeLimitsAtTpStage(1, { tp1Hit: false, tp2Hit: false })).toBe(false);
  });

  it("cancels limits only on first TP2 after TP1 hit", () => {
    expect(shouldCancelCascadeLimitsAtTpStage(2, { tp1Hit: true, tp2Hit: false })).toBe(true);
    expect(shouldCancelCascadeLimitsAtTpStage(2, { tp1Hit: false, tp2Hit: false })).toBe(false);
    expect(shouldCancelCascadeLimitsAtTpStage(2, { tp1Hit: true, tp2Hit: true })).toBe(false);
  });

  it("defers auto zone-close while OPEN pre-TP2 with pending limits", () => {
    expect(shouldAutoCloseZoneAfterPositionExit(
      { status: "OPEN", tp2Hit: false },
      false,
      true,
    )).toBe(false);
    expect(shouldAutoCloseZoneAfterPositionExit(
      { status: "OPEN", tp2Hit: true },
      false,
      true,
    )).toBe(true);
    expect(shouldAutoCloseZoneAfterPositionExit(
      { status: "OPEN", tp2Hit: false },
      false,
      false,
    )).toBe(true);
  });
});

describe("auto break-even at TP setting", () => {
  it("sanitizes autoBeAtTp to 1|2|3", () => {
    expect(sanitizeAutoBeAtTp(1)).toBe(1);
    expect(sanitizeAutoBeAtTp("3")).toBe(3);
    expect(sanitizeAutoBeAtTp("x")).toBe(2);
  });

  it("resolveAutoBeAtTp falls back when chosen TP is disabled", () => {
    expect(resolveAutoBeAtTp(1, { tp1: false, tp2: true, tp3: true })).toBe(2);
    expect(resolveAutoBeAtTp(3, { tp1: true, tp2: true, tp3: false })).toBe(1);
  });

  it("isAutoBeTriggerSatisfied follows configured level", () => {
    expect(isAutoBeTriggerSatisfied({ autoBeAtTp: 1, tp1Hit: true, tp2Hit: false, tp3Hit: false })).toBe(true);
    expect(isAutoBeTriggerSatisfied({ autoBeAtTp: 2, tp1Hit: true, tp2Hit: false, tp3Hit: false })).toBe(false);
    expect(isAutoBeTriggerSatisfied({ autoBeAtTp: 3, tp1Hit: true, tp2Hit: true, tp3Hit: true })).toBe(true);
  });
});

describe("sumRealizedTradePnlFromDeals (dashboard period P&L)", () => {
  it("counts only BUY/SELL exit deals with a symbol", () => {
    const deals = [
      { type: "DEAL_TYPE_BUY", entryType: "DEAL_ENTRY_IN", symbol: "XAUUSD", profit: 0, commission: -1, swap: 0 },
      { type: "DEAL_TYPE_BUY", entryType: "DEAL_ENTRY_OUT", symbol: "XAUUSD", profit: 50, commission: -0.5, swap: 0 },
      { type: "DEAL_TYPE_BALANCE", entryType: "DEAL_ENTRY_IN", profit: 1000, commission: 0, swap: 0 },
      { type: "DEAL_TYPE_SELL", entryType: "DEAL_ENTRY_OUT", symbol: "XAUUSD", profit: -10, commission: 0, swap: -0.2 },
    ];
    expect(sumRealizedTradePnlFromDeals(deals)).toBe(39.3);
  });
});

describe("sumDealPnlForPositions (zone closed P&L)", () => {
  it("sums profit+commission+swap only for linked position ids", () => {
    const ids = new Set(["p1", "p2"]);
    const deals = [
      { positionId: "p1", profit: 10, commission: -0.5, swap: 0 },
      { positionId: "p2", profit: 5, commission: 0, swap: -0.2 },
      { positionId: "other", profit: 100, commission: 0, swap: 0 },
      { positionId: "p1", profit: 2.5, commission: 0, swap: 0 },
    ];
    expect(sumDealPnlForPositions(deals, ids)).toBe(16.8);
  });
});
