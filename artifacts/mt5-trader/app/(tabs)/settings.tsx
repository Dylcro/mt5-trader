import { useAuth } from "@/context/AuthContext";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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

import AsyncStorage from "@react-native-async-storage/async-storage";

import Stepper from "@/components/ui/Stepper";
import Toggle from "@/components/ui/Toggle";
import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";
import { useCascadeSettings } from "@/hooks/useCascadeSettings";
import { useDisplayCurrency } from "@/hooks/useDisplayCurrency";
import {
  runnerRemainderLots,
  validateEnabledTpPips,
  validateTpLots,
} from "@/lib/cascadeTpLots";
import { authFetch } from "@/lib/authFetch";

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? "";
const C = Colors.dark;
const NOTIFY_TP3_KEY = "notify_tp3";
const NOTIFY_R1_KEY = "notify_r1";
const NOTIFY_R2_KEY = "notify_r2";
const NOTIFY_R3_KEY = "notify_r3";

const POPULAR_SERVERS = [
  "VantageInternational-Live",
  "VantageInternational-Live 2",
  "VantageInternational-Live 3",
  "VantageInternational-Live 4",
  "VantageInternational-Live 5",
  "VantageInternational-Live 6",
  "VantageInternational-Live 7",
  "VantageInternational-Live 8",
  "VantageInternational-Live 9",
  "VantageInternational-Live 10",
  "VantageInternational-Live 11",
  "VantageInternational-Live 12",
  "VantageInternational-Live 13",
  "VantageInternational-Live 14",
  "VantageInternational-Live 15",
  "VantageInternational-Live 16",
  "VantageInternational-Demo",
];

function InfoRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, color ? { color } : {}]}>{value}</Text>
    </View>
  );
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string; icon: "wifi" | "loader" | "wifi-off" | "alert-circle" }> = {
    connected: { color: C.buy, label: "Connected", icon: "wifi" },
    connecting: { color: C.gold, label: "Connecting...", icon: "loader" },
    disconnected: { color: C.textSecondary, label: "Disconnected", icon: "wifi-off" },
    error: { color: C.sell, label: "Error", icon: "alert-circle" },
  };
  const cfg = map[status] ?? map.disconnected;
  return (
    <View style={[styles.statusBadge, { borderColor: cfg.color }]}>
      <Feather name={cfg.icon} size={13} color={cfg.color} />
      <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <Text style={styles.sectionTitle}>{title}</Text>
  );
}

