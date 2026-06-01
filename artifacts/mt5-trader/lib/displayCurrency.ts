export type DisplayCurrency = "USD" | "GBP" | "EUR";

export const DISPLAY_CURRENCY_STORAGE_KEY = "display_currency_v1";

export const DISPLAY_CURRENCY_OPTIONS: {
  code: DisplayCurrency;
  label: string;
  symbol: string;
}[] = [
  { code: "USD", label: "USD ($)", symbol: "$" },
  { code: "GBP", label: "GBP (£)", symbol: "£" },
  { code: "EUR", label: "EUR (€)", symbol: "€" },
];

export function normalizeDisplayCurrency(raw?: string | null): DisplayCurrency {
  const u = (raw ?? "USD").toUpperCase().trim();
  if (u === "GBP" || u === "GBX" || u.startsWith("GB")) return "GBP";
  if (u === "EUR" || u.startsWith("EU")) return "EUR";
  return "USD";
}

export function currencySymbol(currency: DisplayCurrency): string {
  return DISPLAY_CURRENCY_OPTIONS.find((o) => o.code === currency)?.symbol ?? "$";
}
