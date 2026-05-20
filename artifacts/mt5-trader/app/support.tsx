import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";

const C = Colors.dark;
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

type SubmitState = "idle" | "sending" | "sent" | "error";

export default function SupportScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [query, setQuery] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit() {
    if (!name.trim()) {
      setErrorMsg("Please enter your name.");
      return;
    }
    if (!query.trim()) {
      setErrorMsg("Please describe your issue or question.");
      return;
    }
    setErrorMsg("");
    setSubmitState("sending");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      const res = await fetch(`${API_URL}/support`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || undefined,
          query: query.trim(),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error ?? "Something went wrong. Please try again.");
        setSubmitState("error");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      setSubmitState("sent");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      setErrorMsg("Could not connect to the server. Check your internet connection.");
      setSubmitState("error");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={C.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Help & Support</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        {submitState === "sent" ? (
          <View style={styles.successBox}>
            <View style={styles.successIcon}>
              <Feather name="check-circle" size={40} color={C.buy} />
            </View>
            <Text style={styles.successTitle}>Request Received</Text>
            <Text style={styles.successBody}>
              Thanks for reaching out. We'll get back to you as soon as possible.
            </Text>
            <Pressable
              style={styles.doneBtn}
              onPress={() => router.replace("/(tabs)/settings" as never)}
            >
              <Text style={styles.doneBtnText}>Back to Settings</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.intro}>
              Having an issue or a question? Fill in the form below and we'll get back to you.
            </Text>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Your Name *</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. John Smith"
                placeholderTextColor={C.textMuted}
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email Address</Text>
              <Text style={styles.fieldHint}>Optional — so we can reply to you directly</Text>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor={C.textMuted}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                returnKeyType="next"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Your Question or Issue *</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Describe what you need help with…"
                placeholderTextColor={C.textMuted}
                value={query}
                onChangeText={setQuery}
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />
            </View>

            {(submitState === "error" || errorMsg) && (
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={14} color={C.sell} />
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.submitBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                submitState === "sending" && { opacity: 0.6 },
              ]}
              onPress={handleSubmit}
              disabled={submitState === "sending"}
            >
              {submitState === "sending" ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Feather name="send" size={15} color="#000" />
              )}
              <Text style={styles.submitBtnText}>
                {submitState === "sending" ? "Sending…" : "Send Request"}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  scroll: {
    padding: 24,
    gap: 20,
  },
  intro: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 22,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
    letterSpacing: 0.2,
  },
  fieldHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: -2,
  },
  input: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.text,
  },
  textArea: {
    minHeight: 120,
    paddingTop: 13,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(239,68,68,0.10)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.3)",
    borderRadius: 10,
    padding: 12,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.sell,
    lineHeight: 20,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.gold,
    borderRadius: 12,
    paddingVertical: 15,
  },
  submitBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#000",
  },
  successBox: {
    alignItems: "center",
    paddingTop: 48,
    gap: 16,
  },
  successIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(34,197,94,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  successTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  successBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    maxWidth: 280,
  },
  doneBtn: {
    marginTop: 12,
    paddingVertical: 13,
    paddingHorizontal: 32,
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  doneBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
});