function TpLevelRow({
  label,
  enabled,
  lots,
  maxLots,
  pips,
  onToggle,
  onLotsChange,
  onPipsChange,
}: {
  label: string;
  enabled: boolean;
  lots: number;
  maxLots: number;
  pips: number;
  onToggle: (v: boolean) => void;
  onLotsChange: (v: number) => void;
  onPipsChange: (v: number) => void;
}) {
  return (
    <View style={styles.tpLevelBlock}>
      <View style={styles.tpLevelHeader}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Toggle value={enabled} onValueChange={onToggle} color={C.gold} />
      </View>
      {enabled && (
        <View style={styles.tpLevelExpanded}>
          <View style={styles.tpLevelRow}>
            <Text style={styles.tpLevelRowLabel}>Close lots</Text>
            <Stepper
              value={lots}
              onChange={onLotsChange}
              step={0.01}
              min={0.01}
              max={maxLots}
              display={`${lots.toFixed(2)}`}
            />
          </View>
          <View style={styles.tpLevelRow}>
            <Text style={styles.tpLevelRowLabel}>Distance</Text>
            <Stepper
              value={pips}
              onChange={onPipsChange}
              step={5}
              min={5}
              display={`${pips}p`}
            />
          </View>
        </View>
      )}
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useAuth();
  const { credentials, status, errorMsg, accountInfo, connect, disconnect, accountId } = useTrading();
  const { formatMoney } = useDisplayCurrency();
  const {
    settings: cs,
    cascadeLotSize,
    setCascadeLotSize,
    updateSettings,
    saveToServer,
  } = useCascadeSettings();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testNotifState, setTestNotifState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [testNotifError, setTestNotifError] = useState<string | null>(null);

  const runnerLots = runnerRemainderLots(cs, cascadeLotSize);

  const handleSaveSettings = useCallback(async () => {
    const lotsCheck = validateTpLots(cs, cascadeLotSize);
    if (!lotsCheck.ok) {
      Alert.alert("Invalid TP Lots", lotsCheck.message);
      return;
    }
    if (!validateEnabledTpPips(cs)) {
      Alert.alert(
        "Invalid TP Distances",
        "Enabled take-profit levels need increasing pip distances (e.g. TP2 farther than TP1).",
      );
      return;
    }
    setSaveState("saving");
    setSaveError(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await saveToServer();
    if (result.ok) {
      setSaveState("saved");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      setSaveState("error");
      setSaveError(result.message);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
    setTimeout(() => setSaveState("idle"), 4000);
  }, [cs, cascadeLotSize, saveToServer]);

  const [notifyTp3, setNotifyTp3] = useState(true);
  const [notifyR1, setNotifyR1] = useState(true);
  const [notifyR2, setNotifyR2] = useState(true);
  const [notifyR3, setNotifyR3] = useState(true);

  useEffect(() => {
    void AsyncStorage.getMany([NOTIFY_TP3_KEY, NOTIFY_R1_KEY, NOTIFY_R2_KEY, NOTIFY_R3_KEY]).then((r) => {
      if (r[NOTIFY_TP3_KEY] != null) setNotifyTp3(r[NOTIFY_TP3_KEY] === "true");
      if (r[NOTIFY_R1_KEY] != null) setNotifyR1(r[NOTIFY_R1_KEY] === "true");
      if (r[NOTIFY_R2_KEY] != null) setNotifyR2(r[NOTIFY_R2_KEY] === "true");
      if (r[NOTIFY_R3_KEY] != null) setNotifyR3(r[NOTIFY_R3_KEY] === "true");
    });
  }, []);

  const persistNotify = useCallback((key: string, value: boolean) => {
    void AsyncStorage.setItem(key, String(value));
  }, []);

  const canTestPush = status === "connected" && !!accountId && !!API_BASE;

  const handleTestNotification = useCallback(async () => {
    if (!canTestPush) return;
    setTestNotifState("sending");
    setTestNotifError(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const res = await authFetch(`${API_BASE}/ea/test-notification`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || !data.ok) {
        const msg = data.error ?? `Request failed (${res.status})`;
        setTestNotifState("error");
        setTestNotifError(msg);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert("Test notification failed", msg);
        return;
      }
      setTestNotifState("sent");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Test sent", data.message ?? "Check your device for the notification.");
    } catch (e) {
      const msg = (e as Error).message || "Network error";
      setTestNotifState("error");
      setTestNotifError(msg);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Test notification failed", msg);
    } finally {
      setTimeout(() => setTestNotifState("idle"), 4000);
    }
  }, [canTestPush]);

  const rfColor =
    cs.riskFreePips > 0 ? C.gold : cs.riskFreePips < 0 ? C.sell : C.textMuted;
  const rfDisplay =
    cs.riskFreePips > 0 ? `+${cs.riskFreePips}p` : cs.riskFreePips < 0 ? `${cs.riskFreePips}p` : "0p";

  const [login, setLogin] = useState(credentials.login);
  const [password, setPassword] = useState("");
  const [server, setServer] = useState(credentials.server);
  const [showPassword, setShowPassword] = useState(false);
  const [showServers, setShowServers] = useState(false);

  const isConnecting = status === "connecting";
  const isConnected = status === "connected";
  const webTopPad = Platform.OS === "web" ? 67 : 0;

  const handleConnect = async () => {
    if (!login.trim() || !password.trim() || !server.trim()) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await connect({ login: login.trim(), password: password.trim(), server: server.trim() });
  };

  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnect();
      setPassword("");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.background }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={[styles.container, { paddingTop: insets.top + webTopPad }]}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>MT5 Login</Text>
          <StatusDot status={status} />
        </View>

        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Login Form — only show when not connected */}
          {!isConnected && (
            <View style={styles.formCard}>
              {/* Account Number */}
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Account Number</Text>
                <View style={styles.inputWrap}>
                  <Feather name="hash" size={16} color={C.textSecondary} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input}
                    value={login}
                    onChangeText={setLogin}
                    placeholder="e.g. 12345678"
                    placeholderTextColor={C.textMuted}
                    keyboardType="number-pad"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!isConnecting}
                  />
                </View>
              </View>

              {/* Password */}
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Password</Text>
                <View style={styles.inputWrap}>
                  <Feather name="lock" size={16} color={C.textSecondary} style={styles.inputIcon} />
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={password}
                    onChangeText={setPassword}
                    placeholder="MT5 account password"
                    placeholderTextColor={C.textMuted}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!isConnecting}
                  />
                  <Pressable
                    onPress={() => setShowPassword((s) => !s)}
                    style={styles.eyeBtn}
                    hitSlop={8}
                  >
                    <Feather name={showPassword ? "eye-off" : "eye"} size={16} color={C.textSecondary} />
                  </Pressable>
                </View>
              </View>

              {/* Server */}
              <View style={styles.field}>
                <View style={styles.fieldLabelRow}>
                  <Text style={styles.fieldLabel}>Broker Server</Text>
                  <Pressable onPress={() => setShowServers((s) => !s)} hitSlop={8}>
                    <Text style={styles.fieldHint}>Popular servers</Text>
                  </Pressable>
                </View>
                <View style={styles.inputWrap}>
                  <Feather name="server" size={16} color={C.textSecondary} style={styles.inputIcon} />
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={server}
                    onChangeText={setServer}
                    placeholder="e.g. Exness-MT5Trial"
                    placeholderTextColor={C.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    editable={!isConnecting}
                  />
                </View>

                {showServers && (
                  <View style={styles.serverList}>
                    {POPULAR_SERVERS.map((s) => (
                      <Pressable
                        key={s}
                        style={({ pressed }) => [styles.serverChip, pressed && { opacity: 0.6 }]}
                        onPress={() => { setServer(s); setShowServers(false); }}
                      >
                        <Text style={styles.serverChipText}>{s}</Text>
                      </Pressable>
                    ))}
                    <Text style={styles.serverNote}>
                      Find your server name in MT5 under File → Open an account
                    </Text>
                  </View>
                )}
              </View>

              {/* Error */}
              {errorMsg ? (
                <View style={styles.errorBox}>
                  <Feather name="alert-circle" size={14} color={C.sell} />
                  <Text style={styles.errorText}>{errorMsg}</Text>
                  {errorMsg.toLowerCase().includes("too many") && (
                    <Text style={[styles.errorText, { marginTop: 6, opacity: 0.8, fontSize: 11 }]}>
                      Too many failed attempts. Wait the indicated time, then try again with your correct password.
                    </Text>
                  )}
                  {(errorMsg.toLowerCase().includes("contact support") || errorMsg.toLowerCase().includes("limit reached")) && (
                    <Text style={[styles.errorText, { marginTop: 8, lineHeight: 18 }]}>
                      Please contact support to resolve this issue.
                    </Text>
                  )}
                </View>
              ) : null}

              {/* Connect Button */}
              <Pressable
                style={({ pressed }) => [
                  styles.connectBtn,
                  pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
                  (isConnecting || !login.trim() || !password.trim() || !server.trim()) && { opacity: 0.5 },
                ]}
                onPress={handleConnect}
                disabled={isConnecting || !login.trim() || !password.trim() || !server.trim()}
              >
                {isConnecting ? (
                  <View style={styles.connectingRow}>
                    <ActivityIndicator color="#000" size="small" />
                    <Text style={styles.connectText}>Connecting to MT5...</Text>
                  </View>
                ) : (
                  <View style={styles.connectingRow}>
                    <Feather name="zap" size={18} color="#000" />
                    <Text style={styles.connectText}>Connect</Text>
                  </View>
                )}
              </Pressable>

              {isConnecting && (
                <Text style={styles.connectingNote}>
                  This may take up to 2 minutes while we establish a connection with your broker.
                </Text>
              )}
            </View>
          )}

          {/* Account Info — when connected with loaded info */}
          {isConnected && accountInfo && (
            <>
              <View style={styles.accountHero}>
                <View style={styles.accountHeroTop}>
                  <View>
                    <Text style={styles.accountName}>{accountInfo.name}</Text>
                    <Text style={styles.accountServer}>{credentials.login} · {credentials.server}</Text>
                  </View>
                  <View style={[styles.livePill]}>
                    <View style={styles.liveDot} />
                    <Text style={styles.liveText}>LIVE</Text>
                  </View>
                </View>
                <View style={styles.balanceRow}>
                  <View style={styles.balanceItem}>
                    <Text style={styles.balanceLabel}>BALANCE</Text>
                    <Text style={styles.balanceValue}>
                      {formatMoney(accountInfo.balance)}
                    </Text>
                  </View>
                  <View style={styles.balanceDivider} />
                  <View style={styles.balanceItem}>
                    <Text style={styles.balanceLabel}>EQUITY</Text>
                    <Text style={[styles.balanceValue, { color: accountInfo.equity >= accountInfo.balance ? C.buy : C.sell }]}>
                      {formatMoney(accountInfo.equity)}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={styles.infoCard}>
                <InfoRow label="Free Margin" value={formatMoney(accountInfo.freeMargin)} />
                <View style={styles.infoDivider} />
                <InfoRow label="Leverage" value={`1:${accountInfo.leverage}`} />
                <View style={styles.infoDivider} />
                <InfoRow label="MT5 account currency" value={accountInfo.currency} />
              </View>
            </>
          )}

          {/* Disconnect — visible whenever connected (even if accountInfo not loaded yet) */}
          {isConnected && (
            <Pressable
              style={({ pressed }) => [styles.disconnectBtn, pressed && { opacity: 0.75 }, disconnecting && { opacity: 0.5 }]}
              onPress={handleDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? (
                <ActivityIndicator size="small" color={C.sell} />
              ) : (
                <Feather name="log-out" size={16} color={C.sell} />
              )}
              <Text style={styles.disconnectText}>
                {disconnecting ? "Disconnecting..." : "Disconnect Account"}
              </Text>
            </Pressable>
          )}

          {/* Cancel — visible while connecting (stuck state escape hatch) */}
          {isConnecting && (
            <Pressable
              style={({ pressed }) => [styles.disconnectBtn, pressed && { opacity: 0.75 }]}
              onPress={handleDisconnect}
            >
              <Feather name="x-circle" size={16} color={C.textSecondary} />
              <Text style={[styles.disconnectText, { color: C.textSecondary }]}>Cancel Connection</Text>
            </Pressable>
          )}

          {/* Sign Out */}
          <Pressable
            style={({ pressed }) => [styles.disconnectBtn, { borderColor: "#333", marginTop: 6 }, pressed && { opacity: 0.7 }]}
            onPress={() => signOut()}
          >
            <Feather name="log-out" size={16} color={C.textSecondary} />
            <Text style={[styles.disconnectText, { color: C.textSecondary }]}>Sign Out</Text>
          </Pressable>

          {/* Section 1 — Take Profit Levels */}
          <View style={styles.cascadeCard}>
            <SectionTitle title="TAKE PROFIT LEVELS" />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Cascade lot size</Text>
                <Text style={styles.settingHint}>Total size — split across TPs below</Text>
              </View>
              <Stepper
                value={cascadeLotSize}
                onChange={setCascadeLotSize}
                step={0.01}
                min={0.01}
                display={cascadeLotSize.toFixed(2)}
              />
            </View>
            <View style={styles.cascadeDivider} />
            <TpLevelRow
              label="TP1"
              enabled={cs.tp1Enabled}
              lots={cs.tp1Lots}
              maxLots={cascadeLotSize}
              pips={cs.tp1Pips}
              onToggle={(v) => updateSettings({ tp1Enabled: v })}
              onLotsChange={(v) => updateSettings({ tp1Lots: v })}
              onPipsChange={(v) => updateSettings({ tp1Pips: v })}
            />
            <View style={styles.cascadeDivider} />
            <TpLevelRow
              label="TP2"
              enabled={cs.tp2Enabled}
              lots={cs.tp2Lots}
              maxLots={cascadeLotSize}
              pips={cs.tp2Pips}
              onToggle={(v) => updateSettings({ tp2Enabled: v })}
              onLotsChange={(v) => updateSettings({ tp2Lots: v })}
              onPipsChange={(v) => updateSettings({ tp2Pips: v })}
            />
            <View style={styles.cascadeDivider} />
            <TpLevelRow
              label="TP3"
              enabled={cs.tp3Enabled}
              lots={cs.tp3Lots}
              maxLots={cascadeLotSize}
              pips={cs.tp3Pips}
              onToggle={(v) => updateSettings({ tp3Enabled: v })}
              onLotsChange={(v) => updateSettings({ tp3Lots: v })}
              onPipsChange={(v) => updateSettings({ tp3Pips: v })}
            />
            <View style={styles.runnerRemainderRow}>
              <Text style={styles.settingLabel}>Runners</Text>
              <Text style={[styles.runnerRemainderValue, runnerLots < 0.01 && { color: C.textMuted }]}>
                {runnerLots >= 0.01 ? `${runnerLots.toFixed(2)} lots remaining` : "No remainder — zone closes at last TP"}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.saveBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                saveState === "saving" && { opacity: 0.6 },
              ]}
              disabled={saveState === "saving"}
              onPress={() => { void handleSaveSettings(); }}
            >
              {saveState === "saving" ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Feather
                  name={saveState === "saved" ? "check" : saveState === "error" ? "alert-circle" : "upload-cloud"}
                  size={15}
                  color={saveState === "error" ? C.sell : "#000"}
                />
              )}
              <Text style={[styles.saveBtnText, saveState === "error" && { color: C.sell }]}>
                {saveState === "saving" ? "Saving…"
                  : saveState === "saved" ? "Saved to server"
                  : saveState === "error" ? (saveError ?? "Save failed")
                  : "Save Settings to Server"}
              </Text>
            </Pressable>
          </View>

          {/* Section 2 — Stop Loss */}
          <View style={styles.cascadeCard}>
            <SectionTitle title="STOP LOSS" />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Move SL to BE at TP2</Text>
                <Text style={styles.settingHint}>Protects remaining position automatically</Text>
              </View>
              <Toggle
                value={cs.autoBeAtTp === 2}
                onValueChange={(v) => updateSettings({ autoBeAtTp: v ? 2 : 3 })}
                color={C.buy}
              />
            </View>
            <View style={styles.cascadeDivider} />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Cancel limits at TP2</Text>
                <Text style={styles.settingHint}>Removes unfilled cascade orders</Text>
              </View>
              <Toggle
                value={cs.takeProfitEnabled}
                onValueChange={(v) => updateSettings({ takeProfitEnabled: v })}
                color={C.teal}
              />
            </View>
            <View style={styles.cascadeDivider} />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Risk Free offset</Text>
                <Text style={styles.settingHint}>Pips from entry for risk free SL</Text>
              </View>
              <Stepper
                value={cs.riskFreePips}
                onChange={(v) => updateSettings({ riskFreePips: v })}
                step={5}
                min={-50}
                max={50}
                display={rfDisplay}
                valueColor={rfColor}
              />
            </View>
          </View>

          {/* Section 3 — Cascade Settings */}
          <View style={styles.cascadeCard}>
            <SectionTitle title="CASCADE SETTINGS" />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Number of limits</Text>
              </View>
              <Stepper
                value={cs.numPositions}
                onChange={(v) => updateSettings({ numPositions: v })}
                step={1}
                min={1}
                max={5}
              />
            </View>
            <View style={styles.cascadeDivider} />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Limit spacing</Text>
                <Text style={styles.settingHint}>Pips between each limit order</Text>
              </View>
              <Stepper
                value={cs.pipsBetween}
                onChange={(v) => updateSettings({ pipsBetween: v })}
                step={5}
                min={5}
                display={`${cs.pipsBetween}p`}
              />
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.saveBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                saveState === "saving" && { opacity: 0.6 },
              ]}
              disabled={saveState === "saving"}
              onPress={() => { void handleSaveSettings(); }}
            >
              {saveState === "saving" ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Feather
                  name={saveState === "saved" ? "check" : saveState === "error" ? "alert-circle" : "upload-cloud"}
                  size={15}
                  color={saveState === "error" ? C.sell : "#000"}
                />
              )}
              <Text style={[styles.saveBtnText, saveState === "error" && { color: C.sell }]}>
                {saveState === "saving" ? "Saving…"
                  : saveState === "saved" ? "Saved to server"
                  : saveState === "error" ? (saveError ?? "Save failed")
                  : "Save Settings to Server"}
              </Text>
            </Pressable>
          </View>

          {/* Section 4 — Notifications */}
          <View style={styles.cascadeCard}>
            <SectionTitle title="NOTIFICATIONS" />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>TP3 hit — set runners</Text>
              </View>
              <Toggle
                value={notifyTp3}
                onValueChange={(v) => { setNotifyTp3(v); persistNotify(NOTIFY_TP3_KEY, v); }}
                color={C.gold}
              />
            </View>
            <View style={styles.cascadeDivider} />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Runner 1 hit</Text>
              </View>
              <Toggle
                value={notifyR1}
                onValueChange={(v) => { setNotifyR1(v); persistNotify(NOTIFY_R1_KEY, v); }}
                color={C.teal}
              />
            </View>
            <View style={styles.cascadeDivider} />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Runner 2 hit</Text>
              </View>
              <Toggle
                value={notifyR2}
                onValueChange={(v) => { setNotifyR2(v); persistNotify(NOTIFY_R2_KEY, v); }}
                color={C.teal}
              />
            </View>
            <View style={styles.cascadeDivider} />
            <View style={styles.settingRow}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.settingLabel}>Runner 3 hit</Text>
              </View>
              <Toggle
                value={notifyR3}
                onValueChange={(v) => { setNotifyR3(v); persistNotify(NOTIFY_R3_KEY, v); }}
                color={C.teal}
              />
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.testNotifBtn,
                !canTestPush && styles.testNotifBtnDisabled,
                pressed && canTestPush && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                testNotifState === "sending" && { opacity: 0.6 },
              ]}
              disabled={!canTestPush || testNotifState === "sending"}
              onPress={() => { void handleTestNotification(); }}
            >
              {testNotifState === "sending" ? (
                <ActivityIndicator size="small" color={C.gold} />
              ) : (
                <Feather
                  name={testNotifState === "sent" ? "check" : testNotifState === "error" ? "alert-circle" : "bell"}
                  size={15}
                  color={testNotifState === "error" ? C.sell : C.gold}
                />
              )}
              <Text style={[styles.testNotifBtnText, testNotifState === "error" && { color: C.sell }]}>
                {testNotifState === "sending" ? "Sending…"
                  : testNotifState === "sent" ? "Test notification sent"
                  : testNotifState === "error" ? (testNotifError ?? "Send failed")
                  : "Send test notification"}
              </Text>
            </Pressable>
            {!canTestPush && (
              <Text style={styles.testNotifHint}>
                Connect MT5 on this device to register a push token.
              </Text>
            )}
          </View>

          {/* Help & Support */}
          <Pressable
            style={({ pressed }) => [styles.supportBtn, pressed && { opacity: 0.8 }]}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push("/support");
            }}
          >
            <Feather name="help-circle" size={18} color={C.gold} />
            <View style={{ flex: 1 }}>
              <Text style={styles.supportBtnTitle}>Help & Support</Text>
              <Text style={styles.supportBtnHint}>Get help or report an issue</Text>
            </View>
            <Feather name="chevron-right" size={16} color={C.textMuted} />
          </Pressable>

          {/* About */}
          <View style={styles.aboutCard}>
            <View style={styles.goldBar}>
              <Text style={styles.goldBarSymbol}>XAU/USD</Text>
              <Text style={styles.goldBarName}>Gold · MetaTrader 5</Text>
            </View>
            <Text style={styles.aboutText}>
              Connects directly to your MT5 broker account. Trades are placed live on your account. Always use a demo account first to test.
            </Text>
            <View style={styles.apiUrlRow}>
              <Feather name="server" size={11} color={C.textMuted} />
              <Text style={styles.apiUrlText} numberOfLines={1} ellipsizeMode="middle">
                {process.env.EXPO_PUBLIC_API_URL ?? process.env.EXPO_PUBLIC_DOMAIN ?? "unknown"}
              </Text>
            </View>
          </View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  statusText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  scroll: {
    padding: 16,
    gap: 14,
  },
  formCard: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: C.border,
    gap: 18,
  },
  field: {
    gap: 8,
  },
  fieldLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  fieldHint: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: C.gold,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    height: 52,
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: C.text,
    height: 52,
  },
  eyeBtn: {
    padding: 4,
    marginLeft: 8,
  },
  serverList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  serverChip: {
    backgroundColor: C.surface,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  serverChipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  serverNote: {
    width: "100%",
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 4,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(246, 70, 93, 0.08)",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(246, 70, 93, 0.2)",
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.sell,
    lineHeight: 18,
  },
  connectBtn: {
    backgroundColor: C.gold,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  connectingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  connectText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#000",
    letterSpacing: 0.3,
  },
  connectingNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    textAlign: "center",
    lineHeight: 17,
    marginTop: -6,
  },
  accountHero: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: C.border,
    gap: 16,
  },
  accountHeroTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  accountName: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  accountServer: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    marginTop: 3,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(14, 203, 129, 0.12)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.buy,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.buy,
  },
  liveText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: C.buy,
    letterSpacing: 0.5,
  },
  balanceRow: {
    flexDirection: "row",
    backgroundColor: C.surface,
    borderRadius: 14,
    overflow: "hidden",
  },
  balanceItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 14,
    gap: 4,
  },
  balanceDivider: {
    width: 1,
    backgroundColor: C.border,
    marginVertical: 12,
  },
  balanceLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 0.8,
  },
  balanceValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  infoCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
    gap: 12,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  infoLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  infoValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  infoDivider: {
    height: 1,
    backgroundColor: C.border,
  },
  disconnectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 16,
    paddingVertical: 15,
    borderWidth: 1,
    borderColor: C.sell,
    backgroundColor: "rgba(246, 70, 93, 0.06)",
  },
  disconnectText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: C.sell,
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 16,
    borderRadius: 14,
    paddingVertical: 14,
    backgroundColor: C.gold,
  },
  saveBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: "#000",
  },
  testNotifBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
    borderRadius: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.45)",
    backgroundColor: "rgba(201,168,76,0.08)",
  },
  testNotifBtnDisabled: {
    opacity: 0.45,
  },
  testNotifBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.gold,
  },
  testNotifHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    textAlign: "center",
    marginTop: -4,
  },
  settingsTabBar: {
    flexDirection: "row",
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: C.border,
    gap: 4,
    marginTop: 6,
  },
  settingsTabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  settingsTabBtnActive: {
    backgroundColor: C.gold,
  },
  settingsTabBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
  },
  settingsTabBtnTextActive: {
    color: "#000",
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#22c55e",
    marginLeft: 2,
    shadowColor: "#22c55e",
    shadowOpacity: 0.8,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  activeDotOnActiveTab: {
    backgroundColor: "#15803d",
    shadowColor: "#15803d",
  },
  activeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "rgba(34,197,94,0.15)",
    borderWidth: 1,
    borderColor: "rgba(34,197,94,0.5)",
  },
  activeBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#22c55e",
  },
  activeBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: "#22c55e",
    letterSpacing: 0.5,
  },
  warningBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "rgba(245,158,11,0.10)",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.35)",
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  warningTitle: {
    fontFamily: "Inter_600SemiBold",
    color: "#f59e0b",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
    marginBottom: -4,
  },
  sectionHeaderLine: {
    flex: 1,
    height: 1,
    backgroundColor: "rgba(201,168,76,0.25)",
  },
  sectionHeaderLabelWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sectionHeaderLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: C.gold,
    letterSpacing: 1.2,
  },
  sourceBadge: {
    marginLeft: "auto",
    backgroundColor: "rgba(201,168,76,0.12)",
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.4)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  sourceBadgeMt5: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.18)",
  },
  sourceBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: C.gold,
    letterSpacing: 1,
  },
  cascadeCard: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: C.border,
    gap: 14,
  },
  mt5Card: {
    borderColor: "rgba(201,168,76,0.25)",
    backgroundColor: "rgba(201,168,76,0.04)",
  },
  cascadeCardHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  cascadeCardTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: C.text },
  cascadeCardDesc: { fontSize: 13, fontFamily: "Inter_400Regular", color: C.textSecondary, lineHeight: 19 },
  cascadeDivider: { height: 1, backgroundColor: C.border },
  tpBlock: {
    paddingVertical: 12,
    gap: 8,
  },
  tpBlockHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  tpBlockTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  tpOffBadge: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
    backgroundColor: C.border,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  tpSubRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 4,
  },
  tpSubLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  tpRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  tpRowLabel: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  tpInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: C.card,
    minWidth: 140,
  },
  tpInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
    padding: 0,
    textAlign: "right",
  },
  tpInputSuffix: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
  },
  settingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  pillSelectorColumn: { flexDirection: "column", gap: 10 },
  settingRowLeft: { flex: 1, gap: 2 },
  settingLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: C.text },
  settingHint: { fontSize: 11, fontFamily: "Inter_400Regular", color: C.textMuted },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: C.textMuted,
    letterSpacing: 1.32,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  tpLevelBlock: { gap: 8 },
  tpLevelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tpLevelExpanded: { gap: 10, paddingLeft: 4 },
  tpLevelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  tpLevelRowLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: C.textMuted,
    width: 64,
  },
  pctBarTrack: {
    flex: 1,
    height: 6,
    backgroundColor: C.surface,
    borderRadius: 3,
    overflow: "hidden",
  },
  pctBarFill: {
    height: "100%",
    backgroundColor: C.gold,
    borderRadius: 3,
  },
  runnerRemainderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
  },
  runnerRemainderValue: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.gold,
  },
  settingControls: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderRadius: 10,
    overflow: "hidden",
  },
  settingBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  settingValue: {
    minWidth: 64,
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.gold,
    paddingHorizontal: 4,
  },
  sliderSetting: {
    paddingVertical: 14,
    gap: 6,
  },
  sliderHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sliderValueBadge: {
    backgroundColor: C.surface,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: C.gold,
  },
  sliderValueText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.gold,
  },
  slider: {
    width: "100%",
    height: 36,
  },
  sliderRange: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: -4,
  },
  sliderRangeText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
  },
  sliderHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    textAlign: "center",
    flex: 1,
  },
  pillGroup: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  pillActive: {
    backgroundColor: C.gold,
    borderColor: C.gold,
  },
  pillText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
  },
  pillTextActive: {
    color: "#000",
  },
  cascadeWarningBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(245,158,11,0.10)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.35)",
    padding: 12,
  },
  cascadeWarningText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: "#f59e0b", lineHeight: 18 },
  cascadePreviewBox: {
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: C.border,
    gap: 6,
  },
  cascadePreviewTitle: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: C.textSecondary, letterSpacing: 0.5 },
  cascadePreviewText: { fontSize: 12, fontFamily: "Inter_400Regular", color: C.textMuted, lineHeight: 20 },
  supportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  supportBtnTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  supportBtnHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 1,
  },
  aboutCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: C.border,
  },
  goldBar: {
    backgroundColor: C.gold,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  goldBarSymbol: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#000",
    letterSpacing: 2,
  },
  goldBarName: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "rgba(0,0,0,0.55)",
  },
  apiUrlRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  apiUrlText: { fontSize: 10, fontFamily: "Inter_400Regular", color: C.textMuted, flex: 1 },
  aboutText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 20,
    padding: 16,
  },
});
