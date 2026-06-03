// Restart-hydration integration tests
//
// These tests simulate the full "kill pod mid-cascade, restart, verify TP
// progression continues" scenario described in Task #44.
//
// The DB is mocked so loadZoneState() and loadZone() are called with controlled
// row data — this is the critical difference from the unit tests in
// mt5-helpers.test.ts which manipulate _zoneStatesForTest directly.
//
// Flow under test:
//   1. Zone is active with TPs partially hit (state persisted in DB).
//   2. Pod crashes — all in-memory state is gone.
//   3. On restart, loadZoneState() queries DB and populates zoneStates.
//   4. Monitor tick calls evaluateZone() via loadZone() (single read path).
//   5. Engine continues from exact DB-persisted checkpoint, no TP re-fires.

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Shared mock state ─────────────────────────────────────────────────────────
// Mutable arrays that each test populates before calling loadZoneState/loadZone.
// The mock DB factory reads from these at call-time (lazy closure capture),
// which works because vi.mock factories run after module-level declarations.

const mockStore = {
  zones: [] as Record<string, unknown>[],
  positions: [] as Record<string, unknown>[],
  orders: [] as Record<string, unknown>[],
};

// Wraps rows in a Promise that also has .where() and .limit() for chaining.
function chainable(rows: Record<string, unknown>[]) {
  const p = Promise.resolve([...rows]) as Promise<Record<string, unknown>[]> & {
    where: (...args: unknown[]) => ReturnType<typeof chainable>;
    limit: (n: number) => Promise<Record<string, unknown>[]>;
  };
  p.where = (..._args: unknown[]) => chainable(rows);
  p.limit = (n: number) => Promise.resolve([...rows].slice(0, n));
  return p;
}

// ── Mocks (hoisted by vitest) ─────────────────────────────────────────────────

// Override the 4 drizzle-orm operators with no-ops so they don't throw when
// called with mock table objects that lack real SQL column definitions.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    and: (..._a: unknown[]) => null,
    eq: (_col: unknown, _val: unknown) => null,
    inArray: (_col: unknown, _vals: unknown[]) => null,
    isNotNull: (_col: unknown) => null,
  };
});

vi.mock("@workspace/db", () => ({
  // ensureCascadeZoneRfColumns() runs ALTER via pool on loadZone / loadZoneState
  pool: {
    query: vi.fn(() => Promise.resolve({ rows: [] })),
  },
  db: {
    select: () => ({
      from: (t: { _key?: string }) =>
        chainable(
          t?._key === "zones"     ? mockStore.zones :
          t?._key === "positions" ? mockStore.positions :
          t?._key === "orders"    ? mockStore.orders : []
        ),
    }),
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
        catch: (_fn: unknown) => Promise.resolve(),
      }),
    }),
  },
  cascadeZonesTable:      { _key: "zones" },
  zonePositionsTable:     { _key: "positions" },
  zoneOrdersTable:        { _key: "orders" },
  cascadeConfigTable:     { _key: "config" },
  storedAccountsTable:    { _key: "accounts" },
  cascadeHistoryTable:    { _key: "history" },
  cascadeOrdersTable:     { _key: "cascade_orders" },
  notificationPrefsTable: { _key: "prefs" },
}));

// Import AFTER mock declarations (vi.mock is hoisted, so mocks apply to mt5.ts)
import {
  loadZoneState,
  loadZone,
  _zoneStatesForTest,
} from "../src/routes/mt5";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeZoneRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zoneId:         "z_restart_integ_001",
    accountId:      "acc_test",
    userId:         null,
    direction:      "buy",
    anchorPrice:    "3120.50",
    tp1Price:       "3130.00",
    tp2Price:       "3145.00",
    tp3Price:       "3160.00",
    tp4Price:       "3175.00",
    tp1Pips:        null,
    tp2Pips:        null,
    tp3Pips:        null,
    originalVolume: "0.08",
    cashoutPips:    5,
    cashoutDone:    false,
    tp1Hit:         false,
    tp2Hit:         false,
    tp3Hit:         false,
    tp4Hit:         false,
    tp2SlIsBestEffort: false,
    status:         "OPEN",
    createdAt:      Date.now(),
    closedAt:       null,
    ...overrides,
  };
}

function makePositionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zoneId:     "z_restart_integ_001",
    positionId: "pos_abc",
    volume:     "0.04",
    entryPrice: "3120.50",
    status:     "OPEN",
    createdAt:  Date.now(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Restart-hydration via loadZoneState (DB-mocked integration)", () => {
  beforeEach(() => {
    // Simulate pod restart: clear all in-memory zone state.
    _zoneStatesForTest.clear();
    mockStore.zones = [];
    mockStore.positions = [];
    mockStore.orders = [];
  });

  it("populates zoneStates from DB rows so monitor can resume tracking after restart", async () => {
    // DB has one OPEN zone with no TPs hit yet
    mockStore.zones = [makeZoneRow()];

    await loadZoneState();

    expect(_zoneStatesForTest.size).toBe(1);
    const st = _zoneStatesForTest.get("z_restart_integ_001")!;
    expect(st).toBeDefined();
    expect(st.status).toBe("OPEN");
    expect(st.accountId).toBe("acc_test");
    expect(st.direction).toBe("buy");
    expect(st.anchorPrice).toBe(3120.50);
  });

  it("mid-cascade restart: TP1+TP2 already hit — engine arms TP3 not re-fires TP1/TP2", async () => {
    // Scenario: pod died mid-cascade at TP2 (RISK_FREE). DB has preserved
    // tp1Hit=true, tp2Hit=true so on restart the engine must start at TP3.
    mockStore.zones = [makeZoneRow({
      status:  "RISK_FREE",
      tp1Hit:  true,
      tp2Hit:  true,
      tp3Hit:  false,
      tp4Hit:  false,
    })];
    mockStore.positions = [makePositionRow({ positionId: "pos_surviving" })];

    await loadZoneState();

    const st = _zoneStatesForTest.get("z_restart_integ_001")!;
    expect(st.status).toBe("RISK_FREE");

    // Completed TPs preserved — engine will NOT re-fire TP1/TP2
    expect(st.tp1Hit).toBe(true);
    expect(st.tp2Hit).toBe(true);

    // Pending TPs clear — engine WILL fire TP3 on the next qualifying tick
    expect(st.tp3Hit).toBe(false);
    expect(st.tp4Hit).toBe(false);

    // Prices are correct for continued TP evaluation
    expect(st.tp3Price).toBe(3160.00);
    expect(st.tp4Price).toBe(3175.00);

    // Transient flags reset (BE re-attempted once after restart, not skipped)
    expect(st.tp2SlMoved).toBe(false);
    expect(st.tp2BeAttempts).toBe(0);
    expect(st.busy).toBe(false);
  });

  it("hydrates position tracking so evaluateZone can calculate lot sizes after restart", async () => {
    mockStore.zones = [makeZoneRow({ status: "OPEN" })];
    mockStore.positions = [
      makePositionRow({ positionId: "pos_1", volume: "0.04", entryPrice: "3121.00" }),
      makePositionRow({ positionId: "pos_2", volume: "0.04", entryPrice: "3122.00" }),
    ];

    await loadZoneState();

    const st = _zoneStatesForTest.get("z_restart_integ_001")!;
    // Both open positions are in the tracking map
    expect(st.trackedPositions.has("pos_1")).toBe(true);
    expect(st.trackedPositions.has("pos_2")).toBe(true);
    expect(st.trackedPositions.get("pos_1")?.volume).toBe(0.04);
    expect(st.trackedPositions.get("pos_2")?.entryPrice).toBe(3122.00);
  });

  it("loads OPEN and RISK_FREE zones; CLOSED zones are absent from the map after restart", async () => {
    // The real DB query uses inArray(status, ["OPEN","RISK_FREE"]) so CLOSED rows
    // are never returned. In this mock we reflect what the real DB would return:
    // only OPEN + RISK_FREE rows. The test verifies those zones land in the map
    // and no phantom CLOSED zone appears (it was never in the mock data).
    mockStore.zones = [
      makeZoneRow({ zoneId: "z_open", status: "OPEN" }),
      makeZoneRow({ zoneId: "z_rf",   status: "RISK_FREE", tp1Hit: true, tp2Hit: true }),
    ];

    await loadZoneState();

    expect(_zoneStatesForTest.has("z_open")).toBe(true);
    expect(_zoneStatesForTest.get("z_open")!.status).toBe("OPEN");

    expect(_zoneStatesForTest.has("z_rf")).toBe(true);
    expect(_zoneStatesForTest.get("z_rf")!.status).toBe("RISK_FREE");
    expect(_zoneStatesForTest.get("z_rf")!.tp1Hit).toBe(true);

    // CLOSED zone was not in the mock result (the SQL WHERE filters it out)
    // so it is absent from zoneStates — monitor has nothing to evaluate.
    expect(_zoneStatesForTest.has("z_closed_ghost")).toBe(false);
  });

  it("loadZone cache-miss path: hydrates single zone from DB when not in zoneStates", async () => {
    // In-memory map is empty (simulating restart between loadZoneState + first monitor tick)
    // loadZone() must fetch from DB and populate the cache
    mockStore.zones = [makeZoneRow({ status: "OPEN", tp1Hit: true })];

    const st = await loadZone("z_restart_integ_001");

    expect(st).not.toBeNull();
    expect(st!.status).toBe("OPEN");
    expect(st!.tp1Hit).toBe(true);

    // The zone is now in cache — subsequent loadZone calls return the cached value
    expect(_zoneStatesForTest.has("z_restart_integ_001")).toBe(true);
  });

  it("loadZone cache-miss returns null for nonexistent zone (genuine 404, not masked DB error)", async () => {
    // DB has no matching zone
    mockStore.zones = [];

    const st = await loadZone("z_does_not_exist");

    expect(st).toBeNull();
    expect(_zoneStatesForTest.has("z_does_not_exist")).toBe(false);
  });

  it("loadZone returns CLOSED zone from DB so close-zone route can give idempotent response", async () => {
    // CLOSED zones are now returned by loadZone; callers check status themselves.
    mockStore.zones = [makeZoneRow({ status: "CLOSED" })];

    const st = await loadZone("z_restart_integ_001");

    expect(st).not.toBeNull();
    expect(st!.status).toBe("CLOSED");
  });
});
