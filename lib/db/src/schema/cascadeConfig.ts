import { pgTable, boolean, integer } from "drizzle-orm/pg-core";

export const cascadeConfigTable = pgTable("cascade_config", {
  id:           integer("id").primaryKey().default(1),
  enabled:      boolean("enabled").notNull().default(false),
  numPositions: integer("num_positions").notNull().default(3),
  pipsBetween:  integer("pips_between").notNull().default(50),
  slPips:       integer("sl_pips").notNull().default(100),
});

export type CascadeConfigRow = typeof cascadeConfigTable.$inferSelect;
