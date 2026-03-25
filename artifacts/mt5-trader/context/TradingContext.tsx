import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// Parse JSON safely — throws a user-readable error instead of a raw SyntaxError
// when the server returns HTML, a blank body, or any other non-JSON response.
async function safeJson<T>(res: Response, context = "Server"): Promise<T> {
  const text = await res.text().catch(() => "");
  // HTML response means the proxy/server isn't ready — give a clearer message
  if (text.trimStart().startsWith("<")) {
    throw new Error(`${context}: server not ready (HTTP ${res.status}). Please try again.`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new Error(
      `${context} returned an unexpected response (HTTP ${res.status})${preview ? `: ${preview}` : ""}. Please try again.`
    );
  }
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface AccountInfo {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  currency: string;
  leverage: number;
  name: string;
}

export interface Position {
  id: string;
  symbol: string;
  type: "POSITION_TYPE_BUY" | "POSITION_TYPE_SELL";
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  profit: number;
  time: string;
  comment?: string;
}

export interface PendingOrder {
  id: string;
  symbol: string;
  type: "ORDER_TYPE_BUY_LIMIT" | "ORDER_TYPE_SELL_LIMIT" | "ORDER_TYPE_BUY_STOP" | "ORDER_TYPE_SELL_STOP" | string;
  volume: number;
  openPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  time: string;
}

export interface Price {
  bid: number;
  ask: number;
  spread: number;
  time: string;
  stale?: boolean; // true when price comes from server-side cache (MetaAPI momentarily slow)
}

export type SLMode = "points" | "percent" | "manual";

export interface Mt5Credentials {
  login: string;
  password: string;
  server: string;
}

interface TradingContextValue {
  accountId: string;
  apiBase: string;
  region: string;
  credentials: Mt5Credentials;
  setCredentials: (c: Mt5Credentials) => void;
  status: ConnectionStatus;
  errorMsg: string;
  accountInfo: AccountInfo | null;
  positions: Position[];
  pendingOrders: PendingOrder[];
  price: Price | null;
  priceError: boolean;
  connect: (creds?: Mt5Credentials) => Promise<void>;
  disconnect: () => Promise<void>;
  placeTrade: (params: PlaceTradeParams) => Promise<{ success: boolean; message: string }>;
  placeCascadeOrders: (params: CascadeOrderParams) => Promise<{ success: boolean; placed: number; failed: number; message: string; marketPositionId?: string; limitOrderIds?: string[] }>;
  closePosition: (positionId: string) => Promise<{ success: boolean; message: string }>;
  cancelOrder: (orderId: string) => Promise<{ success: boolean; message: string }>;
  refreshPositions: () => Promise<void>;
  refreshPendingOrders: () => Promise<void>;
  refreshPrice: () => Promise<void>;
  refreshAccountInfo: () => Promise<void>;
  redeployAccount: () => Promise<void>;
}

export interface PlaceTradeParams {
  direction: "buy" | "sell";
  volume: number;
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  limitPrice?: number;
}

export interface CascadeOrderParams {
  direction: "buy" | "sell";
  volume: number;
  limitEntries: number[];
  stopLoss: number;
}

// Determine the API base URL.
// EXPO_PUBLIC_API_URL is the full URL: https://<domain>/api
// Fall back to deriving from Constants.expoConfig hostUri (strips expo. subdomain)
function resolveApiBase(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  if (process.env.EXPO_PUBLIC_DOMAIN) return `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`;
  // Dynamic fallback: derive standard domain from expo packager host
  const hostUri = (Constants.expoConfig as { hostUri?: string } | null)?.hostUri;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    const apiHost = host.replace(".expo.spock.", ".spock.");
    return `https://${apiHost}/api`;
  }
  return "/api";
}

const API_BASE = resolveApiBase();
console.log("[API] base:", API_BASE);

const DEFAULT_REGION = "london";

const TradingContext = createContext<TradingContextValue | null>(null);

export function TradingProvider({ children }: { children: React.ReactNode }) {
  const [accountId, setAccountIdState] = useState("");
  const [region, setRegionState] = useState(DEFAULT_REGION);
  const [credentials, setCredentialsState] = useState<Mt5Credentials>({
    login: "",
    password: "",
    server: "",
  });
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [errorMsg, setErrorMsg] = useState("");
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [price, setPrice] = useState<Price | null>(null);
  const [priceError, setPriceError] = useState(false);

  const priceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const positionsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const priceFailCountRef = useRef(0);
  const startPollingRef = useRef<((accId: string, accRegion: string) => void) | null>(null);
  const reconnectInProgressRef = useRef(false);


  // Load saved credentials + accountId on startup and auto-reconnect
  useEffect(() => {
    AsyncStorage.multiGet(["mt5_login", "mt5_server", "mt5_account_id", "mt5_region"]).then((pairs) => {
      const login = pairs[0][1] ?? "";
      const server = pairs[1][1] ?? "";
      const savedAccountId = pairs[2][1] ?? "";
      const savedRegion = pairs[3][1] ?? DEFAULT_REGION;
      if (login) setCredentialsState((prev) => ({ ...prev, login, server }));
      if (savedAccountId) {
        setAccountIdState(savedAccountId);
        setRegionState(savedRegion);
        // Auto-reconnect silently — guard prevents double-fire from React StrictMode
        if (!reconnectInProgressRef.current) {
          reconnectInProgressRef.current = true;
          reconnectSaved(savedAccountId).finally(() => { reconnectInProgressRef.current = false; });
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll /status until CONNECTED, then finalise the session
  const pollUntilConnected = useCallback(async (accId: string, accRegion: string, maxWaitMs = 120000) => {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const r = await fetch(`${API_BASE}/mt5/account/${accId}/status?region=${accRegion}`);
        const d = await safeJson<{
          connectionStatus?: string;
          error?: string;
          accountId?: string;
          region?: string;
        } & Partial<AccountInfo>>(r, "Status endpoint");
        if (!r.ok && d.error) throw new Error(d.error);
        if (d.connectionStatus === "CONNECTED") {
          const finalRegion = d.region ?? accRegion;
          setAccountIdState(accId);
          setRegionState(finalRegion);
          await AsyncStorage.multiSet([["mt5_account_id", accId], ["mt5_region", finalRegion]]);
          setAccountInfo({
            balance: d.balance ?? 0,
            equity: d.equity ?? 0,
            margin: d.margin ?? 0,
            freeMargin: d.freeMargin ?? 0,
            currency: d.currency ?? "USD",
            leverage: d.leverage ?? 100,
            name: d.name ?? "Account",
          });
          setStatus("connected");
          startPollingRef.current?.(accId, finalRegion);
          return;
        }
        if (d.connectionStatus === "DEPLOY_FAILED") throw new Error(d.error ?? "Connection failed. Check your credentials and server.");
      } catch (err) {
        throw err;
      }
    }
    throw new Error("Connection timed out. Please try again.");
  }, []);

  const reconnectSaved = async (savedId: string) => {
    setStatus("connecting");

    // Retry up to 3× — handles the race where the API server is still starting
    // when the app opens (proxy returns HTML 404 for a brief moment).
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Small backoff between retries so the server has time to finish starting
        if (attempt > 1) await new Promise((r) => setTimeout(r, 2000 * attempt));

        const res = await fetch(`${API_BASE}/mt5/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: savedId }),
          signal: AbortSignal.timeout(15000),
        });

        // If the proxy returned HTML (server not ready yet), treat as transient
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          const preview = (await res.text()).slice(0, 60);
          console.warn(`[reconnect] attempt ${attempt}: non-JSON response (${res.status}): ${preview}`);
          if (attempt < MAX_ATTEMPTS) continue;
          // All retries exhausted and the server is unreachable — go to
          // disconnected so the user can connect manually without an error banner.
          console.warn("[reconnect] giving up after non-JSON response — falling back to disconnected");
          setStatus("disconnected");
          return;
        }

        const data = await safeJson<{
          status?: string;
          error?: string;
          accountId?: string;
          region?: string;
        } & Partial<AccountInfo>>(res, "Connect endpoint");

        // 404 JSON = account deleted on MetaAPI side — clear storage, let user log in fresh
        if (res.status === 404) {
          setStatus("disconnected");
          setAccountIdState("");
          await AsyncStorage.removeItem("mt5_account_id");
          return;
        }
        if (!res.ok || data.error) throw new Error(data.error ?? "Reconnect failed");

        const accId = data.accountId ?? savedId;
        const accRegion = data.region ?? DEFAULT_REGION;

        if (data.status === "connected") {
          setAccountIdState(accId);
          setRegionState(accRegion);
          await AsyncStorage.setItem("mt5_region", accRegion);
          setAccountInfo({
            balance: data.balance ?? 0, equity: data.equity ?? 0,
            margin: data.margin ?? 0, freeMargin: data.freeMargin ?? 0,
            currency: data.currency ?? "USD", leverage: data.leverage ?? 100,
            name: data.name ?? "Account",
          });
          setStatus("connected");
          startPolling(accId, accRegion);
        } else {
          // status === "deploying" — poll
          await pollUntilConnected(accId, accRegion);
        }
        return; // success — exit retry loop
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Reconnect failed";
        console.warn(`[reconnect] attempt ${attempt} error: ${msg}`);
        if (attempt === MAX_ATTEMPTS) {
          // All retries failed. Fall back to disconnected silently — the user
          // can tap Connect manually. Only show a real error if the API gave
          // us a meaningful message (not a generic network/HTML error).
          const isNetworkError = msg.includes("server not ready") || msg.includes("Network") || msg.includes("unexpected response");
          if (isNetworkError) {
            console.warn("[reconnect] network error on all attempts — falling back to disconnected");
            setStatus("disconnected");
          } else {
            setErrorMsg(msg);
            setStatus("error");
          }
        }
      }
    }
  };

  const setCredentials = useCallback((c: Mt5Credentials) => {
    setCredentialsState(c);
    AsyncStorage.multiSet([
      ["mt5_login", c.login],
      ["mt5_server", c.server],
    ]);
  }, []);

  const fetchPriceData = useCallback(async (accId: string, accRegion: string): Promise<Price> => {
    const res = await fetch(
      `${API_BASE}/mt5/account/${accId}/price?region=${accRegion}`,
      { signal: AbortSignal.timeout(9000) },
    );
    if (!res.ok) throw new Error(`Price fetch failed: ${res.status}`);
    const data = await res.json() as { bid?: number; ask?: number; time?: string; stale?: boolean };
    const bid = data.bid ?? 0;
    const ask = data.ask ?? 0;
    return {
      bid,
      ask,
      spread: Math.round((ask - bid) * 10),
      time: data.time ?? new Date().toISOString(),
      stale: data.stale ?? false,
    };
  }, []);

  const fetchPositionsData = useCallback(async (accId: string, accRegion: string): Promise<Position[]> => {
    const res = await fetch(`${API_BASE}/mt5/account/${accId}/positions?region=${accRegion}`);
    if (!res.ok) throw new Error(`Positions fetch failed: ${res.status}`);
    const data = await res.json() as unknown[];
    return (Array.isArray(data) ? data : []).map((p) => {
      const pos = p as Record<string, unknown>;
      return {
        id: String(pos.id ?? ""),
        symbol: String(pos.symbol ?? ""),
        type: pos.type as Position["type"],
        volume: Number(pos.volume ?? 0),
        openPrice: Number(pos.openPrice ?? 0),
        currentPrice: Number(pos.currentPrice ?? 0),
        stopLoss: pos.stopLoss != null ? Number(pos.stopLoss) : undefined,
        takeProfit: pos.takeProfit != null ? Number(pos.takeProfit) : undefined,
        profit: Number(pos.profit ?? 0),
        time: String(pos.time ?? ""),
        comment: pos.comment != null ? String(pos.comment) : undefined,
      };
    });
  }, []);

  const fetchAccountInfoData = useCallback(async (accId: string, accRegion: string): Promise<AccountInfo> => {
    const res = await fetch(`${API_BASE}/mt5/account/${accId}/info?region=${accRegion}`);
    if (!res.ok) throw new Error(`Account info failed: ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    return {
      balance: Number(data.balance ?? 0),
      equity: Number(data.equity ?? 0),
      margin: Number(data.margin ?? 0),
      freeMargin: Number(data.freeMargin ?? 0),
      currency: String(data.currency ?? "USD"),
      leverage: Number(data.leverage ?? 100),
      name: String(data.name ?? "Account"),
    };
  }, []);

  const fetchPendingOrdersData = useCallback(async (accId: string, accRegion: string): Promise<PendingOrder[]> => {
    const res = await fetch(`${API_BASE}/mt5/account/${accId}/orders?region=${accRegion}`);
    if (!res.ok) throw new Error(`Orders fetch failed: ${res.status}`);
    const data = await res.json() as unknown[];
    return (Array.isArray(data) ? data : []).map((o) => {
      const ord = o as Record<string, unknown>;
      return {
        id: String(ord.id ?? ""),
        symbol: String(ord.symbol ?? ""),
        type: String(ord.type ?? ""),
        volume: Number(ord.volume ?? ord.currentVolume ?? 0),
        openPrice: Number(ord.openPrice ?? 0),
        stopLoss: ord.stopLoss != null ? Number(ord.stopLoss) : undefined,
        takeProfit: ord.takeProfit != null ? Number(ord.takeProfit) : undefined,
        comment: ord.comment != null ? String(ord.comment) : undefined,
        time: String(ord.time ?? ord.updateTime ?? ""),
      };
    });
  }, []);

  const startPolling = useCallback(
    (accId: string, accRegion: string) => {
      if (priceIntervalRef.current) clearTimeout(priceIntervalRef.current);
      if (positionsIntervalRef.current) clearInterval(positionsIntervalRef.current);
      priceFailCountRef.current = 0;
      setPriceError(false);

      // Sequential loop: next request only fires after the previous one settles.
      // Prevents in-flight request pile-up when MetaAPI is slow or the network hiccups.
      let active = true;
      let autoReconnectAt = 0; // timestamp of last auto-reconnect attempt
      const loop = () => {
        if (!active) return;
        fetchPriceData(accId, accRegion)
          .then((p) => {
            // Stale prices don't reset the fail counter but they DO keep the feed alive —
            // don't increment failures and don't clear error state until we get a fresh price.
            if (!p.stale) {
              priceFailCountRef.current = 0;
              setPriceError(false);
            }
            setPrice(p);
          })
          .catch(() => {
            priceFailCountRef.current += 1;
            if (priceFailCountRef.current >= 3) setPriceError(true);
            // Auto-reconnect: if price has been failing for ~15s, try re-deploying
            // the MetaAPI account (handles broker disconnect after idle time).
            // Limit to once every 90 seconds to avoid hammering the API.
            if (priceFailCountRef.current >= 30 && Date.now() - autoReconnectAt > 90_000) {
              autoReconnectAt = Date.now();
              priceFailCountRef.current = 0;
              console.log("[price-poll] auto-reconnect triggered after sustained failures");
              fetch(`${API_BASE}/mt5/connect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accountId: accId }),
              }).catch(() => {});
            }
          })
          .finally(() => {
            if (active) priceIntervalRef.current = setTimeout(loop, 500);
          });
      };

      const pollPositions = () =>
        Promise.all([
          fetchPositionsData(accId, accRegion).then(setPositions).catch(() => {}),
          fetchPendingOrdersData(accId, accRegion).then(setPendingOrders).catch(() => {}),
        ]);

      loop();
      pollPositions();
      positionsIntervalRef.current = setInterval(pollPositions, 10000);

      // Return cleanup so the ref-sync effect can stop the loop
      return () => { active = false; if (priceIntervalRef.current) clearTimeout(priceIntervalRef.current); };
    },
    [fetchPriceData, fetchPositionsData, fetchPendingOrdersData]
  );

  // Keep the ref in sync so pollUntilConnected (declared before startPolling) can access it
  useEffect(() => { startPollingRef.current = startPolling; }, [startPolling]);

  const stopPolling = useCallback(() => {
    if (priceIntervalRef.current) clearTimeout(priceIntervalRef.current);
    if (positionsIntervalRef.current) clearInterval(positionsIntervalRef.current);
  }, []);

  const connect = useCallback(
    async (creds?: Mt5Credentials) => {
      const useCreds = creds ?? credentials;
      if (!useCreds.login.trim() || !useCreds.password.trim() || !useCreds.server.trim()) {
        setErrorMsg("Please fill in your MT5 account number, password, and server.");
        setStatus("error");
        return;
      }
      if (creds) setCredentials(creds);
      setStatus("connecting");
      setErrorMsg("");
      try {
        const connectUrl = `${API_BASE}/mt5/connect`;
        console.log("[connect] POST", connectUrl);
        let res: Response;
        try {
          res = await fetch(connectUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              login: useCreds.login.trim(),
              password: useCreds.password.trim(),
              server: useCreds.server.trim(),
            }),
          });
        } catch (netErr) {
          throw new Error(`Cannot reach server. Check your connection. (${netErr instanceof Error ? netErr.message : netErr})`);
        }

        const data = await safeJson<{
          status?: string;
          error?: string;
          accountId?: string;
          region?: string;
          retryAfterMs?: number;
        } & Partial<AccountInfo>>(res, "Connect endpoint");

        if (!res.ok || data.error) throw new Error(data.error ?? "Connection failed");

        // MetaAPI is auto-detecting broker settings — wait and retry the whole connect
        if (data.status === "pending_broker_detection") {
          const waitMs = data.retryAfterMs ?? 75000;
          console.log(`[connect] broker detection in progress, retrying in ${waitMs}ms`);
          await new Promise((r) => setTimeout(r, waitMs));
          // Retry recursively (without re-setting creds to avoid loop with setCredentials)
          return connect(useCreds);
        }

        const accId = data.accountId;
        const accRegion = data.region ?? DEFAULT_REGION;

        if (!accId || typeof accId !== "string") {
          throw new Error("Server returned an invalid account ID. Please try again.");
        }

        // Already fully connected — use info directly
        if (data.status === "connected") {
          setAccountIdState(accId);
          setRegionState(accRegion);
          await AsyncStorage.multiSet([["mt5_account_id", accId], ["mt5_region", accRegion]]);
          setAccountInfo({
            balance: data.balance ?? 0, equity: data.equity ?? 0,
            margin: data.margin ?? 0, freeMargin: data.freeMargin ?? 0,
            currency: data.currency ?? "USD", leverage: data.leverage ?? 100,
            name: data.name ?? "Account",
          });
          setStatus("connected");
          startPolling(accId, accRegion);
          return;
        }

        // status === "deploying" — poll until CONNECTED
        await pollUntilConnected(accId, accRegion);
      } catch (err) {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "Connection failed");
      }
    },
    [credentials, setCredentials, startPolling, pollUntilConnected]
  );

  const disconnect = useCallback(async () => {
    stopPolling();
    if (accountId) {
      try {
        await fetch(`${API_BASE}/mt5/account/${accountId}/disconnect`, { method: "POST" });
      } catch {}
    }
    await AsyncStorage.multiRemove(["mt5_account_id", "mt5_region"]);
    setAccountIdState("");
    setRegionState(DEFAULT_REGION);
    setStatus("disconnected");
    setAccountInfo(null);
    setPositions([]);
    setPendingOrders([]);
    setPrice(null);
    setErrorMsg("");
  }, [accountId, stopPolling]);

  const refreshPrice = useCallback(async () => {
    if (status !== "connected" || !accountId) return;
    try {
      setPrice(await fetchPriceData(accountId, region));
      priceFailCountRef.current = 0;
      setPriceError(false);
    } catch {}
  }, [status, accountId, region, fetchPriceData]);

  // Force-redeploy the MetaAPI account and restart polling — used when price feed
  // is stuck failing (e.g. broker disconnected after idle time).
  const redeployAccount = useCallback(async () => {
    if (!accountId) return;
    try {
      setStatus("connecting");
      setPriceError(false);
      priceFailCountRef.current = 0;
      const res = await fetch(`${API_BASE}/mt5/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await safeJson<{ status?: string; region?: string; error?: string } & Partial<AccountInfo>>(res, "Reconnect");
      if (!res.ok || data.error) throw new Error(data.error ?? "Reconnect failed");
      const accRegion = data.region ?? region;
      setRegionState(accRegion);
      if (data.status === "connected") {
        if (data.balance != null) {
          setAccountInfo({
            balance: data.balance, equity: data.equity ?? 0,
            margin: data.margin ?? 0, freeMargin: data.freeMargin ?? 0,
            currency: data.currency ?? "USD", leverage: data.leverage ?? 100,
            name: data.name ?? "Account",
          });
        }
        setStatus("connected");
        startPolling(accountId, accRegion);
      } else {
        // deploying — poll until connected
        await pollUntilConnected(accountId, accRegion);
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Reconnect failed");
    }
  }, [accountId, region, startPolling, pollUntilConnected]);

  const refreshPositions = useCallback(async () => {
    if (status !== "connected" || !accountId) return;
    try { setPositions(await fetchPositionsData(accountId, region)); } catch {}
  }, [status, accountId, region, fetchPositionsData]);

  const refreshPendingOrders = useCallback(async () => {
    if (status !== "connected" || !accountId) return;
    try { setPendingOrders(await fetchPendingOrdersData(accountId, region)); } catch {}
  }, [status, accountId, region, fetchPendingOrdersData]);

  const refreshAccountInfo = useCallback(async () => {
    if (status !== "connected" || !accountId) return;
    try { setAccountInfo(await fetchAccountInfoData(accountId, region)); } catch {}
  }, [status, accountId, region, fetchAccountInfoData]);

  // Raw order submission — no side-effect refreshes. Used by both placeTrade and placeCascadeOrders.
  // Retries up to 2 times on transient "not ready" errors (MetaAPI warming up after reconnect).
  const submitOrderRaw = useCallback(
    async (params: PlaceTradeParams): Promise<{ success: boolean; message: string; positionId?: string; orderId?: string }> => {
      let actionType: string;
      if (params.limitPrice != null) {
        actionType = params.direction === "buy" ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_SELL_LIMIT";
      } else {
        actionType = params.direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
      }
      const body: Record<string, unknown> = {
        actionType,
        symbol: "XAUUSD",
        volume: params.volume,
        comment: params.comment ?? "XAUUSD Trader App",
      };
      if (params.limitPrice != null) body.openPrice = params.limitPrice;
      if (params.stopLoss != null) body.stopLoss = params.stopLoss;
      if (params.takeProfit != null) body.takeProfit = params.takeProfit;

      const isTransient = (msg?: string) =>
        msg?.toLowerCase().includes("failed to execute a callable") ||
        msg?.toLowerCase().includes("not connected to broker") ||
        msg?.toLowerCase().includes("account is not connected");

      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log("[submitOrderRaw] →", actionType, "vol=" + String(params.volume), params.limitPrice != null ? "openPrice=" + String(params.limitPrice) : "market", "sl=" + String(params.stopLoss ?? "none"), attempt > 1 ? `(attempt ${attempt})` : "");
        const res = await fetch(`${API_BASE}/mt5/account/${accountId}/trade?region=${region}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json() as { success?: boolean; code?: number; message?: string; positionId?: string; orderId?: string };
        console.log("[submitOrderRaw] ←", actionType, "httpStatus=" + String(res.status), "success=" + String(data.success) + " code=" + String(data.code) + " msg=" + String(data.message));
        if (res.ok && data.success !== false) {
          return { success: true, message: data.message ?? "Trade placed successfully", positionId: data.positionId, orderId: data.orderId };
        }
        // Retry on transient broker-not-ready errors
        if (attempt < MAX_ATTEMPTS && isTransient(data.message)) {
          console.log("[submitOrderRaw] transient error — retrying in 1.5s");
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        return { success: false, message: data.message ?? `Trade failed (code ${data.code ?? res.status})` };
      }
      return { success: false, message: "Trade failed after retries" };
    },
    [accountId, region]
  );

  const placeTrade = useCallback(
    async (params: PlaceTradeParams): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      try {
        const result = await submitOrderRaw(params);
        // Refresh in background — don't block the success toast
        if (result.success) {
          void Promise.all([refreshPositions(), refreshPendingOrders(), refreshAccountInfo()]);
        }
        return result;
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : "Trade failed" };
      }
    },
    [status, submitOrderRaw, refreshPositions, refreshPendingOrders, refreshAccountInfo]
  );

  const placeCascadeOrders = useCallback(
    async (params: CascadeOrderParams): Promise<{ success: boolean; placed: number; failed: number; message: string; marketPositionId?: string; limitOrderIds?: string[] }> => {
      if (status !== "connected") return { success: false, placed: 0, failed: 0, message: "Not connected" };
      let placed = 0;
      let failed = 0;
      const errors: string[] = [];
      const total = 1 + params.limitEntries.length;
      let marketPositionId: string | undefined;
      const limitOrderIds: string[] = [];

      try {
        // Fire market + all limits in parallel — one round-trip instead of two
        const [marketResult, ...limitResults] = await Promise.all([
          submitOrderRaw({
            direction: params.direction,
            volume: params.volume,
            stopLoss: params.stopLoss,
            comment: `Cascade 1/${total}`,
          }),
          ...params.limitEntries.map((limitPrice, i) =>
            submitOrderRaw({
              direction: params.direction,
              volume: params.volume,
              limitPrice,
              stopLoss: params.stopLoss,
              comment: `Cascade ${i + 2}/${total}`,
            })
          ),
        ]);

        if (marketResult.success) {
          placed++;
          if (marketResult.positionId) marketPositionId = marketResult.positionId;
        } else {
          failed++;
          errors.push(`Market: ${marketResult.message}`);
          // Market failed — cancel any limits that succeeded to avoid dangling orders
          const toCancel = limitResults.filter((r) => r.success && r.orderId).map((r) => r.orderId!);
          if (toCancel.length > 0) {
            void Promise.all(toCancel.map((id) =>
              fetch(`${API_BASE}/mt5/account/${accountId}/cancel-order/${id}?region=${region}`, { method: "POST" })
            ));
          }
        }

        for (const r of limitResults) {
          if (r.success) {
            placed++;
            if (r.orderId) limitOrderIds.push(r.orderId);
          } else {
            failed++;
            errors.push(`Limit: ${r.message}`);
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : "Unknown error");
      }

      // Refresh in background — don't delay success feedback
      void Promise.all([refreshPositions(), refreshPendingOrders(), refreshAccountInfo()]);

      if (placed === 0) {
        return { success: false, placed, failed, message: errors[0] ?? "All orders failed to place" };
      }
      if (failed > 0) {
        return { success: true, placed, failed, message: `${placed}/${total} placed. Failed: ${errors.join("; ")}`, marketPositionId, limitOrderIds };
      }
      return { success: true, placed, failed, message: `${placed} orders placed — 1 market + ${params.limitEntries.length} limit`, marketPositionId, limitOrderIds };
    },
    [status, submitOrderRaw, refreshPositions, refreshPendingOrders, refreshAccountInfo]
  );

  const closePosition = useCallback(
    async (positionId: string): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      try {
        const res = await fetch(`${API_BASE}/mt5/account/${accountId}/trade?region=${region}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId }),
        });
        const data = await res.json() as { success?: boolean; code?: number; message?: string };
        if (!res.ok || data.success === false) return { success: false, message: data.message ?? `Close failed (code ${data.code ?? res.status})` };
        await Promise.all([refreshPositions(), refreshAccountInfo()]);
        return { success: true, message: "Position closed" };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : "Close failed" };
      }
    },
    [status, accountId, region, refreshPositions, refreshAccountInfo]
  );

  const cancelOrder = useCallback(
    async (orderId: string): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      try {
        const res = await fetch(`${API_BASE}/mt5/account/${accountId}/order/${orderId}?region=${region}`, {
          method: "DELETE",
        });
        const data = await res.json() as { success?: boolean; message?: string };
        if (!res.ok || data.success === false) return { success: false, message: data.message ?? `Cancel failed` };
        await Promise.all([refreshPendingOrders(), refreshAccountInfo()]);
        return { success: true, message: "Order cancelled" };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : "Cancel failed" };
      }
    },
    [status, accountId, region, refreshPendingOrders, refreshAccountInfo]
  );

  return (
    <TradingContext.Provider
      value={{
        accountId,
        apiBase: API_BASE,
        region,
        credentials,
        setCredentials,
        status,
        errorMsg,
        accountInfo,
        positions,
        pendingOrders,
        price,
        priceError,
        connect,
        disconnect,
        placeTrade,
        placeCascadeOrders,
        closePosition,
        cancelOrder,
        refreshPositions,
        refreshPendingOrders,
        refreshPrice,
        refreshAccountInfo,
        redeployAccount,
      }}
    >
      {children}
    </TradingContext.Provider>
  );
}

export function useTrading(): TradingContextValue {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTrading must be used inside TradingProvider");
  return ctx;
}
