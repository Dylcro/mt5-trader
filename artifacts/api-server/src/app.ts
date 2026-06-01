import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import router from "./routes";
import adminRouter from "./routes/admin";
import authRouter from "./routes/auth";
import healthRouter from "./routes/health";
import systemRouter from "./routes/system";
import { authLimiter, apiLimiter } from "./lib/rateLimiters";
import { STATUS_PAGE_CSS } from "./lib/appTheme";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS — only allow the production domain and local dev ────────────────────
const ALLOWED_ORIGINS: (string | RegExp)[] = [
  "https://meta-trader-link.replit.app",
  /^https:\/\/.*\.replit\.dev$/,
  /^https:\/\/.*\.up\.railway\.app$/,
  /^https:\/\/.*\.expo\.dev$/,
  "http://localhost:19006",
  "http://localhost:8081",
];
const railwayDomain = process.env["RAILWAY_PUBLIC_DOMAIN"];
if (railwayDomain) {
  ALLOWED_ORIGINS.push(`https://${railwayDomain}`);
}
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

// ── Rate limiting (defined in ./lib/rateLimiters so admin can reset them) ────

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ── Health check — public, no JWT. Root path for Railway; /api path for Replit routing.
app.use(healthRouter);
app.use("/api", healthRouter);

app.use("/api/admin", adminRouter);
app.use("/api/system", systemRouter);
app.use("/api/auth", authLimiter, authRouter);
app.use("/api", apiLimiter);

