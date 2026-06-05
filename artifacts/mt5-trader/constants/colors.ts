// XAUUSD Trader — LIGHT THEME (default for light + dark keys in app)

export const colors = {
  background: "#F0F2F5",
  card: "#FFFFFF",
  surface: "#F7F8FA",
  border: "#E4E8EE",

  text: "#0D1421",
  textSecondary: "#4A5568",
  textMuted: "#9AA5B4",

  gold: "#B8922A",
  goldLight: "rgba(184,146,42,0.10)",
  goldBorder: "rgba(184,146,42,0.25)",
  goldDim: "#7A6228",
  navy: "#1A2B4A",

  buy: "#0BAD6B",
  buyLight: "rgba(11,173,107,0.10)",
  buyBorder: "rgba(11,173,107,0.25)",
  buyDim: "rgba(11,173,107,0.10)",
  sell: "#E03450",
  sellLight: "rgba(224,52,80,0.08)",
  sellBorder: "rgba(224,52,80,0.25)",
  sellDim: "rgba(224,52,80,0.08)",

  success: "#0BAD6B",
  warning: "#B8922A",
  danger: "#E03450",

  shadow: "rgba(0,0,0,0.06)",
  onDark: "#FFFFFF",
  onDarkMuted: "rgba(255,255,255,0.5)",

  tint: "#B8922A",
  tabIconDefault: "#9AA5B4",
  tabIconSelected: "#B8922A",

  // Visual spec (zone card redesign)
  appBg: "#ECEEF5",
  cardAlt: "#F9FAFB",
  teal: "#0E7490",
  tealBg: "rgba(14,116,144,0.08)",
  tealBdr: "rgba(14,116,144,0.35)",
  goldProgress: "#FDE68A",
  greenProgress: "#6EE7B7",
  specGold: "#C9892E",
  specGoldBg: "rgba(201,137,46,0.08)",
  specGoldBdr: "rgba(201,137,46,0.35)",
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
