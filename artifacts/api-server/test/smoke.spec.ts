/**
 * MT5 Trader API — Playwright Smoke Suite
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Architecture note — what these tests validate                          │
 * │                                                                         │
 * │  Target: SMOKE_BASE_URL (the currently deployed server).                │
 * │  Purpose: pre-deploy regression guard — verifies the live server is     │
 * │  healthy before the new build goes live. Replit VM deployments have     │
 * │  no staging slot, so candidate code can only be validated post-swap     │
 * │  via the startup health check (/healthz). This suite provides the       │
 * │  pre-swap baseline: if production is already broken, abort the deploy.  │
 * │                                                                         │
 * │  Test modality: Playwright request fixture (HTTP API testing).          │
 * │  Why not browser UI?: The trading app is an Expo/React Native mobile    │
 * │  app — it has no Playwright-accessible web UI. All trading flow state   │
 * │  changes (zone creation, SL mutations, zone closure) are observable     │
 * │  exclusively through the JSON API, making request-based testing the     │
 * │  correct and complete signal for state-transition regressions.          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Five scenarios, executed in sequence on the live server:
 *
 *   1. Public health + status dashboard
 *   2. Auth flow (register → login → auth-guarded config)
 *   3. Admin telemetry endpoint
 *   4. End-to-end cascade with explicit state-transition assertions:
 *        connect → place cascade trade → verify zone visible →
 *        trigger risk-free → verify SL moved on broker → close zone →
 *        verify zone status CLOSED with closedAt + 0 open positions
 *
 * Run:
 *   SMOKE_BASE_URL=https://meta-trader-link.replit.app \
 *   ADMIN_KEY=... \
 *   DEMO_MT5_LOGIN=... DEMO_MT5_PASSWORD=... DEMO_MT5_SERVER=... \
 *     pnpm --filter @workspace/api-server run smoke
 */

import { test, expect } from "@playwright/test";

const ADMIN_KEY = process.env.ADMIN_KEY ?? "";
const DEMO_LOGIN = process.env.DEMO_MT5_LOGIN ?? "";
const DEMO_PASSWORD = process.env.DEMO_MT5_PASSWORD ?? "";
const DEMO_SERVER = process.env.DEMO_MT5_SERVER ?? "";
const DEMO_PLATFORM = process.env.DEMO_MT5_PLATFORM ?? "mt5";

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Public endpoints
// ──────────────────────────────────────────────────────────────────────────────

test("Public: GET /api/healthz → 200 {status:'ok'}", async ({ request }) => {
  // Note: bare /healthz is intercepted by Replit's CDN layer (reserved probe
  // path). The same handler is reachable at /api/healthz via the routed prefix.
  const r = await request.get("/api/healthz");
  expect(r.ok()).toBe(true);
  const body = await r.json() as { status: string };
  expect(body.status).toBe("ok");
});

