import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { db, storedAccountsTable, supportTicketsTable, usersTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { resetAuthLockouts } from "../lib/rateLimiters";

const router: IRouter = Router();

const ADMIN_KEY = process.env["ADMIN_KEY"];
if (!ADMIN_KEY || ADMIN_KEY === "changeme") {
  // Fail fast: the admin panel can reset any user's password and clear
  // auth lockouts, so an unset / placeholder key is a security incident.
  throw new Error("ADMIN_KEY environment variable is required and must not be the default placeholder.");
}

function requireAdminKey(req: Request, res: Response): boolean {
  const key = (req.query["key"] as string | undefined) ?? "";
  if (!key || key !== ADMIN_KEY) {
    res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
      <h2>Admin Access</h2>
      <p>Pass your admin key as a query parameter: <code>/admin?key=YOUR_KEY</code></p>
    </body></html>`);
    return false;
  }
  return true;
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
}

router.get("/", async (req: Request, res: Response) => {
  // mounted at /api/admin in app.ts — before Clerk auth
  if (!requireAdminKey(req, res)) return;

  try {
    const [registeredUsers, connectedAccounts, tickets] = await Promise.all([
      db.select().from(usersTable).orderBy(desc(usersTable.createdAt)),
      db.select().from(storedAccountsTable).orderBy(desc(storedAccountsTable.storedAt)),
      db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.createdAt)),
    ]);

    const css = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e8e6de; min-height: 100vh; padding: 32px 24px; }
      h1 { font-size: 22px; font-weight: 700; color: #c9a84c; letter-spacing: 2px; margin-bottom: 6px; }
      .subtitle { font-size: 13px; color: #6e6e8a; margin-bottom: 32px; }
      h2 { font-size: 14px; font-weight: 600; color: #c9a84c; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 12px; }
      .section { margin-bottom: 40px; }
      .badge { display: inline-block; background: rgba(201,168,76,0.15); color: #c9a84c; border: 1px solid rgba(201,168,76,0.3); border-radius: 20px; font-size: 11px; font-weight: 600; padding: 3px 10px; margin-left: 8px; vertical-align: middle; }
      table { width: 100%; border-collapse: collapse; background: #111118; border-radius: 12px; overflow: hidden; border: 1px solid #1e1e2e; font-size: 13px; }
      thead { background: #1a1a28; }
      th { padding: 12px 16px; text-align: left; font-size: 11px; font-weight: 600; color: #6e6e8a; letter-spacing: 0.5px; text-transform: uppercase; border-bottom: 1px solid #1e1e2e; }
      td { padding: 13px 16px; border-bottom: 1px solid #1a1a28; vertical-align: top; }
      tr:last-child td { border-bottom: none; }
      tr:hover td { background: rgba(201,168,76,0.04); }
      .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: #c9a84c; }
      .muted { color: #6e6e8a; }
      .query { max-width: 480px; line-height: 1.5; white-space: pre-wrap; }
      .empty { color: #6e6e8a; font-style: italic; padding: 20px; text-align: center; }
      .tag { display: inline-block; background: rgba(255,255,255,0.06); border-radius: 6px; padding: 2px 8px; font-size: 11px; color: #a0a0b8; }
      .green { color: #2ed573; }
    `;

    const registeredRows = registeredUsers.length === 0
      ? `<tr><td colspan="5" class="empty">No users registered yet</td></tr>`
      : registeredUsers.map(u => {
          const hasMt5 = connectedAccounts.some(a => a.userId === String(u.id));
          return `
        <tr>
          <td><strong>${escapeHtml(u.fullName ?? "—")}</strong></td>
          <td class="mono muted">${escapeHtml(u.email)}</td>
          <td>${hasMt5 ? '<span class="green">✓ Connected</span>' : '<span class="muted">Not connected</span>'}</td>
          <td class="muted">${formatDate(u.createdAt?.getTime())}</td>
          <td><button type="button" class="resetPwBtn" data-email="${escapeHtml(u.email)}" data-name="${escapeHtml(u.fullName ?? u.email)}" style="padding:6px 12px;background:rgba(201,168,76,0.15);color:#c9a84c;border:1px solid rgba(201,168,76,0.4);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600">Reset password</button></td>
        </tr>`;
        }).join("");

    const connectedRows = connectedAccounts.length === 0
      ? `<tr><td colspan="4" class="empty">No MT5 accounts connected yet</td></tr>`
      : connectedAccounts.map(u => `
        <tr>
          <td class="mono">${u.accountId}</td>
          <td class="mono muted" style="font-size:11px">${u.userId ?? "—"}</td>
          <td><span class="tag">${u.region}</span></td>
          <td class="muted">${formatDate(u.storedAt)}</td>
        </tr>`).join("");

    const ticketRows = tickets.length === 0
      ? `<tr><td colspan="4" class="empty">No support requests yet</td></tr>`
      : tickets.map(t => `
        <tr>
          <td>${escapeHtml(t.name)}</td>
          <td class="mono muted">${t.email ?? "—"}</td>
          <td class="query">${escapeHtml(t.query)}</td>
          <td class="muted">${formatDate(t.createdAt)}</td>
        </tr>`).join("");

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>XAUUSD Trader — Admin</title>
<style>${css}</style>
</head>
<body>
  <h1>XAUUSD TRADER</h1>
  <p class="subtitle">Admin dashboard &mdash; ${new Date().toUTCString()}</p>

  <div class="section">
    <h2>Registered Users <span class="badge">${registeredUsers.length}</span></h2>
    <table>
      <thead><tr><th>Full Name</th><th>Email</th><th>MT5 Status</th><th>Joined</th><th>Actions</th></tr></thead>
      <tbody>${registeredRows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>Connected MT5 Accounts <span class="badge">${connectedAccounts.length}</span></h2>
    <table>
      <thead><tr><th>MT5 Account ID</th><th>User ID</th><th>Region</th><th>Connected</th></tr></thead>
      <tbody>${connectedRows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>Login Lockouts</h2>
    <div style="background:#111118;border:1px solid #1e1e2e;border-radius:12px;padding:20px;max-width:560px">
      <p class="muted" style="font-size:12px;margin-bottom:14px;line-height:1.5">
        After 10 failed login attempts from one network, that IP is locked out for 15 minutes. Click below to clear all current lockouts (e.g. after resetting someone's password so they can sign in immediately).
      </p>
      <button id="clearLockoutsBtn" type="button" style="padding:12px 18px;background:#c9a84c;color:#0a0a0f;border:0;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px">
        CLEAR ALL LOGIN LOCKOUTS
      </button>
      <pre id="clearLockoutsResult" style="margin-top:14px;padding:12px;background:#0a0a0f;border:1px solid #1e1e2e;border-radius:6px;font-size:11px;color:#a0a0b8;white-space:pre-wrap;display:none"></pre>
    </div>
  </div>

  <div class="section">
    <h2>Migrate MT5 Account To New Region</h2>
    <div style="background:#111118;border:1px solid #1e1e2e;border-radius:12px;padding:20px;max-width:560px">
      <p class="muted" style="font-size:12px;margin-bottom:14px;line-height:1.5">
        Re-provisions a MetaAPI account in the target region (default: new-york).
        Use this to move an existing london account to NY for lower latency.
      </p>
      <form id="migrateForm" style="display:grid;gap:10px">
        <input name="login" placeholder="MT5 login (e.g. 12345678)" required
          style="padding:10px;background:#0a0a0f;border:1px solid #1e1e2e;color:#e8e6de;border-radius:6px;font-family:inherit;font-size:13px">
        <input name="password" type="password" placeholder="MT5 password" required
          style="padding:10px;background:#0a0a0f;border:1px solid #1e1e2e;color:#e8e6de;border-radius:6px;font-family:inherit;font-size:13px">
        <input name="server" placeholder="MT5 server (e.g. VantageInternational-Live)" required
          style="padding:10px;background:#0a0a0f;border:1px solid #1e1e2e;color:#e8e6de;border-radius:6px;font-family:inherit;font-size:13px">
        <input name="targetRegion" placeholder="Target region (default: new-york)" value="new-york"
          style="padding:10px;background:#0a0a0f;border:1px solid #1e1e2e;color:#e8e6de;border-radius:6px;font-family:inherit;font-size:13px">
        <button type="submit" style="padding:12px;background:#c9a84c;color:#0a0a0f;border:0;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px">
          MIGRATE ACCOUNT
        </button>
      </form>
      <pre id="migrateResult" style="margin-top:14px;padding:12px;background:#0a0a0f;border:1px solid #1e1e2e;border-radius:6px;font-size:11px;color:#a0a0b8;white-space:pre-wrap;display:none;max-height:200px;overflow:auto"></pre>
    </div>
  </div>
  <script>
    (function() {
      var form = document.getElementById('migrateForm');
      var out = document.getElementById('migrateResult');
      var key = new URLSearchParams(location.search).get('key') || '';
      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        var btn = form.querySelector('button');
        btn.disabled = true; btn.textContent = 'MIGRATING... (10-60s)';
        out.style.display = 'block'; out.textContent = 'Sending request...';
        var fd = new FormData(form);
        var body = { login: fd.get('login'), password: fd.get('password'), server: fd.get('server'), targetRegion: fd.get('targetRegion') || 'new-york' };
        try {
          var r = await fetch('/api/mt5/admin/migrate-region', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
            body: JSON.stringify(body),
          });
          var j = await r.json();
          out.textContent = 'HTTP ' + r.status + '\\n\\n' + JSON.stringify(j, null, 2);
        } catch (err) {
          out.textContent = 'Network error: ' + err.message;
        } finally {
          btn.disabled = false; btn.textContent = 'MIGRATE ACCOUNT';
        }
      });

      // Reset password (per-user button in the Users table)
      document.querySelectorAll('.resetPwBtn').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var email = btn.getAttribute('data-email');
          var name = btn.getAttribute('data-name');
          var pw = prompt('Reset password for ' + name + ' (' + email + ')\n\nEnter a new password (min 8 characters):');
          if (!pw) return;
          if (pw.length < 8) { alert('Password must be at least 8 characters.'); return; }
          var orig = btn.textContent; btn.disabled = true; btn.textContent = 'Resetting…';
          try {
            var r = await fetch('/api/admin/users/reset-password?key=' + encodeURIComponent(key), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: email, newPassword: pw }),
            });
            var j = await r.json();
            if (r.ok && j.ok) {
              alert('Password reset for ' + email + '.\nNew password: ' + pw + '\n\nShare it with them securely.');
            } else {
              alert('Reset failed: ' + (j.error || ('HTTP ' + r.status)));
            }
          } catch (err) {
            alert('Network error: ' + err.message);
          } finally {
            btn.disabled = false; btn.textContent = orig;
          }
        });
      });

      // Clear all login lockouts
      var clearBtn = document.getElementById('clearLockoutsBtn');
      var clearOut = document.getElementById('clearLockoutsResult');
      if (clearBtn) {
        clearBtn.addEventListener('click', async function() {
          clearBtn.disabled = true; var orig = clearBtn.textContent; clearBtn.textContent = 'CLEARING…';
          clearOut.style.display = 'block'; clearOut.textContent = 'Sending request...';
          try {
            var r = await fetch('/api/admin/reset-lockouts?key=' + encodeURIComponent(key), { method: 'POST' });
            var j = await r.json();
            clearOut.textContent = 'HTTP ' + r.status + '\\n\\n' + JSON.stringify(j, null, 2);
          } catch (err) {
            clearOut.textContent = 'Network error: ' + err.message;
          } finally {
            clearBtn.disabled = false; clearBtn.textContent = orig;
          }
        });
      }
    })();
  </script>

  <div class="section">
    <h2>Support Requests <span class="badge">${tickets.length}</span></h2>
    <table>
      <thead><tr><th>Name</th><th>Account</th><th>Message</th><th>Submitted</th></tr></thead>
      <tbody>${ticketRows}</tbody>
    </table>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error("[admin] error:", (err as Error).message);
    res.status(500).send("Internal server error");
  }
});

router.post("/reset-lockouts", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const result = await resetAuthLockouts();
  if (result.ok) {
    res.json({ ok: true, message: "All login lockouts cleared. Users can log in immediately." });
  } else {
    res.status(500).json({ ok: false, error: result.error ?? "Rate-limit store does not support resetAll", method: result.method });
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
    res.json({ ok: true, user: updated, message: "Password reset. Share the new password with the user securely." });
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default router;
