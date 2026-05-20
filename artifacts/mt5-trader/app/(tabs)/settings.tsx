import { Feather } from "@expo/vector-icons";
import Slider from "@react-native-community/slider";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import {
  ActivityIndicator,
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

import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";
import { useCascadeSettings } from "@/hooks/useCascadeSettings";
import { useHapticSettings } from "@/hooks/useHapticSettings";

const C = Colors.dark;

const POPULAR_SERVERS = [
  "Vantage-Live",
  "Vantage-Demo",
  "Vantage-Live 2",
  "Vantage-Demo 2",
  "VantageFX-Live",
  "VantageFX-Demo",
  "VantageFX-Live 2",
  "VantageFX-Demo 2",
  "VantageInternational-Live",
  "VantageInternational-Demo",
  "MetaQuotes-Demo",
  "Exness-MT5Trial",
  "ICMarketsSC-MT5",
  "XM-MT5",
  "FBS-MT5",
  "Pepperstone-MT5",
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
  const { credentials, status, errorMsg, accountInfo, connect, disconnect } = useTrading();
  const { settings: cs, updateSettings, saveToServer } = useCascadeSettings();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const { hapticEnabled, setHapticEnabled } = useHapticSettings();

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
                      MetaAPI rate-limits after several failed credential attempts. Wait the indicated time, then try again with your correct password.
                    </Text>
                  )}
                  {(errorMsg.toLowerCase().includes("top up") || errorMsg.toLowerCase().includes("free-tier")) && (
                    <Text style={[styles.errorText, { marginTop: 8, lineHeight: 18 }]}>
                      {"→ Go to "}
                      <Text style={{ color: C.gold, textDecorationLine: "underline" }}>metaapi.cloud</Text>
                      {" → Billing → top up or upgrade your plan, then tap Connect again."}
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
                  This may take up to 60 seconds while we establish a connection with your broker.
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

          {/* Cascade Order Settings — always visible */}
          <View style={styles.cascadeCard}>
            <View style={styles.cascadeCardHeader}>
              <Feather name="layers" size={16} color={C.gold} />
              <Text style={styles.cascadeCardTitle}>Cascade Orders</Text>
            </View>
            <Text style={styles.cascadeCardDesc}>
              Configure the ladder of orders placed when you enter a price on the Trade screen.
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

            <View style={styles.cascadeDivider} />

            <View style={styles.settingRow}>
              <Switch
                value={cs.autoCascadeEnabled}
                onValueChange={(v) => {
                  void Haptics.selectionAsync();
                  updateSettings({ autoCascadeEnabled: v });
                }}
                trackColor={{ false: C.border, true: "rgba(201,168,76,0.5)" }}
                thumbColor={cs.autoCascadeEnabled ? C.gold : C.textMuted}
              />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={styles.settingLabel}>Auto-cascade MT5 trades</Text>
                <Text style={styles.settingHint}>
                  When ON, any trade opened directly in MT5 will automatically get cascade limit orders placed using the settings above.
                </Text>
              </View>
            </View>

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

          {/* About */}
          <View style={styles.aboutCard}>
            <View style={styles.goldBar}>
              <Text style={styles.goldBarSymbol}>XAU/USD</Text>
              <Text style={styles.goldBarName}>Gold · MetaTrader 5</Text>
            </View>
            <Text style={styles.aboutText}>
              Connects to your MT5 broker account via MetaAPI. Trades are placed live on your account. Always use a demo account first to test.
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
  cascadeCard: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: C.border,
    gap: 14,
  },
  cascadeCardHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  cascadeCardTitle: { fontSize: 16, fontFamily: "Inter_700Bold", color: C.text },
  cascadeCardDesc: { fontSize: 13, fontFamily: "Inter_400Regular", color: C.textSecondary, lineHeight: 19 },
  cascadeDivider: { height: 1, backgroundColor: C.border },
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
