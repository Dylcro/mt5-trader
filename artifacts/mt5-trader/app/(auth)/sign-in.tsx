import { useAuth, useSignIn } from "@clerk/expo";
import { Link, useRouter } from "expo-router";
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

const GOLD = "#C9A84C";
const BG = "#0A0A0F";
const CARD = "#111118";
const BORDER = "#1E1E2E";
const TEXT = "#F0EFE7";
const MUTED = "#6E6E8A";
const RED = "#FF4757";

type Step = "credentials" | "code";

function clerkError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (Array.isArray(e["errors"])) {
      const first = (e["errors"] as Record<string, unknown>[])[0];
      if (first && typeof first["longMessage"] === "string") return first["longMessage"];
      if (first && typeof first["message"] === "string") return first["message"];
    }
    if (typeof e["longMessage"] === "string") return e["longMessage"];
    if (typeof e["message"] === "string") return e["message"];
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}

export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const { isSignedIn, signOut } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isSignedIn) router.replace("/" as never);
  }, [isSignedIn, router]);

  const handleSignIn = async () => {
    if (!email.trim()) { setError("Please enter your email address."); return; }
    if (!password) { setError("Please enter a password."); return; }

    setLoading(true);
    setError("");
    try {
      if (!signIn) throw new Error("Auth not initialised — please refresh the page and try again.");
      const result = await signIn.create({ identifier: email.trim(), password });

      if (result.status === "complete") {
        await setActive!({ session: result.createdSessionId });
        router.replace("/" as never);
        return;
      }

      if (result.status === "needs_first_factor") {
        const factors = result.supportedFirstFactors as Array<Record<string, unknown>> | undefined;

        // Password strategy — attempt it explicitly
        const pwFactor = factors?.find((f) => f["strategy"] === "password");
        if (pwFactor) {
          const pwResult = await signIn.attemptFirstFactor({
            strategy: "password",
            password,
          } as never);
          if (pwResult.status === "complete") {
            await setActive!({ session: pwResult.createdSessionId });
            router.replace("/" as never);
            return;
          }
          if (pwResult.status === "needs_second_factor") {
            setError("Two-factor auth is required. Please disable 2FA in your account settings.");
            return;
          }
        }

        // Email code strategy — send OTP
        const emailFactor = factors?.find((f) => f["strategy"] === "email_code");
        if (emailFactor && typeof emailFactor["emailAddressId"] === "string") {
          await signIn.prepareFirstFactor({
            strategy: "email_code",
            emailAddressId: emailFactor["emailAddressId"] as string,
          });
          setStep("code");
          return;
        }

        const strategies = factors?.map((f) => f["strategy"]).join(", ") || "none";
        setError(`Unsupported sign-in method (${strategies}). Please contact support.`);
        return;
      }

      if (result.status === "needs_second_factor") {
        setError("Two-factor auth is required. Please disable 2FA in your account settings.");
        return;
      }

      setError(`Sign-in returned unexpected status: ${result.status ?? "unknown"}. Please try again.`);
    } catch (err: unknown) {
      const msg = clerkError(err);
      if (msg.toLowerCase().includes("already signed in")) {
        router.replace("/" as never);
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!signIn) return;
    setError("");
    try {
      const factors = signIn.supportedFirstFactors as Array<Record<string, unknown>> | undefined;
      const emailFactor = factors?.find((f) => f["strategy"] === "email_code");
      if (emailFactor && typeof emailFactor["emailAddressId"] === "string") {
        await signIn.prepareFirstFactor({
          strategy: "email_code",
          emailAddressId: emailFactor["emailAddressId"] as string,
        });
      }
    } catch (err) {
      setError(clerkError(err));
    }
  };

  const handleVerifyCode = async () => {
    if (!signIn || !setActive) return;
    setLoading(true);
    setError("");
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: "email_code",
        code: verifyCode.trim(),
      });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        router.replace("/" as never);
        return;
      }
      setError("Verification failed. Please try again.");
    } catch (err) {
      setError(clerkError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    try { await signOut(); } catch {}
    router.replace("/sign-in" as never);
  };

  const handleStartOver = () => {
    setStep("credentials");
    setVerifyCode("");
    setError("");
  };

  if (step === "code") {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 20 }]}>
        <View style={styles.card}>
          <Text style={styles.logo}>XAUUSD</Text>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>Enter the code we sent to {email}</Text>

          <Text style={styles.label}>Verification Code</Text>
          <TextInput
            style={styles.input}
            value={verifyCode}
            onChangeText={setVerifyCode}
            placeholder="000000"
            placeholderTextColor={MUTED}
            keyboardType="number-pad"
            autoFocus
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.btn, (loading || verifyCode.length < 4) && styles.btnDisabled]}
            onPress={handleVerifyCode}
            disabled={loading || verifyCode.length < 4}
          >
            {loading
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.btnText}>Verify</Text>}
          </Pressable>

          <Pressable onPress={handleResendCode} style={styles.linkBtn}>
            <Text style={styles.link}>Resend code</Text>
          </Pressable>
          <Pressable onPress={handleStartOver} style={styles.linkBtn}>
            <Text style={styles.link}>Use a different email</Text>
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

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleSignIn}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#000" />
              : <Text style={styles.btnText}>Sign In</Text>}
          </Pressable>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Don&apos;t have an account? </Text>
            <Link href="/(auth)/sign-up">
              <Text style={styles.link}>Create one</Text>
            </Link>
          </View>
          <Pressable onPress={handleSignOut} style={styles.linkBtn}>
            <Text style={[styles.link, { color: MUTED, fontSize: 12 }]}>Sign out of existing session</Text>
          </Pressable>
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
  error: { color: RED, fontSize: 12, marginBottom: 6, marginTop: 4 },
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
