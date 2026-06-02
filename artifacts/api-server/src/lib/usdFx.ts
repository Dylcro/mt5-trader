/**
 * Convert USD-denominated amounts (e.g. XAUUSD risk) to account/display currency
 * using live FX quotes from MetaAPI on the connected MT5 account.
 */

const rateCache = new Map<string, { rate: number; expiresAt: number }>();
const CACHE_MS = 60_000;

/** Majors usually quoted as {CCY}USD on MT5 (e.g. GBPUSD), not USDGBP. */
const PREFER_INVERSE_PAIR = new Set(["GBP", "EUR", "AUD", "NZD", "CHF", "CAD"]);

async function fetchSymbolMid(
  token: string,
  region: string,
  accountId: string,
  symbol: string,
  fetchPrice: (t: string, r: string, a: string, s: string) => Promise<{ bid: number; ask: number } | null>,
): Promise<number | null> {
  const px = await fetchPrice(token, region, accountId, symbol);
  if (!px || px.bid <= 0 || px.ask <= 0) return null;
  return (px.bid + px.ask) / 2;
}

/** Reject gold ticks (~2600) or other garbage returned when a forex symbol is missing. */
export function isPlausibleUsdFxRate(currency: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  const c = currency.toUpperCase();
  if (c === "JPY") return rate >= 50 && rate <= 300;
  if (PREFER_INVERSE_PAIR.has(c)) return rate >= 0.25 && rate <= 2.5;
  return rate >= 0.01 && rate <= 500;
}

/** How many units of `target` currency equal 1 USD. */
export async function usdToTargetRate(
  token: string,
  region: string,
  accountId: string,
  target: string,
  fetchPrice: (t: string, r: string, a: string, s: string) => Promise<{ bid: number; ask: number } | null>,
): Promise<{ rate: number; currency: string }> {
  const currency = target.toUpperCase().trim();
  if (currency === "USD") return { rate: 1, currency: "USD" };

  const cacheKey = `${accountId}:${currency}`;
  const hit = rateCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return { rate: hit.rate, currency };

  let rate = 1;

  const tryDirect = async (): Promise<number | null> => {
    const mid = await fetchSymbolMid(token, region, accountId, `USD${currency}`, fetchPrice);
    return mid != null && isPlausibleUsdFxRate(currency, mid) ? mid : null;
  };

  const tryInverse = async (): Promise<number | null> => {
    const mid = await fetchSymbolMid(token, region, accountId, `${currency}USD`, fetchPrice);
    if (mid == null || mid <= 0) return null;
    const inverted = 1 / mid;
    return isPlausibleUsdFxRate(currency, inverted) ? inverted : null;
  };

  if (PREFER_INVERSE_PAIR.has(currency)) {
    rate = (await tryInverse()) ?? (await tryDirect()) ?? 1;
  } else {
    rate = (await tryDirect()) ?? (await tryInverse()) ?? 1;
  }

  rateCache.set(cacheKey, { rate, expiresAt: Date.now() + CACHE_MS });
  return { rate, currency };
}

export function convertUsdAmount(usd: number, rate: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0) return usd;
  return usd * rate;
}
