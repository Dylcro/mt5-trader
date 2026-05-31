let _getToken: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(fn: () => Promise<string | null>): void {
  _getToken = fn;
}

export async function getAuthToken(): Promise<string | null> {
  return _getToken ? _getToken() : null;
}

export interface JwtPayload {
  sub?: string;
  email?: string;
  exp?: number;
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]!)) as JwtPayload;
    return payload;
  } catch {
    return null;
  }
}

export function getTokenExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return null;
  return payload.exp * 1000;
}

export function isTokenExpired(token: string, skewMs = 0): boolean {
  const exp = getTokenExpiryMs(token);
  if (exp == null) return true;
  return exp <= Date.now() + skewMs;
}

export async function getAuthTokenExpiryMs(): Promise<number | null> {
  const token = await getAuthToken();
  if (!token) return null;
  return getTokenExpiryMs(token);
}
