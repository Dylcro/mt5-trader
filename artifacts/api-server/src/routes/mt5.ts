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
  _id?: string;
  login?: string;
  server?: string;
  region?: string;
  connectionStatus?: string;
  state?: string;
  message?: string;
  reliability?: string;
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
      // Reconnect by stored MetaAPI account ID
      accountId = existingId;
      const acct = await getProvisioningAccount(token, accountId).catch(() => null);
      if (!acct) {
        return res.status(404).json({ error: "Account not found on MetaAPI. Please log in again with your credentials." });
      }
      region = acct.region ?? DEFAULT_REGION;
      if (acct.connectionStatus !== "CONNECTED") {
        await deployAccount(token, accountId);
        const connected = await waitForConnection(token, accountId);
        if (!connected) {
          return res.status(503).json({ error: "Could not connect to MT5 account. Check broker server availability." });
        }
      }
    } else {
      // Login with credentials — check if account already provisioned on MetaAPI
      if (!login || !password || !server) {
        return res.status(400).json({ error: "login, password and server are required." });
      }

      // Look up existing MetaAPI accounts for this login+server
      const listRes = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
        headers: authHeaders(token),
      });
      const allAccounts = listRes.ok
        ? (await listRes.json() as ProvisioningAccount[])
        : [];
      const existing = Array.isArray(allAccounts)
        ? allAccounts.find((a) => a.login === login && a.server === server)
        : undefined;
      const existingId = existing?._id ?? existing?.id;

      if (existing && existingId) {
        // Reuse existing MetaAPI account — update the password in case it changed
        accountId = existingId;
        region = existing.region ?? DEFAULT_REGION;
        await fetch(`${PROVISIONING_BASE}/users/current/accounts/${accountId}`, {
          method: "PUT",
          headers: authHeaders(token),
          body: JSON.stringify({ password }),
        }).catch(() => {});
        if (existing.connectionStatus !== "CONNECTED") {
          await deployAccount(token, accountId);
          const connected = await waitForConnection(token, accountId);
          if (!connected) {
            return res.status(503).json({ error: "Could not connect to MT5 account. Check broker server availability." });
          }
        }
      } else {
        // Create a brand-new MetaAPI account
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

        let createRes = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify(createPayload),
        });

        // 202 = MetaAPI is auto-detecting broker settings — wait 70s and retry
        if (createRes.status === 202) {
          await sleep(70000);
          createRes = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
            method: "POST",
            headers: authHeaders(token),
            body: JSON.stringify(createPayload),
          });
        }

        const created = await createRes.json() as ProvisioningAccount & { error?: string; details?: string };

        if (!createRes.ok) {
          // 403 = MetaAPI billing limit
          if (createRes.status === 403) {
            return res.status(403).json({
              error: "The MetaAPI service account has reached its provisioning limit. Please top up the MetaAPI account at metaapi.cloud, then try again.",
            });
          }
          // E_AUTH = wrong login/password/server
          if (created.details === "E_AUTH" || (created.error === "ValidationError" && created.message?.includes("authenticate"))) {
            return res.status(401).json({
              error: "Invalid credentials — check your MT5 login, password, and server name.",
            });
          }
          return res.status(createRes.status).json({
            error: created.message ?? "Failed to create account. Check your login details and server name.",
          });
        }

        // Successful creation returns a UUID id, not an integer
        const newId = created._id ?? created.id;
        if (!newId || typeof newId !== "string" || newId.length < 10) {
          return res.status(500).json({ error: "Unexpected response from MetaAPI. Please try again." });
        }
        accountId = newId;
        region = created.region ?? DEFAULT_REGION;

        // Deploy and wait for connection
        await deployAccount(token, accountId);
        const connected = await waitForConnection(token, accountId);
        if (!connected) {
          await fetch(`${PROVISIONING_BASE}/users/current/accounts/${accountId}`, {
            method: "DELETE",
            headers: authHeaders(token),
          }).catch(() => {});
          return res.status(503).json({
            error: "Could not connect to MT5. Please check your credentials and server name.",
          });
        }
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

// MT5 trade return code map — https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes
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
    const data = await tradeRes.json() as { numericCode?: number; message?: string; orderId?: string; positionId?: string };
    const code = data.numericCode ?? 0;
    const success = TRADE_SUCCESS_CODES.has(code);
    const errorMessage = success
      ? undefined
      : (TRADE_ERROR_MESSAGES[code] ?? data.message ?? `Trade failed (code ${code})`);

    console.log(`[trade] accountId=${req.params.accountId} action=${(req.body as Record<string,unknown>).actionType} volume=${(req.body as Record<string,unknown>).volume} code=${code} success=${success}${!success ? ` msg="${errorMessage}"` : ""}`);

    return res.status(tradeRes.ok ? 200 : tradeRes.status).json({
      success,
      code,
      message: success ? "Trade executed successfully" : errorMessage,
      orderId: data.orderId,
      positionId: data.positionId,
    });
  } catch (err) {
    return res.status(500).json({ success: false, code: 0, message: err instanceof Error ? err.message : "Trade failed" });
  }
});

export default router;
