import { useAuth } from "@/context/AuthContext";
import { Feather } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import AsyncStorage from "@react-native-async-storage/async-storage";

import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";
import { useCascadeSettings } from "@/hooks/useCascadeSettings";
import { useHapticSettings } from "@/hooks/useHapticSettings";
import { useNotificationSettings } from "@/hooks/useNotificationSettings";

const C = Colors.dark;

const LOT_SIZE_SINGLE_KEY = "lot_size_single";
const LOT_SIZE_CASCADE_KEY = "lot_size_cascade";

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

function SettingRow({
  label,
  hint,
  value,
  onDec,
  onInc,
  display,
}: {
  label: string;
  hint: string;
  value: number;
  onDec: () => void;
  onInc: () => void;
  display: string;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingRowLeft}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingHint}>{hint}</Text>
      </View>
      <View style={styles.settingControls}>
        <Pressable style={styles.settingBtn} onPress={onDec} hitSlop={8}>
          <Feather name="minus" size={14} color={C.text} />
        </Pressable>
        <Text style={styles.settingValue}>{display}</Text>
        <Pressable style={styles.settingBtn} onPress={onInc} hitSlop={8}>
          <Feather name="plus" size={14} color={C.text} />
        </Pressable>
      </View>
    </View>
  );
}

