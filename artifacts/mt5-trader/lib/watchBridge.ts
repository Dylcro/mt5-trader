import { NativeModules, Platform } from "react-native";

type SessionPayload = {
  token: string | null;
  apiBase: string | null;
  accountId: string | null;
  region: string | null;
};

type BridgeNative = {
  publishSession: (payload: Record<string, string>) => Promise<boolean>;
};

function getBridge(): BridgeNative | null {
  if (Platform.OS !== "ios") return null;
  const mod = (NativeModules as Record<string, unknown>)["MT5WatchBridge"];
  if (!mod) return null;
  return mod as BridgeNative;
}

let lastSent = "";

/**
 * Push the current session to the paired Apple Watch via the iOS-side
 * MT5WatchBridge (WatchConnectivity applicationContext). Safely no-ops when:
 *   - not running on iOS
 *   - running in Expo Go (the native module isn't linked — that's a dev build only)
 *   - the payload is unchanged since the last call (avoids spamming WC)
 *
 * Call from the (tabs) layout whenever token, accountId, or region changes.
 */
export async function publishWatchSession(payload: SessionPayload): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  const clean: Record<string, string> = {};
  if (payload.token) clean.token = payload.token;
  if (payload.apiBase) clean.apiBase = payload.apiBase;
  if (payload.accountId) clean.accountId = payload.accountId;
  if (payload.region) clean.region = payload.region;
  const fingerprint = JSON.stringify(clean);
  if (fingerprint === lastSent) return;
  try {
    await bridge.publishSession(clean);
    lastSent = fingerprint;
  } catch {
    // WC not paired / watch not installed yet — ignore.
  }
}
