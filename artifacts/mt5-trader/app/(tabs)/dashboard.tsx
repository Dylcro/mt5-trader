import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";

import PeriodToggle from "@/components/PeriodToggle";
import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";
import { useRealizedPnl } from "@/hooks/useRealizedPnl";
import { useZones } from "@/hooks/useZones";
import { useDisplayCurrency } from "@/hooks/useDisplayCurrency";
import { normalizeDisplayCurrency } from "@/lib/displayCurrency";
import { formatMoney as formatMoneyRaw, formatPrice } from "@/lib/formatters";
import {
  filterClosedZonesByPeriod,
  avgClosedZonePnlFromTotal,
  winRatePct,
  type Period,
} from "@/lib/zoneStats";

const C = Colors.dark;

function DashStatCard({
  icon,
  iconColor,
  note,
  value,
  valueColor,
  label,
}: {
  icon: React.ReactNode;
  iconColor?: string;
  note: string;
  value: string;
  valueColor?: string;
  label: string;
}) {
  return (
    <View style={styles.dashStat}>
      <View style={styles.dashStatTop}>
        <View style={[styles.dashStatIcon, iconColor ? { backgroundColor: `${iconColor}18` } : null]}>
          {icon}
        </View>
        <Text style={styles.dashStatNote}>{note}</Text>
      </View>
      <Text style={[styles.dashStatValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
      <Text style={styles.dashStatLabel}>{label}</Text>
    </View>
  );
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const {
    status,
    accountInfo,
    price,
    priceError,
    accountId,
    region,
    credentials,
    refreshPositions,
    refreshAccountInfo,
    refreshPrice,
    sseConnected,
    syncSession,
  } = useTrading();
  const { zones, refresh, loading } = useZones(accountId, {
    includeClosed: true,
    pollIntervalMs: 10_000,
    sseConnected,
  });
  const [period, setPeriod] = useState<Period>("today");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useFocusEffect(
    useCallback(() => {
      if (status !== "connected" || !accountId) return;
      void syncSession();
      const id = setInterval(() => void syncSession(), 10_000);
      return () => clearInterval(id);
    }, [status, accountId, syncSession]),
  );

  const openZones = zones.filter((z) => z.status === "OPEN" || z.status === "RISK_FREE");
  const closedAll = zones.filter((z) => z.status === "CLOSED");
  const periodClosed = useMemo(
    () => filterClosedZonesByPeriod(zones, period),
    [zones, period],
  );

  const riskFreeCount = openZones.filter((z) => z.status === "RISK_FREE").length;

  const { pnl: closedPnl, loading: closedPnlLoading } = useRealizedPnl(
    accountId,
    period,
    region,
    refreshKey,
  );

  const winRate = winRatePct(periodClosed);
  const avgZonePnl = useMemo(
    () => avgClosedZonePnlFromTotal(periodClosed, closedPnl ?? null),
    [periodClosed, closedPnl],
  );
  const floatingPnl =
    accountInfo != null ? accountInfo.equity - accountInfo.balance : null;

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refresh(), refreshPositions(), refreshAccountInfo(), refreshPrice()]);
    setRefreshKey((k) => k + 1);
    setRefreshing(false);
  };

  const { brokerCurrency } = useDisplayCurrency();
  const moneyCurrency = brokerCurrency ?? normalizeDisplayCurrency(accountInfo?.currency);
  const formatMoney = (n: number, opts?: { signed?: boolean; decimals?: number }) =>
    formatMoneyRaw(n, { ...opts, currency: moneyCurrency });
  const leverageLabel = accountInfo ? `1:${accountInfo.leverage}` : "—";
  const serverLabel = credentials.server || region || "—";
  const streaming = sseConnected && !priceError && price != null;
  const periodNote = period === "today" ? "today" : "this week";

  return (
    <ScrollView
      style={[styles.screen, { paddingTop: insets.top + 12 }]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={C.gold} />
      }
    >
      <View style={styles.headerRow}>
        <Text style={styles.title}>Dashboard</Text>
        <Pressable
          onPress={() => void onRefresh()}
          style={({ pressed }) => [styles.refreshBtn, pressed && { opacity: 0.6 }]}
          hitSlop={8}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={C.navy} />
          ) : (
            <Feather name="refresh-cw" size={18} color={C.navy} />
          )}
        </Pressable>
      </View>

      <View style={styles.hero}>
        <Text style={styles.heroLabel}>ACCOUNT BALANCE</Text>
        <Text style={styles.heroBalance}>
          {accountInfo ? formatMoney(accountInfo.balance) : "—"}
        </Text>
        <Text style={styles.heroMeta}>
          {accountInfo?.currency ?? "—"} · {leverageLabel} · {serverLabel}
        </Text>
        <View style={styles.heroTiles}>
          <View style={styles.heroTile}>
            <Text style={styles.heroTileLabel}>EQUITY</Text>
            <Text style={[styles.heroTileValue, { color: C.buy }]}>
              {accountInfo ? formatMoney(accountInfo.equity) : "—"}
            </Text>
          </View>
          <View style={styles.heroTileDivider} />
          <View style={styles.heroTile}>
            <Text style={styles.heroTileLabel}>FREE MARGIN</Text>
            <Text style={styles.heroTileValue}>
              {accountInfo ? formatMoney(accountInfo.freeMargin) : "—"}
            </Text>
          </View>
          <View style={styles.heroTileDivider} />
          <View style={styles.heroTile}>
            <Text style={styles.heroTileLabel}>P&L</Text>
            <Text
              style={[
                styles.heroTileValue,
                floatingPnl != null && floatingPnl >= 0 ? { color: C.buy } : { color: C.sell },
              ]}
            >
              {floatingPnl != null ? formatMoney(floatingPnl, { signed: true }) : "—"}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.periodRow}>
        <Text style={styles.periodHint}>Profitable zones & closed P&L</Text>
        <PeriodToggle value={period} onChange={setPeriod} />
      </View>

      <View style={styles.statGrid}>
        <DashStatCard
          icon={<Feather name="zap" size={16} color={C.gold} />}
          iconColor={C.gold}
          note={`${riskFreeCount} risk-free`}
          value={loading ? "…" : String(openZones.length)}
          valueColor={C.gold}
          label="Active Zones"
        />
        <DashStatCard
          icon={<Feather name="award" size={16} color={C.buy} />}
          iconColor={C.buy}
          note={periodNote}
          value={winRate != null ? `${winRate}%` : "—"}
          valueColor={C.buy}
          label="Win Rate"
        />
        <DashStatCard
          icon={<Feather name="calendar" size={16} color={C.textSecondary} />}
          note={`${periodClosed.length} zone${periodClosed.length === 1 ? "" : "s"}`}
          value={
            closedPnlLoading && closedPnl == null
              ? "…"
              : closedPnl != null
                ? formatMoney(closedPnl, { signed: true })
                : "—"
          }
          valueColor={
            closedPnl != null ? (closedPnl >= 0 ? C.buy : C.sell) : C.text
          }
          label={period === "today" ? "Realized P&L Today" : "Realized P&L Week"}
        />
        <DashStatCard
          icon={<Feather name="trending-up" size={16} color={C.buy} />}
          iconColor={C.buy}
          note={`${periodClosed.length} closed`}
          value={avgZonePnl != null ? formatMoney(avgZonePnl, { signed: true }) : "—"}
          valueColor={
            avgZonePnl != null ? (avgZonePnl >= 0 ? C.buy : C.sell) : C.text
          }
          label={period === "today" ? "Avg P&L / Zone" : "Avg P&L / Zone"}
        />
      </View>

      <View style={styles.liveCard}>
        <View style={styles.liveHeader}>
          <Text style={styles.liveTitle}>XAUUSD LIVE</Text>
          <View style={styles.streamRow}>
            <View
              style={[
                styles.streamDot,
                streaming ? { backgroundColor: C.buy } : { backgroundColor: C.textMuted },
              ]}
            />
            <Text style={[styles.streamText, streaming ? { color: C.buy } : { color: C.textMuted }]}>
              {streaming ? "STREAMING" : status === "connected" ? "RECONNECTING" : status.toUpperCase()}
            </Text>
          </View>
        </View>
        <View style={styles.livePrices}>
          <View style={styles.liveCol}>
            <Text style={styles.liveLabel}>BID</Text>
            <Text style={[styles.livePrice, { color: C.sell }]}>
              {price ? formatPrice(price.bid) : "—"}
            </Text>
          </View>
          <View style={styles.liveCol}>
            <Text style={styles.liveLabel}>ASK</Text>
            <Text style={[styles.livePrice, { color: C.buy }]}>
              {price ? formatPrice(price.ask) : "—"}
            </Text>
          </View>
          <View style={styles.liveCol}>
            <Text style={styles.liveLabel}>SPREAD</Text>
            <Text style={styles.liveSpread}>
              {price ? `${Math.round(price.spread)}p` : "—"}
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  content: { paddingHorizontal: 16, paddingBottom: 120 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  hero: {
    backgroundColor: C.navy,
    borderRadius: 18,
    padding: 20,
    marginBottom: 16,
  },
  heroLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: C.onDarkMuted,
    letterSpacing: 1,
    marginBottom: 6,
  },
  heroBalance: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: C.onDark,
    marginBottom: 6,
  },
  heroMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.onDarkMuted,
    marginBottom: 16,
  },
  heroTiles: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 12,
    paddingVertical: 12,
  },
  heroTile: { flex: 1, alignItems: "center", gap: 4 },
  heroTileDivider: {
    width: 1,
    backgroundColor: "rgba(255,255,255,0.12)",
    marginVertical: 4,
  },
  heroTileLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: C.onDarkMuted,
    letterSpacing: 0.8,
  },
  heroTileValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: C.onDark,
  },
  periodRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  periodHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
  },
  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 16,
  },
  dashStat: {
    width: "47%",
    flexGrow: 1,
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    minWidth: 150,
  },
  dashStatTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  dashStatIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.surface,
  },
  dashStatNote: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    flex: 1,
    textAlign: "right",
  },
  dashStatValue: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: C.text,
    marginBottom: 2,
  },
  dashStatLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  liveCard: {
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
  },
  liveHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  liveTitle: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: C.textSecondary,
    letterSpacing: 0.8,
  },
  streamRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  streamDot: { width: 6, height: 6, borderRadius: 3 },
  streamText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  livePrices: { flexDirection: "row" },
  liveCol: { flex: 1, alignItems: "center", gap: 4 },
  liveLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
    letterSpacing: 0.8,
  },
  livePrice: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  liveSpread: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: C.textSecondary,
  },
});
