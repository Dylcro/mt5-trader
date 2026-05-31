import { Feather } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import Colors from "@/constants/colors";

const C = Colors.dark;

const KEY_LINK_DISMISSED = "onboarding_link_dismissed";
const KEY_SETTINGS_DISMISSED = "onboarding_settings_dismissed";
const KEY_TABS_DISMISSED = "onboarding_tabs_dismissed";

type Step = "link" | "settings" | "tabs";

interface BulletProps {
  icon: string;
  title: string;
  body: string;
}

function Bullet({ icon, title, body }: BulletProps) {
  return (
    <View style={styles.bullet}>
      <View style={styles.bulletIcon}>
        <Feather name={icon as any} size={16} color={C.gold} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.bulletTitle}>{title}</Text>
        <Text style={styles.bulletBody}>{body}</Text>
      </View>
    </View>
  );
}

function CheckboxRow({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <Pressable style={styles.checkRow} onPress={onToggle} hitSlop={8}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked && <Feather name="check" size={11} color="#000" />}
      </View>
      <Text style={styles.checkLabel}>Don't show this again</Text>
    </Pressable>
  );
}

interface OnboardingModalProps {
  accountId: string | null | undefined;
  status: string;
}

export default function OnboardingModal({ accountId, status }: OnboardingModalProps) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<Step>("link");
  const [dontShow, setDontShow] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const [linkVal, settingsVal, tabsVal] = await Promise.all([
        AsyncStorage.getItem(KEY_LINK_DISMISSED),
        AsyncStorage.getItem(KEY_SETTINGS_DISMISSED),
        AsyncStorage.getItem(KEY_TABS_DISMISSED),
      ]);
      if (cancelled) return;
      const linkDismissed = linkVal === "true";
      const settingsDismissed = settingsVal === "true";
      const tabsDismissed = tabsVal === "true";
      const isConnected = !!accountId && status === "connected";

      if (!isConnected && !linkDismissed) {
        setStep("link");
        setVisible(true);
      } else if (isConnected && !settingsDismissed) {
        setStep("settings");
        setVisible(true);
      } else if (isConnected && !tabsDismissed) {
        setStep("tabs");
        setVisible(true);
      }
      setReady(true);
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, [accountId, status]);

  const dismissKey = (s: Step) =>
    s === "link" ? KEY_LINK_DISMISSED : s === "settings" ? KEY_SETTINGS_DISMISSED : KEY_TABS_DISMISSED;

  const handleDismiss = useCallback(async () => {
    if (dontShow) {
      await AsyncStorage.setItem(dismissKey(step), "true");
    }
    const isConnected = !!accountId && status === "connected";
    if (step === "link" && isConnected) {
      setStep("settings");
      setDontShow(false);
      const settingsVal = await AsyncStorage.getItem(KEY_SETTINGS_DISMISSED);
      if (settingsVal !== "true") return;
    }
    if (step === "settings" && isConnected) {
      setStep("tabs");
      setDontShow(false);
      const tabsVal = await AsyncStorage.getItem(KEY_TABS_DISMISSED);
      if (tabsVal !== "true") return;
    }
    setVisible(false);
  }, [accountId, dontShow, status, step]);

  if (!ready) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setVisible(false)}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.accentBar} />
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} bounces={false}>
            {step === "link" && (
              <>
                <View style={styles.iconCircle}>
                  <Feather name="link" size={26} color={C.gold} />
                </View>
                <Text style={styles.title}>Welcome to XAUUSD Trader</Text>
                <Text style={styles.subtitle}>Link your MT5 account before you trade.</Text>
                <View style={styles.bullets}>
                  <Bullet icon="settings" title="Open Settings" body="Use the Settings tab to enter MT5 credentials." />
                  <Bullet icon="user" title="Account details" body="Login, password, and server from your broker." />
                  <Bullet icon="globe" title="Region" body="Pick the region closest to your broker server." />
                  <Bullet icon="zap" title="Connect" body="Live prices appear when status shows connected." />
                </View>
              </>
            )}
            {step === "settings" && (
              <>
                <View style={styles.iconCircle}>
                  <Feather name="sliders" size={26} color={C.gold} />
                </View>
                <Text style={styles.title}>Configure cascade settings</Text>
                <Text style={styles.subtitle}>Tune SL, entries, and take-profit levels before your first trade.</Text>
                <View style={styles.bullets}>
                  <Bullet icon="shield" title="Stop loss" body="Shared SL pips across all cascade limit orders." />
                  <Bullet icon="layers" title="Cascade entries" body="Number of limits and pip spacing between entries." />
                  <Bullet icon="target" title="TP1–TP4" body="Partial close distances; TP2 moves SL to break-even." />
                  <Bullet icon="trending-up" title="TP4 open" body="Set TP4 to 0 to leave the final 25% manual." />
                </View>
              </>
            )}
            {step === "tabs" && (
              <>
                <View style={styles.iconCircle}>
                  <Feather name="grid" size={26} color={C.gold} />
                </View>
                <Text style={styles.title}>Explore your tabs</Text>
                <Text style={styles.subtitle}>New screens help you monitor performance and history.</Text>
                <View style={styles.bullets}>
                  <Bullet icon="bar-chart-2" title="Dashboard" body="Account equity, balance, and connection at a glance." />
                  <Bullet icon="clock" title="History" body="Review closed cascade zones and final TP reached." />
                  <Bullet icon="message-circle" title="Assistant" body="Tap the gold chat button for cascade and MT5 help." />
                  <Bullet icon="bell" title="Alerts" body="Enable TP notifications in Settings when you're ready." />
                </View>
              </>
            )}
            <CheckboxRow checked={dontShow} onToggle={() => setDontShow((v) => !v)} />
            <Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.8 }]} onPress={() => void handleDismiss()}>
              <Text style={styles.btnText}>{step === "tabs" ? "Start trading" : "Next"}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: C.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    overflow: "hidden",
    maxHeight: "85%",
  },
  accentBar: { height: 3, backgroundColor: C.gold },
  content: { padding: 24, paddingBottom: 20 },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(201,168,76,0.12)",
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.3)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
    alignSelf: "center",
  },
  title: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: C.text,
    textAlign: "center",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 20,
  },
  bullets: { gap: 16, marginBottom: 24 },
  bullet: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  bulletIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "rgba(201,168,76,0.1)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: 1,
  },
  bulletTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
    marginBottom: 3,
  },
  bulletBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 18,
  },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 16 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.surface,
  },
  checkboxChecked: { backgroundColor: C.gold, borderColor: C.gold },
  checkLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: C.textSecondary },
  btn: { backgroundColor: C.gold, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  btnText: { fontSize: 16, fontFamily: "Inter_700Bold", color: "#000", letterSpacing: 0.5 },
});
