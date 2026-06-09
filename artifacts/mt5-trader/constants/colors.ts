// XAUUSD Trader — LIGHT THEME (simplified UI spec)

export const colors = {
  background: "#F0F2F5",
  card: "#FFFFFF",
  surface: "#F7F8FA",
  border: "rgba(0,0,0,0.07)",

  text: "#111827",
  textSecondary: "#6B7280",
  textMuted: "#6B7280",

  gold: "#C9892E",
  goldLight: "rgba(201,137,46,0.08)",
  goldBorder: "rgba(201,137,46,0.3)",
  goldDim: "#7A6228",
  navy: "#1A2B4A",

  buy: "#059669",
  buyLight: "rgba(5,150,105,0.08)",
  buyBorder: "rgba(5,150,105,0.25)",
  buyDim: "rgba(5,150,105,0.08)",
  buyButton: "#2563EB",
  sell: "#DC2626",
  sellLight: "rgba(220,38,38,0.08)",
  sellBorder: "rgba(220,38,38,0.25)",
  sellDim: "rgba(220,38,38,0.08)",

  success: "#059669",
  warning: "#C9892E",
  danger: "#DC2626",

  shadow: "rgba(0,0,0,0.06)",
  onDark: "#FFFFFF",
  onDarkMuted: "rgba(255,255,255,0.5)",

  tint: "#C9892E",
  tabIconDefault: "#9AA5B4",
  tabIconSelected: "#C9892E",

  appBg: "#F0F2F5",
  cardAlt: "#F9FAFB",
  teal: "#0E7490",
  tealBg: "rgba(14,116,144,0.08)",
  tealBdr: "rgba(14,116,144,0.3)",
  goldProgress: "#FDE68A",
  greenProgress: "#6EE7B7",
  specGold: "#C9892E",
  specGoldBg: "rgba(201,137,46,0.08)",
  specGoldBdr: "rgba(201,137,46,0.3)",
  specBuy: "#059669",
  specBuyBg: "rgba(5,150,105,0.08)",
  specSell: "#DC2626",
  specText: "#111827",
  specMuted: "#6B7280",
  specBorder: "rgba(0,0,0,0.07)",
} as const;

export type AppColors = typeof colors;

/** @deprecated Use `colors` — kept so existing `Colors.dark.*` imports stay valid */
const theme = colors;

export default {
  light: theme,
  dark: theme,
  gold: theme.gold,
};
