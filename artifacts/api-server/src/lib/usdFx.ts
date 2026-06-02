/**
 * Convert USD-denominated amounts (e.g. XAUUSD risk) to account/display currency
 * using live FX quotes from MetaAPI on the connected MT5 account.
 */

const rateCache = new Map<string, { rate: number; expiresAt: number }>();
const CACHE_MS = 60_000;

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
  const direct = await fetchSymbolMid(token, region, accountId, `USD${currency}`, fetchPrice);
  if (direct != null && direct > 0) {
    rate = direct;
  } else {
    const inverse = await fetchSymbolMid(token, region, accountId, `${currency}USD`, fetchPrice);
    if (inverse != null && inverse > 0) rate = 1 / inverse;
  }

  rateCache.set(cacheKey, { rate, expiresAt: Date.now() + CACHE_MS });
  return { rate, currency };
}

export function convertUsdAmount(usd: number, rate: number): number {
  if (!Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0) return usd;
  return usd * rate;
}
