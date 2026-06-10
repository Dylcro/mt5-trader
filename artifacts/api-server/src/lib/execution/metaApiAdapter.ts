import type { ExecutionAdapter, LivePosition, PendingOrder, AccountInfo, TradeResult } from './types';

const CLIENT_DOMAIN = 'agiliumtrade.ai';
const TRADE_SUCCESS_CODES = new Set([10008, 10009, 10010]);
const CANCEL_IDEMPOTENT_CODES = new Set([10036, 4754]);

function normalizeRegion(region: string): string {
  if (!region) return 'london';
  if (!region.includes('.')) return region;
  const m = region.match(/^mt-client-api-v1\.(.+?)\.agiliumtrade\.ai$/);
  return m?.[1] ?? region;
}

function isPricePassedError(code: number, message?: string): boolean {
  const msg = (message ?? '').toLowerCase();
  return code === 10006 || code === 10014 || code === 10020 || code === 10021
    || msg.includes('invalid') || msg.includes('price')
    || msg.includes('off quotes') || msg.includes('trade disabled');
}

export interface MetaApiAdapterOptions {
  accountId: string;
  getToken: () => string;
  getRegion: () => string;
  getConnection: () => unknown;
}

export class MetaApiAdapter implements ExecutionAdapter {
  private readonly accountId: string;
  private readonly getToken: () => string;
  private readonly getRegion: () => string;
  private readonly getConnection: () => unknown;

  constructor(opts: MetaApiAdapterOptions) {
    this.accountId = opts.accountId;
    this.getToken = opts.getToken;
    this.getRegion = opts.getRegion;
    this.getConnection = opts.getConnection;
  }

  private baseUrl(): string {
    const r = normalizeRegion(this.getRegion());
    return `https://mt-client-api-v1.${r}.${CLIENT_DOMAIN}/users/current/accounts/${this.accountId}`;
  }

  private headers(): Record<string, string> {
    return { 'auth-token': this.getToken(), 'Content-Type': 'application/json' };
  }

