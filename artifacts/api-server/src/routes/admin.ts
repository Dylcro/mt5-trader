import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import {
  db,
  storedAccountsTable,
  supportTicketsTable,
  usersTable,
  cascadeZonesTable,
  type StoredAccount,
} from "@workspace/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { resetAuthLockouts } from "../lib/rateLimiters";
import { getStreamHealth, getZoneCounts, listProvisioningAccounts } from "./mt5";
import { getTelemetry } from "../telemetry";
import { ADMIN_PAGE_CSS, APP_THEME } from "../lib/appTheme";

const router: IRouter = Router();

const ADMIN_KEY = process.env["ADMIN_KEY"];
if (!ADMIN_KEY || ADMIN_KEY === "changeme") {
  throw new Error("ADMIN_KEY environment variable is required and must not be the default placeholder.");
}

function requireAdminKey(req: Request, res: Response): boolean {
  const key = (req.query["key"] as string | undefined) ?? "";
  if (!key || key !== ADMIN_KEY) {
    res.status(401).send(`<!DOCTYPE html><html><head><style>${ADMIN_PAGE_CSS}</style></head>
      <body><div class="key-gate" style="margin:80px auto">
      <h2 style="color:${APP_THEME.navy};margin-bottom:12px">Admin Access</h2>
      <p class="muted">Pass your admin key: <code>/api/admin?key=YOUR_KEY</code></p>
    </div></body></html>`);
    return false;
  }
  return true;
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** CI / Playwright smoke registrations — hide from default client list. */
function isSmokeTestUser(u: { email: string; fullName?: string | null }): boolean {
  const e = u.email.toLowerCase().trim();
  if (e.startsWith("smoke+") && e.endsWith("@example.com")) return true;
  if (e.includes("smoketest") || e.includes("playwright")) return true;
  if ((u.fullName ?? "").trim() === "Smoke Test") return true;
  return false;
}

/** Latest stored_accounts row per app user (by storedAt). */
function latestAccountByUserId(accounts: StoredAccount[]): Map<string, StoredAccount> {
  const map = new Map<string, StoredAccount>();
  for (const a of accounts) {
    if (!a.userId) continue;
    const prev = map.get(a.userId);
    if (!prev || (a.storedAt ?? 0) > (prev.storedAt ?? 0)) map.set(a.userId, a);
  }
  return map;
}

type StreamSnap = { stale: boolean; silentForSec: number };

function streamForAccount(
  accountId: string | undefined,
  streamByAccount: Map<string, StreamSnap>,
): { label: string; className: string } {
  if (!accountId) return { label: "—", className: "muted" };
  const s = streamByAccount.get(accountId);
  if (!s) return { label: "No stream", className: "muted" };
  if (s.stale) return { label: `Stale ${s.silentForSec}s`, className: "warn" };
  return { label: "Live", className: "success" };
}

function resolveMt5Identity(
  row: StoredAccount | undefined,
  prov: Map<string, { login: string; server: string; region?: string }>,
): { login: string; server: string; region: string } {
  if (!row) return { login: "—", server: "—", region: "—" };
  const p = prov.get(row.accountId);
  return {
    login: row.mt5Login ?? p?.login ?? "—",
    server: row.mt5Server ?? p?.server ?? "—",
    region: row.region ?? p?.region ?? "—",
  };
}

router.get("/", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const key = String(req.query["key"] ?? "");
  const hideTest = req.query["hide_test"] !== "0";

  try {
    const [allUsers, allAccounts, tickets, provMap, health, zones] = await Promise.all([
      db.select().from(usersTable).orderBy(desc(usersTable.createdAt)),
      db.select().from(storedAccountsTable).orderBy(desc(storedAccountsTable.storedAt)),
      db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.createdAt)),
      listProvisioningAccounts().catch(() => new Map()),
      Promise.resolve(getStreamHealth()),
      Promise.resolve(getZoneCounts()),
    ]);

    const smokeUsers = allUsers.filter(isSmokeTestUser);
    const realUsers = hideTest ? allUsers.filter((u) => !isSmokeTestUser(u)) : allUsers;
    const latestByUser = latestAccountByUserId(allAccounts);

    const streamByAccount = new Map<string, StreamSnap>();
    for (const a of health.accounts) {
      streamByAccount.set(a.accountId, { stale: a.stale, silentForSec: a.silentForSec });
    }

    let liveStreams = 0;
    for (const a of health.accounts) {
      if (!a.stale) liveStreams += 1;
    }

    const clientRows = realUsers.map((u) => {
      const link = latestByUser.get(String(u.id));
      const mt5 = resolveMt5Identity(link, provMap);
      const stream = streamForAccount(link?.accountId, streamByAccount);
      const shortId = link?.accountId ? link.accountId.slice(0, 8) + "…" : "—";
      return `
        <tr data-search="${escapeHtml(`${u.fullName} ${u.email} ${mt5.login} ${mt5.server}`.toLowerCase())}">
          <td><strong>${escapeHtml(u.fullName ?? "—")}</strong></td>
          <td class="mono muted">${escapeHtml(u.email)}</td>
          <td class="mono">${escapeHtml(mt5.login)}</td>
          <td class="tag" title="${escapeHtml(mt5.server)}">${escapeHtml(mt5.server.length > 28 ? mt5.server.slice(0, 26) + "…" : mt5.server)}</td>
          <td><span class="tag">${escapeHtml(mt5.region)}</span></td>
          <td class="${stream.className}">${escapeHtml(stream.label)}</td>
          <td class="mono-sm" title="${escapeHtml(link?.accountId ?? "")}">${escapeHtml(shortId)}</td>
          <td class="muted">${link ? formatDate(link.storedAt) : "—"}</td>
          <td>
            <button type="button" class="resetPwBtn reset-btn" data-email="${escapeHtml(u.email)}" data-name="${escapeHtml(u.fullName ?? u.email)}">
              Reset password
            </button>
          </td>
        </tr>`;
    }).join("");

    const linkedUserIds = new Set(realUsers.map((u) => String(u.id)));
    const orphanAccounts = allAccounts.filter((a) => !a.userId || !linkedUserIds.has(a.userId));
    const orphanRows = orphanAccounts.slice(0, 50).map((a) => {
      const mt5 = resolveMt5Identity(a, provMap);
      const stream = streamForAccount(a.accountId, streamByAccount);
      return `
        <tr>
          <td class="mono">${escapeHtml(mt5.login)}</td>
          <td class="tag">${escapeHtml(mt5.server)}</td>
          <td class="mono-sm">${escapeHtml(a.accountId.slice(0, 12))}…</td>
          <td class="muted">${escapeHtml(a.userId ?? "unlinked")}</td>
          <td class="${stream.className}">${escapeHtml(stream.label)}</td>
          <td class="muted">${formatDate(a.storedAt)}</td>
        </tr>`;
    }).join("");

    const ticketRows = tickets.length === 0
      ? `<tr><td colspan="4" class="empty">No support requests</td></tr>`
      : tickets.slice(0, 30).map((t) => `
        <tr>
          <td>${escapeHtml(t.name)}</td>
          <td class="mono muted">${escapeHtml(t.email ?? "—")}</td>
          <td class="query">${escapeHtml(t.query)}</td>
          <td class="muted">${formatDate(t.createdAt)}</td>
        </tr>`).join("");

    const testToggleHref = hideTest
      ? `/api/admin?key=${encodeURIComponent(key)}&hide_test=0`
      : `/api/admin?key=${encodeURIComponent(key)}&hide_test=1`;
    const testToggleLabel = hideTest ? "Show smoke-test users" : "Hide smoke-test users";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>XAUUSD Trader — Clients</title>
<style>${ADMIN_PAGE_CSS}</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <span class="symbol">XAUUSD</span>
        <span class="brand-sub">Admin · Clients &amp; MT5</span>
      </div>
      <span class="topbar-time">${new Date().toUTCString()}</span>
    </div>
  </header>
  <div class="page">
  <div class="nav">
    <span class="active">Clients</span>
    <a href="/status?key=${encodeURIComponent(key)}">System status</a>
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-n">${realUsers.length}</div><div class="stat-l">App clients</div></div>
    <div class="stat"><div class="stat-n">${realUsers.filter((u) => latestByUser.has(String(u.id))).length}</div><div class="stat-l">With MT5 linked</div></div>
    <div class="stat"><div class="stat-n ${health.healthy ? "success" : "warn"}">${liveStreams}</div><div class="stat-l">Live streams</div></div>
    <div class="stat"><div class="stat-n">${zones.open}</div><div class="stat-l">Open zones</div></div>
    <div class="stat"><div class="stat-n">${hideTest ? smokeUsers.length : 0}</div><div class="stat-l">Smoke users hidden</div></div>
  </div>

  <div class="section">
    <h2>Clients <span class="badge">${realUsers.length}</span></h2>
    <p class="section-hint">
      One row per app user. <strong>MT5 #</strong> is the broker login they use in the app.
      Shows the <em>current</em> linked account (most recent connect). Stream = live price feed from the API.
    </p>
    <div class="toolbar">
      <input type="search" id="clientSearch" class="search" placeholder="Search name, email, MT5…" />
      <a class="btn" href="${testToggleHref}">${testToggleLabel}</a>
      ${smokeUsers.length > 0 ? `<button type="button" class="btn btn-danger" id="purgeSmokeBtn">Delete ${smokeUsers.length} smoke-test users</button>` : ""}
    </div>
    <table id="clientsTable">
      <thead>
        <tr>
          <th>Client</th><th>Email</th><th>MT5 #</th><th>Server</th><th>Region</th>
          <th>Stream</th><th>MetaAPI</th><th>Last linked</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${clientRows.length ? clientRows : '<tr><td colspan="9" class="empty">No clients yet</td></tr>'}
      </tbody>
    </table>
  </div>

  ${orphanAccounts.length > 0 ? `
  <details class="section">
    <summary>Unlinked / old MetaAPI rows (${orphanAccounts.length}) — not tied to a client above</summary>
    <table>
      <thead><tr><th>MT5 #</th><th>Server</th><th>MetaAPI ID</th><th>User ID</th><th>Stream</th><th>Stored</th></tr></thead>
      <tbody>${orphanRows}</tbody>
    </table>
  </details>` : ""}

  <div class="section">
    <h2>Tools</h2>
    <div class="card" style="margin-bottom:16px">
      <p class="muted" style="font-size:12px;margin-bottom:12px">Clear login lockouts after too many failed attempts.</p>
      <button id="clearLockoutsBtn" type="button" class="btn-primary">Clear all login lockouts</button>
      <pre id="clearLockoutsResult" class="code-block"></pre>
    </div>
    <div class="card">
      <h2 style="margin-bottom:10px">Migrate MT5 region</h2>
      <form id="migrateForm" style="display:grid;gap:8px;margin-top:8px">
        <input class="input" name="login" placeholder="MT5 login" required>
        <input class="input" name="password" type="password" placeholder="MT5 password" required>
        <input class="input" name="server" placeholder="MT5 server" required>
        <input class="input" name="targetRegion" value="new-york" placeholder="Target region">
        <button type="submit" class="btn-primary">Migrate account</button>
      </form>
      <pre id="migrateResult" class="code-block"></pre>
    </div>
  </div>

  <div class="section">
    <h2>Support <span class="badge">${tickets.length}</span></h2>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Message</th><th>When</th></tr></thead>
      <tbody>${ticketRows}</tbody>
    </table>
  </div>

<script>
(function() {
  var key = ${JSON.stringify(key)};
  var search = document.getElementById('clientSearch');
  var table = document.getElementById('clientsTable');
  if (search && table) {
    search.addEventListener('input', function() {
      var q = search.value.toLowerCase().trim();
      table.querySelectorAll('tbody tr').forEach(function(tr) {
        var hay = tr.getAttribute('data-search') || '';
        tr.style.display = !q || hay.indexOf(q) >= 0 ? '' : 'none';
      });
    });
  }

  document.querySelectorAll('.resetPwBtn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var email = btn.getAttribute('data-email');
      var name = btn.getAttribute('data-name');
      var pw = prompt('New password for ' + name + ' (' + email + '), min 8 chars:');
      if (!pw || pw.length < 8) return;
      var orig = btn.textContent; btn.disabled = true; btn.textContent = '…';
      try {
        var r = await fetch('/api/admin/users/reset-password?key=' + encodeURIComponent(key), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, newPassword: pw }),
        });
        var j = await r.json();
        alert(r.ok && j.ok ? 'Password updated for ' + email : (j.error || 'Failed'));
        if (r.ok && j.ok) location.reload();
      } finally { btn.disabled = false; btn.textContent = orig; }
    });
  });

  var purge = document.getElementById('purgeSmokeBtn');
  if (purge) {
    purge.addEventListener('click', async function() {
      if (!confirm('Delete all smoke-test users (smoke+*@example.com) and their DB links?')) return;
      purge.disabled = true;
      try {
        var r = await fetch('/api/admin/purge-smoke-users?key=' + encodeURIComponent(key), { method: 'POST' });
        var j = await r.json();
        alert(j.message || j.error || ('HTTP ' + r.status));
        if (r.ok) location.reload();
      } finally { purge.disabled = false; }
    });
  }

  var clearBtn = document.getElementById('clearLockoutsBtn');
  var clearOut = document.getElementById('clearLockoutsResult');
  if (clearBtn) {
    clearBtn.addEventListener('click', async function() {
      clearBtn.disabled = true;
      clearOut.style.display = 'block';
      try {
        var r = await fetch('/api/admin/reset-lockouts?key=' + encodeURIComponent(key), { method: 'POST' });
        clearOut.textContent = JSON.stringify(await r.json(), null, 2);
      } finally { clearBtn.disabled = false; }
    });
  }

  var form = document.getElementById('migrateForm');
  var out = document.getElementById('migrateResult');
  if (form) {
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      var btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      out.style.display = 'block';
      var fd = new FormData(form);
      try {
        var r = await fetch('/api/mt5/admin/migrate-region', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
          body: JSON.stringify(Object.fromEntries(fd.entries())),
        });
        out.textContent = JSON.stringify(await r.json(), null, 2);
      } catch (err) { out.textContent = String(err); }
      finally { btn.disabled = false; }
    });
  }
})();
</script>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error("[admin] error:", (err as Error).message);
    res.status(500).send("Internal server error");
  }
});

