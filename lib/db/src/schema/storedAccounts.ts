import { pgTable, serial, text, bigint } from "drizzle-orm/pg-core";

export const storedAccountsTable = pgTable("stored_accounts", {
  id:          serial("id").primaryKey(),
  accountId:   text("account_id").notNull().unique(),
  region:      text("region").notNull().default("new-york"),
  storedAt:    bigint("stored_at", { mode: "number" }),
  userId:      text("user_id"),
  /** Broker MT5 login number (e.g. 12345678). */
  mt5Login:    text("mt5_login"),
  /** Broker server name (e.g. VantageInternational-Live). */
  mt5Server:   text("mt5_server"),
});

export type StoredAccount = typeof storedAccountsTable.$inferSelect;
