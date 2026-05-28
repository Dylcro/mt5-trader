import { pgTable, text, bigint, doublePrecision } from "drizzle-orm/pg-core";

// Per-user "last used" cascade trade defaults. The Apple Watch reads this row
// to know what lot size + TP offsets to fire with when the user taps BUY/SELL,
// so the watch doesn't need a UI for those values. The phone writes a fresh row
// after every successful cascade placement.
export const userTradeDefaultsTable = pgTable("user_trade_defaults", {
  userId:      text("user_id").primaryKey(),
  lotSize:     doublePrecision("lot_size").notNull().default(0.04),
  // TP offsets stored as POSITIVE pip distances from the entry, in the
  // profitable direction. The watch converts these to absolute prices at
  // trade time using the current bid/ask.
  tp1Pips:     doublePrecision("tp1_pips").notNull().default(20),
  tp2Pips:     doublePrecision("tp2_pips").notNull().default(50),
  tp3Pips:     doublePrecision("tp3_pips").notNull().default(90),
  // tp4Pips = 0 means "leave the final 25% open / manual close".
  tp4Pips:     doublePrecision("tp4_pips").notNull().default(0),
  // SL pip distance for the cascade.
  slPips:      doublePrecision("sl_pips").notNull().default(100),
  updatedAt:   bigint("updated_at", { mode: "number" }).notNull(),
});

export type UserTradeDefaultsRow = typeof userTradeDefaultsTable.$inferSelect;
