/**
 * API Smoke Tests
 *
 * Runs against a live server to verify critical endpoints before each deploy.
 * Set SMOKE_BASE_URL to the server origin to activate:
 *
 *   SMOKE_BASE_URL=https://meta-trader-link.replit.app \
 *     pnpm --filter @workspace/api-server run smoke
 *
 * For the full end-to-end cascade scenario, also supply demo MT5 credentials:
 *   DEMO_MT5_LOGIN     — MT5 account login number
 *   DEMO_MT5_PASSWORD  — MT5 account password
 *   DEMO_MT5_SERVER    — MT5 broker server name (e.g. "MetaQuotes-Demo")
 *   DEMO_MT5_PLATFORM  — "mt5" (default) or "mt4"
 *
 * When SMOKE_BASE_URL is absent every describe block is skipped automatically,
 * so `pnpm test` stays green in environments without a live server.
 */

import { describe, it, expect, beforeAll } from "vitest";

const BASE = (process.env.SMOKE_BASE_URL ?? "").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";

const DEMO_LOGIN = process.env.DEMO_MT5_LOGIN ?? "";
const DEMO_PASSWORD = process.env.DEMO_MT5_PASSWORD ?? "";
const DEMO_SERVER = process.env.DEMO_MT5_SERVER ?? "";
const DEMO_PLATFORM = process.env.DEMO_MT5_PLATFORM ?? "mt5";

const hasDemoAccount = Boolean(DEMO_LOGIN && DEMO_PASSWORD && DEMO_SERVER);

async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Public endpoints
// ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(!BASE)("Smoke — public endpoints", () => {
  it("GET /healthz → 200 {status:'ok'}", async () => {
    const r = await api("/healthz");
    expect(r.status).toBe(200);
    const body = await r.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("GET /status → 200 HTML auto-refresh dashboard", async () => {
    const r = await api("/status");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") ?? "").toMatch(/html/i);
    const html = await r.text();
    expect(html).toMatch(/MT5 Trader/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Auth flow
// ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(!BASE)("Smoke — auth flow", () => {
  const tag = Date.now();
  const email = `smoke+${tag}@example.com`;
  const password = "SmokeTest1234!";
  let token = "";

  it("POST /api/auth/register creates a new account", async () => {
    const r = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, fullName: "Smoke Test" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { token: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(10);
    token = body.token;
  });

  it("POST /api/auth/login with correct credentials returns token", async () => {
    const r = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { token: string };
    expect(typeof body.token).toBe("string");
  });

  it("POST /api/auth/login with wrong password → 401", async () => {
    const r = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: "wrongpassword" }),
    });
    expect(r.status).toBe(401);
  });

  it("GET /api/cascade-config with auth returns config object", async () => {
    const r = await api("/api/cascade-config", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body).toHaveProperty("lots");
    expect(body).toHaveProperty("tpLevels");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Admin status
// ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(!BASE || !ADMIN_KEY)("Smoke — admin status endpoint", () => {
  it("GET /api/admin/status?key=<ADMIN_KEY> returns telemetry", async () => {
    const r = await api(`/api/admin/status?key=${ADMIN_KEY}`);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body).toHaveProperty("accounts");
    expect(body).toHaveProperty("recentEvents");
  });

  it("GET /api/admin/status without key → 401", async () => {
    const r = await api("/api/admin/status");
    expect(r.status).toBe(401);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. Full cascade flow (skipped unless DEMO_MT5_* credentials are set)
// ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(!BASE || !hasDemoAccount)(
  "Smoke — end-to-end cascade (demo account)",
  () => {
    let token = "";
    let accountId = "";
    let zoneId = "";

    beforeAll(async () => {
      const tag = Date.now();
      const r = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: `cascade-smoke+${tag}@example.com`,
          password: "SmokeTest1234!",
          fullName: "Cascade Smoke",
        }),
      });
      const body = await r.json() as { token: string };
      token = body.token;
    });

    it(
      "POST /api/mt5/connect links demo account and returns accountId",
      async () => {
        const r = await api("/api/mt5/connect", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            login: DEMO_LOGIN,
            password: DEMO_PASSWORD,
            serverName: DEMO_SERVER,
            platform: DEMO_PLATFORM,
            region: "new-york",
          }),
        });
        expect(r.status).toBe(200);
        const body = await r.json() as { accountId: string };
        expect(typeof body.accountId).toBe("string");
        expect(body.accountId.length).toBeGreaterThan(0);
        accountId = body.accountId;
      },
      90_000,
    );

    it(
      "GET /api/mt5/account/:id/status shows account is connected",
      async () => {
        expect(accountId).toBeTruthy();
        const r = await api(`/api/mt5/account/${accountId}/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json() as { connectionStatus: string };
        expect(
          ["deployed", "connected", "CONNECTED", "DEPLOYING"].some((s) =>
            body.connectionStatus?.toUpperCase().includes(s.toUpperCase()),
          ),
        ).toBe(true);
      },
      60_000,
    );

    it(
      "POST /api/mt5/account/:id/trade places cascade zone (market buy)",
      async () => {
        expect(accountId).toBeTruthy();
        const r = await api(`/api/mt5/account/${accountId}/trade`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            type: "market",
            symbol: "XAUUSD",
            direction: "buy",
          }),
        });
        expect(r.status).toBe(200);
        const body = await r.json() as { zoneId: string };
        expect(typeof body.zoneId).toBe("string");
        zoneId = body.zoneId;
      },
      60_000,
    );

    it(
      "GET /api/mt5/account/:id/zones lists the newly created zone",
      async () => {
        expect(accountId && zoneId).toBeTruthy();
        const r = await api(`/api/mt5/account/${accountId}/zones`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        const body = await r.json() as { zones: Array<{ id: string }> };
        expect(Array.isArray(body.zones)).toBe(true);
        const zone = body.zones.find((z) => z.id === zoneId);
        expect(zone).toBeDefined();
      },
      30_000,
    );

    it(
      "POST /api/mt5/account/:id/zones/:zoneId/risk-free moves SL to BE",
      async () => {
        expect(accountId && zoneId).toBeTruthy();
        const r = await api(
          `/api/mt5/account/${accountId}/zones/${zoneId}/risk-free`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        // 200 = SL moved; 400 = price not far enough (acceptable in smoke)
        expect([200, 400]).toContain(r.status);
      },
      30_000,
    );

    it(
      "POST /api/mt5/account/:id/zones/:zoneId/close exits the zone cleanly",
      async () => {
        expect(accountId && zoneId).toBeTruthy();
        const r = await api(
          `/api/mt5/account/${accountId}/zones/${zoneId}/close`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        expect(r.status).toBe(200);
      },
      60_000,
    );
  },
);
