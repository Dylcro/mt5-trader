import { pgTable, boolean, integer, serial, text } from "drizzle-orm/pg-core";

export const cascadeConfigTable = pgTable("cascade_config", {
  id:           serial("id").primaryKey(),
  accountId:    text("account_id").notNull().default("").unique(),
  enabled:      boolean("enabled").notNull().default(false),
  numPositions: integer("num_positions").notNull().default(3),
  pipsBetween:  integer("pips_between").notNull().default(50),
  slPips:       integer("sl_pips").notNull().default(100),
  // MT5 auto-SL: when a trade is opened directly in MT5, automatically attach
  // a stop loss. `mt5SlEnabled` toggles the feature. `mt5SlNumPositions` is
  // the size of the auto-SL batch (1-6). `mt5SlPips` is the SL distance in
  // dollars (1 "pip" = $1 price move on XAUUSD per Vantage convention).
  // A batch starts when the user has zero open auto-SL'd positions, fills up
  // to N positions, then resets to zero only when ALL tracked positions close.
  mt5SlEnabled:      boolean("mt5_sl_enabled").notNull().default(false),
  mt5SlNumPositions: integer("mt5_sl_num_positions").notNull().default(3),
  mt5SlPips:         integer("mt5_sl_pips").notNull().default(50),
  // Failsafe SL: a periodic safety-net scan (every 10s) that finds any open
  // XAUUSD position without a stop loss and attaches one at `mt5FailsafePips`
  // away from current market. Catches edge cases the primary onDealAdded
  // path misses (server restart, missed deal event, primary SL all-retries
  // failure, etc.). On by default.
  mt5FailsafeEnabled: boolean("mt5_failsafe_enabled").notNull().default(true),
  mt5FailsafePips:    integer("mt5_failsafe_pips").notNull().default(150),
});

export type CascadeConfigRow = typeof cascadeConfigTable.$inferSelect;
