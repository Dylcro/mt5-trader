// Resolve API base from the page origin so the remote works wherever it's
// hosted (Replit dev URL, deployed .replit.app, custom domain).
export const API_BASE = `${window.location.origin}/api`;

const TOKEN_KEY = "mt5_remote_token";

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore quota errors */ }
}

export function decodeJwtExp(token: string): number | null {
  try {
    let b64 = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = JSON.parse(atob(b64));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch { return null; }
}

export function isTokenValid(token: string | null | undefined): boolean {
  if (!token) return false;
  const exp = decodeJwtExp(token);
  return !!exp && exp * 1000 > Date.now();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "error" in data && typeof data.error === "string")
      ? data.error
      : `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

// -------- Auth --------

export type LoginResponse = { token: string; user: { id: number; email: string } };

export async function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

// -------- MT5 --------

export type AccountStatus = {
  accountId?: string;
  region?: string;
  status?: string;
};

export async function getMyAccount(): Promise<AccountStatus | null> {
  try {
    return await request<AccountStatus>("/mt5/my-account");
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

export type Price = { bid: number; ask: number };

export function getPrice(accountId: string, region: string): Promise<Price> {
  return request<Price>(`/mt5/account/${accountId}/price?region=${region}`);
}

export type Position = {
  profit?: number;
  swap?: number;
  commission?: number;
  unrealizedProfit?: number;
};

export async function getTotalPnL(accountId: string, region: string): Promise<number> {
  const positions = await request<Position[]>(`/mt5/account/${accountId}/positions?region=${region}`);
  return positions.reduce((acc, p) => {
    const profit = p.unrealizedProfit ?? p.profit ?? 0;
    return acc + profit + (p.swap ?? 0) + (p.commission ?? 0);
  }, 0);
}

export type Zone = {
  zoneId: string;
  direction: "buy" | "sell";
  anchorPrice: number;
  status: string;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  tp4Hit: boolean;
  createdAt: number;
};

export async function getLatestOpenZone(accountId: string): Promise<Zone | null> {
  const zones = await request<Zone[]>(`/mt5/account/${accountId}/zones`);
  const open = zones.filter((z) => z.status === "OPEN");
  if (open.length === 0) return null;
  open.sort((a, b) => b.createdAt - a.createdAt);
  return open[0]!;
}

export type TradeDefaults = {
  lotSize: number;
  tp1Pips: number;
  tp2Pips: number;
  tp3Pips: number;
  tp4Pips: number;
  slPips: number;
};

export function getTradeDefaults(): Promise<TradeDefaults> {
  return request<TradeDefaults>("/mt5/user/trade-defaults");
}

const PIP = 0.10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function placeMarketOrder(
  accountId: string,
  region: string,
  direction: "buy" | "sell",
): Promise<void> {
  const [d, price] = await Promise.all([
    getTradeDefaults(),
    getPrice(accountId, region),
  ]);
  const entry = direction === "buy" ? price.ask : price.bid;
  const sign = direction === "buy" ? 1 : -1;
  const sl = round2(entry - sign * d.slPips * PIP);
  const tp1 = round2(entry + sign * d.tp1Pips * PIP);
  const tp2 = round2(entry + sign * d.tp2Pips * PIP);
  const tp3 = round2(entry + sign * d.tp3Pips * PIP);
  const tp4 = d.tp4Pips > 0 ? round2(entry + sign * d.tp4Pips * PIP) : undefined;

  // Comment MUST start with "Cascade" so the server fires zone creation
  // (which powers the staged 25% partial closes at TP2/3/4).
  const body: Record<string, unknown> = {
    actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    symbol: "XAUUSD",
    volume: d.lotSize,
    comment: "Cascade 1/1 (remote)",
    stopLoss: sl,
    takeProfit: tp1,
    tp1Price: tp1,
    tp2Price: tp2,
    tp3Price: tp3,
    anchorPrice: entry,
  };
  if (tp4 !== undefined) body.tp4Price = tp4;

  await request(`/mt5/account/${accountId}/trade?region=${region}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function riskFreeLatestZone(accountId: string, region: string): Promise<void> {
  const zone = await request<{ zoneId: string }>(`/mt5/account/${accountId}/zones/latest-open`);
  await request(`/mt5/account/${accountId}/zones/${zone.zoneId}/risk-free?region=${region}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