  private async execRest(body: Record<string, unknown>): Promise<TradeResult> {
    const res = await fetch(`${this.baseUrl()}/trade`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as {
      numericCode?: number; message?: string; orderId?: string; positionId?: string;
    };
    const numericCode = data.numericCode ?? 0;
    return {
      ok: res.ok && TRADE_SUCCESS_CODES.has(numericCode),
      numericCode,
      orderId: data.orderId,
      positionId: data.positionId,
      message: data.message,
      httpStatus: res.ok ? 200 : res.status,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async tradeViaConn(conn: any, body: Record<string, unknown>): Promise<any> {
    const { actionType, symbol, volume, stopLoss, takeProfit, openPrice, comment, orderId } = body;
    const opts = { comment: comment as string | undefined };
    switch (actionType) {
      case 'ORDER_TYPE_BUY':
        return conn.createMarketBuyOrder(symbol, volume, stopLoss ?? undefined, takeProfit ?? undefined, opts);
      case 'ORDER_TYPE_SELL':
        return conn.createMarketSellOrder(symbol, volume, stopLoss ?? undefined, takeProfit ?? undefined, opts);
      case 'ORDER_TYPE_BUY_LIMIT':
        return conn.createLimitBuyOrder(symbol, volume, openPrice, stopLoss ?? undefined, takeProfit ?? undefined, opts);
      case 'ORDER_TYPE_SELL_LIMIT':
        return conn.createLimitSellOrder(symbol, volume, openPrice, stopLoss ?? undefined, takeProfit ?? undefined, opts);
      case 'ORDER_CANCEL':
        return conn.cancelOrder(orderId as string);
      default:
        throw new Error(`Unknown actionType: ${String(actionType)}`);
    }
  }

  private async execSdkOrRest(body: Record<string, unknown>): Promise<TradeResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = this.getConnection() as any;
    if (conn) {
      try {
        const sdkResp = await this.tradeViaConn(conn, body);
        const numericCode = sdkResp?.numericCode ?? 0;
        return {
          ok: TRADE_SUCCESS_CODES.has(numericCode),
          numericCode,
          orderId: sdkResp?.orderId,
          positionId: sdkResp?.positionId,
          message: sdkResp?.message,
          httpStatus: 200,
        };
      } catch {
        return this.execRest(body);
      }
    }
    return this.execRest(body);
  }

  async placeMarketOrder(
    direction: 'buy' | 'sell',
    symbol: string,
    volume: number,
    sl?: number,
    tp?: number,
    opts?: { comment?: string; magic?: number },
  ): Promise<TradeResult> {
    const body: Record<string, unknown> = {
      actionType: direction === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
      symbol, volume,
      ...(sl !== undefined && { stopLoss: sl }),
      ...(tp !== undefined && { takeProfit: tp }),
      ...(opts?.comment !== undefined && { comment: opts.comment }),
      ...(opts?.magic !== undefined && { magic: opts.magic }),
    };
    return this.execSdkOrRest(body);
  }

  async placeLimitOrder(
    direction: 'buy' | 'sell',
    symbol: string,
    volume: number,
    openPrice: number,
    sl?: number,
    tp?: number,
    opts?: { comment?: string; magic?: number },
  ): Promise<TradeResult> {
    const body: Record<string, unknown> = {
      actionType: direction === 'buy' ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_SELL_LIMIT',
      symbol, volume, openPrice,
      ...(sl !== undefined && { stopLoss: sl }),
      ...(tp !== undefined && { takeProfit: tp }),
      ...(opts?.comment !== undefined && { comment: opts.comment }),
      ...(opts?.magic !== undefined && { magic: opts.magic }),
    };
    let r = await this.execSdkOrRest(body);
    if (!r.ok && isPricePassedError(r.numericCode, r.message)) {
      const marketType = direction === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
      console.log(`[MetaApiAdapter] limit at ${openPrice} passed through, placing market`);
      const marketBody: Record<string, unknown> = { ...body, actionType: marketType };
      delete marketBody['openPrice'];
      r = await this.execSdkOrRest(marketBody);
    }
    return r;
  }

  async modifyPosition(
    positionId: string,
    params: { stopLoss?: number; takeProfit?: number; comment?: string; magic?: number },
  ): Promise<TradeResult> {
    const body: Record<string, unknown> = {
      actionType: 'POSITION_MODIFY', positionId,
      ...(params.stopLoss !== undefined && { stopLoss: params.stopLoss }),
      ...(params.takeProfit !== undefined && { takeProfit: params.takeProfit }),
      ...(params.comment !== undefined && { comment: params.comment }),
      ...(params.magic !== undefined && { magic: params.magic }),
    };
    return this.execRest(body);
  }

  async closePositionPartial(positionId: string, volume: number): Promise<TradeResult> {
    return this.execRest({ actionType: 'POSITION_PARTIAL', positionId, volume });
  }

  async closePositionFull(positionId: string): Promise<TradeResult> {
    return this.execRest({ actionType: 'POSITION_CLOSE_ID', positionId });
  }

  async cancelOrder(orderId: string): Promise<TradeResult> {
    const r = await this.execRest({ actionType: 'ORDER_CANCEL', orderId });
    if (CANCEL_IDEMPOTENT_CODES.has(r.numericCode)) return { ...r, ok: true };
    return r;
  }

  async getPositions(): Promise<LivePosition[]> {
    const res = await fetch(`${this.baseUrl()}/positions`, { headers: this.headers() });
    if (!res.ok) return [];
    const raw = await res.json() as Array<{
      id?: string; _id?: string; openPrice?: number; volume?: number; type?: string;
      symbol?: string; magic?: number; comment?: string; stopLoss?: number; profit?: number;
    }>;
    return raw
      .map(p => ({
        id: String(p.id ?? p._id ?? ''),
        openPrice: Number(p.openPrice ?? 0),
        volume: Number(p.volume ?? 0),
        type: String(p.type ?? ''),
        symbol: String(p.symbol ?? ''),
        magic: p.magic,
        comment: p.comment,
        stopLoss: p.stopLoss,
        profit: p.profit,
      }))
      .filter(p => p.id);
  }

  async getPendingOrders(): Promise<PendingOrder[]> {
    const res = await fetch(`${this.baseUrl()}/orders`, { headers: this.headers() });
    if (!res.ok) return [];
    const raw = await res.json() as Array<{ id?: string; _id?: string; comment?: string; magic?: number }>;
    return raw
      .map(o => ({ id: String(o.id ?? o._id ?? ''), comment: o.comment, magic: o.magic }))
      .filter(o => o.id);
  }

  async getAccountInfo(): Promise<AccountInfo> {
    const res = await fetch(`${this.baseUrl()}/account-information`, { headers: this.headers() });
    if (!res.ok) throw new Error(`getAccountInfo HTTP ${res.status}`);
    const raw = await res.json() as { balance?: number; equity?: number; freeMargin?: number; marginFree?: number };
    return {
      balance: Number(raw.balance ?? 0),
      equity: Number(raw.equity ?? 0),
      marginFree: Number(raw.freeMargin ?? raw.marginFree ?? 0),
    };
  }
}
