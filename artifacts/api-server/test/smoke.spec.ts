/**
 * MT5 Trader API — Playwright smoke suite
 *
 * Five scenarios validated against the live server before each deploy:
 *
 *   1. Public health & status dashboard
 *   2. Auth flow  (register → login → auth-guarded config)
 *   3. Admin status telemetry endpoint
 *   4. Demo cascade (connect → trade → zones visible → risk-free → close)
 *
 * Scenario 4 is automatically skipped when DEMO_MT5_* credentials are absent.
 *
 * Run:
 *   SMOKE_BASE_URL=https://meta-trader-link.replit.app \
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

test("GET /healthz → 200 {status:'ok'}", async ({ request }) => {
  const r = await request.get("/healthz");
  expect(r.ok()).toBe(true);
  const body = await r.json() as { status: string };
  expect(body.status).toBe("ok");
});

test("GET /status → 200 HTML auto-refresh dashboard", async ({ request }) => {
  const r = await request.get("/status");
  expect(r.ok()).toBe(true);
  expect(r.headers()["content-type"]).toMatch(/html/i);
  const html = await r.text();
  expect(html).toContain("MT5 Trader");
  expect(html).toContain("auto-refresh");
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Auth flow
// ──────────────────────────────────────────────────────────────────────────────

test("Auth — register → login → auth-guarded cascade-config", async ({ request }) => {
  const tag = Date.now();
  const email = `smoke+${tag}@example.com`;
  const password = "SmokeTest1234!";

  // Register
  const reg = await request.post("/api/auth/register", {
    data: { email, password, fullName: "Smoke Test" },
  });
  expect(reg.status()).toBe(200);
  const regBody = await reg.json() as { token: string };
  expect(typeof regBody.token).toBe("string");
  const token = regBody.token;

  // Login with correct credentials
  const login = await request.post("/api/auth/login", {
    data: { email, password },
  });
  expect(login.status()).toBe(200);
  const loginBody = await login.json() as { token: string };
  expect(typeof loginBody.token).toBe("string");

  // Login with wrong password → 401
  const bad = await request.post("/api/auth/login", {
    data: { email, password: "wrongpassword" },
  });
  expect(bad.status()).toBe(401);

  // Auth-guarded endpoint: cascade config
  const cfg = await request.get("/api/cascade-config", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(cfg.status()).toBe(200);
  const cfgBody = await cfg.json() as Record<string, unknown>;
  expect(cfgBody).toHaveProperty("lots");
  expect(cfgBody).toHaveProperty("tpLevels");
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Admin status
// ──────────────────────────────────────────────────────────────────────────────

test("Admin — /api/admin/status requires key and returns telemetry", async ({ request }) => {
  // No key → 401
  const noKey = await request.get("/api/admin/status");
  expect(noKey.status()).toBe(401);

  test.skip(!ADMIN_KEY, "ADMIN_KEY not set — skipping authenticated admin check");

  const r = await request.get(`/api/admin/status?key=${ADMIN_KEY}`);
  expect(r.status()).toBe(200);
  const body = await r.json() as Record<string, unknown>;
  expect(body).toHaveProperty("accounts");
  expect(body).toHaveProperty("recentEvents");
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario 4 — End-to-end cascade (demo account)
// ──────────────────────────────────────────────────────────────────────────────

test.describe("Cascade — end-to-end demo account flow", () => {
  let token = "";
  let accountId = "";
  let zoneId = "";

  test.beforeAll(async ({ request }) => {
    test.skip(
      !DEMO_LOGIN || !DEMO_PASSWORD || !DEMO_SERVER,
      "DEMO_MT5_LOGIN / DEMO_MT5_PASSWORD / DEMO_MT5_SERVER not set — cascade scenario skipped",
    );

    const tag = Date.now();
    const r = await request.post("/api/auth/register", {
      data: {
        email: `cascade-smoke+${tag}@example.com`,
        password: "SmokeTest1234!",
        fullName: "Cascade Smoke",
      },
    });
    const body = await r.json() as { token: string };
    token = body.token;
  });

  test("connect — POST /api/mt5/connect returns accountId", async ({ request }) => {
    test.skip(!DEMO_LOGIN || !DEMO_PASSWORD || !DEMO_SERVER, "demo creds absent");
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

  test("status — account shows connected after deploy", async ({ request }) => {
    test.skip(!DEMO_LOGIN || !accountId, "demo creds or accountId absent");
    const r = await request.get(`/api/mt5/account/${accountId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { connectionStatus: string };
    expect(body.connectionStatus?.toUpperCase()).toMatch(
      /CONNECTED|DEPLOYED|DEPLOYING/,
    );
  });

  test("single trade — POST /api/mt5/account/:id/trade creates cascade zone", async ({ request }) => {
    test.skip(!DEMO_LOGIN || !accountId, "demo creds or accountId absent");
    const r = await request.post(`/api/mt5/account/${accountId}/trade`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { type: "market", symbol: "XAUUSD", direction: "buy" },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { zoneId: string };
    expect(typeof body.zoneId).toBe("string");
    zoneId = body.zoneId;
  });

  test("TP progress — zone is visible in zones list", async ({ request }) => {
    test.skip(!DEMO_LOGIN || !accountId || !zoneId, "prior steps not completed");
    const r = await request.get(`/api/mt5/account/${accountId}/zones`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status()).toBe(200);
    const body = await r.json() as { zones: Array<{ id: string }> };
    expect(Array.isArray(body.zones)).toBe(true);
    const zone = body.zones.find((z) => z.id === zoneId);
    expect(zone).toBeDefined();
  });

  test("risk-free — POST .../risk-free responds (200 moved / 400 not far enough)", async ({ request }) => {
    test.skip(!DEMO_LOGIN || !accountId || !zoneId, "prior steps not completed");
    const r = await request.post(
      `/api/mt5/account/${accountId}/zones/${zoneId}/risk-free`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect([200, 400]).toContain(r.status());
  });

  test("close zone — POST .../close exits cleanly", async ({ request }) => {
    test.skip(!DEMO_LOGIN || !accountId || !zoneId, "prior steps not completed");
    const r = await request.post(
      `/api/mt5/account/${accountId}/zones/${zoneId}/close`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(r.status()).toBe(200);
  });
});
