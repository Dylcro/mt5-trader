import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { handleEaStateSnapshot } from "./mt5";
import { setEaState, initTerminalToken, resolveTerminalToken, recordEaPoll } from "../lib/eaState";
import type { LivePosition, PendingOrder, AccountInfo } from "../lib/execution/types";

const router = Router();

// Seed the shared token registry from env vars at startup.
const _rawToken = process.env["EA_TERMINAL_TOKEN"];
const _rawAccount = process.env["EA_TERMINAL_ACCOUNT"];
if (_rawToken && _rawAccount) initTerminalToken(_rawToken, _rawAccount);

function resolveAccount(req: Request, res: Response): string | null {
  const token = req.headers["x-terminal-token"];
  if (typeof token !== "string" || !token) {
    console.warn(`[ea] missing X-Terminal-Token from ${req.ip}`);
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const accountId = resolveTerminalToken(token);
  if (!accountId) {
    console.warn(`[ea] invalid X-Terminal-Token from ${req.ip}`);
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return accountId;
}

// GET /ea/poll
// Atomically claims up to 5 oldest pending commands for the terminal's account.
// The EA should call this on a tight loop (e.g. every 250ms) when connected.
//
// curl -H "X-Terminal-Token: $EA_TERMINAL_TOKEN" https://<host>/ea/poll
router.get("/poll", async (req: Request, res: Response) => {
  const accountId = resolveAccount(req, res);
  if (!accountId) return;
  try {
    const { rows } = await pool.query<{ id: string; type: string; payload: unknown }>(`
      UPDATE executor_commands
         SET status = 'claimed', claimed_at = NOW()
       WHERE id IN (
         SELECT id FROM executor_commands
          WHERE account_id = $1 AND status = 'pending'
          ORDER BY created_at ASC
          LIMIT 5
       )
      RETURNING id, type, payload
    `, [accountId]);
    for (const row of rows) {
      console.log(`[ea] claimed command id=${row.id} type=${row.type} account=${accountId}`);
    }
    recordEaPoll(accountId);
    res.json({ serverTime: new Date().toISOString(), commands: rows });
  } catch (err) {
    console.error("[ea] poll error:", (err as Error).message);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /ea/result
// EA reports command outcome. Idempotent — results for already-settled commands
// are acknowledged (200) and ignored.
//
// curl -X POST -H "X-Terminal-Token: $EA_TERMINAL_TOKEN" \
//   -H "Content-Type: application/json" \
//   -d '{"commandId":"<uuid>","ok":true,"retcode":10009,"dealTicket":"12345"}' \
//   https://<host>/ea/result
router.post("/result", async (req: Request, res: Response) => {
  const accountId = resolveAccount(req, res);
  if (!accountId) return;
  const body = req.body as {
    commandId?: string;
    ok?: boolean;
    retcode?: number;
    dealTicket?: string | number;
    fillPrice?: number;
    message?: string;
  };
  if (!body.commandId) {
    res.status(400).json({ error: "commandId required" });
    return;
  }
  try {
    const status = body.ok ? "done" : "failed";
    const result = {
      ok: body.ok,
      retcode: body.retcode,
      dealTicket: body.dealTicket,
      fillPrice: body.fillPrice,
      message: body.message,
    };
    const { rowCount } = await pool.query(
      `UPDATE executor_commands
          SET status = $1, result = $2, completed_at = NOW()
        WHERE id = $3 AND account_id = $4 AND status IN ('pending', 'claimed')`,
      [status, JSON.stringify(result), body.commandId, accountId],
    );
    if ((rowCount ?? 0) === 0) {
      console.log(`[ea] result ignored (already settled or not found) id=${body.commandId}`);
    } else {
      console.log(`[ea] command ${status} id=${body.commandId} retcode=${body.retcode ?? "—"} account=${accountId}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[ea] result error:", (err as Error).message);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /ea/state
// Full position/order/account snapshot pushed by the EA terminal.
// Triggers zone evaluation immediately using the fresh data.
//
// EA payload shape (document here for the MQL5 brief):
//   positions[]: { ticket, symbol, type("buy"|"sell"), lots, openPrice, sl, tp, profit, magic, comment }
//   orders[]:    { ticket, symbol, type("buy_limit"|"sell_limit"|...), lots, openPrice, sl, tp, magic, comment }
//   account:     { balance, equity, marginFree }
//   terminalTime: ISO string
//
// curl -X POST -H "X-Terminal-Token: $EA_TERMINAL_TOKEN" \
//   -H "Content-Type: application/json" \
//   -d '{"positions":[{"ticket":123,"symbol":"XAUUSD","type":"buy","lots":0.01,"openPrice":2300,"sl":2280,"profit":5}],"orders":[],"account":{"balance":10000,"equity":10005,"marginFree":9800},"terminalTime":"2026-06-10T12:00:00Z"}' \
//   https://<host>/ea/state
router.post("/state", async (req: Request, res: Response) => {
  const accountId = resolveAccount(req, res);
  if (!accountId) return;
  const body = req.body as {
    positions?: Array<{
      ticket: string | number;
      symbol: string;
      type: string;      // "buy" | "sell"
      lots: number;
      openPrice: number;
      sl?: number;
      tp?: number;
      profit?: number;
      magic?: number;
      comment?: string;
    }>;
    orders?: Array<{
      ticket: string | number;
      symbol: string;
      type: string;      // "buy_limit" | "sell_limit" | "buy_stop" | "sell_stop"
      lots: number;
      openPrice: number; // limit/stop price
      sl?: number;
      tp?: number;
      magic?: number;
      comment?: string;
    }>;
    account?: { balance?: number; equity?: number; marginFree?: number; currency?: string; leverage?: number };
    price?: { symbol?: string; bid?: number; ask?: number };
    terminalTime?: string;
  };

  console.log(`[EA_STATE_DBG] symbol=${body.price?.symbol ?? "(none)"} bid=${body.price?.bid ?? "(none)"} ask=${body.price?.ask ?? "(none)"}`);

  // Only track positions/orders opened by this EA (magic 770001).
  // Other magic numbers belong to manual trades or third-party EAs.
  const EA_MAGIC = 770001;

  // Normalize into the same LivePosition shape MetaApi streaming produces.
  // Direction detection in the zone engine uses .includes("BUY") / .includes("SELL")
  // on the type field, so we map the EA's short form to the MetaApi token form.
  const positions: LivePosition[] = (body.positions ?? []).filter(p => p.magic === EA_MAGIC).map(p => ({
    id:        String(p.ticket),
    symbol:    p.symbol,
    type:      p.type.toUpperCase() === "BUY" ? "POSITION_TYPE_BUY" : "POSITION_TYPE_SELL",
    volume:    p.lots,
    openPrice: p.openPrice,
    stopLoss:  p.sl,
    profit:    p.profit,
    magic:     p.magic,
    comment:   p.comment,
  }));

  const orders: PendingOrder[] = (body.orders ?? []).filter(o => o.magic === EA_MAGIC).map(o => ({
    id:      String(o.ticket),
    comment: o.comment,
    magic:   o.magic,
  }));

  const accountInfo: AccountInfo = {
    balance:    Number(body.account?.balance ?? 0),
    equity:     Number(body.account?.equity ?? 0),
    marginFree: Number(body.account?.marginFree ?? 0),
    ...(body.account?.currency ? { currency: body.account.currency } : {}),
    ...(body.account?.leverage != null ? { leverage: Number(body.account.leverage) } : {}),
  };

  // Persist to in-memory cache (read by EaAdapter in commit 3).
  setEaState(accountId, positions, orders, accountInfo);

  // Feed through the existing zone-eval pipeline — same path as MetaApi streaming ticks.
  const price = (body.price?.bid != null && body.price?.ask != null)
    ? { bid: Number(body.price.bid), ask: Number(body.price.ask), symbol: body.price.symbol }
    : undefined;
  try {
    await handleEaStateSnapshot(accountId, positions, orders, price);
  } catch (err) {
    const e = err as Error;
    console.error(`[EA_STATE_DBG] snapshot threw: ${e.message}\n${e.stack ?? ""}`);
    throw err;
  }

  res.json({ ok: true });
});

export default router;