// Public privacy policy page — required by App Store and Google Play for financial apps
app.get("/privacy", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy – XAUUSD Trader</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.7; }
  h1 { color: #b8860b; } h2 { color: #333; margin-top: 2em; }
  a { color: #b8860b; }
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p><strong>XAUUSD Trader</strong> &mdash; Last updated: May 2026</p>

<h2>1. Information We Collect</h2>
<p>We collect the minimum information necessary to provide the service:</p>
<ul>
  <li><strong>Account credentials</strong>: Your MetaTrader 5 broker login and server details, transmitted over TLS and stored encrypted at rest. We never store your password in plaintext.</li>
  <li><strong>Authentication data</strong>: Email address and hashed password used to create your in-app account. We do not sell this data.</li>
  <li><strong>Trading activity</strong>: Trade commands and position data are relayed to your MetaTrader 5 broker via MetaAPI. We log requests for error-debugging purposes only.</li>
  <li><strong>Device/app data</strong>: App settings (cascade configuration) stored server-side and associated with your account.</li>
</ul>

<h2>2. How We Use Your Information</h2>
<p>We use the information collected solely to:</p>
<ul>
  <li>Connect to and operate your MetaTrader 5 trading account</li>
  <li>Authenticate you and keep your session secure</li>
  <li>Sync your trading settings across devices</li>
  <li>Debug service errors and improve reliability</li>
</ul>
<p>We do not use your data for advertising, analytics resale, or any purpose beyond operating this service.</p>

<h2>3. Data Sharing</h2>
<p>Your data is shared only with the following third-party services required to operate the app:</p>
<ul>
  <li><strong>MetaAPI</strong> (metaapi.cloud) &mdash; executes trades on your broker via the MetaTrader 5 protocol</li>
</ul>
<p>We do not sell, rent, or share your personal information with any other parties.</p>

<h2>4. Data Retention</h2>
<p>Your account data is retained for as long as your account is active. You may request deletion at any time by contacting us; we will remove your records within 30 days.</p>

<h2>5. Security</h2>
<p>All data in transit is protected by TLS. Passwords are hashed using bcrypt and never stored in plaintext. Broker credentials are encrypted at rest. We apply the principle of least privilege: each user can only access data tied to their own account.</p>

<h2>6. Your Rights</h2>
<p>Depending on your jurisdiction, you may have the right to access, correct, or delete your personal data. To exercise these rights, contact us at the address below.</p>

<h2>7. Children</h2>
<p>This app is intended for adults engaged in financial trading. We do not knowingly collect data from anyone under 18.</p>

<h2>8. Changes</h2>
<p>We may update this policy. Continued use of the app after changes constitutes acceptance of the updated policy.</p>

<h2>9. Contact</h2>
<p>Questions? Contact us at <a href="mailto:privacy@xauusdtrader.com">privacy@xauusdtrader.com</a>.</p>
</body>
</html>`);
});

app.use("/api", router);

// ── Status page — admin-gated live health dashboard ──────────────────────────
app.get("/status", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>XAUUSD Trader — Status</title>
<style>${STATUS_PAGE_CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <span class="symbol">XAUUSD</span>
      <span class="brand-sub">System status</span>
    </div>
  </div>
</header>
<div class="page">
  <div class="nav nav-back"><a href="/api/admin?key=" id="adminLink">← Clients</a></div>
  <div id="root"></div>
</div>
<script>
(function() {
  var key = new URLSearchParams(location.search).get('key') || '';
  var root = document.getElementById('root');
  var timer = null;
  var countdown = 10;
  var cdTimer = null;

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmt(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'medium' }) + ' UTC';
  }
  function ago(ms) {
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s/60) + 'm ago';
    return Math.round(s/3600) + 'h ago';
  }

  var adminLink = document.getElementById('adminLink');
  if (adminLink && key) adminLink.href = '/api/admin?key=' + encodeURIComponent(key);

  if (!key) {
    root.innerHTML = '<div class="key-form"><h2 style="margin-bottom:16px;color:#1A2B4A">Admin Key Required</h2><form id="kf"><input type="password" id="ki" placeholder="Enter admin key" autocomplete="off"><button type="submit">OPEN STATUS PAGE</button></form></div>';
    document.getElementById('kf').addEventListener('submit', function(e) {
      e.preventDefault();
      var k = document.getElementById('ki').value.trim();
      if (k) location.href = '/status?key=' + encodeURIComponent(k);
    });
    return;
  }

  function render(d) {
    var streams = d.streams || { healthy: true, accounts: [] };
    var zones = d.zones || { open: 0, riskFree: 0 };
    var failures = d.recentTradeFailures || [];
    var rateLimits = d.recentRateLimits || [];

    var streamRows = streams.accounts.length === 0
      ? '<tr><td colspan="4" class="empty">No accounts streaming yet</td></tr>'
      : streams.accounts.map(function(a) {
          var cls = a.stale ? 'err' : 'ok';
          var label = a.stale ? 'STALE' : 'LIVE';
          return '<tr><td class="mono">' + esc(a.accountId) + '</td>' +
            '<td class="' + cls + '">' + label + '</td>' +
            '<td class="muted">' + a.silentForSec + 's silent</td>' +
            '<td class="muted">' + (a.lastEventAt ? fmt(a.lastEventAt) : '\u2014') + '</td></tr>';
        }).join('');

    var failRows = failures.length === 0
      ? '<tr><td colspan="4" class="empty">No trade failures recorded</td></tr>'
      : failures.slice().reverse().map(function(f) {
          return '<tr><td class="muted">' + fmt(f.ts) + '</td>' +
            '<td class="mono">' + esc(f.accountId.slice(-8)) + '</td>' +
            '<td><span class="err">' + esc(f.code) + '</span></td>' +
            '<td class="muted" style="max-width:320px;word-break:break-word">' + esc(f.message) + '</td></tr>';
        }).join('');

    var rlRows = rateLimits.length === 0
      ? '<tr><td colspan="2" class="empty">No rate-limit hits recorded</td></tr>'
      : rateLimits.slice().reverse().map(function(r) {
          return '<tr><td class="muted">' + fmt(r.ts) + '</td>' +
            '<td class="mono">' + esc(r.accountId.slice(-8)) + '</td></tr>';
        }).join('');

    var health = streams.healthy ? '<span class="ok">HEALTHY</span>' : '<span class="err">DEGRADED</span>';

    root.innerHTML =
      '<div id="refresh-bar">Auto-refreshes every 10 s &mdash; last updated ' + ago(d.ts) + '</div>' +
      '<div class="section">' +
        '<div class="grid">' +
          '<div class="metric-card"><div class="card-label">Stream Health</div><div class="card-value" style="font-size:18px;margin-top:4px">' + health + '</div><div class="card-sub">' + streams.accounts.length + ' account(s)</div></div>' +
          '<div class="metric-card"><div class="card-label">Open Zones</div><div class="card-value">' + zones.open + '</div><div class="card-sub">' + zones.riskFree + ' risk-free \u2022 ' + (zones.closedLast24h ?? 0) + ' closed (24h)</div></div>' +
          '<div class="metric-card"><div class="card-label">Trade Failures</div><div class="card-value">' + failures.length + '</div><div class="card-sub">in ring buffer</div></div>' +
          '<div class="metric-card"><div class="card-label">Rate Limit Hits</div><div class="card-value">' + rateLimits.length + '</div><div class="card-sub">in ring buffer</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="section"><h2>Streams <span class="badge">' + streams.accounts.length + '</span></h2>' +
        '<table><thead><tr><th>Account ID</th><th>Status</th><th>Silence</th><th>Last Event</th></tr></thead><tbody>' + streamRows + '</tbody></table>' +
      '</div>' +
      '<div class="section"><h2>Recent Trade Failures <span class="badge">' + failures.length + '</span></h2>' +
        '<table><thead><tr><th>Time</th><th>Account</th><th>Code</th><th>Message</th></tr></thead><tbody>' + failRows + '</tbody></table>' +
      '</div>' +
      '<div class="section"><h2>Rate Limit Hits <span class="badge">' + rateLimits.length + '</span></h2>' +
        '<table><thead><tr><th>Time</th><th>Account</th></tr></thead><tbody>' + rlRows + '</tbody></table>' +
      '</div>';
  }

  function startCountdown() {
    countdown = 10;
    clearInterval(cdTimer);
    cdTimer = setInterval(function() {
      countdown--;
      var bar = document.getElementById('refresh-bar');
      if (bar) bar.textContent = 'Auto-refreshes every 10 s — next in ' + countdown + 's';
      if (countdown <= 0) clearInterval(cdTimer);
    }, 1000);
  }

  function load() {
    clearTimeout(timer);
    fetch('/api/admin/status?key=' + encodeURIComponent(key))
      .then(function(r) {
        if (r.status === 401) { root.innerHTML = '<p class="err" style="padding:20px">Invalid admin key.</p>'; return null; }
        return r.json();
      })
      .then(function(d) {
        if (d) { render(d); startCountdown(); }
      })
      .catch(function(e) { root.innerHTML = '<p class="err" style="padding:20px">Fetch error: ' + esc(e.message) + '</p>'; })
      .finally(function() { timer = setTimeout(load, 10000); });
  }

  load();
})();
</script>
</div>
</body>
</html>`);
});

// ── PWA web app — served after all API routes so /api/* is never shadowed ──
const webDist = path.join(__dirname, "../public");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((_req: Request, res: Response) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

export default app;
