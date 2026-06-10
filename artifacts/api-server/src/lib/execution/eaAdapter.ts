import { randomUUID } from "crypto";
import { pool } from "@workspace/db";
import {
  type ExecutionAdapter, type LivePosition, type PendingOrder,
  type AccountInfo, type TradeResult,
  NotReadyError, CommandTimeoutError,
} from "./types";
import { getEaState } from "../eaState";

const EA_STATE_MAX_AGE_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const MARKET_TIMEOUT_MS = 10_000;
const LIMIT_TIMEOUT_MS = 15_000;

export class EaAdapter implements ExecutionAdapter {
  constructor(private readonly accountId: string) {}

  private freshState() {
    const entry = getEaState(this.accountId);
    if (!entry || Date.now() - entry.receivedAt > EA_STATE_MAX_AGE_MS) {
      throw new NotReadyError("EA terminal state is absent or stale (>5 s old)");
    }
    return entry;
  }

  async getPositions(): Promise<LivePosition[]> { return this.freshState().positions; }
  async getPendingOrders(): Promise<PendingOrder[]> { return this.freshState().orders; }
  async getAccountInfo(): Promise<AccountInfo> { return this.freshState().accountInfo; }

  private async enqueue(type: string, payload: unknown, timeoutMs: number): Promise<TradeResult> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO executor_commands (id, account_id, type, payload) VALUES ($1, $2, $3, $4)`,
      [id, this.accountId, type, JSON.stringify(payload)],
    );
    console.log(`[ea-adapter] enqueued id=${id} type=${type} account=${this.accountId}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
      const { rows } = await pool.query<{ status: string; result: unknown }>(
        `SELECT status, result FROM executor_commands WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new Error(`[ea-adapter] command ${id} disappeared from DB`);
      if (row.status === "done" || row.status === "failed") {
        const r = row.result as {
          ok?: boolean; retcode?: number;
          dealTicket?: string | number; message?: string;
        } | null;
        console.log(`[ea-adapter] ${row.status} id=${id} retcode=${r?.retcode ?? "—"}`);
        return {
          ok: r?.ok ?? row.status === "done",
          numericCode: r?.retcode ?? 0,
          orderId:  r?.dealTicket !== undefined ? String(r.dealTicket) : undefined,
          message:  r?.message,
        };
      }
    }
    // Timed out — tombstone the command so the sweeper ignores it.
    await pool.query(
      `UPDATE executor_commands
          SET status = 'failed', result = $1, completed_at = NOW()
        WHERE id = $2 AND status IN ('pending', 'claimed')`,
      [JSON.stringify({ ok: false, message: "client-side timeout: confirmation not received" }), id],
    );
    console.warn(`[ea-adapter] timeout id=${id} type=${type} after ${timeoutMs} ms`);
    throw new CommandTimeoutError();
  }

  async placeMarketOrder(
    direction: "buy" | "sell", symbol: string, volume: number,
    sl?: number, tp?: number, opts?: { comment?: string; magic?: number },
  ): Promise<TradeResult> {
    return this.enqueue("place_market", { direction, symbol, volume, sl, tp, ...opts }, MARKET_TIMEOUT_MS);
  }

  async placeLimitOrder(
    direction: "buy" | "sell", symbol: string, volume: number, openPrice: number,
    sl?: number, tp?: number, opts?: { comment?: string; magic?: number },
  ): Promise<TradeResult> {
    return this.enqueue("place_limit", { direction, symbol, volume, openPrice, sl, tp, ...opts }, LIMIT_TIMEOUT_MS);
  }

  async modifyPosition(
    positionId: string,
    params: { stopLoss?: number; takeProfit?: number; comment?: string; magic?: number },
  ): Promise<TradeResult> {
    return this.enqueue("modify_sl_tp", { positionId, ...params }, MARKET_TIMEOUT_MS);
  }

  async closePositionPartial(positionId: string, volume: number): Promise<TradeResult> {
    return this.enqueue("close_partial", { positionId, volume }, MARKET_TIMEOUT_MS);
  }

  async closePositionFull(positionId: string): Promise<TradeResult> {
    return this.enqueue("close_full", { positionId }, MARKET_TIMEOUT_MS);
  }

  async cancelOrder(orderId: string): Promise<TradeResult> {
    return this.enqueue("cancel_order", { orderId }, MARKET_TIMEOUT_MS);
  }
}

// Runs every 30 s. Commands still pending/claimed after 60 s mean the terminal
// stopped polling — mark them failed so EaAdapter waiters get unblocked on
// their next DB check and throw CommandTimeoutError.
export function startEaCommandSweeper(): void {
  setInterval(async () => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE executor_commands
            SET status = 'failed',
                result = '{"ok":false,"message":"terminal not polling"}',
                completed_at = NOW()
          WHERE status IN ('pending', 'claimed')
            AND created_at < NOW() - INTERVAL '60 seconds'`,
      );
      if ((rowCount ?? 0) > 0) {
        console.warn(`[ea-sweeper] marked ${rowCount} stale command(s) failed — terminal not polling`);
      }
    } catch (err) {
      console.error("[ea-sweeper] error:", (err as Error).message);
    }
  }, 30_000);
}
