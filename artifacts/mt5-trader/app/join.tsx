import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";

import { storePendingInviteCode } from "@/lib/inviteStorage";

/** Deep link /join?code=DEMO2026 — saves code and opens sign-up (or onboarding will read it). */
export default function JoinScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; inviteCode?: string }>();

  useEffect(() => {
    const code =
      (typeof params.code === "string" ? params.code : "") ||
      (typeof params.inviteCode === "string" ? params.inviteCode : "");
    void (async () => {
      if (code.trim()) await storePendingInviteCode(code);
      router.replace({
        pathname: "/(auth)/sign-up",
        params: code.trim() ? { code: code.trim() } : {},
      } as never);
    })();
  }, [params.code, params.inviteCode, router]);

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0A0A0F" }}>
      <ActivityIndicator color="#C9A84C" />
    </View>
  );
}
