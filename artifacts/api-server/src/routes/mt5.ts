import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { createRequire } from "module";
import { db, pool, cascadeConfigTable, storedAccountsTable, cascadeHistoryTable, cascadeOrdersTable, cascadeZonesTable, zonePositionsTable, zoneOrdersTable, notificationPrefsTable, usersTable } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { JWT_SECRET } from "./auth";
import { getTradingStatus } from "../lib/platformFlags";
import { logEvent } from "../logger";
import { usdToTargetRate } from "../lib/usdFx.js";
// Force the CJS/Node build — the ESM entry in package.json is a browser-only bundle.
// In dev (tsx/ESM) import.meta.url is the real file URL.
// In production (esbuild CJS) build.ts injects a __importMetaUrl banner and
// defines import.meta.url → __importMetaUrl so this line still resolves correctly.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _MetaApiCjs = _require("metaapi.cloud-sdk") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MetaApi: any = _MetaApiCjs.default ?? _MetaApiCjs;

const router: IRouter = Router();

// ── Auth middleware ──────────────────────────────────────────────────────────
// userId → accountId in-memory ownership cache. Populated on /connect.
const userAccountCache = new Map<string, string>(); // userId → accountId

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { sub: string };
    const userId = payload.sub;
    const [user] = await db.select({ locked: usersTable.locked })
      .from(usersTable)
      .where(eq(usersTable.id, Number(userId)))
      .limit(1);
    if (user?.locked) {
      res.status(403).json({ error: "Your account is locked. Contact support." });
      return;
    }
    (req as unknown as Record<string, unknown>)["userId"] = userId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
}

async function checkOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as unknown as Record<string, unknown>)["userId"] as string;
  const accountId = req.params["accountId"] as string;
  if (!accountId || !userId) { next(); return; }

  // Fast path: in-memory cache — only trust the cache when it matches.
  // On mismatch fall through to the DB so a reconnect with a new accountId
  // (after re-provisioning) is not permanently blocked by a stale cache entry.
  const cachedId = userAccountCache.get(userId);
  if (cachedId === accountId) { next(); return; }

  // DB check: verify this specific accountId is owned by this user.
  // Querying by both columns avoids false denials caused by the user having
  // multiple account rows or the cache holding an older accountId.
  try {
    const [row] = await db.select().from(storedAccountsTable)
      .where(and(
        eq(storedAccountsTable.userId, userId),
        eq(storedAccountsTable.accountId, accountId),
      ))
      .limit(1);
    if (!row) {
      console.warn(`[checkOwner] userId=${userId} does not own accountId=${accountId}`);
      res.status(403).json({ error: "Forbidden" }); return;
    }
    userAccountCache.set(userId, accountId); // refresh cache with confirmed value
    next();
  } catch (err) {
    // DB error — fail closed, do not allow access
    console.error("[checkOwner] DB error:", (err as Error).message);
    res.status(503).json({ error: "Authorization check failed, please retry." });
  }
}

// Admin-key-protected endpoint — registered BEFORE requireAuth so it does
// not require a JWT (it has its own x-admin-key check). The handler is a
// hoisted async function declared further down in this file.
router.post("/mt5/admin/migrate-region", (req, res) => { void migrateRegionHandler(req, res); });

router.use(requireAuth);

// ── MetaAPI Streaming Manager ────────────────────────────────────────────────
// Maintains one SDK streaming connection per account and stores incoming deal
// events in a short-TTL ring buffer so the app can poll for them.

interface DealEvent {
  dealId: string;
  positionId: string;
  symbol: string;
  type: string;       // "DEAL_TYPE_BUY" | "DEAL_TYPE_SELL"
  entryType: string;  // "DEAL_ENTRY_IN" for new positions
  openPrice: number;
  volume: number;
  comment?: string;
  time: number;       // ms epoch when we received it
  autoCascade?: boolean;     // true if auto-cascade placed limits for this deal
  autoCascadeCount?: number; // number of limit orders placed by auto-cascade
}

const dealStore = new Map<string, DealEvent[]>(); // accountId → recent deals
const activeStreams = new Set<string>();           // accountIds with live connections
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeConnections = new Map<string, any>(); // accountId → StreamingMetaApiConnectionInstance (for SDK trades)
const activeRegions = new Map<string, string>();  // accountId → region (used for REST fallback in auto-cascade)

// ── In-memory account registry ────────────────────────────────────────────────
// Mirrors the stored_accounts table in memory. Seeded at startup from DB, then
// kept up-to-date whenever an account connects. The watchdog and safety-net use
// this as their primary source so a DB blip can NEVER knock out SL coverage.
interface KnownAccount { accountId: string; userId?: string; region: string; }
const knownAccounts = new Map<string, KnownAccount>(); // accountId → KnownAccount
let sdkInstance: InstanceType<typeof MetaApi> | null = null;

/** Idempotent — safe when drizzle push was skipped (RF history columns). */
let cascadeRfColumnsReady: Promise<void> | null = null;
export async function ensureCascadeZoneRfColumns(): Promise<void> {
  if (!cascadeRfColumnsReady) {
    cascadeRfColumnsReady = pool.query(`
      ALTER TABLE cascade_zones
        ADD COLUMN IF NOT EXISTS went_risk_free BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS risk_free_sl_exit BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS risk_free_offset INTEGER NOT NULL DEFAULT 0;
    `).then(() => undefined).catch((e) => {
      cascadeRfColumnsReady = null;
      throw e;
    });
  }
  await cascadeRfColumnsReady;
}

let cascadeRunnerColumnsReady: Promise<void> | null = null;
export async function ensureCascadeZoneRunnerColumns(): Promise<void> {
  if (!cascadeRunnerColumnsReady) {
    cascadeRunnerColumnsReady = pool.query(`
      ALTER TABLE cascade_zones
        ADD COLUMN IF NOT EXISTS runner1_price DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS runner1_lots DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS runner2_price DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS runner2_lots DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS runner3_price DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS runner3_lots DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS runner1_hit BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS runner2_hit BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS runner3_hit BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS runner1_auto BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS runner2_auto BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS runner3_auto BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS runner_active BOOLEAN NOT NULL DEFAULT FALSE;
    `).then(() => undefined).catch((e) => {
      cascadeRunnerColumnsReady = null;
      throw e;
    });
  }
  await cascadeRunnerColumnsReady;
}

async function upsertStoredAccount(params: {
  accountId: string;
  region: string;
  userId?: string | null;
  mt5Login?: string | null;
  mt5Server?: string | null;
}): Promise<void> {
  const now = Date.now();
  const set: {
    region: string;
    storedAt: number;
    userId?: string;
    mt5Login?: string;
    mt5Server?: string;
  } = { region: params.region, storedAt: now };
  if (params.userId) set.userId = params.userId;
  if (params.mt5Login) set.mt5Login = params.mt5Login;
  if (params.mt5Server) set.mt5Server = params.mt5Server;
  await db.insert(storedAccountsTable)
    .values({
      accountId: params.accountId,
      region: params.region,
      storedAt: now,
      userId: params.userId ?? undefined,
      mt5Login: params.mt5Login ?? undefined,
      mt5Server: params.mt5Server ?? undefined,
    })
    .onConflictDoUpdate({
      target: storedAccountsTable.accountId,
      set,
    });
}

// ── Cascade Config ────────────────────────────────────────────────────────────
// Persisted to DB, keyed per trading account.
// The empty-string key "" represents the global (account-agnostic) config.
// The app syncs these whenever the user changes settings.

interface CascadeConfig {
  enabled: boolean;
  numPositions: number;
  pipsBetween: number;
  slPips: number;
  tp1Pips: number;
  tp2Pips: number;
  tp3Pips: number;
  tp4Pips: number;
  tp1Pct: number;
  tp2Pct: number;
  tp3Pct: number;
  tp4Pct: number;
  tp1Enabled: boolean;
  tp2Enabled: boolean;
  tp3Enabled: boolean;
  tp4Enabled: boolean;
  riskFreePips: number;
  autoBeAtTp: number;
  takeProfitEnabled: boolean;
  takeProfitPips: number;
}

const CASCADE_DEFAULTS: CascadeConfig = {
  enabled: false,
  numPositions: 3,
  pipsBetween: 10,
  slPips: 100,
  tp1Pips: 20,
  tp2Pips: 50,
  tp3Pips: 90,
  tp4Pips: 0,
  tp1Pct: 25,
  tp2Pct: 25,
  tp3Pct: 25,
  tp4Pct: 25,
  tp1Enabled: true,
  tp2Enabled: true,
  tp3Enabled: true,
  tp4Enabled: true,
  riskFreePips: -10,
  autoBeAtTp: 2,
  takeProfitEnabled: false,
  takeProfitPips: 30,
};

// In-memory cache: accountId (or "" for global) → config.
const cascadeConfigs = new Map<string, CascadeConfig>();

function getCascadeConfig(accountId: string, userId?: string): CascadeConfig {
  if (userId && cascadeConfigs.has(userId)) return cascadeConfigs.get(userId)!;
  return cascadeConfigs.get(accountId) ?? cascadeConfigs.get("") ?? { ...CASCADE_DEFAULTS };
}

// Attempt a single load from the database; throws on failure.
async function attemptLoadCascadeConfig(): Promise<void> {
  const [rows, accounts] = await Promise.all([
    db.select().from(cascadeConfigTable),
    db.select().from(storedAccountsTable),
  ]);
  if (rows.length > 0) {
    // Build userId → MetaAPI accountId map so we can cross-populate the cache.
    const userToAccount = new Map<string, string>();
    for (const acct of accounts) {
      if (acct.userId && acct.accountId) userToAccount.set(acct.userId, acct.accountId);
    }
    for (const row of rows) {
      const key = row.accountId ?? "";
      const r = row as typeof row & {
        tp4Pips?: number; tp1Pct?: number; tp2Pct?: number; tp3Pct?: number; tp4Pct?: number;
        tp1Enabled?: boolean; tp2Enabled?: boolean; tp3Enabled?: boolean; tp4Enabled?: boolean;
        riskFreePips?: number; autoBeAtTp?: number;
        takeProfitEnabled?: boolean; takeProfitPips?: number;
      };
      const cfg: CascadeConfig = {
        enabled:           row.enabled,
        numPositions:      row.numPositions,
        pipsBetween:       row.pipsBetween,
        slPips:            row.slPips,
        tp1Pips:           row.tp1Pips,
        tp2Pips:           row.tp2Pips,
        tp3Pips:           row.tp3Pips,
        tp4Pips:           r.tp4Pips ?? CASCADE_DEFAULTS.tp4Pips,
        tp1Pct:            r.tp1Pct ?? CASCADE_DEFAULTS.tp1Pct,
        tp2Pct:            r.tp2Pct ?? CASCADE_DEFAULTS.tp2Pct,
        tp3Pct:            r.tp3Pct ?? CASCADE_DEFAULTS.tp3Pct,
        tp4Pct:            r.tp4Pct ?? CASCADE_DEFAULTS.tp4Pct,
        tp1Enabled:        r.tp1Enabled ?? CASCADE_DEFAULTS.tp1Enabled,
        tp2Enabled:        r.tp2Enabled ?? CASCADE_DEFAULTS.tp2Enabled,
        tp3Enabled:        r.tp3Enabled ?? CASCADE_DEFAULTS.tp3Enabled,
        tp4Enabled:        r.tp4Enabled ?? CASCADE_DEFAULTS.tp4Enabled,
        riskFreePips:      r.riskFreePips ?? CASCADE_DEFAULTS.riskFreePips,
        autoBeAtTp:        r.autoBeAtTp ?? CASCADE_DEFAULTS.autoBeAtTp,
        takeProfitEnabled: r.takeProfitEnabled ?? CASCADE_DEFAULTS.takeProfitEnabled,
        takeProfitPips:    r.takeProfitPips ?? CASCADE_DEFAULTS.takeProfitPips,
      };
      cascadeConfigs.set(key, cfg);
      // Also cache under the MetaAPI accountId so the auto-cascade background
      // loop (which only knows MetaAPI accountId) can find the right config
      // after a server restart without waiting for the user to re-save settings.
      const metaApiId = userToAccount.get(key);
      if (metaApiId) cascadeConfigs.set(metaApiId, cfg);
    }
    console.log(`[cascade-config] loaded ${rows.length} row(s) from db`);
  } else {
    // Seed the global default row so future upserts work correctly.
    await db.insert(cascadeConfigTable).values({ accountId: "", ...CASCADE_DEFAULTS }).onConflictDoNothing();
    cascadeConfigs.set("", { ...CASCADE_DEFAULTS });
    console.log("[cascade-config] seeded global defaults into db");
  }
}

// Exported so index.ts can await it before the server begins accepting requests,
// eliminating the startup race where GET /cascade-config returns defaults.
// Retries up to 3 times with exponential back-off before falling back to defaults.
// If CASCADE_CONFIG_OVERRIDE is set it is used directly, bypassing the database.
export async function loadCascadeConfig(): Promise<void> {
  // Environment-variable override: useful for zero-DB-dependency deployments.
  const override = process.env.CASCADE_CONFIG_OVERRIDE;
  if (override) {
    try {
      const parsed = JSON.parse(override) as Partial<CascadeConfig>;
      cascadeConfigs.set("", { ...CASCADE_DEFAULTS, ...parsed });
      console.log("[cascade-config] loaded config from CASCADE_CONFIG_OVERRIDE env var");
      return;
    } catch (err) {
      console.warn("[cascade-config] CASCADE_CONFIG_OVERRIDE is not valid JSON, ignoring:", (err as Error).message);
    }
  }

  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 500;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await attemptLoadCascadeConfig();
      return; // success
    } catch (err) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      if (isLastAttempt) {
        console.warn(
          `[cascade-config] all ${MAX_ATTEMPTS} attempts to load from db failed, using defaults:`,
          (err as Error).message,
        );
      } else {
        const delayMs = BASE_DELAY_MS * attempt;
        console.warn(
          `[cascade-config] attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${delayMs}ms:`,
          (err as Error).message,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

// Pure helper: validate and merge a PUT /cascade-config request body against the
// current persisted config. Returns either the next config to save, or a 400
// response payload explaining what was rejected.
// Exported so regression tests can lock the TP-ordering rule in (it was once
// unenforced, allowing TP2 < TP1 / TP3 < TP2 to reach the staged-exit logic).
export type CascadeConfigUpdateResult =
  | { ok: true; config: CascadeConfig }
  | { ok: false; status: 400; body: { error: string; tp1Pips: number; tp2Pips: number; tp3Pips: number } };

export function buildCascadeConfigUpdate(
  body: Partial<CascadeConfig> | null | undefined,
  current: CascadeConfig,
): CascadeConfigUpdateResult {
  const b = body ?? {};
  const pickBool = (v: unknown, cur: boolean) => typeof v === "boolean" ? v : cur;
  const pickNum = (v: unknown, cur: number) => typeof v === "number" && Number.isFinite(v) ? v : cur;
  const pickPct = (v: unknown, cur: number) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return cur;
    return Math.min(100, Math.max(0, Math.round(v)));
  };
  const nextConfig: CascadeConfig = {
    enabled:      pickBool(b.enabled, current.enabled),
    numPositions: pickNum(b.numPositions, current.numPositions),
    pipsBetween:  pickNum(b.pipsBetween, current.pipsBetween),
    slPips:       pickNum(b.slPips, current.slPips),
    tp1Pips:      typeof b.tp1Pips === "number" && b.tp1Pips > 0 ? Math.round(b.tp1Pips) : current.tp1Pips,
    tp2Pips:      typeof b.tp2Pips === "number" && b.tp2Pips > 0 ? Math.round(b.tp2Pips) : current.tp2Pips,
    tp3Pips:      typeof b.tp3Pips === "number" && b.tp3Pips > 0 ? Math.round(b.tp3Pips) : current.tp3Pips,
    tp4Pips:      typeof b.tp4Pips === "number" && b.tp4Pips >= 0 ? Math.round(b.tp4Pips) : current.tp4Pips,
    tp1Pct:       pickPct(b.tp1Pct, current.tp1Pct),
    tp2Pct:       pickPct(b.tp2Pct, current.tp2Pct),
    tp3Pct:       pickPct(b.tp3Pct, current.tp3Pct),
    tp4Pct:       pickPct(b.tp4Pct, current.tp4Pct),
    tp1Enabled:   pickBool(b.tp1Enabled, current.tp1Enabled),
    tp2Enabled:   pickBool(b.tp2Enabled, current.tp2Enabled),
    tp3Enabled:   pickBool(b.tp3Enabled, current.tp3Enabled),
    tp4Enabled:   pickBool(b.tp4Enabled, current.tp4Enabled),
    riskFreePips: sanitizeRiskFreePips(b.riskFreePips ?? current.riskFreePips),
    autoBeAtTp:   (() => {
      const n = typeof b.autoBeAtTp === "number" ? b.autoBeAtTp : current.autoBeAtTp;
      if (n === 3) return 3;
      if (n === 1 || n === 2) return 2;
      return current.autoBeAtTp === 3 ? 3 : 2;
    })(),
    takeProfitEnabled: pickBool(b.takeProfitEnabled, current.takeProfitEnabled),
    takeProfitPips:    typeof b.takeProfitPips === "number" && b.takeProfitPips > 0
      ? Math.round(b.takeProfitPips) : current.takeProfitPips,
  };
  // Enforce strict ordering: TP1 < TP2 < TP3 (zone TP stages must fire in sequence).
  if (!(nextConfig.tp1Pips < nextConfig.tp2Pips && nextConfig.tp2Pips < nextConfig.tp3Pips)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Take Profit levels must be strictly increasing (TP1 < TP2 < TP3)",
        tp1Pips: nextConfig.tp1Pips,
        tp2Pips: nextConfig.tp2Pips,
        tp3Pips: nextConfig.tp3Pips,
      },
    };
  }
  if (nextConfig.tp4Pips > 0 && !(nextConfig.tp4Pips > nextConfig.tp3Pips)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "TP4 must be 0 (manual) or strictly greater than TP3",
        tp1Pips: nextConfig.tp1Pips,
        tp2Pips: nextConfig.tp2Pips,
        tp3Pips: nextConfig.tp3Pips,
      },
    };
  }
  return { ok: true, config: nextConfig };
}

// Returns true on success, false on DB failure.
// accountId="" means the global (fallback) config.
async function saveCascadeConfig(config: CascadeConfig, accountId: string): Promise<boolean> {
  try {
    await db.insert(cascadeConfigTable)
      .values({ accountId, ...config })
      .onConflictDoUpdate({
        target: cascadeConfigTable.accountId,
        set: {
          enabled:           config.enabled,
          numPositions:      config.numPositions,
          pipsBetween:       config.pipsBetween,
          slPips:            config.slPips,
          tp1Pips:           config.tp1Pips,
          tp2Pips:           config.tp2Pips,
          tp3Pips:           config.tp3Pips,
          tp4Pips:           config.tp4Pips,
          tp1Pct:            config.tp1Pct,
          tp2Pct:            config.tp2Pct,
          tp3Pct:            config.tp3Pct,
          tp4Pct:            config.tp4Pct,
          tp1Enabled:        config.tp1Enabled,
          tp2Enabled:        config.tp2Enabled,
          tp3Enabled:        config.tp3Enabled,
          tp4Enabled:        config.tp4Enabled,
          riskFreePips:      config.riskFreePips,
          autoBeAtTp:        config.autoBeAtTp,
          takeProfitEnabled: config.takeProfitEnabled,
          takeProfitPips:    config.takeProfitPips,
        },
      });
    return true;
  } catch (err) {
    console.error("[cascade-config] failed to save to db:", (err as Error).message);
    return false;
  }
}

const PIP = 0.10;

function buildCascadeLevels(
  marketPrice: number,
  direction: "buy" | "sell",
  config: CascadeConfig
): { limitEntries: number[]; stopLoss: number } {
  const step = config.pipsBetween * PIP;
  const slDist = config.slPips * PIP;
  const limitEntries: number[] = [];
  for (let i = 1; i < config.numPositions; i++) {
    const price = direction === "buy"
      ? parseFloat((marketPrice - i * step).toFixed(2))
      : parseFloat((marketPrice + i * step).toFixed(2));
    limitEntries.push(price);
  }
  const stopLoss = direction === "buy"
    ? parseFloat((marketPrice - slDist).toFixed(2))
    : parseFloat((marketPrice + slDist).toFixed(2));
  return { limitEntries, stopLoss };
}

function getSdk(token: string): InstanceType<typeof MetaApi> {
  if (!sdkInstance) sdkInstance = new MetaApi(token);
  return sdkInstance;
}

function storeDealEvent(accountId: string, evt: DealEvent) {
  const cutoff = Date.now() - 60_000;
  const arr = (dealStore.get(accountId) ?? []).filter(e => e.time > cutoff);
  // Dedup: MetaAPI may fire the same deal from multiple streaming instances
  if (arr.some(e => e.dealId === evt.dealId)) return;
  arr.push(evt);
  dealStore.set(accountId, arr.slice(-100));
}

function getEventsSince(accountId: string, since: number): DealEvent[] {
  return (dealStore.get(accountId) ?? []).filter(e => e.time > since);
}

// Tracks accountIds where an app-initiated market order is currently in-flight.
// The deal event from MetaAPI's stream arrives before the SDK trade call resolves,
// so we can't rely on positionId pre-marking alone — the deal fires BEFORE we call
// markCascaded. Setting this flag synchronously before the SDK call closes the race.
const pendingAppCascades = new Set<string>();

// Tracks orderIds of limit orders placed by our cascade logic.
// When those orders fill (volatile market), their deals arrive with deal.orderId set.
// We must NOT re-cascade those fills — even if the broker stripped the comment.
// Persisted to the cascade_orders DB table so it survives server restarts —
// without this, every deploy/restart leaves previously-placed limits "unknown"
// and their fills get re-cascaded as if they were brand-new user trades.
const cascadePlacedOrderIds = new Set<string>();
function trackCascadeOrder(accountId: string, orderId: string | undefined): void {
  if (!orderId) return;
  if (cascadePlacedOrderIds.has(orderId)) return;
  cascadePlacedOrderIds.add(orderId);
  if (cascadePlacedOrderIds.size > 5000) {
    const first = cascadePlacedOrderIds.values().next().value;
    if (first !== undefined) cascadePlacedOrderIds.delete(first);
  }
  db.insert(cascadeOrdersTable)
    .values({ accountId, orderId, createdAt: Date.now() })
    .onConflictDoNothing()
    .catch((e: Error) => console.error(`[cascade-orders] persist error orderId=${orderId}:`, e.message));
}

// Load persisted cascade order IDs for an account on (re)connect so that
// onDealAdded recognises fills of limits placed in previous sessions.
async function loadCascadeOrders(accountId: string): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(cascadeOrdersTable)
      .where(eq(cascadeOrdersTable.accountId, accountId));
    for (const row of rows) cascadePlacedOrderIds.add(row.orderId);
    if (rows.length > 0) {
      console.log(`[cascade-orders] loaded ${rows.length} previously-placed cascade orderIds for ${accountId}`);
    }
  } catch (e) {
    console.error(`[cascade-orders] load error for ${accountId}:`, (e as Error).message);
  }
}

// Deduplication: MetaAPI connects to two server nodes (london-a and london-b)
// so every deal event arrives twice. Track recently seen deal IDs and drop duplicates.
// Cap raised to 5000 — sync replay can deliver hundreds of historical deals and a
// 500-entry cap caused early entries to be evicted, allowing double-cascades on reconnect.
const seenDealIds = new Set<string>();
function isDuplicate(dealId: string): boolean {
  if (seenDealIds.has(dealId)) return true;
  seenDealIds.add(dealId);
  // Prevent unbounded growth — keep at most 5000 entries
  if (seenDealIds.size > 5000) {
    const first = seenDealIds.values().next().value;
    if (first !== undefined) seenDealIds.delete(first);
  }
  return false;
}

// ── SSE fan-out ────────────────────────────────────────────────────────────────
// Tracks connected SSE clients per accountId. Each entry is a write function
// that pushes a pre-formatted SSE payload string to the HTTP response.
// Entries are removed when the client disconnects (req.on("close")).
const sseClients = new Map<string, Set<(payload: string) => void>>();

function broadcastToAccount(accountId: string, event: string, data: unknown): void {
  const clients = sseClients.get(accountId);
  if (!clients?.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const write of clients) {
    try { write(payload); } catch { /* client gone — cleanup handled on req.close */ }
  }
}

async function mergeZoneHitsFromPositions(
  zoneId: string,
  row: {
    tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; tp4Hit: boolean;
    tp1Enabled?: boolean; tp2Enabled?: boolean; tp3Enabled?: boolean; tp4Enabled?: boolean;
  },
): Promise<{
  tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; tp4Hit: boolean; positionCount: number;
  tp1Enabled: boolean; tp2Enabled: boolean; tp3Enabled: boolean; tp4Enabled: boolean;
}> {
  const tp1Enabled = row.tp1Enabled ?? true;
  const tp2Enabled = row.tp2Enabled ?? true;
  const tp3Enabled = row.tp3Enabled ?? true;
  const tp4Enabled = row.tp4Enabled ?? true;
  const [zoneMeta] = await db.select({ tp4Price: cascadeZonesTable.tp4Price })
    .from(cascadeZonesTable).where(eq(cascadeZonesTable.zoneId, zoneId)).limit(1);
  const tp4Price = zoneMeta?.tp4Price != null ? Number(zoneMeta.tp4Price) : null;
  const posRows = await db.select().from(zonePositionsTable)
    .where(eq(zonePositionsTable.zoneId, zoneId));
  const open = posRows.filter((r) => r.status === "OPEN");
  let tp1Hit = Boolean(row.tp1Hit) || posRows.some((r) => r.tp1Hit);
  let tp2Hit = Boolean(row.tp2Hit) || posRows.some((r) => r.tp2Hit);
  let tp3Hit = Boolean(row.tp3Hit) || posRows.some((r) => r.tp3Hit);
  let tp4Hit = Boolean(row.tp4Hit) || posRows.some((r) => r.tp4Hit);
  const sanitized = sanitizeZoneTpLadder({
    tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
    tp1Hit, tp2Hit, tp3Hit, tp4Hit, tp4Price,
  });
  tp1Hit = sanitized.tp1Hit;
  tp2Hit = sanitized.tp2Hit;
  tp3Hit = sanitized.tp3Hit;
  tp4Hit = sanitized.tp4Hit;
  const persistTp1 = Boolean(row.tp1Hit) || tp1Hit;
  const persistTp2 = Boolean(row.tp2Hit) || tp2Hit;
  const persistTp3 = Boolean(row.tp3Hit) || tp3Hit;
  const persistTp4 = Boolean(row.tp4Hit) || tp4Hit;
  if (persistTp1 !== row.tp1Hit || persistTp2 !== row.tp2Hit || persistTp3 !== row.tp3Hit || persistTp4 !== row.tp4Hit) {
    await db.update(cascadeZonesTable)
      .set({ tp1Hit: persistTp1, tp2Hit: persistTp2, tp3Hit: persistTp3, tp4Hit: persistTp4 })
      .where(eq(cascadeZonesTable.zoneId, zoneId))
      .catch((e: Error) => console.warn(`[zone ${zoneId}] hit-flag sync failed:`, e.message));
    const st = zoneStates.get(zoneId);
    if (st) {
      st.tp1Hit = persistTp1;
      st.tp2Hit = persistTp2;
      st.tp3Hit = persistTp3;
      st.tp4Hit = persistTp4;
    }
  }
  return {
    tp1Hit: persistTp1, tp2Hit: persistTp2, tp3Hit: persistTp3, tp4Hit: persistTp4, positionCount: open.length,
    tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
  };
}

function broadcastZoneUpdate(zoneId: string): void {
  void (async () => {
    const st = zoneStates.get(zoneId);
    const [dbRow] = await db.select().from(cascadeZonesTable)
      .where(eq(cascadeZonesTable.zoneId, zoneId))
      .limit(1);
    if (!st && !dbRow) return;
    const accountId = st?.accountId ?? dbRow!.accountId;
    const base = dbRow ?? {
      status: st!.status,
      tp1Hit: st!.tp1Hit, tp2Hit: st!.tp2Hit, tp3Hit: st!.tp3Hit, tp4Hit: st!.tp4Hit,
      tp1Enabled: st!.tp1Enabled, tp2Enabled: st!.tp2Enabled, tp3Enabled: st!.tp3Enabled, tp4Enabled: st!.tp4Enabled,
    };
    const merged = await mergeZoneHitsFromPositions(zoneId, {
      tp1Hit: Boolean(base.tp1Hit),
      tp2Hit: Boolean(base.tp2Hit),
      tp3Hit: Boolean(base.tp3Hit),
      tp4Hit: Boolean(base.tp4Hit ?? false),
      tp1Enabled: (base as { tp1Enabled?: boolean }).tp1Enabled,
      tp2Enabled: (base as { tp2Enabled?: boolean }).tp2Enabled,
      tp3Enabled: (base as { tp3Enabled?: boolean }).tp3Enabled,
      tp4Enabled: (base as { tp4Enabled?: boolean }).tp4Enabled,
    });
    const tp4Price = (dbRow as { tp4Price?: number | null } | undefined)?.tp4Price != null
      ? Number((dbRow as { tp4Price: number }).tp4Price)
      : st?.tp4Price ?? null;
    const enabledTpCount = countEnabledTps({
      tp1Enabled: merged.tp1Enabled, tp2Enabled: merged.tp2Enabled,
      tp3Enabled: merged.tp3Enabled, tp4Enabled: merged.tp4Enabled,
      tp4Price,
    });
    const hitEnabledTpCount = countHitEnabledTps({
      tp1Enabled: merged.tp1Enabled, tp2Enabled: merged.tp2Enabled,
      tp3Enabled: merged.tp3Enabled, tp4Enabled: merged.tp4Enabled,
      tp1Hit: merged.tp1Hit, tp2Hit: merged.tp2Hit, tp3Hit: merged.tp3Hit, tp4Hit: merged.tp4Hit,
      tp4Price,
    });
    const dir = (dbRow?.direction ?? st?.direction ?? "buy") as "buy" | "sell";
    const anchor = Number(dbRow?.anchorPrice ?? st?.anchorPrice ?? 0);
    const tp1Price = dbRow?.tp1Price != null ? Number(dbRow.tp1Price) : st?.tp1Price ?? null;
    const tp2Price = dbRow?.tp2Price != null ? Number(dbRow.tp2Price) : st?.tp2Price ?? null;
    const tp3Price = dbRow?.tp3Price != null ? Number(dbRow.tp3Price) : st?.tp3Price ?? null;
    broadcastToAccount(accountId, "zone_update", {
      zoneId,
      direction: dir,
      anchorPrice: anchor,
      tp1Price, tp2Price, tp3Price, tp4Price,
      status: st?.status ?? String(dbRow!.status),
      createdAt: Number(dbRow?.createdAt ?? 0),
      closedAt: dbRow?.closedAt != null ? Number(dbRow.closedAt) : null,
      originalVolume: Number(dbRow?.originalVolume ?? st?.originalVolume ?? 0),
      tp1Pct: Number(dbRow?.tp1Pct ?? st?.tp1Pct ?? 25),
      tp2Pct: Number(dbRow?.tp2Pct ?? st?.tp2Pct ?? 25),
      tp3Pct: Number(dbRow?.tp3Pct ?? st?.tp3Pct ?? 25),
      tp4Pct: Number(dbRow?.tp4Pct ?? st?.tp4Pct ?? 25),
      cashoutDone: Boolean(dbRow?.cashoutDone ?? false),
      tp1Hit: merged.tp1Hit,
      tp2Hit: merged.tp2Hit,
      tp3Hit: merged.tp3Hit,
      tp4Hit: merged.tp4Hit,
      tp1Enabled: merged.tp1Enabled,
      tp2Enabled: merged.tp2Enabled,
      tp3Enabled: merged.tp3Enabled,
      tp4Enabled: merged.tp4Enabled,
      enabledTpCount,
      hitEnabledTpCount,
      positionCount: merged.positionCount,
      tp2SlIsBestEffort: (dbRow as { tp2SlIsBestEffort?: boolean } | undefined)?.tp2SlIsBestEffort
        ?? (st as { tp2SlIsBestEffort?: boolean } | undefined)?.tp2SlIsBestEffort ?? false,
      manualClose: (dbRow as { manualClose?: boolean } | undefined)?.manualClose ?? false,
      slHit: (dbRow as { slHit?: boolean } | undefined)?.slHit ?? false,
      riskFreeSlExit: (dbRow as { riskFreeSlExit?: boolean } | undefined)?.riskFreeSlExit ?? false,
      runner1Price: dbRow?.runner1Price != null ? Number(dbRow.runner1Price) : st?.runner1Price ?? null,
      runner1Lots: dbRow?.runner1Lots != null ? Number(dbRow.runner1Lots) : st?.runner1Lots ?? null,
      runner2Price: dbRow?.runner2Price != null ? Number(dbRow.runner2Price) : st?.runner2Price ?? null,
      runner2Lots: dbRow?.runner2Lots != null ? Number(dbRow.runner2Lots) : st?.runner2Lots ?? null,
      runner3Price: dbRow?.runner3Price != null ? Number(dbRow.runner3Price) : st?.runner3Price ?? null,
      runner3Lots: dbRow?.runner3Lots != null ? Number(dbRow.runner3Lots) : st?.runner3Lots ?? null,
      runner1Hit: Boolean(dbRow?.runner1Hit ?? st?.runner1Hit),
      runner2Hit: Boolean(dbRow?.runner2Hit ?? st?.runner2Hit),
      runner3Hit: Boolean(dbRow?.runner3Hit ?? st?.runner3Hit),
      runner1Auto: Boolean((dbRow as { runner1Auto?: boolean } | undefined)?.runner1Auto ?? st?.runner1Auto),
      runner2Auto: Boolean((dbRow as { runner2Auto?: boolean } | undefined)?.runner2Auto ?? st?.runner2Auto),
      runner3Auto: Boolean((dbRow as { runner3Auto?: boolean } | undefined)?.runner3Auto ?? st?.runner3Auto),
      runnerActive: Boolean(dbRow?.runnerActive ?? st?.runnerActive),
      runner1Notified: Boolean(st?.tpNotified?.runner1),
      runner2Notified: Boolean(st?.tpNotified?.runner2),
      runner3Notified: Boolean(st?.tpNotified?.runner3),
    });
  })();
}

// ── Stream-health tracking ──────────────────────────────────────────────────
// Records the ms timestamp of the most-recent streaming event received per
// account (price tick, deal, order lifecycle). Cleared on clean disconnect /
// stop so wedged-but-connected streams are the only ones that go stale.
// The /healthz endpoint reads this map to decide 200 vs 503.
const lastEventAt = new Map<string, number>();

/** Freshness window — default 60 s; override with STREAM_FRESHNESS_MS env var. */
const STREAM_FRESHNESS_MS = Number(process.env["STREAM_FRESHNESS_MS"] ?? 60_000);

export interface StreamHealthAccount {
  accountId: string;
  silentForSec: number;
  stale: boolean;
  lastEventAt: number;
}

/** Returns the health of every currently-tracked streaming account.
 *  Empty map (no accounts) → healthy.
 *  Any account silent for > STREAM_FRESHNESS_MS → unhealthy. */
export function getStreamHealth(): { healthy: boolean; accounts: StreamHealthAccount[] } {
  if (lastEventAt.size === 0) return { healthy: true, accounts: [] };
  const now = Date.now();
  let healthy = true;
  const accounts: StreamHealthAccount[] = [];
  for (const [accountId, ts] of lastEventAt.entries()) {
    const silentForSec = Math.round((now - ts) / 1000);
    const stale = now - ts > STREAM_FRESHNESS_MS;
    if (stale) healthy = false;
    accounts.push({ accountId, silentForSec, stale, lastEventAt: ts });
  }
  return { healthy, accounts };
}

export function getZoneCounts(): { open: number; riskFree: number } {
  let open = 0; let riskFree = 0;
  for (const st of zoneStates.values()) {
    if (st.status === "OPEN") open++;
    else if (st.status === "RISK_FREE") riskFree++;
  }
  return { open, riskFree };
}

// Tracks positionIds that have already been auto-cascaded (per account).
// Persisted to the cascade_history table so it survives server restarts —
// without this, post-sync catch-up re-cascades positions whose cascade limit
// orders already filled (filled orders vanish from MT5's pending list, so
// the comment-based "already cascaded" heuristic can't detect them).
const cascadedPositions = new Map<string, Set<string>>(); // accountId → Set<positionId>
function hasBeenCascaded(accountId: string, positionId: string): boolean {
  return cascadedPositions.get(accountId)?.has(positionId) ?? false;
}
function unmarkCascaded(accountId: string, positionId: string): void {
  cascadedPositions.get(accountId)?.delete(positionId);
}
function markCascaded(accountId: string, positionId: string): void {
  let set = cascadedPositions.get(accountId);
  if (!set) { set = new Set(); cascadedPositions.set(accountId, set); }
  if (set.has(positionId)) return; // already marked — skip DB write
  set.add(positionId);
  // Evict oldest entry if this account's set grows too large
  if (set.size > 2000) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
  // Persist to DB — fire-and-forget (in-memory set is the source of truth
  // for the current session; DB is loaded on the next server startup).
  db.insert(cascadeHistoryTable)
    .values({ accountId, positionId, createdAt: Date.now() })
    .onConflictDoNothing()
    .catch((e: Error) => console.error(`[cascade-history] persist error posId=${positionId}:`, e.message));
}

// Load persisted cascade history for an account on (re)connect so that
// post-sync catch-up never re-cascades positions that were already handled
// in a previous server session.
async function loadCascadeHistory(accountId: string): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(cascadeHistoryTable)
      .where(eq(cascadeHistoryTable.accountId, accountId));
    let set = cascadedPositions.get(accountId);
    if (!set) { set = new Set(); cascadedPositions.set(accountId, set); }
    for (const row of rows) set.add(row.positionId);
    if (rows.length > 0) {
      console.log(`[cascade-history] loaded ${rows.length} previously-cascaded positions for ${accountId}`);
    }
  } catch (e) {
    console.error(`[cascade-history] load error for ${accountId}:`, (e as Error).message);
  }
}

// ── Rapid-trade dedup guard (Layer 6) ────────────────────────────────────────
// If two separate DEAL_ENTRY_IN events arrive for the same account within
// RAPID_CASCADE_WINDOW_MS at nearly the same price (within RAPID_PRICE_TOLERANCE),
// the second is almost certainly a double-click / double-tap in MT5 rather than
// an intentional separate position — skip auto-cascading it.
const RAPID_CASCADE_WINDOW_MS   = 4_000;  // 4 seconds between cascades per account
const RAPID_PRICE_TOLERANCE     = 0.5;    // XAUUSD points — tighter than normal spread

interface LastCascadeInfo { time: number; price: number; }
const lastCascadeByAccount = new Map<string, LastCascadeInfo>();

function isRapidDuplicate(accountId: string, price: number): boolean {
  const prev = lastCascadeByAccount.get(accountId);
  if (!prev) return false;
  const ageMs   = Date.now() - prev.time;
  const priceDiff = Math.abs(price - prev.price);
  return ageMs < RAPID_CASCADE_WINDOW_MS && priceDiff < RAPID_PRICE_TOLERANCE;
}

function recordCascade(accountId: string, price: number): void {
  lastCascadeByAccount.set(accountId, { time: Date.now(), price });
}

// Tracks which accounts have completed the initial MetaAPI synchronisation.
// onDealAdded fires for HISTORICAL deals during sync replay — we must NOT
// auto-cascade those. Only deals that arrive after onSynchronized are live.
const syncReady = new Set<string>();
// Per-stream-lifetime recovery timer. Must be cleared on stopStreaming so a
// timer scheduled by an old stream cannot fire against a future fresh stream
// (which would tear down a perfectly healthy new connection).
const recoveryTimers = new Map<string, NodeJS.Timeout>();
// Records the server-side ms timestamp when each account's sync completed.
// Used to filter out historical deal events that the SDK delivers AFTER
// onDealsSynchronized fires (a known SDK buffering quirk).
const syncReadyAt = new Map<string, number>();
// Tracks whether we've already logged a Layer-1 SKIP for this account's
// current replay window. Reset on disconnect and on sync-arm so we get
// one diagnostic line per replay, not per historical deal.
const skipLogged = new Set<string>();

// Server-side filter for orders that streaming has confirmed are completed
// (cancelled or filled). MetaAPI REST is eventually consistent and can lag
// by minutes — this map lets the /orders endpoint serve an accurate list
// immediately after a streaming onPendingOrderCompleted event fires.
// Entries expire after 5 minutes (order IDs are not reused).
const completedOrderIds = new Map<string, Set<string>>(); // accountId → Set<orderId>

function markOrderCompleted(accountId: string, orderId: string): void {
  if (!orderId) return;
  if (!completedOrderIds.has(accountId)) completedOrderIds.set(accountId, new Set());
  completedOrderIds.get(accountId)!.add(orderId);
  // Expire after 5 minutes — MetaAPI REST will have caught up by then.
  setTimeout(() => completedOrderIds.get(accountId)?.delete(orderId), 5 * 60 * 1000);
}

// Per-zone throttle for streaming-driven evaluateZone calls. Ticks can arrive
// many times per second; we cap each zone at one evaluation per
// STREAMING_EVAL_MIN_INTERVAL_MS so the broker isn't hammered on duplicates.
// The periodic timer remains as a safety net for ticks lost to a streaming dropout.
const STREAMING_EVAL_MIN_INTERVAL_MS = 500;
const MONITOR_EVAL_SKIP_IF_STREAM_MS = 12_000;
const lastStreamingEvalAt = new Map<string, number>(); // zoneId → epoch ms

/** Short-lived per-account broker snapshot — dedupes concurrent position/order REST calls. */
const BROKER_SNAPSHOT_TTL_MS = 5_000;
const brokerSnapshotCache = new Map<string, {
  positions: LivePosition[];
  orders: Array<{ id: string; comment?: string; magic?: number }>;
  fetchedAt: number;
}>();
const brokerSnapshotInflight = new Map<string, Promise<{
  positions: LivePosition[];
  orders: Array<{ id: string; comment?: string; magic?: number }>;
}>>();

async function getBrokerSnapshot(
  token: string,
  region: string,
  accountId: string,
  opts?: { fresh?: boolean },
): Promise<{
  positions: LivePosition[];
  orders: Array<{ id: string; comment?: string; magic?: number }>;
}> {
  if (!opts?.fresh) {
    const cached = brokerSnapshotCache.get(accountId);
    if (cached && Date.now() - cached.fetchedAt < BROKER_SNAPSHOT_TTL_MS) {
      return { positions: cached.positions, orders: cached.orders };
    }
    const pending = brokerSnapshotInflight.get(accountId);
    if (pending) return pending;
  }
  const load = (async () => {
    const [positions, orders] = await Promise.all([
      fetchOpenPositionsUncached(token, region, accountId),
      fetchLivePendingOrdersUncached(token, region, accountId),
    ]);
    brokerSnapshotCache.set(accountId, { positions, orders, fetchedAt: Date.now() });
    brokerSnapshotInflight.delete(accountId);
    return { positions, orders };
  })();
  if (!opts?.fresh) brokerSnapshotInflight.set(accountId, load);
  try {
    return await load;
  } catch (e) {
    brokerSnapshotInflight.delete(accountId);
    throw e;
  }
}

function invalidateBrokerSnapshot(accountId: string): void {
  brokerSnapshotCache.delete(accountId);
  brokerSnapshotInflight.delete(accountId);
}

/** Gold market hours — skip zone eval/reconcile off-hours to cut MetaAPI load. */
function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 23) return false;
  if (day === 5 && hour >= 22) return false;
  return true;
}

type BrokerSnap = {
  positions: LivePosition[];
  orders: Array<{ id: string; comment?: string; magic?: number }>;
};

/** One tick → one broker snapshot → evaluate all zones on the account (read-only snap). */
async function processStreamingTickBatch(accountId: string): Promise<void> {
  if (!isMarketOpen()) return;
  let token: string;
  try { token = getToken(); } catch { return; }

  const zones: string[] = [];
  for (const [zoneId, st] of zoneStates.entries()) {
    if (st.accountId !== accountId || st.status === "CLOSED") continue;
    zones.push(zoneId);
  }
  if (zones.length === 0) return;

  const region = activeRegions.get(accountId) ?? knownAccounts.get(accountId)?.region ?? DEFAULT_REGION;
  let snap: BrokerSnap;
  try {
    snap = await getBrokerSnapshot(token, region, accountId);
  } catch (err) {
    console.warn(`[tick-batch] snapshot failed for ${accountId}:`, (err as Error).message);
    return;
  }

  const now = Date.now();
  for (const zoneId of zones) {
    const last = lastStreamingEvalAt.get(zoneId) ?? 0;
    if (now - last < STREAMING_EVAL_MIN_INTERVAL_MS) continue;
    lastStreamingEvalAt.set(zoneId, now);
    try {
      await evaluateZone(zoneId, token, { brokerSnap: snap });
    } catch (err) {
      console.error(`[eval] ${zoneId}:`, (err as Error).message);
    }
  }
  invalidateBrokerSnapshot(accountId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleStreamingTick(accountId: string, price: any): void {
  if (!price || typeof price !== "object") return;
  // Reject ticks from any symbol other than XAUUSD — MT5 accounts can stream
  // multiple symbols simultaneously and we must not mix e.g. GBPUSD (~1.34)
  // with gold prices (~4500), which causes the alternating display bug.
  if (price.symbol && price.symbol !== "XAUUSD") return;
  const bid = Number(price.bid);
  const ask = Number(price.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
  // Cache the tick so latestPrice() / candle builders stay current even when
  // the mobile app isn't polling /price (e.g. backgrounded).
  storeTick(accountId, bid, ask);
  lastEventAt.set(accountId, Date.now());
  lastTickAtByAccount.set(accountId, Date.now());
  broadcastToAccount(accountId, "price", { bid, ask });
  void processStreamingTickBatch(accountId);
}

function makeDealListener(accountId: string) {
  // The MetaAPI SDK calls many methods on every registered listener and throws
  // if any of them is missing — aborting the entire synchronization packet.
  // Rather than enumerating every possible method name, we use a Proxy to
  // silently no-op any method the SDK calls that we haven't explicitly defined.
  const handler = {
    async onDisconnected(_instanceIndex: string): Promise<void> {
      syncReady.delete(accountId); // reset — next reconnect must re-sync before cascading
      syncReadyAt.delete(accountId);
      skipLogged.delete(accountId);
      activeStreams.delete(accountId);
      lastEventAt.delete(accountId); // clean disconnect — don't leave a stale entry
      // NOTE: intentionally NOT clearing activeConnections here.
      // The old connection's terminalState (in-memory cache) stays intact
      // across brief disconnects — positions synced before the drop are
      // still visible. This lets the safety net keep reading positions
      // during the full reconnect+resync window (~54 s) instead of going
      // blind and missing trades placed during that gap.
      // startStreaming() will replace activeConnections with the new conn.
      logEvent("stream.disconnect", { accountId });
      // Don't wait for the 10 s watchdog — reconnect immediately (3 s delay
      // to avoid a tight loop if the broker endpoint is briefly down).
      setTimeout(() => {
        if (activeStreams.has(accountId)) return; // already reconnected
        const { region } = knownAccounts.get(accountId) ?? { region: DEFAULT_REGION };
        try {
          const tok = getToken();
          void startStreaming(tok, accountId, region);
        } catch {
          // getToken() can throw if env var missing — watchdog will retry
        }
      }, 3_000);
    },
    // onDealsSynchronized fires after all historical deals have been replayed.
    async onDealsSynchronized(_instanceIndex: string, _synchronizationId: string): Promise<void> {
      lastEventAt.set(accountId, Date.now());
      if (!syncReady.has(accountId)) {
        syncReady.add(accountId);
        syncReadyAt.set(accountId, Date.now());
        skipLogged.delete(accountId);
        const pending = recoveryTimers.get(accountId);
        if (pending) {
          clearTimeout(pending);
          recoveryTimers.delete(accountId);
        }
        console.log(`[stream ${accountId}] deals sync complete`);
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async onDealAdded(_instanceIndex: string, deal: any): Promise<void> {
      lastEventAt.set(accountId, Date.now());
      // Zone cleanup: an exit deal may be a partial or full close — the helper
      // re-checks live positions via REST before marking the row CLOSED.
      if (deal?.entryType === "DEAL_ENTRY_OUT") {
        const posId = String(deal.positionId ?? "");
        if (posId) {
          invalidateBrokerSnapshot(accountId);
          void markZonePositionClosed(accountId, posId, deal);
        }
        broadcastToAccount(accountId, "deal", { type: "position_changed" });
        // MetaAPI REST has eventual consistency — the first broadcast above races
        // the cache. A second broadcast ~1500ms later ensures the client re-fetches
        // after the REST endpoint has settled, so closed positions disappear without
        // needing a manual pull-to-refresh.
        setTimeout(() => broadcastToAccount(accountId, "deal", { type: "position_changed" }), 1500);
        return;
      }
      if (deal?.entryType !== "DEAL_ENTRY_IN") return;
      if (!deal?.symbol) return;
      if (isDuplicate(String(deal.id ?? ""))) return;
      // Zone-aware limit-fill association: a tracked cascade limit just filled.
      // Record the resulting positionId in zone_positions so the monitor can manage it.
      // A limit order just filled — mark it completed so /orders filters it out
      // of MetaAPI REST immediately (REST cache can lag significantly).
      if (deal.orderId) markOrderCompleted(accountId, String(deal.orderId));
      if (deal.orderId && cascadePlacedOrderIds.has(String(deal.orderId))) {
        let zoneId = getZoneLimitOrder(accountId, String(deal.orderId));
        // Backstop when in-memory mapping is missing: (1) DB by orderId,
        // (2) deal comment Cascade|zoneId|leg/total. No direction/pending guess —
        // that steals fills across parallel same-direction zones.
        if (!zoneId && deal.positionId) {
          try {
            const dbRow = await db.select({ zoneId: zoneOrdersTable.zoneId })
              .from(zoneOrdersTable)
              .where(eq(zoneOrdersTable.orderId, String(deal.orderId)))
              .limit(1);
            if (dbRow[0]?.zoneId) {
              zoneId = dbRow[0].zoneId;
              setZoneLimitOrder(accountId, String(deal.orderId), zoneId);
              console.log(`[zone ${zoneId}] backstop-recovered from DB orderId=${deal.orderId} posId=${deal.positionId}`);
            }
          } catch (e) {
            console.warn(`[stream ${accountId}] backstop DB lookup failed for orderId=${deal.orderId}:`, (e as Error).message);
          }
        }
        if (!zoneId && deal.positionId) {
          const commentZone = parseZoneIdFromComment(String(deal.comment ?? ""));
          if (commentZone) {
            zoneId = commentZone;
            setZoneLimitOrder(accountId, String(deal.orderId), zoneId);
            console.log(`[zone ${zoneId}] backstop-recovered from deal comment orderId=${deal.orderId}`);
          }
        }
        if (zoneId && deal.positionId) {
          invalidateBrokerSnapshot(accountId);
          void recordZonePositionFill(
            zoneId, String(deal.positionId),
            Number(deal.price ?? deal.openPrice ?? 0),
            Number(deal.volume ?? 0),
          ).then(() => {
            lastStreamingEvalAt.delete(zoneId);
            try {
              const tkn = getToken();
              void evaluateZone(zoneId, tkn);
            } catch { /* token unavailable */ }
          });
        } else if (deal.positionId) {
          console.warn(`[stream ${accountId}] cascade fill orderId=${deal.orderId} posId=${deal.positionId} could not be linked to any active zone — position will be orphaned`);
        }
        // Always push a position-changed event so the client refreshes immediately
        // after a cascade limit fills, regardless of zone linkage outcome.
        broadcastToAccount(accountId, "deal", { type: "position_changed" });
        return;
      }
      const price = deal.price || deal.openPrice || 0;
      const evt: DealEvent = {
        dealId:     deal.id         ?? String(Date.now()),
        positionId: deal.positionId ?? "",
        symbol:     deal.symbol,
        type:       deal.type       ?? "",
        entryType:  deal.entryType,
        openPrice:  price,
        volume:     deal.volume     ?? 0,
        comment:    deal.comment,
        time:       Date.now(),
      };
      console.log(`[stream ${accountId}] deal dealId=${evt.dealId} posId=${evt.positionId} type=${evt.type} sym=${evt.symbol} price=${evt.openPrice} comment="${evt.comment ?? ""}"`);
      storeDealEvent(accountId, evt);
      broadcastToAccount(accountId, "deal", { type: "position_changed" });
    },
    // Streaming tick handlers — drive evaluateZone off real broker ticks so
    // TPs fire within ~100ms of the level being touched (vs the 3 s timer's
    // worst-case 3 s lag). MetaAPI calls one or the other depending on SDK
    // version: `onSymbolPriceUpdated` (singular) on older builds,
    // `onSymbolPricesUpdated` (plural, batched) on newer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async onSymbolPriceUpdated(_instanceIndex: string, price: any): Promise<void> {
      handleStreamingTick(accountId, price);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async onSymbolPricesUpdated(_instanceIndex: string, prices: any[]): Promise<void> {
      if (!Array.isArray(prices)) return;
      for (const p of prices) handleStreamingTick(accountId, p);
    },
    // Pending-order lifecycle — broadcast so the client can update its list
    // without waiting for a deal event or the next poll cycle.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async onPendingOrderAdded(_instanceIndex: string, _order: any): Promise<void> {
      lastEventAt.set(accountId, Date.now());
      broadcastToAccount(accountId, "pending_order", {});
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async onPendingOrderUpdated(_instanceIndex: string, _order: any): Promise<void> {
      lastEventAt.set(accountId, Date.now());
      broadcastToAccount(accountId, "pending_order", {});
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async onPendingOrderCompleted(_instanceIndex: string, order: any): Promise<void> {
      lastEventAt.set(accountId, Date.now());
      // Mark the order completed so the /orders endpoint can filter it out of
      // the MetaAPI REST response immediately (MetaAPI REST can lag minutes).
      const oid = String(order?.id ?? order?._id ?? "");
      markOrderCompleted(accountId, oid);
      broadcastToAccount(accountId, "pending_order", {});
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async onPositionRemoved(_instanceIndex: string, position: any): Promise<void> {
      lastEventAt.set(accountId, Date.now());
      const posId = String(position?.id ?? position?.positionId ?? "");
      if (!posId) return;
      invalidateBrokerSnapshot(accountId);
      void markZonePositionClosed(accountId, posId, position);
      broadcastToAccount(accountId, "deal", { type: "position_changed" });
    },
  };

  // Proxy: any property access that isn't `onDealAdded` returns a silent no-op.
  return new Proxy(handler, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(target: any, prop: string) {
      if (prop in target) return target[prop];
      return () => Promise.resolve();
    },
  });
}

// Stop an active stream, close the WebSocket, and clean up all in-memory state.
// Called when a user connects a different MT5 account so the old one stops cascading.
async function stopStreaming(accountId: string): Promise<void> {
  const conn = activeConnections.get(accountId);
  if (conn) {
    try { await conn.close(); } catch { /* ignore close errors */ }
  }
  activeStreams.delete(accountId);
  activeConnections.delete(accountId);
  activeRegions.delete(accountId);
  syncReady.delete(accountId);
  syncReadyAt.delete(accountId);
  lastEventAt.delete(accountId);
  // Do NOT delete cascadeConfigs here — config is persistent settings, not stream state.
  const pending = recoveryTimers.get(accountId);
  if (pending) {
    clearTimeout(pending);
    recoveryTimers.delete(accountId);
  }
  console.log(`[stream ${accountId}] stopped and cleaned up`);
}

/** Admin: drop broker stream and remove stored link for a user. */
export async function disconnectUserMt5(userId: string): Promise<number> {
  const rows = await db.select().from(storedAccountsTable).where(eq(storedAccountsTable.userId, userId));
  for (const row of rows) {
    await stopStreaming(row.accountId);
    await db.delete(storedAccountsTable).where(eq(storedAccountsTable.accountId, row.accountId));
  }
  userAccountCache.delete(userId);
  return rows.length;
}

async function startStreaming(token: string, accountId: string, region: string = DEFAULT_REGION, userId?: string): Promise<void> {
  if (activeStreams.has(accountId)) return;
  activeStreams.add(accountId);
  // Load persisted cascade history BEFORE sync so post-sync catch-up
  // sees already-cascaded positions and skips re-cascading them.
  await loadCascadeHistory(accountId);
  await loadCascadeOrders(accountId);
  try {
    const sdk = getSdk(token);
    const account = await sdk.metatraderAccountApi.getAccount(accountId);
    // If MetaAPI auto-undeployed the account (common after inactivity), re-deploy
    // before attempting to open a streaming connection — otherwise the subscribe
    // call silently fails and no deal events are ever received.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acctState: string = (account as any).state ?? "";
    if (acctState === "UNDEPLOYED") {
      console.warn(`[stream ${accountId}] account is UNDEPLOYED — re-deploying before connect...`);
      await deployAccount(token, accountId);
      // Give MetaAPI up to 30 s to bring the account online before we try to stream
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5000));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refreshed = await sdk.metatraderAccountApi.getAccount(accountId) as any;
        if (refreshed.state === "DEPLOYED" || refreshed.connectionStatus === "CONNECTED") break;
        console.log(`[stream ${accountId}] waiting for deploy... (${(i + 1) * 5}s)`);
      }
    }
    // Skip historical deal/order replay entirely. We never read history —
    // only react to live `onDealAdded` events for auto-cascade. Accounts
    // with large histories (like Gethin's) were taking 90-120 s to sync,
    // causing subscribe timeouts and a permanent reconnect loop on the
    // london region. Starting from "now" makes sync near-instant.
    const conn = account.getStreamingConnection(undefined, new Date());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).addSynchronizationListener(makeDealListener(accountId));
    // Hard cap: if connect() hangs (MetaAPI server-side issue), abort after
    // 30 s so the watchdog can retry rather than leaving the account dark for
    // 175 s+. The SDK's own internal timeout can be much longer.
    await Promise.race([
      conn.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("connect() timed out after 30 s")), 30_000),
      ),
    ]);
    // Store connection so the trade endpoint can reuse this WebSocket
    // instead of making new HTTP calls to MetaAPI REST for every order.
    activeConnections.set(accountId, conn);
    activeRegions.set(accountId, region);
    // Keep the in-memory registry current so the watchdog/safety-net can work
    // even when the DB is temporarily unavailable.
    knownAccounts.set(accountId, { accountId, userId, region });
    logEvent("stream.connect", { accountId, region });
    // Sync-stuck recovery: if `onDealsSynchronized` hasn't fired within 150s,
    // the account's sync session on MetaAPI is wedged (the "synchronization
    // with this id is already running" error). Force-arming locally doesn't
    // help because no deal events ever arrive — the only cure is to undeploy
    // and redeploy the account on MetaAPI's side, which wipes the stuck
    // session. 150s is generous — successful syncs land in 25-90s; firing
    // earlier just tears down a connection that was about to succeed and
    // creates a churn loop. Recovery is rate-limited to avoid loops.
    // Capture this stream's specific connection instance so the timer can
    // confirm it's still firing for the SAME stream — never against a
    // future fresh stream born of a reconnect.
    const myConn = conn;
    const timer = setTimeout(() => {
      recoveryTimers.delete(accountId);
      // Bail if: sync completed, no connection, or this is a stale timer
      // whose stream was already replaced by a newer reconnect.
      if (syncReady.has(accountId)) return;
      const current = activeConnections.get(accountId);
      if (!current || current !== myConn) return;
      console.warn(`[stream ${accountId}] onDealsSynchronized never fired after 240s — triggering sync recovery`);
      void recoverStuckSync(token, accountId);
    }, 240_000);
    recoveryTimers.set(accountId, timer);
    // Persist credentials so the server can auto-reconnect after a restart
    // without waiting for the app to call /connect again.
    // userId is included when available so /my-account lookups work reliably.
    try {
      const known = knownAccounts.get(accountId);
      await upsertStoredAccount({
        accountId,
        region,
        userId: userId ?? known?.userId,
        mt5Login: null,
        mt5Server: null,
      });
      if (userId) userAccountCache.set(userId, accountId);
      console.log(`[stream ${accountId}] credentials saved to DB for auto-reconnect`);
    } catch (dbErr) {
      console.warn(`[stream ${accountId}] failed to persist account to DB:`, (dbErr as Error).message);
    }
  } catch (err) {
    activeStreams.delete(accountId); // allow retry on next poll
    activeConnections.delete(accountId);
    const msg = (err as Error).message ?? "";
    // MetaAPI auto-undeploys accounts during inactivity. Detect the error and
    // re-deploy automatically so the stream resumes without user intervention.
    if (msg.includes("no accounts deployed") || msg.includes("deploy an account first")) {
      console.warn(`[stream ${accountId}] account undeployed — triggering re-deploy...`);
      try {
        await deployAccount(token, accountId);
        console.log(`[stream ${accountId}] re-deploy requested — watchdog will retry stream in 30 s`);
      } catch (deployErr) {
        console.error(`[stream ${accountId}] re-deploy failed:`, (deployErr as Error).message);
      }
    } else if (/account with id .* not found/i.test(msg) || msg.includes("NotFoundError")) {
      // Permanent: account was deleted on MetaAPI's side. Without removing it
      // from stored_accounts the watchdog reconnects every 10s forever,
      // calling loadCascadeHistory each time — pure noise + load. Drop it
      // so we stop trying.
      console.warn(`[stream ${accountId}] account no longer exists on MetaAPI — removing from stored_accounts to stop retry loop`);
      knownAccounts.delete(accountId);
      try {
        await db.delete(storedAccountsTable).where(eq(storedAccountsTable.accountId, accountId));
      } catch (delErr) {
        console.warn(`[stream ${accountId}] failed to delete stored_account:`, (delErr as Error).message);
      }
    } else {
      console.error(`[stream ${accountId}] streaming start failed:`, msg);
    }
  }
}

// ── Auto-connect & watchdog ───────────────────────────────────────────────────
// On server startup, reconnect all previously-seen accounts from the DB so
// auto-cascade works even when the app is closed / phone is off.
// The watchdog fires every 60 s and retries any account that lost its stream.

export async function startAutoConnect(): Promise<void> {
  try {
    const token = getToken();
    const rows = await db
      .select()
      .from(storedAccountsTable)
      .where(isNotNull(storedAccountsTable.userId));
    if (rows.length === 0) {
      console.log("[auto-connect] no stored accounts with bound users — waiting for first app connect");
      return;
    }
    // Seed the in-memory registry NOW, before any streaming starts.
    // This guarantees the watchdog and safety-net always have a non-empty
    // account list even if the DB becomes unavailable during the first tick.
    for (const { accountId, userId, region } of rows) {
      knownAccounts.set(accountId, { accountId, userId: userId ?? undefined, region });
    }
    for (const { accountId, region, userId } of rows) {
      console.log(`[auto-connect] reconnecting accountId=${accountId} region=${region}`);
      void startStreaming(token, accountId, region, userId ?? undefined);
    }
  } catch (err) {
    console.error("[auto-connect] failed:", (err as Error).message);
  }
}

export function startConnectionWatchdog(): void {
  const INTERVAL_MS = 10_000;
  setInterval(async () => {
    try {
      const token = getToken();
      // Try to refresh the in-memory registry from DB. If DB is unavailable,
      // fall back to the existing cache — never skip reconnects due to a DB blip.
      let accounts: KnownAccount[];
      try {
        const rows = await db
          .select()
          .from(storedAccountsTable)
          .where(isNotNull(storedAccountsTable.userId));
        // Refresh cache with latest DB state while we have it.
        for (const { accountId, userId, region } of rows) {
          knownAccounts.set(accountId, { accountId, userId: userId ?? undefined, region });
        }
        accounts = rows.map(r => ({ accountId: r.accountId, userId: r.userId ?? undefined, region: r.region }));
      } catch {
        accounts = Array.from(knownAccounts.values());
        if (accounts.length > 0) {
          console.log(`[watchdog] DB unavailable — using in-memory cache (${accounts.length} accounts)`);
        }
      }
      for (const { accountId, region } of accounts) {
        if (!activeStreams.has(accountId)) {
          console.log(`[watchdog] ${accountId} not streaming — reconnecting`);
          void startStreaming(token, accountId, region);
        }
      }
    } catch (err) {
      console.warn("[watchdog] error:", (err as Error).message);
    }
  }, INTERVAL_MS);
  console.log("[watchdog] connection watchdog started (30 s interval)");
}


// ── SDK connection-based trade execution ─────────────────────────────────────
// Uses the already-open streaming WebSocket instead of making new HTTP requests
// to MetaAPI REST for every order. Falls back to REST if connection unavailable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tradeViaConnection(conn: any, body: Record<string, unknown>): Promise<{
  numericCode: number; message?: string; orderId?: string; positionId?: string;
}> {
  const { actionType, symbol, volume, stopLoss, takeProfit, openPrice, comment, orderId } = body;
  const opts = { comment: comment as string | undefined };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resp: any;
  switch (actionType) {
    case "ORDER_TYPE_BUY":
      resp = await conn.createMarketBuyOrder(symbol, volume, stopLoss ?? undefined, takeProfit ?? undefined, opts);
      break;
    case "ORDER_TYPE_SELL":
      resp = await conn.createMarketSellOrder(symbol, volume, stopLoss ?? undefined, takeProfit ?? undefined, opts);
      break;
    case "ORDER_TYPE_BUY_LIMIT":
      resp = await conn.createLimitBuyOrder(symbol, volume, openPrice, stopLoss ?? undefined, takeProfit ?? undefined, opts);
      break;
    case "ORDER_TYPE_SELL_LIMIT":
      resp = await conn.createLimitSellOrder(symbol, volume, openPrice, stopLoss ?? undefined, takeProfit ?? undefined, opts);
      break;
    case "ORDER_CANCEL":
      resp = await conn.cancelOrder(orderId as string);
      break;
    default:
      throw new Error(`Unknown actionType: ${String(actionType)}`);
  }
  return { numericCode: resp?.numericCode ?? 0, message: resp?.message, orderId: resp?.orderId, positionId: resp?.positionId };
}

function isPricePassedError(code: number, message?: string): boolean {
  const msg = (message ?? "").toLowerCase();
  return code === 10006 || code === 10014 || code === 10020 || code === 10021
    || msg.includes("invalid") || msg.includes("price")
    || msg.includes("off quotes") || msg.includes("trade disabled");
}

type TradeExecResult = {
  code: number;
  data: { numericCode?: number; message?: string; orderId?: string; positionId?: string };
  httpStatus: number;
};

async function executeTradeRequest(
  conn: unknown | undefined,
  region: string,
  accountId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<TradeExecResult> {
  const runOnce = async (reqBody: Record<string, unknown>): Promise<TradeExecResult> => {
    let code: number;
    let data: TradeExecResult["data"];
    let httpStatus = 200;
    if (conn) {
      try {
        const sdkResp = await tradeViaConnection(conn, reqBody);
        code = sdkResp.numericCode;
        data = sdkResp;
      } catch (sdkErr) {
        const tradeRes = await fetch(`${clientBase(region)}/users/current/accounts/${accountId}/trade`, {
          method: "POST", headers: authHeaders(token), body: JSON.stringify(reqBody),
        });
        httpStatus = tradeRes.ok ? 200 : tradeRes.status;
        data = await tradeRes.json() as TradeExecResult["data"];
        code = data.numericCode ?? 0;
      }
    } else {
      const tradeRes = await fetch(`${clientBase(region)}/users/current/accounts/${accountId}/trade`, {
        method: "POST", headers: authHeaders(token), body: JSON.stringify(reqBody),
      });
      httpStatus = tradeRes.ok ? 200 : tradeRes.status;
      data = await tradeRes.json() as TradeExecResult["data"];
      code = data.numericCode ?? 0;
    }
    return { code, data, httpStatus };
  };

  const actionType = String(body.actionType ?? "");
  const isLimit = actionType.endsWith("_LIMIT");
  let result = await runOnce(body);
  if (!TRADE_SUCCESS_CODES.has(result.code) && isLimit && isPricePassedError(result.code, result.data.message)) {
    const marketType = actionType === "ORDER_TYPE_BUY_LIMIT" ? "ORDER_TYPE_BUY"
      : actionType === "ORDER_TYPE_SELL_LIMIT" ? "ORDER_TYPE_SELL" : null;
    if (marketType) {
      console.log(`[cascade] limit at ${String(body.openPrice)} passed through, placing market`);
      const { openPrice: _omit, ...rest } = body;
      result = await runOnce({ ...rest, actionType: marketType });
    }
  }
  return result;
}

// Place a cascade limit order.
// Picks ONE channel and commits to it — never fires both in parallel:
//   - If a streaming SDK connection exists → streaming only (with 30 s safety bound).
//   - Otherwise → REST only.
// The previously-removed *parallel* hybrid was dangerous because a late
// streaming response could land on MT5 after REST already placed the order,
// and the cancel-duplicate call would silently fail during a WebSocket
// disconnect. A single-channel REST call (when no streaming exists) cannot
// produce a duplicate — nothing is racing it.
const STREAMING_CASCADE_TIMEOUT_MS = 30_000;
async function placeCascadeLimitFast(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: any | undefined,
  region: string,
  accountId: string,
  token: string,
  body: Record<string, unknown>,
  limitNum: number,
  total: number,
): Promise<string | undefined> {
  if (!conn) {
    console.warn(`[auto-cascade] no streaming connection for limit ${limitNum}/${total} — using REST (single-channel, no duplicate risk)`);
  }
  const result = await executeTradeRequest(conn, region, accountId, token, body);
  if (!TRADE_SUCCESS_CODES.has(result.code)) {
    throw new Error(userFacingTradeMessage(result.code, result.data.message));
  }
  return result.data.orderId;
}

// ── Post-cascade orphan sweeper ─────────────────────────────────────────────
// 15 s after a cascade fires, scan pending limit orders. Any "Cascade"-tagged
// order whose orderId we did NOT track is an orphan (the most common cause:
// a late streaming response that landed on MT5 but our cancel-duplicate failed
// because the WebSocket was disconnecting). Cancel it.
const RECONCILE_DELAY_MS = 20_000;

/** Zones mid-cascade: orphan sweeper must not cancel their pending limits. */
const zonesPlacingUntil = new Map<string, number>();

export function markZonePlacing(zoneId: string, ms = CASCADE_LIMIT_GRACE_MS + 15_000): void {
  zonesPlacingUntil.set(zoneId, Date.now() + ms);
}

function isZoneStillPlacing(zoneId: string): boolean {
  const until = zonesPlacingUntil.get(zoneId) ?? 0;
  if (until <= Date.now()) {
    zonesPlacingUntil.delete(zoneId);
    return false;
  }
  return true;
}

function scheduleCascadeReconcile(accountId: string, region: string, token: string): void {
  setTimeout(async () => {
    try {
      if (!syncReady.has(accountId)) {
        console.log(`[reconcile ${accountId}] skip orphan sweep — stream not synced yet`);
        return;
      }
      const resp = await fetch(`${clientBase(region)}/users/current/accounts/${accountId}/orders`, {
        headers: authHeaders(token),
      });
      if (!resp.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orders = (await resp.json()) as any[];
      const nowMs = Date.now();
      const orphans: { id: string; comment: string }[] = [];
      for (const o of orders) {
        const comment = String(o.comment ?? "");
        if (!comment.startsWith("Cascade")) continue;
        const oid = String(o.id ?? o._id ?? "");
        if (!oid) continue;
        if (cascadePlacedOrderIds.has(oid)) continue;
        const zid = parseZoneIdFromComment(comment);
        if (zid && isZoneStillPlacing(zid)) continue;
        if (orderMappedToActiveZone(accountId, oid)) continue;
        if (zid) {
          const z = zoneStates.get(zid);
          if (z && z.status !== "CLOSED") continue;
        }
        const orderTimeMs = o.time ? new Date(o.time).getTime() : 0;
        if (orderTimeMs > 0 && (nowMs - orderTimeMs) < CASCADE_LIMIT_GRACE_MS) continue;
        orphans.push({ id: oid, comment });
      }
      if (orphans.length === 0) return;
      console.warn(`[reconcile ${accountId}] found ${orphans.length} untracked Cascade order(s): ${orphans.map(o => `${o.id}(${o.comment})`).join(", ")}`);
      await Promise.all(orphans.map(async o => {
        try {
          const r = await fetch(`${clientBase(region)}/users/current/accounts/${accountId}/trade`, {
            method: "POST",
            headers: authHeaders(token),
            body: JSON.stringify({ actionType: "ORDER_CANCEL", orderId: o.id }),
          });
          if (r.ok) console.log(`[reconcile ${accountId}] cancelled orphan orderId=${o.id}`);
          else console.warn(`[reconcile ${accountId}] failed to cancel orphan orderId=${o.id} status=${r.status}`);
        } catch (e) {
          console.error(`[reconcile ${accountId}] cancel orphan threw orderId=${o.id}:`, (e as Error).message);
        }
      }));
    } catch (e) {
      console.error(`[reconcile ${accountId}] sweep error:`, (e as Error).message);
    }
  }, RECONCILE_DELAY_MS).unref();
}

// ── In-memory tick store ────────────────────────────────────────────────────
// Every price poll is stored here; candles are aggregated on demand.
interface PriceTick { time: number; bid: number; ask: number; }
interface OhlcCandle { time: string; open: number; high: number; low: number; close: number; }

const tickStore = new Map<string, PriceTick[]>(); // accountId → ticks
const MAX_TICKS = 3000; // ~4 hours of 5-second ticks

function storeTick(accountId: string, bid: number, ask: number) {
  if (!tickStore.has(accountId)) tickStore.set(accountId, []);
  const ticks = tickStore.get(accountId)!;
  ticks.push({ time: Date.now(), bid, ask });
  if (ticks.length > MAX_TICKS) ticks.splice(0, ticks.length - MAX_TICKS);
}

const TF_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000,
  "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

function buildCandles(accountId: string, timeframe: string, limit: number): OhlcCandle[] {
  const ticks = tickStore.get(accountId) ?? [];
  const msPerBar = TF_MS[timeframe] ?? 300_000;
  const map = new Map<number, OhlcCandle>();
  for (const t of ticks) {
    const barStart = Math.floor(t.time / msPerBar) * msPerBar;
    const mid = parseFloat(((t.bid + t.ask) / 2).toFixed(2));
    const existing = map.get(barStart);
    if (existing) {
      existing.high  = parseFloat(Math.max(existing.high, mid).toFixed(2));
      existing.low   = parseFloat(Math.min(existing.low,  mid).toFixed(2));
      existing.close = mid;
    } else {
      map.set(barStart, { time: new Date(barStart).toISOString(), open: mid, high: mid, low: mid, close: mid });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
    .slice(-limit);
}

const PROVISIONING_BASE = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const CLIENT_DOMAIN = "agiliumtrade.ai";
const DEFAULT_REGION = "london";

function getToken(): string {
  const token = process.env.METAAPI_TOKEN;
  if (!token) throw new Error("METAAPI_TOKEN is not configured on the server.");
  return token;
}

function authHeaders(token: string) {
  return { "auth-token": token, "Content-Type": "application/json" };
}

// Normalise whatever MetaAPI returns as "region" to the short subdomain form (e.g. "london").
// MetaAPI may return the full host like "mt-client-api-v1.london.agiliumtrade.ai".
function normalizeRegion(region: string | undefined): string {
  if (!region) return DEFAULT_REGION;
  // Already short form: "london", "new-york", etc.
  if (!region.includes(".")) return region;
  // Full host: "mt-client-api-v1.london.agiliumtrade.ai" → extract "london"
  const m = region.match(/^mt-client-api-v1\.(.+?)\.agiliumtrade\.ai$/);
  if (m?.[1]) return m[1];
  // Fallback: use as-is and let MetaAPI reject it with a clear error
  return region;
}

function clientBase(region: string = DEFAULT_REGION): string {
  const r = normalizeRegion(region);
  return `https://mt-client-api-v1.${r}.${CLIENT_DOMAIN}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function qstr(v: unknown): string | undefined {
  if (Array.isArray(v)) return v[0] as string;
  return v as string | undefined;
}

interface ProvisioningAccount {
  id?: string;
  _id?: string;
  login?: string;
  server?: string;
  region?: string;
  connectionStatus?: string;
  state?: string;
  message?: string;
  reliability?: string;
  error?: string;
  details?: string;
}

async function getProvisioningAccount(token: string, accountId: string): Promise<ProvisioningAccount> {
  const res = await fetch(`${PROVISIONING_BASE}/users/current/accounts/${accountId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Account lookup failed: ${res.status}`);
  }
  return res.json() as Promise<ProvisioningAccount>;
}

/** Admin dashboard: broker login/server for each MetaAPI account id. */
export async function listProvisioningAccounts(): Promise<
  Map<string, { login: string; server: string; region?: string; connectionStatus?: string }>
> {
  const token = getToken();
  const listRes = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
    headers: authHeaders(token),
  });
  if (!listRes.ok) return new Map();
  const all = await listRes.json() as ProvisioningAccount[];
  const map = new Map<string, { login: string; server: string; region?: string; connectionStatus?: string }>();
  if (!Array.isArray(all)) return map;
  for (const a of all) {
    const accountId = a._id ?? a.id;
    if (!accountId) continue;
    map.set(accountId, {
      login: String(a.login ?? ""),
      server: String(a.server ?? ""),
      region: a.region,
      connectionStatus: a.connectionStatus,
    });
  }
  return map;
}

async function getAccountInfo(token: string, accountId: string, region: string | undefined = DEFAULT_REGION) {
  region = region || DEFAULT_REGION;
  const res = await fetch(
    `${clientBase(region)}/users/current/accounts/${accountId}/account-information`,
    { headers: authHeaders(token) }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Account info failed: ${res.status}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

async function deployAccount(token: string, accountId: string): Promise<void> {
  const res = await fetch(`${PROVISIONING_BASE}/users/current/accounts/${accountId}/deploy`, {
    method: "POST",
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    const msg = body.message ?? `Deploy failed (HTTP ${res.status})`;
    console.warn(`[deploy] ${accountId} failed ${res.status}: ${msg}`);
    throw new Error(msg);
  }
}

async function undeployAccount(token: string, accountId: string): Promise<void> {
  const res = await fetch(`${PROVISIONING_BASE}/users/current/accounts/${accountId}/undeploy`, {
    method: "POST",
    headers: authHeaders(token),
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    const msg = body.message ?? `Undeploy failed (HTTP ${res.status})`;
    console.warn(`[undeploy] ${accountId} failed ${res.status}: ${msg}`);
    throw new Error(msg);
  }
}

// ── Stuck-sync recovery ────────────────────────────────────────────────────
// Some MetaAPI accounts (Gethin's is the canonical example) get into a state
// where every subscribe call fails with "synchronization with this id is
// already running" and onDealsSynchronized never fires. Reconnecting does
// nothing because the stuck session lives on MetaAPI's server, not ours.
// The only known cure is to undeploy → wait → redeploy, which wipes the
// server-side sync state and lets the next streaming connect succeed.
const recoveryAttempts = new Map<string, number[]>(); // accountId → recovery timestamps
const RECOVERY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RECOVERIES_PER_WINDOW = 3;

function canAttemptRecovery(accountId: string): boolean {
  const now = Date.now();
  const recent = (recoveryAttempts.get(accountId) ?? []).filter(t => now - t < RECOVERY_WINDOW_MS);
  recoveryAttempts.set(accountId, recent);
  return recent.length < MAX_RECOVERIES_PER_WINDOW;
}

function recordRecoveryAttempt(accountId: string): void {
  const arr = recoveryAttempts.get(accountId) ?? [];
  arr.push(Date.now());
  recoveryAttempts.set(accountId, arr);
}

async function recoverStuckSync(token: string, accountId: string): Promise<void> {
  if (!canAttemptRecovery(accountId)) {
    console.warn(`[sync-recovery] ${accountId} — recovery rate-limit reached (>${MAX_RECOVERIES_PER_WINDOW} in 2h), skipping`);
    return;
  }
  recordRecoveryAttempt(accountId);
  console.warn(`[sync-recovery] ${accountId} — sync stuck, starting undeploy→redeploy cycle to clear MetaAPI session state`);
  try {
    // 1. Tear down our local streaming connection so the watchdog won't
    //    fight the recovery by reconnecting mid-cycle.
    await stopStreaming(accountId);
    // 2. Undeploy on MetaAPI's side — this kills the stuck sync session.
    await undeployAccount(token, accountId);
    console.log(`[sync-recovery] ${accountId} — undeploy requested, waiting for UNDEPLOYED state...`);
    // 3. Poll until UNDEPLOYED confirmed (up to 60 s).
    const sdk = getSdk(token);
    const undeployStart = Date.now();
    while (Date.now() - undeployStart < 60_000) {
      await new Promise(r => setTimeout(r, 3000));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acct = await sdk.metatraderAccountApi.getAccount(accountId) as any;
      if (acct.state === "UNDEPLOYED") {
        console.log(`[sync-recovery] ${accountId} — confirmed UNDEPLOYED after ${Math.round((Date.now() - undeployStart) / 1000)}s`);
        break;
      }
    }
    // 4. Redeploy and let the watchdog (30 s) pick it up to reconnect.
    await deployAccount(token, accountId);
    console.log(`[sync-recovery] ${accountId} — redeploy requested, watchdog will reconnect within 30 s`);
  } catch (err) {
    console.error(`[sync-recovery] ${accountId} — recovery cycle failed:`, (err as Error).message);
    // Don't leave activeStreams marked — let watchdog retry the connect.
    activeStreams.delete(accountId);
  }
}

// ── Zone comment / isolation helpers ─────────────────────────────────────────
// Every cascade leg carries `Cascade|<zoneId>|<leg>/<total>` in the MT5 comment
// so parallel zones on the same symbol stay isolated after restarts.

export function buildCascadeComment(zoneId: string, leg: number, total: number): string {
  return `Cascade|${zoneId}|${leg}/${total}`;
}

export function parseZoneIdFromComment(comment: string | undefined | null): string | null {
  if (!comment) return null;
  const pipeMatch = comment.match(/^Cascade\|([^|]+)\|\d+\/\d+$/);
  if (pipeMatch?.[1]) return pipeMatch[1];
  return null;
}

export function commentBelongsToZone(comment: string | undefined | null, zoneId: string): boolean {
  const parsed = parseZoneIdFromComment(comment);
  return parsed != null && parsed === zoneId;
}

/** True when a live MT5 position belongs to this cascade zone (magic or comment tag). */
export function positionBelongsToZone(
  p: { magic?: number; comment?: string },
  zoneId: string,
): boolean {
  if (commentBelongsToZone(p.comment, zoneId)) return true;
  if (parseZoneIdFromComment(p.comment) == null) {
    const magic = Number(p.magic);
    if (Number.isFinite(magic) && magic === zoneMagicNumber(zoneId)) return true;
  }
  return false;
}

/** DB-tracked ∪ comment/magic-tagged legs — same union as resolveLivePositionsForZoneAction. */
export function mergeLiveZoneLegs(
  allLive: LivePosition[],
  zoneId: string,
  trackedIds: Set<string>,
): LivePosition[] {
  const byId = new Map<string, LivePosition>();
  for (const p of allLive) {
    if (trackedIds.has(p.id) || positionBelongsToZone(p, zoneId)) byId.set(p.id, p);
  }
  return [...byId.values()];
}

/**
 * True when the broker snapshot is missing legs we know about (DB rows or tagged
 * positions). Batch snapshots can lag behind a limit fill while anchor is
 * already visible — relink + fresh REST avoids TP closes on anchor only.
 */
export function zoneLegsNeedFreshResolve(
  live: LivePosition[],
  zoneId: string,
  trackedIds: Set<string>,
  allLive: LivePosition[],
  dbOpenCount: number,
): boolean {
  if (dbOpenCount > live.length) return true;
  for (const id of trackedIds) {
    if (!live.some((p) => p.id === id)) return true;
  }
  return allLive
    .filter((p) => positionBelongsToZone(p, zoneId))
    .some((p) => !live.some((l) => l.id === p.id));
}

/** True when evaluateZone can run TP/BE logic (anchor or absolute TP prices set). */
export function zoneHasTpTargets(st: {
  anchorPrice: number;
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
  tp4Price: number | null;
}): boolean {
  if (st.anchorPrice > 0) return true;
  return [st.tp1Price, st.tp2Price, st.tp3Price, st.tp4Price]
    .some((p) => p != null && p > 0);
}

/**
 * True when live MT5 volume shows this TP level's partial was already taken
 * (broker TP filled before our tick saw the price cross, etc.).
 */
export function positionShowsTpLevelApplied(
  currentVol: number,
  origVol: number,
  level: 1 | 2 | 3 | 4,
  tpPcts: { tp1Pct: number; tp2Pct: number; tp3Pct: number },
): boolean {
  if (!(origVol > 0) || !(currentVol > 0)) return false;
  const tpPct = level === 1 ? tpPcts.tp1Pct : level === 2 ? tpPcts.tp2Pct : level === 3 ? tpPcts.tp3Pct : 0;
  const priorPct = level === 1 ? 0
    : level === 2 ? tpPcts.tp1Pct
      : level === 3 ? tpPcts.tp1Pct + tpPcts.tp2Pct
        : tpPcts.tp1Pct + tpPcts.tp2Pct + tpPcts.tp3Pct;
  const keepFractionGate = Math.max(0, (100 - priorPct - tpPct + 1) / 100);
  return currentVol <= origVol * keepFractionGate;
}

/** Next manual Take TP level: lowest TP any open leg in this zone still needs. */
export function computeNextTakeTpLevel(
  openRows: Array<{ tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean }>,
  enabled: { tp1Enabled: boolean; tp2Enabled: boolean; tp3Enabled: boolean },
): 0 | 1 | 2 | 3 {
  if (openRows.length === 0) return 0;
  if (enabled.tp1Enabled && openRows.some((r) => !r.tp1Hit)) return 1;
  if (enabled.tp2Enabled && openRows.some((r) => r.tp1Hit && !r.tp2Hit)) return 2;
  if (enabled.tp3Enabled && openRows.some((r) => r.tp2Hit && !r.tp3Hit)) return 3;
  return 0;
}

/** Whether this leg still needs the zone's configured TP slice at `lvl` (per-position, per-zone). */
export function legNeedsTpSlice(
  leg: { id: string; volume: number },
  st: {
    trackedPositions: Map<string, { volume: number; tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; tp4Hit: boolean }>;
    tp1Pct: number; tp2Pct: number; tp3Pct: number;
  },
  lvl: 1 | 2 | 3,
): boolean {
  const tpPcts = { tp1Pct: st.tp1Pct, tp2Pct: st.tp2Pct, tp3Pct: st.tp3Pct };
  const cached = st.trackedPositions.get(leg.id);
  const origVol = cached?.volume && cached.volume > 0 ? cached.volume : leg.volume;
  const posHit = (n: 1 | 2 | 3): boolean => {
    const key = `tp${n}Hit` as const;
    return Boolean(cached?.[key]) || positionShowsTpLevelApplied(leg.volume, origVol, n, tpPcts);
  };
  if (lvl >= 2 && !posHit(1)) return false;
  if (lvl >= 3 && !posHit(2)) return false;
  return !posHit(lvl);
}

/** Cascade limits are cancelled only on the first successful TP2, never on TP1. */
export function shouldCancelCascadeLimitsAtTpStage(
  tpStage: 1 | 2 | 3 | 4,
  zone: { tp1Hit: boolean; tp2Hit: boolean },
): boolean {
  return tpStage === 2 && zone.tp1Hit && !zone.tp2Hit;
}

/** Unfilled cascade limits are stale once TP2 has fired (same as evaluateZone after TP2). */
export function shouldCancelCascadeLimitsForZone(zone: { tp2Hit: boolean }): boolean {
  return zone.tp2Hit;
}

/**
 * When the last tracked position row closes, defer auto zone-close + limit cancel
 * if the zone is still OPEN pre-TP2 and unfilled cascade limits remain on the broker.
 */
export function shouldAutoCloseZoneAfterPositionExit(
  zone: { status: string; tp2Hit: boolean },
  hasOpenPositionsInDb: boolean,
  hasLivePendingLimits: boolean,
): boolean {
  if (hasOpenPositionsInDb) return false;
  if (zone.status === "OPEN" && !zone.tp2Hit && hasLivePendingLimits) return false;
  return true;
}

/** Never cancel fresh cascade limits during placement (brief: ~45–60s grace). */
export const CASCADE_LIMIT_GRACE_MS = 50_000;

/** Whether `level` is the last TP step enabled on this zone. */
export function isLastEnabledTpLevel(
  level: 1 | 2 | 3 | 4,
  zone: { tp1Enabled: boolean; tp2Enabled: boolean; tp3Enabled: boolean; tp4Enabled: boolean },
): boolean {
  if (level === 1) return !zone.tp2Enabled && !zone.tp3Enabled && !zone.tp4Enabled;
  if (level === 2) return !zone.tp3Enabled && !zone.tp4Enabled;
  if (level === 3) return !zone.tp4Enabled;
  return true;
}

/**
 * TP partial size from original cascade lot × %, with sub-min-lot carry (hybrid).
 * slice = cascadeLot × close%; rounded to 0.01; capped by remaining open volume.
 */
export function computeTpSliceVolume(opts: {
  cascadeLot: number;
  tpPct: number;
  remainingVol: number;
  carryIn?: number;
  isLastEnabledTp: boolean;
}): { closeVol: number; carryOut: number; action: "close" | "carry" | "full_remainder" } {
  const carryIn = opts.carryIn ?? 0;
  const rawUnrounded = opts.cascadeLot * (opts.tpPct / 100) + carryIn;
  if (rawUnrounded < 0.01) {
    if (opts.isLastEnabledTp && opts.remainingVol >= 0.01) {
      return { closeVol: opts.remainingVol, carryOut: 0, action: "full_remainder" };
    }
    if (!opts.isLastEnabledTp) {
      return { closeVol: 0, carryOut: rawUnrounded, action: "carry" };
    }
    return { closeVol: 0, carryOut: 0, action: "carry" };
  }
  const raw = Math.round(rawUnrounded * 100) / 100;
  const closeVol = Math.min(raw, opts.remainingVol);
  if (closeVol < 0.01) {
    if (opts.isLastEnabledTp && opts.remainingVol >= 0.01) {
      return { closeVol: opts.remainingVol, carryOut: 0, action: "full_remainder" };
    }
    return { closeVol: 0, carryOut: 0, action: "carry" };
  }
  return { closeVol, carryOut: 0, action: "close" };
}

type HistoryDealRow = {
  positionId?: string;
  profit?: number;
  commission?: number;
  swap?: number;
  type?: string;
  entryType?: string;
  symbol?: string;
  reason?: string;
  closeReason?: string;
  comment?: string;
  price?: number;
  openPrice?: number;
};

const REALIZED_DEAL_ENTRIES = new Set(["DEAL_ENTRY_OUT", "DEAL_ENTRY_INOUT"]);
const TRADE_DEAL_TYPES = new Set(["DEAL_TYPE_BUY", "DEAL_TYPE_SELL"]);

/** Sum closed-trade P&L (exit deals only), matching MT5 realized profit for a period. */
export function sumRealizedTradePnlFromDeals(deals: HistoryDealRow[]): number {
  let sum = 0;
  for (const d of deals) {
    const type = d.type ?? "";
    const entry = d.entryType ?? "";
    if (!TRADE_DEAL_TYPES.has(type)) continue;
    if (!REALIZED_DEAL_ENTRIES.has(entry)) continue;
    if (!d.symbol) continue;
    sum += Number(d.profit ?? 0) + Number(d.commission ?? 0) + Number(d.swap ?? 0);
  }
  return Math.round(sum * 100) / 100;
}

/** True if any closing deal for these positions exited via broker stop / stop-out. */
export function inferZoneStopLossFromDeals(
  deals: HistoryDealRow[],
  positionIds: Set<string>,
): { stopLossExit: boolean; exitPrice: number | null } {
  let exitPrice: number | null = null;
  let stopLossExit = false;
  for (const d of deals) {
    const pid = d.positionId != null ? String(d.positionId) : "";
    if (!pid || !positionIds.has(pid)) continue;
    const entry = d.entryType ?? "";
    if (!REALIZED_DEAL_ENTRIES.has(entry)) continue;
    const px = exitPriceFromDeal(d);
    if (px != null) exitPrice = px;
    if (dealIndicatesStopLoss(d)) stopLossExit = true;
  }
  return { stopLossExit, exitPrice };
}

/** Sum realized P&L from broker deals for the given MT5 position ids. */
export function sumDealPnlForPositions(
  deals: HistoryDealRow[],
  positionIds: Set<string>,
): number {
  let sum = 0;
  for (const d of deals) {
    const pid = d.positionId != null ? String(d.positionId) : "";
    if (!pid || !positionIds.has(pid)) continue;
    sum += Number(d.profit ?? 0) + Number(d.commission ?? 0) + Number(d.swap ?? 0);
  }
  return Math.round(sum * 100) / 100;
}

async function fetchAccountHistoryDeals(
  token: string,
  region: string,
  accountId: string,
  startMs: number,
  endMs: number,
): Promise<HistoryDealRow[]> {
  const startTime = new Date(startMs).toISOString();
  const endTime = new Date(endMs).toISOString();
  const res = await fetch(
    `${clientBase(region)}/users/current/accounts/${accountId}/history-deals/time/${encodeURIComponent(startTime)}/${encodeURIComponent(endTime)}`,
    { headers: authHeaders(token) },
  );
  if (!res.ok) return [];
  const deals = await res.json() as HistoryDealRow[];
  return Array.isArray(deals) ? deals : [];
}

/** After a zone closes, persist broker realized P&L for win-rate (incl. manual MT5 exits). */
async function settleZoneClosedPnl(accountId: string, zoneId: string): Promise<void> {
  try {
    const [zone] = await db.select().from(cascadeZonesTable)
      .where(and(eq(cascadeZonesTable.zoneId, zoneId), eq(cascadeZonesTable.accountId, accountId)))
      .limit(1);
    if (!zone || zone.status !== "CLOSED" || zone.closedAt == null) return;

    const posRows = await db.select({ positionId: zonePositionsTable.positionId })
      .from(zonePositionsTable)
      .where(eq(zonePositionsTable.zoneId, zoneId));
    const positionIds = new Set(posRows.map((r) => r.positionId));
    if (positionIds.size === 0) return;

    const token = getToken();
    const region = activeRegions.get(accountId) ?? knownAccounts.get(accountId)?.region ?? DEFAULT_REGION;
    const deals = await fetchAccountHistoryDeals(
      token,
      region,
      accountId,
      Number(zone.createdAt),
      Number(zone.closedAt) + 120_000,
    );
    if (zone.closedPnl == null) {
      const pnl = sumDealPnlForPositions(deals, positionIds);
      await db.update(cascadeZonesTable)
        .set({ closedPnl: pnl })
        .where(eq(cascadeZonesTable.zoneId, zoneId));
      console.log(`[zone ${zoneId}] closedPnl=${pnl} (${positionIds.size} position(s))`);
    }

    if (!zone.slHit && !zone.riskFreeSlExit) {
      const { stopLossExit, exitPrice } = inferZoneStopLossFromDeals(deals, positionIds);
      if (stopLossExit) {
        await finalizeZoneClose(accountId, zoneId, {
          stopLossExit: true,
          wasRiskFree: Boolean((zone as { wentRiskFree?: boolean }).wentRiskFree),
          exitPrice: exitPrice ?? undefined,
          exitPriceFromDeal: exitPrice != null && exitPrice > 0,
        });
      }
    }
  } catch (e) {
    console.warn(`[zone ${zoneId}] settleZoneClosedPnl failed:`, (e as Error).message);
  }
}

/** Build finalize opts from broker history (reconcile / restart closes). */
async function buildCloseFinalizeOptsForZone(
  accountId: string,
  zoneId: string,
  partial: { wasRiskFree: boolean; direction: "buy" | "sell" },
): Promise<CloseFinalizeOpts> {
  const base: CloseFinalizeOpts = {
    wasRiskFree: partial.wasRiskFree,
    exitPrice: exitPriceForZoneClose(accountId, partial.direction),
  };
  try {
    const [zone] = await db.select().from(cascadeZonesTable)
      .where(and(eq(cascadeZonesTable.zoneId, zoneId), eq(cascadeZonesTable.accountId, accountId)))
      .limit(1);
    if (!zone?.closedAt) return base;
    const posRows = await db.select({ positionId: zonePositionsTable.positionId })
      .from(zonePositionsTable)
      .where(eq(zonePositionsTable.zoneId, zoneId));
    const positionIds = new Set(posRows.map((r) => r.positionId));
    if (positionIds.size === 0) return base;
    const token = getToken();
    const region = activeRegions.get(accountId) ?? knownAccounts.get(accountId)?.region ?? DEFAULT_REGION;
    const deals = await fetchAccountHistoryDeals(
      token, region, accountId, Number(zone.createdAt), Number(zone.closedAt) + 120_000,
    );
    const { stopLossExit, exitPrice } = inferZoneStopLossFromDeals(deals, positionIds);
    return {
      ...base,
      stopLossExit,
      exitPrice: exitPrice ?? base.exitPrice,
      exitPriceFromDeal: exitPrice != null && exitPrice > 0,
    };
  } catch {
    return base;
  }
}

/** Deterministic magic number derived from zoneId for broker-side tagging. */
export function zoneMagicNumber(zoneId: string): number {
  let h = 47182;
  for (let i = 0; i < zoneId.length; i++) {
    h = ((h << 5) - h + zoneId.charCodeAt(i)) | 0;
  }
  return Math.abs(h % 900_000) + 100_000;
}

export type TpDisplayState = "pending" | "hit" | "disabled";

export function tpDisplayState(
  enabled: boolean,
  hit: boolean,
): TpDisplayState {
  if (!enabled) return "disabled";
  if (hit) return "hit";
  return "pending";
}

export function countEnabledTps(flags: {
  tp1Enabled: boolean; tp2Enabled: boolean; tp3Enabled: boolean; tp4Enabled: boolean;
  tp4Price?: number | null;
}): number {
  return [flags.tp1Enabled, flags.tp2Enabled, flags.tp3Enabled, flags.tp4Enabled].filter(Boolean).length;
}

export function countHitEnabledTps(z: {
  tp1Enabled: boolean; tp2Enabled: boolean; tp3Enabled: boolean; tp4Enabled: boolean;
  tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; tp4Hit: boolean;
  tp4Price?: number | null;
}): number {
  let n = 0;
  if (z.tp1Enabled && z.tp1Hit) n++;
  if (z.tp2Enabled && z.tp2Hit) n++;
  if (z.tp3Enabled && z.tp3Hit) n++;
  if (z.tp4Enabled && z.tp4Hit) n++;
  return n;
}

export function computeFinalTpReached(z: {
  tp1Enabled: boolean; tp2Enabled: boolean; tp3Enabled: boolean; tp4Enabled: boolean;
  tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; tp4Hit: boolean;
  tp4Price?: number | null;
}): 0 | 1 | 2 | 3 | 4 {
  let last: 0 | 1 | 2 | 3 | 4 = 0;
  if (z.tp1Enabled && z.tp1Hit) last = 1;
  if (z.tp2Enabled && z.tp2Hit) last = 2;
  if (z.tp3Enabled && z.tp3Hit) last = 3;
  if (z.tp4Enabled && z.tp4Hit) last = 4;
  return last;
}

export type ZonePrimaryOutcome = "RF" | "SL" | "MANUAL" | "TP4" | "TP3" | "TP2" | "TP1" | "NONE";

/** One history bucket per closed zone (not per position leg). */
export function zonePrimaryOutcome(row: {
  status: string;
  riskFreeSlExit?: boolean;
  slHit?: boolean;
  manualClose?: boolean;
  finalTpReached?: 0 | 1 | 2 | 3 | 4;
  tp1Enabled?: boolean;
  tp2Enabled?: boolean;
  tp3Enabled?: boolean;
  tp4Enabled?: boolean;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  tp3Hit?: boolean;
  tp4Hit?: boolean;
  tp4Price?: number | null;
}): ZonePrimaryOutcome {
  if (row.status !== "CLOSED") return "NONE";
  const final = row.finalTpReached ?? computeFinalTpReached({
    tp1Enabled: row.tp1Enabled ?? true,
    tp2Enabled: row.tp2Enabled ?? true,
    tp3Enabled: row.tp3Enabled ?? true,
    tp4Enabled: row.tp4Enabled ?? true,
    tp1Hit: Boolean(row.tp1Hit),
    tp2Hit: Boolean(row.tp2Hit),
    tp3Hit: Boolean(row.tp3Hit),
    tp4Hit: Boolean(row.tp4Hit),
    tp4Price: row.tp4Price,
  });
  // Highest TP reached wins before RF / SL / MANUAL (zone-classification-spec).
  if (final >= 4 && row.tp4Enabled !== false) return "TP4";
  if (Boolean(row.tp4Hit) && row.tp4Enabled !== false) return "TP4";
  if (final >= 3 && row.tp3Enabled !== false) return "TP3";
  if (final >= 2 && row.tp2Enabled !== false) return "TP2";
  if (final >= 1 && row.tp1Enabled !== false) return "TP1";
  if (row.riskFreeSlExit) return "RF";
  if (row.slHit) return "SL";
  if (row.manualClose) return "MANUAL";
  return "MANUAL";
}

/** True when a broker deal indicates the position exited via stop loss. */
export function dealIndicatesStopLoss(deal: unknown): boolean {
  if (!deal || typeof deal !== "object") return false;
  const d = deal as Record<string, unknown>;
  const reason = String(d.reason ?? d.closeReason ?? "").toUpperCase();
  if (
    reason.includes("SL")
    || reason.includes("STOP_LOSS")
    || reason.includes("STOP LOSS")
    || reason.includes("STOP_OUT")
    || reason.includes("STOPOUT")
  ) {
    return true;
  }
  const comment = String(d.comment ?? "").toUpperCase();
  return comment.includes("STOP LOSS") || comment.includes("[SL");
}

type CloseFinalizeOpts = {
  userInitiated?: boolean;
  stopLossExit?: boolean;
  /** Zone was RISK_FREE when the last leg closed (or wentRiskFree persisted). */
  wasRiskFree?: boolean;
  exitPrice?: number;
  /** True when exitPrice is the broker fill from a deal, not live bid/ask. */
  exitPriceFromDeal?: boolean;
};

export function exitPriceFromDeal(deal: unknown): number | null {
  if (!deal || typeof deal !== "object") return null;
  const d = deal as Record<string, unknown>;
  const p = Number(d.price ?? d.openPrice ?? 0);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** TP4 left manual in MT5 (tp4 pips = 0 → no tp4Price on the zone). */
export function isManualTp4Zone(tp4Price: number | null | undefined, tp4Enabled: boolean): boolean {
  return Boolean(tp4Enabled) && (tp4Price == null || !(tp4Price > 0));
}

/** Enforce ladder order — TP4 cannot be hit without TP3, etc. Strips manual-TP4 false positives. */
export function sanitizeZoneTpLadder<T extends {
  tp1Enabled?: boolean; tp2Enabled?: boolean; tp3Enabled?: boolean; tp4Enabled?: boolean;
  tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; tp4Hit: boolean;
  tp4Price?: number | null;
}>(z: T): T {
  const tp1Enabled = z.tp1Enabled ?? true;
  const tp2Enabled = z.tp2Enabled ?? true;
  const tp3Enabled = z.tp3Enabled ?? true;
  const tp4Enabled = z.tp4Enabled ?? true;
  const tp1Hit = tp1Enabled && Boolean(z.tp1Hit);
  const tp2Hit = tp2Enabled && tp1Hit && Boolean(z.tp2Hit);
  const tp3Hit = tp3Enabled && tp2Hit && Boolean(z.tp3Hit);
  const manualTp4 = isManualTp4Zone(z.tp4Price, tp4Enabled);
  const tp4Hit = tp4Enabled && Boolean(z.tp4Hit) && (
    manualTp4 ? true : tp3Hit
  );
  return { ...z, tp1Hit, tp2Hit, tp3Hit, tp4Hit };
}

/** Exit at/above TP3 region (manual TP4 leg) for buy; at/below for sell. */
export function exitPriceBeyondTp3(
  direction: "buy" | "sell",
  exitPrice: number,
  tp3Price: number | null,
): boolean {
  if (tp3Price == null || !(tp3Price > 0) || !(exitPrice > 0)) return false;
  return direction === "buy" ? exitPrice >= tp3Price : exitPrice <= tp3Price;
}

/** Early bailout in MT5 before TP1. */
export function exitPriceBeforeTp1(
  direction: "buy" | "sell",
  exitPrice: number,
  tp1Price: number | null,
): boolean {
  if (tp1Price == null || !(tp1Price > 0) || !(exitPrice > 0)) return false;
  return direction === "buy" ? exitPrice < tp1Price : exitPrice > tp1Price;
}

/**
 * Classify MT5/app zone close from broker fill price.
 * - manualClose: early exit before TP1 was ever reached (History MANUAL column).
 * - tp4Hit: manual TP4 slice closed at/above TP3, or automated TP4 price reached.
 * - TP1 already hit then closed below TP1: keeps tp1Hit, not manualClose.
 */
export function inferCloseOutcomeFromExitPrice(
  zone: {
    direction: "buy" | "sell";
    tp1Price: number | null;
    tp3Price: number | null;
    tp4Price: number | null;
    tp4Enabled: boolean;
    tp1Hit?: boolean;
    tp4Hit?: boolean;
  },
  exitPrice: number | null | undefined,
): { tp4Hit: boolean; manualClose: boolean } {
  const tp1Hit = Boolean(zone.tp1Hit);
  const priorTp4 = Boolean(zone.tp4Hit);

  if (exitPrice == null || !(exitPrice > 0)) {
    return { tp4Hit: priorTp4, manualClose: !tp1Hit && !priorTp4 };
  }

  if (exitPriceBeforeTp1(zone.direction, exitPrice, zone.tp1Price)) {
    if (tp1Hit) return { tp4Hit: false, manualClose: false };
    return { tp4Hit: false, manualClose: true };
  }

  if (isManualTp4Zone(zone.tp4Price, zone.tp4Enabled)
    && exitPriceBeyondTp3(zone.direction, exitPrice, zone.tp3Price)) {
    return { tp4Hit: true, manualClose: false };
  }

  if (zone.tp4Price != null && zone.tp4Price > 0
    && exitPriceBeyondTp3(zone.direction, exitPrice, zone.tp4Price)) {
    return { tp4Hit: true, manualClose: false };
  }

  return { tp4Hit: priorTp4, manualClose: false };
}

export function inferManualCloseFromExitPrice(
  zone: Parameters<typeof inferCloseOutcomeFromExitPrice>[0],
  exitPrice: number | null | undefined,
): boolean {
  return inferCloseOutcomeFromExitPrice(zone, exitPrice).manualClose;
}

/** Resolve close outcome for API/history (backfills legacy CLOSED rows missing flags). */
export function resolveCloseOutcome(row: {
  status: string;
  tp4Enabled: boolean;
  tp4Hit: boolean;
  tp4Price?: number | null;
  manualClose?: boolean;
  slHit?: boolean;
  riskFreeSlExit?: boolean;
}): { manualClose: boolean; slHit: boolean; riskFreeSlExit: boolean } {
  if (row.riskFreeSlExit) return { manualClose: false, slHit: false, riskFreeSlExit: true };
  if (row.slHit) return { manualClose: false, slHit: true, riskFreeSlExit: false };
  if (row.status !== "CLOSED") return { manualClose: false, slHit: false, riskFreeSlExit: false };
  if (row.manualClose != null) {
    return { manualClose: Boolean(row.manualClose), slHit: false, riskFreeSlExit: false };
  }
  return { manualClose: Boolean(row.manualClose), slHit: false, riskFreeSlExit: false };
}

/** Persist how a closed zone ended (manual app/MT5 exit vs SL vs TP ladder). */
async function finalizeZoneClose(
  accountId: string,
  zoneId: string,
  opts: CloseFinalizeOpts = {},
): Promise<void> {
  try {
    const [row] = await db.select().from(cascadeZonesTable)
      .where(and(eq(cascadeZonesTable.zoneId, zoneId), eq(cascadeZonesTable.accountId, accountId)))
      .limit(1);
    if (!row || row.status !== "CLOSED") return;

    let slHit = Boolean(opts.stopLossExit);
    let riskFreeSlExit = false;
    if (slHit && (opts.wasRiskFree || Boolean(row.wentRiskFree))) {
      riskFreeSlExit = true;
      slHit = false;
    }
    const baseFlags = {
      tp1Enabled: Boolean(row.tp1Enabled),
      tp2Enabled: Boolean(row.tp2Enabled),
      tp3Enabled: Boolean(row.tp3Enabled),
      tp4Enabled: Boolean(row.tp4Enabled),
      tp4Price: row.tp4Price,
    };
    let sanitized = sanitizeZoneTpLadder({
      ...baseFlags,
      tp1Hit: Boolean(row.tp1Hit),
      tp2Hit: Boolean(row.tp2Hit),
      tp3Hit: Boolean(row.tp3Hit),
      tp4Hit: Boolean(row.tp4Hit),
    });
    let manualClose = false;

    if (slHit) {
      manualClose = false;
    } else if (opts.exitPriceFromDeal && opts.exitPrice != null && opts.exitPrice > 0) {
      const inferred = inferCloseOutcomeFromExitPrice(
        {
          direction: row.direction as "buy" | "sell",
          tp1Price: row.tp1Price,
          tp3Price: row.tp3Price,
          tp4Price: row.tp4Price,
          tp4Enabled: baseFlags.tp4Enabled,
          tp1Hit: sanitized.tp1Hit,
          tp4Hit: sanitized.tp4Hit,
        },
        opts.exitPrice,
      );
      manualClose = inferred.manualClose;
      sanitized = sanitizeZoneTpLadder({
        ...baseFlags,
        ...sanitized,
        tp4Hit: inferred.tp4Hit || sanitized.tp4Hit,
      });
    } else if (opts.userInitiated) {
      manualClose = !sanitized.tp1Hit && !sanitized.tp4Hit;
    } else {
      manualClose = !sanitized.tp1Hit && !sanitized.tp4Hit;
    }

    const finalTp = computeFinalTpReached({
      tp1Enabled: baseFlags.tp1Enabled,
      tp2Enabled: baseFlags.tp2Enabled,
      tp3Enabled: baseFlags.tp3Enabled,
      tp4Enabled: baseFlags.tp4Enabled,
      tp1Hit: sanitized.tp1Hit,
      tp2Hit: sanitized.tp2Hit,
      tp3Hit: sanitized.tp3Hit,
      tp4Hit: sanitized.tp4Hit,
      tp4Price: row.tp4Price,
    });
    if (finalTp >= 1) slHit = false;

    await db.update(cascadeZonesTable)
      .set({
        slHit, manualClose, riskFreeSlExit,
        tp1Hit: sanitized.tp1Hit,
        tp2Hit: sanitized.tp2Hit,
        tp3Hit: sanitized.tp3Hit,
        tp4Hit: sanitized.tp4Hit,
      })
      .where(eq(cascadeZonesTable.zoneId, zoneId));
    const st = zoneStates.get(zoneId);
    if (st) {
      st.tp1Hit = sanitized.tp1Hit;
      st.tp2Hit = sanitized.tp2Hit;
      st.tp3Hit = sanitized.tp3Hit;
      st.tp4Hit = sanitized.tp4Hit;
      (st as ZoneState & { slHit?: boolean; manualClose?: boolean; riskFreeSlExit?: boolean }).slHit = slHit;
      (st as ZoneState & { manualClose?: boolean }).manualClose = manualClose;
      (st as ZoneState & { riskFreeSlExit?: boolean }).riskFreeSlExit = riskFreeSlExit;
    }
    console.log(`[zone ${zoneId}] close outcome rfSl=${riskFreeSlExit} sl=${slHit} manual=${manualClose} tp4Hit=${sanitized.tp4Hit} exit=${opts.exitPrice ?? "n/a"} deal=${opts.exitPriceFromDeal ?? false}`);
  } catch (e) {
    console.warn(`[zone ${zoneId}] finalizeZoneClose failed:`, (e as Error).message);
  }
}

function exitPriceForZoneClose(
  accountId: string,
  direction: "buy" | "sell",
  explicit?: number,
): number | undefined {
  if (explicit != null && explicit > 0) return explicit;
  const px = latestPrice(accountId);
  if (!px) return undefined;
  return direction === "buy" ? px.bid : px.ask;
}

// ── Zone TP Engine ───────────────────────────────────────────────────────────
// When a cascade is placed, create a "zone" anchored at the market price + direction.
// A background monitor watches each zone's open positions against TP1/TP2/TP3
// (TP4 is left for the user to handle manually) and fires partial closes / SL moves.

interface ZoneState {
  zoneId: string;
  accountId: string;
  direction: "buy" | "sell";
  anchorPrice: number;
  // Absolute TP prices typed per-trade. tp4Price null = TP4 left manual.
  tp1Price: number | null;
  tp2Price: number | null;
  tp3Price: number | null;
  tp4Price: number | null;
  // Per-zone TP close percentages (0-100). Default 25 each.
  // Gate formula: after level N fires, remaining = (100 - sum_through_N) / 100.
  tp1Pct: number;
  tp2Pct: number;
  tp3Pct: number;
  tp4Pct: number;
  tp1Enabled: boolean;
  tp2Enabled: boolean;
  tp3Enabled: boolean;
  tp4Enabled: boolean;
  // Original best-entry volume — configured-pct slices are computed from this so
  // partials stay consistent across TP1/2/3/4.
  originalVolume: number;
  // Cashout-at-anchor offset (pips into profit; 5p covers broker spread).
  cashoutPips: number;
  cashoutDone: boolean;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  tp4Hit: boolean;
  // SL→BE is a SEPARATE concern from the TP2 partial close. We track it on its
  // own so a broker-rejected SL move (e.g. code 10016 "Invalid stops") cannot
  // wedge the zone at TP2 forever — partial close succeeds, tp2Hit advances,
  // and BE retries on a bounded budget without re-firing TP2 every tick.
  // Both fields are runtime-only (not persisted); after a restart we re-attempt
  // BE up to the cap, which is safe (modify-sl is idempotent).
  tp2SlMoved: boolean;
  tp2BeAttempts: number;
  // True iff the SL we got onto the position(s) at TP2 is a "best effort"
  // protective SL (broker rejected true BE because price had retraced
  // through entry), NOT the actual break-even price. Persisted to DB so the
  // app warning chip survives a restart. Engine keeps trying to upgrade to
  // true BE on every tick while this is true; clears it once SL = openPrice
  // is accepted.
  tp2SlIsBestEffort: boolean;
  /** Auto SL→BE after this TP partial (1, 2, or 3). Baked in at zone creation. */
  autoBeAtTp: 1 | 2 | 3;
  status: "OPEN" | "RISK_FREE" | "CLOSED" | "ARMED";
  /** Sub-min-lot slice carry across TP steps (zone-keyed, survives leg closes). */
  tpCarryLot: number;
  busy: boolean; // debounce: prevent overlapping monitor ticks for this zone
  // In-memory mirror of zone_positions(status=OPEN) for this zone, used as a
  // fallback when the DB query inside evaluateZone fails — prevents transient
  // DB blips from silently blinding the TP engine for an entire zone. We carry
  // {volume, entryPrice} because TP partial-close logic needs the original
  // per-entry volume to compute the 25% slice (a fallback row without volume
  // would silently advance TP flags without actually closing anything).
  trackedPositions: Map<string, { volume: number; entryPrice: number; tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; tp4Hit: boolean }>;
  /** In-memory only — tracks which TP/runner push notifications have fired. */
  tpNotified?: {
    tp1: boolean; tp2: boolean; tp3: boolean;
    runner1: boolean; runner2: boolean; runner3: boolean;
  };
  runner1Price?: number | null;
  runner1Lots?: number | null;
  runner2Price?: number | null;
  runner2Lots?: number | null;
  runner3Price?: number | null;
  runner3Lots?: number | null;
  runner1Hit?: boolean;
  runner2Hit?: boolean;
  runner3Hit?: boolean;
  runner1Auto?: boolean;
  runner2Auto?: boolean;
  runner3Auto?: boolean;
  runnerActive?: boolean;
  /** Signed pip offset for Risk Free SL (-30..+30), stored at zone creation. */
  riskFreeOffset?: number;
  highestPriceSeen?: number;
  lowestPriceSeen?: number;
  tp1PassedAt?: number;
  tp2PassedAt?: number;
  tp3PassedAt?: number;
}

// Signed offset (pips) of the protective SL from the surviving entry:
//   negative → SL sits on the DRAWDOWN side  (small loss if reversed)
//   positive → SL sits on the PROFIT side    (locks in gain, tighter exit)
//   zero     → SL exactly at entry           (true break-even)
// User-tunable per-account via the risk-free POST body; this is the fallback.
export const ZONE_RISK_FREE_PIPS   = -10;
const ZONE_RISK_FREE_PIPS_MIN = -30;
const ZONE_RISK_FREE_PIPS_MAX =  30;
const ZONE_RISK_FREE_PIPS_STEP = 5;
export const ZONE_AUTO_BE_AT_TP_DEFAULT = 2;

export function sanitizeAutoBeAtTp(raw: unknown): 1 | 2 | 3 {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  // Legacy stored value 1 (BE after TP1) is no longer supported — always TP2 minimum.
  if (n === 3) return 3;
  if (n === 1 || n === 2) return 2;
  return ZONE_AUTO_BE_AT_TP_DEFAULT;
}

/** If the chosen TP is disabled, use the next enabled level (prefer later TPs). */
export function resolveAutoBeAtTp(
  requested: 1 | 2 | 3,
  enabled: { tp1: boolean; tp2: boolean; tp3: boolean },
): 1 | 2 | 3 {
  const normalized = requested === 1 ? 2 : requested;
  const candidates: (1 | 2 | 3)[] = [normalized, 2, 3].filter(
    (v, i, a) => a.indexOf(v) === i,
  ) as (1 | 2 | 3)[];
  for (const level of candidates) {
    if (level === 1) continue; // never BE at TP1
    if (level === 2 && enabled.tp2) return 2;
    if (level === 3 && enabled.tp3) return 3;
  }
  return ZONE_AUTO_BE_AT_TP_DEFAULT;
}

export function isAutoBeTriggerSatisfied(st: {
  autoBeAtTp: 1 | 2 | 3;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
}): boolean {
  // Legacy autoBeAtTp===1 zones are treated as TP2 — SL→BE never fires on TP1 alone.
  if (st.autoBeAtTp === 3) return st.tp3Hit;
  return st.tp2Hit;
}
const ZONE_CASHOUT_PIPS_DEFAULT = 5;   // anchor + 5p covers spread
const ZONE_MIN_LOT_PER_ENTRY    = 0.01; // broker minimum; lots ≥ 0.04 get 25% partials, smaller lots get a full close at TP1
// How close (in pips) price must come to a TP target before the engine fires
// the partial close. Lets TPs trigger through the broker spread instead of
// requiring the comparison side to print the exact level.
const ZONE_TP_TOLERANCE_PIPS    = 4;
/** Price-point buffer for manual close pill classification (close-partial endpoint). */
const TP_BUFFER                 = 5.0;
const MONITOR_KEEPALIVE_MS      = 30_000;
const lastTickAtByAccount       = new Map<string, number>();
// Max ticks we'll retry the SL→BE move after TP2 partials are closed.
// At the 3 s monitor interval (plus streaming tick attempts) this is
// roughly 15 s of trying; enough to ride out a transient broker burp
// but bounded so a hard rejection (code 10016) doesn't loop forever.
const MAX_TP2_BE_ATTEMPTS       = 5;
// Safety buffer (pips) ABOVE the broker's minimum stops-level when setting a
// "best effort" protective SL after a TP2 break-even rejection. 2 pips on
// XAUUSD ≈ 0.20 — enough cushion that the broker accepts the SL even when
// the spread widens momentarily, without giving up too much room.
const ZONE_BE_SAFETY_PIPS       = 2;

// ── Small DB-resilience + request-rate helpers ───────────────────────────────
// withDbRetry wraps a single DB call in up to N attempts with a small fixed
// backoff. Use it on reads/writes that fire from hot paths (per-tick zone
// evaluation, deal handlers) where Neon's occasional "Failed query" blips
// were causing ERROR-level log spam even though a 1-2 attempt retry fixes
// them. Only logs once, after all retries fail.
async function withDbRetry<T>(
  label: string, fn: () => Promise<T>, tries = 3, delayMs = 200,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; if (i < tries - 1) await sleep(delayMs); }
  }
  console.warn(`[db-retry] ${label} failed after ${tries} attempts: ${(lastErr as Error)?.message}`);
  throw lastErr;
}

// Per-account rolling 60s request counter for MetaAPI calls. Logs a WARN if
// any single account exceeds REQ_RATE_WARN_PER_MIN — a signal that we may be
// piling concurrent calls onto MetaAPI (which can indirectly slow down the
// user's trading experience if MetaAPI throttles us). The window is rolling:
// we keep timestamps and drop entries older than 60s on each record.
const REQ_RATE_WINDOW_MS = 60_000;
const REQ_RATE_WARN_PER_MIN = 60;
const accountReqLog = new Map<string, number[]>(); // accountId → timestamps
const accountReqWarnAt = new Map<string, number>(); // accountId → last warn ts (dedupe)
function recordApiCall(accountId: string): void {
  const now = Date.now();
  const log = accountReqLog.get(accountId) ?? [];
  // Drop entries older than the rolling window.
  let cut = 0;
  while (cut < log.length && log[cut]! < now - REQ_RATE_WINDOW_MS) cut++;
  if (cut > 0) log.splice(0, cut);
  log.push(now);
  accountReqLog.set(accountId, log);
  if (log.length > REQ_RATE_WARN_PER_MIN) {
    const lastWarn = accountReqWarnAt.get(accountId) ?? 0;
    if (now - lastWarn > 30_000) {
      console.warn(`[req-rate] ${accountId} sustained ${log.length} MetaAPI calls in last 60s (warn>${REQ_RATE_WARN_PER_MIN}) — review for accidental fan-out`);
      accountReqWarnAt.set(accountId, now);
    }
  }
}

// Periodically evict accounts whose last MetaAPI call (or warn) is well
// outside the rate window — otherwise transient/deleted/never-reconnected
// accountIds would accumulate forever in the rate-log maps. Runs every
// 5 minutes; cutoff is 2× the rate window so we only drop truly idle keys.
setInterval(() => {
  const cutoff = Date.now() - REQ_RATE_WINDOW_MS * 2;
  for (const [acct, log] of accountReqLog) {
    if (log.length === 0 || log[log.length - 1]! < cutoff) {
      accountReqLog.delete(acct);
      accountReqWarnAt.delete(acct);
    }
  }
  // Independently sweep warn-at entries whose log is already gone.
  for (const acct of accountReqWarnAt.keys()) {
    if (!accountReqLog.has(acct)) accountReqWarnAt.delete(acct);
  }
}, 5 * 60_000).unref?.();

// Compute a broker-safe protective SL for TP2 break-even.
//   - True BE = position openPrice.
//   - Broker rejects SL too close to current price (stops_level). For a SELL,
//     SL must sit at least N pips ABOVE the current ask; for a BUY, at least
//     N pips BELOW the current bid. We don't know stops_level precisely — we
//     use ZONE_BE_SAFETY_PIPS as the cushion which is comfortably above the
//     typical XAUUSD level.
//   - When current price has NOT crossed entry (still in profit relative to
//     direction), true BE is valid → returns { sl: openPrice, isBestEffort: false }.
//   - When price has crossed back through entry, true BE would be rejected →
//     returns the broker-safe SL with isBestEffort: true. This is still
//     protective (no worse than the current price + buffer) and lets the engine
//     keep upgrading toward true BE on later ticks.
function computeBrokerSafeBeSl(
  direction: "buy" | "sell", openPrice: number,
  price: { bid: number; ask: number },
): { sl: number; isBestEffort: boolean } {
  const safety = ZONE_BE_SAFETY_PIPS * PIP;
  if (direction === "sell") {
    // For SELL, valid SL > ask + safety. True BE valid iff openPrice >= ask + safety.
    const minSl = price.ask + safety;
    if (openPrice >= minSl) return { sl: parseFloat(openPrice.toFixed(2)), isBestEffort: false };
    return { sl: parseFloat(minSl.toFixed(2)), isBestEffort: true };
  }
  // BUY: valid SL < bid - safety. True BE valid iff openPrice <= bid - safety.
  const maxSl = price.bid - safety;
  if (openPrice <= maxSl) return { sl: parseFloat(openPrice.toFixed(2)), isBestEffort: false };
  return { sl: parseFloat(maxSl.toFixed(2)), isBestEffort: true };
}

// Pure helper: compute the "risk free" stop-loss price for a zone's surviving
// entry. `pips` is SIGNED relative to entry from the trader's perspective:
//   negative → SL on the DRAWDOWN side (small loss if reversed; protective)
//   positive → SL on the PROFIT side   (locks in gain; tighter exit)
//   zero     → SL exactly at entry (true break-even)
// For BUY: profit is above entry, drawdown is below → SL = entry + pips*PIP.
// For SELL: profit is below entry, drawdown is above → SL = entry − pips*PIP.
// Exported so regression tests can lock the direction in (it was once inverted).
export function computeRiskFreeSl(
  direction: "buy" | "sell",
  entryPrice: number,
  pips: number = ZONE_RISK_FREE_PIPS,
): number {
  const offset = pips * PIP;
  const raw = direction === "buy" ? entryPrice + offset : entryPrice - offset;
  return parseFloat(raw.toFixed(2));
}

// Clamp + snap user-supplied risk-free pips to the supported -30..+30 / step 5
// grid. Returns the configured default for non-numeric / out-of-range input.
export function sanitizeRiskFreePips(input: unknown): number {
  // `Number(null)` is 0 and `Number("")` is 0, so reject those explicitly
  // — only accept numbers and numeric strings as valid input.
  let n: number;
  if (typeof input === "number") {
    n = input;
  } else if (typeof input === "string" && input.trim() !== "") {
    n = Number(input);
  } else {
    return ZONE_RISK_FREE_PIPS;
  }
  if (!Number.isFinite(n)) return ZONE_RISK_FREE_PIPS;
  const clamped = Math.max(ZONE_RISK_FREE_PIPS_MIN, Math.min(ZONE_RISK_FREE_PIPS_MAX, n));
  return Math.round(clamped / ZONE_RISK_FREE_PIPS_STEP) * ZONE_RISK_FREE_PIPS_STEP;
}
const ZONE_ASSOC_WINDOW_MS  = 30_000; // limits placed within 30s of market attach to the same zone
// Orphan-attach window: a cascade limit POST response that arrived BEFORE its
// sibling market POST should land within milliseconds — keep this tight so
// leftover orphans from an earlier failed cascade do not attach to a fresh
// zone created later in the same 30s window.
// Originally 5s, but a slow market POST (>5s round-trip to MetaAPI) would
// cause already-buffered cascade limit POSTs to be rejected as "stale" once
// the market response finally created the zone — leaving those limits with
// `cascadePlacedOrderIds` membership but NO `zoneLimitOrders` mapping. Their
// later fills then fall through onDealAdded with no zone to link to, the
// resulting positions become orphans, and when the market leg closes the
// zone is marked CLOSED while the orphan positions remain open as
// "standalone" entries in the Positions tab. Matching the 30s assoc window
// closes that race; cross-cascade misattachment is already prevented by the
// 30s expiresAt on each orphan entry.
const ZONE_ORPHAN_DRAIN_WINDOW_MS = 30_000;

// In-memory state, hydrated from DB on startup.
const zoneStates = new Map<string, ZoneState>();          // zoneId → state
/** Per MetaAPI account: pending limit orderId → owning zoneId (never global across accounts). */
const zoneLimitOrdersByAccount = new Map<string, Map<string, string>>();

function zoneLimitMap(accountId: string): Map<string, string> {
  let m = zoneLimitOrdersByAccount.get(accountId);
  if (!m) {
    m = new Map();
    zoneLimitOrdersByAccount.set(accountId, m);
  }
  return m;
}

export function setZoneLimitOrder(accountId: string, orderId: string, zoneId: string): void {
  if (!orderId) return;
  zoneLimitMap(accountId).set(orderId, zoneId);
}

export function getZoneLimitOrder(accountId: string, orderId: string): string | undefined {
  return zoneLimitMap(accountId).get(orderId);
}

export function deleteZoneLimitOrder(accountId: string, orderId: string): void {
  zoneLimitMap(accountId).delete(orderId);
}

export function orderIdsForZone(accountId: string, zoneId: string): string[] {
  const out: string[] = [];
  for (const [oid, zid] of zoneLimitMap(accountId).entries()) {
    if (zid === zoneId) out.push(oid);
  }
  return out;
}

function orderMappedToActiveZone(accountId: string, orderId: string): boolean {
  return zoneLimitMap(accountId).has(orderId);
}
const pendingZoneAssoc = new Map<string, { zoneId: string; direction: "buy" | "sell"; expiresAt: number }>(); // accountId → most recent zone (legacy fallback)
const pendingZoneByZone = new Map<string, Map<string, { zoneId: string; direction: "buy" | "sell"; expiresAt: number }>>(); // accountId → zoneId → assoc
// Race buffer: when a cascade limit POST response arrives BEFORE the market
// POST response has set up pendingZoneAssoc (the app fires them in parallel),
// stash the orderId here so the next prepareZoneForCascade for this account
// can attach it. Expires after ZONE_ASSOC_WINDOW_MS to avoid leaking across
// unrelated cascades.
const orphanedCascadeLimits = new Map<string, { orderId: string; expiresAt: number; bufferedAt: number }[]>();

function resolvePendingZoneAssoc(
  accountId: string,
  direction: "buy" | "sell" | null,
): { zoneId: string; direction: "buy" | "sell" } | null {
  const now = Date.now();
  if (direction) {
    const byZone = pendingZoneByZone.get(accountId);
    if (byZone) {
      for (const entry of byZone.values()) {
        if (entry.expiresAt >= now && entry.direction === direction) return entry;
      }
    }
  }
  const pending = pendingZoneAssoc.get(accountId);
  if (!pending || pending.expiresAt < now) {
    if (pending) pendingZoneAssoc.delete(accountId);
    return null;
  }
  if (direction && pending.direction !== direction) return null;
  return pending;
}

function newZoneId(): string {
  return `z_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Sync prep — reserve a zoneId + pending association so cascade limits
// submitted *immediately* after the market order can attach without waiting
// for the anchor lookup / DB inserts. Returns the prepared zone state.
//
// `tps` carries the user-typed absolute TP prices. TP1-3 are required by the
// trade endpoint validator; TP4 is optional (null = left manual).
function prepareZoneForCascade(
  accountId: string, direction: "buy" | "sell", userId: string | undefined,
  tps: {
    tp1Price: number; tp2Price: number; tp3Price: number; tp4Price: number | null;
    tp1Pct: number; tp2Pct: number; tp3Pct: number; tp4Pct: number;
    autoBeAtTp?: unknown;
  },
  originalVolume: number,
  explicitZoneId?: string,
  anchorPriceHint = 0,
  riskFreeOffset = 0,
): ZoneState {
  void userId;
  const zoneId = explicitZoneId && /^z_[a-z0-9_]+$/i.test(explicitZoneId) ? explicitZoneId : newZoneId();
  const tp1Enabled = tps.tp1Pct > 0;
  const tp2Enabled = tps.tp2Pct > 0;
  const tp3Enabled = tps.tp3Pct > 0;
  const tp4Enabled = tps.tp4Pct > 0;
  const state: ZoneState = {
    zoneId, accountId, direction, anchorPrice: anchorPriceHint > 0 ? anchorPriceHint : 0,
    tp1Price: tps.tp1Price, tp2Price: tps.tp2Price, tp3Price: tps.tp3Price, tp4Price: tps.tp4Price,
    tp1Pct: tps.tp1Pct, tp2Pct: tps.tp2Pct, tp3Pct: tps.tp3Pct, tp4Pct: tps.tp4Pct,
    tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
    originalVolume,
    cashoutPips: ZONE_CASHOUT_PIPS_DEFAULT,
    cashoutDone: false,
    // Disabled TPs stay false — they are not "hit", they are skipped by the engine.
    tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false,
    tp2SlMoved: false, tp2BeAttempts: 0, tp2SlIsBestEffort: false,
    autoBeAtTp: resolveAutoBeAtTp(sanitizeAutoBeAtTp(tps.autoBeAtTp), {
      tp1: tp1Enabled, tp2: tp2Enabled, tp3: tp3Enabled,
    }),
    status: "OPEN", tpCarryLot: 0, busy: false,
    trackedPositions: new Map(),
    riskFreeOffset: sanitizeRiskFreePips(riskFreeOffset),
  };
  markZonePlacing(zoneId);
  // Do NOT set zoneStates here — the zone is added to the in-memory map only
  // after earlyPersist succeeds in the caller's async block (DB-first ordering).
  pendingZoneAssoc.set(accountId, { zoneId, direction, expiresAt: Date.now() + ZONE_ASSOC_WINDOW_MS });
  // Also index by zoneId so concurrent zones on the same account don't overwrite each other.
  const accountPending = pendingZoneByZone.get(accountId) ?? new Map();
  accountPending.set(zoneId, { zoneId, direction, expiresAt: Date.now() + ZONE_ASSOC_WINDOW_MS });
  pendingZoneByZone.set(accountId, accountPending);
  // Drain any cascade limit orderIds whose POST response landed before this
  // market response. Only consider orphans buffered very recently (sibling
  // race resolves in ms) so stale orphans from a previous cascade attempt
  // can't attach themselves to this brand new zone.
  const orphans = orphanedCascadeLimits.get(accountId);
  if (orphans && orphans.length > 0) {
    const now = Date.now();
    const recentCutoff = now - ZONE_ORPHAN_DRAIN_WINDOW_MS;
    for (const o of orphans) {
      if (o.expiresAt < now) continue;
      if (o.bufferedAt < recentCutoff) {
        console.warn(`[zone ${zoneId}] skipping stale orphan orderId=${o.orderId} (buffered ${now - o.bufferedAt}ms ago, > ${ZONE_ORPHAN_DRAIN_WINDOW_MS}ms)`);
        continue;
      }
      setZoneLimitOrder(accountId, o.orderId, zoneId);
      void db.insert(zoneOrdersTable)
        .values({ zoneId, orderId: o.orderId, createdAt: now })
        .onConflictDoNothing()
        .catch((e: Error) => console.warn(`[zone ${zoneId}] orphan-attach persist orderId=${o.orderId} failed:`, e.message));
      console.log(`[zone ${zoneId}] attached orphaned cascade limit orderId=${o.orderId} (arrived before zone was prepared)`);
    }
    orphanedCascadeLimits.delete(accountId);
  }
  return state;
}

// Async finalization — persist the zone and its market position. Anchor may be
// updated to the real fill price by the caller before this runs. evaluateZone
// guards on `anchorPrice > 0`, so an unfilled anchor simply pauses TP checks
// until this completes.
async function persistPreparedZone(
  state: ZoneState,
  userId: string | undefined,
  positionId: string,
  volume: number,
): Promise<void> {
  // Intentionally no try/catch — DB errors are rethrown so the caller's
  // async block can enforce DB-first ordering: zoneStates is updated only
  // after this promise resolves successfully. Swallowing errors here was the
  // root cause of zones entering memory without a DB row (restart-unsafe).
  const now = Date.now();
  await withDbRetry(`persistZone ${state.zoneId}`, () =>
    db.insert(cascadeZonesTable).values({
      zoneId: state.zoneId, accountId: state.accountId, userId: userId ?? null,
      direction: state.direction, anchorPrice: state.anchorPrice,
      tp1Price: state.tp1Price, tp2Price: state.tp2Price,
      tp3Price: state.tp3Price, tp4Price: state.tp4Price,
      tp1Pct: state.tp1Pct, tp2Pct: state.tp2Pct, tp3Pct: state.tp3Pct, tp4Pct: state.tp4Pct,
      tp1Enabled: state.tp1Enabled, tp2Enabled: state.tp2Enabled, tp3Enabled: state.tp3Enabled, tp4Enabled: state.tp4Enabled,
      originalVolume: state.originalVolume,
      cashoutPips: state.cashoutPips, cashoutDone: false,
      tp1Hit: state.tp1Hit, tp2Hit: state.tp2Hit, tp3Hit: state.tp3Hit, tp4Hit: state.tp4Hit,
      autoBeAtTp: state.autoBeAtTp,
      riskFreeOffset: state.riskFreeOffset ?? 0,
      status: "OPEN", createdAt: now,
    } as typeof cascadeZonesTable.$inferInsert).onConflictDoNothing());
  await withDbRetry(`persistZonePos ${state.zoneId}`, () =>
    db.insert(zonePositionsTable).values({
      zoneId: state.zoneId, positionId, entryPrice: state.anchorPrice, volume,
      status: "OPEN", createdAt: now,
    }).onConflictDoNothing());
  // Seed the in-memory cache for the anchor leg so a DB blip immediately
  // after zone creation can't blind evaluateZone to the market entry.
  state.trackedPositions.set(positionId, { volume, entryPrice: state.anchorPrice, tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false });
  if (userId) zoneIdToUserId.set(state.zoneId, userId);
  logEvent("zone.create", { accountId: state.accountId, zoneId: state.zoneId, direction: state.direction, anchorPrice: state.anchorPrice, positionId, volume });
}

/** Armed @-price cascade: zone row only — no positions until first limit fills. */
async function persistArmedZone(state: ZoneState, userId: string | undefined): Promise<void> {
  const now = Date.now();
  await db.insert(cascadeZonesTable).values({
    zoneId: state.zoneId, accountId: state.accountId, userId: userId ?? null,
    direction: state.direction, anchorPrice: state.anchorPrice,
    tp1Price: state.tp1Price, tp2Price: state.tp2Price,
    tp3Price: state.tp3Price, tp4Price: state.tp4Price,
    tp1Pct: state.tp1Pct, tp2Pct: state.tp2Pct, tp3Pct: state.tp3Pct, tp4Pct: state.tp4Pct,
    tp1Enabled: state.tp1Enabled, tp2Enabled: state.tp2Enabled, tp3Enabled: state.tp3Enabled, tp4Enabled: state.tp4Enabled,
    originalVolume: state.originalVolume,
    cashoutPips: state.cashoutPips, cashoutDone: false,
    tp1Hit: state.tp1Hit, tp2Hit: state.tp2Hit, tp3Hit: state.tp3Hit, tp4Hit: state.tp4Hit,
    autoBeAtTp: state.autoBeAtTp,
    riskFreeOffset: state.riskFreeOffset ?? 0,
    status: "ARMED", createdAt: now,
  } as typeof cascadeZonesTable.$inferInsert).onConflictDoNothing();
  if (userId) zoneIdToUserId.set(state.zoneId, userId);
  logEvent("zone.arm", { accountId: state.accountId, zoneId: state.zoneId, direction: state.direction, anchorPrice: state.anchorPrice });
}

/** After delete-orders on an @-price zone with no fills, remove it from the app. */
async function closeArmedZoneIfDisarmed(
  accountId: string, zoneId: string, token: string, region: string,
  opts?: { force?: boolean },
): Promise<void> {
  const st = await loadZone(zoneId);
  if (!st || st.accountId !== accountId || st.status !== "ARMED") return;
  const openRows = await db.select().from(zonePositionsTable)
    .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.status, "OPEN")));
  if (openRows.length > 0) return;
  if (!opts?.force) {
    const pendingLeft = await zoneHasLivePendingCascadeLimits(token, region, accountId, zoneId);
    if (pendingLeft) return;
  }
  const closedAt = Date.now();
  await db.update(cascadeZonesTable)
    .set({ status: "CLOSED", closedAt, manualClose: true })
    .where(eq(cascadeZonesTable.zoneId, zoneId));
  st.status = "CLOSED";
  await finalizeZoneClose(accountId, zoneId, {
    exitPrice: exitPriceForZoneClose(accountId, st.direction),
  });
  console.log(`[zone ${zoneId}] ARMED disarmed — no pending orders or positions, zone closed`);
}

async function activateArmedZone(zoneId: string): Promise<void> {
  const [row] = await db.select({ status: cascadeZonesTable.status })
    .from(cascadeZonesTable).where(eq(cascadeZonesTable.zoneId, zoneId)).limit(1);
  if (!row || row.status !== "ARMED") return;
  await db.update(cascadeZonesTable).set({ status: "OPEN" }).where(eq(cascadeZonesTable.zoneId, zoneId));
  const st = zoneStates.get(zoneId);
  if (st) st.status = "OPEN";
  console.log(`[zone ${zoneId}] ARMED → OPEN (first position filled)`);
  broadcastZoneUpdate(zoneId);
}

async function attachLimitOrderToZone(
  accountId: string,
  orderId: string,
  comment?: string,
  direction?: "buy" | "sell" | null,
): Promise<void> {
  const zoneFromComment = parseZoneIdFromComment(comment);
  if (zoneFromComment) {
    setZoneLimitOrder(accountId, orderId, zoneFromComment);
    try {
      await db.insert(zoneOrdersTable).values({
        zoneId: zoneFromComment, orderId, createdAt: Date.now(),
      }).onConflictDoNothing();
    } catch (e) {
      console.warn(`[zone ${zoneFromComment}] persist order=${orderId} failed:`, (e as Error).message);
    }
    console.log(`[zone ${zoneFromComment}] tracking limit orderId=${orderId} (from comment)`);
    return;
  }
  const pending = resolvePendingZoneAssoc(accountId, direction ?? null);
  if (!pending) {
    // Race: this cascade limit POST resolved before the companion market POST
    // could call prepareZoneForCascade. Buffer the orderId so the next zone
    // prepared for this account picks it up.
    const now = Date.now();
    const arr = orphanedCascadeLimits.get(accountId) ?? [];
    arr.push({ orderId, expiresAt: now + ZONE_ASSOC_WINDOW_MS, bufferedAt: now });
    orphanedCascadeLimits.set(accountId, arr);
    console.log(`[zone ?] buffered cascade limit orderId=${orderId} for account=${accountId} (no zone prepared yet)`);
    return;
  }
  setZoneLimitOrder(accountId, orderId, pending.zoneId);
  try {
    await db.insert(zoneOrdersTable).values({
      zoneId: pending.zoneId, orderId, createdAt: Date.now(),
    }).onConflictDoNothing();
  } catch (e) {
    console.warn(`[zone ${pending.zoneId}] persist order=${orderId} failed:`, (e as Error).message);
  }
  console.log(`[zone ${pending.zoneId}] tracking limit orderId=${orderId}`);
}

async function recordZonePositionFill(
  zoneId: string, positionId: string, entryPrice: number, volume: number,
): Promise<void> {
  // Retry on transient DB errors. Losing this insert means the position is
  // forever invisible to evaluateZone (no row → never in `live` → cashout and
  // TPs skip it). Six attempts over ~30s covers typical pool/connection blips
  // without blocking the trade flow indefinitely.
  const delays = [200, 500, 1000, 2500, 5000, 15000];
  let lastErr: unknown = null;
  for (let i = 0; i <= delays.length; i++) {
    try {
      await db.insert(zonePositionsTable).values({
        zoneId, positionId, entryPrice, volume, status: "OPEN", createdAt: Date.now(),
      }).onConflictDoNothing();
      // Mirror into the in-memory cache so evaluateZone keeps working through
      // DB blips even if the next select() throws.
      const st = zoneStates.get(zoneId);
      if (st) st.trackedPositions.set(positionId, { volume, entryPrice, tp1Hit: false, tp2Hit: false, tp3Hit: false, tp4Hit: false });
      console.log(`[zone ${zoneId}] linked filled positionId=${positionId} @${entryPrice} vol=${volume}${i > 0 ? ` (after ${i} retries)` : ""}`);
      void activateArmedZone(zoneId);
      return;
    } catch (e) {
      lastErr = e;
      if (i < delays.length) {
        console.warn(`[zone ${zoneId}] fill persist attempt ${i + 1} failed for posId=${positionId}: ${(e as Error).message} — retrying in ${delays[i]}ms`);
        await sleep(delays[i]!);
      }
    }
  }
  console.error(`[zone ${zoneId}] fill persist FAILED after retries for posId=${positionId} @${entryPrice}:`, (lastErr as Error)?.message);
}

/**
 * All open MT5 legs for this zone (DB OPEN rows ∪ comment/magic-tagged positions).
 * Anchor is often missing from OPEN rows while limits are tracked — union prevents
 * close-zone from closing only the ladder and leaving the market entry running.
 */
/**
 * TP2 zone housekeeping (per zone): cancel all unfilled cascade limits, then
 * SL→BE on active legs. On first zone TP2 → all legs; on late legs → those legs only.
 */
async function applyZoneTp2Housekeeping(
  token: string,
  region: string,
  zoneId: string,
  st: ZoneState,
  opts: { beLegs?: LivePosition[]; isFirstZoneTp2: boolean; cancelLimits?: boolean },
): Promise<void> {
  try {
    if (opts.cancelLimits !== false) {
      await cancelZoneLimits(token, region, st.accountId, zoneId);
      if (opts.isFirstZoneTp2) {
        console.log(`[tp2] cancelled unfilled limits for ${zoneId}`);
      }
    }
    if (!isAutoBeTriggerSatisfied(st)) return;

    const legs = opts.beLegs ?? await resolveLivePositionsForZoneAction(
      token, region, st.accountId, zoneId, st, { fresh: true },
    );
    if (legs.length === 0) return;

    const price = await priceForZoneEval(st.accountId, token, region, legs[0]!.symbol || "XAUUSD");
    if (!price) return;

    let allTrueBe = true;
    const results = await Promise.all(legs.map(async (p) => {
      const { sl, isBestEffort } = computeBrokerSafeBeSl(st.direction, p.openPrice, price);
      if (isBestEffort) allTrueBe = false;
      const ok = await modifyZonePositionSl(token, region, st.accountId, p.id, sl);
      return { ok, isBestEffort };
    }));
    const allOk = results.every((r) => r.ok);

    if (allOk && allTrueBe) {
      const wasBestEffort = st.tp2SlIsBestEffort;
      st.tp2SlMoved = true;
      st.tp2SlIsBestEffort = false;
      if (wasBestEffort) {
        await withDbRetry(`zones[${zoneId}].tp2SlIsBestEffort=false`,
          () => db.update(cascadeZonesTable).set({ tp2SlIsBestEffort: false } as Record<string, unknown>)
            .where(eq(cascadeZonesTable.zoneId, zoneId)),
        ).catch(() => {/* logged inside withDbRetry */});
      }
      console.log(`[tp2] ${zoneId} SL→BE on ${legs.length} leg(s)${opts.isFirstZoneTp2 ? "" : " (late leg)"}`);
    } else if (allOk) {
      if (!st.tp2SlIsBestEffort) {
        st.tp2SlIsBestEffort = true;
        await withDbRetry(`zones[${zoneId}].tp2SlIsBestEffort=true`,
          () => db.update(cascadeZonesTable).set({ tp2SlIsBestEffort: true } as Record<string, unknown>)
            .where(eq(cascadeZonesTable.zoneId, zoneId)),
        ).catch(() => {/* logged inside withDbRetry */});
        console.warn(`[tp2] ${zoneId} SL set to best-effort protective level`);
      }
    } else if (opts.isFirstZoneTp2 && st.tp2BeAttempts < MAX_TP2_BE_ATTEMPTS) {
      st.tp2BeAttempts += 1;
    }
  } catch (err) {
    console.error(`[tp2] housekeeping failed for ${zoneId}:`, (err as Error).message);
  }
}

async function markPositionTpLevelHit(
  zoneId: string, positionId: string, lvl: 1 | 2 | 3 | 4, st: ZoneState,
): Promise<void> {
  const key = `tp${lvl}Hit` as const;
  const cached = st.trackedPositions.get(positionId);
  if (cached) cached[key] = true;
  await db.update(zonePositionsTable)
    .set({ [key]: true })
    .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.positionId, positionId)))
    .catch((e: Error) => console.warn(`[zone ${zoneId}] pos ${positionId} ${key} persist failed:`, e.message));
}

/** Close this zone's configured tpPct from each leg that still needs level `lvl`. */
async function closeTpSliceOnEveryLiveLeg(
  token: string,
  region: string,
  st: ZoneState,
  zoneId: string,
  legs: LivePosition[],
  lvl: 1 | 2 | 3,
): Promise<number> {
  const tpPct = st[`tp${lvl}Pct`];
  if (!(tpPct > 0) || st[`tp${lvl}Enabled`] === false) return 0;
  const isLast = isLastEnabledTpLevel(lvl, st);
  const LOT_STEP = 0.01;
  let totalClosed = 0;
  for (const leg of legs) {
    if (!legNeedsTpSlice(leg, st, lvl)) continue;
    const cached = st.trackedPositions.get(leg.id);
    const cascadeLot = cached?.volume && cached.volume > 0 ? cached.volume : leg.volume;
    const slice = computeTpSliceVolume({
      cascadeLot,
      tpPct,
      remainingVol: leg.volume,
      isLastEnabledTp: isLast,
    });
    if (slice.closeVol < LOT_STEP) continue;
    const toClose = Math.min(slice.closeVol, leg.volume);
    let closed = 0;
    if (toClose >= leg.volume - 1e-9) {
      if (await closeZonePosition(token, region, st.accountId, leg.id)) closed = leg.volume;
    } else if (await closeZonePosition(token, region, st.accountId, leg.id, toClose)) {
      closed = toClose;
    }
    if (closed > 0) {
      totalClosed += closed;
      await markPositionTpLevelHit(zoneId, leg.id, lvl, st);
    }
  }
  return totalClosed;
}

async function resolveLivePositionsForZoneAction(
  token: string,
  region: string,
  accountId: string,
  zoneId: string,
  st: ZoneState,
  opts?: { fresh?: boolean },
): Promise<LivePosition[]> {
  const allLive = await fetchOpenPositions(token, region, accountId, opts);
  const openRows = await db.select().from(zonePositionsTable)
    .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.status, "OPEN")));
  const trackedIds = new Set(openRows.map((z) => z.positionId));
  const fromDb = allLive.filter((p) => trackedIds.has(p.id));
  const tagged = allLive.filter((p) => positionBelongsToZone(p, zoneId));
  const byId = new Map<string, LivePosition>();
  for (const p of fromDb) byId.set(p.id, p);
  for (const p of tagged) byId.set(p.id, p);
  const live = [...byId.values()];
  if (live.length === 0) return [];

  let relinked = 0;
  for (const p of live) {
    const [row] = await db.select({
      status: zonePositionsTable.status,
      volume: zonePositionsTable.volume,
      entryPrice: zonePositionsTable.entryPrice,
    })
      .from(zonePositionsTable)
      .where(and(
        eq(zonePositionsTable.zoneId, zoneId),
        eq(zonePositionsTable.positionId, p.id),
      ))
      .limit(1);
    if (row?.status === "CLOSED") {
      await db.update(zonePositionsTable)
        .set({ status: "OPEN" })
        .where(and(
          eq(zonePositionsTable.zoneId, zoneId),
          eq(zonePositionsTable.positionId, p.id),
        ));
      relinked++;
    } else if (!row) {
      await recordZonePositionFill(zoneId, p.id, p.openPrice, p.volume);
      relinked++;
    }
    const cached = st.trackedPositions.get(p.id);
    // Keep the original fill volume from DB for TP partial % math — broker
    // live volume shrinks after partials; overwriting with p.volume makes the
    // engine think TP1 already fired and skip real closes.
    const origVol = row?.volume != null ? Number(row.volume) : p.volume;
    const entry = row?.entryPrice != null ? Number(row.entryPrice) : p.openPrice;
    st.trackedPositions.set(p.id, {
      volume: origVol,
      entryPrice: entry,
      tp1Hit: cached?.tp1Hit ?? false,
      tp2Hit: cached?.tp2Hit ?? false,
      tp3Hit: cached?.tp3Hit ?? false,
      tp4Hit: cached?.tp4Hit ?? false,
    });
  }
  if (relinked > 0 || tagged.length > fromDb.length) {
    console.log(
      `[zone ${zoneId}] resolved ${live.length} leg(s) for zone action (dbOpen=${fromDb.length} tagged=${tagged.length} relinked=${relinked})`,
    );
  }
  return live;
}

/** Wrongly CLOSED in DB while MT5 still has legs — reopen so TPs keep firing. */
async function reopenClosedZoneIfBrokerLegsRemain(
  token: string,
  region: string,
  accountId: string,
  zoneId: string,
  st: ZoneState,
): Promise<boolean> {
  if (st.status !== "CLOSED") return false;
  const brokerOpen = await brokerHasOpenLegsForZone(token, region, accountId, zoneId);
  if (!brokerOpen) return false;
  await db.update(cascadeZonesTable)
    .set({ status: "OPEN", closedAt: null, manualClose: false })
    .where(and(eq(cascadeZonesTable.zoneId, zoneId), eq(cascadeZonesTable.accountId, accountId)));
  st.status = "OPEN";
  console.log(`[zone ${zoneId}] reopened CLOSED→OPEN (broker still has ${accountId} legs)`);
  broadcastZoneUpdate(zoneId);
  return true;
}

async function markZonePositionsClosedInDb(zoneId: string, positionIds: string[]): Promise<void> {
  if (positionIds.length === 0) return;
  await db.update(zonePositionsTable)
    .set({ status: "CLOSED" })
    .where(and(
      eq(zonePositionsTable.zoneId, zoneId),
      inArray(zonePositionsTable.positionId, positionIds),
    ));
}

async function closeLiveZoneLegs(
  token: string,
  region: string,
  accountId: string,
  zoneId: string,
  live: LivePosition[],
): Promise<{ failed: string[] }> {
  const closeResults = await Promise.all(
    live.map(async (p) => {
      try {
        return { id: p.id, ok: await closeZonePosition(token, region, accountId, p.id) };
      } catch (e) {
        console.warn(`[zone ${zoneId}] close threw for posId=${p.id}:`, (e as Error).message);
        return { id: p.id, ok: false };
      }
    }),
  );
  const failed = closeResults.filter((r) => !r.ok).map((r) => r.id);
  const closedIds = closeResults.filter((r) => r.ok).map((r) => r.id);
  await markZonePositionsClosedInDb(zoneId, closedIds);
  return { failed };
}

// Called on every DEAL_ENTRY_OUT. A partial close ALSO fires this event with
// the closed slice as `volume` — the position stays open with its remaining
// volume. To avoid marking a still-open position CLOSED, verify the position
// no longer exists on MetaAPI before flipping the row.
async function markZonePositionClosed(
  accountId: string,
  positionId: string,
  exitDeal?: unknown,
  options: { intentionalFullClose?: boolean } = {},
): Promise<void> {
  try {
    // Join through cascade_zones so we only act on rows belonging to *this*
    // account — MT5 position IDs can be reused across accounts/brokers.
    const rows = await withDbRetry(`markClosed.lookup posId=${positionId}`, () => db
      .select({ zoneId: zonePositionsTable.zoneId, zoneAccountId: cascadeZonesTable.accountId })
      .from(zonePositionsTable)
      .innerJoin(cascadeZonesTable, eq(zonePositionsTable.zoneId, cascadeZonesTable.zoneId))
      .where(and(eq(zonePositionsTable.positionId, positionId), eq(cascadeZonesTable.accountId, accountId)))
      .limit(1)
    );
    const zoneId = rows[0]?.zoneId;
    if (!zoneId) return;
    const st = zoneStates.get(zoneId);
    const region = activeRegions.get(accountId) ?? knownAccounts.get(accountId)?.region ?? DEFAULT_REGION;
    void st; // (zone state may be missing during startup; carry on with REST anyway)
    let token: string;
    try { token = getToken(); } catch { return; }
    // Give MT5 a moment to settle the position state after the exit deal.
    // MetaAPI REST has eventual consistency — a partial close (e.g. TP1
    // closing 25%) fires DEAL_ENTRY_OUT immediately but the position still
    // exists at reduced volume. A single 750ms wait can race the REST cache:
    // if the cache hasn't refreshed yet the position appears "gone" and we'd
    // incorrectly mark it CLOSED and cancel limits. Retry once after another
    // 1.5s (2.25s total) to cover the typical MetaAPI cache refresh window.
    invalidateBrokerSnapshot(accountId);
    await sleep(750);
    const live = await fetchOpenPositions(token, region, accountId, { fresh: true });
    let stillOpen = live.some(p => p.id === positionId);
    if (!stillOpen) {
      await sleep(1500);
      invalidateBrokerSnapshot(accountId);
      const liveRetry = await fetchOpenPositions(token, region, accountId, { fresh: true });
      stillOpen = liveRetry.some(p => p.id === positionId);
      if (stillOpen) {
        console.log(`[markClosed] posId=${positionId} appeared on retry — partial close, leaving OPEN`);
      }
    }
    if (stillOpen) return; // partial close — leave row as OPEN

    await withDbRetry(`markClosed.update posId=${positionId}`, () => db.update(zonePositionsTable)
      .set({ status: "CLOSED" })
      .where(and(
        eq(zonePositionsTable.zoneId, zoneId),
        eq(zonePositionsTable.positionId, positionId),
        eq(zonePositionsTable.status, "OPEN"),
      ))
    );

    const openInZone = await withDbRetry(`markClosed.openCheck zone=${zoneId}`, () => db.select().from(zonePositionsTable)
      .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.status, "OPEN")))
    );
    if (openInZone.length === 0) {
      const brokerStillOpen = await zoneHasLiveTrackedPositionsOnBroker(token, region, accountId, zoneId);
      if (brokerStillOpen) {
        console.log(`[markClosed] zone ${zoneId} DB empty but broker still has open legs — zone stays active`);
        broadcastZoneUpdate(zoneId);
        broadcastToAccount(accountId, "deal", { type: "position_changed" });
        return;
      }
      if (!options.intentionalFullClose) {
        await reconcileZoneFromBroker(accountId, zoneId, token, region, "position_closed_external");
        broadcastToAccount(accountId, "deal", { type: "position_changed" });
        return;
      }
      const zoneMetaRows = await withDbRetry(`markClosed.zoneMeta zone=${zoneId}`, () => db
        .select({ status: cascadeZonesTable.status })
        .from(cascadeZonesTable)
        .where(eq(cascadeZonesTable.zoneId, zoneId))
        .limit(1)
      ).catch(() => []);
      const zoneStatus = st?.status ?? zoneMetaRows[0]?.status ?? "CLOSED";
      const closedAt = Date.now();
      await withDbRetry(`markClosed.zoneClose zone=${zoneId}`, () => db.update(cascadeZonesTable)
        .set({ status: "CLOSED", closedAt })
        .where(eq(cascadeZonesTable.zoneId, zoneId))
      );
      if (st) {
        st.status = "CLOSED";
        zoneStates.delete(zoneId);
      }
      const exitPx = exitPriceFromDeal(exitDeal);
      const dir = (st?.direction ?? "buy") as "buy" | "sell";
      await finalizeZoneClose(accountId, zoneId, {
        stopLossExit: dealIndicatesStopLoss(exitDeal),
        wasRiskFree: zoneStatus === "RISK_FREE",
        exitPrice: exitPx ?? exitPriceForZoneClose(accountId, dir),
        exitPriceFromDeal: exitPx != null && exitPx > 0,
      });
      void settleZoneClosedPnl(accountId, zoneId);
      logEvent("zone.close", { accountId, zoneId, trigger: "position.closed" });
      try {
        const tkn = getToken();
        const rgn = activeRegions.get(accountId) ?? knownAccounts.get(accountId)?.region ?? DEFAULT_REGION;
        cancelZoneLimits(tkn, rgn, accountId, zoneId)
          .catch((e: Error) => console.warn(`[zone ${zoneId}] cancelZoneLimits error:`, e.message))
          .finally(() => {
            broadcastToAccount(accountId, "deal", { type: "position_changed" });
            broadcastZoneUpdate(zoneId);
          });
      } catch {
        broadcastToAccount(accountId, "deal", { type: "position_changed" });
        broadcastZoneUpdate(zoneId);
      }
    }
  } catch (e) {
    console.error(`[zone] markZonePositionClosed error posId=${positionId}:`, (e as Error).message);
  }
}

// REST trade-action helpers — keep them simple/REST so they're independent
// of streaming-connection health. Auth-token + region come from the caller.
async function tradeAction(
  token: string, region: string, accountId: string, body: Record<string, unknown>,
): Promise<{ ok: boolean; code: number; message?: string }> {
  recordApiCall(accountId);
  const r = await fetch(`${clientBase(region)}/users/current/accounts/${accountId}/trade`, {
    method: "POST", headers: authHeaders(token), body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({})) as { numericCode?: number; message?: string };
  const code = data.numericCode ?? 0;
  return { ok: r.ok && TRADE_SUCCESS_CODES.has(code), code, message: data.message };
}

async function closeZonePosition(
  token: string, region: string, accountId: string, positionId: string, volume?: number,
): Promise<boolean> {
  invalidateBrokerSnapshot(accountId);
  const body: Record<string, unknown> = volume !== undefined && volume > 0
    ? { actionType: "POSITION_PARTIAL", positionId, volume }
    : { actionType: "POSITION_CLOSE_ID", positionId };
  return closeWithRetry(async () => {
    const r = await tradeAction(token, region, accountId, body);
    if (!r.ok) console.warn(`[zone] close posId=${positionId} vol=${volume ?? "full"} failed code=${r.code} msg="${r.message ?? ""}"`);
    return r.ok;
  });
}

async function resubscribeToTickStream(accountId: string): Promise<void> {
  const region = activeRegions.get(accountId) ?? knownAccounts.get(accountId)?.region ?? DEFAULT_REGION;
  activeStreams.delete(accountId);
  activeConnections.delete(accountId);
  const token = getToken();
  const userId = knownAccounts.get(accountId)?.userId;
  await startStreaming(token, accountId, region, userId);
}

/** Re-start tick stream + zone monitor for every account with non-closed zones. */
export async function ensureMonitorsForActiveZones(): Promise<void> {
  try {
    await ensureCascadeZoneRunnerColumns();
    const activeZones = await db.select({ accountId: cascadeZonesTable.accountId })
      .from(cascadeZonesTable)
      .where(ne(cascadeZonesTable.status, "CLOSED"));
    const accountIds = [...new Set(activeZones.map((z) => z.accountId))];
    if (accountIds.length === 0) return;
    const token = getToken();
    for (const accountId of accountIds) {
      const region = activeRegions.get(accountId) ?? knownAccounts.get(accountId)?.region ?? DEFAULT_REGION;
      if (!activeStreams.has(accountId)) {
        void startStreaming(token, accountId, region, knownAccounts.get(accountId)?.userId);
      }
    }
  } catch (e) {
    console.warn("[zone-monitor] ensureMonitorsForActiveZones failed:", (e as Error).message);
  }
}

async function handleClosePartial(
  accountId: string,
  zoneId: string,
  body: { pct?: number; lots?: number; tpLevel?: number; runnerN?: number },
  token: string,
  region: string,
): Promise<{ ok: boolean; message?: string }> {
  let st = await loadZone(zoneId);
  if (!st || st.accountId !== accountId) return { ok: false, message: "Zone not found" };
  if (st.status === "CLOSED") {
    const reopened = await reopenClosedZoneIfBrokerLegsRemain(token, region, accountId, zoneId, st);
    if (!reopened) return { ok: false, message: "Zone closed" };
    st = (await loadZone(zoneId)) ?? st;
  }
  if (st.status === "ARMED") return { ok: false, message: "Zone not active" };

  const legs = await resolveLivePositionsForZoneAction(token, region, accountId, zoneId, st, { fresh: true });
  if (legs.length === 0) return { ok: false, message: "No open positions" };

  const tpLevel = body.tpLevel != null && body.tpLevel >= 1 && body.tpLevel <= 3
    ? (body.tpLevel as 1 | 2 | 3) : null;

  if (tpLevel != null) {
    const pendingLegs = legs.filter((leg) => legNeedsTpSlice(leg, st, tpLevel));
    if (pendingLegs.length === 0) {
      return { ok: false, message: `TP${tpLevel} already taken on all open legs` };
    }
    const zoneHadTpHit = st[`tp${tpLevel}Hit`];
    const closeLots = await closeTpSliceOnEveryLiveLeg(token, region, st, zoneId, pendingLegs, tpLevel);
    if (closeLots < 0.01) return { ok: false, message: "Lot too small" };
    await mergeZoneHitsFromPositions(zoneId, {
      tp1Hit: st.tp1Hit, tp2Hit: st.tp2Hit, tp3Hit: st.tp3Hit, tp4Hit: st.tp4Hit,
      tp1Enabled: st.tp1Enabled, tp2Enabled: st.tp2Enabled,
      tp3Enabled: st.tp3Enabled, tp4Enabled: st.tp4Enabled,
    });
    broadcastZoneUpdate(zoneId);
    if (tpLevel === 2 && st.tp2Hit) {
      await applyZoneTp2Housekeeping(token, region, zoneId, st, {
        isFirstZoneTp2: !zoneHadTpHit,
        beLegs: zoneHadTpHit ? pendingLegs : undefined,
      });
    }
    if (tpLevel === 3) {
      notifyZoneEvent(zoneId, "tp3_runners", 3, 0, st.direction);
    }
    console.log(`[take-tp] zone ${zoneId} manual TP${tpLevel} closed ${closeLots.toFixed(2)} lots across ${pendingLegs.length} leg(s)`);
    return { ok: true };
  }

  const totalVol = legs.reduce((s, p) => s + p.volume, 0);
  const LOT_STEP = 0.01;

  let targetLot: number;
  if (body.lots != null) {
    targetLot = Math.min(body.lots, totalVol);
  } else if (body.pct != null && body.pct >= 100) {
    targetLot = totalVol;
  } else {
    const baseVol = st.originalVolume > 0 ? st.originalVolume : totalVol;
    targetLot = Math.round((baseVol * (body.pct ?? 25) / 100) / LOT_STEP) * LOT_STEP;
    if (targetLot < LOT_STEP) return { ok: false, message: "Lot too small" };
    if (targetLot > totalVol) targetLot = totalVol;
  }

  const sorted = [...legs].sort((a, b) => b.volume - a.volume);
  let remaining = targetLot;
  for (const leg of sorted) {
    if (remaining <= 0) break;
    if (leg.volume <= remaining + 1e-9) {
      await closeZonePosition(token, region, accountId, leg.id);
      remaining = Math.round((remaining - leg.volume) / LOT_STEP) * LOT_STEP;
    } else if (remaining >= LOT_STEP) {
      await closeZonePosition(token, region, accountId, leg.id, remaining);
      remaining = 0;
    }
  }

  if ((body.pct ?? 0) >= 100 || (body.lots != null && targetLot >= totalVol - 1e-9)) {
    await cancelZoneLimits(token, region, accountId, zoneId);
  }

  const stAfter = zoneStates.get(zoneId) ?? st;
  if (body.runnerN != null && body.runnerN >= 1 && body.runnerN <= 3 && stAfter?.runnerActive) {
    const hitKey = `runner${body.runnerN}Hit` as "runner1Hit" | "runner2Hit" | "runner3Hit";
    if (stAfter && !stAfter[hitKey]) {
      stAfter[hitKey] = true;
      await db.update(cascadeZonesTable)
        .set({ [hitKey]: true })
        .where(eq(cascadeZonesTable.zoneId, zoneId))
        .catch(() => {});
      broadcastZoneUpdate(zoneId);
    }
  }

  return { ok: true };
}

async function modifyZonePositionSl(
  token: string, region: string, accountId: string, positionId: string, sl: number,
): Promise<boolean> {
  const r = await tradeAction(token, region, accountId, {
    actionType: "POSITION_MODIFY", positionId, stopLoss: sl,
  });
  if (!r.ok) console.warn(`[zone] modify-sl posId=${positionId} sl=${sl} failed code=${r.code} msg="${r.message ?? ""}"`);
  return r.ok;
}

async function cancelZoneLimits(
  token: string, region: string, accountId: string, zoneId: string,
): Promise<void> {
  const orderIds: string[] = orderIdsForZone(accountId, zoneId);
  // DB fallback: the in-memory map can be empty if entries were never populated
  // (race on zone creation), lost during a server restart gap, or already
  // cleaned up. Always cross-check the DB so we don't skip live MT5 orders.
  if (orderIds.length === 0) {
    try {
      const dbOrders = await db.select().from(zoneOrdersTable).where(eq(zoneOrdersTable.zoneId, zoneId));
      for (const o of dbOrders) {
        orderIds.push(o.orderId);
        setZoneLimitOrder(accountId, o.orderId, zoneId);
      }
    } catch (e) {
      console.warn(`[zone ${zoneId}] DB fallback order lookup failed:`, (e as Error).message);
    }
  }
  // Fetch live pending orders — used both for the tracked-ID path (to skip
  // already-gone orders) and the blind-cancel fallback below.
  let liveOrders: Array<{ id: string; comment?: string }> = [];
  try {
    const r = await fetch(`${clientBase(region)}/users/current/accounts/${accountId}/orders`, {
      headers: authHeaders(token),
    });
    if (r.ok) {
      const raw = await r.json() as Array<{ id?: string; _id?: string; comment?: string }>;
      liveOrders = raw.map(o => ({ id: String(o.id ?? o._id ?? ""), comment: o.comment })).filter(o => o.id);
    }
  } catch (e) {
    console.warn(`[zone ${zoneId}] orders fetch error during cancel:`, (e as Error).message);
  }

  if (orderIds.length === 0) {
    // Neither in-memory map nor DB had tracked order IDs — this can happen after
    // a server restart or when the cascade-limit-attach race was lost. As a safety
    // net, cancel every live pending order that carries a "Cascade" comment: those
    // are definitionally stale once this zone is fully closed.
    // IMPORTANT: skip orders already claimed by a different active zone — multiple
    // zones can run in parallel on the same account, so blind-cancelling their
    // limits would wipe out a sibling zone's pending entries.
    const cascadeLive = liveOrders.filter(o => {
      const c = String(o.comment ?? "");
      if (!c.startsWith("Cascade")) return false;
      if (orderMappedToActiveZone(accountId, o.id)) return false;
      // Only blind-cancel orders explicitly tagged with THIS zoneId in the comment.
      return commentBelongsToZone(c, zoneId);
    });
    if (cascadeLive.length === 0) return;
    console.log(
      `[zone ${zoneId}] cancelZoneLimits accountId=${accountId} blind-cancel ${cascadeLive.length} untracked cascade limit(s)`,
    );
    await Promise.all(cascadeLive.map(async (o) => {
      const r = await tradeAction(token, region, accountId, { actionType: "ORDER_CANCEL", orderId: o.id });
      // Mark completed regardless of result — 4754 means already gone, which is
      // still a signal the order is no longer live. Ensures MetaAPI REST filter fires.
      markOrderCompleted(accountId, o.id);
      if (r.ok || r.code === 10036) {
        console.log(`[zone ${zoneId}] blind-cancelled cascade orderId=${o.id}`);
      } else {
        console.warn(`[zone ${zoneId}] blind-cancel orderId=${o.id} failed code=${r.code}`);
      }
    }));
    return;
  }

  console.log(
    `[zone ${zoneId}] cancelZoneLimits accountId=${accountId} cancelling ${orderIds.length} tracked limit order(s)`,
  );
  const pending: Set<string> = new Set(liveOrders.map(o => o.id));
  await Promise.all(orderIds.map(async (oid) => {
    const forget = async () => {
      deleteZoneLimitOrder(accountId, oid);
      try { await db.delete(zoneOrdersTable).where(eq(zoneOrdersTable.orderId, oid)); } catch { /* ignore */ }
    };
    if (pending.size > 0 && !pending.has(oid)) {
      // Not in the live list — already gone from broker. Mark completed so the
      // /orders endpoint filters it out of MetaAPI REST's stale response.
      markOrderCompleted(accountId, oid);
      await forget(); return;
    }
    const r = await tradeAction(token, region, accountId, { actionType: "ORDER_CANCEL", orderId: oid });
    // Mark completed regardless of outcome: success = cancelled now, 4754 = already
    // gone, 10036 = already closed — in all cases the order is no longer pending.
    markOrderCompleted(accountId, oid);
    if (r.ok || r.code === 10036 /* already closed */) {
      await forget();
      console.log(`[zone ${zoneId}] cancelled limit orderId=${oid}`);
    } else {
      console.warn(`[zone ${zoneId}] cancel limit orderId=${oid} failed code=${r.code}`);
    }
  }));
}

interface LivePosition {
  id: string; openPrice: number; volume: number; type: string; symbol: string;
  magic?: number; comment?: string;
  /** MetaAPI floating P&L (profit field on open positions). */
  profit?: number;
}

const ZONE_ACTION_RETRY_MSG = "Action failed — please retry in a moment";
const MARKET_BUSY_MSG = "Market busy — please try again in a moment";
const CLOSE_COOLDOWN_MS = 1500;
const zoneCloseCooldown = new Map<string, number>();

function isRateLimitError(err: unknown): boolean {
  const e = err as { status?: number; message?: string; code?: number };
  const msg = String(e?.message ?? "").toLowerCase();
  return e?.status === 429 || e?.code === 10024
    || msg.includes("too many") || msg.includes("rate limit");
}

async function metaApiCallWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (isRateLimitError(err) && i < maxRetries - 1) {
        const wait = Math.pow(2, i) * 1000;
        console.warn(`[metaapi] rate limited, waiting ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

function userFacingTradeMessage(code: number, raw?: string): string {
  if (code === 10024 || (raw ?? "").toLowerCase().includes("too many")) {
    return MARKET_BUSY_MSG;
  }
  return TRADE_ERROR_MESSAGES[code] ?? raw ?? `Trade failed (code ${code})`;
}

async function closeWithRetry(fn: () => Promise<boolean>, retries = 2): Promise<boolean> {
  for (let i = 0; i <= retries; i++) {
    try {
      const ok = await fn();
      if (ok) return true;
      if (i < retries) await sleep(1000 * (i + 1));
    } catch (err) {
      if (isRateLimitError(err) && i < retries) {
        await sleep(1000 * (i + 1));
        continue;
      }
      throw err;
    }
  }
  return false;
}

function isCloseAllowed(zoneId: string): boolean {
  const last = zoneCloseCooldown.get(zoneId) ?? 0;
  return Date.now() - last >= CLOSE_COOLDOWN_MS;
}

function markCloseAttempt(zoneId: string): void {
  zoneCloseCooldown.set(zoneId, Date.now());
}

function respondZoneActionError(res: Response, label: string, err: unknown): void {
  console.error(`[${label}]`, err);
  const msg = isRateLimitError(err) ? MARKET_BUSY_MSG : ZONE_ACTION_RETRY_MSG;
  res.status(isRateLimitError(err) ? 429 : 500).json({ ok: false, error: msg, message: msg });
}

async function fetchOpenPositions(
  token: string, region: string, accountId: string, opts?: { fresh?: boolean },
): Promise<LivePosition[]> {
  const snap = await getBrokerSnapshot(token, region, accountId, opts);
  return snap.positions;
}

async function fetchOpenPositionsUncached(token: string, region: string, accountId: string): Promise<LivePosition[]> {
  return metaApiCallWithBackoff(async () => {
    recordApiCall(accountId);
    const r = await fetch(
      `${clientBase(region)}/users/current/accounts/${accountId}/positions`,
      { headers: authHeaders(token), signal: AbortSignal.timeout(8000) },
    );
    if (r.status === 429) {
      throw Object.assign(new Error("too many requests"), { status: 429 });
    }
    if (r.ok) {
      const arr = await r.json() as Array<Record<string, unknown>>;
      return arr.map((p) => ({
        id: String(p.id ?? p._id ?? ""),
        openPrice: Number(p.openPrice ?? 0),
        volume: Number(p.volume ?? 0),
        type: String(p.type ?? ""),
        symbol: String(p.symbol ?? ""),
        magic: p.magic != null ? Number(p.magic) : undefined,
        comment: p.comment != null ? String(p.comment) : undefined,
        profit: p.profit != null ? Number(p.profit) : undefined,
      })).filter((p) => p.id);
    }
    throw new Error(`fetchOpenPositions ${r.status} for ${accountId}`);
  });
}

async function fetchLivePendingOrders(
  token: string, region: string, accountId: string, opts?: { fresh?: boolean },
): Promise<Array<{ id: string; comment?: string; magic?: number }>> {
  const snap = await getBrokerSnapshot(token, region, accountId, opts);
  return snap.orders;
}

async function fetchLivePendingOrdersUncached(
  token: string, region: string, accountId: string,
): Promise<Array<{ id: string; comment?: string; magic?: number }>> {
  try {
    return await metaApiCallWithBackoff(async () => {
      recordApiCall(accountId);
      const r = await fetch(`${clientBase(region)}/users/current/accounts/${accountId}/orders`, {
        headers: authHeaders(token),
      });
      if (r.status === 429) {
        throw Object.assign(new Error("too many requests"), { status: 429 });
      }
      if (!r.ok) return [];
      const raw = await r.json() as Array<{ id?: string; _id?: string; comment?: string; magic?: number }>;
      return raw.map(o => ({
        id: String(o.id ?? o._id ?? ""),
        comment: o.comment,
        magic: o.magic != null ? Number(o.magic) : undefined,
      })).filter(o => o.id);
    });
  } catch {
    return [];
  }
}

/** Any open position or pending cascade order on the broker tagged for this zone. */
export async function brokerHasOpenLegsForZone(
  token: string, region: string, accountId: string, zoneId: string,
  opts?: { fresh?: boolean },
): Promise<boolean> {
  return zoneHasLiveTrackedPositionsOnBroker(token, region, accountId, zoneId, opts);
}

function zoneHasPendingLimitsInSnapshot(
  accountId: string,
  zoneId: string,
  orders: Array<{ id: string; comment?: string; magic?: number }>,
): boolean {
  const expectedMagic = zoneMagicNumber(zoneId);
  return orders.some((o) => {
    if (getZoneLimitOrder(accountId, o.id) === zoneId) return true;
    if (o.magic != null && o.magic === expectedMagic) return true;
    return commentBelongsToZone(o.comment, zoneId);
  });
}

async function zoneHasLivePendingCascadeLimits(
  token: string, region: string, accountId: string, zoneId: string,
  orders?: Array<{ id: string; comment?: string; magic?: number }>,
): Promise<boolean> {
  const liveOrders = orders ?? await fetchLivePendingOrders(token, region, accountId);
  return zoneHasPendingLimitsInSnapshot(accountId, zoneId, liveOrders);
}

function zoneHasLegsInSnapshot(
  accountId: string,
  zoneId: string,
  live: LivePosition[],
  orders: Array<{ id: string; comment?: string; magic?: number }>,
): boolean {
  if (live.some((p) => positionBelongsToZone(p, zoneId))) return true;
  const expectedMagic = zoneMagicNumber(zoneId);
  return orders.some((o) => {
    if (getZoneLimitOrder(accountId, o.id) === zoneId) return true;
    if (o.magic != null && o.magic === expectedMagic) return true;
    return commentBelongsToZone(o.comment, zoneId);
  });
}

async function zoneHasLiveTrackedPositionsOnBroker(
  token: string, region: string, accountId: string, zoneId: string,
  opts?: { fresh?: boolean },
): Promise<boolean> {
  const snap = await getBrokerSnapshot(token, region, accountId, opts);
  return zoneHasLegsInSnapshot(accountId, zoneId, snap.positions, snap.orders);
}

/** Close zone when MT5 has no open legs or pending limits for it (manual MT5 close, etc.). */
async function reconcileZoneFromBroker(
  accountId: string,
  zoneId: string,
  token: string,
  region: string,
  trigger = "broker_reconcile",
): Promise<void> {
  const st = zoneStates.get(zoneId) ?? await loadZone(zoneId);
  if (!st || st.accountId !== accountId || st.status === "CLOSED") return;
  if (!syncReady.has(accountId)) return;

  const stillOnBroker = await zoneHasLiveTrackedPositionsOnBroker(token, region, accountId, zoneId);
  if (stillOnBroker) return;

  console.log(`[reconcile] ${zoneId} — no positions or orders in MT5, marking CLOSED`);
  const closedAt = Date.now();
  await withDbRetry(`reconcile.close zone=${zoneId}`,
    () => db.update(cascadeZonesTable)
      .set({ status: "CLOSED", closedAt })
      .where(eq(cascadeZonesTable.zoneId, zoneId)),
  ).catch(() => {/* logged inside withDbRetry */});
  const wasRiskFree = st.status === "RISK_FREE";
  st.status = "CLOSED";
  zoneStates.delete(zoneId);
  await finalizeZoneClose(accountId, zoneId, await buildCloseFinalizeOptsForZone(
    accountId, zoneId, { wasRiskFree, direction: st.direction },
  ));
  void settleZoneClosedPnl(accountId, zoneId);
  logEvent("zone.close", { accountId, zoneId, trigger });
  try {
    cancelZoneLimits(token, region, accountId, zoneId)
      .catch((e: Error) => console.warn(`[zone ${zoneId}] reconcile cancelZoneLimits:`, e.message))
      .finally(() => broadcastZoneUpdate(zoneId));
  } catch {
    broadcastZoneUpdate(zoneId);
  }
}

// Live bid/ask straight from MetaAPI — independent of tickStore (which only
// fills while the app is open and polling /price). Falls back to tickStore
// if the REST call fails, then null if neither has data.
async function fetchSymbolPrice(
  token: string, region: string, accountId: string, symbol: string,
  opts?: { useTickFallback?: boolean },
): Promise<{ bid: number; ask: number } | null> {
  try {
    const rest = await metaApiCallWithBackoff(async () => {
      recordApiCall(accountId);
      const r = await fetch(
        `${clientBase(region)}/users/current/accounts/${accountId}/symbols/${encodeURIComponent(symbol)}/current-price`,
        { headers: authHeaders(token) },
      );
      if (r.status === 429) {
        throw Object.assign(new Error("too many requests"), { status: 429 });
      }
      if (r.ok) {
        const j = await r.json() as { bid?: number; ask?: number };
        if (typeof j.bid === "number" && typeof j.ask === "number") return { bid: j.bid, ask: j.ask };
      }
      return null;
    });
    if (rest) return rest;
  } catch {
    /* fall through to tick cache */
  }
  if (opts?.useTickFallback === false) return null;
  const ticks = tickStore.get(accountId);
  if (ticks && ticks.length > 0) {
    const t = ticks[ticks.length - 1]!;
    if (Date.now() - t.time <= 30_000) return { bid: t.bid, ask: t.ask };
  }
  return null;
}

function latestPrice(accountId: string): { bid: number; ask: number } | null {
  const ticks = tickStore.get(accountId);
  if (!ticks || ticks.length === 0) return null;
  const t = ticks[ticks.length - 1]!;
  return { bid: t.bid, ask: t.ask };
}

/** Prefer recent streaming ticks for TP/BE — avoids a MetaAPI REST price call per eval. */
function priceForZoneEval(
  accountId: string,
  token: string,
  region: string,
  symbol: string,
): Promise<{ bid: number; ask: number } | null> {
  const ticks = tickStore.get(accountId);
  if (ticks && ticks.length > 0) {
    const t = ticks[ticks.length - 1]!;
    if (Date.now() - t.time <= 15_000) return Promise.resolve({ bid: t.bid, ask: t.ask });
  }
  return fetchSymbolPrice(token, region, accountId, symbol);
}

function isQuotesLive(accountId: string): boolean {
  return syncReady.has(accountId);
}

function checkPriceAvailableForZoneAction(accountId: string): { ok: true } | { ok: false; message: string } {
  const cachedTick = tickStore.get(accountId)?.at(-1);
  const tickIsFresh = cachedTick != null && (Date.now() - cachedTick.time) < 30_000;
  const priceAvailable = isQuotesLive(accountId) || tickIsFresh;
  if (!priceAvailable) {
    return { ok: false, message: "Price not ready — wait a moment and try again" };
  }
  return { ok: true };
}

function rejectIfPriceNotReady(res: Response, accountId: string): boolean {
  const check = checkPriceAvailableForZoneAction(accountId);
  if (!check.ok) {
    res.status(400).json({ ok: false, error: check.message, message: check.message });
    return true;
  }
  return false;
}

// Sort positions for a zone: worst → best.
// BUY worst = highest entry; SELL worst = lowest entry.
function sortZonePositions(positions: LivePosition[], direction: "buy" | "sell"): LivePosition[] {
  return positions.slice().sort((a, b) => direction === "buy" ? b.openPrice - a.openPrice : a.openPrice - b.openPrice);
}

function comparePositionIdsEarliest(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Highest floating P&L wins; ties → earliest ticket id. */
export function pickBestZonePositionByFloatingPnl(positions: LivePosition[]): LivePosition {
  return positions.slice().sort((a, b) => {
    const diff = (b.profit ?? 0) - (a.profit ?? 0);
    if (diff !== 0) return diff;
    return comparePositionIdsEarliest(a.id, b.id);
  })[0]!;
}

/** Secure Profits: best by floating P&L when available, else entry ladder. */
export function pickBestZonePositionForCloseWorst(
  positions: LivePosition[],
  direction: "buy" | "sell",
): LivePosition {
  if (positions.some((p) => p.profit != null && !Number.isNaN(p.profit))) {
    return pickBestZonePositionByFloatingPnl(positions);
  }
  const sorted = sortZonePositions(positions, direction);
  return sorted[sorted.length - 1]!;
}

/**
 * One leg per tap: the open position on the next rung away from best on the entry ladder.
 * BUY → close the lowest entry above best; SELL → close the highest entry below best.
 * The closed leg may be in profit or loss — only entry distance from best matters.
 */
export function pickNextLegToTrimForSecureProfits(
  positions: LivePosition[],
  best: LivePosition,
  direction: "buy" | "sell",
): LivePosition | null {
  const others = positions.filter((p) => p.id !== best.id);
  if (others.length === 0) return null;
  if (direction === "buy") {
    const aboveBest = others.filter((p) => p.openPrice > best.openPrice);
    const pool = aboveBest.length > 0 ? aboveBest : others;
    return pool.slice().sort((a, b) => a.openPrice - b.openPrice)[0]!;
  }
  const belowBest = others.filter((p) => p.openPrice < best.openPrice);
  const pool = belowBest.length > 0 ? belowBest : others;
  return pool.slice().sort((a, b) => b.openPrice - a.openPrice)[0]!;
}

type EvaluateZoneOpts = { brokerSnap?: BrokerSnap };

async function evaluateZone(zoneId: string, token: string, opts?: EvaluateZoneOpts): Promise<void> {
  if (!zoneStates.has(zoneId)) return;
  const st = zoneStates.get(zoneId);
  if (!st) return;
  // Evaluate OPEN and RISK_FREE zones — Risk Free closes the losing entries
  // and arms a protective SL, but the TP ladder must keep running on the
  // surviving best entry. ARMED = pending limits only (no TP engine yet).
  if (st.status === "CLOSED") {
    zoneStates.delete(zoneId);
    return;
  }
  if (st.status === "ARMED") return;
  if (st.busy) return;
  st.busy = true;
  try {
    const region = activeRegions.get(st.accountId) ?? knownAccounts.get(st.accountId)?.region ?? DEFAULT_REGION;
    // Fetch this zone's tracked positions from DB (OPEN status only).
    // Resilient tracked-positions lookup: prefer DB (source of truth) but
    // fall back to the in-memory mirror on transient query failures so a DB
    // blip can't silently blind the TP engine for the whole zone (the bug
    // that left TP1 unfired on z_mppceam5_ulh4du). We carry volume + entry
    // price so the TP partial-close logic still has the data it needs.
    let zps: { positionId: string; volume: number; entryPrice: number }[] = [];
    let trackedIds: Set<string>;
    let dbOk = true;
    try {
      const rows = await withDbRetry(`evalZone.trackedPositions zone=${zoneId}`, () => db.select().from(zonePositionsTable)
        .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.status, "OPEN")))
      );
      zps = rows.map(r => ({
        positionId: r.positionId, volume: Number(r.volume), entryPrice: Number(r.entryPrice),
      }));
      trackedIds = new Set(zps.map(z => z.positionId));
      // Merge DB snapshot into existing cache (do NOT replace the Map wholesale)
      // — replacing would clobber a concurrent recordZonePositionFill().add()
      // landing between our SELECT and this assignment.
      for (const r of rows) {
        st.trackedPositions.set(r.positionId, {
          volume: Number(r.volume), entryPrice: Number(r.entryPrice),
          tp1Hit: Boolean(r.tp1Hit),
          tp2Hit: Boolean(r.tp2Hit),
          tp3Hit: Boolean(r.tp3Hit),
          tp4Hit: Boolean(r.tp4Hit),
        });
      }
      // Drop entries the authoritative DB view says are no longer OPEN.
      for (const id of Array.from(st.trackedPositions.keys())) {
        if (!trackedIds.has(id)) st.trackedPositions.delete(id);
      }
    } catch (e) {
      dbOk = false;
      zps = Array.from(st.trackedPositions.entries()).map(([positionId, v]) => ({
        positionId, volume: v.volume, entryPrice: v.entryPrice,
      }));
      trackedIds = new Set(zps.map(z => z.positionId));
      console.warn(`[zone ${zoneId}] tracked-positions DB query failed, using in-memory cache (${trackedIds.size} ids): ${(e as Error).message}`);
    }
    const snap = opts?.brokerSnap;
    if (zps.length === 0) {
      const pendingLeft = snap
        ? zoneHasPendingLimitsInSnapshot(st.accountId, zoneId, snap.orders)
        : await zoneHasLivePendingCascadeLimits(token, region, st.accountId, zoneId);
      const brokerLegs = snap
        ? zoneHasLegsInSnapshot(st.accountId, zoneId, snap.positions, snap.orders)
        : await brokerHasOpenLegsForZone(token, region, st.accountId, zoneId);
      if (brokerLegs) {
        await resolveLivePositionsForZoneAction(token, region, st.accountId, zoneId, st);
        try {
          const rows = await withDbRetry(`evalZone.relinkRefresh zone=${zoneId}`, () => db.select().from(zonePositionsTable)
            .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.status, "OPEN")))
          );
          zps = rows.map((r) => ({
            positionId: r.positionId, volume: Number(r.volume), entryPrice: Number(r.entryPrice),
          }));
          trackedIds = new Set(zps.map((z) => z.positionId));
          dbOk = true;
          for (const z of zps) {
            const existing = st.trackedPositions.get(z.positionId);
            st.trackedPositions.set(z.positionId, {
              volume: z.volume, entryPrice: z.entryPrice,
              tp1Hit: existing?.tp1Hit ?? false,
              tp2Hit: existing?.tp2Hit ?? false,
              tp3Hit: existing?.tp3Hit ?? false,
              tp4Hit: existing?.tp4Hit ?? false,
            });
          }
          console.log(`[zone ${zoneId}] relinked ${zps.length} open leg(s) for TP engine`);
        } catch (e) {
          zps = Array.from(st.trackedPositions.entries()).map(([positionId, v]) => ({
            positionId, volume: v.volume, entryPrice: v.entryPrice,
          }));
          trackedIds = new Set(zps.map((z) => z.positionId));
          console.warn(`[zone ${zoneId}] relink refresh failed, using cache (${trackedIds.size} ids): ${(e as Error).message}`);
        }
      }
      if (zps.length === 0) {
        if (!syncReady.has(st.accountId)) return;
        if (!brokerLegs && !pendingLeft) {
          if (!shouldAutoCloseZoneAfterPositionExit(st, false, false)) {
            console.log(`[zone ${zoneId}] empty tracked rows but defer zone close (pre-TP2 policy)`);
            return;
          }
          const closedAt = Date.now();
          await withDbRetry(`evalZone.emptyClose zone=${zoneId}`,
            () => db.update(cascadeZonesTable)
              .set({ status: "CLOSED", closedAt })
              .where(eq(cascadeZonesTable.zoneId, zoneId)),
          ).catch(() => {/* logged inside withDbRetry */});
          const wasRiskFree = st.status === "RISK_FREE";
          st.status = "CLOSED";
          await finalizeZoneClose(st.accountId, zoneId, await buildCloseFinalizeOptsForZone(
            st.accountId, zoneId, { wasRiskFree, direction: st.direction },
          ));
          void settleZoneClosedPnl(st.accountId, zoneId);
          logEvent("zone.close", { accountId: st.accountId, zoneId, trigger: "empty_reconcile" });
          try {
            const tkn = getToken();
            cancelZoneLimits(tkn, region, st.accountId, zoneId)
              .catch((e: Error) => console.warn(`[zone ${zoneId}] empty reconcile cancelZoneLimits:`, e.message))
              .finally(() => broadcastZoneUpdate(zoneId));
          } catch {
            broadcastZoneUpdate(zoneId);
          }
        }
        return;
      }
    }
    let allLive = snap?.positions ?? await fetchOpenPositions(token, region, st.accountId);
    let live = mergeLiveZoneLegs(allLive, zoneId, trackedIds);
    const hasBrokerLegs = snap
      ? zoneHasLegsInSnapshot(st.accountId, zoneId, snap.positions, snap.orders)
      : await brokerHasOpenLegsForZone(token, region, st.accountId, zoneId);
    const needsLegResolve =
      (live.length === 0 && hasBrokerLegs)
      || zoneLegsNeedFreshResolve(live, zoneId, trackedIds, allLive, zps.length);
    if (needsLegResolve) {
      await resolveLivePositionsForZoneAction(token, region, st.accountId, zoneId, st);
      try {
        const rows = await withDbRetry(`evalZone.legResolveRefresh zone=${zoneId}`, () => db.select().from(zonePositionsTable)
          .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.status, "OPEN")))
        );
        zps = rows.map((r) => ({
          positionId: r.positionId, volume: Number(r.volume), entryPrice: Number(r.entryPrice),
        }));
        trackedIds = new Set(zps.map((z) => z.positionId));
        for (const z of zps) {
          const existing = st.trackedPositions.get(z.positionId);
          st.trackedPositions.set(z.positionId, {
            volume: z.volume, entryPrice: z.entryPrice,
            tp1Hit: existing?.tp1Hit ?? false,
            tp2Hit: existing?.tp2Hit ?? false,
            tp3Hit: existing?.tp3Hit ?? false,
            tp4Hit: existing?.tp4Hit ?? false,
          });
        }
      } catch (e) {
        console.warn(`[zone ${zoneId}] leg-resolve tracked refresh failed, using cache (${trackedIds.size} ids): ${(e as Error).message}`);
      }
      allLive = await fetchOpenPositions(token, region, st.accountId, { fresh: true });
      live = mergeLiveZoneLegs(allLive, zoneId, trackedIds);
    }
    // Skip the destructive reconciliation path (which permanently marks
    // positions CLOSED in the DB) when we're operating off the cache —
    // we can't trust "missing from live" without a confirmed DB view.
    if (live.length === 0 && !dbOk) return;
    // Guard: don't reconcile a zone as CLOSED if the stream for this account
    // hasn't completed its first deals-sync since server start. On startup the
    // zone monitor fires within 3 s — long before the MetaAPI stream reconnects
    // and re-populates live positions. Without this check, active zones get
    // wrongly reconciled closed on every deployment/restart.
    if (live.length === 0 && !syncReady.has(st.accountId)) return;
    if (live.length === 0) {
      // Reconciliation: all tracked positions are gone (possibly closed during
      // a server restart — DEAL_ENTRY_OUT events from that window are lost
      // because the streaming connection starts from `new Date()`). Mark each
      // missing row CLOSED, then close the zone.
      const allLiveIds = new Set(allLive.map(p => p.id));
      for (const zp of zps) {
        if (!allLiveIds.has(zp.positionId)) {
          await withDbRetry(`evalZone.reconcileClose zone=${zoneId} posId=${zp.positionId}`,
            () => db.update(zonePositionsTable)
              .set({ status: "CLOSED" })
              .where(and(
                eq(zonePositionsTable.zoneId, zoneId),
                eq(zonePositionsTable.positionId, zp.positionId),
                eq(zonePositionsTable.status, "OPEN"),
              ))
          ).catch(() => {/* logged inside withDbRetry */});
        }
      }
      const stillOpen = await withDbRetry(`evalZone.reconcileOpenCheck zone=${zoneId}`,
        () => db.select().from(zonePositionsTable)
          .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.status, "OPEN")))
      ).catch(() => null);
      if (stillOpen && stillOpen.length === 0) {
        const pendingLeft = snap
          ? zoneHasPendingLimitsInSnapshot(st.accountId, zoneId, snap.orders)
          : await zoneHasLivePendingCascadeLimits(token, region, st.accountId, zoneId);
        const brokerStillOpen = snap
          ? zoneHasLegsInSnapshot(st.accountId, zoneId, snap.positions, snap.orders)
          : await zoneHasLiveTrackedPositionsOnBroker(token, region, st.accountId, zoneId);
        if (brokerStillOpen) {
          console.log(`[zone ${zoneId}] reconcile: broker still has open legs — zone stays active`);
          return;
        }
        const hasNoPending = !pendingLeft;
        if (!hasNoPending) {
          console.log(`[zone ${zoneId}] reconcile: pending limits remain — zone stays active`);
          return;
        }
        const closedAt = Date.now();
        await withDbRetry(`evalZone.reconcileZoneClose zone=${zoneId}`,
          () => db.update(cascadeZonesTable)
            .set({ status: "CLOSED", closedAt })
            .where(eq(cascadeZonesTable.zoneId, zoneId))
        ).catch(() => {/* logged inside withDbRetry */});
        const wasRiskFree = st.status === "RISK_FREE";
        st.status = "CLOSED";
        zoneStates.delete(zoneId);
        await finalizeZoneClose(st.accountId, zoneId, await buildCloseFinalizeOptsForZone(
          st.accountId, zoneId, { wasRiskFree, direction: st.direction },
        ));
        void settleZoneClosedPnl(st.accountId, zoneId);
        logEvent("zone.close", { accountId: st.accountId, zoneId, trigger: "reconciliation" });
        // Cancel any outstanding cascade limit orders so they don't orphan on
        // MT5 and flash as individual pending cards on the client. Broadcast
        // AFTER cancellation so the client only redraws once limits are gone.
        try {
          const tkn = getToken();
          cancelZoneLimits(tkn, region, st.accountId, zoneId)
            .catch((e: Error) => console.warn(`[zone ${zoneId}] reconciliation cancelZoneLimits error:`, e.message))
            .finally(() => broadcastZoneUpdate(zoneId));
        } catch {
          // Token unavailable — still broadcast so client refreshes.
          broadcastZoneUpdate(zoneId);
        }
      }
      return;
    }

    const price = await priceForZoneEval(st.accountId, token, region, live[0]!.symbol || "XAUUSD");
    if (!price) return;
    // For BUY closes use bid; for SELL closes use ask. Allow TP checks when
    // absolute TP prices are set even if anchor was closed before persisting.
    if (!zoneHasTpTargets(st)) return;
    const cmpPrice = st.direction === "buy" ? price.bid : price.ask;

    // Spread/slippage tolerance: fire TP when price comes within
    // ZONE_TP_TOLERANCE_PIPS of the target on the profitable side. Without
    // this, a TP set at the exact bid/ask never triggers because the broker's
    // spread keeps the comparison side just shy of the level (e.g. user sets
    // TP1 at 2400.00, bid peaks at 2399.94 due to 6-pip spread, and the close
    // never fires). 3 pips is a typical XAUUSD spread + a small slippage buffer.
    const tol = ZONE_TP_TOLERANCE_PIPS * PIP;
    const hit = (tp: number) => st.direction === "buy" ? cmpPrice >= (tp - tol) : cmpPrice <= (tp + tol);

    // No auto cashout — the user closes upper entries manually if they want.
    // All four cascade orders share the same SL and TP1-4 (set broker-side at
    // placement); the engine just runs 25% partial closes on EVERY live entry
    // as each TP level is hit.

    // "Near next TP" detection — fire a push once per TP step when the live
    // distance crosses the user's threshold. Runs before the hit branches so a
    // near-then-hit on the same tick still fires both events in order. Uses
    // the absolute TP prices on `st` (the cascade refactor moved away from pip
    // distances), and skips silently if the next TP price isn't set yet.
    {
      const nextTpIdx: 0 | 1 | 2 | 3 | 4 =
        st.tp1Enabled && !st.tp1Hit ? 1 :
        st.tp2Enabled && !st.tp2Hit ? 2 :
        st.tp3Enabled && !st.tp3Hit ? 3 :
        st.tp4Enabled && !st.tp4Hit && st.tp4Price != null ? 4 : 0;
      const nextTpPrice =
        nextTpIdx === 1 ? st.tp1Price :
        nextTpIdx === 2 ? st.tp2Price :
        nextTpIdx === 3 ? st.tp3Price :
        nextTpIdx === 4 ? st.tp4Price : null;
      if (nextTpIdx > 0 && nextTpPrice != null) {
        const userId = resolveZoneNotifyUserId(zoneId, st.accountId);
        const prefs = userId ? notificationPrefs.get(userId) : undefined;
        const threshold = prefs?.thresholdPips ?? 0;
        const sign = st.direction === "buy" ? 1 : -1;
        const remaining = (nextTpPrice - cmpPrice) / PIP * sign;
        const lastNotified = zoneNearNotifiedTp.get(zoneId) ?? 0;
        // Reset the "near" gate whenever the zone advances to a new TP step.
        if (lastNotified > 0 && lastNotified !== nextTpIdx) {
          zoneNearNotifiedTp.set(zoneId, 0);
        }
        if (
          prefs?.nearEnabled &&
          prefs.expoPushToken &&
          remaining > 0 &&
          remaining <= threshold &&
          (zoneNearNotifiedTp.get(zoneId) ?? 0) !== nextTpIdx
        ) {
          zoneNearNotifiedTp.set(zoneId, nextTpIdx);
          notifyZoneEvent(zoneId, "near", nextTpIdx as 1 | 2 | 3 | 4, remaining, st.direction);
        }
      }
    }

    // High water mark — track best price seen so buffered auto-TP can fire on retraces.
    if (st.direction === "buy") {
      if (!st.highestPriceSeen || price.bid > st.highestPriceSeen) {
        st.highestPriceSeen = price.bid;
      }
    } else {
      if (!st.lowestPriceSeen || price.ask < st.lowestPriceSeen) {
        st.lowestPriceSeen = price.ask;
      }
    }
    for (const lvl of [1, 2, 3] as const) {
      if (st[`tp${lvl}Hit`] || st[`tp${lvl}PassedAt`]) continue;
      const tpPrice = st[`tp${lvl}Price`];
      if (tpPrice == null) continue;
      const crossed = st.direction === "buy"
        ? (st.highestPriceSeen ?? 0) >= tpPrice
        : (st.lowestPriceSeen ?? Infinity) <= tpPrice;
      if (crossed) st[`tp${lvl}PassedAt`] = Date.now();
    }

    const AUTO_TP_BUFFER = 0.30;
    const AUTO_TP_BUFFER_WINDOW_MS = 15_000;
    for (const lvl of [1, 2, 3] as const) {
      const tpPrice = st[`tp${lvl}Price`];
      const tpPct = st[`tp${lvl}Pct`];
      const enabled = st[`tp${lvl}Enabled`] !== false;
      const passedAt = st[`tp${lvl}PassedAt`];
      if (tpPrice == null || !enabled || !(tpPct > 0)) continue;

      const atLevel = st.direction === "buy"
        ? price.bid >= tpPrice
        : price.ask <= tpPrice;
      const withinWindow = passedAt != null && (Date.now() - passedAt) < AUTO_TP_BUFFER_WINDOW_MS;
      const withinBuffer = st.direction === "buy"
        ? price.bid >= tpPrice - AUTO_TP_BUFFER
        : price.ask <= tpPrice + AUTO_TP_BUFFER;
      const bufferedClose = withinWindow && withinBuffer;
      if (!atLevel && !bufferedClose) continue;

      try {
        // Fresh broker read so limits that filled since tick start join this TP.
        const tpLegs = await resolveLivePositionsForZoneAction(
          token, region, st.accountId, zoneId, st, { fresh: true },
        );
        const pendingLegs = tpLegs.filter((leg) => legNeedsTpSlice(leg, st, lvl));
        if (pendingLegs.length === 0) continue;

        const zoneHadTpHit = st[`tp${lvl}Hit`];
        const closeLots = await closeTpSliceOnEveryLiveLeg(
          token, region, st, zoneId, pendingLegs, lvl,
        );
        if (closeLots < 0.01) continue;

        st[`tp${lvl}PassedAt`] = undefined;
        await mergeZoneHitsFromPositions(zoneId, {
          tp1Hit: st.tp1Hit, tp2Hit: st.tp2Hit, tp3Hit: st.tp3Hit, tp4Hit: st.tp4Hit,
          tp1Enabled: st.tp1Enabled, tp2Enabled: st.tp2Enabled,
          tp3Enabled: st.tp3Enabled, tp4Enabled: st.tp4Enabled,
        });
        broadcastZoneUpdate(zoneId);

        if (lvl === 2 && st.tp2Hit) {
          await applyZoneTp2Housekeeping(token, region, zoneId, st, {
            isFirstZoneTp2: !zoneHadTpHit,
            beLegs: zoneHadTpHit ? pendingLegs : undefined,
          });
        }

        if (lvl === 3) {
          notifyZoneEvent(zoneId, "tp3_runners", 3, 0, st.direction);
        }
        console.log(`[auto-tp] zone ${zoneId} TP${lvl} (${tpPct}%) closed ${closeLots.toFixed(2)} lots across ${pendingLegs.length} leg(s)`);
      } catch (err) {
        console.error(`[auto-tp] TP${lvl} close failed for ${zoneId}:`, err);
      }
    }

    const notified = st.tpNotified ?? {
      tp1: false, tp2: false, tp3: false,
      runner1: false, runner2: false, runner3: false,
    };

    if (st.runnerActive) {
      for (const n of [1, 2, 3] as const) {
        const rPrice = st[`runner${n}Price`] as number | null | undefined;
        const rLots = st[`runner${n}Lots`] as number | undefined;
        const key = `runner${n}` as keyof typeof notified;
        if (!rPrice || notified[key] || st[`runner${n}Hit`]) continue;
        const reached = st.direction === "buy"
          ? price.bid >= rPrice
          : price.ask <= rPrice;
        if (reached) {
          const autoClose = Boolean(st[`runner${n}Auto`]);
          if (autoClose && rLots != null && rLots >= 0.01) {
            try {
              const result = await handleClosePartial(
                st.accountId, zoneId, { lots: rLots, runnerN: n }, token, region,
              );
              if (result.ok) {
                notified[key] = true;
                st.tpNotified = notified;
                broadcastToAccount(st.accountId, "deal", { type: "position_changed" });
                console.log(`[auto-runner] zone ${zoneId} R${n} auto-closed ${rLots} lots`);
              } else {
                console.warn(`[auto-runner] zone ${zoneId} R${n} close failed: ${result.message ?? "unknown"}`);
              }
            } catch (err) {
              console.error(`[auto-runner] zone ${zoneId} R${n} error:`, (err as Error).message);
            }
            continue;
          }
          notified[key] = true;
          st.tpNotified = notified;
          notifyZoneEvent(st.zoneId, "runner", n, 0, st.direction, rPrice, rLots ?? undefined);
          broadcastToAccount(st.accountId, "runner_alert", {
            zoneId: st.zoneId,
            runnerN: n,
            price: rPrice,
            lots: rLots ?? null,
            anchor: st.anchorPrice,
            direction: st.direction,
          });
        }
      }
    }

    st.tpNotified = notified;

        // Sticky SL→BE block, independent of the TP if/else chain above. Runs
    // every tick once TP2 partials have closed, until either true BE is
    // achieved (tp2SlMoved=true) or we've truly exhausted the attempt budget.
    //
    // Why this is more than a naive retry: the original symptom was the
    // broker rejecting SL=openPrice with code 10016 ("Invalid stops") on a
    // SELL whose entry price was now BELOW current ask — a true BE would
    // close the position instantly, so the broker refuses it. The old code
    // burned all 5 attempts on that condition and gave up, leaving the
    // position at its original wide SL. The fix: pre-compute a broker-safe
    // SL based on current bid/ask. If true BE is valid, use it; otherwise
    // apply the safest possible protective SL and flag the zone as
    // "best effort" so the app can warn the user — and keep trying to
    // upgrade to true BE on later ticks without consuming the retry budget.
    const lateLegNeedsBe = live.some((p) => st.trackedPositions.get(p.id)?.tp2Hit);
    if (isAutoBeTriggerSatisfied(st) && live.length > 0
      && (!st.tp2SlMoved || st.tp2SlIsBestEffort || lateLegNeedsBe)) {
      const beLegs = lateLegNeedsBe && st.tp2SlMoved
        ? live.filter((p) => st.trackedPositions.get(p.id)?.tp2Hit)
        : live;
      if (beLegs.length > 0) {
        await applyZoneTp2Housekeeping(token, region, zoneId, st, {
          isFirstZoneTp2: false,
          cancelLimits: false,
          beLegs,
        });
      }
    }
  } catch (e) {
    console.error(`[zone ${zoneId}] evaluate error:`, (e as Error).message);
  } finally {
    st.busy = false;
  }
}

let zoneMonitorTimer: NodeJS.Timeout | null = null;
let zoneReconcileTimer: NodeJS.Timeout | null = null;
let zoneKeepaliveTimer: NodeJS.Timeout | null = null;
let zoneMonitorTick = 0;
export function startZoneTpMonitor(): void {
  if (zoneMonitorTimer) return;
  void ensureMonitorsForActiveZones();
  if (!zoneReconcileTimer) {
    zoneReconcileTimer = setInterval(() => {
      if (!isMarketOpen()) return;
      const token = (() => { try { return getToken(); } catch { return null; } })();
      if (!token) return;
      const byAccount = new Map<string, { region: string; zoneIds: string[] }>();
      for (const [zoneId, st] of zoneStates.entries()) {
        if (st.status === "CLOSED") continue;
        if (!syncReady.has(st.accountId)) continue;
        const region = activeRegions.get(st.accountId) ?? knownAccounts.get(st.accountId)?.region ?? DEFAULT_REGION;
        const bucket = byAccount.get(st.accountId) ?? { region, zoneIds: [] };
        bucket.zoneIds.push(zoneId);
        byAccount.set(st.accountId, bucket);
      }
      for (const [accountId, { region, zoneIds }] of byAccount) {
        void (async () => {
          try {
            const snap = await getBrokerSnapshot(token, region, accountId);
            for (const zoneId of zoneIds) {
              if (zoneHasLegsInSnapshot(accountId, zoneId, snap.positions, snap.orders)) continue;
              await reconcileZoneFromBroker(accountId, zoneId, token, region, "periodic_reconcile");
            }
          } catch (err) {
            console.error(`[reconcile] account ${accountId}:`, (err as Error).message);
          }
        })();
      }
    }, 60_000);
    zoneReconcileTimer.unref?.();
    console.log("[zone-reconcile] started (60 s interval, batched per account)");
  }
  zoneMonitorTimer = setInterval(() => {
    if (!isMarketOpen()) return;
    const token = (() => { try { return getToken(); } catch { return null; } })();
    if (!token) return;
    zoneMonitorTick += 1;
    // Every ~100 s, hydrate any OPEN/RISK_FREE zones missing from memory (e.g.
    // created while this pod was down or lost from cache after a partial failure).
    if (zoneMonitorTick % 10 === 0) {
      void (async () => {
        try {
          const rows = await db.select({ zoneId: cascadeZonesTable.zoneId })
            .from(cascadeZonesTable)
            .where(inArray(cascadeZonesTable.status, ["OPEN", "RISK_FREE", "ARMED"]));
          for (const row of rows) {
            if (!zoneStates.has(row.zoneId)) await loadZone(row.zoneId);
          }
        } catch (e) {
          console.warn("[zone-monitor] periodic DB hydrate failed:", (e as Error).message);
        }
      })();
    }
    const now = Date.now();
    for (const [zoneId, st] of zoneStates.entries()) {
      if (st.status === "CLOSED" || st.status === "ARMED") continue;
      if (syncReady.has(st.accountId)) {
        const lastStreamEval = lastStreamingEvalAt.get(zoneId) ?? 0;
        if (now - lastStreamEval < MONITOR_EVAL_SKIP_IF_STREAM_MS) continue;
      }
      void evaluateZone(zoneId, token);
    }
  }, 10_000);
  if (!zoneKeepaliveTimer) {
    zoneKeepaliveTimer = setInterval(() => {
      const now = Date.now();
      for (const [accountId, lastTick] of lastTickAtByAccount.entries()) {
        if (now - lastTick > MONITOR_KEEPALIVE_MS) {
          console.warn(`[keepalive] No tick for ${MONITOR_KEEPALIVE_MS}ms on ${accountId} — re-subscribing`);
          void resubscribeToTickStream(accountId).catch((err) =>
            console.error("[keepalive] re-subscribe failed:", err),
          );
          lastTickAtByAccount.set(accountId, now);
        }
      }
    }, 15_000);
    zoneKeepaliveTimer.unref?.();
  }
  console.log("[zone-monitor] started (10 s interval; streaming eval min 1 s)");
}

// Convert a cascadeZonesTable row to a ZoneState (transient fields get safe defaults).
// Single place for this logic — shared by loadZoneState and loadZone.
// Exported for testing the restart-hydration path without requiring a live DB.
export function rowToZoneState(z: typeof cascadeZonesTable.$inferSelect): ZoneState {
  const dir: "buy" | "sell" = z.direction === "sell" ? "sell" : "buy";
  const anchor = Number(z.anchorPrice);
  // Legacy zones (created before the rebuild) only have pip distances. Convert
  // to absolute prices so the monitor's hit() comparisons still fire.
  const fromPips = (pips: number) => dir === "buy" ? anchor + pips * PIP : anchor - pips * PIP;
  return {
    zoneId: z.zoneId, accountId: z.accountId, direction: dir, anchorPrice: anchor,
    tp1Price: z.tp1Price != null ? Number(z.tp1Price) : (z.tp1Pips ? fromPips(Number(z.tp1Pips)) : null),
    tp2Price: z.tp2Price != null ? Number(z.tp2Price) : (z.tp2Pips ? fromPips(Number(z.tp2Pips)) : null),
    tp3Price: z.tp3Price != null ? Number(z.tp3Price) : (z.tp3Pips ? fromPips(Number(z.tp3Pips)) : null),
    tp4Price: z.tp4Price != null ? Number(z.tp4Price) : null,
    tp1Pct: z.tp1Pct != null ? Number(z.tp1Pct) : 25,
    tp2Pct: z.tp2Pct != null ? Number(z.tp2Pct) : 25,
    tp3Pct: z.tp3Pct != null ? Number(z.tp3Pct) : 25,
    tp4Pct: z.tp4Pct != null ? Number(z.tp4Pct) : 25,
    tp1Enabled: (z as { tp1Enabled?: boolean }).tp1Enabled ?? (Number(z.tp1Pct ?? 25) > 0),
    tp2Enabled: (z as { tp2Enabled?: boolean }).tp2Enabled ?? (Number(z.tp2Pct ?? 25) > 0),
    tp3Enabled: (z as { tp3Enabled?: boolean }).tp3Enabled ?? (Number(z.tp3Pct ?? 25) > 0),
    tp4Enabled: (z as { tp4Enabled?: boolean }).tp4Enabled ?? (Number(z.tp4Pct ?? 25) > 0),
    originalVolume: z.originalVolume != null ? Number(z.originalVolume) : 0,
    cashoutPips: Number(z.cashoutPips ?? ZONE_CASHOUT_PIPS_DEFAULT),
    cashoutDone: z.cashoutDone ?? false,
    tp1Hit: z.tp1Hit, tp2Hit: z.tp2Hit, tp3Hit: z.tp3Hit, tp4Hit: z.tp4Hit ?? false,
    // BE move isn't persisted — on restart, if tp2 was already hit, attempt
    // BE again (modify-sl is idempotent). If the broker still rejects, the
    // bounded retry budget below stops the loop quickly. The best-effort
    // flag IS persisted so the app warning chip survives a restart.
    tp2SlMoved: false, tp2BeAttempts: 0,
    tp2SlIsBestEffort: (z as { tp2SlIsBestEffort?: boolean }).tp2SlIsBestEffort ?? false,
    autoBeAtTp: sanitizeAutoBeAtTp((z as { autoBeAtTp?: number }).autoBeAtTp),
    status: z.status === "CLOSED" ? "CLOSED"
      : z.status === "RISK_FREE" ? "RISK_FREE"
        : z.status === "ARMED" ? "ARMED"
          : "OPEN",
    tpCarryLot: 0,
    busy: false,
    trackedPositions: new Map(),
    runner1Price: (z as { runner1Price?: number | null }).runner1Price != null
      ? Number((z as { runner1Price: number }).runner1Price) : null,
    runner1Lots: (z as { runner1Lots?: number | null }).runner1Lots != null
      ? Number((z as { runner1Lots: number }).runner1Lots) : null,
    runner2Price: (z as { runner2Price?: number | null }).runner2Price != null
      ? Number((z as { runner2Price: number }).runner2Price) : null,
    runner2Lots: (z as { runner2Lots?: number | null }).runner2Lots != null
      ? Number((z as { runner2Lots: number }).runner2Lots) : null,
    runner3Price: (z as { runner3Price?: number | null }).runner3Price != null
      ? Number((z as { runner3Price: number }).runner3Price) : null,
    runner3Lots: (z as { runner3Lots?: number | null }).runner3Lots != null
      ? Number((z as { runner3Lots: number }).runner3Lots) : null,
    runner1Hit: Boolean((z as { runner1Hit?: boolean }).runner1Hit),
    runner2Hit: Boolean((z as { runner2Hit?: boolean }).runner2Hit),
    runner3Hit: Boolean((z as { runner3Hit?: boolean }).runner3Hit),
    runner1Auto: Boolean((z as { runner1Auto?: boolean }).runner1Auto),
    runner2Auto: Boolean((z as { runner2Auto?: boolean }).runner2Auto),
    runner3Auto: Boolean((z as { runner3Auto?: boolean }).runner3Auto),
    runnerActive: Boolean((z as { runnerActive?: boolean }).runnerActive),
    riskFreeOffset: sanitizeRiskFreePips((z as { riskFreeOffset?: number }).riskFreeOffset ?? 0),
  };
}

// Cache-first zone reader: check in-memory map first, hydrate from DB on miss,
// set in cache, return. Returns null only when the zone does not exist in DB;
// returns the zone (including CLOSED) if it does exist — callers check status.
// DB errors propagate as thrown exceptions so callers surface 5xx, not silent 404.
// This is the single read path for all code that needs to act on a zone state.
export async function loadZone(zoneId: string): Promise<ZoneState | null> {
  const cached = zoneStates.get(zoneId);
  if (cached) return cached;
  await ensureCascadeZoneRfColumns();
  // Intentionally no try/catch — DB errors bubble up to the route handler
  // which wraps everything in try/catch and returns 500.
  const [z] = await db.select().from(cascadeZonesTable)
    .where(eq(cascadeZonesTable.zoneId, zoneId))
    .limit(1);
  if (!z) return null; // zone truly doesn't exist
  const st = rowToZoneState(z);
  zoneStates.set(zoneId, st);
  console.log(`[zone ${zoneId}] hydrated from DB on cache miss (status=${z.status})`);
  if (z.status !== "CLOSED") {
    try {
      const zpRows = await db.select().from(zonePositionsTable)
        .where(and(eq(zonePositionsTable.zoneId, zoneId), eq(zonePositionsTable.status, "OPEN")));
      for (const zp of zpRows) {
        // Migration safety: positions created before per-position tracking was
        // introduced have tp1Hit=false in DB even if TP1 already fired on them.
        // Use zone-level flags as a floor so we don't re-fire TPs on old positions.
        // New positions inserted by recordZonePositionFill carry tp1Hit=false
        // intentionally and have their flags set by evaluateZone going forward.
        st.trackedPositions.set(zp.positionId, {
          volume: Number(zp.volume), entryPrice: Number(zp.entryPrice),
          tp1Hit: Boolean(zp.tp1Hit),
          tp2Hit: Boolean(zp.tp2Hit),
          tp3Hit: Boolean(zp.tp3Hit),
          tp4Hit: Boolean(zp.tp4Hit),
        });
      }
    } catch { /* non-fatal — evaluateZone will re-read from DB */ }
  }
  return st;
}

// Test hook — exposes internal state for restart-hydration integration tests.
// NOT part of the production API; only used by test files.
export const _zoneStatesForTest = zoneStates;

// Hydrate in-memory zone state from DB on startup so the monitor resumes
// watching zones placed in previous server sessions.
export async function loadZoneState(): Promise<void> {
  try {
    await ensureCascadeZoneRfColumns();
    await ensureCascadeZoneRunnerColumns();
    // Load both OPEN and RISK_FREE zones — the monitor evaluates both
    // (RISK_FREE zones still need TP progression on the surviving entry).
    const zones = await db.select().from(cascadeZonesTable)
      .where(ne(cascadeZonesTable.status, "CLOSED"));
    for (const z of zones) {
      zoneStates.set(z.zoneId, rowToZoneState(z));
      if (z.userId) zoneIdToUserId.set(z.zoneId, z.userId);
      else {
        const known = knownAccounts.get(z.accountId);
        if (known?.userId) zoneIdToUserId.set(z.zoneId, known.userId);
      }
    }
    // Hydrate the in-memory tracked-positions cache from the open
    // zone_positions rows so we have a working fallback the moment the
    // process is up — without this, a DB blip immediately after startup
    // would blind the engine until the next successful query.
    try {
      const zpRows = await db.select().from(zonePositionsTable)
        .where(eq(zonePositionsTable.status, "OPEN"));
      for (const zp of zpRows) {
        const st = zoneStates.get(zp.zoneId);
        if (st) st.trackedPositions.set(zp.positionId, {
          volume: Number(zp.volume), entryPrice: Number(zp.entryPrice),
          tp1Hit: Boolean(zp.tp1Hit),
          tp2Hit: Boolean(zp.tp2Hit),
          tp3Hit: Boolean(zp.tp3Hit),
          tp4Hit: Boolean(zp.tp4Hit),
        });
      }
    } catch (e) {
      console.warn(`[zone] hydrate trackedPositions cache failed:`, (e as Error).message);
    }
    if (zones.length > 0) console.log(`[zone] hydrated ${zones.length} OPEN zone(s) from db`);
    // Rehydrate zone↔limit-order mappings so pre-restart limits still resolve.
    const orders = await db.select({
      orderId: zoneOrdersTable.orderId,
      zoneId: zoneOrdersTable.zoneId,
      accountId: cascadeZonesTable.accountId,
    })
      .from(zoneOrdersTable)
      .innerJoin(cascadeZonesTable, eq(zoneOrdersTable.zoneId, cascadeZonesTable.zoneId));
    for (const o of orders) {
      setZoneLimitOrder(o.accountId, o.orderId, o.zoneId);
    }
    if (orders.length > 0) console.log(`[zone] hydrated ${orders.length} zone limit-order link(s) from db (per-account)`);
    void backfillClosedZoneClassifications(40);
  } catch (e) {
    console.error("[zone] hydrate error:", (e as Error).message);
  }
}

/** Recompute slHit / deal-based flags on legacy CLOSED rows (History totals + win rate). */
async function backfillClosedZoneClassifications(budget = 40): Promise<void> {
  try {
    const rows = await db.select().from(cascadeZonesTable)
      .where(eq(cascadeZonesTable.status, "CLOSED"))
      .orderBy(desc(cascadeZonesTable.closedAt))
      .limit(budget);
    let n = 0;
    for (const row of rows) {
      const tp1Enabled = (row as { tp1Enabled?: boolean }).tp1Enabled ?? (Number(row.tp1Pct ?? 25) > 0);
      const tp2Enabled = (row as { tp2Enabled?: boolean }).tp2Enabled ?? (Number(row.tp2Pct ?? 25) > 0);
      const tp3Enabled = (row as { tp3Enabled?: boolean }).tp3Enabled ?? (Number(row.tp3Pct ?? 25) > 0);
      const tp4Enabled = (row as { tp4Enabled?: boolean }).tp4Enabled ?? (Number(row.tp4Pct ?? 25) > 0);
      const finalTp = computeFinalTpReached({
        tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
        tp1Hit: Boolean(row.tp1Hit),
        tp2Hit: Boolean(row.tp2Hit),
        tp3Hit: Boolean(row.tp3Hit),
        tp4Hit: Boolean(row.tp4Hit),
        tp4Price: row.tp4Price,
      });
      if (finalTp >= 1 && row.slHit) {
        await db.update(cascadeZonesTable)
          .set({ slHit: false })
          .where(eq(cascadeZonesTable.zoneId, row.zoneId));
      }
      try {
        await settleZoneClosedPnl(row.accountId, row.zoneId);
        n += 1;
      } catch (e) {
        console.warn(`[backfill] settle ${row.zoneId}:`, (e as Error).message);
      }
    }
    if (n > 0) console.log(`[backfill] reclassified ${n} closed zone(s)`);
  } catch (e) {
    console.warn("[backfill] closed-zone classification failed:", (e as Error).message);
  }
}

// ── Notification prefs + push delivery ───────────────────────────────────────
// Per-user prefs let the mobile app opt in to push alerts when an OPEN zone
// is approaching its next TP ("near") or has just hit one ("hit"). Tokens are
// Expo push tokens registered by the client. Detection runs inside
// `evaluateZone` so alerts fire even when the app is backgrounded.

interface NotificationPrefs {
  nearEnabled: boolean;
  hitEnabled: boolean;
  thresholdPips: number;
  expoPushToken: string | null;
}

const notificationPrefs = new Map<string, NotificationPrefs>(); // userId → prefs
const zoneIdToUserId = new Map<string, string>();                // zoneId → userId
// Per-zone: highest TP index for which a "near" alert has already been sent.
// Reset to 0 when the zone advances to the next TP, so each TP step alerts once.
const zoneNearNotifiedTp = new Map<string, number>();

export async function loadNotificationPrefs(): Promise<void> {
  try {
    const rows = await db.select().from(notificationPrefsTable);
    for (const r of rows) {
      notificationPrefs.set(r.userId, {
        nearEnabled: r.nearEnabled,
        hitEnabled: r.hitEnabled,
        thresholdPips: r.thresholdPips,
        expoPushToken: r.expoPushToken,
      });
    }
    if (rows.length > 0) console.log(`[notif] loaded ${rows.length} pref row(s)`);
    // Also hydrate zoneId→userId so the monitor can find the recipient.
    const zones = await db.select({ zoneId: cascadeZonesTable.zoneId, userId: cascadeZonesTable.userId })
      .from(cascadeZonesTable);
    for (const z of zones) {
      if (z.userId) zoneIdToUserId.set(z.zoneId, z.userId);
    }
  } catch (e) {
    console.error("[notif] hydrate error:", (e as Error).message);
  }
}

async function sendExpoPush(
  token: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  if (!token.startsWith("ExponentPushToken[") && !token.startsWith("ExpoPushToken[")) {
    // Reject malformed tokens early — Expo will 400 otherwise.
    console.warn(`[notif] skipping invalid token shape: ${token.slice(0, 20)}…`);
    return;
  }
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify({
        to: token, title, body, data,
        sound: "default", priority: "high", channelId: "tp-alerts",
      }),
    });
    const payload = await res.json().catch(() => ({})) as {
      data?: Array<{ status?: string; message?: string; details?: { error?: string } }>;
    };
    if (!res.ok) {
      console.warn(`[notif] push HTTP ${res.status}: ${JSON.stringify(payload)}`);
      return;
    }
    const ticket = payload.data?.[0];
    if (ticket?.status === "error") {
      console.warn(`[notif] push ticket error: ${ticket.message ?? ""} ${ticket.details?.error ?? ""}`);
    }
  } catch (e) {
    console.warn(`[notif] push error: ${(e as Error).message}`);
  }
}

function resolveZoneNotifyUserId(zoneId: string, accountId?: string): string | undefined {
  const cached = zoneIdToUserId.get(zoneId);
  if (cached) return cached;
  const st = zoneStates.get(zoneId);
  const acct = accountId ?? st?.accountId;
  if (acct) {
    const known = knownAccounts.get(acct);
    if (known?.userId) {
      zoneIdToUserId.set(zoneId, known.userId);
      return known.userId;
    }
  }
  return undefined;
}

async function resolveZoneNotifyUserIdAsync(zoneId: string, accountId?: string): Promise<string | undefined> {
  const immediate = resolveZoneNotifyUserId(zoneId, accountId);
  if (immediate) return immediate;
  try {
    const [row] = await db.select({ userId: cascadeZonesTable.userId })
      .from(cascadeZonesTable)
      .where(eq(cascadeZonesTable.zoneId, zoneId))
      .limit(1);
    if (row?.userId) {
      zoneIdToUserId.set(zoneId, row.userId);
      return row.userId;
    }
  } catch (e) {
    console.warn(`[notif] userId DB lookup failed for zone ${zoneId}:`, (e as Error).message);
  }
  return undefined;
}

async function loadPrefsForUser(userId: string): Promise<NotificationPrefs | null> {
  const cached = notificationPrefs.get(userId);
  if (cached) return cached;
  try {
    const [row] = await db.select().from(notificationPrefsTable)
      .where(eq(notificationPrefsTable.userId, userId))
      .limit(1);
    if (!row) return null;
    const prefs: NotificationPrefs = {
      nearEnabled: row.nearEnabled,
      hitEnabled: row.hitEnabled,
      thresholdPips: row.thresholdPips,
      expoPushToken: row.expoPushToken,
    };
    notificationPrefs.set(userId, prefs);
    return prefs;
  } catch (e) {
    console.warn(`[notif] prefs DB lookup failed for user ${userId}:`, (e as Error).message);
    return null;
  }
}

async function notifyZoneEvent(
  zoneId: string,
  kind: "near" | "hit" | "tp3_runners" | "runner",
  tp: 1 | 2 | 3 | 4,
  pipsToNextTp: number | null,
  direction: "buy" | "sell",
  runnerPrice?: number,
  runnerLots?: number,
): Promise<void> {
  const st = zoneStates.get(zoneId);
  const userId = await resolveZoneNotifyUserIdAsync(zoneId, st?.accountId);
  if (!userId) {
    console.warn(`[notif] no userId for zone ${zoneId} — skipping ${kind} TP${tp}`);
    return;
  }
  const prefs = await loadPrefsForUser(userId);
  if (!prefs?.expoPushToken) {
    console.warn(`[notif] no push token for user ${userId} — skipping ${kind} TP${tp} zone ${zoneId}`);
    return;
  }
  if (kind === "near" && !prefs.nearEnabled) return;
  // TP3 runner activation is critical — send whenever a device token exists.
  if (kind === "hit" || kind === "runner") {
    if (!prefs.hitEnabled) return;
  }
  const dir = direction.toUpperCase();
  const anchor = st?.anchorPrice;
  const anchorFmt = anchor != null ? anchor.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  let title: string;
  let body: string;
  let data: Record<string, unknown>;
  if (kind === "tp3_runners") {
    title = `⚡ TP3 hit — ${dir} ${anchorFmt}`;
    body = "Open app to set your runners";
    data = { type: "tp3_complete", zoneId, direction, anchor: anchor ?? null };
  } else if (kind === "runner") {
    title = `🏃 Runner ${tp} hit — ${dir} ${anchorFmt}`;
    const px = runnerPrice != null ? runnerPrice.toFixed(2) : "—";
    const lots = runnerLots != null ? runnerLots.toFixed(2) : "—";
    body = `Tap to close ${lots} lots`;
    data = { type: "runner_hit", zoneId, runnerN: tp, direction, anchor: anchor ?? null };
  } else {
    title = kind === "hit"
      ? `TP${tp} hit (${dir})`
      : `TP${tp} approaching (${dir})`;
    body = kind === "hit"
      ? `Your ${dir} zone just hit TP${tp}.`
      : pipsToNextTp != null
        ? `${pipsToNextTp.toFixed(1)} pips away from TP${tp}.`
        : `Closing in on TP${tp}.`;
    data = { zoneId, kind, tp };
  }
  await sendExpoPush(prefs.expoPushToken, title, body, data);
  console.log(`[notif] sent ${kind} TP${tp} push to user ${userId} zone ${zoneId}`);
}

// ── Notification prefs routes ────────────────────────────────────────────────
// GET /api/mt5/notifications/prefs
router.get("/mt5/notifications/prefs", async (req: Request, res: Response) => {
  const userId = (req as unknown as Record<string, unknown>)["userId"] as string;
  const cached = notificationPrefs.get(userId);
  if (cached) {
    res.json({
      nearEnabled: cached.nearEnabled,
      hitEnabled: cached.hitEnabled,
      thresholdPips: cached.thresholdPips,
      hasToken: !!cached.expoPushToken,
    });
    return;
  }
  try {
    const [row] = await db.select().from(notificationPrefsTable)
      .where(eq(notificationPrefsTable.userId, userId)).limit(1);
    if (!row) {
      res.json({ nearEnabled: false, hitEnabled: false, thresholdPips: 3, hasToken: false });
      return;
    }
    notificationPrefs.set(userId, {
      nearEnabled: row.nearEnabled, hitEnabled: row.hitEnabled,
      thresholdPips: row.thresholdPips, expoPushToken: row.expoPushToken,
    });
    res.json({
      nearEnabled: row.nearEnabled, hitEnabled: row.hitEnabled,
      thresholdPips: row.thresholdPips, hasToken: !!row.expoPushToken,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/mt5/notifications/prefs
// Body: { nearEnabled?, hitEnabled?, thresholdPips?, expoPushToken? (null clears) }
router.put("/mt5/notifications/prefs", async (req: Request, res: Response) => {
  const userId = (req as unknown as Record<string, unknown>)["userId"] as string;
  const body = (req.body ?? {}) as {
    nearEnabled?: unknown; hitEnabled?: unknown;
    thresholdPips?: unknown; expoPushToken?: unknown;
  };
  const existing = notificationPrefs.get(userId) ?? {
    nearEnabled: false, hitEnabled: false, thresholdPips: 3, expoPushToken: null,
  };
  const next: NotificationPrefs = {
    nearEnabled: typeof body.nearEnabled === "boolean" ? body.nearEnabled : existing.nearEnabled,
    hitEnabled:  typeof body.hitEnabled  === "boolean" ? body.hitEnabled  : existing.hitEnabled,
    thresholdPips: typeof body.thresholdPips === "number" && body.thresholdPips > 0 && body.thresholdPips <= 50
      ? Math.round(body.thresholdPips) : existing.thresholdPips,
    expoPushToken:
      body.expoPushToken === null ? null
      : typeof body.expoPushToken === "string" && body.expoPushToken.length > 0
        ? body.expoPushToken
        : existing.expoPushToken,
  };
  try {
    await db.insert(notificationPrefsTable).values({
      userId,
      nearEnabled:   next.nearEnabled,
      hitEnabled:    next.hitEnabled,
      thresholdPips: next.thresholdPips,
      expoPushToken: next.expoPushToken,
      updatedAt:     Date.now(),
    }).onConflictDoUpdate({
      target: notificationPrefsTable.userId,
      set: {
        nearEnabled:   next.nearEnabled,
        hitEnabled:    next.hitEnabled,
        thresholdPips: next.thresholdPips,
        expoPushToken: next.expoPushToken,
        updatedAt:     Date.now(),
      },
    });
    notificationPrefs.set(userId, next);
    res.json({
      nearEnabled: next.nearEnabled, hitEnabled: next.hitEnabled,
      thresholdPips: next.thresholdPips, hasToken: !!next.expoPushToken,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── SSE stream route ──────────────────────────────────────────────────────────

// GET /api/mt5/account/:accountId/stream
// Server-Sent Events: pushes live price ticks, deal signals (positions changed),
// and zone-state updates to the client. Replaces REST polling for live data.
// Auth: Authorization header (Bearer token) — same as all other endpoints.
// The client reconnects automatically after a disconnect; the server broadcasts
// a heartbeat comment every 15 s to keep connections alive through proxies.
router.get("/mt5/account/:accountId/stream", checkOwner, (req: Request, res: Response) => {
  const { accountId } = req.params as { accountId: string };

  res.setHeader("Content-Type",   "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control",  "no-cache, no-store");
  res.setHeader("Connection",     "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  const write = (payload: string): void => { res.write(payload); };

  // Register this client
  if (!sseClients.has(accountId)) sseClients.set(accountId, new Set());
  sseClients.get(accountId)!.add(write);

  // Confirm connection and send latest cached price immediately
  res.write(`event: connected\ndata: ${JSON.stringify({ accountId })}\n\n`);
  const tick = latestPrice(accountId);
  if (tick) {
    res.write(`event: price\ndata: ${JSON.stringify({ bid: tick.bid, ask: tick.ask })}\n\n`);
  }

  // Heartbeat comment every 8 s — keeps the TCP connection alive through
  // Replit's proxy and mobile carrier NATs that close idle connections.
  const hb = setInterval(() => {
    try { res.write(": hb\n\n"); } catch { clearInterval(hb); }
  }, 8_000);

  req.on("close", () => {
    clearInterval(hb);
    sseClients.get(accountId)?.delete(write);
    if (!sseClients.get(accountId)?.size) sseClients.delete(accountId);
  });
});

// ── Zone routes ──────────────────────────────────────────────────────────────

// GET /api/mt5/account/:accountId/zones — list active + risk-free zones with live position count.
router.get("/mt5/account/:accountId/zones", checkOwner, async (req: Request, res: Response) => {
  try {
    await ensureCascadeZoneRfColumns();
    await ensureCascadeZoneRunnerColumns();
    const { accountId } = req.params as { accountId: string };
    const includeClosed = qstr(req.query.includeClosed) === "true";
    const zones = await db.select().from(cascadeZonesTable)
      .where(eq(cascadeZonesTable.accountId, accountId));
    // Reuse the cached tick from the existing /price poll — no extra backend load.
    const price = latestPrice(accountId);
    const out = [];
    let settleBudget = 8;
    for (const z of zones) {
      try {
      if (!includeClosed && z.status === "CLOSED") continue;
      let row = z;
      const needsSettle = z.status === "CLOSED" && (
        z.closedPnl == null
        || (!(z as { slHit?: boolean }).slHit && !(z as { riskFreeSlExit?: boolean }).riskFreeSlExit)
      );
      if (needsSettle && settleBudget > 0) {
        settleBudget -= 1;
        try {
          await settleZoneClosedPnl(accountId, z.zoneId);
          const [fresh] = await db.select().from(cascadeZonesTable)
            .where(eq(cascadeZonesTable.zoneId, z.zoneId))
            .limit(1);
          if (fresh) row = fresh;
        } catch (settleErr) {
          console.warn(`[zones] settle ${z.zoneId}:`, (settleErr as Error).message);
        }
      } else if (z.status === "CLOSED" && z.closedPnl == null) {
        void settleZoneClosedPnl(accountId, z.zoneId);
      }
      const tp1Enabled = (row as { tp1Enabled?: boolean }).tp1Enabled ?? (Number(row.tp1Pct ?? 25) > 0);
      const tp2Enabled = (row as { tp2Enabled?: boolean }).tp2Enabled ?? (Number(row.tp2Pct ?? 25) > 0);
      const tp3Enabled = (row as { tp3Enabled?: boolean }).tp3Enabled ?? (Number(row.tp3Pct ?? 25) > 0);
      const tp4Enabled = (row as { tp4Enabled?: boolean }).tp4Enabled ?? (Number(row.tp4Pct ?? 25) > 0);
      let mergedHits = await mergeZoneHitsFromPositions(row.zoneId, {
        tp1Hit: row.tp1Hit, tp2Hit: row.tp2Hit, tp3Hit: row.tp3Hit, tp4Hit: row.tp4Hit ?? false,
        tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
      });
      const dir = row.direction === "sell" ? "sell" : "buy";
      const anchor = Number(row.anchorPrice);
      // Resolve absolute TP prices, falling back to anchor + legacy pip distance.
      const fromPips = (pips: number) => dir === "buy" ? anchor + pips * PIP : anchor - pips * PIP;
      const tp1Price = row.tp1Price != null ? Number(row.tp1Price) : (row.tp1Pips ? fromPips(Number(row.tp1Pips)) : null);
      const tp2Price = row.tp2Price != null ? Number(row.tp2Price) : (row.tp2Pips ? fromPips(Number(row.tp2Pips)) : null);
      const tp3Price = row.tp3Price != null ? Number(row.tp3Price) : (row.tp3Pips ? fromPips(Number(row.tp3Pips)) : null);
      const tp4Price = row.tp4Price != null ? Number(row.tp4Price) : null;
      mergedHits = sanitizeZoneTpLadder({ ...mergedHits, tp4Price });
      const positionCount = mergedHits.positionCount;
      const finalTpReached = computeFinalTpReached({
        tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
        tp1Hit: mergedHits.tp1Hit, tp2Hit: mergedHits.tp2Hit, tp3Hit: mergedHits.tp3Hit, tp4Hit: mergedHits.tp4Hit,
        tp4Price,
      });
      const enabledTpCount = countEnabledTps({ tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled, tp4Price });
      const hitEnabledTpCount = countHitEnabledTps({
        tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
        tp1Hit: mergedHits.tp1Hit, tp2Hit: mergedHits.tp2Hit, tp3Hit: mergedHits.tp3Hit, tp4Hit: mergedHits.tp4Hit,
        tp4Price,
      });

      const openPosRows = await db.select({
        tp1Hit: zonePositionsTable.tp1Hit,
        tp2Hit: zonePositionsTable.tp2Hit,
        tp3Hit: zonePositionsTable.tp3Hit,
      }).from(zonePositionsTable)
        .where(and(eq(zonePositionsTable.zoneId, row.zoneId), eq(zonePositionsTable.status, "OPEN")));
      const takeTpLevel = computeNextTakeTpLevel(openPosRows, { tp1Enabled, tp2Enabled, tp3Enabled });

      let nextTp: 0 | 1 | 2 | 3 | 4 = 0;
      if (tp1Enabled && !mergedHits.tp1Hit) nextTp = 1;
      else if (tp2Enabled && !mergedHits.tp2Hit) nextTp = 2;
      else if (tp3Enabled && !mergedHits.tp3Hit) nextTp = 3;
      else if (tp4Enabled && !mergedHits.tp4Hit && tp4Price != null) nextTp = 4;

      let currentPrice: number | null = null;
      let nextTpPrice: number | null = null;
      let pipsToNextTp: number | null = null;
      let progressPct: number | null = null;

      if (price && anchor > 0 && row.status !== "CLOSED" && nextTp > 0) {
        const cmp = dir === "buy" ? price.bid : price.ask;
        currentPrice = cmp;
        const tps = [tp1Price, tp2Price, tp3Price, tp4Price];
        const nextPx = tps[nextTp - 1];
        const prevPx = nextTp === 1 ? anchor : (tps[nextTp - 2] ?? anchor);
        if (nextPx != null) {
          nextTpPrice = parseFloat(nextPx.toFixed(2));
          const sign = dir === "buy" ? 1 : -1;
          const remaining = (nextPx - cmp) / PIP * sign;
          pipsToNextTp = Math.round(remaining * 10) / 10;
          const span = (nextPx - prevPx) * sign;
          if (span > 0) {
            const travelled = (cmp - prevPx) * sign;
            progressPct = Math.max(0, Math.min(100, (travelled / span) * 100));
          }
        }
      }

      out.push({
        zoneId: row.zoneId,
        direction: row.direction,
        anchorPrice: anchor,
        tp1Price, tp2Price, tp3Price, tp4Price,
        tp1Hit: mergedHits.tp1Hit, tp2Hit: mergedHits.tp2Hit, tp3Hit: mergedHits.tp3Hit, tp4Hit: mergedHits.tp4Hit,
        tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
        enabledTpCount, hitEnabledTpCount,
        tp2SlIsBestEffort: (row as { tp2SlIsBestEffort?: boolean }).tp2SlIsBestEffort ?? false,
        cashoutDone: row.cashoutDone ?? false,
        status: row.status,
        createdAt: Number(row.createdAt),
        closedAt: row.closedAt != null ? Number(row.closedAt) : null,
        closedPnl: row.closedPnl != null ? Number(row.closedPnl) : null,
        finalTpReached,
        ...(() => {
          const closeFlags = resolveCloseOutcome(row);
          return {
            ...closeFlags,
            primaryOutcome: zonePrimaryOutcome({
              status: row.status,
              ...closeFlags,
              manualClose: row.manualClose,
              finalTpReached,
              tp1Enabled, tp2Enabled, tp3Enabled, tp4Enabled,
              tp1Hit: mergedHits.tp1Hit, tp2Hit: mergedHits.tp2Hit, tp3Hit: mergedHits.tp3Hit, tp4Hit: mergedHits.tp4Hit,
              tp4Price,
            }),
          };
        })(),
        positionCount,
        originalVolume: row.originalVolume != null ? Number(row.originalVolume) : 0,
        tp1Pct: Number(row.tp1Pct ?? 25),
        tp2Pct: Number(row.tp2Pct ?? 25),
        tp3Pct: Number(row.tp3Pct ?? 25),
        tp4Pct: Number(row.tp4Pct ?? 25),
        runner1Price: (row as { runner1Price?: number | null }).runner1Price != null
          ? Number((row as { runner1Price: number }).runner1Price) : null,
        runner1Lots: (row as { runner1Lots?: number | null }).runner1Lots != null
          ? Number((row as { runner1Lots: number }).runner1Lots) : null,
        runner2Price: (row as { runner2Price?: number | null }).runner2Price != null
          ? Number((row as { runner2Price: number }).runner2Price) : null,
        runner2Lots: (row as { runner2Lots?: number | null }).runner2Lots != null
          ? Number((row as { runner2Lots: number }).runner2Lots) : null,
        runner3Price: (row as { runner3Price?: number | null }).runner3Price != null
          ? Number((row as { runner3Price: number }).runner3Price) : null,
        runner3Lots: (row as { runner3Lots?: number | null }).runner3Lots != null
          ? Number((row as { runner3Lots: number }).runner3Lots) : null,
        runner1Hit: Boolean((row as { runner1Hit?: boolean }).runner1Hit),
        runner2Hit: Boolean((row as { runner2Hit?: boolean }).runner2Hit),
        runner3Hit: Boolean((row as { runner3Hit?: boolean }).runner3Hit),
        runner1Auto: Boolean((row as { runner1Auto?: boolean }).runner1Auto),
        runner2Auto: Boolean((row as { runner2Auto?: boolean }).runner2Auto),
        runner3Auto: Boolean((row as { runner3Auto?: boolean }).runner3Auto),
        runnerActive: Boolean((row as { runnerActive?: boolean }).runnerActive),
        runner1Notified: Boolean(zoneStates.get(row.zoneId)?.tpNotified?.runner1),
        runner2Notified: Boolean(zoneStates.get(row.zoneId)?.tpNotified?.runner2),
        runner3Notified: Boolean(zoneStates.get(row.zoneId)?.tpNotified?.runner3),
        currentPrice,
        takeTpLevel,
        nextTp,
        nextTpPrice,
        pipsToNextTp,
        progressPct,
      });
      } catch (zoneErr) {
        console.warn(`[zones] skip zone ${z.zoneId}:`, (zoneErr as Error).message);
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/mt5/account/:accountId/zones/:zoneId/close-partial
router.post("/mt5/account/:accountId/zones/:zoneId/close-partial", checkOwner, async (req: Request, res: Response) => {
  const { accountId, zoneId } = req.params as { accountId: string; zoneId: string };
  try {
    if (rejectIfPriceNotReady(res, accountId)) return;
    await ensureCascadeZoneRunnerColumns();
    const token = getToken();
    const region = qstr(req.query.region) || activeRegions.get(accountId) || knownAccounts.get(accountId)?.region || DEFAULT_REGION;
    const body = (req.body ?? {}) as { pct?: unknown; lots?: unknown; tpLevel?: unknown; runnerN?: unknown; emergency?: unknown };
    const pct = typeof body.pct === "number" ? body.pct : undefined;
    const lots = typeof body.lots === "number" ? body.lots : undefined;
    const tpLevel = typeof body.tpLevel === "number" ? body.tpLevel : undefined;
    const runnerN = typeof body.runnerN === "number" ? body.runnerN : undefined;
    const emergency = body.emergency === true;
    if (!emergency && tpLevel == null) {
      if (!isCloseAllowed(zoneId)) {
        res.status(429).json({ ok: false, message: MARKET_BUSY_MSG });
        return;
      }
      markCloseAttempt(zoneId);
    }
    const result = await handleClosePartial(accountId, zoneId, { pct, lots, tpLevel, runnerN }, token, region);
    if (!result.ok) {
      res.status(result.message === "Zone not found" ? 404 : 409).json(result);
      return;
    }
    broadcastToAccount(accountId, "deal", { type: "position_changed" });
    res.json(result);
  } catch (err) {
    respondZoneActionError(res, "close-partial", err);
  }
});

// POST /api/mt5/account/:accountId/zones/:zoneId/activate-runner
router.post("/mt5/account/:accountId/zones/:zoneId/activate-runner", checkOwner, async (req: Request, res: Response) => {
  const { accountId, zoneId } = req.params as { accountId: string; zoneId: string };
  try {
    if (rejectIfPriceNotReady(res, accountId)) return;
    await ensureCascadeZoneRunnerColumns();
    const token = getToken();
    const region = qstr(req.query.region) || activeRegions.get(accountId) || knownAccounts.get(accountId)?.region || DEFAULT_REGION;
    const st = await loadZone(zoneId);
    if (!st || st.accountId !== accountId || st.status === "CLOSED") {
      res.status(404).json({ ok: false, message: "Zone not found" });
      return;
    }
    const body = (req.body ?? {}) as {
      runner1Price?: unknown; runner1Lots?: unknown;
      runner2Price?: unknown; runner2Lots?: unknown;
      runner3Price?: unknown; runner3Lots?: unknown;
      runner1Auto?: unknown; runner2Auto?: unknown; runner3Auto?: unknown;
    };
    const targets: Array<{ price: number; lots: number }> = [];
    for (const n of [1, 2, 3] as const) {
      const px = body[`runner${n}Price`];
      const lots = body[`runner${n}Lots`];
      if (px == null && lots == null) continue;
      if (typeof px !== "number" || typeof lots !== "number") {
        res.status(400).json({ ok: false, message: `Runner ${n} requires both price and lots` });
        return;
      }
      targets.push({ price: px, lots });
    }
    if (targets.length === 0) {
      res.status(400).json({ ok: false, message: "At least one runner target required" });
      return;
    }
    const tick = tickStore.get(accountId)?.at(-1);
    const livePx = tick
      ? (st.direction === "buy" ? tick.ask : tick.bid)
      : (await fetchSymbolPrice(token, region, accountId, "XAUUSD"))?.[st.direction === "buy" ? "ask" : "bid"] ?? null;
    if (livePx == null) {
      res.status(400).json({ ok: false, message: "Price not ready — wait a moment and try again" });
      return;
    }
    for (const t of targets) {
      if (t.lots < 0.01) {
        res.status(400).json({ ok: false, message: "Each runner lot must be at least 0.01" });
        return;
      }
      if (st.direction === "buy" && t.price <= livePx) {
        res.status(400).json({ ok: false, message: "Runner price must be above current price" });
        return;
      }
      if (st.direction === "sell" && t.price >= livePx) {
        res.status(400).json({ ok: false, message: "Runner price must be below current price" });
        return;
      }
    }
    const sorted = [...targets].sort((a, b) => st.direction === "buy" ? a.price - b.price : b.price - a.price);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!.price;
      const cur = sorted[i]!.price;
      if (st.direction === "buy" ? cur <= prev : cur >= prev) {
        res.status(400).json({ ok: false, message: "Runner prices must be in ascending order (BUY) or descending (SELL)" });
        return;
      }
    }
    const live = await resolveLivePositionsForZoneAction(token, region, accountId, zoneId, st);
    const totalVol = live.reduce((s, p) => s + p.volume, 0);
    const totalLots = targets.reduce((s, t) => s + t.lots, 0);
    if (totalLots > totalVol + 1e-9) {
      res.status(400).json({ ok: false, message: "Total runner lots exceed open volume" });
      return;
    }
    const updateMode = Boolean(st.runnerActive);
    const update: Record<string, number | boolean | null> = { runnerActive: true };
    for (const n of [1, 2, 3] as const) {
      update[`runner${n}Price`] = null;
      update[`runner${n}Lots`] = null;
    }
    targets.forEach((t, idx) => {
      const n = (idx + 1) as 1 | 2 | 3;
      update[`runner${n}Price`] = t.price;
      update[`runner${n}Lots`] = t.lots;
    });
    for (const n of [1, 2, 3] as const) {
      if (!updateMode || update[`runner${n}Price`] != null) {
        update[`runner${n}Hit`] = false;
      }
      const autoVal = body[`runner${n}Auto`];
      if (typeof autoVal === "boolean") {
        update[`runner${n}Auto`] = autoVal;
      }
    }
    await db.update(cascadeZonesTable).set(update).where(eq(cascadeZonesTable.zoneId, zoneId));
    st.runnerActive = true;
    for (const n of [1, 2, 3] as const) {
      st[`runner${n}Price`] = update[`runner${n}Price`] as number | null;
      st[`runner${n}Lots`] = update[`runner${n}Lots`] as number | null;
      if (!updateMode || update[`runner${n}Price`] != null) {
        st[`runner${n}Hit`] = false;
      }
      if (typeof update[`runner${n}Auto`] === "boolean") {
        st[`runner${n}Auto`] = update[`runner${n}Auto`] as boolean;
      }
    }
    const tpNotified = {
      ...(st.tpNotified ?? { tp1: false, tp2: false, tp3: false, runner1: false, runner2: false, runner3: false }),
    };
    if (updateMode) {
      for (const n of [1, 2, 3] as const) {
        if (update[`runner${n}Price`] != null) {
          tpNotified[`runner${n}`] = false;
        }
      }
    } else {
      tpNotified.runner1 = false;
      tpNotified.runner2 = false;
      tpNotified.runner3 = false;
    }
    st.tpNotified = tpNotified;
    broadcastZoneUpdate(zoneId);
    res.json({ ok: true });
  } catch (err) {
    respondZoneActionError(res, "activate-runner", err);
  }
});

// POST /api/mt5/account/:accountId/zones/:zoneId/runner-auto
// Toggle per-runner auto bank (server closes when price hits while app is closed).
router.post("/mt5/account/:accountId/zones/:zoneId/runner-auto", checkOwner, async (req: Request, res: Response) => {
  const { accountId, zoneId } = req.params as { accountId: string; zoneId: string };
  try {
    await ensureCascadeZoneRunnerColumns();
    const st = await loadZone(zoneId);
    if (!st || st.accountId !== accountId || st.status === "CLOSED") {
      res.status(404).json({ ok: false, message: "Zone not found" });
      return;
    }
    const body = (req.body ?? {}) as { runnerN?: unknown; auto?: unknown };
    const runnerN = typeof body.runnerN === "number" ? body.runnerN : Number(body.runnerN);
    if (![1, 2, 3].includes(runnerN)) {
      res.status(400).json({ ok: false, message: "runnerN must be 1, 2, or 3" });
      return;
    }
    if (typeof body.auto !== "boolean") {
      res.status(400).json({ ok: false, message: "auto must be a boolean" });
      return;
    }
    const autoKey = `runner${runnerN}Auto` as "runner1Auto" | "runner2Auto" | "runner3Auto";
    await db.update(cascadeZonesTable)
      .set({ [autoKey]: body.auto })
      .where(eq(cascadeZonesTable.zoneId, zoneId));
    st[autoKey] = body.auto;
    broadcastZoneUpdate(zoneId);
    res.json({ ok: true, runnerN, auto: body.auto });
  } catch (err) {
    respondZoneActionError(res, "runner-auto", err);
  }
});

// POST /api/mt5/account/:accountId/zones/:zoneId/risk-free
// Close all but the best entry; move best entry's SL by signed pip offset.
router.post("/mt5/account/:accountId/zones/:zoneId/risk-free", checkOwner, async (req: Request, res: Response) => {
  const { accountId, zoneId } = req.params as { accountId: string; zoneId: string };
  try {
    if (rejectIfPriceNotReady(res, accountId)) return;
    await ensureCascadeZoneRfColumns();
    const token = getToken();
    const region = qstr(req.query.region) || activeRegions.get(accountId) || knownAccounts.get(accountId)?.region || DEFAULT_REGION;
    const st = await loadZone(zoneId);
    if (!st || st.accountId !== accountId || st.status === "CLOSED") { res.status(404).json({ error: "Zone not found" }); return; }
    if (st.status === "ARMED") {
      res.status(409).json({ error: "Zone not active yet — wait for the first order to fill" });
      return;
    }
    const live = await resolveLivePositionsForZoneAction(token, region, accountId, zoneId, st);
    if (live.length === 0) {
      res.status(409).json({ error: "No open positions in this zone" }); return;
    }
    const sorted = [...live].sort((a, b) =>
      st.direction === "buy"
        ? a.openPrice - b.openPrice
        : b.openPrice - a.openPrice,
    );
    const best = sorted[0]!;
    const others = sorted.slice(1);
    const closeResults = await Promise.all(
      others.map(async (p) => {
        try {
          return { id: p.id, ok: await closeZonePosition(token, region, accountId, p.id) };
        } catch (e) {
          console.warn(`[zone ${zoneId}] risk-free close threw for posId=${p.id}:`, (e as Error).message);
          return { id: p.id, ok: false };
        }
      }),
    );
    const failed: string[] = closeResults.filter((r) => !r.ok).map((r) => r.id);
    const body = (req.body ?? {}) as { riskFreePips?: unknown };
    const pips = body.riskFreePips !== undefined
      ? sanitizeRiskFreePips(body.riskFreePips)
      : (st.riskFreeOffset ?? ZONE_RISK_FREE_PIPS);
    const sl = computeRiskFreeSl(st.direction, best.openPrice, pips);
    const slOk = await modifyZonePositionSl(token, region, accountId, best.id, sl);
    if (failed.length > 0 || !slOk) {
      console.warn(`[zone ${zoneId}] risk-free partial: failedCloses=${failed.length} slOk=${slOk}`);
      res.status(207).json({
        ok: false,
        bestPositionId: best.id,
        sl, slOk,
        closedCount: others.length - failed.length,
        failedPositionIds: failed,
        message: "Some operations failed. Retry to clear remaining issues.",
      });
      return;
    }
    for (const r of closeResults) {
      if (!r.ok) continue;
      await db.update(zonePositionsTable)
        .set({ status: "CLOSED" })
        .where(and(
          eq(zonePositionsTable.zoneId, zoneId),
          eq(zonePositionsTable.positionId, r.id),
        ))
        .catch((e: Error) => console.warn(`[zone ${zoneId}] risk-free mark closed ${r.id}:`, e.message));
      st.trackedPositions.delete(r.id);
    }
    await cancelZoneLimits(token, region, accountId, zoneId);
    broadcastZoneUpdate(zoneId);
    broadcastToAccount(accountId, "deal", { type: "position_changed" });
    console.log(`[zone ${zoneId}] risk-free: kept posId=${best.id} @${best.openPrice} sl=${sl} (pips=${pips})`);
    res.json({ ok: true, bestPositionId: best.id, sl, pips, closedCount: others.length });
  } catch (err) {
    respondZoneActionError(res, "risk-free", err);
  }
});

// POST /api/mt5/account/:accountId/zones/:zoneId/close-worst
// Secure Profits: each tap closes one leg — the rung nearest best on the entry ladder.
// Best stays open; does not move SL/TP or close the whole zone.
router.post("/mt5/account/:accountId/zones/:zoneId/close-worst", checkOwner, async (req: Request, res: Response) => {
  const { accountId, zoneId } = req.params as { accountId: string; zoneId: string };
  try {
    if (rejectIfPriceNotReady(res, accountId)) return;
    const token = getToken();
    const region = qstr(req.query.region) || activeRegions.get(accountId) || knownAccounts.get(accountId)?.region || DEFAULT_REGION;
    const st = await loadZone(zoneId);
    if (!st || st.accountId !== accountId) {
      res.status(404).json({ error: "Zone not found" });
      return;
    }
    if (st.status === "CLOSED") {
      await reopenClosedZoneIfBrokerLegsRemain(token, region, accountId, zoneId, st);
    }
    if (st.status === "CLOSED") {
      res.status(404).json({ error: "Zone not found" });
      return;
    }
    if (st.status === "ARMED") {
      res.status(409).json({ error: "Zone not active yet — wait for the first order to fill" });
      return;
    }
    const live = await resolveLivePositionsForZoneAction(token, region, accountId, zoneId, st);
    if (live.length <= 1) {
      res.status(409).json({ ok: false, message: "Only one position left — nothing to secure" });
      return;
    }
    const sorted = [...live].sort((a, b) =>
      st.direction === "buy" ? a.openPrice - b.openPrice : b.openPrice - a.openPrice,
    );
    const best = sorted[0]!;
    const toClose = sorted[sorted.length - 1]!;
    const { failed } = await closeLiveZoneLegs(token, region, accountId, zoneId, [toClose]);
    if (!failed.includes(toClose.id)) st.trackedPositions.delete(toClose.id);
    if (failed.length > 0) {
      console.warn(`[zone ${zoneId}] secure-profits close failed posId=${toClose.id}`);
      res.status(207).json({
        ok: false,
        bestPositionId: best.id,
        closedPositionId: toClose.id,
        closedCount: 0,
        failedPositionIds: failed,
        message: "Could not close that leg — tap Secure Profits to try again.",
      });
      return;
    }
    const remaining = live.length - 1;
    await new Promise((r) => setTimeout(r, 800));
    broadcastZoneUpdate(zoneId);
    broadcastToAccount(accountId, "deal", { type: "position_changed" });
    console.log(
      `[zone ${zoneId}] secure-profits: kept posId=${best.id} @${best.openPrice} `
      + `closed posId=${toClose.id} @${toClose.openPrice} remaining=${remaining}`,
    );
    res.json({
      ok: true,
      bestPositionId: best.id,
      closedPositionId: toClose.id,
      closedCount: 1,
      positionCount: remaining,
    });
  } catch (err) {
    respondZoneActionError(res, "secure-profits", err);
  }
});

// POST /api/mt5/account/:accountId/zones/:zoneId/close
// User-initiated full close: cancels any outstanding cascade limit orders,
// market-closes every tracked open position in the zone, then marks the
// zone CLOSED. Intended as an "I'm done with this zone" escape hatch when
// the user wants out regardless of TP progress or PnL. The 3-second
// zone-monitor tick will also notice the empty position set and tidy up,
// but doing it inline keeps the UI snappy and the limit-order cleanup
// deterministic from the user's point of view.
router.post("/mt5/account/:accountId/zones/:zoneId/close", checkOwner, async (req: Request, res: Response) => {
  const { accountId, zoneId } = req.params as { accountId: string; zoneId: string };
  try {
    if (rejectIfPriceNotReady(res, accountId)) return;
    const token = getToken();
    const region = qstr(req.query.region) || activeRegions.get(accountId) || knownAccounts.get(accountId)?.region || DEFAULT_REGION;
    // DB-first read via the single loadZone path (cache → DB → hydrate).
    // DB errors bubble up to the surrounding try/catch and return 500.
    let st = await loadZone(zoneId);
    if (!st || st.accountId !== accountId) {
      const liveOrphans = await fetchOpenPositions(token, region, accountId);
      const orphans = liveOrphans.filter((p) => positionBelongsToZone(p, zoneId));
      if (orphans.length > 0) {
        const { failed } = await closeLiveZoneLegs(token, region, accountId, zoneId, orphans);
        if (failed.length > 0) {
          res.status(207).json({
            ok: false,
            closedCount: orphans.length - failed.length,
            failedPositionIds: failed,
            message: "Recovered some orphaned positions — retry to clear the rest.",
          });
          return;
        }
        broadcastToAccount(accountId, "deal", { type: "position_changed" });
        res.json({ ok: true, closedCount: orphans.length, message: "Recovered and closed orphaned positions" });
        return;
      }
      res.status(404).json({ error: "Zone not found" });
      return;
    }

    if (!isCloseAllowed(zoneId)) {
      res.status(429).json({ ok: false, message: MARKET_BUSY_MSG });
      return;
    }
    markCloseAttempt(zoneId);

    await cancelZoneLimits(token, region, accountId, zoneId);

    const live = await resolveLivePositionsForZoneAction(token, region, accountId, zoneId, st);

    // Zone already CLOSED in DB but anchor (or other leg) still open on MT5 — sweep.
    if (st.status === "CLOSED") {
      if (live.length === 0) {
        res.json({ ok: true, closedCount: 0, alreadyClosed: true });
        return;
      }
      const { failed } = await closeLiveZoneLegs(token, region, accountId, zoneId, live);
      for (const id of live.map((p) => p.id)) st.trackedPositions.delete(id);
      if (failed.length > 0) {
        res.status(207).json({
          ok: false,
          closedCount: live.length - failed.length,
          failedPositionIds: failed,
          message: "Some positions failed to close — retry Close Zone to clear the rest.",
        });
        return;
      }
      void settleZoneClosedPnl(accountId, zoneId);
      broadcastZoneUpdate(zoneId);
      broadcastToAccount(accountId, "deal", { type: "position_changed" });
      logEvent("zone.close", { accountId, zoneId, closedCount: live.length, trigger: "user_cleanup" });
      res.json({ ok: true, closedCount: live.length, cleanedUp: true });
      return;
    }

    if (live.length === 0) {
      res.status(409).json({ error: "No open positions in this zone" });
      return;
    }

    const { failed } = await closeLiveZoneLegs(token, region, accountId, zoneId, live);
    for (const id of live.map((p) => p.id)) st.trackedPositions.delete(id);

    if (failed.length > 0) {
      console.warn(`[zone ${zoneId}] close: failedCloses=${failed.length}/${live.length}`);
      res.status(207).json({
        ok: false,
        closedCount: live.length - failed.length,
        failedPositionIds: failed,
        message: "Some positions failed to close — zone NOT marked closed. Retry to clear remaining.",
      });
      return;
    }

    const closedAt = Date.now();
    await db.update(cascadeZonesTable)
      .set({ status: "CLOSED", closedAt })
      .where(eq(cascadeZonesTable.zoneId, zoneId));
    const wasRiskFree = st.status === "RISK_FREE";
    st.status = "CLOSED";
    zoneStates.delete(zoneId);
    await finalizeZoneClose(accountId, zoneId, {
      wasRiskFree,
      exitPrice: exitPriceForZoneClose(accountId, st.direction),
      userInitiated: true,
    });
    void settleZoneClosedPnl(accountId, zoneId);
    broadcastZoneUpdate(zoneId);
    broadcastToAccount(accountId, "deal", { type: "position_changed" });
    logEvent("zone.close", { accountId, zoneId, closedCount: live.length, trigger: "user" });
    res.json({ ok: true, closedCount: live.length });
  } catch (err) {
    respondZoneActionError(res, "close-zone", err);
  }
});

// POST /api/mt5/account/:accountId/zones/arm
// Prepare an @-price cascade zone (status ARMED) before the client places
// pending limits at the ladder prices. First fill promotes ARMED → OPEN.
router.post("/mt5/account/:accountId/zones/arm", checkOwner, async (req: Request, res: Response) => {
  const { accountId } = req.params as { accountId: string };
  const trading = getTradingStatus();
  if (!trading.trading_enabled) {
    res.status(503).json({ error: trading.message });
    return;
  }
  try {
    const raw = req.body as Record<string, unknown>;
    const direction: "buy" | "sell" | null =
      raw.direction === "sell" ? "sell" : raw.direction === "buy" ? "buy" : null;
    if (!direction) {
      res.status(400).json({ error: "direction must be buy or sell" });
      return;
    }
    const anchorPrice = Number(raw.anchorPrice);
    if (!(anchorPrice > 0)) {
      res.status(400).json({ error: "anchorPrice must be a positive number" });
      return;
    }
    const volume = Number(raw.volume ?? 0);
    if (volume < ZONE_MIN_LOT_PER_ENTRY) {
      res.status(400).json({
        error: `volume must be at least ${ZONE_MIN_LOT_PER_ENTRY}`,
      });
      return;
    }
    const pickPrice = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    const tp1Price = pickPrice(raw.tp1Price);
    const tp2Price = pickPrice(raw.tp2Price);
    const tp3Price = pickPrice(raw.tp3Price);
    const tp4Price = pickPrice(raw.tp4Price);
    const cmp = direction === "buy"
      ? (a: number, b: number) => a > b
      : (a: number, b: number) => a < b;
    const tpsValid =
      tp1Price != null && tp2Price != null && tp3Price != null &&
      cmp(tp1Price, anchorPrice) && cmp(tp2Price, tp1Price) && cmp(tp3Price, tp2Price) &&
      (tp4Price == null || cmp(tp4Price, tp3Price));
    if (!tpsValid) {
      res.status(400).json({
        error: `TP1–TP3 must be in strictly ${direction === "buy" ? "ascending" : "descending"} order on the profitable side of anchorPrice`,
      });
      return;
    }
    const pickPct = (v: unknown, def: number): number => {
      const n = typeof v === "number" && Number.isFinite(v) ? v : def;
      return Math.min(100, Math.max(0, n));
    };
    const tp1Pct = pickPct(raw.tp1Pct, 25);
    const tp2Pct = pickPct(raw.tp2Pct, 25);
    const tp3Pct = pickPct(raw.tp3Pct, 25);
    const tp4Pct = pickPct(raw.tp4Pct, 25);
    const clientZoneId = typeof raw.zoneId === "string" ? raw.zoneId.trim() : "";
    const uId = (req as unknown as Record<string, unknown>)["userId"] as string | undefined;
    const rfOffset = getCascadeConfig(accountId, uId).riskFreePips;
    const zoneState = prepareZoneForCascade(
      accountId, direction, uId,
      {
        tp1Price: tp1Price!, tp2Price: tp2Price!, tp3Price: tp3Price!, tp4Price,
        tp1Pct, tp2Pct, tp3Pct, tp4Pct,
        autoBeAtTp: raw.autoBeAtTp,
      },
      volume,
      clientZoneId || undefined,
      anchorPrice,
      rfOffset,
    );
    zoneState.status = "ARMED";
    zoneState.anchorPrice = anchorPrice;
    await persistArmedZone(zoneState, uId);
    zoneStates.set(zoneState.zoneId, zoneState);
    pendingZoneAssoc.set(accountId, { zoneId: zoneState.zoneId, direction, expiresAt: Date.now() + ZONE_ASSOC_WINDOW_MS });
    const accountPending = pendingZoneByZone.get(accountId) ?? new Map();
    accountPending.set(zoneState.zoneId, { zoneId: zoneState.zoneId, direction, expiresAt: Date.now() + ZONE_ASSOC_WINDOW_MS });
    pendingZoneByZone.set(accountId, accountPending);
    broadcastZoneUpdate(zoneState.zoneId);
    res.json({ ok: true, zoneId: zoneState.zoneId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/mt5/account/:accountId/zones/:zoneId/cancel-pending
// User-initiated "delete orders" for a zone: cancels every outstanding
// cascade limit order tied to the zone WITHOUT touching any open positions.
// Use case: user wants to stop additional cascade entries from filling but
// keep the positions they already have. Zone status is intentionally NOT
// changed — the zone is still ACTIVE / RISK_FREE, just with no pending
// fills behind it. Idempotent: if there's nothing pending, returns ok:true
// with cancelledCount:0 so the UI doesn't show a spurious failure.
router.post("/mt5/account/:accountId/zones/:zoneId/cancel-pending", checkOwner, async (req: Request, res: Response) => {
  const { accountId, zoneId } = req.params as { accountId: string; zoneId: string };
  try {
    if (rejectIfPriceNotReady(res, accountId)) return;
    const token = getToken();
    const region = qstr(req.query.region) || activeRegions.get(accountId) || knownAccounts.get(accountId)?.region || DEFAULT_REGION;
    if (!zoneStates.has(zoneId)) {
      await loadZone(zoneId);
    }
    const pendingBefore = orderIdsForZone(accountId, zoneId).length;
    await cancelZoneLimits(token, region, accountId, zoneId);
    const pendingAfter = orderIdsForZone(accountId, zoneId).length;
    const cancelledCount = Math.max(0, pendingBefore - pendingAfter);
    broadcastToAccount(accountId, "pending_order", {});
    broadcastZoneUpdate(zoneId);
    console.log(`[zone ${zoneId}] cancel-pending: user-initiated, cancelled=${cancelledCount}/${pendingBefore}`);
    res.json({ ok: true, cancelledCount });
  } catch (err) {
    respondZoneActionError(res, "cancel-pending", err);
  }
});

// GET /api/mt5/my-account — returns the accountId bound to the authenticated user
router.get("/mt5/my-account", async (req: Request, res: Response) => {
  const userId = (req as unknown as Record<string, unknown>)["userId"] as string;
  try {
    const [row] = await db.select().from(storedAccountsTable).where(eq(storedAccountsTable.userId, userId)).limit(1);
    if (!row) { res.status(404).json({ error: "No account linked" }); return; }
    res.json({ accountId: row.accountId, region: row.region });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/mt5/connect
// Body: { login, password, server } — provision and deploy (returns immediately, client polls /status)
// Body: { accountId } — reconnect stored account
router.post("/mt5/connect", async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const userId = (req as unknown as Record<string, unknown>)["userId"] as string | undefined;

    // Stop streaming and remove DB rows for any previous account belonging to this user
    // that is different from the incoming accountId.  Must be awaited before binding
    // the new account so the old stream's cascade logic is fully shut down first.
    const evictPreviousAccount = async (newAccountId: string) => {
      if (!userId) return;
      try {
        const oldRows = await db.select().from(storedAccountsTable)
          .where(eq(storedAccountsTable.userId, userId));
        for (const row of oldRows) {
          if (row.accountId === newAccountId) continue;
          console.log(`[connect] evicting old account ${row.accountId} for userId=${userId}`);
          await stopStreaming(row.accountId);
          await db.delete(storedAccountsTable)
            .where(eq(storedAccountsTable.accountId, row.accountId));
          userAccountCache.delete(userId);
        }
      } catch (e) {
        console.warn(`[connect] evictPreviousAccount error:`, (e as Error).message);
      }
    };

    // Helper: bind userId → accountId in cache + DB (best-effort, non-blocking)
    const bindAccount = (accountId: string) => {
      if (!userId) return;
      userAccountCache.set(userId, accountId);
      db.update(storedAccountsTable)
        .set({ userId })
        .where(eq(storedAccountsTable.accountId, accountId))
        .catch(() => {});
    };

    // Intercept res.json so every successful response with an accountId field automatically
    // evicts any old account and binds the new one — no need to call these at every return point.
    const _origJson = res.json.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).json = (body: unknown) => {
      if (body && typeof body === "object" && "accountId" in (body as object)) {
        const newId = (body as Record<string, unknown>)["accountId"] as string;
        // Fire eviction async — must not block the HTTP response
        void evictPreviousAccount(newId);
        bindAccount(newId);
      }
      return _origJson(body);
    };

    const { login, password, server, accountId: existingId } = req.body as {
      login?: string;
      password?: string;
      server?: string;
      accountId?: string;
    };

    console.log(`[connect] userId=${userId} login=${login} server=${server} existingId=${existingId}`);

    // ── RECONNECT PATH: existing MetaAPI account ID stored on device ──────────
    if (existingId) {
      // Fail-closed ownership check: only allow reconnect when the DB row exists
      // AND is already bound to the current authenticated user.
      // No row, null userId, or a different userId all return 403.
      const [storedRow] = await db.select().from(storedAccountsTable)
        .where(eq(storedAccountsTable.accountId, existingId))
        .limit(1);
      if (!storedRow || !storedRow.userId || storedRow.userId !== userId) {
        return res.status(403).json({ error: "This account is not linked to your user. Please connect using your MT5 credentials." });
      }

      const acct = await getProvisioningAccount(token, existingId).catch(() => null);
      if (!acct) {
        return res.status(404).json({ error: "Account not found. Please log in again with your credentials." });
      }
      const region = normalizeRegion(acct.region);
      void upsertStoredAccount({
        accountId: existingId,
        region,
        userId,
        mt5Login: acct.login ?? storedRow.mt5Login,
        mt5Server: acct.server ?? storedRow.mt5Server,
      });
      console.log(`[connect] reconnect status=${acct.connectionStatus} region=${region}`);

      if (acct.connectionStatus === "CONNECTED") {
        // Already connected — fetch info and return immediately.
        // If the client API isn't warm yet (just redeployed), fall back to polling.
        // Kick off streaming in background so deal events (and auto-cascade) work
        // even though the app never polls the /events endpoint directly.
        void startStreaming(token, existingId, region, userId ?? undefined);
        try {
          const info = await getAccountInfo(token, existingId, region) as Record<string, unknown>;
          return res.json({
            status: "connected",
            accountId: existingId,
            region,
            name: info.name ?? "Account",
            balance: info.balance ?? 0,
            equity: info.equity ?? 0,
            margin: info.margin ?? 0,
            freeMargin: info.freeMargin ?? 0,
            currency: info.currency ?? "USD",
            leverage: info.leverage ?? 100,
          });
        } catch {
          console.log(`[connect] client API not ready yet for ${existingId} — falling back to polling`);
          return res.json({ status: "deploying", accountId: existingId, region });
        }
      }

      // Not connected — trigger deploy and return "deploying" immediately
      try {
        await deployAccount(token, existingId);
      } catch (deployErr) {
        const msg = (deployErr as Error).message ?? "Deploy failed";
        const isBilling = msg.toLowerCase().includes("top up") || msg.toLowerCase().includes("forbidden");
        return res.status(503).json({
          error: isBilling
            ? "Connection limit reached. Please contact support."
            : msg,
        });
      }
      return res.json({ status: "deploying", accountId: existingId, region });
    }

    // ── FRESH LOGIN PATH: credentials provided ────────────────────────────────
    if (!login || !password || !server) {
      return res.status(400).json({ error: "login, password and server are required." });
    }

    // Check if this login+server is already provisioned on MetaAPI
    const listRes = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
      headers: authHeaders(token),
    });
    const allAccounts = listRes.ok ? (await listRes.json() as ProvisioningAccount[]) : [];
    console.log(`[connect] found ${Array.isArray(allAccounts) ? allAccounts.length : 0} existing accounts`);

    const existing = Array.isArray(allAccounts)
      ? allAccounts.find((a) => a.login === login && a.server === server)
      : undefined;
    const foundId = existing?._id ?? existing?.id;

    if (existing && foundId) {
      // Reuse existing account — update password just in case
      console.log(`[connect] reusing ${foundId} status=${existing.connectionStatus}`);
      await fetch(`${PROVISIONING_BASE}/users/current/accounts/${foundId}`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify({ password }),
      }).catch(() => {});

      // Eagerly transfer DB ownership to the current user so checkOwner
      // passes immediately on subsequent requests (startStreaming also does
      // this, but it runs asynchronously after this response returns).
      const region = normalizeRegion(existing.region);
      if (userId) {
        await upsertStoredAccount({
          accountId: foundId,
          region,
          userId,
          mt5Login: login,
          mt5Server: server,
        }).catch((e: Error) => console.warn(`[connect] eager ownership transfer failed:`, e.message));
        userAccountCache.set(userId, foundId);
      }

      if (existing.connectionStatus === "CONNECTED") {
        try {
          const info = await getAccountInfo(token, foundId, region) as Record<string, unknown>;
          return res.json({
            status: "connected",
            accountId: foundId,
            region,
            name: info.name ?? "Account",
            balance: info.balance ?? 0,
            equity: info.equity ?? 0,
            margin: info.margin ?? 0,
            freeMargin: info.freeMargin ?? 0,
            currency: info.currency ?? "USD",
            leverage: info.leverage ?? 100,
          });
        } catch {
          console.log(`[connect] client API not ready for ${foundId} — falling back to polling`);
          return res.json({ status: "deploying", accountId: foundId, region });
        }
      }

      await deployAccount(token, foundId);
      return res.json({ status: "deploying", accountId: foundId, region });
    }

    // ── CREATE BRAND-NEW MetaAPI ACCOUNT ──────────────────────────────────────
    const createPayload = {
      login,
      password,
      name: `MT5 ${login}`,
      server,
      platform: "mt5",
      type: "cloud-g2",
      reliability: "regular",
      magic: 47182,
      // Vantage Markets executes from Equinix NY4 — provisioning the MetaAPI
      // account in new-york minimises broker round-trip latency, which is the
      // dominant cost when cascading limit orders.
      region: "new-york",
    };

    console.log(`[connect] creating new account login=${login} server=${server}`);

    // MetaAPI provisioning can take 30-40s for unknown brokers (it downloads the broker .dat file).
    // Use a 38-second abort signal to capture the 202 response, then handle it.
    const ctrl = new AbortController();
    const createTimer = setTimeout(() => ctrl.abort(), 38000);

    // Use a different name to avoid conflict with Express's Response type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchRes: any = null;
    let createTimedOut = false;
    try {
      fetchRes = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(createPayload),
        signal: ctrl.signal,
      });
      clearTimeout(createTimer);
      console.log(`[connect] create status=${fetchRes.status}`);
    } catch (fetchErr) {
      clearTimeout(createTimer);
      if ((fetchErr as Error).name === "AbortError") {
        createTimedOut = true;
        console.log(`[connect] create timed out — checking if account was queued`);
      } else {
        throw fetchErr;
      }
    }

    // Handle non-202 error statuses before the timeout/202 path
    if (fetchRes && !createTimedOut && fetchRes.status !== 202 && !fetchRes.ok) {
      const errBody = await fetchRes.json().catch(() => ({})) as ProvisioningAccount & { metadata?: { recommendedRetryTime?: string } };
      console.log(`[connect] create error: status=${fetchRes.status} body=${JSON.stringify(errBody).slice(0, 200)}`);
      if (fetchRes.status === 429) {
        const retryAt = errBody.metadata?.recommendedRetryTime;
        const retryMsg = retryAt ? ` Try again after ${new Date(retryAt).toLocaleTimeString()}.` : " Please try again in 1 hour.";
        return res.status(429).json({ error: `Too many failed attempts for this account.${retryMsg}` });
      }
      if (fetchRes.status === 403) {
        return res.status(403).json({ error: "Connection limit reached. Please contact support." });
      }
      if (errBody.details === "E_AUTH" || errBody.message?.includes("authenticate")) {
        return res.status(401).json({ error: "Invalid credentials — check your MT5 login, password, and server name." });
      }
      return res.status(fetchRes.status).json({ error: errBody.message ?? "Failed to create account. Check your login details and server name." });
    }

    // If the provisioning request timed out, MetaAPI may have queued the account.
    // Check the list — if it appeared, proceed. Otherwise ask client to retry.
    if (createTimedOut || fetchRes?.status === 202) {
      const listR = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, { headers: authHeaders(token) });
      const accts = listR.ok ? (await listR.json() as ProvisioningAccount[]) : [];
      const queued = Array.isArray(accts) ? accts.find((a) => a.login === login && a.server === server) : undefined;
      const queuedId = queued?._id ?? queued?.id;
      if (queued && queuedId) {
        console.log(`[connect] found queued account ${queuedId} — deploying`);
        const region = normalizeRegion(queued.region);
        if (userId) {
          await upsertStoredAccount({
            accountId: queuedId,
            region,
            userId,
            mt5Login: login,
            mt5Server: server,
          }).catch((e: Error) => console.warn(`[connect] queued account persist failed:`, e.message));
        }
        if (queued.connectionStatus !== "CONNECTED") await deployAccount(token, queuedId);
        return res.json({ status: "deploying", accountId: queuedId, region });
      }
      // Account not visible yet — tell client to retry in 70s (MetaAPI says wait 60s)
      console.log(`[connect] account not yet visible, asking client to retry in 70s`);
      return res.json({ status: "pending_broker_detection", retryAfterMs: 70000 });
    }

    const created = await fetchRes.json() as ProvisioningAccount;
    console.log(`[connect] create body: ${JSON.stringify(created).slice(0, 250)}`);

    const newId = created._id ?? created.id;
    if (!newId || typeof newId !== "string" || newId.length < 10) {
      return res.status(500).json({ error: "Unexpected error establishing connection. Please try again." });
    }

    const region = normalizeRegion(created.region);
    console.log(`[connect] created accountId=${newId} region=${region} — deploying`);

    if (userId) {
      await upsertStoredAccount({
        accountId: newId,
        region,
        userId,
        mt5Login: login,
        mt5Server: server,
      }).catch((e: Error) => console.warn(`[connect] new account persist failed:`, e.message));
    }

    // Kick off deploy and return immediately — client will poll /status
    await deployAccount(token, newId);
    return res.json({ status: "deploying", accountId: newId, region });

  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    console.error("[connect] error:", message);
    return res.status(500).json({ error: message });
  }
});

// GET /api/mt5/account/:accountId/status?region=
// Client polls this after getting status="deploying" or "pending_broker_detection"
router.get("/mt5/account/:accountId/status", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const accountId = String(req.params.accountId);
    const region = qstr(req.query.region) || DEFAULT_REGION;

    const acct = await getProvisioningAccount(token, accountId);
    console.log(`[status] accountId=${accountId} state=${acct.state} connectionStatus=${acct.connectionStatus}`);

    if (acct.connectionStatus === "CONNECTED") {
      let info: Record<string, unknown> = {};
      try {
        const effectiveRegion = normalizeRegion(acct.region) || region;
        info = await getAccountInfo(token, accountId, effectiveRegion) as Record<string, unknown>;
      } catch (infoErr) {
        // Client API not yet ready — report still connecting to keep polling
        console.warn(`[status] getAccountInfo failed for ${accountId}:`, (infoErr as Error).message);
        return res.json({ connectionStatus: "CONNECTING", state: acct.state });
      }
      const effectiveRegion = normalizeRegion(acct.region) || region;
      return res.json({
        connectionStatus: "CONNECTED",
        accountId,
        region: effectiveRegion,
        name: info.name ?? "Account",
        balance: info.balance ?? 0,
        equity: info.equity ?? 0,
        margin: info.margin ?? 0,
        freeMargin: info.freeMargin ?? 0,
        currency: info.currency ?? "USD",
        leverage: info.leverage ?? 100,
      });
    }

    if (acct.state === "DEPLOY_FAILED") {
      return res.status(503).json({ connectionStatus: "DEPLOY_FAILED", error: "Deployment failed. Check your credentials and server." });
    }

    // If the account is UNDEPLOYED (e.g. after a server restart or MetaAPI idle timeout),
    // re-trigger deployment so the client doesn't get stuck polling forever.
    if (acct.state === "UNDEPLOYED") {
      console.log(`[status] account ${accountId} is UNDEPLOYED — re-triggering deploy`);
      try {
        await deployAccount(token, accountId);
        return res.json({ connectionStatus: "DEPLOYING", state: "DEPLOYING" });
      } catch (deployErr) {
        const msg = (deployErr as Error).message ?? "Deploy failed";
        const isBilling = msg.toLowerCase().includes("top up") || msg.toLowerCase().includes("forbidden");
        return res.status(503).json({
          connectionStatus: "DEPLOY_FAILED",
          error: isBilling
            ? "Connection limit reached. Please contact support."
            : msg,
        });
      }
    }

    return res.json({ connectionStatus: acct.connectionStatus ?? "DEPLOYING", state: acct.state });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Status check failed" });
  }
});

// In-memory lock to prevent concurrent migrations for the same MT5 login.
// Key: `${loginStr}|${server}`. The lock is best-effort (single-process); a
// real multi-instance deploy would need a DB lock, but this server is
// single-instance on Replit.
const migrationLocks = new Set<string>();

// POST /api/mt5/admin/migrate-region
// Body: { login, password, server, targetRegion? }
// Header: x-admin-key  (header only — never accept via query string)
// Re-provisions an existing MetaAPI account into a different region. Required
// because MetaAPI does not let you change region on an existing account — we
// must delete and recreate. The user's MT5 password is needed (we don't store
// it). User->account binding is preserved across the swap.
//
// Failure recovery: if the delete succeeds but create fails (network blip,
// bad credentials), the old account is gone — admin must call this endpoint
// again with the same payload. The retry will find no existing account and
// fall through to the create path, restoring the userId binding.
async function migrateRegionHandler(req: Request, res: Response): Promise<void> {
  // Fail-closed: require ADMIN_KEY to be configured AND match. No default.
  const ADMIN_KEY = process.env["ADMIN_KEY"];
  if (!ADMIN_KEY) {
    res.status(500).json({ error: "ADMIN_KEY not configured on server" }); return;
  }
  const key = (req.headers["x-admin-key"] as string | undefined) ?? "";
  if (key !== ADMIN_KEY) { res.status(401).json({ error: "admin key required (x-admin-key header)" }); return; }

  const { login, password, server, targetRegion } = (req.body ?? {}) as {
    login?: string | number; password?: string; server?: string; targetRegion?: string;
  };
  const target = (targetRegion ?? "new-york").trim();
  if (!login || !password || !server) {
    res.status(400).json({ error: "login, password, server required" }); return;
  }
  const loginStr = String(login);
  const lockKey = `${loginStr}|${server}`;
  if (migrationLocks.has(lockKey)) {
    res.status(409).json({ error: "Migration already in progress for this login. Try again in a moment." }); return;
  }
  migrationLocks.add(lockKey);

  try {
    const token = getToken();

    // 1. Find existing account on MetaAPI by login+server
    const listR = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, { headers: authHeaders(token) });
    if (!listR.ok) {
      res.status(502).json({ error: `MetaAPI list failed: ${listR.status}` }); return;
    }
    const accts = await listR.json() as ProvisioningAccount[];
    const existing = Array.isArray(accts)
      ? accts.find((a) => String(a.login) === loginStr && a.server === server)
      : undefined;

    let preservedUserId: string | null = null;

    if (existing) {
      const existingId = (existing._id ?? existing.id) as string;
      const existingRegion = normalizeRegion(existing.region);
      console.log(`[migrate] found existing accountId=${existingId} region=${existingRegion} target=${target}`);

      if (existingRegion === target) {
        res.json({ ok: true, accountId: existingId, region: existingRegion, message: "Already in target region — nothing to do." });
        return;
      }

      // Capture userId binding so we can restore it after recreating
      const [row] = await db.select().from(storedAccountsTable).where(eq(storedAccountsTable.accountId, existingId)).limit(1);
      preservedUserId = row?.userId ?? null;

      // 2. Drop DB row FIRST so the watchdog (60 s interval) cannot reconnect
      //    the old account once we stop streaming and undeploy it.
      await db.delete(storedAccountsTable).where(eq(storedAccountsTable.accountId, existingId)).catch(() => {});
      if (preservedUserId) userAccountCache.delete(preservedUserId);

      // 3. Stop streaming
      await stopStreaming(existingId);

      // 4. Undeploy
      const undeployR = await fetch(`${PROVISIONING_BASE}/users/current/accounts/${existingId}/undeploy`, {
        method: "POST", headers: authHeaders(token),
      });
      if (!undeployR.ok && undeployR.status !== 204) {
        const errBody = await undeployR.json().catch(() => ({})) as { message?: string };
        console.warn(`[migrate] undeploy returned ${undeployR.status}: ${errBody.message}`);
      }

      // 5. Poll until confirmed UNDEPLOYED. Only break on confirmed terminal
      //    state — transient lookup errors do NOT advance us to delete.
      const undeployStart = Date.now();
      let transientErrors = 0;
      let confirmedUndeployed = false;
      while (Date.now() - undeployStart < 60000) {
        const acct = await getProvisioningAccount(token, existingId).catch(() => null);
        if (!acct) {
          // 404 means already gone — treat as success
          transientErrors++;
          if (transientErrors >= 3) { confirmedUndeployed = true; break; }
        } else if (acct.state === "UNDEPLOYED" || acct.state === "DELETING") {
          confirmedUndeployed = true; break;
        } else {
          transientErrors = 0;
        }
        await sleep(2000);
      }
      if (!confirmedUndeployed) {
        console.warn(`[migrate] undeploy did not confirm within 60s — attempting delete anyway`);
      }

      // 6. Delete the MetaAPI account
      const delR = await fetch(`${PROVISIONING_BASE}/users/current/accounts/${existingId}`, {
        method: "DELETE", headers: authHeaders(token),
      });
      if (!delR.ok && delR.status !== 204 && delR.status !== 404) {
        const errBody = await delR.json().catch(() => ({})) as { message?: string };
        res.status(502).json({
          error: `Delete failed: ${errBody.message ?? delR.status}. Old account still exists in ${existingRegion}; safe to retry.`,
        }); return;
      }
      console.log(`[migrate] deleted old accountId=${existingId} (preservedUserId=${preservedUserId})`);
    } else {
      console.log(`[migrate] no existing account for login=${loginStr} server=${server} — creating fresh in ${target}`);
      // If a previous run deleted the account but failed at create, the userId
      // binding may already be missing. Try to recover it from our DB rows.
      if (!preservedUserId) {
        const rows = await db.select().from(storedAccountsTable);
        // No way to look up by login (we don't store it), so caller must reconnect
        // through the app if userId binding is lost. Log loudly.
        if (rows.length === 0) console.log(`[migrate] (no DB rows to recover userId from)`);
      }
    }

    // 7. Provision fresh account in target region
    const createPayload = {
      login: loginStr, password, name: `MT5 ${loginStr}`, server,
      platform: "mt5", type: "cloud-g2", reliability: "regular", magic: 47182,
      region: target,
    };
    const createR = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
      method: "POST", headers: authHeaders(token), body: JSON.stringify(createPayload),
    });
    if (!createR.ok && createR.status !== 202) {
      const errBody = await createR.json().catch(() => ({})) as { message?: string; details?: string };
      const msg = errBody.message ?? `create failed: ${createR.status}`;
      // If we already deleted the old account, the admin MUST retry with the
      // same payload — log this loudly so it can be diagnosed.
      console.error(`[migrate] CREATE FAILED after old account deleted. login=${loginStr} server=${server} target=${target} preservedUserId=${preservedUserId} err=${msg}`);
      if (errBody.details === "E_AUTH") {
        res.status(401).json({ error: "Invalid MT5 credentials. Old account already removed — verify password and retry." }); return;
      }
      res.status(502).json({ error: `${msg}. Old account was already removed; retry with same payload.` }); return;
    }
    const created = await createR.json() as ProvisioningAccount;
    const newId = (created._id ?? created.id) as string;
    const newRegion = normalizeRegion(created.region) || target;
    console.log(`[migrate] created new accountId=${newId} region=${newRegion}`);

    // 8. Deploy
    await deployAccount(token, newId);

    // 9. Restore userId binding in DB (upsert). Failure here is logged but the
    //    migration is still considered successful — admin can rebind manually.
    try {
      await upsertStoredAccount({
        accountId: newId,
        region: newRegion,
        userId: preservedUserId,
        mt5Login: loginStr,
        mt5Server: server,
      });
      if (preservedUserId) userAccountCache.set(preservedUserId, newId);
    } catch (e) {
      console.error(`[migrate] DB upsert failed for newId=${newId} userId=${preservedUserId}:`, (e as Error).message);
    }

    // 10. Kick off streaming so cascade is armed once deploy completes
    void startStreaming(token, newId, newRegion, preservedUserId ?? undefined);

    res.json({
      ok: true,
      accountId: newId,
      region: newRegion,
      userId: preservedUserId,
      message: `Account re-provisioned in ${newRegion}. Deploy is in progress — give it 30-60s before trading.`,
    });
  } catch (err) {
    console.error("[migrate] error:", (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  } finally {
    migrationLocks.delete(lockKey);
  }
}

// POST /api/mt5/account/:accountId/disconnect
router.post("/mt5/account/:accountId/disconnect", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const { accountId } = req.params;
    await fetch(`${PROVISIONING_BASE}/users/current/accounts/${accountId}/undeploy`, {
      method: "POST",
      headers: authHeaders(token),
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Disconnect failed" });
  }
});

// GET /api/mt5/account/:accountId/realized-pnl?since=<ms>&region=london
// Sums profit+commission+swap on closed trade deals (DEAL_ENTRY_OUT) since `since` (ms epoch).
router.get("/mt5/account/:accountId/realized-pnl", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const { accountId } = req.params as { accountId: string };
    const region = qstr(req.query.region) || activeRegions.get(accountId) || knownAccounts.get(accountId)?.region || DEFAULT_REGION;
    const sinceMs = parseInt(qstr(req.query.since) ?? "0", 10) || 0;
    const deals = await fetchAccountHistoryDeals(token, region, accountId, sinceMs, Date.now());
    return res.json({ pnl: sumRealizedTradePnlFromDeals(deals) });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /api/mt5/account/:accountId/info?region=london
router.get("/mt5/account/:accountId/info", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const info = await getAccountInfo(token, String(req.params.accountId), region);
    return res.json(info);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /api/mt5/account/:accountId/candles?region=london&timeframe=5m&limit=150
// Candles are built from live price ticks accumulated by the /price endpoint.
router.get("/mt5/account/:accountId/candles", checkOwner, (req: Request, res: Response) => {
  const timeframe = qstr(req.query.timeframe) || "5m";
  const limit = Math.min(parseInt(qstr(req.query.limit) || "150", 10) || 150, 500);
  const candles = buildCandles(req.params.accountId as string, timeframe, limit);
  return res.json(candles);
});

// GET /api/mt5/account/:accountId/price?region=london
router.get("/mt5/account/:accountId/price", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const priceRes = await fetch(
      `${clientBase(region)}/users/current/accounts/${req.params.accountId}/symbols/XAUUSD/current-price`,
      { headers: authHeaders(token) }
    );
    if (!priceRes.ok) return res.status(priceRes.status).json({ error: "Price fetch failed" });
    const priceData = await priceRes.json() as { bid?: number; ask?: number };
    // Accumulate tick for chart history
    if (priceData.bid && priceData.ask) storeTick(req.params.accountId as string, priceData.bid, priceData.ask);
    return res.json(priceData);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /api/mt5/account/:accountId/display-fx?to=GBP&region=london
// Returns FX rate: display amount = usdAmount * rate (XAUUSD risk is quoted in USD).
router.get("/mt5/account/:accountId/display-fx", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const accountId = String(req.params.accountId);
    const to = qstr(req.query.to) || "USD";
    const { rate, currency } = await usdToTargetRate(
      token, region, accountId, to,
      (t, r, a, s) => fetchSymbolPrice(t, r, a, s, { useTickFallback: false }),
    );
    return res.json({ from: "USD", to: currency, rate });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "FX rate failed" });
  }
});

// GET /api/mt5/account/:accountId/positions?region=london
router.get("/mt5/account/:accountId/positions", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const { accountId } = req.params as { accountId: string };
    const posRes = await fetch(
      `${clientBase(region)}/users/current/accounts/${accountId}/positions`,
      { headers: authHeaders(token) }
    );
    if (!posRes.ok) return res.status(posRes.status).json({ error: "Positions fetch failed" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await posRes.json() as any[];
    return res.json(body);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /api/mt5/account/:accountId/orders?region=london  (pending orders)
router.get("/mt5/account/:accountId/orders", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const { accountId } = req.params as { accountId: string };
    const ordRes = await fetch(
      `${clientBase(region)}/users/current/accounts/${accountId}/orders`,
      { headers: authHeaders(token) }
    );
    if (!ordRes.ok) return res.status(ordRes.status).json({ error: "Orders fetch failed" });
    const orders = await ordRes.json() as Array<Record<string, unknown>>;
    // Filter out orders that streaming has confirmed are completed (cancelled/filled).
    // MetaAPI REST is eventually consistent and can serve stale data for minutes;
    // the streaming completedOrderIds set is our real-time source of truth.
    const done = completedOrderIds.get(accountId);
    const filtered = done?.size
      ? orders.filter(o => !done.has(String(o.id ?? o._id ?? "")))
      : orders;
    return res.json(filtered);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// DELETE /api/mt5/account/:accountId/order/:orderId?region=london  (cancel pending order)
router.delete("/mt5/account/:accountId/order/:orderId", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const tradeRes = await fetch(
      `${clientBase(region)}/users/current/accounts/${req.params.accountId}/trade`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ actionType: "ORDER_CANCEL", orderId: req.params.orderId }),
      }
    );
    const data = await tradeRes.json() as { numericCode?: number; message?: string };
    const code = data.numericCode ?? 0;
    const success = TRADE_SUCCESS_CODES.has(code);
    // 4754 = order already gone — still mark completed so /orders filters it out.
    if (success || code === 4754) markOrderCompleted(String(req.params.accountId), String(req.params.orderId));
    console.log(`[cancel-order] orderId=${req.params.orderId} code=${code} success=${success}`);
    return res.status(tradeRes.ok ? 200 : tradeRes.status).json({
      success,
      code,
      message: success ? "Order cancelled" : (TRADE_ERROR_MESSAGES[code] ?? data.message ?? `Cancel failed (code ${code})`),
    });
  } catch (err) {
    return res.status(500).json({ success: false, code: 0, message: err instanceof Error ? err.message : "Cancel failed" });
  }
});

// MT5 trade return code map
const TRADE_SUCCESS_CODES = new Set([10008, 10009, 10010]);
const TRADE_ERROR_MESSAGES: Record<number, string> = {
  10004: "Requote — price changed before execution. Please retry.",
  10006: "Order rejected by the broker.",
  10007: "Order cancelled.",
  10011: "Trade request processing error.",
  10012: "Trade request timed out. Please retry.",
  10013: "Invalid trade request.",
  10014: "Invalid trade volume.",
  10015: "Invalid trade price.",
  10016: "Invalid stop loss or take profit level.",
  10017: "Trading is disabled for this account.",
  10018: "Market is closed. Please try during trading hours.",
  10019: "Insufficient margin. Your free margin is too low for this trade size — try reducing the lot size, closing existing positions, or checking your leverage.",
  10020: "Price changed — no longer valid. Please retry.",
  10021: "No quotes available. Please retry shortly.",
  10022: "Invalid order expiration date.",
  10023: "Order state changed.",
  10024: "Too many requests — please wait before retrying.",
  10025: "No changes in the trade request.",
  10026: "Automated trading disabled by the server.",
  10027: "Automated trading disabled by the client terminal.",
  10028: "Order is locked for processing.",
  10029: "Order or position is frozen.",
  10030: "Invalid order filling type.",
  10031: "No connection to the trade server.",
  10032: "Operation allowed only for live accounts.",
  10033: "Pending order limit reached.",
  10034: "Total volume limit for orders/positions reached.",
  10035: "Invalid or prohibited order type.",
  10036: "Position already closed.",
  10038: "Close volume exceeds current position volume.",
  10039: "A close order already exists for this position.",
  10040: "Maximum number of open positions reached.",
  10041: "Pending order activation request rejected.",
  10042: "Only long (buy) positions allowed for this symbol.",
  10043: "Only short (sell) positions allowed for this symbol.",
  10044: "Only position closing allowed for this symbol.",
  10045: "Positions can only be closed in FIFO order.",
};

// POST /api/mt5/account/:accountId/trade?region=london
// Tries the SDK WebSocket path first (reuses existing stream connection → no new TCP/TLS to MetaAPI).
// Falls back to REST if the connection is unavailable or the SDK call throws.
router.post("/mt5/account/:accountId/trade", checkOwner, async (req: Request, res: Response) => {
  const accountId = String(req.params.accountId);
  const trading = getTradingStatus();
  if (!trading.trading_enabled) {
    res.status(503).json({ error: trading.message });
    return;
  }
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const body = req.body as Record<string, unknown>;
    const clientZoneTag =
      typeof body.zoneId === "string" ? body.zoneId.trim()
        : parseZoneIdFromComment(String(body.comment ?? ""));
    if (clientZoneTag) {
      body.magic = zoneMagicNumber(clientZoneTag);
    }
    let code: number;
    let data: { numericCode?: number; message?: string; orderId?: string; positionId?: string };
    let httpStatus = 200;

    // Detect app-initiated market cascade BEFORE any await so we can set the
    // in-flight guard synchronously. The streaming deal event arrives on the
    // WebSocket before the SDK trade call resolves, so pendingAppCascades must
    // be populated before we yield to the event loop for the first time.
    const _tradeActionType = String(body.actionType ?? "");
    const _tradeComment    = String(body.comment ?? "");
    const _isAppMarketCascade =
      (_tradeComment.startsWith("Cascade") || _tradeComment === "XAUUSD Trader App") &&
      !_tradeActionType.endsWith("_LIMIT");

    // For app-initiated cascade MARKET legs (the trade that creates the zone),
    // reject up-front when TP prices / lot size are invalid — placing an
    // untracked cascade trade silently violates the zone-engine spec.
    if (_tradeComment.startsWith("Cascade") && !_tradeActionType.endsWith("_LIMIT")) {
      const direction = _tradeActionType === "ORDER_TYPE_BUY" ? "buy"
        : _tradeActionType === "ORDER_TYPE_SELL" ? "sell" : null;
      if (direction) {
        const pickP = (v: unknown): number | null =>
          typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
        const tp1 = pickP(body.tp1Price);
        const tp2 = pickP(body.tp2Price);
        const tp3 = pickP(body.tp3Price);
        const tp4 = pickP(body.tp4Price);
        const anchor = Number(body.anchorPrice ?? 0) || 0;
        const vol = Number(body.volume ?? 0) || 0;
        const cmp = direction === "buy"
          ? (a: number, b: number) => a > b
          : (a: number, b: number) => a < b;
        const tpsOk = tp1 != null && tp2 != null && tp3 != null
          && (anchor <= 0 || cmp(tp1, anchor))
          && cmp(tp2, tp1) && cmp(tp3, tp2)
          && (tp4 == null || cmp(tp4, tp3));
        if (!tpsOk) {
          return res.status(400).json({
            success: false, code: 0,
            message: `Cascade requires TP1, TP2, TP3 absolute prices in strictly ${direction === "buy" ? "ascending" : "descending"} order on the profitable side of the entry. TP4 optional.`,
          });
        }
        if (vol < ZONE_MIN_LOT_PER_ENTRY) {
          return res.status(400).json({
            success: false, code: 0,
            message: `Cascade lot size must be at least ${ZONE_MIN_LOT_PER_ENTRY} (broker minimum). Lots ≥ 0.04 get 25% partial closes at each TP; smaller lots will fully close at TP1.`,
          });
        }
      }
    }

    if (_isAppMarketCascade) {
      pendingAppCascades.add(accountId);
    }

    const conn = activeConnections.get(accountId);
    const tradeResult = await executeTradeRequest(conn, region, accountId, token, body);
    code = tradeResult.code;
    data = tradeResult.data;
    httpStatus = tradeResult.httpStatus;
    console.log(`[trade] accountId=${accountId} action=${body.actionType} code=${code}`);

    // ── Dead-account detection ───────────────────────────────────────────────
    // If MetaAPI says the account no longer exists (deleted/orphaned on their
    // side), the trade can never succeed for this accountId. Evict the stale DB
    // row + caches and tell the client to reconnect with fresh credentials so
    // the user isn't left with a button that silently does nothing.
    const _failMsg = String((data as { message?: string }).message ?? "").toLowerCase();
    const _accountGone =
      httpStatus === 404 ||
      _failMsg.includes("trading account") && _failMsg.includes("not found") ||
      _failMsg.includes("account is not deployed") && _failMsg.includes("not found");
    if (_accountGone) {
      pendingAppCascades.delete(accountId);
      console.warn(`[trade] accountId=${accountId} — MetaAPI says account not found. Evicting stale row and asking client to reconnect.`);
      try {
        await stopStreaming(accountId);
        await db.delete(storedAccountsTable).where(eq(storedAccountsTable.accountId, accountId));
        const uId = (req as unknown as Record<string, unknown>)["userId"] as string | undefined;
        if (uId) userAccountCache.delete(uId);
        knownAccounts.delete(accountId);
      } catch (evictErr) {
        console.warn(`[trade] eviction error for ${accountId}:`, (evictErr as Error).message);
      }
      return res.status(410).json({
        success: false,
        code: 0,
        reconnectRequired: true,
        message: "Your MT5 connection has expired. Please reconnect with your MT5 password to continue trading.",
      });
    }

    const success = TRADE_SUCCESS_CODES.has(code);
    const errorMessage = success ? undefined : userFacingTradeMessage(code, data.message);
    if (!success) console.log(`[trade] FAILED action=${body.actionType} code=${code} msg="${errorMessage}"`);
    if (_isAppMarketCascade && !success) {
      scheduleCascadeReconcile(accountId, region, token);
    }
    logEvent(success ? "trade.ok" : "trade.fail", {
      accountId,
      action: _tradeActionType,
      code,
      message: errorMessage ?? null,
      positionId: data.positionId ?? null,
    });
    if (code === 10024) logEvent("rate.hit", { accountId, code });

    // Clear the in-flight guard now that the trade response is back (the race
    // window is closed — the deal event has already been handled or won't fire).
    pendingAppCascades.delete(accountId);

    if (success) {
      const actionType = String(body.actionType ?? "");
      const comment   = String(body.comment ?? "");
      const isAppTrade = comment.startsWith("Cascade") || comment === "XAUUSD Trader App";
      if (isAppTrade) {
        // Limit order placed by the app: track its orderId so that when it fills
        // in a volatile market, onDealAdded skips re-cascading it — even if the
        // broker has stripped the comment by fill time.
        if (actionType.endsWith("_LIMIT") && data.orderId) {
          trackCascadeOrder(accountId, data.orderId);
          console.log(`[trade] tracked cascade limit orderId=${data.orderId}`);
          const limitDir: "buy" | "sell" | null =
            actionType.includes("BUY") ? "buy" :
            actionType.includes("SELL") ? "sell" : null;
          void attachLimitOrderToZone(accountId, data.orderId, comment, limitDir);
        }
        // Market order placed by the app: mark its positionId immediately so the
        // hasBeenCascaded guard blocks it even if the comment is later stripped.
        if (!actionType.endsWith("_LIMIT") && data.positionId) {
          markCascaded(accountId, data.positionId);
          console.log(`[trade] pre-marked cascade market positionId=${data.positionId}`);
          // Create a new zone anchored at the market fill price for the cascade.
          // The companion limits (placed by the app within ~30 s) will be
          // attached via attachLimitOrderToZone above as they come in.
          const isCascadeMarket = comment.startsWith("Cascade");
          if (isCascadeMarket) {
            const direction = actionType === "ORDER_TYPE_BUY" ? "buy" : "sell";
            const positionId = data.positionId;
            const volume = Number((req.body as Record<string, unknown>).volume ?? 0) || 0;
            const uId = (req as unknown as Record<string, unknown>)["userId"] as string | undefined;
            // Per-trade absolute TP prices typed by the user. TP1-3 required,
            // TP4 optional (null/0 = left for manual close). Validation already
            // happened client-side; we re-validate here so a bad request can't
            // create a zone that never fires its TPs.
            const rawBody = req.body as Record<string, unknown>;
            const pickPrice = (v: unknown): number | null =>
              typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
            const tp1Price = pickPrice(rawBody.tp1Price);
            const tp2Price = pickPrice(rawBody.tp2Price);
            const tp3Price = pickPrice(rawBody.tp3Price);
            const tp4Price = pickPrice(rawBody.tp4Price);
            const pickPct = (v: unknown, def: number): number => {
              const n = typeof v === "number" && Number.isFinite(v) ? v : def;
              return Math.min(100, Math.max(0, n));
            };
            const tp1Pct = pickPct(rawBody.tp1Pct, 25);
            const tp2Pct = pickPct(rawBody.tp2Pct, 25);
            const tp3Pct = pickPct(rawBody.tp3Pct, 25);
            const tp4Pct = pickPct(rawBody.tp4Pct, 25);
            const anchorHint = Number(rawBody.anchorPrice ?? 0) || 0;
            const clientZoneId = typeof rawBody.zoneId === "string" ? rawBody.zoneId.trim() : "";
            const cmp = direction === "buy"
              ? (a: number, b: number) => a > b
              : (a: number, b: number) => a < b;
            // TP1<TP2<TP3 (BUY) on profitable side of anchor; reverse for SELL.
            // TP4 optional but must extend the ordering when present.
            const tpsValid =
              tp1Price != null && tp2Price != null && tp3Price != null &&
              (anchorHint <= 0 || cmp(tp1Price, anchorHint)) &&
              cmp(tp2Price, tp1Price) && cmp(tp3Price, tp2Price) &&
              (tp4Price == null || cmp(tp4Price, tp3Price));
            if (!tpsValid) {
              console.warn(`[trade] cascade has invalid/missing TP prices — zone will NOT be created: tp1=${tp1Price} tp2=${tp2Price} tp3=${tp3Price} tp4=${tp4Price}`);
            } else if (volume < ZONE_MIN_LOT_PER_ENTRY) {
              console.warn(`[trade] cascade lot ${volume} below broker minimum ${ZONE_MIN_LOT_PER_ENTRY} — zone will NOT be created`);
            } else {
              // SYNCHRONOUS: reserve zone + pending association *before* the
              // trade response returns, so any companion cascade limit that
              // arrives immediately after will find a zoneId to attach to.
              const zoneState = prepareZoneForCascade(
                accountId, direction, uId,
                {
                  tp1Price: tp1Price!, tp2Price: tp2Price!, tp3Price: tp3Price!, tp4Price,
                  tp1Pct, tp2Pct, tp3Pct, tp4Pct,
                  autoBeAtTp: rawBody.autoBeAtTp,
                },
                volume,
                clientZoneId || parseZoneIdFromComment(comment) || undefined,
                anchorHint,
                getCascadeConfig(accountId, uId).riskFreePips,
              );
              // Seed best-known anchor from caller-provided value / cached tick.
              const tick = latestPrice(accountId);
              if (anchorHint > 0 && zoneState.anchorPrice !== anchorHint) {
                zoneState.anchorPrice = anchorHint;
              } else if (zoneState.anchorPrice <= 0 && tick) {
                zoneState.anchorPrice = direction === "buy" ? tick.ask : tick.bid;
              }
              // DB-FIRST: write the zone row immediately with the best-known
              // anchor so it survives a pod restart. If the server crashes
              // between here and the anchor-refinement below, loadZoneState()
              // will still find this row and the monitor keeps tracking it.
              // evaluateZone guards on anchorPrice > 0, so a zero anchor just
              // pauses TP checks until the refinement below completes.
              const earlyPersist = persistPreparedZone(zoneState, uId, positionId, volume);
              void (async () => {
                try {
                  await earlyPersist; // throws on DB failure — rethrown by persistPreparedZone
                } catch (e) {
                  // DB insert failed — do NOT register the zone in memory.
                  // The zone will not be tracked this session, which is correct:
                  // a restart must not silently resume a zone that has no DB row.
                  console.error(`[zone ${zoneState.zoneId}] zone creation persist FAILED — zone will not be tracked (restart-safe):`, (e as Error).message);
                  return;
                }
                // DB write confirmed — now safe to put zone in the in-memory map.
                // This is the DB-first ordering: DB row exists before monitor sees it.
                zoneStates.set(zoneState.zoneId, zoneState);
                try {
                  const positions = await fetchOpenPositions(getToken(), region, accountId);
                  const me = positions.find(p => p.id === positionId);
                  if (me && me.openPrice > 0 && me.openPrice !== zoneState.anchorPrice) {
                    zoneState.anchorPrice = me.openPrice;
                    const existingPos = zoneState.trackedPositions.get(positionId);
                    zoneState.trackedPositions.set(positionId, { volume, entryPrice: me.openPrice, tp1Hit: existingPos?.tp1Hit ?? false, tp2Hit: existingPos?.tp2Hit ?? false, tp3Hit: existingPos?.tp3Hit ?? false, tp4Hit: existingPos?.tp4Hit ?? false });
                    await Promise.all([
                      db.update(cascadeZonesTable)
                        .set({ anchorPrice: me.openPrice })
                        .where(eq(cascadeZonesTable.zoneId, zoneState.zoneId))
                        .catch((e: Error) => console.warn(`[zone ${zoneState.zoneId}] anchor update failed:`, e.message)),
                      db.update(zonePositionsTable)
                        .set({ entryPrice: me.openPrice })
                        .where(and(
                          eq(zonePositionsTable.zoneId, zoneState.zoneId),
                          eq(zonePositionsTable.positionId, positionId),
                        ))
                        .catch((e: Error) => console.warn(`[zone ${zoneState.zoneId}] entry-price update failed:`, e.message)),
                    ]);
                  }
                } catch { /* keep best-known anchor */ }
              })();
              scheduleCascadeReconcile(accountId, region, token);
            }
          }
        }
      }
    }

    return res.status(httpStatus).json({
      success,
      code,
      message: success ? "Trade executed successfully" : errorMessage,
      orderId: data.orderId,
      positionId: data.positionId,
    });
  } catch (err) {
    pendingAppCascades.delete(accountId);
    return res.status(500).json({ success: false, code: 0, message: err instanceof Error ? err.message : "Trade failed" });
  }
});

// GET /api/mt5/events/:accountId?since=<ms>&region=london
// Returns new DEAL_ENTRY_IN events since `since` (ms epoch).
// Also kicks off the streaming connection for this account if not already running.
router.get("/mt5/events/:accountId", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const { accountId } = req.params as { accountId: string };
    const since = parseInt(qstr(req.query.since) ?? "0", 10) || 0;
    const region = qstr(req.query.region) || DEFAULT_REGION;

    // Start streaming connection in the background (idempotent — safe to call repeatedly)
    const eventsUserId = (req as unknown as Record<string, unknown>)["userId"] as string | undefined;
    void startStreaming(token, accountId, region, eventsUserId);

    const events = getEventsSince(accountId, since);
    return res.json({ events, serverTime: Date.now() });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/cascade-config?accountId=<id>
// Returns cascade config for the authenticated user (userId key),
// falling back to accountId-keyed config, then global default.
router.get("/cascade-config", (req: Request, res: Response) => {
  const userId = (req as unknown as Record<string, unknown>)["userId"] as string | undefined;
  const accountId = typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
  return res.json(getCascadeConfig(accountId, userId));
});

// PUT /api/cascade-config?accountId=<id>
// Body: { enabled?, numPositions?, pipsBetween?, slPips? }
// Saves under the authenticated userId (for per-user isolation).
// Also caches under accountId so the auto-cascade background loop can find it.
router.put("/cascade-config", async (req: Request, res: Response) => {
  const userId = (req as unknown as Record<string, unknown>)["userId"] as string | undefined;
  const accountId = typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
  // Primary save key is userId; fall back to accountId for backwards-compat.
  const saveKey = userId ?? accountId;
  const body = req.body as Partial<CascadeConfig>;
  const current = getCascadeConfig(accountId, userId);
  const result = buildCascadeConfigUpdate(body, current);
  if (!result.ok) {
    return res.status(result.status).json(result.body);
  }
  const nextConfig = result.config;
  // Persist first — only commit to in-memory state when DB write succeeds.
  const saved = await saveCascadeConfig(nextConfig, saveKey);
  if (!saved) {
    return res.status(500).json({ error: "Failed to persist cascade config to database" });
  }
  cascadeConfigs.set(saveKey, nextConfig);
  // Also cache under accountId so the background auto-cascade loop (which only
  // knows accountId) uses the latest user config.
  if (userId && accountId) cascadeConfigs.set(accountId, nextConfig);
  console.log(`[cascade-config] updated key="${saveKey}":`, JSON.stringify(nextConfig));
  return res.json(nextConfig);
});

export default router;
