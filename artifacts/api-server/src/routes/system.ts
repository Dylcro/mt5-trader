import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getPlatformFlags, getTradingStatus } from "../lib/platformFlags";
import { getStreamHealth } from "./mt5";

const router: IRouter = Router();

/** Public — app checks before trading (no rebuild needed when flag flips). */
router.get("/status", (_req: Request, res: Response) => {
  const trading = getTradingStatus();
  const flags = getPlatformFlags();
  res.json({
    trading_enabled: trading.trading_enabled,
    message: trading.message,
    signups_open: flags.signupsOpen,
    invite_only: flags.inviteOnly,
    membership_cap: flags.membershipCap,
  });
});

/** Public health summary for admin inline panel (non-sensitive). */
router.get("/health", async (_req: Request, res: Response) => {
  let dbOk = false;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const streams = getStreamHealth();
  const metaConfigured = Boolean(process.env.METAAPI_TOKEN ?? process.env.META_API_TOKEN);
  res.json({
    backend: true,
    database: dbOk,
    metaapi_configured: metaConfigured,
    streams_healthy: streams.healthy,
    live_stream_count: streams.accounts.filter((a) => !a.stale).length,
  });
});

export default router;
