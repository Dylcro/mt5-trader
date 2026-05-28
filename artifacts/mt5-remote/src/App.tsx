import { useCallback, useEffect, useRef, useState } from "react";
import {
  getMyAccount, getPrice, getTotalPnL, getLatestOpenZone,
  placeMarketOrder, riskFreeLatestZone,
  login as apiLogin, setToken, getToken, isTokenValid,
  type Price, type Zone, type AccountStatus,
} from "@/lib/api";

type Action = "buy" | "sell" | "riskFree";

type Banner = { text: string; isError: boolean; ts: number };

export default function App() {
  const [signedIn, setSignedIn] = useState<boolean>(() => isTokenValid(getToken()));

  if (!signedIn) {
    return <LoginScreen onSignedIn={() => setSignedIn(true)} />;
  }
  return <RemoteScreen onSignOut={() => { setToken(null); setSignedIn(false); }} />;
}

// ============================================================================
// Login
// ============================================================================

function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await apiLogin(email.trim(), password);
      setToken(r.token);
      onSignedIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      justifyContent: "center", alignItems: "stretch",
      padding: "24px", maxWidth: "420px", margin: "0 auto",
    }}>
      <h1 style={{
        color: "var(--gold)", fontSize: "28px", fontWeight: 800,
        textAlign: "center", margin: "0 0 8px",
        letterSpacing: "-0.02em",
      }}>MT5 Remote</h1>
      <p style={{
        color: "var(--muted)", textAlign: "center", margin: "0 0 32px",
        fontSize: "14px",
      }}>Sign in with your trader account</p>

      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={inputStyle}
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={inputStyle}
        />
        {err && (
          <div style={{
            color: "var(--red)", fontSize: 13, padding: "8px 12px",
            background: "rgba(231,76,60,.08)", borderRadius: 8,
            border: "1px solid rgba(231,76,60,.25)",
          }}>{err}</div>
        )}
        <button
          type="submit"
          disabled={busy}
          style={{
            ...primaryButtonStyle,
            opacity: busy ? 0.6 : 1,
            marginTop: 4,
          }}
        >{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "14px 16px",
  color: "var(--text)",
  fontSize: 16,
  outline: "none",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "var(--gold)",
  color: "#000",
  border: "none",
  borderRadius: 10,
  padding: "14px 16px",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
};

// ============================================================================
// Remote (dashboard + buttons)
// ============================================================================

