import { pgTable, serial, text, bigint } from "drizzle-orm/pg-core";

export const supportTicketsTable = pgTable("support_tickets", {
  id:            serial("id").primaryKey(),
  name:          text("name").notNull(),
  email:         text("email"),
  accountNumber: text("account_number"),
  query:         text("query").notNull(),
  createdAt:     bigint("created_at", { mode: "number" }).notNull(),
  /** unread | read | resolved */
  status:        text("status").notNull().default("unread"),
});

export type SupportTicket = typeof supportTicketsTable.$inferSelect;
