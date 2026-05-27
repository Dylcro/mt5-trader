import { pgTable, serial, text, bigint, boolean, doublePrecision } from "drizzle-orm/pg-core";

export const cascadeZonesTable = pgTable("cascade_zones", {
  id:          serial("id").primaryKey(),
  zoneId:      text("zone_id").notNull().unique(),
  accountId:   text("account_id").notNull(),
  userId:      text("user_id"),
  direction:   text("direction").notNull(),
  anchorPrice: doublePrecision("anchor_price").notNull(),
  tp1Pips:     doublePrecision("tp1_pips").notNull().default(20),
  tp2Pips:     doublePrecision("tp2_pips").notNull().default(50),
  tp3Pips:     doublePrecision("tp3_pips").notNull().default(90),
  tp1Hit:      boolean("tp1_hit").notNull().default(false),
  tp2Hit:      boolean("tp2_hit").notNull().default(false),
  tp3Hit:      boolean("tp3_hit").notNull().default(false),
  status:      text("status").notNull().default("OPEN"),
  createdAt:   bigint("created_at", { mode: "number" }).notNull(),
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
