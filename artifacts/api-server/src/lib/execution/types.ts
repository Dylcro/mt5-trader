export interface LivePosition {
  id: string;
  openPrice: number;
  volume: number;
  type: string;
  symbol: string;
  magic?: number;
  comment?: string;
  stopLoss?: number;
  profit?: number;
}

export interface PendingOrder {
  id: string;
  comment?: string;
  magic?: number;
}

export interface AccountInfo {
  balance: number;
  equity: number;
  marginFree: number;
  currency?: string;
  leverage?: number;
}

export interface TradeResult {
  ok: boolean;
  numericCode: number;
  orderId?: string;
  positionId?: string;
  message?: string;
  httpStatus?: number;
}

export interface ExecutionAdapter {
  getPositions(): Promise<LivePosition[]>;
  getPendingOrders(): Promise<PendingOrder[]>;
  getAccountInfo(): Promise<AccountInfo>;
  placeMarketOrder(
    direction: 'buy' | 'sell',
    symbol: string,
    volume: number,
    sl?: number,
    tp?: number,
    opts?: { comment?: string; magic?: number },
  ): Promise<TradeResult>;
  placeLimitOrder(
    direction: 'buy' | 'sell',
    symbol: string,
    volume: number,
    openPrice: number,
    sl?: number,
    tp?: number,
    opts?: { comment?: string; magic?: number },
  ): Promise<TradeResult>;
  modifyPosition(
    positionId: string,
    params: { stopLoss?: number; takeProfit?: number; comment?: string; magic?: number },
  ): Promise<TradeResult>;
  closePositionPartial(positionId: string, volume: number): Promise<TradeResult>;
  closePositionFull(positionId: string): Promise<TradeResult>;
  cancelOrder(orderId: string): Promise<TradeResult>;
}

export class NotReadyError extends Error {
  constructor(msg = 'Server not ready — broker connection not yet synchronized') {
    super(msg);
    this.name = 'NotReadyError';
  }
}

export class CommandTimeoutError extends Error {
  constructor() {
    super('command sent — confirmation not received; check positions before retrying');
    this.name = 'CommandTimeoutError';
  }
}
