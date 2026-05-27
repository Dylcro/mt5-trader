import app from "./app";
import { pool } from "@workspace/db";
import { loadCascadeConfig, startAutoConnect, startConnectionWatchdog, loadZoneState, startZoneTpMonitor } from "./routes/mt5";

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

async function ensureTables(): Promise<void> {
  await pool.query(`
    ALTER TABLE cascade_config ADD COLUMN IF NOT EXISTS tp1_pips INTEGER NOT NULL DEFAULT 20;
    ALTER TABLE cascade_config ADD COLUMN IF NOT EXISTS tp2_pips INTEGER NOT NULL DEFAULT 50;
    ALTER TABLE cascade_config ADD COLUMN IF NOT EXISTS tp3_pips INTEGER NOT NULL DEFAULT 90;
  `);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cascade_zones (
      id            SERIAL PRIMARY KEY,
      zone_id       TEXT             NOT NULL UNIQUE,
      account_id    TEXT             NOT NULL,
      user_id       TEXT,
      direction     TEXT             NOT NULL,
      anchor_price  DOUBLE PRECISION NOT NULL,
      tp1_pips      DOUBLE PRECISION NOT NULL DEFAULT 20,
      tp2_pips      DOUBLE PRECISION NOT NULL DEFAULT 50,
      tp3_pips      DOUBLE PRECISION NOT NULL DEFAULT 90,
      tp1_hit       BOOLEAN          NOT NULL DEFAULT FALSE,
      tp2_hit       BOOLEAN          NOT NULL DEFAULT FALSE,
      tp3_hit       BOOLEAN          NOT NULL DEFAULT FALSE,
      status        TEXT             NOT NULL DEFAULT 'OPEN',
      created_at    BIGINT           NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cascade_zones_acct_status
      ON cascade_zones (account_id, status);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zone_positions (
      id           SERIAL PRIMARY KEY,
      zone_id      TEXT             NOT NULL,
      position_id  TEXT             NOT NULL,
      entry_price  DOUBLE PRECISION NOT NULL,
      volume       DOUBLE PRECISION NOT NULL,
      status       TEXT             NOT NULL DEFAULT 'OPEN',
      created_at   BIGINT           NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS zone_positions_zone_pos
      ON zone_positions (zone_id, position_id);
    CREATE INDEX IF NOT EXISTS zone_positions_zone_status
      ON zone_positions (zone_id, status);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zone_orders (
      id         SERIAL PRIMARY KEY,
      zone_id    TEXT   NOT NULL,
      order_id   TEXT   NOT NULL UNIQUE,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS zone_orders_zone ON zone_orders (zone_id);
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

  // Hydrate in-memory zone state from DB and start the 3 s TP monitor.
  await loadZoneState();
  startZoneTpMonitor();

}

main().catch((err) => {
  console.error("[startup]", err);
  process.exit(1);
});
