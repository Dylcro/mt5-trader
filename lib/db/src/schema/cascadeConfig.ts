import { pgTable, boolean, integer, serial, text } from "drizzle-orm/pg-core";

export const cascadeConfigTable = pgTable("cascade_config", {
  id:           serial("id").primaryKey(),
  accountId:    text("account_id").notNull().default("").unique(),
  enabled:      boolean("enabled").notNull().default(false),
  numPositions: integer("num_positions").notNull().default(3),
  pipsBetween:  integer("pips_between").notNull().default(50),
  slPips:       integer("sl_pips").notNull().default(100),
});

export type CascadeConfigRow = typeof cascadeConfigTable.$inferSelect;
