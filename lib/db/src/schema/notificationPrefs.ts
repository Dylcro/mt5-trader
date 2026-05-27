import { pgTable, text, boolean, integer, bigint } from "drizzle-orm/pg-core";

// Per-user push notification preferences for zone TP alerts.
// One row per user; `expoPushToken` is the device token registered by the
// Expo client (null until the user opts in).
export const notificationPrefsTable = pgTable("notification_prefs", {
  userId:         text("user_id").primaryKey(),
  nearEnabled:    boolean("near_enabled").notNull().default(false),
  hitEnabled:     boolean("hit_enabled").notNull().default(false),
  thresholdPips:  integer("threshold_pips").notNull().default(3),
  expoPushToken:  text("expo_push_token"),
  updatedAt:      bigint("updated_at", { mode: "number" }).notNull().default(0),
});

export type NotificationPrefsRow = typeof notificationPrefsTable.$inferSelect;
