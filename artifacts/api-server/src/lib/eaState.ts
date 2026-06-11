import type { LivePosition, PendingOrder, AccountInfo } from './execution/types';

export interface EaStateEntry {
  positions: LivePosition[];
  orders: PendingOrder[];
  accountInfo: AccountInfo;
  receivedAt: number;
}

const cache = new Map<string, EaStateEntry>();

// Track the last time /ea/poll was served for each account.
// Lets ensureReadyForAccount declare liveness even before the first state push.
const lastPollAt = new Map<string, number>();

export function recordEaPoll(accountId: string): void {
  lastPollAt.set(accountId, Date.now());
}

export function getLastEaPollAt(accountId: string): number {
  return lastPollAt.get(accountId) ?? 0;
}

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

// ── Terminal token registry ───────────────────────────────────────────────────
// Shared between ea.ts (auth) and mt5.ts (account registration) without a
// circular import. Keyed token → accountId.
const terminalTokens = new Map<string, string>();

export function initTerminalToken(token: string, accountId: string): void {
  terminalTokens.set(token, accountId);
}

export function resolveTerminalToken(token: string): string | undefined {
  return terminalTokens.get(token);
}

/** Re-point every registered token to a new accountId. Called when the user
 *  replaces their MT5 account so /ea/poll routes to the correct account. */
export function reregisterEaTerminalAccount(accountId: string): void {
  for (const token of terminalTokens.keys()) {
    terminalTokens.set(token, accountId);
  }
  console.log(`[ea-tokens] terminal token(s) re-pointed to account ${accountId}`);
}
