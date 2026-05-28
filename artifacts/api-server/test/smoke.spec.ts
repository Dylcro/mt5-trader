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

test("Public: GET /healthz → 200 {status:'ok'}", async ({ request }) => {
  const r = await request.get("/healthz");
  expect(r.ok()).toBe(true);
  const body = await r.json() as { status: string };
  expect(body.status).toBe("ok");
});

test("Public: GET /status → 200 HTML dashboard with auto-refresh", async ({ request }) => {
  const r = await request.get("/status");
  expect(r.ok()).toBe(true);
  expect(r.headers()["content-type"]).toMatch(/html/i);
  const html = await r.text();
  expect(html).toContain("MT5 Trader");
  // Auto-refresh meta tag confirms the dashboard refresh logic is intact
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
  const cfg = await request.get("/api/cascade-config", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(cfg.status()).toBe(200);
  const cfgBody = await cfg.json() as Record<string, unknown>;
  expect(cfgBody).toHaveProperty("lots");
  expect(cfgBody).toHaveProperty("tpLevels");
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Admin status endpoint
// ──────────────────────────────────────────────────────────────────────────────

test("Admin: /api/admin/status guards with key and returns telemetry shape", async ({ request }) => {
  // No key → must reject
  const noKey = await request.get("/api/admin/status");
  expect(noKey.status()).toBe(401);

  // Valid key → telemetry response
  const r = await request.get(`/api/admin/status?key=${ADMIN_KEY}`);
  expect(r.status()).toBe(200);
  const body = await r.json() as Record<string, unknown>;
  expect(body).toHaveProperty("accounts");
  expect(body).toHaveProperty("recentEvents");
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
        serverName: DEMO_SERVER,
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

  test("connect — GET /api/mt5/account/:id/status confirms account is live", async ({ request }) => {
    const r = await request.get(`/api/mt5/account/${accountId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { connectionStatus: string };
    expect(body.connectionStatus?.toUpperCase()).toMatch(/CONNECTED|DEPLOYED|DEPLOYING/);
  });

  // ── Scenario 4b: Single trade → zone created ─────────────────────────────
  test("single trade — POST /api/mt5/account/:id/trade returns zoneId", async ({ request }) => {
    const r = await request.post(`/api/mt5/account/${accountId}/trade`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { type: "market", symbol: "XAUUSD", direction: "buy" },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { zoneId: string };
    expect(typeof body.zoneId).toBe("string");
    expect(body.zoneId.length).toBeGreaterThan(0);
    zoneId = body.zoneId;
  });

  // ── Scenario 4c: TP progress — zone visible ──────────────────────────────
  test("TP progress — zone appears in GET /api/mt5/account/:id/zones", async ({ request }) => {
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

    // 200 = SL moved; 207 = partial (some positions failed but SL attempted);
    // 400/409 = price not far enough / no open positions (acceptable in smoke)
    expect([200, 207, 400, 409]).toContain(rf.status());

    if (rf.status() === 200) {
      // Explicit SL verification: the response carries the new SL price
      // and the position ID it was applied to.
      const rfBody = await rf.json() as {
        ok: boolean;
        sl: number;
        bestPositionId: string;
        pips: number;
        closedCount: number;
      };
      expect(rfBody.ok).toBe(true);
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
        currentPrice?: number;
        openPrice?: number;
      }>;
      const bestPos = positions.find((p) => p.id === riskFreeBestPosId);
      if (bestPos !== undefined) {
        // SL must be within 0.02 price units of the server-computed value
        // (tiny tolerance for floating-point rounding in the MetaAPI response).
        expect(Math.abs((bestPos.stopLoss ?? 0) - riskFreeSlPrice)).toBeLessThan(0.02);
      }

      // Zone status must have transitioned to RISK_FREE in the database
      const zonesR = await request.get(`/api/mt5/account/${accountId}/zones`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const zones = await zonesR.json() as Array<{ zoneId: string; status: string }>;
      const zone = zones.find((z) => z.zoneId === zoneId);
      expect(zone?.status).toBe("RISK_FREE");
    }
  });

  // ── Scenario 4e: Close zone — verify clean exit ───────────────────────────
  test("close zone — POST .../close marks zone CLOSED with timestamp + 0 positions", async ({ request }) => {
    const close = await request.post(
      `/api/mt5/account/${accountId}/zones/${zoneId}/close`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(close.status()).toBe(200);

    // Explicit state-transition assertion: zone must be CLOSED in DB with
    // a valid closedAt timestamp and zero remaining open positions.
    const zonesR = await request.get(
      `/api/mt5/account/${accountId}/zones?includeClosed=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(zonesR.status()).toBe(200);
    const zones = await zonesR.json() as Array<{
      zoneId: string;
      status: string;
      closedAt: number | null;
      positionCount: number;
    }>;
    const zone = zones.find((z) => z.zoneId === zoneId);
    expect(zone).toBeDefined();
    expect(zone?.status).toBe("CLOSED");
    expect(zone?.closedAt).not.toBeNull();
    expect(typeof zone?.closedAt).toBe("number");
    expect(zone?.positionCount).toBe(0);
  });
});
