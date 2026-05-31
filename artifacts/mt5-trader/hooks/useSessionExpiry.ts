import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/context/AuthContext";
import { getAuthToken, getAuthTokenExpiryMs, isTokenExpired } from "@/lib/authToken";

const WARN_BEFORE_MS = 5 * 60 * 1000;
const POLL_MS = 30_000;

export interface SessionExpiryState {
  expiresAt: number | null;
  minutesRemaining: number | null;
  showWarning: boolean;
  isExpired: boolean;
  dismissWarning: () => void;
}

export function useSessionExpiry(): SessionExpiryState {
  const { isSignedIn, signOut } = useAuth();
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(async () => {
    if (!isSignedIn) {
      setExpiresAt(null);
      return;
    }
    const exp = await getAuthTokenExpiryMs();
    setExpiresAt(exp);
    if (exp != null) {
      const token = await getAuthToken();
      if (token && isTokenExpired(token)) {
        await signOut();
      }
    }
  }, [isSignedIn, signOut]);

  useEffect(() => {
    setDismissed(false);
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh, isSignedIn]);

  const msRemaining = expiresAt != null ? expiresAt - Date.now() : null;
  const minutesRemaining =
    msRemaining != null ? Math.max(0, Math.ceil(msRemaining / 60_000)) : null;
  const showWarning =
    isSignedIn &&
    !dismissed &&
    msRemaining != null &&
    msRemaining > 0 &&
    msRemaining <= WARN_BEFORE_MS;
  const isExpired = isSignedIn && msRemaining != null && msRemaining <= 0;

  return {
    expiresAt,
    minutesRemaining,
    showWarning,
    isExpired,
    dismissWarning: () => setDismissed(true),
  };
}
