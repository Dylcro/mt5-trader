import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { getAuthToken } from "@/lib/authToken";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

interface NotificationPrefs {
  nearEnabled: boolean;
  hitEnabled: boolean;
  thresholdPips: number;
  hasToken: boolean;
}

const DEFAULTS: NotificationPrefs = {
  nearEnabled: false,
  hitEnabled: false,
  thresholdPips: 3,
  hasToken: false,
};

interface NotificationSettingsContextValue {
  prefs: NotificationPrefs;
  loading: boolean;
  permissionStatus: Notifications.PermissionStatus | "unknown";
  updatePrefs: (
    next: Partial<Pick<NotificationPrefs, "nearEnabled" | "hitEnabled" | "thresholdPips">>,
  ) => Promise<{ ok: boolean; message?: string }>;
}

const Ctx = createContext<NotificationSettingsContextValue | null>(null);

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return fetch(url, { ...options, headers });
}

// Configure foreground behaviour once at module load: show the banner even
// when the app is open so the user gets feedback while watching the screen.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registerForPushTokenAsync(): Promise<{
  token: string | null;
  status: Notifications.PermissionStatus;
}> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("tp-alerts", {
      name: "TP alerts",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      enableVibrate: true,
    });
  }
  if (!Device.isDevice) {
    return { token: null, status: "denied" as Notifications.PermissionStatus };
  }
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== "granted") return { token: null, status };
  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
    (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
  try {
    const res = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    return { token: res.data, status };
  } catch {
    return { token: null, status };
  }
}

export function NotificationSettingsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [permissionStatus, setPermissionStatus] = useState<
    Notifications.PermissionStatus | "unknown"
  >("unknown");
  const lastTokenSent = useRef<string | null>(null);

  // Initial load — fetch server prefs (auth-gated). Silently no-ops when
  // unauthenticated; settings screen re-loads after sign-in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!API_BASE) { setLoading(false); return; }
      try {
        const res = await authFetch(`${API_BASE}/mt5/notifications/prefs`);
        if (res.ok) {
          const data = (await res.json()) as NotificationPrefs;
          if (!cancelled) setPrefs({ ...DEFAULTS, ...data });
        }
      } catch {
        // ignored — defaults stay
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const updatePrefs = useCallback<NotificationSettingsContextValue["updatePrefs"]>(async (next) => {
    if (!API_BASE) return { ok: false, message: "API not configured" };

    // Compute the optimistic next state up-front so the UI feels instant.
    const merged: NotificationPrefs = { ...prefs, ...next };

    // If the user is opting in to either alert type and we don't have a token
    // yet, request permissions + fetch an Expo push token. A denied permission
    // forces the toggle back off so the UI doesn't lie about being enabled.
    let pushToken: string | null | undefined;
    const wantsAlerts = merged.nearEnabled || merged.hitEnabled;
    if (wantsAlerts && !prefs.hasToken) {
      const reg = await registerForPushTokenAsync();
      setPermissionStatus(reg.status);
      if (!reg.token) {
        return { ok: false, message: "Notification permission was not granted." };
      }
      // Only resend the token if it's new — avoids hammering the server.
      if (lastTokenSent.current !== reg.token) {
        pushToken = reg.token;
        lastTokenSent.current = reg.token;
      }
    }

    try {
      const body: Record<string, unknown> = { ...next };
      if (pushToken !== undefined) body["expoPushToken"] = pushToken;
      const res = await authFetch(`${API_BASE}/mt5/notifications/prefs`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, message: data.error ?? `HTTP ${res.status}` };
      }
      const data = (await res.json()) as NotificationPrefs;
      setPrefs({ ...DEFAULTS, ...data });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }, [prefs]);

  return React.createElement(
    Ctx.Provider,
    { value: { prefs, loading, permissionStatus, updatePrefs } },
    children,
  );
}

export function useNotificationSettings() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNotificationSettings must be used inside NotificationSettingsProvider");
  return ctx;
}
