import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id:           serial("id").primaryKey(),
  fullName:     text("full_name"),
  email:        text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  locked:       boolean("locked").notNull().default(false),
  lockedReason: text("locked_reason"),
});

export type User = typeof usersTable.$inferSelect;
