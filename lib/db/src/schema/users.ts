import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id:           serial("id").primaryKey(),
  fullName:     text("full_name"),
  email:        text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
});

export type User = typeof usersTable.$inferSelect;
