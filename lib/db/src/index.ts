import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep TCP connections alive so the DB server doesn't silently drop them.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  // Release idle connections after 30 s — well before the DB server's own
  // idle-connection timeout fires and sends a "terminating connection" kill.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  // Small pool: the server is I/O bound, not query-heavy.
  max: 5,
});

pool.on("error", (err) => {
  console.error("[db-pool] idle client error:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
