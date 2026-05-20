import { Router, type IRouter, type Request, type Response } from "express";
import { db, storedAccountsTable, supportTicketsTable, usersTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const router: IRouter = Router();

const ADMIN_KEY = process.env["ADMIN_KEY"] ?? "changeme";

function requireAdminKey(req: Request, res: Response): boolean {
  const key = (req.query["key"] as string | undefined) ?? "";
  if (key !== ADMIN_KEY) {
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
      ? `<tr><td colspan="4" class="empty">No users registered yet</td></tr>`
      : registeredUsers.map(u => {
          const hasMt5 = connectedAccounts.some(a => a.userId === String(u.id));
          return `
        <tr>
          <td><strong>${escapeHtml(u.fullName ?? "—")}</strong></td>
          <td class="mono muted">${escapeHtml(u.email)}</td>
          <td>${hasMt5 ? '<span class="green">✓ Connected</span>' : '<span class="muted">Not connected</span>'}</td>
          <td class="muted">${formatDate(u.createdAt?.getTime())}</td>
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
          <td>${t.name}</td>
          <td class="mono">${t.accountNumber ?? "—"}</td>
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
      <thead><tr><th>Full Name</th><th>Email</th><th>MT5 Status</th><th>Joined</th></tr></thead>
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
