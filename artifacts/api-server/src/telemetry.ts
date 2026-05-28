const MAX_RING = 20;

export interface TradeFailEvent {
  ts: number;
  accountId: string;
  action: string;
  code: number;
  message: string;
  positionId: string | null;
}

export interface RateLimitEvent {
  ts: number;
  accountId: string;
}

const recentTradeFailures: TradeFailEvent[] = [];
const recentRateLimits: RateLimitEvent[] = [];

export function recordTradeFail(ev: TradeFailEvent): void {
  recentTradeFailures.push(ev);
  if (recentTradeFailures.length > MAX_RING) recentTradeFailures.shift();
}

export function recordRateLimit(ev: RateLimitEvent): void {
  recentRateLimits.push(ev);
  if (recentRateLimits.length > MAX_RING) recentRateLimits.shift();
}

export function getTelemetry(): {
  recentTradeFailures: TradeFailEvent[];
  recentRateLimits: RateLimitEvent[];
} {
  return {
    recentTradeFailures: [...recentTradeFailures],
    recentRateLimits: [...recentRateLimits],
  };
}