function PillSelector({
  label,
  hint,
  options,
  value,
  onChange,
  suffix = "pips",
  labels,
}: {
  label: string;
  hint: string;
  options: number[];
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  labels?: Record<number, string>;
}) {
  return (
    <View style={styles.pillSelectorColumn}>
      <View style={styles.settingRowLeft}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingHint}>{hint}</Text>
      </View>
      <View style={styles.pillGroup}>
        {options.map((opt) => {
          const selected = opt === value;
          const display = labels?.[opt] ?? `${opt}${suffix}`;
          return (
            <Pressable
              key={opt}
              style={[styles.pill, selected && styles.pillActive]}
              onPress={() => {
                Haptics.selectionAsync();
                onChange(opt);
              }}
              hitSlop={4}
            >
              <Text style={[styles.pillText, selected && styles.pillTextActive]}>
                {display}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SliderSetting({
  label,
  value,
  min,
  max,
  step,
  onChange,
  displayValue,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  displayValue: string;
  hint: string;
}) {
  return (
    <View style={styles.sliderSetting}>
      <View style={styles.sliderHeader}>
        <Text style={styles.settingLabel}>{label}</Text>
        <View style={styles.sliderValueBadge}>
          <Text style={styles.sliderValueText}>{displayValue}</Text>
        </View>
      </View>
      <Slider
        style={styles.slider}
        minimumValue={min}
        maximumValue={max}
        step={step}
        value={value}
        onValueChange={(v) => {
          onChange(Math.round(v / step) * step);
        }}
        onSlidingComplete={() => Haptics.selectionAsync()}
        minimumTrackTintColor={C.gold}
        maximumTrackTintColor={C.border}
        thumbTintColor={C.gold}
      />
      <View style={styles.sliderRange}>
        <Text style={styles.sliderRangeText}>{min} pips</Text>
        <Text style={styles.sliderHint}>{hint}</Text>
        <Text style={styles.sliderRangeText}>{max} pips</Text>
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useAuth();
  const { credentials, status, errorMsg, accountInfo, connect, disconnect } = useTrading();
  const { settings: cs, updateSettings, saveToServer } = useCascadeSettings();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [tpDraft, setTpDraft] = useState({
    tp1: String(cs.tp1Pips),
    tp2: String(cs.tp2Pips),
    tp3: String(cs.tp3Pips),
    tp4: String(cs.tp4Pips),
  });
  const [tpSaveState, setTpSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Risk-free SL setting: signed pips (-30..+30, step 5). Negative = drawdown
  // protection, positive = profit lock, 0 = exact break-even. Stored locally
  // and passed in the risk-free POST body per zone.
  const [rfDraft, setRfDraft] = useState<number>(cs.riskFreePips);
  const [rfSaveState, setRfSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => { setRfDraft(cs.riskFreePips); }, [cs.riskFreePips]);
  const rfDirty = rfDraft !== cs.riskFreePips;
  useEffect(() => {
    setTpDraft({
      tp1: String(cs.tp1Pips),
      tp2: String(cs.tp2Pips),
      tp3: String(cs.tp3Pips),
      tp4: String(cs.tp4Pips),
    });
  }, [cs.tp1Pips, cs.tp2Pips, cs.tp3Pips, cs.tp4Pips]);

  const parsedTp = {
    tp1: parseFloat(tpDraft.tp1),
    tp2: parseFloat(tpDraft.tp2),
    tp3: parseFloat(tpDraft.tp3),
    tp4: tpDraft.tp4.trim() === "" ? 0 : parseFloat(tpDraft.tp4),
  };
  const tpDraftValid =
    Number.isFinite(parsedTp.tp1) && parsedTp.tp1 > 0 &&
    Number.isFinite(parsedTp.tp2) && parsedTp.tp2 > parsedTp.tp1 &&
    Number.isFinite(parsedTp.tp3) && parsedTp.tp3 > parsedTp.tp2 &&
    Number.isFinite(parsedTp.tp4) && (parsedTp.tp4 === 0 || parsedTp.tp4 > parsedTp.tp3);
  const tpDraftDirty =
    parsedTp.tp1 !== cs.tp1Pips ||
    parsedTp.tp2 !== cs.tp2Pips ||
    parsedTp.tp3 !== cs.tp3Pips ||
    parsedTp.tp4 !== cs.tp4Pips;

  // Lot sizes — shared with the trade tab via AsyncStorage
  const [singleLotDraft, setSingleLotDraft] = useState("0.01");
  const [cascadeLotDraft, setCascadeLotDraft] = useState("0.04");
  const [lotSaveState, setLotSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => {
    AsyncStorage.getMany([LOT_SIZE_SINGLE_KEY, LOT_SIZE_CASCADE_KEY]).then((r) => {
      const s = r[LOT_SIZE_SINGLE_KEY];
      const c = r[LOT_SIZE_CASCADE_KEY];
      if (s) setSingleLotDraft(parseFloat(s).toFixed(2));
      if (c) setCascadeLotDraft(parseFloat(c).toFixed(2));
    });
  }, []);
  const parsedSingleLot = parseFloat(singleLotDraft);
  const parsedCascadeLot = parseFloat(cascadeLotDraft);
  const lotDraftsValid = Number.isFinite(parsedSingleLot) && parsedSingleLot >= 0.01;

  // TP split % per level
  const [splitDraft, setSplitDraft] = useState({
    tp1: String(cs.tp1Pct),
    tp2: String(cs.tp2Pct),
    tp3: String(cs.tp3Pct),
    tp4: String(cs.tp4Pct),
  });
  useEffect(() => {
    setSplitDraft({ tp1: String(cs.tp1Pct), tp2: String(cs.tp2Pct), tp3: String(cs.tp3Pct), tp4: String(cs.tp4Pct) });
  }, [cs.tp1Pct, cs.tp2Pct, cs.tp3Pct, cs.tp4Pct]);
  const parsedSplit = {
    tp1: parseInt(splitDraft.tp1, 10) || 0,
    tp2: parseInt(splitDraft.tp2, 10) || 0,
    tp3: parseInt(splitDraft.tp3, 10) || 0,
    tp4: parseInt(splitDraft.tp4, 10) || 0,
  };
  const activeSplitSum =
    (cs.tp1Enabled ? parsedSplit.tp1 : 0) +
    (cs.tp2Enabled ? parsedSplit.tp2 : 0) +
    (cs.tp3Enabled ? parsedSplit.tp3 : 0) +
    (cs.tp4Enabled ? parsedSplit.tp4 : 0);
  const splitValid = activeSplitSum === 100 &&
    (!cs.tp1Enabled || parsedSplit.tp1 > 0) &&
    (!cs.tp2Enabled || parsedSplit.tp2 > 0) &&
    (!cs.tp3Enabled || parsedSplit.tp3 > 0) &&
    (!cs.tp4Enabled || parsedSplit.tp4 > 0);

  // Lot-size constraint: each partial close must be >= 0.01 lots (MT5 minimum)
  const enabledTpCount = [cs.tp1Enabled, cs.tp2Enabled, cs.tp3Enabled, cs.tp4Enabled].filter(Boolean).length;
  const maxActiveTPs = Number.isFinite(parsedCascadeLot) && parsedCascadeLot >= 0.01
    ? Math.min(4, Math.round(parsedCascadeLot * 100))
    : 0;
  const tooManyTPs = enabledTpCount > maxActiveTPs;
  type TpLotErr = { label: string; lots: number };
  const tpLotErrors: TpLotErr[] = (
    [
      { label: "TP1", enabled: cs.tp1Enabled, pct: parsedSplit.tp1 },
      { label: "TP2", enabled: cs.tp2Enabled, pct: parsedSplit.tp2 },
      { label: "TP3", enabled: cs.tp3Enabled, pct: parsedSplit.tp3 },
      { label: "TP4", enabled: cs.tp4Enabled, pct: parsedSplit.tp4 },
    ]
      .filter((t) => t.enabled && t.pct > 0 && Number.isFinite(parsedCascadeLot) && parsedCascadeLot >= 0.01)
      .map((t) => {
        const lots = Math.round(parsedCascadeLot * t.pct / 100 * 100) / 100;
        return lots < 0.01 ? { label: t.label, lots } : null;
      })
      .filter((x): x is TpLotErr => x !== null)
  );
  const tpCardValid =
    Number.isFinite(parsedCascadeLot) && parsedCascadeLot >= 0.01 &&
    (enabledTpCount === 0 || splitValid) &&
    tpDraftValid &&
    !tooManyTPs &&
    tpLotErrors.length === 0;

  const { hapticEnabled, setHapticEnabled } = useHapticSettings();
  const { prefs: notif, loading: notifLoading, updatePrefs: updateNotif } = useNotificationSettings();
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);

  const handleNotifUpdate = async (
    patch: Partial<{ nearEnabled: boolean; hitEnabled: boolean; thresholdPips: number }>,
  ) => {
    setNotifBusy(true);
    setNotifError(null);
    const result = await updateNotif(patch);
    setNotifBusy(false);
    if (!result.ok) setNotifError(result.message ?? "Couldn't save");
  };

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
                      {accountInfo.currency} {accountInfo.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </Text>
                  </View>
                  <View style={styles.balanceDivider} />
                  <View style={styles.balanceItem}>
                    <Text style={styles.balanceLabel}>EQUITY</Text>
                    <Text style={[styles.balanceValue, { color: accountInfo.equity >= accountInfo.balance ? C.buy : C.sell }]}>
                      {accountInfo.currency} {accountInfo.equity.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={styles.infoCard}>
                <InfoRow label="Free Margin" value={`${accountInfo.currency} ${accountInfo.freeMargin.toLocaleString("en-US", { minimumFractionDigits: 2 })}`} />
                <View style={styles.infoDivider} />
                <InfoRow label="Leverage" value={`1:${accountInfo.leverage}`} />
                <View style={styles.infoDivider} />
                <InfoRow label="Currency" value={accountInfo.currency} />
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

          {/* Preferences */}
          <View style={styles.cascadeCard}>
            <View style={styles.cascadeCardHeader}>
              <Feather name="sliders" size={16} color={C.gold} />
              <Text style={styles.cascadeCardTitle}>Preferences</Text>
            </View>

            <View style={styles.settingRow}>
              <Switch
                value={hapticEnabled}
                onValueChange={(v) => {
                  setHapticEnabled(v);
                }}
                trackColor={{ false: C.border, true: "rgba(201,168,76,0.5)" }}
                thumbColor={hapticEnabled ? C.gold : C.textMuted}
              />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={styles.settingLabel}>Haptic feedback</Text>
                <Text style={styles.settingHint}>
                  Vibrate when a cascade toast notification appears.
                </Text>
              </View>
            </View>
          </View>

          {/* TP Alerts */}
          <View style={styles.cascadeCard}>
            <View style={styles.cascadeCardHeader}>
              <Feather name="bell" size={16} color={C.gold} />
              <Text style={styles.cascadeCardTitle}>TP Alerts</Text>
            </View>
            <Text style={styles.cascadeCardDesc}>
              Get a push notification when an active zone is about to hit its next take-profit, or when it actually hits. Works while the app is closed.
            </Text>

            <View style={styles.cascadeDivider} />

            <View style={styles.settingRow}>
              <Switch
                value={notif.nearEnabled}
                disabled={notifBusy || notifLoading}
                onValueChange={(v) => { void handleNotifUpdate({ nearEnabled: v }); }}
                trackColor={{ false: C.border, true: "rgba(201,168,76,0.5)" }}
                thumbColor={notif.nearEnabled ? C.gold : C.textMuted}
              />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={styles.settingLabel}>Alert when near next TP</Text>
                <Text style={styles.settingHint}>
                  Fires once per TP level when price gets within the threshold below.
                </Text>
              </View>
            </View>

            <View style={styles.cascadeDivider} />

            <View style={styles.settingRow}>
              <Switch
                value={notif.hitEnabled}
                disabled={notifBusy || notifLoading}
                onValueChange={(v) => { void handleNotifUpdate({ hitEnabled: v }); }}
                trackColor={{ false: C.border, true: "rgba(201,168,76,0.5)" }}
                thumbColor={notif.hitEnabled ? C.gold : C.textMuted}
              />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={styles.settingLabel}>Alert when TP hits</Text>
                <Text style={styles.settingHint}>
                  Fires the moment a TP is reached and your zone advances.
                </Text>
              </View>
            </View>

            {notif.nearEnabled && (
              <>
                <View style={styles.cascadeDivider} />
                <SliderSetting
                  label="Near-TP threshold"
                  value={notif.thresholdPips}
                  min={1}
                  max={20}
                  step={1}
                  onChange={(v) => { void handleNotifUpdate({ thresholdPips: v }); }}
                  displayValue={`${notif.thresholdPips} pips`}
                  hint="distance before alert"
                />
              </>
            )}

            {notifError && (
              <View style={styles.cascadeWarningBox}>
                <Feather name="alert-triangle" size={14} color="#f59e0b" />
                <Text style={styles.cascadeWarningText}>{notifError}</Text>
              </View>
            )}
            {notifBusy && (
              <View style={styles.settingRow}>
                <ActivityIndicator size="small" color={C.gold} />
                <Text style={[styles.settingHint, { marginLeft: 10 }]}>Saving…</Text>
              </View>
            )}
          </View>

          {/* In-app cascade settings */}
          <View style={styles.cascadeCard}>
            <View style={styles.cascadeCardHeader}>
              <Feather name="layers" size={16} color={C.gold} />
              <Text style={styles.cascadeCardTitle}>Cascade Orders</Text>
              <View style={styles.sourceBadge}>
                <Text style={styles.sourceBadgeText}>IN-APP</Text>
              </View>
            </View>
            <Text style={styles.cascadeCardDesc}>
              Controls the ladder of orders placed when you tap Buy or Sell on the Trade screen of this app. Has no effect on trades you place inside the MT5 app.
            </Text>

            <View style={styles.cascadeDivider} />

            <PillSelector
              label="Number of positions"
              hint="Total orders per cascade (1 market + limits)"
              options={[1, 2, 3, 4, 5]}
              value={cs.numPositions}
              onChange={(v) => updateSettings({ numPositions: v })}
              suffix=""
            />

            <View style={styles.cascadeDivider} />

            <PillSelector
              label="Pips between orders"
              hint={`${(cs.pipsBetween * 0.10).toFixed(2)} price gap between each level`}
              options={[5, 10, 15, 20]}
              value={cs.pipsBetween}
              onChange={(v) => updateSettings({ pipsBetween: v })}
            />

            <View style={styles.cascadeDivider} />

            <SliderSetting
              label="Stop loss (from entry)"
              value={cs.slPips}
              min={10}
              max={500}
              step={5}
              onChange={(v) => updateSettings({ slPips: v })}
              displayValue={`${cs.slPips} pips`}
              hint={`${(cs.slPips * 0.10).toFixed(2)} below market entry — shared by all orders`}
            />

            {cs.numPositions > 1 && cs.slPips <= (cs.numPositions - 1) * cs.pipsBetween && (
              <View style={styles.cascadeWarningBox}>
                <Feather name="alert-triangle" size={14} color="#f59e0b" />
                <Text style={styles.cascadeWarningText}>
                  {`SL (${cs.slPips} pips) is too tight — limit ${Math.ceil(cs.slPips / cs.pipsBetween) + 1}+ will be rejected by MT5. Increase SL to at least ${(cs.numPositions - 1) * cs.pipsBetween + 5} pips, or reduce pips between orders.`}
                </Text>
              </View>
            )}

            <View style={styles.cascadePreviewBox}>
              <Text style={styles.cascadePreviewTitle}>Preview with current settings (buy example)</Text>
              <Text style={styles.cascadePreviewText}>
                {`#1  Market  @ 5058.00  ← instant\n`}
                {Array.from({ length: cs.numPositions - 1 }, (_, i) =>
                  `#${i + 2}  Limit   @ ${(5058 - (i + 1) * cs.pipsBetween * 0.10).toFixed(2)}`
                ).join("\n")}
                {cs.numPositions > 1 ? "\n" : ""}
                {`SL  ${(5058 - cs.slPips * 0.10).toFixed(2)}  ← all orders (${cs.slPips} pips from entry)`}
              </Text>
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.saveBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                saveState === "saving" && { opacity: 0.6 },
              ]}
              disabled={saveState === "saving"}
              onPress={async () => {
                setSaveState("saving");
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                const ok = await saveToServer();
                setSaveState(ok ? "saved" : "error");
                if (ok) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                else void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                setTimeout(() => setSaveState("idle"), 3000);
              }}
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
                  : saveState === "error" ? "Save failed — check connection"
                  : "Save Settings to Server"}
              </Text>
            </Pressable>
          </View>

          {/* Lot Sizes */}
          <View style={styles.cascadeCard}>
            <View style={styles.cascadeCardHeader}>
              <Feather name="layers" size={16} color={C.gold} />
              <Text style={styles.cascadeCardTitle}>Lot Sizes</Text>
              <View style={styles.sourceBadge}>
                <Text style={styles.sourceBadgeText}>IN-APP</Text>
              </View>
            </View>
            <Text style={styles.cascadeCardDesc}>
              Default lot size for single trades and cascade orders. Changes take effect immediately on the trade screen.
            </Text>

            <View style={styles.cascadeDivider} />

            <View style={styles.tpRow}>
              <Text style={styles.tpRowLabel}>Single Trade</Text>
              <View style={styles.tpInputWrap}>
                <TextInput
                  style={styles.tpInput}
                  value={singleLotDraft}
                  onChangeText={(v) => {
                    setSingleLotDraft(v.replace(/[^0-9.]/g, ""));
                    if (lotSaveState !== "idle") setLotSaveState("idle");
                  }}
                  placeholder="0.01"
                  placeholderTextColor={C.textMuted}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                />
                <Text style={styles.tpInputSuffix}>lot</Text>
              </View>
            </View>

            {!lotDraftsValid && (
              <View style={styles.cascadeWarningBox}>
                <Feather name="alert-triangle" size={14} color="#f59e0b" />
                <Text style={styles.cascadeWarningText}>
                  Minimum lot size is 0.01.
                </Text>
              </View>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.saveBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                (!lotDraftsValid || lotSaveState === "saving") && { opacity: 0.5 },
              ]}
              disabled={!lotDraftsValid || lotSaveState === "saving"}
              onPress={async () => {
                Keyboard.dismiss();
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setLotSaveState("saving");
                try {
                  const sLot = parseFloat(parsedSingleLot.toFixed(2));
                  const cLot = Math.max(0.01, parseFloat(parsedCascadeLot.toFixed(2)));
                  await AsyncStorage.setMany({
                    [LOT_SIZE_SINGLE_KEY]: String(sLot),
                    [LOT_SIZE_CASCADE_KEY]: String(cLot),
                  });
                  setSingleLotDraft(sLot.toFixed(2));
                  setCascadeLotDraft(cLot.toFixed(2));
                  setLotSaveState("saved");
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  setTimeout(() => setLotSaveState("idle"), 2500);
                } catch {
                  setLotSaveState("error");
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                  setTimeout(() => setLotSaveState("idle"), 3000);
                }
              }}
            >
              {lotSaveState === "saving" ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Feather
                  name={lotSaveState === "saved" ? "check" : lotSaveState === "error" ? "alert-circle" : "save"}
                  size={15}
                  color={lotSaveState === "error" ? C.sell : "#000"}
                />
              )}
              <Text style={[styles.saveBtnText, lotSaveState === "error" && { color: C.sell }]}>
                {lotSaveState === "saving" ? "Saving…"
                  : lotSaveState === "saved" ? "Lot Sizes Saved"
                  : lotSaveState === "error" ? "Save failed"
                  : "Save Lot Sizes"}
              </Text>
            </Pressable>
          </View>

          {/* Risk Free SL placement — signed pip offset from the surviving entry. */}
          <View style={styles.cascadeCard}>
            <View style={styles.cascadeCardHeader}>
              <Feather name="shield" size={16} color={C.gold} />
              <Text style={styles.cascadeCardTitle}>Risk Free SL</Text>
              <View style={styles.sourceBadge}>
                <Text style={styles.sourceBadgeText}>IN-APP</Text>
              </View>
            </View>
            <Text style={styles.cascadeCardDesc}>
              Where to place the protective stop when you tap Risk Free on a zone.
            </Text>

            <View style={styles.cascadeDivider} />

            <PillSelector
              label="SL offset from entry"
              hint={
                rfDraft < 0 ? `${Math.abs(rfDraft)} pips of drawdown protection`
                : rfDraft > 0 ? `Locks in ${rfDraft} pips of profit`
                : "Break-even — SL exactly at entry"
              }
              options={[-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30]}
              value={rfDraft}
              onChange={(v) => {
                setRfDraft(v);
                if (rfSaveState !== "idle") setRfSaveState("idle");
              }}
              suffix=""
              labels={{
                [-30]: "-30", [-25]: "-25", [-20]: "-20", [-15]: "-15",
                [-10]: "-10", [-5]: "-5", 0: "0",
                5: "+5", 10: "+10", 15: "+15", 20: "+20", 25: "+25", 30: "+30",
              }}
            />

            <Pressable
              style={({ pressed }) => [
                styles.saveBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                (!rfDirty || rfSaveState === "saving") && { opacity: 0.5 },
              ]}
              disabled={!rfDirty || rfSaveState === "saving"}
              onPress={async () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setRfSaveState("saving");
                try {
                  updateSettings({ riskFreePips: rfDraft });
                  setRfSaveState("saved");
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  setTimeout(() => setRfSaveState("idle"), 2500);
                } catch {
                  setRfSaveState("error");
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                  setTimeout(() => setRfSaveState("idle"), 3000);
                }
              }}
            >
              {rfSaveState === "saving" ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Feather
                  name={rfSaveState === "saved" ? "check" : rfSaveState === "error" ? "alert-circle" : "save"}
                  size={15}
                  color={rfSaveState === "error" ? C.sell : "#000"}
                />
              )}
              <Text style={[styles.saveBtnText, rfSaveState === "error" && { color: C.sell }]}>
                {rfSaveState === "saving" ? "Saving…"
                  : rfSaveState === "saved" ? "Risk Free SL Saved"
                  : rfSaveState === "error" ? "Save failed"
                  : "Save Risk Free SL"}
              </Text>
            </Pressable>
          </View>

          {/* Merged Zone Take Profit card — lot size + per-TP pip/% + on/off */}
          <View style={styles.cascadeCard}>
            <View style={styles.cascadeCardHeader}>
              <Feather name="target" size={16} color={C.gold} />
              <Text style={styles.cascadeCardTitle}>Zone Take Profit</Text>
              <View style={styles.sourceBadge}>
                <Text style={styles.sourceBadgeText}>IN-APP</Text>
              </View>
            </View>
            <Text style={styles.cascadeCardDesc}>
              Set your cascade lot size and configure each TP level. Toggle any TP off to skip it. Each partial close must be at least 0.01 lots — the lot size limits how many TPs you can split between.
            </Text>

            <View style={styles.cascadeDivider} />

            {/* Cascade lot size */}
            <View style={styles.tpRow}>
              <Text style={styles.tpRowLabel}>Cascade Lot Size</Text>
              <View style={styles.tpInputWrap}>
                <TextInput
                  style={styles.tpInput}
                  value={cascadeLotDraft}
                  onChangeText={(v) => {
                    setCascadeLotDraft(v.replace(/[^0-9.]/g, ""));
                    if (tpSaveState !== "idle") setTpSaveState("idle");
                  }}
                  placeholder="0.04"
                  placeholderTextColor={C.textMuted}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                />
                <Text style={styles.tpInputSuffix}>lot</Text>
              </View>
            </View>

            <View style={styles.cascadeDivider} />

            {/* Per-TP blocks */}
            {([
              { key: "tp1" as const, label: "TP1", placeholder: "20",         enKey: "tp1Enabled" as const },
              { key: "tp2" as const, label: "TP2", placeholder: "60",         enKey: "tp2Enabled" as const },
              { key: "tp3" as const, label: "TP3", placeholder: "100",        enKey: "tp3Enabled" as const },
              { key: "tp4" as const, label: "TP4", placeholder: "0 = skip",   enKey: "tp4Enabled" as const },
            ]).map((tp, idx) => {
              const enabled = cs[tp.enKey];
              return (
                <View key={tp.key} style={[styles.tpBlock, idx > 0 && { borderTopWidth: 1, borderTopColor: C.border }]}>
                  {/* Header row: label + toggle */}
                  <View style={styles.tpBlockHeader}>
                    <Text style={[styles.tpBlockTitle, !enabled && { color: C.textMuted }]}>{tp.label}</Text>
                    {!enabled && (
                      <Text style={styles.tpOffBadge}>OFF</Text>
                    )}
                    <View style={{ flex: 1 }} />
                    <Switch
                      value={enabled}
                      onValueChange={(v) => {
                        updateSettings({ [tp.enKey]: v });
                        void Haptics.selectionAsync();
                      }}
                      trackColor={{ false: C.border, true: C.buy }}
                      thumbColor="#fff"
                      style={{ transform: [{ scaleX: 0.85 }, { scaleY: 0.85 }] }}
                    />
                  </View>

                  {/* Pip distance row */}
                  <View style={[styles.tpSubRow, !enabled && { opacity: 0.35 }]}>
                    <Text style={styles.tpSubLabel}>Pip distance</Text>
                    <View style={[styles.tpInputWrap, { minWidth: 120 }]}>
                      <TextInput
                        style={styles.tpInput}
                        value={tpDraft[tp.key]}
                        onChangeText={(v) => {
                          setTpDraft((d) => ({ ...d, [tp.key]: v.replace(/[^0-9.]/g, "") }));
                          if (tpSaveState !== "idle") setTpSaveState("idle");
                        }}
                        placeholder={tp.placeholder}
                        placeholderTextColor={C.textMuted}
                        keyboardType="number-pad"
                        inputMode="numeric"
                        editable={enabled}
                      />
                      <Text style={styles.tpInputSuffix}>pips</Text>
                    </View>
                  </View>

                  {/* Close % row */}
                  <View style={[styles.tpSubRow, !enabled && { opacity: 0.35 }]}>
                    <Text style={styles.tpSubLabel}>Close %</Text>
                    <View style={[styles.tpInputWrap, { minWidth: 120 }]}>
                      <TextInput
                        style={styles.tpInput}
                        value={enabled ? splitDraft[tp.key] : "0"}
                        onChangeText={(v) => {
                          setSplitDraft((d) => ({ ...d, [tp.key]: v.replace(/[^0-9]/g, "") }));
                          if (tpSaveState !== "idle") setTpSaveState("idle");
                        }}
                        placeholder="25"
                        placeholderTextColor={C.textMuted}
                        keyboardType="number-pad"
                        inputMode="numeric"
                        editable={enabled}
                      />
                      <Text style={styles.tpInputSuffix}>{enabled ? "%" : "off"}</Text>
                    </View>
                  </View>
                </View>
              );
            })}

            <View style={styles.cascadeDivider} />

            {/* Running total */}
            <View style={[styles.infoRow, { marginTop: 4 }]}>
              <Text style={styles.infoLabel}>Total close %</Text>
              <Text style={[styles.infoValue, { color: enabledTpCount === 0 || activeSplitSum === 100 ? C.buy : C.sell }]}>
                {enabledTpCount === 0 ? "—" : `${activeSplitSum}%`}
              </Text>
            </View>

            {/* Validation warnings */}
            {!tpDraftValid && (
              <View style={styles.cascadeWarningBox}>
                <Feather name="alert-triangle" size={14} color="#f59e0b" />
                <Text style={styles.cascadeWarningText}>
                  TP pip distances must be strictly increasing for enabled TPs (TP4 can be 0 to skip).
                </Text>
              </View>
            )}
            {enabledTpCount > 0 && !splitValid && tpLotErrors.length === 0 && !tooManyTPs && (
              <View style={styles.cascadeWarningBox}>
                <Feather name="alert-triangle" size={14} color="#f59e0b" />
                <Text style={styles.cascadeWarningText}>
                  {activeSplitSum !== 100
                    ? `Close % for enabled TPs must sum to 100 (currently ${activeSplitSum}%).`
                    : "Each enabled TP must have a close % greater than 0."}
                </Text>
              </View>
            )}
            {tooManyTPs && (
              <View style={styles.cascadeWarningBox}>
                <Feather name="alert-triangle" size={14} color="#f59e0b" />
                <Text style={styles.cascadeWarningText}>
                  {`${cascadeLotDraft} lot only supports ${maxActiveTPs} active TP${maxActiveTPs === 1 ? "" : "s"} — each partial close needs at least 0.01 lot. Disable ${enabledTpCount - maxActiveTPs} TP${enabledTpCount - maxActiveTPs === 1 ? "" : "s"} or increase the lot size.`}
                </Text>
              </View>
            )}
            {tpLotErrors.map((e) => (
              <View key={e.label} style={styles.cascadeWarningBox}>
                <Feather name="alert-triangle" size={14} color="#f59e0b" />
                <Text style={styles.cascadeWarningText}>
                  {`${e.label} would close ${e.lots.toFixed(2)} lot — below the 0.01 minimum. Increase its % or the lot size.`}
                </Text>
              </View>
            ))}

            <Pressable
              style={({ pressed }) => [
                styles.saveBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                (!tpCardValid || tpSaveState === "saving") && { opacity: 0.5 },
              ]}
              disabled={!tpCardValid || tpSaveState === "saving"}
              onPress={async () => {
                Keyboard.dismiss();
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setTpSaveState("saving");
                try {
                  const cLot = Math.max(0.01, parseFloat(parsedCascadeLot.toFixed(2)));
                  await AsyncStorage.setItem(LOT_SIZE_CASCADE_KEY, String(cLot));
                  setCascadeLotDraft(cLot.toFixed(2));
                  updateSettings({
                    tp1Pips: parsedTp.tp1, tp2Pips: parsedTp.tp2,
                    tp3Pips: parsedTp.tp3, tp4Pips: parsedTp.tp4,
                    tp1Pct: parsedSplit.tp1, tp2Pct: parsedSplit.tp2,
                    tp3Pct: parsedSplit.tp3, tp4Pct: parsedSplit.tp4,
                  });
                  const ok = await saveToServer();
                  setTpSaveState(ok ? "saved" : "error");
                  void Haptics.notificationAsync(
                    ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
                  );
                  setTimeout(() => setTpSaveState("idle"), ok ? 2500 : 3000);
                } catch {
                  setTpSaveState("error");
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                  setTimeout(() => setTpSaveState("idle"), 3000);
                }
              }}
            >
              {tpSaveState === "saving" ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Feather
                  name={tpSaveState === "saved" ? "check" : tpSaveState === "error" ? "alert-circle" : "save"}
                  size={15}
                  color={tpSaveState === "error" ? C.sell : "#000"}
                />
              )}
              <Text style={[styles.saveBtnText, tpSaveState === "error" && { color: C.sell }]}>
                {tpSaveState === "saving" ? "Saving…"
                  : tpSaveState === "saved" ? "Zone TP Saved"
                  : tpSaveState === "error" ? "Save failed — check connection"
                  : "Save Zone TP Settings"}
              </Text>
            </Pressable>
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
  settingLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: C.text },
  settingHint: { fontSize: 11, fontFamily: "Inter_400Regular", color: C.textSecondary },
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
