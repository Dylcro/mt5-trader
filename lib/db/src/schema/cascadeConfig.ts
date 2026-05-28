import { pgTable, boolean, integer, serial, text } from "drizzle-orm/pg-core";

export const cascadeConfigTable = pgTable("cascade_config", {
  id:           serial("id").primaryKey(),
  accountId:    text("account_id").notNull().default("").unique(),
  enabled:      boolean("enabled").notNull().default(false),
  numPositions: integer("num_positions").notNull().default(3),
  pipsBetween:  integer("pips_between").notNull().default(50),
  slPips:       integer("sl_pips").notNull().default(100),
  // Zone TP — pip distances from the zone anchor for TP1/TP2/TP3/TP4 hits.
  // tp4Pips = 0 means "leave the last 25% open / manual close".
  tp1Pips:      integer("tp1_pips").notNull().default(20),
  tp2Pips:      integer("tp2_pips").notNull().default(50),
  tp3Pips:      integer("tp3_pips").notNull().default(90),
  tp4Pips:      integer("tp4_pips").notNull().default(0),
  // MT5 auto-SL: when a trade is opened directly in MT5, automatically attach
  // a stop loss. `mt5SlEnabled` toggles the feature. `mt5SlNumPositions` is
  // the size of the auto-SL batch (1-6). `mt5SlPips` is the SL distance in
  // dollars (1 "pip" = $1 price move on XAUUSD per Vantage convention).
  // A batch starts when the user has zero open auto-SL'd positions, fills up
  // to N positions, then resets to zero only when ALL tracked positions close.
  mt5SlEnabled:      boolean("mt5_sl_enabled").notNull().default(false),
  mt5SlNumPositions: integer("mt5_sl_num_positions").notNull().default(3),
  mt5SlPips:         integer("mt5_sl_pips").notNull().default(50),
  // MT5 auto-cascade: when enabled, a manual market trade placed directly in
  // MT5 (not through the app) automatically gets a full cascade built around
  // it using the pip distances above. `mt5CascadeLot` is the per-leg lot size
  // (decimal stored as text, e.g. "0.04"). Re-uses numPositions/pipsBetween/
  // slPips/tp1-4Pips so users tune one set of values.
  autoCascadeOnMt5:  boolean("auto_cascade_on_mt5").notNull().default(false),
  mt5CascadeLot:     text("mt5_cascade_lot").notNull().default("0.04"),
});

export type CascadeConfigRow = typeof cascadeConfigTable.$inferSelect;