router.post("/purge-smoke-users", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  try {
    const allUsers = await db.select().from(usersTable);
    const smoke = allUsers.filter(isSmokeTestUser);
    if (smoke.length === 0) {
      res.json({ ok: true, deletedUsers: 0, message: "No smoke-test users found." });
      return;
    }
    const ids = smoke.map((u) => u.id);
    const emails = smoke.map((u) => u.email.toLowerCase());
    for (const u of smoke) {
      const uid = String(u.id);
      const accounts = await db.select().from(storedAccountsTable).where(eq(storedAccountsTable.userId, uid));
      for (const a of accounts) {
        await db.delete(storedAccountsTable).where(eq(storedAccountsTable.accountId, a.accountId));
      }
    }
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
    res.json({
      ok: true,
      deletedUsers: smoke.length,
      message: `Removed ${smoke.length} smoke-test user(s): ${emails.slice(0, 5).join(", ")}${emails.length > 5 ? "…" : ""}`,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/reset-lockouts", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const result = await resetAuthLockouts();
  if (result.ok) {
    res.json({ ok: true, message: "All login lockouts cleared." });
  } else {
    res.status(500).json({ ok: false, error: result.error ?? "Rate-limit store does not support resetAll" });
  }
});

router.post("/users/reset-password", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const { email, newPassword } = req.body ?? {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email is required." });
    return;
  }
  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters." });
    return;
  }
  try {
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const [updated] = await db.update(usersTable)
      .set({ passwordHash })
      .where(eq(usersTable.email, email.toLowerCase().trim()))
      .returning({ id: usersTable.id, email: usersTable.email });
    if (!updated) { res.status(404).json({ error: "User not found." }); return; }
    res.json({ ok: true, user: updated, message: "Password reset." });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/users/update-name", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const { email, fullName } = req.body ?? {};
  if (!email || !fullName) { res.status(400).json({ error: "email and fullName required" }); return; }
  try {
    const [updated] = await db.update(usersTable)
      .set({ fullName })
      .where(eq(usersTable.email, email.toLowerCase().trim()))
      .returning({ id: usersTable.id, email: usersTable.email, fullName: usersTable.fullName });
    if (!updated) { res.status(404).json({ error: "User not found" }); return; }
    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/status", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const health = getStreamHealth();
  const zones = getZoneCounts();
  const { recentTradeFailures, recentRateLimits } = getTelemetry();
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const [closedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cascadeZonesTable)
    .where(sql`status = 'CLOSED' AND closed_at >= ${since}`);
  res.json({
    ts: Date.now(),
    streams: health,
    zones: { ...zones, closedLast24h: closedRow?.count ?? 0 },
    recentTradeFailures,
    recentRateLimits,
  });
});

export default router;
