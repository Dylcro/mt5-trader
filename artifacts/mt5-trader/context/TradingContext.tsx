import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";

import { emitAccountEvent } from "@/lib/accountEventBus";
import { getAuthToken } from "@/lib/authToken";
import { buildCascadeComment, newCascadeZoneId } from "@/lib/zoneComments";

// Secure credential helpers — used to silently re-establish the MetaAPI account
// when the server tells us the previous accountId is dead (HTTP 410). The
// password never leaves the device's hardware-backed keystore; on web (where
// SecureStore is unavailable) we degrade to "prompt for reconnect" gracefully.
const MT5_PASSWORD_KEY = "mt5_password_v1";
const _secureAvailable = Platform.OS === "ios" || Platform.OS === "android";
async function saveMt5Password(password: string): Promise<void> {
  if (!_secureAvailable || !password) return;
  try { await SecureStore.setItemAsync(MT5_PASSWORD_KEY, password); } catch (e) {
    console.warn("[secureCreds] save failed:", (e as Error).message);
  }
}
async function loadMt5Password(): Promise<string | null> {
  if (!_secureAvailable) return null;
  try { return await SecureStore.getItemAsync(MT5_PASSWORD_KEY); } catch { return null; }
}
async function clearMt5Password(): Promise<void> {
  if (!_secureAvailable) return;
  try { await SecureStore.deleteItemAsync(MT5_PASSWORD_KEY); } catch {}
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
}

export type SLMode = "points" | "percent" | "manual";

export interface Mt5Credentials {
  login: string;
  password: string;
  server: string;
}

export interface CascadeNotification {
  count: number;
  time: number;
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
  /** True when bid/ask have not updated recently (session asleep / SSE dropped). */
  priceStale: boolean;
  cascadeNotification: CascadeNotification | null;
  clearCascadeNotification: () => void;
  connect: (creds?: Mt5Credentials) => Promise<void>;
  disconnect: () => Promise<void>;
  reconnectFromServer: () => Promise<void>;
  placeTrade: (params: PlaceTradeParams) => Promise<{ success: boolean; message: string }>;
  placeCascadeOrders: (params: CascadeOrderParams) => Promise<{ success: boolean; placed: number; failed: number; message: string; marketPositionId?: string; limitOrderIds?: string[] }>;
  closePosition: (positionId: string) => Promise<{ success: boolean; message: string }>;
  cancelOrder: (orderId: string) => Promise<{ success: boolean; message: string }>;
  refreshPositions: () => Promise<void>;
  refreshPendingOrders: () => Promise<void>;
  refreshPrice: () => Promise<void>;
  refreshAccountInfo: () => Promise<void>;
  sseConnected: boolean;
  /** False while session sync runs after connect / foreground / trade-tab focus. */
  connectionWarm: boolean;
  /** Refresh broker session (price, positions, account). Safe to call when already warm. */
  syncSession: (force?: boolean) => Promise<void>;
}

export interface PlaceTradeParams {
  direction: "buy" | "sell";
  volume: number;
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
  limitPrice?: number;
  /** Per-trade absolute zone TP prices. Only the market leg of a cascade actually
   *  creates a zone server-side, so these are no-ops on plain single orders. */
  tp1Price?: number;
  tp2Price?: number;
  tp3Price?: number;
  /** TP4 is optional — when omitted the remaining 25% is left for manual close. */
  tp4Price?: number;
  /** Anchor hint = the live market price observed when the user tapped BUY/SELL.
   *  Server uses this to seed the zone before the real fill price arrives. */
  anchorPrice?: number;
  /** Per-TP close percentages. Must sum to 100 across active TPs. Default 25 each. */
  tp1Pct?: number;
  tp2Pct?: number;
  tp3Pct?: number;
  tp4Pct?: number;
  /** Auto SL→BE after TP1, TP2, or TP3 (default 2). */
  autoBeAtTp?: number;
  /** Pre-generated zone id for cascade legs — ties all orders to one zone. */
  zoneId?: string;
}

