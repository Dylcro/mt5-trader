import { Router, type Request, type Response, type IRouter } from "express";
import { getStreamHealth } from "./mt5";

const router: IRouter = Router();

router.get("/healthz", (_req: Request, res: Response) => {
  const health = getStreamHealth();
  if (!health.healthy) {
    res.status(503).json({
      status: "unhealthy",
      stale: health.accounts
        .filter(a => a.stale)
        .map(a => ({ accountId: a.accountId, silentForSec: a.silentForSec })),
      accounts: health.accounts,
    });
    return;
  }
  res.json({
    status: "ok",
    accounts: health.accounts,
  });
});

export default router;
