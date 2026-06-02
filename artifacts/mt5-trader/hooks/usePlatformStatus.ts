import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.EXPO_PUBLIC_API_URL || "/api";

export type PlatformStatus = {
  trading_enabled: boolean;
  message: string;
  signups_open: boolean;
  invite_only: boolean;
  membership_cap: number;
  users_count?: number;
  spots_remaining?: number;
};

const DEFAULT_STATUS: PlatformStatus = {
  trading_enabled: true,
  message: "",
  signups_open: true,
  invite_only: false,
  membership_cap: 20,
  users_count: 0,
  spots_remaining: 20,
};

export function usePlatformStatus(pollMs = 30_000) {
  const [status, setStatus] = useState<PlatformStatus>(DEFAULT_STATUS);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/system/status`);
      if (res.ok) setStatus(await res.json() as PlatformStatus);
    } catch {
      /* keep last known */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { status, refresh };
}
