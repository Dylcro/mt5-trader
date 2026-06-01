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
import { authLimiter, apiLimiter } from "./lib/rateLimiters";

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

// ── Health check — mounted at root, outside rate limiting, so the deployment
//    platform can probe /healthz without being throttled or blocked by /api middleware.
app.use(healthRouter);

app.use("/api/admin", adminRouter);
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
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e8e6de; min-height: 100vh; padding: 32px 24px; }
  h1 { font-size: 22px; font-weight: 700; color: #c9a84c; letter-spacing: 2px; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #6e6e8a; margin-bottom: 32px; }
  h2 { font-size: 13px; font-weight: 600; color: #c9a84c; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 12px; }
  .section { margin-bottom: 36px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 0; }
  .card { background: #111118; border: 1px solid #1e1e2e; border-radius: 10px; padding: 16px 20px; }
  .card-label { font-size: 11px; color: #6e6e8a; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .card-value { font-size: 28px; font-weight: 700; color: #e8e6de; }
  .card-sub { font-size: 12px; color: #6e6e8a; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #111118; border-radius: 10px; overflow: hidden; border: 1px solid #1e1e2e; font-size: 13px; }
  thead { background: #1a1a28; }
  th { padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 600; color: #6e6e8a; letter-spacing: 0.5px; text-transform: uppercase; border-bottom: 1px solid #1e1e2e; }
  td { padding: 11px 14px; border-bottom: 1px solid #1a1a28; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: #c9a84c; }
  .muted { color: #6e6e8a; }
  .ok { color: #2ed573; }
  .warn { color: #ffa502; }
  .err { color: #ff4757; }
  .empty { color: #6e6e8a; font-style: italic; padding: 20px; text-align: center; }
  .badge { display: inline-block; background: rgba(201,168,76,0.15); color: #c9a84c; border: 1px solid rgba(201,168,76,0.3); border-radius: 20px; font-size: 11px; font-weight: 600; padding: 3px 10px; margin-left: 8px; }
  .key-form { background: #111118; border: 1px solid #1e1e2e; border-radius: 12px; padding: 28px; max-width: 400px; }
  .key-form input { width: 100%; padding: 10px 14px; background: #0a0a0f; border: 1px solid #1e1e2e; color: #e8e6de; border-radius: 6px; font-family: inherit; font-size: 13px; margin-bottom: 12px; }
  .key-form button { padding: 12px 20px; background: #c9a84c; color: #0a0a0f; border: 0; border-radius: 6px; font-weight: 700; cursor: pointer; font-size: 13px; width: 100%; }
  #refresh-bar { font-size: 12px; color: #6e6e8a; margin-top: -20px; margin-bottom: 28px; }
</style>
</head>
<body>
<h1>XAUUSD TRADER</h1>
<p class="subtitle">Live system status</p>
<div id="root"></div>
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

  if (!key) {
    root.innerHTML = '<div class="key-form"><h2 style="margin-bottom:16px">Admin Key Required</h2><form id="kf"><input type="password" id="ki" placeholder="Enter admin key" autocomplete="off"><button type="submit">OPEN STATUS PAGE</button></form></div>';
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
          '<div class="card"><div class="card-label">Stream Health</div><div class="card-value" style="font-size:18px;margin-top:4px">' + health + '</div><div class="card-sub">' + streams.accounts.length + ' account(s)</div></div>' +
          '<div class="card"><div class="card-label">Open Zones</div><div class="card-value">' + zones.open + '</div><div class="card-sub">' + zones.riskFree + ' risk-free \u2022 ' + (zones.closedLast24h ?? 0) + ' closed (24h)</div></div>' +
          '<div class="card"><div class="card-label">Trade Failures</div><div class="card-value">' + failures.length + '</div><div class="card-sub">in ring buffer</div></div>' +
          '<div class="card"><div class="card-label">Rate Limit Hits</div><div class="card-value">' + rateLimits.length + '</div><div class="card-sub">in ring buffer</div></div>' +
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
