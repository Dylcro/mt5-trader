import { getAuthToken } from "@/lib/authToken";

export async function authFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

const TIMEOUT_HINT =
  "Broker is slow to respond. Open Trade, tap sync (↻), wait until price is live, then try again.";

/** Zone trades (risk-free, secure profits, close) — MetaAPI can take 20–40s when waking. */
export async function authFetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 35_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await authFetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(TIMEOUT_HINT);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
