import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { getAuthToken } from "@/lib/authToken";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return fetch(url, { ...options, headers });
}

/** Request iOS permission, obtain Expo push token, register on server for this account. */
export async function registerPushToken(accountId: string): Promise<void> {
  if (!API_BASE || !accountId) return;
  if (!Device.isDevice) {
    console.log("[push] skipping — not a real device");
    return;
  }
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("tp-alerts", {
      name: "TP alerts",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      enableVibrate: true,
    });
  }
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") {
    console.log("[push] permission denied");
    return;
  }
  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
    (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
  try {
    const push = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    console.log("[push] token registered:", push.data);
    await authFetch(`${API_BASE}/mt5/account/${encodeURIComponent(accountId)}/push-token`, {
      method: "POST",
      body: JSON.stringify({ token: push.data }),
    });
    // Keep notification_prefs in sync for near/hit toggles.
    await authFetch(`${API_BASE}/mt5/notifications/prefs`, {
      method: "PUT",
      body: JSON.stringify({ expoPushToken: push.data }),
    }).catch(() => {});
  } catch (e) {
    console.warn("[push] register failed:", (e as Error).message);
  }
}
