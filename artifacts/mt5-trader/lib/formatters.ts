import { currencySymbol, type DisplayCurrency } from "@/lib/displayCurrency";

const PIP = 0.1;
const MONEY_LOCALE = "en-GB";

function safeCurrencyFormat(
  n: number,
  currency: DisplayCurrency,
  decimals: number,
): string {
  const abs = Math.abs(n);
  if (!Number.isFinite(abs)) return "—";
  try {
    return new Intl.NumberFormat(MONEY_LOCALE, {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(abs);
  } catch {
    const sym = currencySymbol(currency);
    const text = abs.toLocaleString(MONEY_LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return `${sym}${text}`;
  }
}

export function formatPrice(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatMoney(
  n: number,
  opts?: { signed?: boolean; decimals?: number; currency?: DisplayCurrency },
): string {
  const currency = opts?.currency ?? "USD";
  const decimals = opts?.decimals ?? 2;
  if (!Number.isFinite(n)) return "—";
  const formatted = safeCurrencyFormat(n, currency, decimals);
  if (opts?.signed) {
    if (n >= 0) return `+${formatted}`;
    return `-${formatted}`;
  }
  if (n < 0) return `-${formatted}`;
  return formatted;
}

export function formatCompactMoney(n: number, currency: DisplayCurrency = "USD"): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1000) {
    const k = abs / 1000;
    try {
      const parts = new Intl.NumberFormat(MONEY_LOCALE, {
        style: "currency",
        currency,
        maximumFractionDigits: 1,
      }).formatToParts(k);
      const compact = parts
        .map((p) => (p.type === "integer" || p.type === "decimal" || p.type === "fraction"
          ? `${p.value}k`
          : p.value))
        .join("");
      return `${sign}${compact}`;
    } catch {
      const sym = currencySymbol(currency);
      return `${sign}${sym}${(k).toLocaleString(MONEY_LOCALE, { maximumFractionDigits: 1 })}k`;
    }
  }
  return formatMoney(n, { signed: true, decimals: abs >= 100 ? 0 : 2, currency });
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  }
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatHistoryDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function pipsFromEntry(
  direction: "buy" | "sell",
  entry: number,
  current: number,
): number {
  const raw = direction === "buy" ? (current - entry) / PIP : (entry - current) / PIP;
  return Math.round(raw * 10) / 10;
}
