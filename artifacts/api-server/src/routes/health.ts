import { Router, type Request, type Response, type IRouter } from "express";
import { getStreamHealth } from "./mt5";

const router: IRouter = Router();

router.get("/healthz", (_req: Request, res: Response) => {
  // Always 200 — EA stream freshness is an application metric, not a server
  // health indicator. Returning 503 here causes Railway to stop routing all
  // traffic, which prevents the EA from posting the very ticks that would
  // restore freshness (self-reinforcing outage cycle).
  const health = getStreamHealth();
  res.json({
    status: "ok",
    stream: health.healthy ? "fresh" : "stale",
    accounts: health.accounts,
  });
});

export default router;
