import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import {
  db,
  pool,
  storedAccountsTable,
  supportTicketsTable,
  usersTable,
  cascadeZonesTable,
  waitlistTable,
  type StoredAccount,
} from "@workspace/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { resetAuthLockouts } from "../lib/rateLimiters";
import { getStreamHealth, getZoneCounts, listProvisioningAccounts, disconnectUserMt5 } from "./mt5";
import { getTelemetry } from "../telemetry";
import { ADMIN_PAGE_CSS, APP_THEME } from "../lib/appTheme";
import { renderAdminDashboard } from "../lib/adminDashboardPage";
import { isSmokeTestUser } from "../lib/smokeUsers";
import {
  getPlatformFlags,
  updatePlatformFlags,
  logAdminAction,
} from "../lib/platformFlags";

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

function startOfUtcDayMs(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

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
    const flags = getPlatformFlags();
    const todayStart = startOfUtcDayMs();
    const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

    const [allUsers, allAccounts, tickets, waitlist, provMap, health, zones] = await Promise.all([
      db.select().from(usersTable).orderBy(desc(usersTable.createdAt)),
      db.select().from(storedAccountsTable).orderBy(desc(storedAccountsTable.storedAt)),
      db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.createdAt)),
      db.select().from(waitlistTable).orderBy(desc(waitlistTable.createdAt)),
      listProvisioningAccounts().catch(() => new Map()),
      Promise.resolve(getStreamHealth()),
      Promise.resolve(getZoneCounts()),
    ]);

    let dbOk = false;
    try {
      await pool.query("SELECT 1");
      dbOk = true;
    } catch { /* ignore */ }

    const smokeUsers = allUsers.filter(isSmokeTestUser);
    const realUsers = hideTest ? allUsers.filter((u) => !isSmokeTestUser(u)) : allUsers;
    const latestByUser = latestAccountByUserId(allAccounts);

    const streamByAccount = new Map<string, StreamSnap>();
    for (const a of health.accounts) {
      streamByAccount.set(a.accountId, { stale: a.stale, silentForSec: a.silentForSec });
    }

    let liveStreamsReal = 0;
    for (const u of realUsers) {
      const link = latestByUser.get(String(u.id));
      if (!link) continue;
      const s = streamByAccount.get(link.accountId);
      if (s && !s.stale) liveStreamsReal += 1;
    }

    const signupsToday = realUsers.filter((u) => new Date(u.createdAt).getTime() >= todayStart).length;
    const signupsWeek = realUsers.filter((u) => new Date(u.createdAt).getTime() >= weekStart).length;
    const unreadSupport = tickets.filter((t) => t.status === "unread").length;

    const clientRows = realUsers.map((u) => {
      const link = latestByUser.get(String(u.id));
      const mt5 = resolveMt5Identity(link, provMap);
      const stream = streamForAccount(link?.accountId, streamByAccount);
      const locked = u.locked ? '<span class="danger">LOCKED</span>' : '<span class="success">Active</span>';
      return `
        <tr data-search="${escapeHtml(`${u.fullName} ${u.email} ${mt5.login} ${mt5.server}`.toLowerCase())}">
          <td><strong>${escapeHtml(u.fullName ?? "—")}</strong></td>
          <td class="mono muted">${escapeHtml(u.email)}</td>
          <td class="mono">${escapeHtml(mt5.login)}</td>
          <td class="tag" title="${escapeHtml(mt5.server)}">${escapeHtml(mt5.server.length > 24 ? mt5.server.slice(0, 22) + "…" : mt5.server)}</td>
          <td class="${stream.className}">${escapeHtml(stream.label)}</td>
          <td>${locked}</td>
          <td class="row-actions">
            <button type="button" class="btn manage-user-btn" data-id="${u.id}" data-email="${escapeHtml(u.email)}"
              data-name="${escapeHtml(u.fullName ?? u.email)}" data-locked="${u.locked ? "1" : "0"}">Manage</button>
          </td>
        </tr>`;
    }).join("");

    const supportRows = tickets.length === 0
      ? `<tr><td colspan="5" class="empty">No messages</td></tr>`
      : tickets.slice(0, 50).map((t) => `
        <tr>
          <td>${escapeHtml(t.name)}</td>
          <td class="mono muted">${escapeHtml(t.email ?? "—")}</td>
          <td class="query">${escapeHtml(t.query)}</td>
          <td class="muted">${formatDate(t.createdAt)}</td>
          <td>
            <span class="tag">${escapeHtml(t.status)}</span>
            ${t.status !== "resolved" ? `<button class="btn support-read" data-id="${t.id}">Read</button>` : ""}
            ${t.status !== "resolved" ? `<button class="btn support-resolve" data-id="${t.id}">Resolve</button>` : ""}
          </td>
        </tr>`).join("");

    const waitlistRows = waitlist.length === 0
      ? ""
      : waitlist.slice(0, 30).map((w) => `
        <tr><td class="mono muted">${escapeHtml(w.email)}</td><td class="muted">${formatDate(w.createdAt)}</td></tr>`).join("");

    const testToggleHref = hideTest
      ? `/api/admin?key=${encodeURIComponent(key)}&hide_test=0`
      : `/api/admin?key=${encodeURIComponent(key)}&hide_test=1`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderAdminDashboard({
      key,
      hideTest,
      flags,
      stats: {
        realUsers: realUsers.length,
        linked: realUsers.filter((u) => latestByUser.has(String(u.id))).length,
        liveStreams: liveStreamsReal,
        signupsToday,
        signupsWeek,
        openZones: zones.open,
        unreadSupport,
        waitlistCount: waitlist.length,
        smokeHidden: hideTest ? smokeUsers.length : 0,
      },
      health: {
        backend: true,
        database: dbOk,
        metaapi: Boolean(process.env.METAAPI_TOKEN ?? process.env.META_API_TOKEN),
        streamsHealthy: health.healthy,
        liveStreamCount: health.accounts.filter((a) => !a.stale).length,
      },
      clientRowsHtml: clientRows || '<tr><td colspan="7" class="empty">No clients yet</td></tr>',
      supportRowsHtml: supportRows,
      waitlistRowsHtml: waitlistRows,
      smokePurgeCount: smokeUsers.length,
      testToggleHref,
      testToggleLabel: hideTest ? "Show smoke-test users" : "Hide smoke-test users",
      publicAppUrl: process.env.PUBLIC_APP_URL?.trim() || "https://workspaceapi-server-production-4768.up.railway.app",
    }));
  } catch (err) {
    console.error("[admin] error:", (err as Error).message);
    res.status(500).send("Internal server error");
  }
});

