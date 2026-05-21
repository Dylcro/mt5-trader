import app from "./app";
import { pool } from "@workspace/db";
import { loadCascadeConfig, startAutoConnect, startConnectionWatchdog, startAutoSlSafetyNet } from "./routes/mt5";

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

async function ensureTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id            SERIAL PRIMARY KEY,
      name          TEXT    NOT NULL,
      account_number TEXT,
      query         TEXT    NOT NULL,
      created_at    BIGINT  NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cascade_history (
      id          SERIAL PRIMARY KEY,
      account_id  TEXT   NOT NULL,
      position_id TEXT   NOT NULL,
      created_at  BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cascade_history_acct_pos
      ON cascade_history (account_id, position_id);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cascade_orders (
      id          SERIAL PRIMARY KEY,
      account_id  TEXT   NOT NULL,
      order_id    TEXT   NOT NULL,
      created_at  BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cascade_orders_acct_ord
      ON cascade_orders (account_id, order_id);
    CREATE INDEX IF NOT EXISTS cascade_orders_acct_created
      ON cascade_orders (account_id, created_at);
  `);
}

async function main() {
  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  await ensureTables();

  // Load persisted cascade config from the database before accepting requests
  // so that GET /cascade-config never returns stale defaults on a fresh start.
  await loadCascadeConfig();

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  // Reconnect all previously-seen MT5 accounts so auto-cascade works
  // immediately on startup — even when the app / phone is off.
  await startAutoConnect();

  // Watchdog: every 30 s, reconnect any account whose stream has dropped.
  startConnectionWatchdog();

  // Safety net: every 30 s, scan open positions via REST and apply SL to any
  // XAUUSD position that's still naked. Independent of the streaming feed, so
  // auto-SL keeps working even when MetaAPI sync is slow, stuck, or recovering.
  startAutoSlSafetyNet();
}

main().catch((err) => {
  console.error("[startup]", err);
  process.exit(1);
});
