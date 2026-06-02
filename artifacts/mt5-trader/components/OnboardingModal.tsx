// XAUUSD Trader — 6-step onboarding wizard (light theme)

import React, { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Linking,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from "react-native";
import Colors from "../constants/colors";
import { usePlatformStatus } from "../hooks/usePlatformStatus";

const colors = Colors.dark;

type Props = {
  visible: boolean;
  onComplete: () => void;
  onConnectMT5?: (creds: {
    login: string;
    password: string;
    server: string;
  }) => Promise<void>;
  onSignIn?: (email: string, password: string) => Promise<void>;
  onCreateAccount?: (fullName: string, email: string, password: string, inviteCode?: string) => Promise<void>;
  /** Pre-filled from /join?code= or admin invite link */
  initialInviteCode?: string;
  termsUrl?: string;
};

const TOTAL_STEPS = 6;

export default function OnboardingModal({
  visible,
  onComplete,
  onConnectMT5,
  onSignIn,
  onCreateAccount,
  initialInviteCode = "",
  termsUrl = "https://meta-trader-link.replit.app/terms",
}: Props) {
  const [step, setStep] = useState(0);

  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [agreed, setAgreed] = useState(false);

  const { status: platformStatus, refresh: refreshPlatformStatus } = usePlatformStatus();
  const [authMode, setAuthMode] = useState<"create" | "signin">("create");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState(initialInviteCode.trim());

  useEffect(() => {
    if (initialInviteCode.trim()) setInviteCode(initialInviteCode.trim());
  }, [initialInviteCode]);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [login, setLogin] = useState("");
  const [mtPassword, setMtPassword] = useState("");
  const [server, setServer] = useState("");
  const [mtBusy, setMtBusy] = useState(false);
  const [mtError, setMtError] = useState<string | null>(null);

  const next = () => setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const handleTermsScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const atBottom =
      layoutMeasurement.height + contentOffset.y >= contentSize.height - 24;
    if (atBottom) setScrolledToBottom(true);
  };

  const doAuth = async () => {
    setAuthError(null);
    if (authMode === "create") {
      if (!fullName.trim() || fullName.trim().length < 2) {
        setAuthError("Enter your full name (at least 2 characters).");
        return;
      }
      // Do not block on cached /system/status — server enforces signups, invite, and cap.
    }
    if (!email.trim() || !password) {
      setAuthError("Enter your email and a password.");
      return;
    }
    if (authMode === "create" && password.length < 8) {
      setAuthError("Password must be at least 8 characters.");
      return;
    }
    setAuthBusy(true);
    try {
      if (authMode === "create") void refreshPlatformStatus();
      if (authMode === "create") {
        await onCreateAccount?.(
          fullName.trim(),
          email.trim(),
          password,
          inviteCode.trim() || undefined,
        );
      } else {
        await onSignIn?.(email.trim(), password);
      }
      next();
    } catch (err: unknown) {
      const fallback =
        authMode === "create"
          ? "Could not create your account. Check your details and try again."
          : "Could not sign you in. Check your email and password.";
      setAuthError(humanError(err) ?? fallback);
    } finally {
      setAuthBusy(false);
    }
  };

  const doConnect = async () => {
    setMtError(null);
    if (!login.trim() || !mtPassword || !server.trim()) {
      setMtError("Fill in your login, password and server name.");
      return;
    }
    if (server.trim().length < 4) {
      setMtError("That server name looks too short — copy it exactly from the MT5 app.");
      return;
    }
    setMtBusy(true);
    try {
      await onConnectMT5?.({
        login: login.trim(),
        password: mtPassword,
        server: server.trim(),
      });
      next();
    } catch (err: unknown) {
      setMtError(
        humanError(err) ??
          "Couldn't connect. Double-check your login, password and server, then try again."
      );
    } finally {
      setMtBusy(false);
    }
  };

  const progress = useMemo(() => (step + 1) / TOTAL_STEPS, [step]);

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <View style={s.root}>
        <View style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${progress * 100}%` }]} />
        </View>

        <View style={s.stepHeader}>
          <Text style={s.stepCount}>
            Step {step + 1} of {TOTAL_STEPS}
          </Text>
        </View>

        {step === 0 && (
          <ScrollView contentContainerStyle={s.body}>
            <View style={s.logoCircle}>
              <Text style={s.logoMark}>✦</Text>
            </View>
            <Text style={s.h1}>Welcome to{"\n"}XAUUSD Trader</Text>
            <Text style={s.lead}>
              Professional cascade trading for gold, connected to your Vantage MT5
              account.
            </Text>
            <View style={s.featureList}>
              <Feature icon="⚡" title="One-tap cascades" desc="Market + limit orders placed together" />
              <Feature icon="🛡️" title="Automatic zones" desc="Take profits and break-even, hands-free" />
              <Feature icon="✦" title="AI assistant" desc="Ask anything about your trades" />
            </View>
            <Pressable onPress={() => Linking.openURL(termsUrl)}>
              <Text style={s.link}>Read the Terms &amp; Conditions</Text>
            </Pressable>
          </ScrollView>
        )}

        {step === 1 && (
          <View style={s.bodyFill}>
            <Text style={s.h2}>Terms &amp; Conditions</Text>
            <Text style={s.sub}>Please scroll to the bottom and tick the box to continue.</Text>
            <ScrollView style={s.termsBox} onScroll={handleTermsScroll} scrollEventThrottle={64}>
              <Text style={s.terms}>{TERMS_TEXT}</Text>
            </ScrollView>
            <Pressable
              style={s.checkRow}
              onPress={() => scrolledToBottom && setAgreed((v) => !v)}
              disabled={!scrolledToBottom}
            >
              <View style={[s.checkbox, agreed && s.checkboxOn, !scrolledToBottom && s.checkboxDisabled]}>
                {agreed && <Text style={s.checkMark}>✓</Text>}
              </View>
              <Text style={[s.checkLabel, !scrolledToBottom && s.checkLabelDisabled]}>
                I have read and agree to the Terms &amp; Conditions
              </Text>
            </Pressable>
            {!scrolledToBottom && (
              <Text style={s.hint}>Scroll to the end of the terms to enable this.</Text>
            )}
          </View>
        )}

        {step === 2 && (
          <ScrollView contentContainerStyle={s.body}>
            <Text style={s.h2}>{authMode === "create" ? "Create your account" : "Sign in"}</Text>
            <View style={s.segment}>
              <SegBtn label="Create account" active={authMode === "create"} onPress={() => setAuthMode("create")} />
              <SegBtn label="Sign in" active={authMode === "signin"} onPress={() => setAuthMode("signin")} />
            </View>
            {authMode === "create" && (
              <Field label="Full name" value={fullName} onChangeText={setFullName} placeholder="Your name"
                autoCapitalize="words" />
            )}
            <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com"
              keyboardType="email-address" autoCapitalize="none" />
            <Field label="Password" value={password} onChangeText={setPassword}
              placeholder={authMode === "create" ? "At least 8 characters" : "••••••••"} secureTextEntry />
            {authMode === "create" && (
              <Field
                label={platformStatus.invite_only ? "Invite code (required)" : "Invite code (if you were sent one)"}
                value={inviteCode}
                onChangeText={setInviteCode}
                placeholder={platformStatus.invite_only ? "Paste code from your invite" : "Optional"}
                autoCapitalize="none"
              />
            )}
            {authError && <Text style={s.error}>{authError}</Text>}
            <Pressable style={[s.primaryBtn, authBusy && s.btnBusy]} onPress={doAuth} disabled={authBusy}>
              {authBusy ? <ActivityIndicator color={colors.onDark} /> :
                <Text style={s.primaryBtnText}>{authMode === "create" ? "Create account" : "Sign in"}</Text>}
            </Pressable>
          </ScrollView>
        )}

        {step === 3 && (
          <ScrollView contentContainerStyle={s.body}>
            <Text style={s.h2}>Find your MT5 details</Text>
            <Text style={s.lead}>You'll need three things from the Vantage MT5 app:</Text>
            <Step n="1" title="Open the MT5 app" desc="On your phone, open MetaTrader 5 (Vantage)." />
            <Step n="2" title="Tap Settings → Accounts" desc="Find the account you trade with." />
            <Step n="3" title="Note the Login number" desc="A long number, e.g. 1009xxxxx." />
            <Step n="4" title="Note the Server name" desc='Copy it exactly, e.g. "VantageInternational-Live 3".' />
            <Step n="5" title="Have your password ready" desc="The master (trading) password, not the investor one." />
            <View style={s.infoBox}>
              <Text style={s.infoText}>
                Tip: copy the server name exactly — capitalisation and spaces matter.
              </Text>
            </View>
          </ScrollView>
        )}

        {step === 4 && (
          <ScrollView contentContainerStyle={s.body}>
            <Text style={s.h2}>Connect MT5</Text>
            <Text style={s.sub}>Enter the details you just found.</Text>
            <Field label="Login number" value={login} onChangeText={setLogin}
              placeholder="1009xxxxx" keyboardType="number-pad" />
            <Field label="Master password" value={mtPassword} onChangeText={setMtPassword}
              placeholder="••••••••" secureTextEntry />
            <Field label="Server name" value={server} onChangeText={setServer}
              placeholder="VantageInternational-Live 3" autoCapitalize="none" />
            {mtBusy && (
              <View style={s.progressInline}>
                <View style={s.progressInlineTrack}>
                  <View style={s.progressInlineFill} />
                </View>
                <Text style={s.sub}>Connecting to your broker…</Text>
              </View>
            )}
            {mtError && <Text style={s.error}>{mtError}</Text>}
            <Pressable style={[s.primaryBtn, mtBusy && s.btnBusy]} onPress={doConnect} disabled={mtBusy}>
              {mtBusy ? <ActivityIndicator color={colors.onDark} /> :
                <Text style={s.primaryBtnText}>Connect</Text>}
            </Pressable>
          </ScrollView>
        )}

        {step === 5 && (
          <ScrollView contentContainerStyle={s.body}>
            <Text style={s.h2}>You're all set 🎉</Text>
            <Text style={s.lead}>Here's what each tab does:</Text>
            <Step n="📈" title="Trade" desc="Place cascades with one tap. Live bid/ask up top." />
            <Step n="📋" title="Positions" desc="See open trades, live P&L and zone status." />
            <Step n="📊" title="Dashboard" desc="Balance, equity, win rate at a glance." />
            <Step n="🕐" title="History" desc="Every closed zone and which TPs it hit." />
            <Step n="⚙️" title="Settings" desc="Cascade config, zone TPs, biometric lock." />
            <View style={s.infoBox}>
              <Text style={s.infoText}>
                Tip: try everything on a demo account first. Tap the ✦ button any time to ask the AI assistant.
              </Text>
            </View>
          </ScrollView>
        )}

        <View style={s.footer}>
          {step > 0 ? (
            <Pressable style={s.ghostBtn} onPress={back}>
              <Text style={s.ghostBtnText}>Back</Text>
            </Pressable>
          ) : (
            <View style={{ flex: 1 }} />
          )}

          {step !== 2 && step !== 4 && (
            <Pressable
              style={[
                s.nextBtn,
                step === 1 && !(scrolledToBottom && agreed) && s.nextDisabled,
              ]}
              disabled={step === 1 && !(scrolledToBottom && agreed)}
              onPress={() => {
                if (step === TOTAL_STEPS - 1) onComplete();
                else next();
              }}
            >
              <Text style={s.nextText}>
                {step === TOTAL_STEPS - 1 ? "Start trading" : "Continue"}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Feature({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <View style={s.feature}>
      <View style={s.featureIcon}><Text style={{ fontSize: 16 }}>{icon}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={s.featureTitle}>{title}</Text>
        <Text style={s.featureDesc}>{desc}</Text>
      </View>
    </View>
  );
}

function Step({ n, title, desc }: { n: string; title: string; desc: string }) {
  return (
    <View style={s.stepRow}>
      <View style={s.stepNum}><Text style={s.stepNumText}>{n}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={s.stepTitle}>{title}</Text>
        <Text style={s.stepDesc}>{desc}</Text>
      </View>
    </View>
  );
}

function Field(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.input}
        placeholderTextColor={colors.textMuted}
        {...rest}
      />
    </View>
  );
}

function SegBtn({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[s.segBtn, active && s.segBtnOn]} onPress={onPress}>
      <Text style={[s.segText, active && s.segTextOn]}>{label}</Text>
    </Pressable>
  );
}

function humanError(err: unknown): string | null {
  const raw = err instanceof Error ? err.message.trim() : String(err).trim();
  if (!raw) return null;
  const msg = raw.toLowerCase();
  if (msg.includes("invalid") && msg.includes("password")) return "That password wasn't accepted.";
  if (msg.includes("server") && !msg.includes("invite")) return "Couldn't reach that server — check the server name.";
  if (msg.includes("network") || msg.includes("timeout")) return "Network problem — check your connection and retry.";
  if (msg.includes("already exists")) return "An account with that email already exists — switch to Sign in.";
  if (msg.includes("invite code")) return raw;
  if (msg.includes("waitlist") || msg.includes("registration is closed") || msg.includes("we're full")) return raw;
  if (msg.includes("full name") || msg.includes("password must") || msg.includes("valid email")) return raw;
  // Show the API message (registration failed, locked, etc.) instead of a generic sign-in line.
  return raw;
}

const TERMS_TEXT = `XAUUSD Trader — Terms & Conditions

1. Not financial advice. This app is an execution and educational tool. Nothing in it is financial, investment or trading advice. You trade entirely at your own risk.

2. No liability for losses. Trading leveraged products such as gold (XAUUSD) carries a high risk of loss. You may lose more than expected. We accept no liability for any losses, missed trades, or costs arising from use of the app.

3. Demo first. You should test all features on a demo account before trading real funds.

4. Latency & slippage. Orders are routed to your broker over the internet. Prices, fills, slippage and execution speed depend on your broker, connection and market conditions, and are outside our control.

5. High-volatility news. Avoid trading around major news releases where spreads widen and slippage increases. Cascade and zone logic may behave unexpectedly in fast markets.

6. App availability. The app and its servers may be unavailable, delayed, or interrupted. We do not guarantee uptime and are not responsible for consequences of downtime.

7. Broker relationship. Your account, funds and trades are held with your broker (Vantage). We are not your broker and do not hold your funds. Your broker's terms apply.

8. Your credentials. You are responsible for keeping your login details secure. The app stores MT5 credentials in encrypted form for the sole purpose of connecting to your account.

9. Educational purpose. Features such as the AI assistant provide general information only and may be incomplete or wrong. Always verify before acting.

10. Acceptance. By ticking the box below you confirm you have read, understood and agree to these terms, and that you are using the app at your own risk.

(End of terms — you may now tick the box.)`;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingTop: 56 },
  progressTrack: { height: 4, backgroundColor: colors.border, marginHorizontal: 20, borderRadius: 2, overflow: "hidden" },
  progressFill: { height: 4, backgroundColor: colors.gold, borderRadius: 2 },
  stepHeader: { paddingHorizontal: 24, paddingTop: 10 },
  stepCount: { fontSize: 11, color: colors.textMuted, letterSpacing: 1, textTransform: "uppercase", fontWeight: "600" },

  body: { paddingHorizontal: 24, paddingTop: 14, paddingBottom: 28 },
  bodyFill: { flex: 1, paddingHorizontal: 24, paddingTop: 14 },

  logoCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.navy, alignItems: "center", justifyContent: "center", marginBottom: 18 },
  logoMark: { fontSize: 28, color: colors.gold, fontWeight: "700" },

  h1: { fontSize: 30, fontWeight: "800", color: colors.text, lineHeight: 34, marginBottom: 10 },
  h2: { fontSize: 24, fontWeight: "800", color: colors.text, marginBottom: 6 },
  lead: { fontSize: 15, color: colors.textSecondary, lineHeight: 22, marginBottom: 18 },
  sub: { fontSize: 13, color: colors.textMuted, marginBottom: 14 },

  featureList: { gap: 12, marginBottom: 18 },
  feature: { flexDirection: "row", gap: 12, alignItems: "center", backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 12 },
  featureIcon: { width: 34, height: 34, borderRadius: 9, backgroundColor: colors.goldLight, alignItems: "center", justifyContent: "center" },
  featureTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  featureDesc: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },

  link: { fontSize: 14, color: colors.gold, fontWeight: "600", textDecorationLine: "underline" },

  termsBox: { flex: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 14 },
  terms: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },

  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
  checkboxOn: { backgroundColor: colors.buy, borderColor: colors.buy },
  checkboxDisabled: { opacity: 0.4 },
  checkMark: { color: colors.onDark, fontWeight: "800", fontSize: 14 },
  checkLabel: { flex: 1, fontSize: 14, color: colors.text },
  checkLabelDisabled: { color: colors.textMuted },
  hint: { fontSize: 12, color: colors.textMuted, marginTop: 4, paddingBottom: 8 },

  segment: { flexDirection: "row", backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 3, gap: 3, marginBottom: 16 },
  segBtn: { flex: 1, paddingVertical: 9, alignItems: "center", borderRadius: 9 },
  segBtnOn: { backgroundColor: colors.gold },
  segText: { fontSize: 13, fontWeight: "600", color: colors.textSecondary },
  segTextOn: { color: colors.onDark },

  fieldLabel: { fontSize: 11, fontWeight: "600", color: colors.textSecondary, marginBottom: 6, letterSpacing: 0.4, textTransform: "uppercase" },
  input: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.text },

  primaryBtn: { backgroundColor: colors.navy, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  primaryBtnText: { color: colors.onDark, fontSize: 15, fontWeight: "700" },
  btnBusy: { opacity: 0.7 },

  progressInline: { marginVertical: 12, gap: 8 },
  progressInlineTrack: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: "hidden" },
  progressInlineFill: { height: 6, width: "70%", backgroundColor: colors.gold, borderRadius: 3 },

  error: { color: colors.sell, fontSize: 13, marginVertical: 8 },

  stepRow: { flexDirection: "row", gap: 12, marginBottom: 14, alignItems: "flex-start" },
  stepNum: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.goldLight, alignItems: "center", justifyContent: "center" },
  stepNumText: { fontSize: 14, fontWeight: "700", color: colors.gold },
  stepTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  stepDesc: { fontSize: 13, color: colors.textSecondary, marginTop: 1, lineHeight: 18 },

  infoBox: { backgroundColor: colors.goldLight, borderColor: colors.goldBorder, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8 },
  infoText: { fontSize: 13, color: colors.textSecondary, lineHeight: 19 },

  footer: { flexDirection: "row", gap: 12, alignItems: "center", paddingHorizontal: 24, paddingVertical: 16, borderTopColor: colors.border, borderTopWidth: 1, backgroundColor: colors.card },
  ghostBtn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10 },
  ghostBtnText: { fontSize: 15, color: colors.textSecondary, fontWeight: "600" },
  nextBtn: { flex: 1, backgroundColor: colors.gold, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  nextDisabled: { opacity: 0.4 },
  nextText: { color: colors.onDark, fontSize: 15, fontWeight: "700" },
});
