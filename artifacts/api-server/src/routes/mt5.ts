import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { createRequire } from "module";
import { db, cascadeConfigTable, storedAccountsTable } from "@workspace/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { JWT_SECRET } from "./auth";
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

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { sub: string };
    (req as Record<string, unknown>)["userId"] = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
}

async function checkOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as Record<string, unknown>)["userId"] as string;
  const accountId = req.params["accountId"];
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
let sdkInstance: InstanceType<typeof MetaApi> | null = null;

// ── Cascade Config ────────────────────────────────────────────────────────────
// Persisted to DB, keyed per trading account.
// The empty-string key "" represents the global (account-agnostic) config.
// The app syncs these whenever the user changes settings.

interface CascadeConfig {
  enabled: boolean;
  numPositions: number;
  pipsBetween: number;
  slPips: number;
}

const CASCADE_DEFAULTS: CascadeConfig = { enabled: false, numPositions: 3, pipsBetween: 10, slPips: 100 };

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
      const cfg = {
        enabled:      row.enabled,
        numPositions: row.numPositions,
        pipsBetween:  row.pipsBetween,
        slPips:       row.slPips,
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

// Returns true on success, false on DB failure.
// accountId="" means the global (fallback) config.
async function saveCascadeConfig(config: CascadeConfig, accountId: string): Promise<boolean> {
  try {
    await db.insert(cascadeConfigTable)
      .values({ accountId, ...config })
      .onConflictDoUpdate({
        target: cascadeConfigTable.accountId,
        set: {
          enabled:      config.enabled,
          numPositions: config.numPositions,
          pipsBetween:  config.pipsBetween,
          slPips:       config.slPips,
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
const cascadePlacedOrderIds = new Set<string>();
function trackCascadeOrder(orderId: string | undefined): void {
  if (!orderId) return;
  cascadePlacedOrderIds.add(orderId);
  if (cascadePlacedOrderIds.size > 2000) {
    const first = cascadePlacedOrderIds.values().next().value;
    if (first !== undefined) cascadePlacedOrderIds.delete(first);
  }
}

// Deduplication: MetaAPI connects to two server nodes (london-a and london-b)
// so every deal event arrives twice. Track recently seen deal IDs and drop duplicates.
const seenDealIds = new Set<string>();
function isDuplicate(dealId: string): boolean {
  if (seenDealIds.has(dealId)) return true;
  seenDealIds.add(dealId);
  // Prevent unbounded growth — keep at most 500 entries
  if (seenDealIds.size > 500) {
    const first = seenDealIds.values().next().value;
    if (first !== undefined) seenDealIds.delete(first);
  }
  return false;
}

// Tracks positionIds that have already been auto-cascaded (per account).
// Survives reconnects intentionally — the same position must never be
// double-cascaded even if MetaAPI re-delivers its deal after a reconnect.
// Capped at 2000 entries total across all accounts to bound memory.
const cascadedPositions = new Map<string, Set<string>>(); // accountId → Set<positionId>
function hasBeenCascaded(accountId: string, positionId: string): boolean {
  return cascadedPositions.get(accountId)?.has(positionId) ?? false;
}
function markCascaded(accountId: string, positionId: string): void {
  let set = cascadedPositions.get(accountId);
  if (!set) { set = new Set(); cascadedPositions.set(accountId, set); }
  set.add(positionId);
  // Evict oldest entry if this account's set grows too large
  if (set.size > 2000) {
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
}

// ── Cascade REST placement helper ────────────────────────────────────────────
// Places a single cascade limit order via REST with:
//  • A deterministic clientId (positionId + level index) so MetaAPI deduplicates
//    the order if a retry somehow reaches the server after a timeout.
//  • One retry on pure network errors (fetch throws before we get any response).
//  • No retry on timeout — the order may already be live on the broker.
//  • No retry on HTTP errors — bad request / auth / broker rejection won't fix itself.
async function placeCascadeLimit(opts: {
  region: string;
  token: string;
  accountId: string;
  positionId: string;
  levelIndex: number;
  body: Record<string, unknown>;
}): Promise<string | undefined> {
  const { region, token, accountId, body } = opts;
  const url = `${clientBase(region)}/users/current/accounts/${accountId}/trade`;
  const headers = authHeaders(token);
  const payload = JSON.stringify(body);

  const attempt = async (isRetry: boolean): Promise<string | undefined> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000); // 8s hard timeout
    try {
      const resp = await fetch(url, { method: "POST", headers, body: payload, signal: ctrl.signal });
      clearTimeout(timer);
      const data = await resp.json() as { orderId?: string; message?: string };
      if (!resp.ok) {
        // HTTP error — broker rejected the order or MetaAPI auth failed.
        // No point retrying — log and move on.
        throw new Error(`HTTP ${resp.status}: ${data.message ?? "trade rejected"}`);
      }
      return data.orderId;
    } catch (err) {
      clearTimeout(timer);
      const e = err as Error;
      if (e.name === "AbortError") {
        // Timed out — the request may have reached MetaAPI and been processed.
        // Do NOT retry; the cascadedPositions set already prevents a second cascade
        // for the same positionId, so no double-order risk at the server level.
        throw new Error(`timeout${isRetry ? " (retry)" : ""} — order may be live`);
      }
      throw e; // re-throw for caller to decide on retry
    }
  };

  try {
    return await attempt(false);
  } catch (err) {
    const e = err as Error;
    // Only retry on network-level errors (fetch threw before any HTTP response).
    // Timeout and HTTP errors are not retried (see comments above).
    if (e.message.startsWith("timeout") || e.message.startsWith("HTTP ")) {
      throw e;
    }
    // Network error — wait briefly and try once more.
    await new Promise(r => setTimeout(r, 300));
    return await attempt(true);
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

function makeDealListener(accountId: string) {
  // The MetaAPI SDK calls many methods on every registered listener and throws
  // if any of them is missing — aborting the entire synchronization packet.
  // Rather than enumerating every possible method name, we use a Proxy to
  // silently no-op any method the SDK calls that we haven't explicitly defined.
  const handler = {
    async onDisconnected(_instanceIndex: string): Promise<void> {
      syncReady.delete(accountId); // reset — next reconnect must re-sync before cascading
      activeStreams.delete(accountId);
      activeConnections.delete(accountId);
      console.log(`[stream ${accountId}] WebSocket disconnected — watchdog will reconnect`);
    },
    // onDealsSynchronized fires after all historical deals have been replayed.
    // Any onDealAdded call AFTER this point is a live event — safe to cascade.
    async onDealsSynchronized(_instanceIndex: string, _synchronizationId: string): Promise<void> {
      if (!syncReady.has(accountId)) {
        syncReady.add(accountId);
        console.log(`[stream ${accountId}] deals sync complete — auto-cascade armed for live deals`);

        // ── Post-sync catch-up ─────────────────────────────────────────────
        // Trades placed in MT5 while the server was restarting/reconnecting
        // arrive as onDealAdded events BEFORE this callback fires, so the
        // sync guard silently drops them. Catch those missed positions here.
        void (async () => {
          try {
            const acctCascadeCfg = getCascadeConfig(accountId);
            if (!acctCascadeCfg.enabled) return;

            const region = activeRegions.get(accountId) ?? DEFAULT_REGION;
            const token  = getToken();

            // Fetch open positions and pending orders in parallel
            const [posRes, ordRes] = await Promise.all([
              fetch(`${clientBase(region)}/users/current/accounts/${accountId}/positions`,
                { headers: authHeaders(token) }),
              fetch(`${clientBase(region)}/users/current/accounts/${accountId}/orders`,
                { headers: authHeaders(token) }),
            ]);
            if (!posRes.ok) return;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const positions: any[]    = await posRes.json();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pendingOrders: any[] = ordRes.ok ? await ordRes.json() : [];

            // Positions that already have at least one "Cascade"-tagged limit order
            // don't need cascading — they survived the reconnect intact.
            const cascadedComments = new Set<string>(
              pendingOrders
                .filter((o: any) => String(o.comment ?? "").startsWith("Cascade"))
                // pending limit orders carry clientId or comment but NOT positionId —
                // group by direction+symbol instead; any buy limit → buy positions covered
                .map((o: any) => `${o.symbol}:${String(o.type ?? "").includes("BUY") ? "buy" : "sell"}`)
            );

            const conn = activeConnections.get(accountId);

            for (const pos of positions) {
              if (pos.symbol !== "XAUUSD") continue;
              const posId = String(pos.id ?? pos._id ?? "");
              if (!posId) continue;
              if (hasBeenCascaded(accountId, posId)) continue;

              const direction: "buy" | "sell" = String(pos.type ?? "").includes("BUY") ? "buy" : "sell";

              // If cascade limits already exist for this direction, mark and skip
              if (cascadedComments.has(`XAUUSD:${direction}`)) {
                markCascaded(accountId, posId);
                console.log(`[post-sync-cascade] SKIP posId=${posId} — existing limits found`);
                continue;
              }

              const openPrice = pos.openPrice ?? 0;
              if (openPrice <= 0) continue;

              const levels = buildCascadeLevels(openPrice, direction, acctCascadeCfg);
              const total  = 1 + levels.limitEntries.length;
              markCascaded(accountId, posId);
              recordCascade(accountId, openPrice);
              console.log(`[post-sync-cascade] posId=${posId} dir=${direction} price=${openPrice} limits=[${levels.limitEntries.join(",")}] sl=${levels.stopLoss}`);

              await Promise.all(
                levels.limitEntries.map(async (limitPrice, i) => {
                  const body: Record<string, unknown> = {
                    actionType: direction === "buy" ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_SELL_LIMIT",
                    symbol:    "XAUUSD",
                    volume:    pos.volume,
                    openPrice: limitPrice,
                    stopLoss:  levels.stopLoss,
                    comment:   `Cascade ${i + 2}/${total}`,
                  };
                  try {
                    const orderId = await placeCascadeLimit({
                      region, token, accountId,
                      positionId: posId,
                      levelIndex: i,
                      body,
                    });
                    trackCascadeOrder(orderId);
                    console.log(`[post-sync-cascade] placed limit ${i + 2}/${total} @ ${limitPrice}`);
                  } catch (e) {
                    console.error(`[post-sync-cascade] failed limit ${i + 2}/${total} @ ${limitPrice}:`, (e as Error).message);
                  }
                })
              );
            }
          } catch (e) {
            console.error(`[post-sync-cascade] catch-up error:`, (e as Error).message);
          }
        })();
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async onDealAdded(_instanceIndex: string, deal: any): Promise<void> {
      if (deal?.entryType !== "DEAL_ENTRY_IN") return;
      if (!deal?.symbol) return;
      if (isDuplicate(String(deal.id ?? ""))) return;
      // Guard: if this deal was created by filling one of our cascade limit orders,
      // never re-cascade it — even if the broker stripped the comment.
      if (deal.orderId && cascadePlacedOrderIds.has(String(deal.orderId))) return;
      // MetaAPI streaming deal events expose the execution price as `deal.price`
      // (the tick price at fill time). `deal.openPrice` may be 0 or absent in
      // the streaming payload — always prefer whichever field is non-zero.
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

      // ── Auto-cascade: place limit orders for trades opened directly in MT5 ──
      const acctCascadeCfg = getCascadeConfig(accountId);

      // Layer 1: sync guard — never cascade historical deals replayed on connect
      if (!syncReady.has(accountId)) { /* skip — historical replay */ }
      // Layer 2: feature enabled + correct symbol + valid price
      else if (!acctCascadeCfg.enabled || evt.symbol !== "XAUUSD" || evt.openPrice <= 0) { /* skip — disabled or irrelevant */ }
      // Layer 3: positionId already cascaded (covers app-placed market orders pre-marked above)
      else if (hasBeenCascaded(accountId, evt.positionId)) {
        console.log(`[auto-cascade] SKIP posId=${evt.positionId} — already cascaded`);
      }
      // Layer 4: an app-initiated market cascade trade is in-flight for this account.
      // The deal event arrives via stream before the SDK trade response resolves, so
      // markCascaded hasn't been called yet — we mark it here to close the race.
      else if (pendingAppCascades.has(accountId)) {
        markCascaded(accountId, evt.positionId);
        console.log(`[auto-cascade] SKIP posId=${evt.positionId} — in-flight app cascade (race guard)`);
      }
      // Layer 5: comment identifies this as an app-placed trade (broker may strip comment, so this
      // is a best-effort check — Layer 4 and Layer 6 handle the cases where comment is absent).
      else if ((evt.comment ?? "").startsWith("Cascade") || evt.comment === "XAUUSD Trader App") {
        console.log(`[auto-cascade] SKIP posId=${evt.positionId} — app-placed trade (comment="${evt.comment ?? ""}")`);
        markCascaded(accountId, evt.positionId);
      }
      // Layer 6: rapid-trade dedup — two deals at nearly the same price within a few seconds
      // almost certainly means a double-click / double-tap in MT5 rather than a new position.
      else if (isRapidDuplicate(accountId, evt.openPrice)) {
        markCascaded(accountId, evt.positionId);
        console.log(`[auto-cascade] SKIP posId=${evt.positionId} price=${evt.openPrice} — rapid duplicate (Layer 6)`);
      }
      else {
        markCascaded(accountId, evt.positionId);
        recordCascade(accountId, evt.openPrice);
        void (async () => {
            const direction: "buy" | "sell" = evt.type === "DEAL_TYPE_BUY" ? "buy" : "sell";
            const levels = buildCascadeLevels(evt.openPrice, direction, acctCascadeCfg);
            const total = 1 + levels.limitEntries.length;
            console.log(`[auto-cascade] posId=${evt.positionId} dir=${direction} price=${evt.openPrice} limits=[${levels.limitEntries.join(",")}] sl=${levels.stopLoss}`);
            const region = activeRegions.get(accountId) ?? DEFAULT_REGION;
            const token = getToken();
            let placed = 0;
            await Promise.all(
              levels.limitEntries.map(async (limitPrice, i) => {
                const body: Record<string, unknown> = {
                  actionType: direction === "buy" ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_SELL_LIMIT",
                  symbol: "XAUUSD",
                  volume: evt.volume,
                  openPrice: limitPrice,
                  stopLoss: levels.stopLoss,
                  comment: `Cascade ${i + 2}/${total}`,
                };
                try {
                  const orderId = await placeCascadeLimit({
                    region, token, accountId,
                    positionId: evt.positionId,
                    levelIndex: i,
                    body,
                  });
                  trackCascadeOrder(orderId);
                  placed++;
                  console.log(`[auto-cascade] placed limit ${i + 2}/${total} @ ${limitPrice}`);
                } catch (tradeErr) {
                  console.error(`[auto-cascade] failed limit ${i + 2}/${total} @ ${limitPrice}:`, (tradeErr as Error).message);
                }
              })
            );
            // Append a new synthetic event after placement completes so the app can show a notification.
            // We do NOT mutate the original event in place — that would create a race where a client
            // poll during placement advances its `since` watermark past the original event's timestamp
            // and never sees the mutation. A fresh event with time=now() is always after the watermark.
            if (placed > 0) {
              const syntheticEvt: DealEvent = {
                ...evt,
                dealId: `cascade-${evt.dealId}`, // unique ID — won't dedup with the real deal event
                time: Date.now(),                 // timestamp after placement; guaranteed > any poll watermark set before now
                autoCascade: true,
                autoCascadeCount: placed,
              };
              storeDealEvent(accountId, syntheticEvt);
              console.log(`[auto-cascade] stored synthetic notification event dealId=${syntheticEvt.dealId} autoCascadeCount=${placed}`);
            }
          })();
      }
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
  cascadeConfigs.delete(accountId);
  console.log(`[stream ${accountId}] stopped and cleaned up`);
}

async function startStreaming(token: string, accountId: string, region: string = DEFAULT_REGION, userId?: string): Promise<void> {
  if (activeStreams.has(accountId)) return;
  activeStreams.add(accountId);
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
    const conn = account.getStreamingConnection();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).addSynchronizationListener(makeDealListener(accountId));
    await conn.connect();
    // Store connection so the trade endpoint can reuse this WebSocket
    // instead of making new HTTP calls to MetaAPI REST for every order.
    activeConnections.set(accountId, conn);
    activeRegions.set(accountId, region);
    console.log(`[stream ${accountId}] streaming connection established — SDK trade path armed`);
    // Persist credentials so the server can auto-reconnect after a restart
    // without waiting for the app to call /connect again.
    // userId is included when available so /my-account lookups work reliably.
    try {
      const now = Date.now();
      const updateFields: Record<string, unknown> = { region, storedAt: now };
      if (userId) updateFields["userId"] = userId;
      await db.insert(storedAccountsTable)
        .values({ accountId, region, storedAt: now, ...(userId ? { userId } : {}) })
        .onConflictDoUpdate({
          target: storedAccountsTable.accountId,
          set: updateFields,
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
    for (const { accountId, region } of rows) {
      console.log(`[auto-connect] reconnecting accountId=${accountId} region=${region}`);
      void startStreaming(token, accountId, region);
    }
  } catch (err) {
    console.error("[auto-connect] failed:", (err as Error).message);
  }
}

export function startConnectionWatchdog(): void {
  const INTERVAL_MS = 30_000;
  setInterval(async () => {
    try {
      const token = getToken();
      const rows = await db
        .select()
        .from(storedAccountsTable)
        .where(isNotNull(storedAccountsTable.userId));
      for (const { accountId, region } of rows) {
        if (!activeStreams.has(accountId)) {
          console.log(`[watchdog] ${accountId} not streaming — reconnecting`);
          void startStreaming(token, accountId, region);
        }
      }
    } catch (err) {
      console.warn("[watchdog] error:", (err as Error).message);
    }
  }, INTERVAL_MS);
  console.log("[watchdog] connection watchdog started (60 s interval)");
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

// GET /api/mt5/my-account — returns the accountId bound to the authenticated user
router.get("/mt5/my-account", async (req: Request, res: Response) => {
  const userId = (req as Record<string, unknown>)["userId"] as string;
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
    const userId = (req as Record<string, unknown>)["userId"] as string | undefined;

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

      const region = normalizeRegion(existing.region);

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

// GET /api/mt5/account/:accountId/positions?region=london
router.get("/mt5/account/:accountId/positions", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const posRes = await fetch(
      `${clientBase(region)}/users/current/accounts/${req.params.accountId}/positions`,
      { headers: authHeaders(token) }
    );
    if (!posRes.ok) return res.status(posRes.status).json({ error: "Positions fetch failed" });
    return res.json(await posRes.json());
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /api/mt5/account/:accountId/orders?region=london  (pending orders)
router.get("/mt5/account/:accountId/orders", checkOwner, async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const ordRes = await fetch(
      `${clientBase(region)}/users/current/accounts/${req.params.accountId}/orders`,
      { headers: authHeaders(token) }
    );
    if (!ordRes.ok) return res.status(ordRes.status).json({ error: "Orders fetch failed" });
    return res.json(await ordRes.json());
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
  try {
    const token = getToken();
    const region = qstr(req.query.region) || DEFAULT_REGION;
    const body = req.body as Record<string, unknown>;
    const accountId = String(req.params.accountId);
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
    if (_isAppMarketCascade) {
      pendingAppCascades.add(accountId);
    }

    const conn = activeConnections.get(accountId);
    if (conn) {
      try {
        const sdkResp = await tradeViaConnection(conn, body);
        code = sdkResp.numericCode;
        data = sdkResp;
        console.log(`[trade/sdk] accountId=${accountId} action=${body.actionType} code=${code}`);
      } catch (sdkErr) {
        // SDK path failed (connection dropped, method error, etc.) — try REST
        console.log(`[trade/sdk→rest] SDK trade failed (${(sdkErr as Error).message}), falling back to REST`);
        const tradeRes = await fetch(
          `${clientBase(region)}/users/current/accounts/${accountId}/trade`,
          { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
        );
        httpStatus = tradeRes.ok ? 200 : tradeRes.status;
        data = await tradeRes.json() as typeof data;
        code = data.numericCode ?? 0;
        console.log(`[trade/rest-fallback] accountId=${accountId} action=${body.actionType} code=${code}`);
      }
    } else {
      // No streaming connection established yet — use REST directly
      const tradeRes = await fetch(
        `${clientBase(region)}/users/current/accounts/${accountId}/trade`,
        { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
      );
      httpStatus = tradeRes.ok ? 200 : tradeRes.status;
      data = await tradeRes.json() as typeof data;
      code = data.numericCode ?? 0;
      console.log(`[trade/rest] accountId=${accountId} action=${body.actionType} code=${code}`);
    }

    const success = TRADE_SUCCESS_CODES.has(code);
    const errorMessage = success ? undefined : (TRADE_ERROR_MESSAGES[code] ?? data.message ?? `Trade failed (code ${code})`);
    if (!success) console.log(`[trade] FAILED action=${body.actionType} code=${code} msg="${errorMessage}"`);

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
          trackCascadeOrder(data.orderId);
          console.log(`[trade] tracked cascade limit orderId=${data.orderId}`);
        }
        // Market order placed by the app: mark its positionId immediately so the
        // hasBeenCascaded guard blocks it even if the comment is later stripped.
        if (!actionType.endsWith("_LIMIT") && data.positionId) {
          markCascaded(accountId, data.positionId);
          console.log(`[trade] pre-marked cascade market positionId=${data.positionId}`);
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
    const eventsUserId = (req as Record<string, unknown>)["userId"] as string | undefined;
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
  const userId = (req as Record<string, unknown>)["userId"] as string | undefined;
  const accountId = typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
  return res.json(getCascadeConfig(accountId, userId));
});

// PUT /api/cascade-config?accountId=<id>
// Body: { enabled?, numPositions?, pipsBetween?, slPips? }
// Saves under the authenticated userId (for per-user isolation).
// Also caches under accountId so the auto-cascade background loop can find it.
router.put("/cascade-config", async (req: Request, res: Response) => {
  const userId = (req as Record<string, unknown>)["userId"] as string | undefined;
  const accountId = typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
  // Primary save key is userId; fall back to accountId for backwards-compat.
  const saveKey = userId ?? accountId;
  const body = req.body as Partial<CascadeConfig>;
  const current = getCascadeConfig(accountId, userId);
  // Build the candidate config without mutating in-memory state yet.
  const nextConfig: CascadeConfig = {
    enabled:      typeof body.enabled      === "boolean" ? body.enabled      : current.enabled,
    numPositions: typeof body.numPositions === "number"  ? body.numPositions : current.numPositions,
    pipsBetween:  typeof body.pipsBetween  === "number"  ? body.pipsBetween  : current.pipsBetween,
    slPips:       typeof body.slPips       === "number"  ? body.slPips       : current.slPips,
  };
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
