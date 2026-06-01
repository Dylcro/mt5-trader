import { boolean, integer, pgTable, serial, text } from "drizzle-orm/pg-core";

/** Singleton row (id=1) — platform-wide admin controls. */
export const adminSettingsTable = pgTable("admin_settings", {
  id:                   serial("id").primaryKey(),
  membershipCap:        integer("membership_cap").notNull().default(20),
  inviteOnly:           boolean("invite_only").notNull().default(false),
  inviteCode:           text("invite_code"),
  signupsOpen:          boolean("signups_open").notNull().default(true),
  tradingPaused:        boolean("trading_paused").notNull().default(false),
  tradingPauseMessage:  text("trading_pause_message").notNull().default(
    "Trading is temporarily paused — we'll be back shortly.",
  ),
});

export type AdminSettings = typeof adminSettingsTable.$inferSelect;
