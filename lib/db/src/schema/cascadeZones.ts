import { pgTable, serial, text, bigint, boolean, doublePrecision } from "drizzle-orm/pg-core";

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
  // Cashout trigger pip offset from the anchor (default 5p covers spread).
  cashoutPips: doublePrecision("cashout_pips").notNull().default(5),
  // Step flags — once true, that step won't fire again.
  cashoutDone: boolean("cashout_done").notNull().default(false),
  tp1Hit:      boolean("tp1_hit").notNull().default(false),
  tp2Hit:      boolean("tp2_hit").notNull().default(false),
  tp3Hit:      boolean("tp3_hit").notNull().default(false),
  tp4Hit:      boolean("tp4_hit").notNull().default(false),
  status:      text("status").notNull().default("OPEN"),
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
  closedAt:    bigint("closed_at", { mode: "number" }),
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
