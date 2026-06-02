import { Link, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
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

import { useAuth } from "@/context/AuthContext";
import { usePlatformStatus } from "@/hooks/usePlatformStatus";

const GOLD = "#C9A84C";
const BG = "#0A0A0F";
const CARD = "#111118";
const BORDER = "#1E1E2E";
const TEXT = "#F0EFE7";
const MUTED = "#6E6E8A";
const RED = "#FF4757";

export default function SignUpScreen() {
  const { isSignedIn, signUp } = useAuth();
  const { status: platformStatus } = usePlatformStatus();
  const params = useLocalSearchParams<{ inviteCode?: string; code?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const initialInvite =
    (typeof params.inviteCode === "string" ? params.inviteCode : "") ||
    (typeof params.code === "string" ? params.code : "");
  const [inviteCode, setInviteCode] = useState(initialInvite);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isSignedIn) router.replace("/" as never);
  }, [isSignedIn, router]);

  const handleSignUp = async () => {
    if (!fullName.trim() || fullName.trim().length < 2) { setError("Please enter your full name."); return; }
    if (!email.trim()) { setError("Please enter your email address."); return; }
    if (!password || password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setLoading(true);
    setError("");
    const result = await signUp(fullName.trim(), email.trim(), password, inviteCode.trim() || undefined);
    setLoading(false);

    if (result.error) {
      setError(result.error);
    } else {
      router.replace("/" as never);
    }
  };

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
          <Text style={styles.title}>Create account</Text>
          <Text style={styles.subtitle}>Connect your MT5 account and start trading</Text>

          <Text style={styles.label}>Full Name</Text>
          <TextInput
            style={styles.input}
            value={fullName}
            onChangeText={setFullName}
            placeholder="Your full name"
            placeholderTextColor={MUTED}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="next"
          />

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
            returnKeyType="next"
          />

          <Text style={styles.label}>
            {platformStatus.invite_only ? "Invite code (required)" : "Invite code (if you were sent one)"}
          </Text>
          <TextInput
            style={styles.input}
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder={platformStatus.invite_only ? "Paste code from your invite" : "Optional"}
            placeholderTextColor={MUTED}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Password</Text>
          <View style={styles.pwWrap}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={password}
              onChangeText={setPassword}
              placeholder="8+ characters"
              placeholderTextColor={MUTED}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={handleSignUp}
            />
            <Pressable onPress={() => setShowPassword((s) => !s)} style={styles.eyeBtn} hitSlop={8}>
              <Text style={{ color: MUTED, fontSize: 12 }}>{showPassword ? "HIDE" : "SHOW"}</Text>
            </Pressable>
          </View>

          {error ? (
            <View>
              <Text style={styles.error}>{error}</Text>
              {error.toLowerCase().includes("already exists") && (
                <View style={{ flexDirection: "row", justifyContent: "center", marginTop: 4 }}>
                  <Text style={{ color: MUTED, fontSize: 12 }}>Have an account? </Text>
                  <Link href="/(auth)/sign-in">
                    <Text style={[styles.link, { fontSize: 12 }]}>Sign in instead</Text>
                  </Link>
                </View>
              )}
            </View>
          ) : null}

          <Pressable
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleSignUp}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.btnText}>Create Account</Text>}
          </Pressable>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Already have an account? </Text>
            <Link href="/(auth)/sign-in">
              <Text style={styles.link}>Sign in</Text>
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
  error: { color: RED, fontSize: 12, marginBottom: 6, marginTop: 8 },
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
});
