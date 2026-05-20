import { useSignIn } from "@clerk/expo";
import { Link, useRouter } from "expo-router";
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

const GOLD = "#C9A84C";
const BG = "#0A0A0F";
const CARD = "#111118";
const BORDER = "#1E1E2E";
const TEXT = "#F0EFE7";
const MUTED = "#6E6E8A";
const RED = "#FF4757";

export default function SignInScreen() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");

  const handleSubmit = async () => {
    const { error } = await signIn.password({ emailAddress: email, password });
    if (error) return;

    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: ({ decorateUrl }) => {
          const url = decorateUrl("/");
          router.replace(url as never);
        },
      });
    } else if (signIn.status === "needs_client_trust") {
      await signIn.mfa.sendEmailCode();
    }
  };

  const handleVerify = async () => {
    await signIn.mfa.verifyEmailCode({ code: verifyCode });
    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: ({ decorateUrl }) => {
          const url = decorateUrl("/");
          router.replace(url as never);
        },
      });
    }
  };

  const isLoading = fetchStatus === "fetching";
  const canSubmit = email.trim() !== "" && password !== "" && !isLoading;

  if (signIn.status === "needs_client_trust") {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 20 }]}>
        <View style={styles.card}>
          <Text style={styles.logo}>XAUUSD</Text>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>Enter the code we sent to {email}</Text>

          <TextInput
            style={styles.input}
            value={verifyCode}
            onChangeText={setVerifyCode}
            placeholder="000000"
            placeholderTextColor={MUTED}
            keyboardType="number-pad"
            autoFocus
          />
          {errors.fields.code && <Text style={styles.error}>{errors.fields.code.message}</Text>}

          <Pressable
            style={[styles.btn, isLoading && styles.btnDisabled]}
            onPress={handleVerify}
            disabled={isLoading}
          >
            {isLoading ? <ActivityIndicator color="#000" /> : <Text style={styles.btnText}>Verify</Text>}
          </Pressable>

          <Pressable onPress={() => signIn.mfa.sendEmailCode()} style={styles.linkBtn}>
            <Text style={styles.link}>Resend code</Text>
          </Pressable>
          <Pressable onPress={() => signIn.reset()} style={styles.linkBtn}>
            <Text style={styles.link}>Start over</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.logo}>XAUUSD</Text>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to access your trading account</Text>

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={MUTED}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {errors.fields.identifier && <Text style={styles.error}>{errors.fields.identifier.message}</Text>}

          <Text style={styles.label}>Password</Text>
          <View style={styles.pwWrap}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={MUTED}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
            />
            <Pressable onPress={() => setShowPassword((s) => !s)} style={styles.eyeBtn} hitSlop={8}>
              <Text style={{ color: MUTED, fontSize: 12 }}>{showPassword ? "HIDE" : "SHOW"}</Text>
            </Pressable>
          </View>
          {errors.fields.password && <Text style={styles.error}>{errors.fields.password.message}</Text>}

          <Pressable
            style={[styles.btn, !canSubmit && styles.btnDisabled]}
            onPress={handleSubmit}
            disabled={!canSubmit}
          >
            {isLoading
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.btnText}>Sign In</Text>}
          </Pressable>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Don&apos;t have an account? </Text>
            <Link href="/(auth)/sign-up">
              <Text style={styles.link}>Create one</Text>
            </Link>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  scroll: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 20 },
  card: {
    backgroundColor: CARD,
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: BORDER,
  },
  logo: {
    fontSize: 13,
    fontWeight: "700",
    color: GOLD,
    letterSpacing: 3,
    marginBottom: 20,
    textAlign: "center",
  },
  title: { fontSize: 24, fontWeight: "700", color: TEXT, textAlign: "center", marginBottom: 6 },
  subtitle: { fontSize: 13, color: MUTED, textAlign: "center", marginBottom: 24 },
  label: { fontSize: 12, fontWeight: "600", color: MUTED, marginBottom: 6, marginTop: 12, letterSpacing: 0.5 },
  input: {
    backgroundColor: BG,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: TEXT,
    fontSize: 15,
    marginBottom: 4,
  },
  pwWrap: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  eyeBtn: { paddingHorizontal: 4 },
  error: { color: RED, fontSize: 12, marginBottom: 6 },
  btn: {
    backgroundColor: GOLD,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 20,
  },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: "#000", fontWeight: "700", fontSize: 15 },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 20 },
  footerText: { color: MUTED, fontSize: 13 },
  link: { color: GOLD, fontSize: 13, fontWeight: "600" },
  linkBtn: { alignItems: "center", marginTop: 12 },
});
