import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
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

import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";

const C = Colors.dark;

const POPULAR_SERVERS = [
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

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { credentials, status, errorMsg, accountInfo, connect, disconnect } = useTrading();

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

  const handleDisconnect = () => {
    Alert.alert("Disconnect", "Disconnect from your MT5 account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          await disconnect();
          setPassword("");
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        },
      },
    ]);
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

          {/* Account Info — when connected */}
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

              <Pressable
                style={({ pressed }) => [styles.disconnectBtn, pressed && { opacity: 0.75 }]}
                onPress={handleDisconnect}
              >
                <Feather name="log-out" size={16} color={C.sell} />
                <Text style={styles.disconnectText}>Disconnect Account</Text>
              </Pressable>
            </>
          )}

          {/* About */}
          <View style={styles.aboutCard}>
            <View style={styles.goldBar}>
              <Text style={styles.goldBarSymbol}>XAU/USD</Text>
              <Text style={styles.goldBarName}>Gold · MetaTrader 5</Text>
            </View>
            <Text style={styles.aboutText}>
              Connects to your MT5 broker account via MetaAPI. Trades are placed live on your account. Always use a demo account first to test.
            </Text>
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
  aboutText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 20,
    padding: 16,
  },
});
