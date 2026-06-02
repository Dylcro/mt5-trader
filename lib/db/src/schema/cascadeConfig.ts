import { pgTable, boolean, integer, serial, text } from "drizzle-orm/pg-core";

export const cascadeConfigTable = pgTable("cascade_config", {
  id:           serial("id").primaryKey(),
  accountId:    text("account_id").notNull().default("").unique(),
  enabled:      boolean("enabled").notNull().default(false),
  numPositions: integer("num_positions").notNull().default(3),
  pipsBetween:  integer("pips_between").notNull().default(50),
  slPips:       integer("sl_pips").notNull().default(100),
  // Zone TP — pip distances from the zone anchor for TP1/TP2/TP3 hits.
  tp1Pips:      integer("tp1_pips").notNull().default(20),
  tp2Pips:      integer("tp2_pips").notNull().default(50),
  tp3Pips:      integer("tp3_pips").notNull().default(90),
  tp4Pips:      integer("tp4_pips").notNull().default(0),
  // TP close percentages. Each is the % of the original best-entry volume to
  // close at that TP level. Must sum to 100 across the active TPs. Defaults to
  // 25/25/25/25 (equal quarters). Stored as integers (0-100).
  tp1Pct:       integer("tp1_pct").notNull().default(25),
  tp2Pct:       integer("tp2_pct").notNull().default(25),
  tp3Pct:       integer("tp3_pct").notNull().default(25),
  tp4Pct:       integer("tp4_pct").notNull().default(25),
  tp1Enabled:   boolean("tp1_enabled").notNull().default(true),
  tp2Enabled:   boolean("tp2_enabled").notNull().default(true),
  tp3Enabled:   boolean("tp3_enabled").notNull().default(true),
  tp4Enabled:   boolean("tp4_enabled").notNull().default(true),
  riskFreePips: integer("risk_free_pips").notNull().default(-10),
  autoBeAtTp:   integer("auto_be_at_tp").notNull().default(2),
  takeProfitEnabled: boolean("take_profit_enabled").notNull().default(false),
  takeProfitPips:    integer("take_profit_pips").notNull().default(30),
  // MT5 auto-SL: when a trade is opened directly in MT5, automatically attach
  // a stop loss. `mt5SlEnabled` toggles the feature. `mt5SlNumPositions` is
  // the size of the auto-SL batch (1-6). `mt5SlPips` is the SL distance in
  // dollars (1 "pip" = $1 price move on XAUUSD per Vantage convention).
  // A batch starts when the user has zero open auto-SL'd positions, fills up
  // to N positions, then resets to zero only when ALL tracked positions close.
  mt5SlEnabled:      boolean("mt5_sl_enabled").notNull().default(false),
  mt5SlNumPositions: integer("mt5_sl_num_positions").notNull().default(3),
  mt5SlPips:         integer("mt5_sl_pips").notNull().default(50),
});

export type CascadeConfigRow = typeof cascadeConfigTable.$inferSelect;
