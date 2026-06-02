import AsyncStorage from "@react-native-async-storage/async-storage";

export const PENDING_INVITE_CODE_KEY = "pending_invite_code";

export async function storePendingInviteCode(code: string): Promise<void> {
  const trimmed = code.trim();
  if (!trimmed) return;
  await AsyncStorage.setItem(PENDING_INVITE_CODE_KEY, trimmed);
}

export async function loadPendingInviteCode(): Promise<string | null> {
  const v = await AsyncStorage.getItem(PENDING_INVITE_CODE_KEY);
  return v?.trim() || null;
}

export async function clearPendingInviteCode(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_INVITE_CODE_KEY);
}
