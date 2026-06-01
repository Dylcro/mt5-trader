import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.EXPO_PUBLIC_API_URL || "/api";

export type PlatformStatus = {
  trading_enabled: boolean;
  message: string;
  signups_open: boolean;
  membership_cap: number;
};

const DEFAULT_STATUS: PlatformStatus = {
  trading_enabled: true,
  message: "",
  signups_open: true,
  membership_cap: 20,
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
