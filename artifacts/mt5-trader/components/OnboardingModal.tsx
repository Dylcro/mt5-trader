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

interface CheckboxRowProps {
  checked: boolean;
  onToggle: () => void;
}

function CheckboxRow({ checked, onToggle }: CheckboxRowProps) {
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
  const [step, setStep] = useState<"link" | "settings">("link");
  const [dontShow, setDontShow] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const [linkVal, settingsVal] = await Promise.all([
        AsyncStorage.getItem(KEY_LINK_DISMISSED),
        AsyncStorage.getItem(KEY_SETTINGS_DISMISSED),
      ]);
      if (cancelled) return;
      const linkDismissed = linkVal === "true";
      const settingsDismissed = settingsVal === "true";
      const isConnected = !!accountId && status === "connected";

      if (!isConnected && !linkDismissed) {
        setStep("link");
        setVisible(true);
      } else if (isConnected && !settingsDismissed) {
        setStep("settings");
        setVisible(true);
      }
      setReady(true);
    }
    void check();
    return () => { cancelled = true; };
  }, [accountId, status]);

  const handleDismiss = useCallback(async () => {
    if (dontShow) {
      await AsyncStorage.setItem(
        step === "link" ? KEY_LINK_DISMISSED : KEY_SETTINGS_DISMISSED,
        "true",
      );
    }
    setVisible(false);
  }, [dontShow, step]);

  if (!ready) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => setVisible(false)}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          {/* Gold accent bar */}
          <View style={styles.accentBar} />

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.content}
            bounces={false}
          >
            {step === "link" ? (
              <>
                <View style={styles.iconCircle}>
                  <Feather name="link" size={26} color={C.gold} />
                </View>
                <Text style={styles.title}>Welcome to MT5 Trader</Text>
                <Text style={styles.subtitle}>
                  Before you can trade, you need to link your MT5 account.
                </Text>

                <View style={styles.bullets}>
                  <Bullet
                    icon="settings"
                    title="Open Settings"
                    body="Tap the Settings tab in the bottom-right corner of the screen."
                  />
                  <Bullet
                    icon="user"
                    title="Enter Your Account Details"
                    body="Fill in your MT5 Account ID, Login, Password, and Server name from your broker."
                  />
                  <Bullet
                    icon="globe"
                    title="Choose Your Region"
                    body="Select the region closest to your broker's server for the best connection speed."
                  />
                  <Bullet
                    icon="zap"
                    title="Tap Connect"
                    body="Your live price feed and account data will appear as soon as the link is active."
                  />
                </View>
              </>
            ) : (
              <>
                <View style={styles.iconCircle}>
                  <Feather name="sliders" size={26} color={C.gold} />
                </View>
                <Text style={styles.title}>Configure Your Settings</Text>
                <Text style={styles.subtitle}>
                  Your account is connected. Tune these settings before placing your first cascade trade.
                </Text>

                <View style={styles.bullets}>
                  <Bullet
                    icon="shield"
                    title="Stop Loss (SL Pips)"
                    body="How many pips below (buy) or above (sell) your entry the shared stop loss is placed across all cascade orders."
                  />
                  <Bullet
                    icon="layers"
                    title="Cascade Entries"
                    body="Choose how many limit orders to layer (e.g. 5) and the pip gap between each entry level."
                  />
                  <Bullet
                    icon="target"
                    title="Take Profit Levels (TP1–TP4)"
                    body="Set pip distances for each 25% partial close. TP2 automatically moves your SL to break-even once hit."
                  />
                  <Bullet
                    icon="trending-up"
                    title="TP4 — Leave It Open"
                    body="Set TP4 to 0 pips to leave the final 25% running with no auto-close. You close it manually."
                  />
                </View>
              </>
            )}

            <CheckboxRow checked={dontShow} onToggle={() => setDontShow((v) => !v)} />

            <Pressable
              style={({ pressed }) => [styles.btn, pressed && { opacity: 0.8 }]}
              onPress={handleDismiss}
            >
              <Text style={styles.btnText}>Got it</Text>
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
  accentBar: {
    height: 3,
    backgroundColor: C.gold,
  },
  content: {
    padding: 24,
    paddingBottom: 20,
  },
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
  bullets: {
    gap: 16,
    marginBottom: 24,
  },
  bullet: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
  },
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
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
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
  checkboxChecked: {
    backgroundColor: C.gold,
    borderColor: C.gold,
  },
  checkLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  btn: {
    backgroundColor: C.gold,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#000",
    letterSpacing: 0.5,
  },
});
