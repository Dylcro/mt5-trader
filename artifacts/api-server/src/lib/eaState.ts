import type { LivePosition, PendingOrder, AccountInfo } from './execution/types';

export interface EaStateEntry {
  positions: LivePosition[];
  orders: PendingOrder[];
  accountInfo: AccountInfo;
  receivedAt: number;
}

const cache = new Map<string, EaStateEntry>();

export function setEaState(
  accountId: string,
  positions: LivePosition[],
  orders: PendingOrder[],
  accountInfo: AccountInfo,
): void {
  cache.set(accountId, { positions, orders, accountInfo, receivedAt: Date.now() });
}

export function getEaState(accountId: string): EaStateEntry | undefined {
  return cache.get(accountId);
}

export function isEaAccount(accountId: string): boolean {
  return cache.has(accountId);
}
