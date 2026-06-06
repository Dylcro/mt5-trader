import { pgTable, serial, text, bigint, boolean, doublePrecision, integer } from "drizzle-orm/pg-core";

export const cascadeZonesTable = pgTable("cascade_zones", {
  id:          serial("id").primaryKey(),
  zoneId:      text("zone_id").notNull().unique(),
  accountId:   text("account_id").notNull(),
  userId:      text("user_id"),
  direction:   text("direction").notNull(),
  anchorPrice: doublePrecision("anchor_price").notNull(),
  // Legacy pip-based TPs (kept for back-compat with pre-rebuild zones).
  // New zones use absolute tpXPrice instead.
  tp1Pips:     doublePrecision("tp1_pips").notNull().default(20),
  tp2Pips:     doublePrecision("tp2_pips").notNull().default(50),
  tp3Pips:     doublePrecision("tp3_pips").notNull().default(90),
  // Absolute TP prices typed by the user when placing the cascade.
  // tp4Price is nullable — when omitted, TP4 is left for the user to close manually.
  tp1Price:    doublePrecision("tp1_price"),
  tp2Price:    doublePrecision("tp2_price"),
  tp3Price:    doublePrecision("tp3_price"),
  tp4Price:    doublePrecision("tp4_price"),
  // Original best-entry volume captured at cascade placement so the 25%
  // partials at TP1/2/3/4 stay consistent across partial fills.
  originalVolume: doublePrecision("original_volume"),
  // Per-zone TP close percentages baked in at zone creation time (from the user's
  // split config). Defaults to 25 each for backward-compat with pre-split zones.
  tp1Pct:      doublePrecision("tp1_pct").notNull().default(25),
  tp2Pct:      doublePrecision("tp2_pct").notNull().default(25),
  tp3Pct:      doublePrecision("tp3_pct").notNull().default(25),
  tp4Pct:      doublePrecision("tp4_pct").notNull().default(25),
  // Snapshot of which TP levels were enabled when the zone was placed.
  tp1Enabled:  boolean("tp1_enabled").notNull().default(true),
  tp2Enabled:  boolean("tp2_enabled").notNull().default(true),
  tp3Enabled:  boolean("tp3_enabled").notNull().default(true),
  tp4Enabled:  boolean("tp4_enabled").notNull().default(true),
  // Cashout trigger pip offset from the anchor (default 5p covers spread).
  cashoutPips: doublePrecision("cashout_pips").notNull().default(5),
  // Step flags — once true, that step won't fire again.
  cashoutDone: boolean("cashout_done").notNull().default(false),
  tp1Hit:      boolean("tp1_hit").notNull().default(false),
  tp2Hit:      boolean("tp2_hit").notNull().default(false),
  tp3Hit:      boolean("tp3_hit").notNull().default(false),
  tp4Hit:      boolean("tp4_hit").notNull().default(false),
  /** Zone fully closed by user/app or MT5 exit without TP4 automation. */
  manualClose: boolean("manual_close").notNull().default(false),
  /** Zone fully closed because broker stop loss was hit. */
  slHit:       boolean("sl_hit").notNull().default(false),
  /** User pressed Risk free on this zone (surviving leg at RF SL). */
  wentRiskFree: boolean("went_risk_free").notNull().default(false),
  /** SL on the risk-free survivor — History RF, not SL. */
  riskFreeSlExit: boolean("risk_free_sl_exit").notNull().default(false),
  /** Signed pip offset for Risk Free SL, baked in at zone creation (-30..+30). */
  riskFreeOffset: integer("risk_free_offset").notNull().default(0),
  // When TP2 fires but price has retraced through the entry, true BE
  // (SL = openPrice) would be rejected by the broker (SL below current ask
  // for a SELL would close the position instantly). We instead apply a
  // "best effort" SL at the broker's minimum-allowed distance and flag the
  // zone so the app can show a "SL not at BE" warning chip. Once price
  // moves favorably enough that true BE becomes valid, the engine upgrades
  // the SL and clears the flag.
  tp2SlIsBestEffort: boolean("tp2_sl_is_best_effort").notNull().default(false),
  // Auto SL→BE fires after this TP level's partial close (1, 2, or 3). Default 2.
  autoBeAtTp:  doublePrecision("auto_be_at_tp").notNull().default(2),
  status:      text("status").notNull().default("OPEN"),
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
  closedAt:    bigint("closed_at", { mode: "number" }),
  // Realized P&L for the whole zone (profit+commission+swap on all linked positions).
  closedPnl:   doublePrecision("closed_pnl"),
  runner1Price: doublePrecision("runner1_price"),
  runner1Lots:  doublePrecision("runner1_lots"),
  runner2Price: doublePrecision("runner2_price"),
  runner2Lots:  doublePrecision("runner2_lots"),
  runner3Price: doublePrecision("runner3_price"),
  runner3Lots:  doublePrecision("runner3_lots"),
  runner1Hit:   boolean("runner1_hit").notNull().default(false),
  runner2Hit:   boolean("runner2_hit").notNull().default(false),
  runner3Hit:   boolean("runner3_hit").notNull().default(false),
  runnerActive: boolean("runner_active").notNull().default(false),
});

export type CascadeZoneRow = typeof cascadeZonesTable.$inferSelect;

export const zonePositionsTable = pgTable("zone_positions", {
  id:         serial("id").primaryKey(),
  zoneId:     text("zone_id").notNull(),
  positionId: text("position_id").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  volume:     doublePrecision("volume").notNull(),
  status:     text("status").notNull().default("OPEN"),
  createdAt:  bigint("created_at", { mode: "number" }).notNull(),
  // Per-position TP hit flags. Set to true by evaluateZone when a TP level is
  // applied to this specific position. Enables positions that fill into the zone
  // after TP1 (e.g. cascade limits filling on a pullback) to run through the
  // full TP ladder independently of the main entry position.
  tp1Hit:     boolean("tp1_hit").notNull().default(false),
  tp2Hit:     boolean("tp2_hit").notNull().default(false),
  tp3Hit:     boolean("tp3_hit").notNull().default(false),
  tp4Hit:     boolean("tp4_hit").notNull().default(false),
});

export type ZonePositionRow = typeof zonePositionsTable.$inferSelect;

// Persistent zone↔order mapping so cascade limit fills (and TP2 cancellations)
// still find their zone after a server restart.
export const zoneOrdersTable = pgTable("zone_orders", {
  id:        serial("id").primaryKey(),
  zoneId:    text("zone_id").notNull(),
  orderId:   text("order_id").notNull().unique(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type ZoneOrderRow = typeof zoneOrdersTable.$inferSelect;
