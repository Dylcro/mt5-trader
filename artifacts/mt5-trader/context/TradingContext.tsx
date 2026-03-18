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

interface TradingContextValue {
  token: string;
  accountId: string;
  setToken: (t: string) => void;
  setAccountId: (id: string) => void;
  status: ConnectionStatus;
  errorMsg: string;
  accountInfo: AccountInfo | null;
  positions: Position[];
  price: Price | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  placeTrade: (params: PlaceTradeParams) => Promise<{ success: boolean; message: string }>;
  closePosition: (positionId: string) => Promise<{ success: boolean; message: string }>;
  refreshPositions: () => Promise<void>;
  refreshPrice: () => Promise<void>;
}

export interface PlaceTradeParams {
  direction: "buy" | "sell";
  volume: number;
  stopLoss?: number;
  takeProfit?: number;
  comment?: string;
}

const BASE_URL = "https://mt-client-api-v1.london.agiliumtrade.ai";

const TradingContext = createContext<TradingContextValue | null>(null);

export function TradingProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState("");
  const [accountId, setAccountIdState] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [errorMsg, setErrorMsg] = useState("");
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [price, setPrice] = useState<Price | null>(null);

  const priceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const positionsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    AsyncStorage.multiGet(["metaapi_token", "metaapi_account_id"]).then((pairs) => {
      const t = pairs[0][1] ?? "";
      const a = pairs[1][1] ?? "";
      if (t) setTokenState(t);
      if (a) setAccountIdState(a);
    });
  }, []);

  const setToken = useCallback((t: string) => {
    setTokenState(t);
    AsyncStorage.setItem("metaapi_token", t);
  }, []);

  const setAccountId = useCallback((id: string) => {
    setAccountIdState(id);
    AsyncStorage.setItem("metaapi_account_id", id);
  }, []);

  const apiHeaders = useCallback(
    (tok: string) => ({
      "auth-token": tok,
      "Content-Type": "application/json",
    }),
    []
  );

  const fetchAccountInfo = useCallback(
    async (tok: string, accId: string): Promise<AccountInfo> => {
      const res = await fetch(
        `${BASE_URL}/users/current/accounts/${accId}/account-information`,
        { headers: apiHeaders(tok) }
      );
      if (!res.ok) throw new Error(`Account info failed: ${res.status}`);
      const data = await res.json();
      return {
        balance: data.balance ?? 0,
        equity: data.equity ?? 0,
        margin: data.margin ?? 0,
        freeMargin: data.freeMargin ?? 0,
        currency: data.currency ?? "USD",
        leverage: data.leverage ?? 100,
        name: data.name ?? "Account",
      };
    },
    [apiHeaders]
  );

  const fetchPrice = useCallback(
    async (tok: string, accId: string): Promise<Price> => {
      const res = await fetch(
        `${BASE_URL}/users/current/accounts/${accId}/symbols/XAUUSD/current-price`,
        { headers: apiHeaders(tok) }
      );
      if (!res.ok) throw new Error(`Price fetch failed: ${res.status}`);
      const data = await res.json();
      const bid = data.bid ?? 0;
      const ask = data.ask ?? 0;
      return {
        bid,
        ask,
        spread: Math.round((ask - bid) * 100),
        time: data.time ?? new Date().toISOString(),
      };
    },
    [apiHeaders]
  );

  const fetchPositions = useCallback(
    async (tok: string, accId: string): Promise<Position[]> => {
      const res = await fetch(
        `${BASE_URL}/users/current/accounts/${accId}/positions`,
        { headers: apiHeaders(tok) }
      );
      if (!res.ok) throw new Error(`Positions fetch failed: ${res.status}`);
      const data = await res.json();
      return (Array.isArray(data) ? data : []).map((p: Record<string, unknown>) => ({
        id: String(p.id ?? ""),
        symbol: String(p.symbol ?? ""),
        type: p.type as Position["type"],
        volume: Number(p.volume ?? 0),
        openPrice: Number(p.openPrice ?? 0),
        currentPrice: Number(p.currentPrice ?? 0),
        stopLoss: p.stopLoss != null ? Number(p.stopLoss) : undefined,
        takeProfit: p.takeProfit != null ? Number(p.takeProfit) : undefined,
        profit: Number(p.profit ?? 0),
        time: String(p.time ?? ""),
        comment: p.comment != null ? String(p.comment) : undefined,
      }));
    },
    [apiHeaders]
  );

  const startPolling = useCallback(
    (tok: string, accId: string) => {
      if (priceIntervalRef.current) clearInterval(priceIntervalRef.current);
      if (positionsIntervalRef.current) clearInterval(positionsIntervalRef.current);

      const pollPrice = () =>
        fetchPrice(tok, accId)
          .then(setPrice)
          .catch(() => {});
      const pollPositions = () =>
        fetchPositions(tok, accId)
          .then(setPositions)
          .catch(() => {});

      pollPrice();
      pollPositions();
      priceIntervalRef.current = setInterval(pollPrice, 5000);
      positionsIntervalRef.current = setInterval(pollPositions, 10000);
    },
    [fetchPrice, fetchPositions]
  );

  const stopPolling = useCallback(() => {
    if (priceIntervalRef.current) clearInterval(priceIntervalRef.current);
    if (positionsIntervalRef.current) clearInterval(positionsIntervalRef.current);
  }, []);

  const connect = useCallback(async () => {
    if (!token.trim() || !accountId.trim()) {
      setErrorMsg("Please enter your MetaAPI token and account ID.");
      setStatus("error");
      return;
    }
    setStatus("connecting");
    setErrorMsg("");
    try {
      const info = await fetchAccountInfo(token, accountId);
      setAccountInfo(info);
      setStatus("connected");
      startPolling(token, accountId);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Connection failed");
    }
  }, [token, accountId, fetchAccountInfo, startPolling]);

  const disconnect = useCallback(() => {
    stopPolling();
    setStatus("disconnected");
    setAccountInfo(null);
    setPositions([]);
    setPrice(null);
    setErrorMsg("");
  }, [stopPolling]);

  const refreshPrice = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const p = await fetchPrice(token, accountId);
      setPrice(p);
    } catch {}
  }, [status, token, accountId, fetchPrice]);

  const refreshPositions = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const p = await fetchPositions(token, accountId);
      setPositions(p);
    } catch {}
  }, [status, token, accountId, fetchPositions]);

  const placeTrade = useCallback(
    async (params: PlaceTradeParams): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      try {
        const body: Record<string, unknown> = {
          actionType: params.direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
          symbol: "XAUUSD",
          volume: params.volume,
          comment: params.comment ?? "MT5 Trader App",
        };
        if (params.stopLoss != null) body.stopLoss = params.stopLoss;
        if (params.takeProfit != null) body.takeProfit = params.takeProfit;
        const res = await fetch(
          `${BASE_URL}/users/current/accounts/${accountId}/trade`,
          {
            method: "POST",
            headers: apiHeaders(token),
            body: JSON.stringify(body),
          }
        );
        const data = await res.json();
        if (!res.ok || data.numericCode === 10006) {
          return {
            success: false,
            message: data.message ?? `Trade failed: ${res.status}`,
          };
        }
        await refreshPositions();
        const acc = await fetchAccountInfo(token, accountId);
        setAccountInfo(acc);
        return { success: true, message: "Trade placed successfully" };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : "Trade failed",
        };
      }
    },
    [status, accountId, token, apiHeaders, refreshPositions, fetchAccountInfo]
  );

  const closePosition = useCallback(
    async (positionId: string): Promise<{ success: boolean; message: string }> => {
      if (status !== "connected") return { success: false, message: "Not connected" };
      try {
        const body = {
          actionType: "POSITION_CLOSE_ID",
          positionId,
        };
        const res = await fetch(
          `${BASE_URL}/users/current/accounts/${accountId}/trade`,
          {
            method: "POST",
            headers: apiHeaders(token),
            body: JSON.stringify(body),
          }
        );
        const data = await res.json();
        if (!res.ok) {
          return {
            success: false,
            message: data.message ?? `Close failed: ${res.status}`,
          };
        }
        await refreshPositions();
        const acc = await fetchAccountInfo(token, accountId);
        setAccountInfo(acc);
        return { success: true, message: "Position closed" };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : "Close failed",
        };
      }
    },
    [status, accountId, token, apiHeaders, refreshPositions, fetchAccountInfo]
  );

  return (
    <TradingContext.Provider
      value={{
        token,
        accountId,
        setToken,
        setAccountId,
        status,
        errorMsg,
        accountInfo,
        positions,
        price,
        connect,
        disconnect,
        placeTrade,
        closePosition,
        refreshPositions,
        refreshPrice,
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
