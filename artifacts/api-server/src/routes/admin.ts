import { Router, type IRouter, type Request, type Response } from "express";
import { db, storedAccountsTable, supportTicketsTable } from "@workspace/db";
import { desc } from "drizzle-orm";

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

router.get("/admin", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;

  try {
    const [users, tickets] = await Promise.all([
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
    `;

    const usersRows = users.length === 0
      ? `<tr><td colspan="4" class="empty">No users connected yet</td></tr>`
      : users.map(u => `
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
    <h2>Active Users <span class="badge">${users.length}</span></h2>
    <table>
      <thead><tr><th>MT5 Account ID</th><th>Clerk User ID</th><th>Region</th><th>Connected</th></tr></thead>
      <tbody>${usersRows}</tbody>
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default router;