router.post("/settings/trading", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const { tradingPaused, tradingPauseMessage } = req.body ?? {};
  const flags = getPlatformFlags();
  const nextPaused = typeof tradingPaused === "boolean" ? tradingPaused : !flags.tradingPaused;
  await updatePlatformFlags({
    tradingPaused: nextPaused,
    tradingPauseMessage: typeof tradingPauseMessage === "string" && tradingPauseMessage.trim()
      ? tradingPauseMessage.trim()
      : flags.tradingPauseMessage,
  });
  logAdminAction("trading_pause", { tradingPaused: nextPaused });
  res.json({ ok: true, tradingPaused: nextPaused });
});

router.post("/settings/membership", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const { membershipCap, inviteOnly, inviteCode, signupsOpen } = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof membershipCap === "number" && membershipCap >= 1) patch.membershipCap = membershipCap;
  if (typeof inviteOnly === "boolean") patch.inviteOnly = inviteOnly;
  if (inviteCode === null || typeof inviteCode === "string") patch.inviteCode = inviteCode || null;
  if (typeof signupsOpen === "boolean") patch.signupsOpen = signupsOpen;
  const updated = await updatePlatformFlags(patch);
  logAdminAction("membership_settings", patch);
  res.json({ ok: true, flags: updated });
});

router.get("/users/:userId/detail", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const userId = String(req.params.userId);
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, Number(userId))).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const accounts = await db.select().from(storedAccountsTable).where(eq(storedAccountsTable.userId, userId));
    const zones = await db.select().from(cascadeZonesTable)
      .where(eq(cascadeZonesTable.userId, userId))
      .orderBy(desc(cascadeZonesTable.createdAt))
      .limit(20);
    res.json({
      user: { id: user.id, email: user.email, fullName: user.fullName, locked: user.locked, lockedReason: user.lockedReason, createdAt: user.createdAt },
      mt5Accounts: accounts,
      recentZones: zones,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/users/:userId/lock", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const userId = Number(req.params.userId);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Locked by admin";
  await db.update(usersTable).set({ locked: true, lockedReason: reason }).where(eq(usersTable.id, userId));
  logAdminAction("user_lock", { userId, reason });
  res.json({ ok: true });
});

router.post("/users/:userId/unlock", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const userId = Number(req.params.userId);
  await db.update(usersTable).set({ locked: false, lockedReason: null }).where(eq(usersTable.id, userId));
  logAdminAction("user_unlock", { userId });
  res.json({ ok: true });
});

router.delete("/users/:userId", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const userId = String(req.params.userId);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, Number(userId))).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (isSmokeTestUser(user)) {
    res.status(400).json({ error: "Use purge smoke-test for test accounts." });
    return;
  }
  await disconnectUserMt5(userId);
  await db.delete(usersTable).where(eq(usersTable.id, user.id));
  logAdminAction("user_delete", { userId, email: user.email });
  res.json({ ok: true, message: `Deleted ${user.email}` });
});

router.post("/users/:userId/disconnect-mt5", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const userId = String(req.params.userId);
  const n = await disconnectUserMt5(userId);
  logAdminAction("mt5_disconnect", { userId, accounts: n });
  res.json({ ok: true, message: `Disconnected ${n} account(s).` });
});

router.post("/support/:ticketId/read", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  await db.update(supportTicketsTable).set({ status: "read" }).where(eq(supportTicketsTable.id, Number(req.params.ticketId)));
  res.json({ ok: true });
});

router.post("/support/:ticketId/resolve", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  await db.update(supportTicketsTable).set({ status: "resolved" }).where(eq(supportTicketsTable.id, Number(req.params.ticketId)));
  res.json({ ok: true });
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
    for (const u of smoke) {
      await disconnectUserMt5(String(u.id));
    }
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
    logAdminAction("purge_smoke", { count: smoke.length });
    res.json({ ok: true, deletedUsers: smoke.length, message: `Removed ${smoke.length} smoke-test user(s).` });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/reset-lockouts", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const result = await resetAuthLockouts();
  logAdminAction("reset_lockouts", {});
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
    logAdminAction("reset_password", { email });
    res.json({ ok: true, user: updated, message: "Password reset." });
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
    flags: getPlatformFlags(),
  });
});

export default router;