function RemoteScreen({ onSignOut }: { onSignOut: () => void }) {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [accountErr, setAccountErr] = useState<string | null>(null);
  const [price, setPrice] = useState<Price | null>(null);
  const [pnl, setPnl] = useState<number | null>(null);
  const [zone, setZone] = useState<Zone | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [stale, setStale] = useState(false);
  const reqSeq = useRef(0);
  const failStreak = useRef(0);

  // Resolve the active account once on mount
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const a = await getMyAccount();
        if (!alive) return;
        if (!a || !a.accountId) { setAccountErr("No MT5 account linked. Open the phone app first."); return; }
        setAccount(a);
      } catch (e) {
        if (alive) setAccountErr((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!account?.accountId || !account?.region) return;
    const aid = account.accountId; const rg = account.region;
    const mySeq = ++reqSeq.current;
    const results = await Promise.allSettled([
      getPrice(aid, rg),
      getTotalPnL(aid, rg),
      getLatestOpenZone(aid),
    ]);
    // Drop responses from older refreshes — keeps state monotonic under latency spikes.
    if (mySeq !== reqSeq.current) return;
    const [pr, lr, zr] = results;
    const anyOk = results.some((r) => r.status === "fulfilled");
    if (pr.status === "fulfilled") setPrice(pr.value);
    if (lr.status === "fulfilled") setPnl(lr.value);
    if (zr.status === "fulfilled") setZone(zr.value);
    if (anyOk) { failStreak.current = 0; setStale(false); }
    else { failStreak.current += 1; if (failStreak.current >= 2) setStale(true); }
  }, [account?.accountId, account?.region]);

  // Poll every 3s while the tab is visible
  useEffect(() => {
    if (!account) return;
    void refresh();
    let interval: number | undefined;
    const start = () => {
      stop();
      interval = window.setInterval(() => { void refresh(); }, 3000);
    };
    const stop = () => { if (interval) { window.clearInterval(interval); interval = undefined; } };
    const onVis = () => { if (document.visibilityState === "visible") { void refresh(); start(); } else { stop(); } };
    document.addEventListener("visibilitychange", onVis);
    start();
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [account, refresh]);

  // Auto-dismiss banner after 4s
  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner((b) => (b && b.ts === banner.ts ? null : b)), 4000);
    return () => window.clearTimeout(t);
  }, [banner]);

  async function runTrade(direction: "buy" | "sell") {
    if (!account?.accountId || !account?.region || busy) return;
    setBusy(direction);
    haptic();
    try {
      await placeMarketOrder(account.accountId, account.region, direction);
      setBanner({ text: `${direction.toUpperCase()} placed`, isError: false, ts: Date.now() });
      void refresh();
    } catch (e) {
      setBanner({ text: (e as Error).message, isError: true, ts: Date.now() });
    } finally {
      setBusy(null);
    }
  }

  async function runRiskFree() {
    if (!account?.accountId || !account?.region || busy) return;
    setBusy("riskFree");
    haptic();
    try {
      await riskFreeLatestZone(account.accountId, account.region);
      setBanner({ text: "Risk-free applied", isError: false, ts: Date.now() });
      void refresh();
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = status === 404 ? "No open zone" : (e as Error).message;
      setBanner({ text: msg, isError: true, ts: Date.now() });
    } finally {
      setBusy(null);
    }
  }

  if (accountErr) {
    return (
      <div style={{ padding: 24, maxWidth: 420, margin: "0 auto" }}>
        <div style={{
          color: "var(--red)", padding: 16, background: "rgba(231,76,60,.08)",
          border: "1px solid rgba(231,76,60,.25)", borderRadius: 10,
        }}>{accountErr}</div>
        <button onClick={onSignOut} style={{
          marginTop: 16, width: "100%",
          background: "transparent", border: "1px solid var(--border)",
          color: "var(--muted)", borderRadius: 10, padding: "12px 16px",
          fontSize: 14, cursor: "pointer",
        }}>Sign out</button>
      </div>
    );
  }

  if (!account) {
    return <CenteredText>Loading…</CenteredText>;
  }

  return (
    <div style={{
      minHeight: "100vh", maxWidth: 420, margin: "0 auto",
      padding: "20px 16px 24px", display: "flex", flexDirection: "column", gap: 14,
    }}>
      <Header onSignOut={onSignOut} />
      {stale && (
        <div style={{
          fontSize: 12, fontWeight: 600, color: "var(--gold)",
          padding: "8px 12px", borderRadius: 8,
          background: "rgba(201,168,76,.08)",
          border: "1px solid rgba(201,168,76,.25)",
          textAlign: "center",
        }}>Connection lost — data may be stale</div>
      )}
      <PriceCard price={price} />
      <PnLCard pnl={pnl} />
      <ZoneCard zone={zone} />
      <div style={{ flex: 1 }} />
      {banner && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, textAlign: "center", fontSize: 14, fontWeight: 600,
          color: banner.isError ? "var(--red)" : "var(--green)",
          background: banner.isError ? "rgba(231,76,60,.08)" : "rgba(46,204,113,.08)",
          border: `1px solid ${banner.isError ? "rgba(231,76,60,.25)" : "rgba(46,204,113,.25)"}`,
        }}>{banner.text}</div>
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <ActionButton color="var(--green)" busy={busy === "buy"} disabled={!!busy} onClick={() => runTrade("buy")}>BUY</ActionButton>
        <ActionButton color="var(--red)" busy={busy === "sell"} disabled={!!busy} onClick={() => runTrade("sell")}>SELL</ActionButton>
      </div>
      <ActionButton color="var(--gold)" busy={busy === "riskFree"} disabled={!!busy} onClick={runRiskFree} wide>
        RISK FREE
      </ActionButton>
    </div>
  );
}

