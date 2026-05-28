type AccountEventHandler = (type: string, data: unknown) => void;
const bus = new Map<string, Set<AccountEventHandler>>();

export function subscribeAccountEvents(
  accountId: string,
  handler: AccountEventHandler,
): () => void {
  if (!bus.has(accountId)) bus.set(accountId, new Set());
  bus.get(accountId)!.add(handler);
  return () => {
    bus.get(accountId)?.delete(handler);
    if (!bus.get(accountId)?.size) bus.delete(accountId);
  };
}

export function emitAccountEvent(accountId: string, type: string, data: unknown): void {
  bus.get(accountId)?.forEach(h => {
    try { h(type, data); } catch {}
  });
}
