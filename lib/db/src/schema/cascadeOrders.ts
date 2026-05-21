import { pgTable, serial, text, bigint } from "drizzle-orm/pg-core";

export const cascadeOrdersTable = pgTable("cascade_orders", {
  id:        serial("id").primaryKey(),
  accountId: text("account_id").notNull(),
  orderId:   text("order_id").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type CascadeOrderRow = typeof cascadeOrdersTable.$inferSelect;