// ============================================================================
// Pieces
// ============================================================================

function Header({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: "var(--gold)", letterSpacing: "-0.01em" }}>MT5 Remote</div>
      <button onClick={onSignOut} style={{
        background: "transparent", border: "1px solid var(--border)", color: "var(--muted)",
        borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer",
      }}>Sign out</button>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--card)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "14px 16px",
    }}>{children}</div>
  );
}

function PriceCard({ price }: { price: Price | null }) {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em" }}>XAUUSD</span>
        {price ? (
          <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
            <span style={{ color: "var(--red)", fontSize: 22, fontWeight: 700, fontFamily: "var(--app-font-mono)" }}>
              {price.bid.toFixed(2)}
            </span>
            <span style={{ color: "var(--muted)", fontSize: 14 }}>/</span>
            <span style={{ color: "var(--green)", fontSize: 22, fontWeight: 700, fontFamily: "var(--app-font-mono)" }}>
              {price.ask.toFixed(2)}
            </span>
          </div>
        ) : (
          <span style={{ color: "var(--muted)", fontFamily: "var(--app-font-mono)" }}>—</span>
        )}
      </div>
    </Card>
  );
}

function PnLCard({ pnl }: { pnl: number | null }) {
  const color = pnl == null ? "var(--muted)" : pnl < 0 ? "var(--red)" : pnl > 0 ? "var(--green)" : "var(--text)";
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "var(--muted)", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em" }}>TOTAL P&amp;L</span>
        <span style={{ color, fontSize: 24, fontWeight: 800, fontFamily: "var(--app-font-mono)" }}>
          {pnl == null ? "—" : `${pnl < 0 ? "-" : ""}$${Math.abs(pnl).toFixed(2)}`}
        </span>
      </div>
    </Card>
  );
}

function ZoneCard({ zone }: { zone: Zone | null }) {
  return (
    <Card>
      {zone ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{
              color: zone.direction === "buy" ? "var(--green)" : "var(--red)",
              fontSize: 13, fontWeight: 800, letterSpacing: "0.05em",
            }}>{zone.direction.toUpperCase()}</span>
            <span style={{ color: "var(--muted)", fontSize: 11 }}>@</span>
            <span style={{ color: "var(--text)", fontSize: 14, fontFamily: "var(--app-font-mono)" }}>
              {zone.anchorPrice.toFixed(2)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[zone.tp1Hit, zone.tp2Hit, zone.tp3Hit, zone.tp4Hit].map((hit, i) => (
              <span key={i} style={{
                fontSize: 11, fontFamily: "var(--app-font-mono)", padding: "2px 6px",
                borderRadius: 4, fontWeight: 700,
                color: hit ? "#000" : "var(--muted)",
                background: hit ? "var(--gold)" : "transparent",
                border: `1px solid ${hit ? "var(--gold)" : "var(--border)"}`,
              }}>TP{i + 1}</span>
            ))}
          </div>
        </div>
      ) : (
        <span style={{ color: "var(--muted)", fontSize: 13 }}>No open zone</span>
      )}
    </Card>
  );
}

function ActionButton({
  color, children, onClick, disabled, busy, wide,
}: {
  color: string; children: React.ReactNode; onClick: () => void;
  disabled?: boolean; busy?: boolean; wide?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        background: color,
        color: "#000",
        border: "none",
        borderRadius: 14,
        padding: wide ? "22px 16px" : "26px 16px",
        fontSize: wide ? 18 : 22,
        fontWeight: 900,
        letterSpacing: "0.04em",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled && !busy ? 0.35 : 1,
        transition: "transform .05s ease, opacity .15s ease",
        WebkitTouchCallout: "none",
        userSelect: "none",
      }}
      onTouchStart={(e) => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.transform = "scale(0.97)"; }}
      onTouchEnd={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = ""; }}
    >
      {busy ? "…" : children}
    </button>
  );
}

function CenteredText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      color: "var(--muted)",
    }}>{children}</div>
  );
}

function haptic() {
  try {
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    nav.vibrate?.(20);
  } catch { /* unsupported on iOS Safari */ }
}
