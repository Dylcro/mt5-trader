import { bigint, pgTable, serial, text } from "drizzle-orm/pg-core";

export const waitlistTable = pgTable("waitlist", {
  id:        serial("id").primaryKey(),
  email:     text("email").notNull().unique(),
  status:    text("status").notNull().default("pending"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export type WaitlistEntry = typeof waitlistTable.$inferSelect;