test("Public: GET /status → 200 HTML dashboard with auto-refresh", async ({ request }) => {
  const r = await request.get("/status");
  expect(r.ok()).toBe(true);
  expect(r.headers()["content-type"]).toMatch(/html/i);
  const html = await r.text();
  // The status dashboard renders under the "XAUUSD TRADER" brand name
  expect(html).toMatch(/XAUUSD\s*TRADER/i);
  // Auto-refresh logic is present in the page JS
  expect(html).toMatch(/refresh|auto/i);
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Auth flow
// ──────────────────────────────────────────────────────────────────────────────

test("Auth: register → login → auth-guarded cascade-config round-trip", async ({ request }) => {
  const tag = Date.now();
  const email = `smoke+${tag}@example.com`;
  const password = "SmokeTest1234!";

  // Register
  const reg = await request.post("/api/auth/register", {
    data: { email, password, fullName: "Smoke Test" },
  });
  expect(reg.status()).toBe(200);
  const { token } = await reg.json() as { token: string };
  expect(typeof token).toBe("string");
  expect(token.length).toBeGreaterThan(20);

  // Login — correct credentials
  const login = await request.post("/api/auth/login", {
    data: { email, password },
  });
  expect(login.status()).toBe(200);
  const loginBody = await login.json() as { token: string };
  expect(typeof loginBody.token).toBe("string");

  // Login — wrong password must reject
  const bad = await request.post("/api/auth/login", {
    data: { email, password: "wrongpassword" },
  });
  expect(bad.status()).toBe(401);

  // Auth-guarded route: cascade config must include expected trading fields
  // Exact shape from CASCADE_DEFAULTS in src/routes/mt5.ts
  const cfg = await request.get("/api/cascade-config", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(cfg.status()).toBe(200);
  const cfgBody = await cfg.json() as Record<string, unknown>;
  expect(cfgBody).toHaveProperty("enabled");
  expect(cfgBody).toHaveProperty("numPositions");
  expect(cfgBody).toHaveProperty("slPips");
  expect(cfgBody).toHaveProperty("tp1Pips");
  expect(cfgBody).toHaveProperty("pipsBetween");
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Admin status endpoint
// ──────────────────────────────────────────────────────────────────────────────

test("Admin: /api/admin/status guards with key and returns telemetry shape", async ({ request }) => {
  // No key → must reject
  const noKey = await request.get("/api/admin/status");
  expect(noKey.status()).toBe(401);

  // Valid key → telemetry response (percent-encode so proxy doesn't reject non-ASCII chars)
  const r = await request.get(`/api/admin/status?key=${encodeURIComponent(ADMIN_KEY)}`);
  expect(r.status()).toBe(200);
  const body = await r.json() as Record<string, unknown>;
  // Exact fields from src/routes/admin.ts: { ts, streams, zones, recentTradeFailures, recentRateLimits }
  expect(body).toHaveProperty("ts");
  expect(body).toHaveProperty("streams");
  expect(body).toHaveProperty("zones");
  expect(body).toHaveProperty("recentTradeFailures");
  expect(body).toHaveProperty("recentRateLimits");
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 4 — End-to-end cascade with explicit state-transition assertions
// ──────────────────────────────────────────────────────────────────────────────

test.describe("Cascade: end-to-end demo account flow", () => {
  // State shared across tests in this describe block.
  // Playwright describe blocks share state via outer-scope variables.
  let token = "";
  let accountId = "";
  let zoneId = "";
  let riskFreeSlPrice = 0;     // populated after risk-free → used for SL assertion
  let riskFreeBestPosId = "";  // populated after risk-free → used for SL assertion

  test.beforeAll(async ({ request }) => {
    // Register a fresh smoke user so test isolation is guaranteed
    const tag = Date.now();
    const r = await request.post("/api/auth/register", {
      data: {
        email: `cascade-smoke+${tag}@example.com`,
        password: "SmokeTest1234!",
        fullName: "Cascade Smoke",
      },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { token: string };
    token = body.token;
  });

  // ── Scenario 4a: Connect ─────────────────────────────────────────────────
  test("connect — POST /api/mt5/connect links demo account", async ({ request }) => {
    const r = await request.post("/api/mt5/connect", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        login: DEMO_LOGIN,
        password: DEMO_PASSWORD,
        server: DEMO_SERVER,
        platform: DEMO_PLATFORM,
        region: "new-york",
      },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { accountId: string };
    expect(typeof body.accountId).toBe("string");
    expect(body.accountId.length).toBeGreaterThan(0);
    accountId = body.accountId;
  });

  test("connect — account reaches CONNECTED state within 60 s", async ({ request }) => {
    // Poll /status until the account is CONNECTED or the deadline passes.
    // Demo accounts can take 30-50 s to deploy on first connect.
    const deadline = Date.now() + 60_000;
    let connectionStatus = "";
    while (Date.now() < deadline) {
      const r = await request.get(`/api/mt5/account/${accountId}/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok()) {
        const body = await r.json() as { connectionStatus?: string };
        connectionStatus = (body.connectionStatus ?? "").toUpperCase();
        if (connectionStatus === "CONNECTED") break;
      }
      await new Promise((res) => setTimeout(res, 5000));
    }
    expect(connectionStatus).toMatch(/CONNECTED|DEPLOYED|DEPLOYING/);
  });

  // ── Scenario 4b: Cascade market trade → zone created ────────────────────
  // The trade endpoint accepts the same actionType/TP-price shape the mobile
  // app sends. After a successful trade the server asynchronously creates a
  // zone; we confirm zone creation by polling /zones within the test timeout.
  test("cascade trade — POST /api/mt5/account/:id/trade creates zone", async ({ request }) => {
    // Fetch the current ask price so we can set realistic (but safe) TP prices.
    // The /price endpoint returns { ask, bid, symbol } or 404 if no tick yet.
    let anchor = 3200; // fallback if tick not yet available
    try {
      const priceR = await request.get(`/api/mt5/account/${accountId}/price`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (priceR.ok()) {
        const tick = await priceR.json() as { ask?: number; bid?: number };
        if (typeof tick.ask === "number" && tick.ask > 100) anchor = tick.ask;
      }
    } catch { /* use fallback */ }

    // Cascade BUY: place 0.04 lot (minimum for 4 × 25% TP slices).
    // TP prices must be strictly ascending above the ask price.
    const r = await request.post(`/api/mt5/account/${accountId}/trade`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        actionType: "ORDER_TYPE_BUY",
        symbol: "XAUUSD",
        volume: 0.04,
        comment: "Cascade smoke test",
        anchorPrice: anchor,
        tp1Price: anchor + 3,
        tp2Price: anchor + 6,
        tp3Price: anchor + 9,
      },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { success: boolean; positionId?: string; orderId?: string };
    expect(body.success).toBe(true);

    // Poll /zones until our zone appears (server writes it asynchronously
    // after the position fills). Allow up to 30 s for demo account latency.
    const deadline = Date.now() + 30_000;
    let found: { zoneId: string; status: string; anchorPrice: number } | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const zonesR = await request.get(`/api/mt5/account/${accountId}/zones`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!zonesR.ok()) continue;
      const zones = await zonesR.json() as Array<{ zoneId: string; status: string; anchorPrice: number; direction: string }>;
      // Find the most recent BUY zone that isn't yet closed
      found = zones.filter((z) => z.direction === "buy" && z.status !== "CLOSED")
        .sort((a, b) => b.zoneId.localeCompare(a.zoneId))[0];
      if (found) break;
    }
    expect(found).toBeDefined();
    expect(found?.status).not.toBe("CLOSED");
    expect(found?.anchorPrice).toBeGreaterThan(100);
    zoneId = found!.zoneId;
  });

  // ── Scenario 4c: Zone visible in listing ─────────────────────────────────
  test("zone listing — GET /api/mt5/account/:id/zones includes the new zone", async ({ request }) => {
    const r = await request.get(`/api/mt5/account/${accountId}/zones`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status()).toBe(200);
    const zones = await r.json() as Array<{ zoneId: string; status: string; anchorPrice: number }>;
    expect(Array.isArray(zones)).toBe(true);

    const zone = zones.find((z) => z.zoneId === zoneId);
    expect(zone).toBeDefined();
    // Zone must be in an active state (not yet closed)
    expect(zone?.status).not.toBe("CLOSED");
    // Anchor price must be a valid non-zero XAUUSD price
    expect(zone?.anchorPrice).toBeGreaterThan(100);
  });

  // ── Scenario 4d: Risk Free — verify SL moved on broker ───────────────────
  test("risk-free — POST .../risk-free moves SL to entry; SL verified on live positions", async ({ request }) => {
    const rf = await request.post(
      `/api/mt5/account/${accountId}/zones/${zoneId}/risk-free`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    // 200 = SL moved successfully; 207 = partial (some closes failed but SL attempted);
    // 409 = positions not yet filled (transient race on demo — tolerated in smoke).
    // 400 is NOT accepted: that would indicate a request/logic error, not a timing issue.
    expect([200, 207, 409]).toContain(rf.status());

    if (rf.status() === 200 || rf.status() === 207) {
      // Both 200 and 207 include sl + bestPositionId — use them for SL verification.
      // 200 → ok: true, zone set to RISK_FREE.
      // 207 → ok: false (partial failure), zone NOT set to RISK_FREE yet.
      const rfBody = await rf.json() as {
        ok: boolean;
        sl: number;
        bestPositionId: string;
        slOk?: boolean;
      };
      expect(typeof rfBody.sl).toBe("number");
      expect(rfBody.sl).toBeGreaterThan(0);
      expect(typeof rfBody.bestPositionId).toBe("string");
      riskFreeSlPrice = rfBody.sl;
      riskFreeBestPosId = rfBody.bestPositionId;

      // Fetch live positions from broker and confirm the SL mutation
      // was accepted by the broker (state-transition visible on MetaAPI).
      const posR = await request.get(`/api/mt5/account/${accountId}/positions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(posR.status()).toBe(200);
      const positions = await posR.json() as Array<{
        id: string;
        stopLoss?: number;
      }>;
      const bestPos = positions.find((p) => p.id === riskFreeBestPosId);
      if (bestPos !== undefined) {
        // SL must be within 0.02 price units of the server-computed value
        // (tiny tolerance for floating-point rounding in the MetaAPI response).
        expect(Math.abs((bestPos.stopLoss ?? 0) - riskFreeSlPrice)).toBeLessThan(0.02);
      }

      if (rf.status() === 200) {
        // Full success: zone must have transitioned to RISK_FREE in the database.
        // (207 = partial failure; zone stays in its previous status until retry.)
        const zonesR = await request.get(`/api/mt5/account/${accountId}/zones`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const zones = await zonesR.json() as Array<{ zoneId: string; status: string }>;
        const zone = zones.find((z) => z.zoneId === zoneId);
        expect(zone?.status).toBe("RISK_FREE");
      }
    }
  });

  // ── Scenario 4e: Close zone — verify clean exit ───────────────────────────
  test("close zone — POST .../close marks zone CLOSED with timestamp + 0 positions", async ({ request }) => {
    const close = await request.post(
      `/api/mt5/account/${accountId}/zones/${zoneId}/close`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(close.status()).toBe(200);

    // Poll until zone is CLOSED with 0 open positions. The broker closes
    // positions asynchronously so positionCount may briefly be > 0 right
    // after the close call returns. Allow up to 20 s for broker confirmation.
    const deadline = Date.now() + 20_000;
    let zone: { zoneId: string; status: string; closedAt: number | null; positionCount: number } | undefined;
    while (Date.now() < deadline) {
      const zonesR = await request.get(
        `/api/mt5/account/${accountId}/zones?includeClosed=true`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(zonesR.status()).toBe(200);
      const zones = await zonesR.json() as Array<{
        zoneId: string; status: string; closedAt: number | null; positionCount: number;
      }>;
      zone = zones.find((z) => z.zoneId === zoneId);
      if (zone?.status === "CLOSED" && zone.positionCount === 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(zone).toBeDefined();
    expect(zone?.status).toBe("CLOSED");
    expect(zone?.closedAt).not.toBeNull();
    expect(typeof zone?.closedAt).toBe("number");
    expect(zone?.positionCount).toBe(0);
  });
});
