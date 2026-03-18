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

function InfoRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, color ? { color } : {}]}>{value}</Text>
    </View>
  );
}

function StatusIndicator({ status }: { status: string }) {
  const configs: Record<string, { color: string; label: string; icon: "wifi" | "loader" | "wifi-off" | "alert-circle" }> = {
    connected: { color: C.buy, label: "Connected", icon: "wifi" },
    connecting: { color: C.gold, label: "Connecting...", icon: "loader" },
    disconnected: { color: C.textSecondary, label: "Disconnected", icon: "wifi-off" },
    error: { color: C.sell, label: "Error", icon: "alert-circle" },
  };
  const cfg = configs[status] ?? configs.disconnected;
  return (
    <View style={[styles.statusBadge, { borderColor: cfg.color }]}>
      <Feather name={cfg.icon} size={13} color={cfg.color} />
      <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { token, accountId, setToken, setAccountId, status, errorMsg, accountInfo, connect, disconnect } = useTrading();
  const [localToken, setLocalToken] = useState(token);
  const [localAccountId, setLocalAccountId] = useState(accountId);
  const [showToken, setShowToken] = useState(false);

  const handleConnect = async () => {
    setToken(localToken.trim());
    setAccountId(localAccountId.trim());
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setTimeout(() => connect(), 50);
  };

  const handleDisconnect = () => {
    Alert.alert("Disconnect", "Disconnect from your MT5 account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: () => {
          disconnect();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        },
      },
    ]);
  };

  const isConnecting = status === "connecting";
  const isConnected = status === "connected";
  const webTopPad = Platform.OS === "web" ? 67 : 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.background }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={[styles.container, { paddingTop: insets.top + webTopPad }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Account</Text>
          <StatusIndicator status={status} />
        </View>

        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* MetaAPI Setup Guide */}
          <View style={styles.guideCard}>
            <View style={styles.guideHeader}>
              <Feather name="info" size={16} color={C.gold} />
              <Text style={styles.guideTitle}>MetaAPI Setup</Text>
            </View>
            <Text style={styles.guideText}>
              1. Create a free account at{" "}
              <Text style={{ color: C.gold }}>metaapi.cloud</Text>
            </Text>
            <Text style={styles.guideText}>2. Connect your MT5 broker account</Text>
            <Text style={styles.guideText}>3. Copy your API token and Account ID below</Text>
          </View>

          {/* Credentials */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>CREDENTIALS</Text>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>MetaAPI Token</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.inputInner}
                  value={localToken}
                  onChangeText={setLocalToken}
                  placeholder="Paste your MetaAPI token"
                  placeholderTextColor={C.textMuted}
                  secureTextEntry={!showToken}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isConnected}
                />
                <Pressable
                  style={styles.eyeBtn}
                  onPress={() => setShowToken((s) => !s)}
                  hitSlop={8}
                >
                  <Feather name={showToken ? "eye-off" : "eye"} size={16} color={C.textSecondary} />
                </Pressable>
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Account ID</Text>
              <TextInput
                style={styles.input}
                value={localAccountId}
                onChangeText={setLocalAccountId}
                placeholder="Your MT5 account ID"
                placeholderTextColor={C.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isConnected}
              />
            </View>

            {errorMsg ? (
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={14} color={C.sell} />
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {isConnected ? (
              <Pressable
                style={({ pressed }) => [styles.disconnectBtn, pressed && { opacity: 0.75 }]}
                onPress={handleDisconnect}
              >
                <Feather name="log-out" size={16} color={C.sell} />
                <Text style={styles.disconnectText}>Disconnect</Text>
              </Pressable>
            ) : (
              <Pressable
                style={({ pressed }) => [
                  styles.connectBtn,
                  pressed && { opacity: 0.85 },
                  isConnecting && { opacity: 0.6 },
                ]}
                onPress={handleConnect}
                disabled={isConnecting || !localToken.trim() || !localAccountId.trim()}
              >
                {isConnecting ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <>
                    <Feather name="zap" size={16} color="#000" />
                    <Text style={styles.connectText}>Connect Account</Text>
                  </>
                )}
              </Pressable>
            )}
          </View>

          {/* Account Info */}
          {isConnected && accountInfo && (
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>ACCOUNT INFO</Text>
              <InfoRow label="Name" value={accountInfo.name} />
              <View style={styles.infoDivider} />
              <InfoRow label="Currency" value={accountInfo.currency} />
              <View style={styles.infoDivider} />
              <InfoRow label="Leverage" value={`1:${accountInfo.leverage}`} />
              <View style={styles.infoDivider} />
              <InfoRow
                label="Balance"
                value={`$${accountInfo.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
                color={C.text}
              />
              <View style={styles.infoDivider} />
              <InfoRow
                label="Equity"
                value={`$${accountInfo.equity.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
                color={accountInfo.equity >= accountInfo.balance ? C.buy : C.sell}
              />
              <View style={styles.infoDivider} />
              <InfoRow
                label="Free Margin"
                value={`$${accountInfo.freeMargin.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
              />
            </View>
          )}

          {/* About */}
          <View style={styles.aboutCard}>
            <View style={styles.goldBar}>
              <Text style={styles.goldBarText}>XAUUSD</Text>
              <Text style={styles.goldBarSub}>Gold / US Dollar</Text>
            </View>
            <Text style={styles.aboutText}>
              This app connects to your MetaTrader 5 account via MetaAPI to place market orders on XAUUSD with automatic stop loss management.
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
  guideCard: {
    backgroundColor: "rgba(201, 168, 76, 0.08)",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(201, 168, 76, 0.25)",
    gap: 8,
  },
  guideHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 2,
  },
  guideTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.gold,
  },
  guideText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 19,
  },
  sectionCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
    gap: 14,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    overflow: "hidden",
  },
  inputInner: {
    flex: 1,
    backgroundColor: "transparent",
    height: 48,
    paddingHorizontal: 16,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.text,
  },
  input: {
    backgroundColor: C.surface,
    borderRadius: 12,
    height: 48,
    paddingHorizontal: 16,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.text,
    borderWidth: 1,
    borderColor: C.border,
  },
  eyeBtn: {
    width: 44,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(246, 70, 93, 0.1)",
    borderRadius: 10,
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.gold,
    borderRadius: 14,
    paddingVertical: 15,
  },
  connectText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#000",
  },
  disconnectBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: C.sell,
    backgroundColor: "rgba(246, 70, 93, 0.06)",
  },
  disconnectText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: C.sell,
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
  aboutCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: C.border,
  },
  goldBar: {
    backgroundColor: C.gold,
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  goldBarText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#000",
    letterSpacing: 2,
  },
  goldBarSub: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "rgba(0,0,0,0.6)",
  },
  aboutText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    lineHeight: 20,
    padding: 16,
  },
});
