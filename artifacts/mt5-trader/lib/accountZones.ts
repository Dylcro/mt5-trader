import { enrichZoneDisplayFields, latchZoneTpHits } from "@/lib/zoneDisplay";
import { getAuthToken } from "@/lib/authToken";
import type { Zone } from "@/hooks/useZones";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

async function authFetch(url: string): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers });
}

/** Fetch zones for an account; latches TP hits when previous rows supplied. */
export async function fetchAccountZones(
  accountId: string,
  prev: Zone[] = [],
  includeClosed = true,
): Promise<Zone[]> {
  if (!API_BASE || !accountId) return [];
  const qs = includeClosed ? "?includeClosed=true" : "";
  const res = await authFetch(
    `${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/zones${qs}`,
  );
  if (!res.ok) throw new Error(`Zones HTTP ${res.status}`);
  const data = (await res.json()) as Zone[];
  if (!Array.isArray(data)) return [];
  const byId = new Map(prev.map((z) => [z.zoneId, z]));
  return data.map((row) => enrichZoneDisplayFields(latchZoneTpHits(byId.get(row.zoneId), row)));
}
