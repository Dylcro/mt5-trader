import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

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

function clientBase(region: string = DEFAULT_REGION): string {
  return `https://mt-client-api-v1.${region}.${CLIENT_DOMAIN}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProvisioningAccount {
  id?: string;
  region?: string;
  connectionStatus?: string;
  state?: string;
  message?: string;
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

async function waitForConnection(token: string, accountId: string, timeoutMs = 90000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const data = await getProvisioningAccount(token, accountId);
      if (data.connectionStatus === "CONNECTED") return true;
      if (data.state === "DEPLOY_FAILED") return false;
    } catch {
      // ignore transient errors during polling
    }
  }
  return false;
}

async function deployAccount(token: string, accountId: string): Promise<void> {
  await fetch(`${PROVISIONING_BASE}/users/current/accounts/${accountId}/deploy`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

async function getAccountInfo(token: string, accountId: string, region: string = DEFAULT_REGION) {
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

// POST /api/mt5/connect
// Body: { login, password, server } to provision a new account
// Body: { accountId } to reconnect an existing account
router.post("/mt5/connect", async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const { login, password, server, accountId: existingId } = req.body as {
      login?: string;
      password?: string;
      server?: string;
      accountId?: string;
    };

    let accountId: string;
    let region: string = DEFAULT_REGION;

    if (existingId) {
      // Reconnect existing account — check its state and deploy if needed
      accountId = existingId;
      const status = await getProvisioningAccount(token, accountId).catch(() => null);
      if (!status) {
        return res.status(404).json({ error: "Account not found. Please log in again." });
      }
      region = status.region ?? DEFAULT_REGION;
      if (status.connectionStatus !== "CONNECTED") {
        await deployAccount(token, accountId);
        const connected = await waitForConnection(token, accountId);
        if (!connected) {
          return res.status(503).json({ error: "Could not connect to MT5 account. Check broker server availability." });
        }
      }
    } else {
      // Provision a new account
      if (!login || !password || !server) {
        return res.status(400).json({ error: "login, password and server are required." });
      }

      const createRes = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          login,
          password,
          name: `MT5 ${login}`,
          server,
          platform: "mt5",
          type: "cloud-g2",
          magic: 47182,
        }),
      });

      const created = await createRes.json() as ProvisioningAccount;
      if (!createRes.ok || !created.id) {
        return res.status(createRes.status).json({
          error: created.message ?? "Failed to create account. Check your login details and server name.",
        });
      }
      accountId = created.id;
      region = created.region ?? DEFAULT_REGION;

      // Deploy the account and wait for connection
      await deployAccount(token, accountId);
      const connected = await waitForConnection(token, accountId);
      if (!connected) {
        // Clean up on failure
        await fetch(`${PROVISIONING_BASE}/users/current/accounts/${accountId}`, {
          method: "DELETE",
          headers: authHeaders(token),
        }).catch(() => {});
        return res.status(503).json({
          error: "Could not connect to MT5. Please check your credentials and server name.",
        });
      }
    }

    // Fetch account info using the correct regional client URL
    const info = await getAccountInfo(token, accountId, region) as {
      balance?: number;
      equity?: number;
      margin?: number;
      freeMargin?: number;
      currency?: string;
      leverage?: number;
      name?: string;
    };

    return res.json({
      accountId,
      region,
      name: info.name ?? `Account ${accountId.slice(0, 6)}`,
      balance: info.balance ?? 0,
      equity: info.equity ?? 0,
      margin: info.margin ?? 0,
      freeMargin: info.freeMargin ?? 0,
      currency: info.currency ?? "USD",
      leverage: info.leverage ?? 100,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return res.status(500).json({ error: message });
  }
});

// POST /api/mt5/account/:accountId/disconnect
router.post("/mt5/account/:accountId/disconnect", async (req: Request, res: Response) => {
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
router.get("/mt5/account/:accountId/info", async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = (req.query.region as string) || DEFAULT_REGION;
    const info = await getAccountInfo(token, req.params.accountId, region);
    return res.json(info);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /api/mt5/account/:accountId/price?region=london
router.get("/mt5/account/:accountId/price", async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = (req.query.region as string) || DEFAULT_REGION;
    const priceRes = await fetch(
      `${clientBase(region)}/users/current/accounts/${req.params.accountId}/symbols/XAUUSD/current-price`,
      { headers: authHeaders(token) }
    );
    if (!priceRes.ok) return res.status(priceRes.status).json({ error: "Price fetch failed" });
    return res.json(await priceRes.json());
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Failed" });
  }
});

// GET /api/mt5/account/:accountId/positions?region=london
router.get("/mt5/account/:accountId/positions", async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = (req.query.region as string) || DEFAULT_REGION;
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

// POST /api/mt5/account/:accountId/trade?region=london
router.post("/mt5/account/:accountId/trade", async (req: Request, res: Response) => {
  try {
    const token = getToken();
    const region = (req.query.region as string) || DEFAULT_REGION;
    const tradeRes = await fetch(
      `${clientBase(region)}/users/current/accounts/${req.params.accountId}/trade`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(req.body),
      }
    );
    const data = await tradeRes.json();
    return res.status(tradeRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Trade failed" });
  }
});

export default router;
