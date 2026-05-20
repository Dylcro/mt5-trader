import { pgTable, serial, text, bigint } from "drizzle-orm/pg-core";

export const storedAccountsTable = pgTable("stored_accounts", {
  id:          serial("id").primaryKey(),
  accountId:   text("account_id").notNull().unique(),
  region:      text("region").notNull().default("london"),
  storedAt:    bigint("stored_at", { mode: "number" }),
});

export type StoredAccount = typeof storedAccountsTable.$inferSelect;