export interface CascadeOrderParams {
  direction: "buy" | "sell";
  volume: number;
  limitEntries: number[];
  stopLoss: number;
  /** If set, skip the market order and use this position ID as the market leg */
  existingPositionId?: string;
  /** Per-zone absolute TP prices. tp1-3 required for the zone monitor to fire;
   *  tp4 optional (omit = manual close of the remaining 25%). */
  tp1Price: number;
  tp2Price: number;
  tp3Price: number;
  tp4Price?: number;
  /** Live anchor hint for the new zone (market price at user tap). */
  anchorPrice?: number;
  /** Per-TP close percentages. Must sum to 100 across active TPs. Default 25 each. */
  tp1Pct?: number;
  tp2Pct?: number;
  tp3Pct?: number;
  tp4Pct?: number;
  autoBeAtTp?: number;
  /** Optional — generated automatically when omitted. */
  zoneId?: string;
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

// Auth-aware fetch: attaches the Clerk Bearer token when available.
async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

// Safely parse a fetch Response as JSON. If the body is HTML (server not ready yet
// or proxy error), throws a human-readable message instead of a raw parse error.
async function safeJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    if (text.trim().startsWith("<")) {
      throw new Error("Server not ready — please wait a moment and try again");
    }
    throw new Error("Unexpected server response — please try again");
  }
}

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
  const [priceStale, setPriceStale] = useState(true);
  const [sseConnected, setSseConnected] = useState(false);
  const [connectionWarm, setConnectionWarm] = useState(false);

  /** No price tick for this long → show Tap to sync (not Ready to trade). */
  const PRICE_STALE_MS = 12_000;
  const lastPriceAtRef = useRef(0);

  const [cascadeNotification, setCascadeNotification] = useState<CascadeNotification | null>(null);

  const priceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const positionsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const lastEventPollTimeRef = useRef<number>(Date.now());
  const priceFailCountRef = useRef(0);
  const startPollingRef = useRef<((accId: string, accRegion: string) => void) | null>(null);
  const reconnectInProgressRef = useRef(false);
  const connectionWarmRef = useRef(connectionWarm);
  const priceRef = useRef(price);
  const prevStatusRef = useRef<ConnectionStatus>(status);
  useEffect(() => { connectionWarmRef.current = connectionWarm; }, [connectionWarm]);
  useEffect(() => { priceRef.current = price; }, [price]);

  const applyLivePrice = useCallback((p: Price) => {
    lastPriceAtRef.current = Date.now();
    setPriceStale(false);
    priceRef.current = p;
    setPrice(p);
  }, []);

  // Mark quotes stale when ticks stop (app backgrounded, SSE dropped, MetaAPI idle).
  useEffect(() => {
    if (status !== "connected") {
      setPriceStale(false);
      return;
    }
    const id = setInterval(() => {
      if (!priceRef.current || lastPriceAtRef.current === 0) {
        setPriceStale(true);
        return;
      }
      const stale = Date.now() - lastPriceAtRef.current > PRICE_STALE_MS;
      setPriceStale(stale);
      if (stale) setConnectionWarm(false);
    }, 2_000);
    return () => clearInterval(id);
  }, [status]);

  // Keeps current region readable from the SSE closure without adding region
  // to the SSE effect's dependency array (which would reconnect on region change).
  const regionRef = useRef(region);
  useEffect(() => { regionRef.current = region; }, [region]);

  // Updated every render (render-time ref mutation, no re-render triggered) so
  // the SSE loop always calls the latest fetchPositionsData / fetchPendingOrdersData
  // closures. Populated below — after those callbacks are declared.
  const sseHandlersRef = useRef<{
    onDeal: () => void;
    onPendingOrder: () => void;
    onZoneUpdate: (data: unknown) => void;
  }>({ onDeal: () => {}, onPendingOrder: () => {}, onZoneUpdate: () => {} });

  const clearCascadeNotification = useCallback(() => setCascadeNotification(null), []);


  // Load saved credentials + accountId on startup (auth-gated reconnect happens in (tabs)/_layout)
  useEffect(() => {
    AsyncStorage.getMany(["mt5_login", "mt5_server", "mt5_account_id", "mt5_region"]).then((record) => {
      const login = record["mt5_login"] ?? "";
      const server = record["mt5_server"] ?? "";
      const savedAccountId = record["mt5_account_id"] ?? "";
      const savedRegion = record["mt5_region"] ?? DEFAULT_REGION;
      if (login) setCredentialsState((prev) => ({ ...prev, login, server }));
      if (savedAccountId) {
        setAccountIdState(savedAccountId);
        setRegionState(savedRegion);
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
        const r = await authFetch(`${API_BASE}/mt5/account/${accId}/status?region=${accRegion}`);
        const d = await safeJson<{
          connectionStatus?: string;
          error?: string;
          accountId?: string;
          region?: string;
        } & Partial<AccountInfo>>(r);
        if (!r.ok && d.error) throw new Error(d.error);
        if (d.connectionStatus === "CONNECTED") {
          const finalRegion = d.region ?? accRegion;
          setAccountIdState(accId);
          setRegionState(finalRegion);
          await AsyncStorage.setMany({ "mt5_account_id": accId, "mt5_region": finalRegion });
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
    try {
      // Retry up to 8 times — autoscale cold-starts can take 20-30 s before serving JSON
      let res: Response | null = null;
      let data: ({ status?: string; error?: string; accountId?: string; region?: string } & Partial<AccountInfo>) | null = null;
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          res = await authFetch(`${API_BASE}/mt5/connect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: savedId }),
          });
          data = await safeJson<{ status?: string; error?: string; accountId?: string; region?: string } & Partial<AccountInfo>>(res);
          break; // success — exit retry loop
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          const isTransient = msg.includes("not ready") || msg.includes("Unexpected server");
          if (attempt < 8 && isTransient) {
            console.warn(`[reconnect] attempt ${attempt} failed (${msg}) — retrying in 4s`);
            await new Promise((r) => setTimeout(r, 4000));
          } else {
            throw err;
          }
        }
      }
      if (!res || !data) throw new Error("Reconnect failed");

      // 404 = account deleted on MetaAPI side — must re-register
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
    } catch (err) {
      // Transient error (network blip, timeout) — leave accountId intact so
      // the user can retry without re-entering credentials.
      const msg = err instanceof Error ? err.message : "Reconnect failed";
      console.warn("[reconnect] failed:", msg);
      setErrorMsg(msg);
      setStatus("error");
    }
  };

  const setCredentials = useCallback((c: Mt5Credentials) => {
    setCredentialsState(c);
    AsyncStorage.setMany({ "mt5_login": c.login, "mt5_server": c.server });
  }, []);

  const fetchPriceData = useCallback(async (accId: string, accRegion: string): Promise<Price> => {
    const res = await authFetch(`${API_BASE}/mt5/account/${accId}/price?region=${accRegion}`);
    if (!res.ok) throw new Error(`Price fetch failed: ${res.status}`);
    const data = await safeJson<{ bid?: number; ask?: number; time?: string }>(res);
    const bid = data.bid ?? 0;
    const ask = data.ask ?? 0;
    return {
      bid,
      ask,
      spread: Math.round((ask - bid) * 10),
      time: data.time ?? new Date().toISOString(),
    };
  }, []);

  const fetchPositionsData = useCallback(async (accId: string, accRegion: string): Promise<Position[]> => {
    const res = await authFetch(`${API_BASE}/mt5/account/${accId}/positions?region=${accRegion}`);
    if (!res.ok) throw new Error(`Positions fetch failed: ${res.status}`);
    const data = await safeJson<unknown[]>(res);
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
    const res = await authFetch(`${API_BASE}/mt5/account/${accId}/info?region=${accRegion}`);
    if (!res.ok) throw new Error(`Account info failed: ${res.status}`);
    const data = await safeJson(res);
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
    const res = await authFetch(`${API_BASE}/mt5/account/${accId}/orders?region=${accRegion}`);
    if (!res.ok) throw new Error(`Orders fetch failed: ${res.status}`);
    const data = await safeJson<unknown[]>(res);
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

  // Render-time ref update — no re-render triggered, no stale closure in SSE loop.
  // Must be placed after fetchPositionsData and fetchPendingOrdersData are declared.
  sseHandlersRef.current = {
    onDeal: () => {
      const r = regionRef.current;
      const a = accountId;
      // Emit to the bus so useZones can react (e.g. refresh zone list on deal).
      emitAccountEvent(a, "deal", {});
      void Promise.all([
        fetchPositionsData(a, r).then(setPositions).catch(() => {}),
        fetchPendingOrdersData(a, r).then(setPendingOrders).catch(() => {}),
        fetchAccountInfoData(a, r).then(setAccountInfo).catch(() => {}),
      ]);
    },
    onPendingOrder: () => {
      const r = regionRef.current;
      const a = accountId;
      void fetchPendingOrdersData(a, r).then(setPendingOrders).catch(() => {});
    },
    onZoneUpdate: (data: unknown) => {
      emitAccountEvent(accountId, "zone_update", data);
    },
  };

  const startPolling = useCallback(
    (accId: string, accRegion: string) => {
      if (priceIntervalRef.current) clearInterval(priceIntervalRef.current);
      if (positionsIntervalRef.current) clearInterval(positionsIntervalRef.current);
      if (eventsIntervalRef.current) clearInterval(eventsIntervalRef.current);
      priceFailCountRef.current = 0;
      lastEventPollTimeRef.current = Date.now();
      setPriceError(false);

      const pollPrice = () =>
        fetchPriceData(accId, accRegion)
          .then((p) => { priceFailCountRef.current = 0; setPriceError(false); applyLivePrice(p); })
          .catch(() => {
            priceFailCountRef.current += 1;
            if (priceFailCountRef.current >= 3) setPriceError(true);
          });

      const pollPositions = () =>
        Promise.all([
          fetchPositionsData(accId, accRegion).then(setPositions).catch(() => {}),
          fetchPendingOrdersData(accId, accRegion).then(setPendingOrders).catch(() => {}),
        ]);

      const pollEvents = async () => {
        try {
          const since = lastEventPollTimeRef.current;
          const res = await authFetch(`${API_BASE}/mt5/events/${accId}?since=${since}&region=${accRegion}`);
          if (!res.ok) return;
          const data = await safeJson<{ events?: Array<{ autoCascade?: boolean; autoCascadeCount?: number; time?: number }>; serverTime?: number }>(res);
          lastEventPollTimeRef.current = data.serverTime ?? Date.now();
          const cascadeEvents = (data.events ?? []).filter(e => e.autoCascade && (e.autoCascadeCount ?? 0) > 0);
          if (cascadeEvents.length > 0) {
            const totalCount = cascadeEvents.reduce((sum, e) => sum + (e.autoCascadeCount ?? 0), 0);
            setCascadeNotification({ count: totalCount, time: Date.now() });
          }
        } catch {
          // swallow — events polling is best-effort
        }
      };

      // One-time fetch on connect. SSE is the primary source for ongoing price +
      // position updates — intervals for those are managed by the SSE effect below
      // (fallback-only, started only after 30 s of SSE disconnection).
      pollPrice();
      pollPositions();
      void fetchAccountInfoData(accId, accRegion).then(setAccountInfo).catch(() => {});
      void pollEvents();
      priceIntervalRef.current = null;
      positionsIntervalRef.current = null;
      eventsIntervalRef.current = setInterval(pollEvents, 5000);
    },
    [fetchPriceData, fetchPositionsData, fetchPendingOrdersData, fetchAccountInfoData, applyLivePrice]
  );

  // Keep the ref in sync so pollUntilConnected (declared before startPolling) can access it
  useEffect(() => { startPollingRef.current = startPolling; }, [startPolling]);

  const stopPolling = useCallback(() => {
    if (priceIntervalRef.current) clearInterval(priceIntervalRef.current);
    if (positionsIntervalRef.current) clearInterval(positionsIntervalRef.current);
    if (eventsIntervalRef.current) clearInterval(eventsIntervalRef.current);
    if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
  }, []);

  const wakeConnection = useCallback(async (force = false) => {
    if (!accountId || status !== "connected") return;
    if (!force && connectionWarmRef.current && priceRef.current) return;
    setConnectionWarm(false);
    const r = regionRef.current;
    try {
      await authFetch(`${API_BASE}/healthz`);
      await authFetch(`${API_BASE}/mt5/account/${accountId}/status?region=${r}`);
      await Promise.all([
        fetchPriceData(accountId, r).then((p) => {
          applyLivePrice(p);
          priceFailCountRef.current = 0;
          setPriceError(false);
        }).catch(() => {}),
        fetchPositionsData(accountId, r).then(setPositions).catch(() => {}),
        fetchPendingOrdersData(accountId, r).then(setPendingOrders).catch(() => {}),
        fetchAccountInfoData(accountId, r).then(setAccountInfo).catch(() => {}),
      ]);
    } catch {
      // Trade path will auto-retry if still stale.
    } finally {
      const fresh =
        priceRef.current != null &&
        lastPriceAtRef.current > 0 &&
        Date.now() - lastPriceAtRef.current <= PRICE_STALE_MS;
      setConnectionWarm(fresh);
      if (!fresh) setPriceStale(true);
    }
  }, [accountId, status, fetchPriceData, fetchPositionsData, fetchPendingOrdersData, fetchAccountInfoData, applyLivePrice]);

  const wakeConnectionRef = useRef<() => void>(() => {});
  wakeConnectionRef.current = () => { void wakeConnection(); };

  // Auto-sync when MT5 reaches CONNECTED (fixes buttons stuck "cloudy" until manual tap).
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status === "connected" && accountId && prev !== "connected") {
      void wakeConnection(true);
    }
  }, [status, accountId, wakeConnection]);

  // Foreground wake + session heartbeat — keeps backend/MetaAPI warm after idle.
  useEffect(() => {
    if (status !== "connected" || !accountId) {
      setConnectionWarm(status !== "connecting");
      return;
    }
    const startHeartbeat = () => {
      if (heartbeatIntervalRef.current) return;
      heartbeatIntervalRef.current = setInterval(() => {
        void authFetch(`${API_BASE}/healthz`).catch(() => {});
        void authFetch(`${API_BASE}/mt5/account/${accountId}/status?region=${regionRef.current}`)
          .then(async (res) => {
            if (!res.ok) return;
            const d = await safeJson<{
              connectionStatus?: string;
              balance?: number;
              equity?: number;
              margin?: number;
              freeMargin?: number;
              currency?: string;
              leverage?: number;
              name?: string;
            }>(res);
            if (d.connectionStatus !== "CONNECTED" || d.balance == null) return;
            setAccountInfo((prev) => ({
              balance: Number(d.balance ?? 0),
              equity: Number(d.equity ?? 0),
              margin: Number(d.margin ?? 0),
              freeMargin: Number(d.freeMargin ?? 0),
              currency: String(d.currency ?? prev?.currency ?? "USD"),
              leverage: Number(d.leverage ?? prev?.leverage ?? 100),
              name: String(d.name ?? prev?.name ?? "Account"),
            }));
          })
          .catch(() => {});
      }, 25_000);
    };
    const stopHeartbeat = () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    };
    const onChange = (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (prev.match(/inactive|background/) && next === "active") {
        wakeConnectionRef.current();
        startHeartbeat();
      }
      if (next.match(/inactive|background/)) {
        stopHeartbeat();
        setConnectionWarm(false);
        setPriceStale(true);
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    if (AppState.currentState === "active") startHeartbeat();
    return () => {
      sub.remove();
      stopHeartbeat();
    };
  }, [status, accountId]);

  // ── SSE live stream ────────────────────────────────────────────────────────────
  // SSE is the PRIMARY source for price and position data.
  // When connected: price/positions intervals are cleared (SSE replaces them).
  // When disconnected: after a 30 s grace period, 15 s fallback intervals start.
  // When reconnected: fallback intervals are cleared again.
  // Cascade-event polling (eventsIntervalRef) is always-on; SSE doesn't carry it.
  // Reconnects with exponential back-off (2 s → 30 s) after a disconnect.
  useEffect(() => {
    if (status !== "connected" || !accountId || !API_BASE) return;
    let mounted = true;
    const controller = new AbortController();
    let retryDelay = 2_000;
    let sseDroppedAt: number | null = null;

    // Stop the fallback intervals (called when SSE (re)connects).
    const clearFallbackIntervals = () => {
      if (priceIntervalRef.current) { clearInterval(priceIntervalRef.current); priceIntervalRef.current = null; }
      if (positionsIntervalRef.current) { clearInterval(positionsIntervalRef.current); positionsIntervalRef.current = null; }
    };

    // Start fast fallback intervals (called only after 12 s of SSE disconnection).
    const startFallbackPolling = () => {
      if (priceIntervalRef.current) return; // already running
      const r = regionRef.current;
      const a = accountId;
      priceIntervalRef.current = setInterval(() => {
        fetchPriceData(a, r)
          .then(p => { priceFailCountRef.current = 0; setPriceError(false); applyLivePrice(p); })
          .catch(() => { priceFailCountRef.current += 1; if (priceFailCountRef.current >= 3) setPriceError(true); });
      }, 4_000);
      positionsIntervalRef.current = setInterval(() => {
        void Promise.all([
          fetchPositionsData(a, r).then(setPositions).catch(() => {}),
          fetchPendingOrdersData(a, r).then(setPendingOrders).catch(() => {}),
        ]);
      }, 4_000);
    };

    // Interruptible sleep — wakeUp() skips the wait immediately (used when
    // the app returns to foreground so we don't wait out a long backoff).
    let wakeUp: (() => void) | null = null;
    const interruptibleSleep = (ms: number) =>
      new Promise<void>(resolve => { wakeUp = resolve; setTimeout(resolve, ms); });
    const wakeNow = () => { wakeUp?.(); wakeUp = null; };

    // When the app returns to foreground (mobile) or tab becomes visible (web),
    // immediately skip any pending backoff sleep and reconnect.
    const onForeground = () => { retryDelay = 2_000; wakeNow(); wakeConnectionRef.current(); };
    const appStateSub = AppState.addEventListener("change", state => {
      if (state === "active") onForeground();
    });
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") onForeground();
    };
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    const run = async () => {
      while (mounted && !controller.signal.aborted) {
        try {
          const token = await getAuthToken();
          const headers: Record<string, string> = {};
          if (token) headers["Authorization"] = `Bearer ${token}`;

          const res = await fetch(
            `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/stream`,
            { headers, signal: controller.signal },
          );
          if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);

          const body = res.body;
          if (!body) throw new Error("SSE streaming not supported on this platform");

          // SSE connected — it is now primary; stop any fallback intervals.
          clearFallbackIntervals();
          setSseConnected(true);
          sseDroppedAt = null;
          retryDelay = 2_000;

          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let curEvent = "";

          try {
            while (mounted && !controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const parts = buffer.split("\n");
              buffer = parts.pop() ?? "";

              for (const line of parts) {
                if (line.startsWith("event:")) {
                  curEvent = line.slice(6).trim();
                } else if (line.startsWith("data:") && curEvent) {
                  try {
                    const data = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
                    if (curEvent === "price") {
                      const bid = Number(data.bid ?? 0);
                      const ask = Number(data.ask ?? 0);
                      if (bid > 0 && ask > 0) {
                        applyLivePrice({ bid, ask, spread: Math.round((ask - bid) * 10), time: new Date().toISOString() });
                        priceFailCountRef.current = 0;
                        setPriceError(false);
                        setConnectionWarm(true);
                      }
                    } else if (curEvent === "deal") {
                      sseHandlersRef.current.onDeal();
                    } else if (curEvent === "pending_order") {
                      sseHandlersRef.current.onPendingOrder();
                    } else if (curEvent === "zone_update") {
                      sseHandlersRef.current.onZoneUpdate(data);
                    }
                  } catch { /* ignore parse errors */ }
                  curEvent = "";
                } else if (line === "") {
                  curEvent = "";
                }
              }
            }
          } finally {
            reader.releaseLock();
          }
        } catch (e) {
          if (controller.signal.aborted || !mounted) break;
          console.warn(`[SSE] disconnected (${(e as Error).message}), retrying in ${retryDelay}ms`);
        }

        if (!mounted || controller.signal.aborted) break;

        // SSE dropped — update connection state and arm the 12 s grace timer.
        setSseConnected(false);
        setConnectionWarm(false);
        if (sseDroppedAt === null) sseDroppedAt = Date.now();
        if (Date.now() - sseDroppedAt >= 12_000) startFallbackPolling();

        await interruptibleSleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 8_000);
      }
    };

    void run();
    return () => {
      mounted = false;
      controller.abort();
      wakeNow();
      clearFallbackIntervals();
      setSseConnected(false);
      appStateSub.remove();
      if (Platform.OS === "web" && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, accountId]);

  const connect = useCallback(
    async (creds?: Mt5Credentials) => {
      const useCreds = creds ?? credentials;
      if (!useCreds.login.trim() || !useCreds.password.trim() || !useCreds.server.trim()) {
        setErrorMsg("Please fill in your MT5 account number, password, and server.");
        setStatus("error");
        return;
      }
      if (creds) setCredentials(creds);
      // Persist password securely so we can transparently re-establish the
      // MetaAPI account if it gets orphaned (no re-typing the password).
      void saveMt5Password(useCreds.password.trim());
      setStatus("connecting");
      setErrorMsg("");
      try {
        const connectUrl = `${API_BASE}/mt5/connect`;
        console.log("[connect] POST", connectUrl);
        let res: Response | null = null;
        let data: ({
          status?: string; error?: string; accountId?: string; region?: string; retryAfterMs?: number;
        } & Partial<AccountInfo>) | null = null;
        // Retry up to 8 times — autoscale cold-starts can take 20-30 s before serving JSON
        for (let attempt = 1; attempt <= 8; attempt++) {
          try {
            res = await authFetch(connectUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                login: useCreds.login.trim(),
                password: useCreds.password.trim(),
                server: useCreds.server.trim(),
              }),
            });
            data = await safeJson<{
              status?: string; error?: string; accountId?: string; region?: string; retryAfterMs?: number;
            } & Partial<AccountInfo>>(res);
            break; // success
          } catch (err) {
            const msg = err instanceof Error ? err.message : "";
            const isTransient = msg.includes("not ready") || msg.includes("Unexpected server");
            if (attempt < 8 && isTransient) {
              console.warn(`[connect] attempt ${attempt} failed (${msg}) — retrying in 4s`);
              await new Promise((r) => setTimeout(r, 4000));
            } else {
              throw err;
            }
          }
        }
        if (!res || !data) throw new Error("Cannot reach server after 8 attempts. Check your connection.");

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
          await AsyncStorage.setMany({ "mt5_account_id": accId, "mt5_region": accRegion });
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
        await authFetch(`${API_BASE}/mt5/account/${accountId}/disconnect`, { method: "POST" });
      } catch {}
    }
    await AsyncStorage.removeMany(["mt5_account_id", "mt5_region"]);
    await clearMt5Password();
    setAccountIdState("");
    setRegionState(DEFAULT_REGION);
    setStatus("disconnected");
    setAccountInfo(null);
    setPositions([]);
    setPendingOrders([]);
    setPrice(null);
    lastPriceAtRef.current = 0;
    setPriceStale(true);
    setConnectionWarm(false);
    setErrorMsg("");
  }, [accountId, stopPolling]);

  // Called after Clerk auth is ready. Fetches the user's account from the server
  // (keyed by userId) so a new device automatically reconnects their MT5 session.
  // Falls back to the locally-saved accountId if the server has no record.
  const reconnectFromServer = useCallback(async () => {
    if (reconnectInProgressRef.current) return;
    reconnectInProgressRef.current = true;
    try {
      let targetAccountId: string | null = null;
      let targetRegion = DEFAULT_REGION;
      try {
        const res = await authFetch(`${API_BASE}/mt5/my-account`);
        if (res.ok) {
          const data = await safeJson<{ accountId?: string; region?: string }>(res);
          if (data.accountId) {
            targetAccountId = data.accountId;
            targetRegion = data.region ?? DEFAULT_REGION;
          }
        }
      } catch {}

      // Fall back to AsyncStorage if server has no record yet
      if (!targetAccountId) {
        const record = await AsyncStorage.getMany(["mt5_account_id", "mt5_region"]);
        targetAccountId = record["mt5_account_id"] ?? null;
        targetRegion = record["mt5_region"] ?? DEFAULT_REGION;
      }

      if (targetAccountId) {
        setAccountIdState(targetAccountId);
        setRegionState(targetRegion);
        await reconnectSaved(targetAccountId);
      }
    } finally {
      reconnectInProgressRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshPrice = useCallback(async () => {
    if (status !== "connected" || !accountId) return;
    try {
      applyLivePrice(await fetchPriceData(accountId, region));
      priceFailCountRef.current = 0;
      setPriceError(false);
    } catch {}
  }, [status, accountId, region, fetchPriceData, applyLivePrice]);

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

  // Silently re-establish the MetaAPI account using credentials cached on this
  // device (login/server in AsyncStorage, password in SecureStore). Returns
  // the fresh {accountId, region} on success, or null if creds are missing /
  // the connect call fails. Used by submitOrderRaw to auto-recover when the
  // stored accountId is orphaned on MetaAPI's side — the user never has to
  // re-type their password.
  const silentReconnect = useCallback(async (): Promise<{ accountId: string; region: string } | null> => {
    try {
      const map = await AsyncStorage.getMany(["mt5_login", "mt5_server"]);
      const login = map["mt5_login"]?.trim();
      const server = map["mt5_server"]?.trim();
      const password = (await loadMt5Password())?.trim();
      if (!login || !server || !password) {
        console.warn("[silentReconnect] missing stored creds — cannot auto-reconnect");
        return null;
      }
      console.log("[silentReconnect] re-provisioning account for login=" + login);
      const res = await authFetch(`${API_BASE}/mt5/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password, server }),
      });
      const data = await safeJson<{ status?: string; accountId?: string; region?: string; error?: string }>(res);
      if (!res.ok || data.error || !data.accountId) {
        console.warn("[silentReconnect] connect failed:", data.error ?? res.status);
        return null;
      }
      const newId = data.accountId;
      const newRegion = data.region ?? DEFAULT_REGION;
      // If the server says "deploying", poll status briefly until CONNECTED
      // (≤30 s) so the immediate trade retry actually has a live connection.
      if (data.status !== "connected") {
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const sRes = await authFetch(`${API_BASE}/mt5/account/${newId}/status?region=${newRegion}`);
          const sData = await safeJson<{ connectionStatus?: string }>(sRes);
          if (sData.connectionStatus === "CONNECTED") break;
        }
      }
      // Update local state + AsyncStorage so subsequent calls (positions/price/etc) use the new ID.
      await AsyncStorage.setMany({ "mt5_account_id": newId, "mt5_region": newRegion });
      setAccountIdState(newId);
      setRegionState(newRegion);
      setStatus("connected");
      return { accountId: newId, region: newRegion };
    } catch (e) {
      console.warn("[silentReconnect] error:", (e as Error).message);
      return null;
    }
  }, []);

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
      // Per-trade zone TP prices — server only honours these on the cascade
      // market leg (it triggers zone creation), harmless on other orders.
      if (params.tp1Price != null) body.tp1Price = params.tp1Price;
      if (params.tp2Price != null) body.tp2Price = params.tp2Price;
      if (params.tp3Price != null) body.tp3Price = params.tp3Price;
      if (params.tp4Price != null) body.tp4Price = params.tp4Price;
      if (params.anchorPrice != null) body.anchorPrice = params.anchorPrice;
      if (params.tp1Pct != null) body.tp1Pct = params.tp1Pct;
      if (params.tp2Pct != null) body.tp2Pct = params.tp2Pct;
      if (params.tp3Pct != null) body.tp3Pct = params.tp3Pct;
      if (params.tp4Pct != null) body.tp4Pct = params.tp4Pct;
      if (params.autoBeAtTp != null) body.autoBeAtTp = params.autoBeAtTp;
      if (params.zoneId) body.zoneId = params.zoneId;

      const isTransient = (msg?: string) => {
        const m = msg?.toLowerCase() ?? "";
        return m.includes("failed to execute a callable") ||
          m.includes("not connected to broker") ||
          m.includes("account is not connected") ||
          m.includes("validation failed") ||
          m.includes("not ready") ||
          m.includes("unexpected server") ||
          m.includes("trade request timed out") ||
          m.includes("no connection to the trade server");
      };

      // Effective accountId/region for this trade — may be replaced mid-flight
      // if the server reports the MetaAPI account is dead and we silently
      // re-provision a fresh one (transparent to the user).
      let liveAccountId = accountId;
      let liveRegion = region;

      const MAX_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log("[submitOrderRaw] →", actionType, "vol=" + String(params.volume), params.limitPrice != null ? "openPrice=" + String(params.limitPrice) : "market", "sl=" + String(params.stopLoss ?? "none"), attempt > 1 ? `(attempt ${attempt})` : "");
        const res = await authFetch(`${API_BASE}/mt5/account/${liveAccountId}/trade?region=${liveRegion}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await safeJson<{ success?: boolean; code?: number; message?: string; error?: string; positionId?: string; orderId?: string; reconnectRequired?: boolean }>(res);
        const errMsg = data.message ?? data.error;
        console.log("[submitOrderRaw] ←", actionType, "httpStatus=" + String(res.status), "success=" + String(data.success) + " code=" + String(data.code) + " msg=" + String(errMsg));
        if (res.ok && data.success !== false) {
          return { success: true, message: data.message ?? "Trade placed successfully", positionId: data.positionId, orderId: data.orderId };
        }
        // Server signalled the MetaAPI account no longer exists. Silently
        // re-establish it using the password held in the device's secure
        // store, then retry the trade against the fresh accountId — the user
        // never sees the hiccup.
        if ((res.status === 410 || data.reconnectRequired) && attempt < MAX_ATTEMPTS) {
          const newIds = await silentReconnect();
          if (newIds) {
            liveAccountId = newIds.accountId;
            liveRegion = newIds.region;
            console.log("[submitOrderRaw] silent reconnect ok — retrying trade with new accountId");
            continue;
          }
          // Silent reconnect failed (no stored password / web platform / connect error)
          // — surface a clear message so the UI can prompt for re-entry.
          return { success: false, message: errMsg ?? "Your MT5 connection has expired. Please reconnect with your MT5 password.", reconnectRequired: true } as { success: boolean; message: string; reconnectRequired?: boolean; positionId?: string; orderId?: string };
        }
        // Retry once on transient broker-not-ready errors with a short delay
        if (attempt < MAX_ATTEMPTS && isTransient(errMsg)) {
          const delayMs = errMsg?.toLowerCase().includes("validation") ? 1200 : 500;
          console.log(`[submitOrderRaw] transient error — retrying in ${delayMs}ms`);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        return { success: false, message: errMsg ?? `Trade failed (code ${data.code ?? res.status})` };
      }
      return { success: false, message: "Trade failed after retries" };
    },
    [accountId, region, silentReconnect]
  );

  const placeTrade = useCallback(
    async (params: PlaceTradeParams): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      if (!connectionWarm) {
        await wakeConnection();
      }
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
    [status, connectionWarm, wakeConnection, submitOrderRaw, refreshPositions, refreshPendingOrders, refreshAccountInfo]
  );

  const placeCascadeOrders = useCallback(
    async (params: CascadeOrderParams): Promise<{ success: boolean; placed: number; failed: number; message: string; marketPositionId?: string; limitOrderIds?: string[] }> => {
      if (status !== "connected") return { success: false, placed: 0, failed: 0, message: "Not connected" };
      if (!connectionWarm) {
        await wakeConnection();
      }
      let placed = 0;
      let failed = 0;
      const errors: string[] = [];
      const zoneId = params.zoneId ?? newCascadeZoneId();
      const total = 1 + params.limitEntries.length;
      let marketPositionId: string | undefined;
      const limitOrderIds: string[] = [];

      try {
        if (params.existingPositionId) {
          // Auto-trigger path: market position already exists in MT5 — only place limit orders
          marketPositionId = params.existingPositionId;
          placed = 1; // count the existing market position
          const limitResults = await Promise.all(
            params.limitEntries.map((limitPrice, i) =>
              submitOrderRaw({
                direction: params.direction,
                volume: params.volume,
                limitPrice,
                stopLoss: params.stopLoss,
                comment: buildCascadeComment(zoneId, i + 2, total),
                zoneId,
              })
            )
          );
          for (const r of limitResults) {
            if (r.success) {
              placed++;
              if (r.orderId) limitOrderIds.push(r.orderId);
            } else {
              failed++;
              errors.push(`Limit: ${r.message}`);
            }
          }
        } else {
          // Normal path: fire market + all limits in parallel — one round-trip instead of two
          const [marketResult, ...limitResults] = await Promise.all([
            submitOrderRaw({
              direction: params.direction,
              volume: params.volume,
              stopLoss: params.stopLoss,
              comment: buildCascadeComment(zoneId, 1, total),
              zoneId,
              // Absolute TP prices ride along on the market leg — that's the
              // trade that triggers zone creation server-side.
              tp1Price: params.tp1Price,
              tp2Price: params.tp2Price,
              tp3Price: params.tp3Price,
              tp4Price: params.tp4Price,
              anchorPrice: params.anchorPrice,
              tp1Pct: params.tp1Pct,
              tp2Pct: params.tp2Pct,
              tp3Pct: params.tp3Pct,
              tp4Pct: params.tp4Pct,
              autoBeAtTp: params.autoBeAtTp,
            }),
            ...params.limitEntries.map((limitPrice, i) =>
              submitOrderRaw({
                direction: params.direction,
                volume: params.volume,
                limitPrice,
                stopLoss: params.stopLoss,
                comment: buildCascadeComment(zoneId, i + 2, total),
                zoneId,
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
                authFetch(`${API_BASE}/mt5/account/${accountId}/cancel-order/${id}?region=${region}`, { method: "POST" })
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
    [status, connectionWarm, wakeConnection, submitOrderRaw, refreshPositions, refreshPendingOrders, refreshAccountInfo, accountId, region]
  );

  const closePosition = useCallback(
    async (positionId: string): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      try {
        const res = await authFetch(`${API_BASE}/mt5/account/${accountId}/trade?region=${region}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId }),
        });
        const data = await safeJson<{ success?: boolean; code?: number; message?: string }>(res);
        if (!res.ok || data.success === false) return { success: false, message: data.message ?? `Close failed (code ${data.code ?? res.status})` };
        // Refresh in background — don't make the user wait for the round-trip
        // before the success toast appears.
        void Promise.all([refreshPositions(), refreshAccountInfo()]);
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
        const res = await authFetch(`${API_BASE}/mt5/account/${accountId}/order/${orderId}?region=${region}`, {
          method: "DELETE",
        });
        const data = await safeJson<{ success?: boolean; message?: string }>(res);
        if (!res.ok || data.success === false) return { success: false, message: data.message ?? `Cancel failed` };
        // Refresh in background — don't block the success toast on the
        // pending-orders / account-info round-trips.
        void Promise.all([refreshPendingOrders(), refreshAccountInfo()]);
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
        priceStale,
        cascadeNotification,
        clearCascadeNotification,
        connect,
        disconnect,
        reconnectFromServer,
        placeTrade,
        placeCascadeOrders,
        closePosition,
        cancelOrder,
        refreshPositions,
        refreshPendingOrders,
        refreshPrice,
        refreshAccountInfo,
        sseConnected,
        connectionWarm,
        syncSession: wakeConnection,
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
