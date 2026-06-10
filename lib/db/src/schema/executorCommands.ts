import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

// Commands queued by the backend for the EA terminal to execute.
// type values: place_market | place_limit | modify_sl_tp | close_partial | close_full | cancel_order
// status values: pending | claimed | done | failed
export const executorCommandsTable = pgTable("executor_commands", {
  id:          text("id").primaryKey(),
  accountId:   text("account_id").notNull(),
  type:        text("type").notNull(),
  payload:     jsonb("payload").notNull(),
  status:      text("status").notNull().default("pending"),
  result:      jsonb("result"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt:   timestamp("claimed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type ExecutorCommandRow = typeof executorCommandsTable.$inferSelect;
