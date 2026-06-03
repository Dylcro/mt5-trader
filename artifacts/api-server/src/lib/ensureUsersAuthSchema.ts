import type pg from "pg";

/**
 * Align legacy `users` / `admin_settings` tables with email+password auth.
 * Production DBs may predate custom auth (Clerk-era columns, NOT NULL `password`, etc.).
 */
export async function ensureUsersAuthSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE admin_settings
      ADD COLUMN IF NOT EXISTS membership_cap INTEGER NOT NULL DEFAULT 20,
      ADD COLUMN IF NOT EXISTS invite_only BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS invite_code TEXT,
      ADD COLUMN IF NOT EXISTS signups_open BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS trading_paused BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS trading_pause_message TEXT NOT NULL DEFAULT 'Trading is temporarily paused — we''ll be back shortly.';
  `);

  await pool.query(`
    DO $migrate$
    DECLARE
      r RECORD;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password'
      ) THEN
        UPDATE users SET password_hash = password
        WHERE password_hash IS NULL AND password IS NOT NULL;
        ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'hashed_password'
      ) THEN
        UPDATE users SET password_hash = hashed_password
        WHERE password_hash IS NULL AND hashed_password IS NOT NULL;
        ALTER TABLE users ALTER COLUMN hashed_password DROP NOT NULL;
      END IF;

      -- Drop NOT NULL on legacy columns that block INSERT (full_name, password_hash, etc. are set by /register).
      FOR r IN
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND is_nullable = 'NO'
          AND column_default IS NULL
          AND column_name NOT IN ('id', 'email')
      LOOP
        EXECUTE format('ALTER TABLE users ALTER COLUMN %I DROP NOT NULL', r.column_name);
      END LOOP;
    END
    $migrate$;
  `);

  const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    ORDER BY ordinal_position
  `);
  console.log("[ensureTables] users columns:", rows.map((c) => `${c.column_name}(${c.is_nullable})`).join(", "));
}
