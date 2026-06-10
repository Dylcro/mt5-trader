import { pool } from "@workspace/db";

/**
 * Bootstrap an empty Postgres (e.g. fresh Railway) and apply additive migrations
 * on existing DBs (Replit). CREATE runs before any ALTER so startup never
 * crashes on missing relations.
 */
export async function ensureTables(): Promise<void> {
  console.log("[startup] ensuring database schema…");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      full_name     TEXT,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      locked        BOOLEAN NOT NULL DEFAULT FALSE,
      locked_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS stored_accounts (
      id                  SERIAL PRIMARY KEY,
      account_id          TEXT NOT NULL UNIQUE,
      region              TEXT NOT NULL DEFAULT 'london',
      stored_at           BIGINT,
      user_id             TEXT,
      mt5_login           TEXT,
      mt5_server          TEXT,
      execution_backend   TEXT NOT NULL DEFAULT 'metaapi'
    );

    CREATE TABLE IF NOT EXISTS cascade_config (
      id                    SERIAL PRIMARY KEY,
      account_id            TEXT NOT NULL DEFAULT '' UNIQUE,
      enabled               BOOLEAN NOT NULL DEFAULT FALSE,
      num_positions         INTEGER NOT NULL DEFAULT 3,
      pips_between          INTEGER NOT NULL DEFAULT 50,
      sl_pips               INTEGER NOT NULL DEFAULT 100,
      tp1_pips              INTEGER NOT NULL DEFAULT 20,
      tp2_pips              INTEGER NOT NULL DEFAULT 50,
      tp3_pips              INTEGER NOT NULL DEFAULT 90,
      tp4_pips              INTEGER NOT NULL DEFAULT 0,
      tp1_pct               INTEGER NOT NULL DEFAULT 25,
      tp2_pct               INTEGER NOT NULL DEFAULT 25,
      tp3_pct               INTEGER NOT NULL DEFAULT 25,
      tp4_pct               INTEGER NOT NULL DEFAULT 25,
      tp1_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      tp2_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      tp3_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      tp4_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      risk_free_pips        INTEGER NOT NULL DEFAULT -10,
      auto_be_at_tp         INTEGER NOT NULL DEFAULT 2,
      take_profit_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
      take_profit_pips      INTEGER NOT NULL DEFAULT 30,
      mt5_sl_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
      mt5_sl_num_positions  INTEGER NOT NULL DEFAULT 3,
      mt5_sl_pips           INTEGER NOT NULL DEFAULT 50
    );

    CREATE TABLE IF NOT EXISTS cascade_zones (
      id                  SERIAL PRIMARY KEY,
      zone_id             TEXT NOT NULL UNIQUE,
      account_id          TEXT NOT NULL,
      user_id             TEXT,
      direction           TEXT NOT NULL,
      anchor_price        DOUBLE PRECISION NOT NULL,
      tp1_pips            DOUBLE PRECISION DEFAULT 20,
      tp2_pips            DOUBLE PRECISION DEFAULT 50,
      tp3_pips            DOUBLE PRECISION DEFAULT 90,
      tp1_price           DOUBLE PRECISION,
      tp2_price           DOUBLE PRECISION,
      tp3_price           DOUBLE PRECISION,
      tp4_price           DOUBLE PRECISION,
      original_volume     DOUBLE PRECISION,
      tp1_pct             DOUBLE PRECISION NOT NULL DEFAULT 25,
      tp2_pct             DOUBLE PRECISION NOT NULL DEFAULT 25,
      tp3_pct             DOUBLE PRECISION NOT NULL DEFAULT 25,
      tp4_pct             DOUBLE PRECISION NOT NULL DEFAULT 25,
      tp1_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      tp2_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      tp3_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      tp4_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      cashout_pips        DOUBLE PRECISION NOT NULL DEFAULT 5,
      cashout_done        BOOLEAN NOT NULL DEFAULT FALSE,
      tp1_hit             BOOLEAN NOT NULL DEFAULT FALSE,
      tp2_hit             BOOLEAN NOT NULL DEFAULT FALSE,
      tp3_hit             BOOLEAN NOT NULL DEFAULT FALSE,
      tp4_hit             BOOLEAN NOT NULL DEFAULT FALSE,
      manual_close        BOOLEAN NOT NULL DEFAULT FALSE,
      sl_hit              BOOLEAN NOT NULL DEFAULT FALSE,
      went_risk_free      BOOLEAN NOT NULL DEFAULT FALSE,
      risk_free_sl_exit   BOOLEAN NOT NULL DEFAULT FALSE,
      risk_free_offset    INTEGER NOT NULL DEFAULT 0,
      tp2_sl_is_best_effort BOOLEAN NOT NULL DEFAULT FALSE,
      auto_be_at_tp       DOUBLE PRECISION NOT NULL DEFAULT 2,
      status              TEXT NOT NULL DEFAULT 'OPEN',
      created_at          BIGINT NOT NULL,
      closed_at           BIGINT,
      closed_pnl          DOUBLE PRECISION,
      runner1_price       DOUBLE PRECISION,
      runner1_lots        DOUBLE PRECISION,
      runner2_price       DOUBLE PRECISION,
      runner2_lots        DOUBLE PRECISION,
      runner3_price       DOUBLE PRECISION,
      runner3_lots        DOUBLE PRECISION,
      runner1_hit         BOOLEAN NOT NULL DEFAULT FALSE,
      runner2_hit         BOOLEAN NOT NULL DEFAULT FALSE,
      runner3_hit         BOOLEAN NOT NULL DEFAULT FALSE,
      runner1_auto        BOOLEAN NOT NULL DEFAULT FALSE,
      runner2_auto        BOOLEAN NOT NULL DEFAULT FALSE,
      runner3_auto        BOOLEAN NOT NULL DEFAULT FALSE,
      runner_active       BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS cascade_zones_acct_status
      ON cascade_zones (account_id, status);

    CREATE TABLE IF NOT EXISTS zone_positions (
      id           SERIAL PRIMARY KEY,
      zone_id      TEXT NOT NULL,
      position_id  TEXT NOT NULL,
      entry_price  DOUBLE PRECISION NOT NULL,
      volume       DOUBLE PRECISION NOT NULL,
      status       TEXT NOT NULL DEFAULT 'OPEN',
      created_at   BIGINT NOT NULL,
      tp1_hit      BOOLEAN NOT NULL DEFAULT FALSE,
      tp2_hit      BOOLEAN NOT NULL DEFAULT FALSE,
      tp3_hit      BOOLEAN NOT NULL DEFAULT FALSE,
      tp4_hit      BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS zone_positions_zone_pos
      ON zone_positions (zone_id, position_id);
    CREATE INDEX IF NOT EXISTS zone_positions_zone_status
      ON zone_positions (zone_id, status);

    CREATE TABLE IF NOT EXISTS zone_orders (
      id         SERIAL PRIMARY KEY,
      zone_id    TEXT NOT NULL,
      order_id   TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS zone_orders_zone ON zone_orders (zone_id);

    CREATE TABLE IF NOT EXISTS cascade_history (
      id          SERIAL PRIMARY KEY,
      account_id  TEXT NOT NULL,
      position_id TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cascade_history_acct_pos
      ON cascade_history (account_id, position_id);

    CREATE TABLE IF NOT EXISTS cascade_orders (
      id          SERIAL PRIMARY KEY,
      account_id  TEXT NOT NULL,
      order_id    TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS cascade_orders_acct_ord
      ON cascade_orders (account_id, order_id);
    CREATE INDEX IF NOT EXISTS cascade_orders_acct_created
      ON cascade_orders (account_id, created_at);

    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id         TEXT PRIMARY KEY,
      near_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
      hit_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
      threshold_pips  INTEGER NOT NULL DEFAULT 3,
      expo_push_token TEXT,
      updated_at      BIGINT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS admin_settings (
      id SERIAL PRIMARY KEY,
      membership_cap INTEGER NOT NULL DEFAULT 20,
      invite_only BOOLEAN NOT NULL DEFAULT FALSE,
      invite_code TEXT,
      signups_open BOOLEAN NOT NULL DEFAULT TRUE,
      trading_paused BOOLEAN NOT NULL DEFAULT FALSE,
      trading_pause_message TEXT NOT NULL DEFAULT 'Trading is temporarily paused — we''ll be back shortly.'
    );

    CREATE TABLE IF NOT EXISTS waitlist (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id             SERIAL PRIMARY KEY,
      name           TEXT NOT NULL,
      email          TEXT,
      account_number TEXT,
      query          TEXT NOT NULL,
      created_at     BIGINT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'unread'
    );
  `);

  // Additive migrations for DBs created before the full bootstrap above.
  await pool.query(`
    ALTER TABLE cascade_config
      ADD COLUMN IF NOT EXISTS tp1_pips INTEGER NOT NULL DEFAULT 20,
      ADD COLUMN IF NOT EXISTS tp2_pips INTEGER NOT NULL DEFAULT 50,
      ADD COLUMN IF NOT EXISTS tp3_pips INTEGER NOT NULL DEFAULT 90,
      ADD COLUMN IF NOT EXISTS tp4_pips INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tp1_pct INTEGER NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS tp2_pct INTEGER NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS tp3_pct INTEGER NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS tp4_pct INTEGER NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS tp1_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS tp2_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS tp3_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS tp4_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS risk_free_pips INTEGER NOT NULL DEFAULT -10,
      ADD COLUMN IF NOT EXISTS auto_be_at_tp INTEGER NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS take_profit_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS take_profit_pips INTEGER NOT NULL DEFAULT 30,
      ADD COLUMN IF NOT EXISTS mt5_sl_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS mt5_sl_num_positions INTEGER NOT NULL DEFAULT 3,
      ADD COLUMN IF NOT EXISTS mt5_sl_pips INTEGER NOT NULL DEFAULT 50;

    ALTER TABLE stored_accounts
      ADD COLUMN IF NOT EXISTS mt5_login TEXT,
      ADD COLUMN IF NOT EXISTS mt5_server TEXT,
      ADD COLUMN IF NOT EXISTS execution_backend TEXT NOT NULL DEFAULT 'metaapi';

    ALTER TABLE cascade_zones
      ADD COLUMN IF NOT EXISTS closed_at BIGINT,
      ADD COLUMN IF NOT EXISTS tp1_price DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS tp2_price DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS tp3_price DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS tp4_price DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS tp4_hit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS original_volume DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS tp1_pct DOUBLE PRECISION NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS tp2_pct DOUBLE PRECISION NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS tp3_pct DOUBLE PRECISION NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS tp4_pct DOUBLE PRECISION NOT NULL DEFAULT 25,
      ADD COLUMN IF NOT EXISTS cashout_pips DOUBLE PRECISION NOT NULL DEFAULT 5,
      ADD COLUMN IF NOT EXISTS cashout_done BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS tp2_sl_is_best_effort BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS tp1_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS tp2_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS tp3_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS tp4_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS closed_pnl DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS manual_close BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS sl_hit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS went_risk_free BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS risk_free_sl_exit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS risk_free_offset INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS auto_be_at_tp DOUBLE PRECISION NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS runner1_price DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS runner1_lots DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS runner2_price DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS runner2_lots DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS runner3_price DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS runner3_lots DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS runner1_hit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS runner2_hit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS runner3_hit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS runner_active BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE zone_positions
      ADD COLUMN IF NOT EXISTS tp1_hit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS tp2_hit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS tp3_hit BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS tp4_hit BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS full_name TEXT,
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS password_hash TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS locked_reason TEXT;

    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unread';

    ALTER TABLE cascade_zones ALTER COLUMN tp1_pips DROP NOT NULL;
    ALTER TABLE cascade_zones ALTER COLUMN tp2_pips DROP NOT NULL;
    ALTER TABLE cascade_zones ALTER COLUMN tp3_pips DROP NOT NULL;
  `);

  console.log("[startup] database schema ready");
}
