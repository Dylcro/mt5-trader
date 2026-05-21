import { pgTable, serial, text, bigint } from "drizzle-orm/pg-core";

export const cascadeHistoryTable = pgTable("cascade_history", {
  id:         serial("id").primaryKey(),
  accountId:  text("account_id").notNull(),
  positionId: text("position_id").notNull(),
  createdAt:  bigint("created_at", { mode: "number" }).notNull(),
});

export type CascadeHistoryRow = typeof cascadeHistoryTable.$inferSelect;
