/** XAUUSD Trader web admin — matches artifacts/mt5-trader/constants/colors.ts */
export const APP_THEME = {
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
  navy: "#1A2B4A",
  success: "#0BAD6B",
  successLight: "rgba(11,173,107,0.10)",
  warning: "#B8922A",
  danger: "#E03450",
  dangerLight: "rgba(224,52,80,0.08)",
  shadow: "rgba(0,0,0,0.06)",
  onDark: "#FFFFFF",
  onDarkMuted: "rgba(255,255,255,0.5)",
} as const;

export const ADMIN_PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${APP_THEME.background};
    color: ${APP_THEME.text};
    min-height: 100vh;
  }
  a { color: ${APP_THEME.gold}; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
  .topbar {
    background: ${APP_THEME.navy};
    color: ${APP_THEME.onDark};
    padding: 18px 24px;
    box-shadow: 0 2px 12px ${APP_THEME.shadow};
  }
  .topbar-inner {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  .brand { display: flex; flex-direction: column; gap: 2px; }
  .symbol { font-size: 22px; font-weight: 700; letter-spacing: 1px; }
  .brand-sub { font-size: 12px; color: ${APP_THEME.onDarkMuted}; font-weight: 500; }
  .topbar-time { font-size: 11px; color: ${APP_THEME.onDarkMuted}; }
  .page { max-width: 1200px; margin: 0 auto; padding: 20px 24px 48px; }
  .nav { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .nav a, .nav span {
    font-size: 12px; font-weight: 600; padding: 8px 16px; border-radius: 20px;
    border: 1px solid ${APP_THEME.border}; background: ${APP_THEME.card};
    color: ${APP_THEME.textSecondary};
  }
  .nav a.active, .nav span.active {
    background: ${APP_THEME.goldLight};
    border-color: ${APP_THEME.goldBorder};
    color: ${APP_THEME.gold};
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat {
    background: ${APP_THEME.card};
    border: 1px solid ${APP_THEME.border};
    border-radius: 16px;
    padding: 16px;
    box-shadow: 0 1px 4px ${APP_THEME.shadow};
  }
  .stat-n { font-size: 28px; font-weight: 700; color: ${APP_THEME.text}; }
  .stat-l { font-size: 10px; color: ${APP_THEME.textMuted}; text-transform: uppercase; letter-spacing: 0.6px; margin-top: 4px; font-weight: 600; }
  h2 { font-size: 13px; font-weight: 700; color: ${APP_THEME.text}; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 10px; }
  .section { margin-bottom: 32px; }
  .section-hint { font-size: 12px; color: ${APP_THEME.textSecondary}; margin-bottom: 12px; line-height: 1.5; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
  .badge {
    display: inline-block; background: ${APP_THEME.goldLight}; color: ${APP_THEME.gold};
    border: 1px solid ${APP_THEME.goldBorder}; border-radius: 20px;
    font-size: 11px; font-weight: 700; padding: 3px 10px; margin-left: 6px;
  }
  .btn {
    display: inline-block; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 700;
    cursor: pointer; border: 1px solid ${APP_THEME.border}; background: ${APP_THEME.card};
    color: ${APP_THEME.text}; text-decoration: none;
  }
  .btn:hover { background: ${APP_THEME.surface}; }
  .btn-danger { color: ${APP_THEME.danger}; border-color: rgba(224,52,80,0.35); background: ${APP_THEME.dangerLight}; }
  .btn-primary {
    padding: 10px 18px; background: ${APP_THEME.gold}; color: ${APP_THEME.onDark};
    border: 0; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 13px;
  }
  .btn-primary:hover { filter: brightness(0.95); }
  .search {
    padding: 10px 14px; background: ${APP_THEME.card}; border: 1px solid ${APP_THEME.border};
    color: ${APP_THEME.text}; border-radius: 12px; font-size: 13px; min-width: 220px;
    box-shadow: 0 1px 2px ${APP_THEME.shadow};
  }
  .search:focus { outline: none; border-color: ${APP_THEME.gold}; box-shadow: 0 0 0 3px ${APP_THEME.goldLight}; }
  table {
    width: 100%; border-collapse: collapse; background: ${APP_THEME.card};
    border-radius: 16px; overflow: hidden; border: 1px solid ${APP_THEME.border};
    font-size: 13px; box-shadow: 0 1px 4px ${APP_THEME.shadow};
  }
  thead { background: ${APP_THEME.surface}; }
  th {
    padding: 12px 14px; text-align: left; font-size: 10px; font-weight: 700;
    color: ${APP_THEME.textMuted}; letter-spacing: 0.5px; text-transform: uppercase;
    border-bottom: 1px solid ${APP_THEME.border};
  }
  td { padding: 12px 14px; border-bottom: 1px solid ${APP_THEME.border}; vertical-align: middle; color: ${APP_THEME.text}; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: ${APP_THEME.surface}; }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: ${APP_THEME.gold}; font-weight: 600; }
  .mono-sm { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 10px; color: ${APP_THEME.textMuted}; }
  .muted { color: ${APP_THEME.textMuted}; }
  .success { color: ${APP_THEME.success}; font-weight: 600; }
  .warn { color: ${APP_THEME.warning}; font-weight: 600; }
  .danger { color: ${APP_THEME.danger}; font-weight: 600; }
  .query { max-width: 420px; line-height: 1.5; white-space: pre-wrap; color: ${APP_THEME.textSecondary}; }
  .empty { color: ${APP_THEME.textMuted}; font-style: italic; padding: 24px; text-align: center; }
  .tag {
    display: inline-block; background: ${APP_THEME.surface}; border: 1px solid ${APP_THEME.border};
    border-radius: 8px; padding: 3px 8px; font-size: 10px; color: ${APP_THEME.textSecondary}; font-weight: 500;
  }
  .card {
    background: ${APP_THEME.card}; border: 1px solid ${APP_THEME.border};
    border-radius: 16px; padding: 18px; max-width: 560px;
    box-shadow: 0 1px 4px ${APP_THEME.shadow};
  }
  .input {
    padding: 10px 14px; background: ${APP_THEME.card}; border: 1px solid ${APP_THEME.border};
    color: ${APP_THEME.text}; border-radius: 10px; font-size: 13px; width: 100%;
  }
  .input:focus { outline: none; border-color: ${APP_THEME.gold}; }
  .code-block {
    margin-top: 12px; padding: 10px; background: ${APP_THEME.surface};
    border: 1px solid ${APP_THEME.border}; border-radius: 10px; font-size: 11px;
    display: none; overflow: auto; max-height: 180px; color: ${APP_THEME.textSecondary};
  }
  details { margin-bottom: 20px; }
  summary { cursor: pointer; color: ${APP_THEME.textSecondary}; font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  .reset-btn {
    padding: 6px 12px; background: ${APP_THEME.goldLight}; color: ${APP_THEME.gold};
    border: 1px solid ${APP_THEME.goldBorder}; border-radius: 8px; cursor: pointer;
    font-size: 10px; font-weight: 700;
  }
  .key-gate {
    max-width: 400px; margin: 80px auto; padding: 28px;
    background: ${APP_THEME.card}; border: 1px solid ${APP_THEME.border};
    border-radius: 16px; box-shadow: 0 4px 20px ${APP_THEME.shadow};
  }
`;

/** Status dashboard — same tokens as the mobile app */
export const STATUS_PAGE_CSS = `${ADMIN_PAGE_CSS}
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .metric-card { background: ${APP_THEME.card}; border: 1px solid ${APP_THEME.border}; border-radius: 16px; padding: 16px 20px; box-shadow: 0 1px 4px ${APP_THEME.shadow}; }
  .card-label { font-size: 11px; color: ${APP_THEME.textMuted}; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; font-weight: 700; }
  .card-value { font-size: 28px; font-weight: 700; color: ${APP_THEME.text}; }
  .card-sub { font-size: 12px; color: ${APP_THEME.textSecondary}; margin-top: 4px; }
  #refresh-bar { font-size: 12px; color: ${APP_THEME.textMuted}; margin-bottom: 20px; }
  .ok { color: ${APP_THEME.success}; font-weight: 700; }
  .err { color: ${APP_THEME.danger}; font-weight: 700; }
  .key-form { background: ${APP_THEME.card}; border: 1px solid ${APP_THEME.border}; border-radius: 16px; padding: 28px; max-width: 400px; box-shadow: 0 4px 20px ${APP_THEME.shadow}; }
  .key-form input { width: 100%; padding: 10px 14px; background: ${APP_THEME.card}; border: 1px solid ${APP_THEME.border}; color: ${APP_THEME.text}; border-radius: 10px; font-family: inherit; font-size: 13px; margin-bottom: 12px; }
  .key-form button { padding: 12px 20px; background: ${APP_THEME.gold}; color: ${APP_THEME.onDark}; border: 0; border-radius: 10px; font-weight: 700; cursor: pointer; font-size: 13px; width: 100%; }
  .nav-back { margin-bottom: 16px; }
`;
