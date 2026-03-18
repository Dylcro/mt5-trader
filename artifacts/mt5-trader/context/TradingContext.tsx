import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

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

interface TradingContextValue {
  accountId: string;
  credentials: Mt5Credentials;
  setCredentials: (c: Mt5Credentials) => void;
  status: ConnectionStatus;
  errorMsg: string;
  accountInfo: AccountInfo | null;
  positions: Position[];
  price: Price | null;
  connect: (creds?: Mt5Credentials) => Promise<void>;
  disconnect: () => Promise<void>;
  placeTrade: (params: PlaceTradeParams) => Promise<{ success: boolean; message: string }>;
  placeCascadeOrders: (params: CascadeOrderParams) => Promise<{ success: boolean; placed: number; failed: number; message: string }>;
  closePosition: (positionId: string) => Promise<{ success: boolean; message: string }>;
  refreshPositions: () => Promise<void>;
  refreshPrice: () => Promise<void>;
  refreshAccountInfo: () => Promise<void>;
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
  entries: number[];
  stopLoss: number;
}

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "/api";

const TradingContext = createContext<TradingContextValue | null>(null);

export function TradingProvider({ children }: { children: React.ReactNode }) {
  const [accountId, setAccountIdState] = useState("");
  const [credentials, setCredentialsState] = useState<Mt5Credentials>({
    login: "",
    password: "",
    server: "",
  });
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [errorMsg, setErrorMsg] = useState("");
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [price, setPrice] = useState<Price | null>(null);

  const priceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const positionsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load saved credentials + accountId on startup and auto-reconnect
  useEffect(() => {
    AsyncStorage.multiGet(["mt5_login", "mt5_server", "mt5_account_id"]).then((pairs) => {
      const login = pairs[0][1] ?? "";
      const server = pairs[1][1] ?? "";
      const savedAccountId = pairs[2][1] ?? "";
      if (login) setCredentialsState((prev) => ({ ...prev, login, server }));
      if (savedAccountId) {
        setAccountIdState(savedAccountId);
        // Auto-reconnect silently
        reconnectSaved(savedAccountId);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reconnectSaved = async (savedId: string) => {
    setStatus("connecting");
    try {
      const res = await fetch(`${API_BASE}/mt5/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: savedId }),
      });
      const data = await res.json() as { error?: string; accountId?: string } & Partial<AccountInfo>;
      if (!res.ok || data.error) throw new Error(data.error ?? "Reconnect failed");
      setAccountIdState(data.accountId ?? savedId);
      setAccountInfo({
        balance: data.balance ?? 0,
        equity: data.equity ?? 0,
        margin: data.margin ?? 0,
        freeMargin: data.freeMargin ?? 0,
        currency: data.currency ?? "USD",
        leverage: data.leverage ?? 100,
        name: data.name ?? "Account",
      });
      setStatus("connected");
      startPolling(data.accountId ?? savedId);
    } catch {
      setStatus("disconnected");
      setAccountIdState("");
      await AsyncStorage.removeItem("mt5_account_id");
    }
  };

  const setCredentials = useCallback((c: Mt5Credentials) => {
    setCredentialsState(c);
    AsyncStorage.multiSet([
      ["mt5_login", c.login],
      ["mt5_server", c.server],
    ]);
  }, []);

  const fetchPriceData = useCallback(async (accId: string): Promise<Price> => {
    const res = await fetch(`${API_BASE}/mt5/account/${accId}/price`);
    if (!res.ok) throw new Error(`Price fetch failed: ${res.status}`);
    const data = await res.json() as { bid?: number; ask?: number; time?: string };
    const bid = data.bid ?? 0;
    const ask = data.ask ?? 0;
    return {
      bid,
      ask,
      spread: Math.round((ask - bid) * 10),
      time: data.time ?? new Date().toISOString(),
    };
  }, []);

  const fetchPositionsData = useCallback(async (accId: string): Promise<Position[]> => {
    const res = await fetch(`${API_BASE}/mt5/account/${accId}/positions`);
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

  const fetchAccountInfoData = useCallback(async (accId: string): Promise<AccountInfo> => {
    const res = await fetch(`${API_BASE}/mt5/account/${accId}/info`);
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

  const startPolling = useCallback(
    (accId: string) => {
      if (priceIntervalRef.current) clearInterval(priceIntervalRef.current);
      if (positionsIntervalRef.current) clearInterval(positionsIntervalRef.current);

      const pollPrice = () => fetchPriceData(accId).then(setPrice).catch(() => {});
      const pollPositions = () => fetchPositionsData(accId).then(setPositions).catch(() => {});

      pollPrice();
      pollPositions();
      priceIntervalRef.current = setInterval(pollPrice, 5000);
      positionsIntervalRef.current = setInterval(pollPositions, 10000);
    },
    [fetchPriceData, fetchPositionsData]
  );

  const stopPolling = useCallback(() => {
    if (priceIntervalRef.current) clearInterval(priceIntervalRef.current);
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
        const res = await fetch(`${API_BASE}/mt5/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            login: useCreds.login.trim(),
            password: useCreds.password.trim(),
            server: useCreds.server.trim(),
          }),
        });
        const data = await res.json() as { error?: string; accountId?: string } & Partial<AccountInfo>;
        if (!res.ok || data.error) throw new Error(data.error ?? "Connection failed");

        const accId = data.accountId!;
        setAccountIdState(accId);
        await AsyncStorage.setItem("mt5_account_id", accId);
        setAccountInfo({
          balance: data.balance ?? 0,
          equity: data.equity ?? 0,
          margin: data.margin ?? 0,
          freeMargin: data.freeMargin ?? 0,
          currency: data.currency ?? "USD",
          leverage: data.leverage ?? 100,
          name: data.name ?? "Account",
        });
        setStatus("connected");
        startPolling(accId);
      } catch (err) {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "Connection failed");
      }
    },
    [credentials, setCredentials, startPolling]
  );

  const disconnect = useCallback(async () => {
    stopPolling();
    if (accountId) {
      try {
        await fetch(`${API_BASE}/mt5/account/${accountId}/disconnect`, { method: "POST" });
      } catch {}
    }
    await AsyncStorage.removeItem("mt5_account_id");
    setAccountIdState("");
    setStatus("disconnected");
    setAccountInfo(null);
    setPositions([]);
    setPrice(null);
    setErrorMsg("");
  }, [accountId, stopPolling]);

  const refreshPrice = useCallback(async () => {
    if (status !== "connected" || !accountId) return;
    try { setPrice(await fetchPriceData(accountId)); } catch {}
  }, [status, accountId, fetchPriceData]);

  const refreshPositions = useCallback(async () => {
    if (status !== "connected" || !accountId) return;
    try { setPositions(await fetchPositionsData(accountId)); } catch {}
  }, [status, accountId, fetchPositionsData]);

  const refreshAccountInfo = useCallback(async () => {
    if (status !== "connected" || !accountId) return;
    try { setAccountInfo(await fetchAccountInfoData(accountId)); } catch {}
  }, [status, accountId, fetchAccountInfoData]);

  const placeTrade = useCallback(
    async (params: PlaceTradeParams): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      try {
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
        const res = await fetch(`${API_BASE}/mt5/account/${accountId}/trade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json() as { numericCode?: number; message?: string };
        if (!res.ok || data.numericCode === 10006) {
          return { success: false, message: data.message ?? `Trade failed: ${res.status}` };
        }
        await refreshPositions();
        await refreshAccountInfo();
        return { success: true, message: "Trade placed successfully" };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : "Trade failed" };
      }
    },
    [status, accountId, refreshPositions, refreshAccountInfo]
  );

  const placeCascadeOrders = useCallback(
    async (params: CascadeOrderParams): Promise<{ success: boolean; placed: number; failed: number; message: string }> => {
      if (status !== "connected") return { success: false, placed: 0, failed: 0, message: "Not connected" };
      let placed = 0;
      let failed = 0;
      for (let i = 0; i < params.entries.length; i++) {
        const result = await placeTrade({
          direction: params.direction,
          volume: params.volume,
          limitPrice: params.entries[i],
          stopLoss: params.stopLoss,
          comment: `Cascade ${i + 1}/${params.entries.length}`,
        });
        if (result.success) placed++;
        else failed++;
      }
      await refreshPositions();
      await refreshAccountInfo();
      if (placed === 0) return { success: false, placed, failed, message: "All orders failed to place" };
      if (failed > 0) return { success: true, placed, failed, message: `${placed} orders placed, ${failed} failed` };
      return { success: true, placed, failed, message: `${placed} limit orders placed successfully` };
    },
    [status, placeTrade, refreshPositions, refreshAccountInfo]
  );

  const closePosition = useCallback(
    async (positionId: string): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      try {
        const res = await fetch(`${API_BASE}/mt5/account/${accountId}/trade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId }),
        });
        const data = await res.json() as { message?: string };
        if (!res.ok) return { success: false, message: data.message ?? `Close failed: ${res.status}` };
        await refreshPositions();
        await refreshAccountInfo();
        return { success: true, message: "Position closed" };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : "Close failed" };
      }
    },
    [status, accountId, refreshPositions, refreshAccountInfo]
  );

  return (
    <TradingContext.Provider
      value={{
        accountId,
        credentials,
        setCredentials,
        status,
        errorMsg,
        accountInfo,
        positions,
        price,
        connect,
        disconnect,
        placeTrade,
        placeCascadeOrders,
        closePosition,
        refreshPositions,
        refreshPrice,
        refreshAccountInfo,
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
