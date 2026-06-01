import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import ZonePositionsCard from "@/components/ZonePositionsCard";
import Colors from "@/constants/colors";
import { useTrading, type PendingOrder, type Position } from "@/context/TradingContext";
import { useZones } from "@/hooks/useZones";
import { formatMoney, formatPrice } from "@/lib/formatters";
import { groupPositionsByZone } from "@/lib/groupPositionsByZone";

const C = Colors.dark;

function StandaloneGroupCard({
  positions,
  symbol,
  direction,
  onCloseAll,
}: {
  positions: Position[];
  symbol: string;
  direction: "buy" | "sell";
  onCloseAll: (positions: Position[]) => void;
}) {
  const isBuy = direction === "buy";
  const [closing, setClosing] = useState(false);
  const totalVolume = positions.reduce((s, p) => s + p.volume, 0);
  const totalProfit = positions.reduce((s, p) => s + p.profit, 0);

  return (
    <View style={styles.standaloneCard}>
      <View style={styles.standaloneHeader}>
        <Text style={styles.standaloneTitle}>
          <Text style={{ color: isBuy ? C.buy : C.sell, fontFamily: "Inter_700Bold" }}>
            {isBuy ? "BUY" : "SELL"}
          </Text>
          <Text style={styles.standaloneMuted}> · {symbol}</Text>
        </Text>
        <Text style={[styles.standalonePnl, { color: totalProfit >= 0 ? C.buy : C.sell }]}>
          {formatMoney(totalProfit, { signed: true })}
        </Text>
      </View>
      <Text style={styles.standaloneSub}>
        {positions.length} position{positions.length === 1 ? "" : "s"} · {totalVolume.toFixed(2)} lots
        {" "}(not in a tracked zone)
      </Text>
      <Pressable
        style={({ pressed }) => [styles.closeAllBtn, pressed && { opacity: 0.85 }, closing && { opacity: 0.5 }]}
        onPress={() => {
          Alert.alert(
            "Close All",
            `Close ${positions.length} standalone position${positions.length === 1 ? "" : "s"}?`,
            [
              { text: "Keep", style: "cancel" },
              {
                text: "Close All",
                style: "destructive",
                onPress: async () => {
                  setClosing(true);
                  onCloseAll(positions);
                  setClosing(false);
                },
              },
            ],
          );
        }}
        disabled={closing}
      >
        <Text style={styles.closeAllText}>Close All</Text>
      </Pressable>
    </View>
  );
}

export default function PositionsScreen() {
  const insets = useSafeAreaInsets();
  const {
    positions,
    pendingOrders,
    status,
    refreshPositions,
    refreshPendingOrders,
    closePosition,
    cancelOrder,
    accountId,
    sseConnected,
  } = useTrading();
  const { zones, closeZone } = useZones(accountId, {
    includeClosed: false,
    pollIntervalMs: 10_000,
    sseConnected,
  });
  const [refreshing, setRefreshing] = useState(false);

  const activeZones = useMemo(() => zones.filter((z) => z.status !== "CLOSED"), [zones]);

  const { buckets, orphanPositions, orphanPending } = useMemo(
    () => groupPositionsByZone(activeZones, positions, pendingOrders),
    [activeZones, positions, pendingOrders],
  );

  const totalPL = positions.reduce((sum, p) => sum + p.profit, 0);
  const webTopPad = Platform.OS === "web" ? 67 : 0;

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshPositions(), refreshPendingOrders()]);
    setRefreshing(false);
  }, [refreshPositions, refreshPendingOrders]);

  useFocusEffect(
    useCallback(() => {
      if (status !== "connected" || !accountId) return;
      const sync = () => void Promise.all([refreshPositions(), refreshPendingOrders()]);
      sync();
      const id = setInterval(sync, 4_000);
      return () => clearInterval(id);
    }, [status, accountId, refreshPositions, refreshPendingOrders]),
  );

  const handleCancelOrder = useCallback(
    (order: PendingOrder) => {
      const isBuy = order.type.includes("BUY");
      Alert.alert(
        "Cancel Order",
        `Cancel ${isBuy ? "BUY" : "SELL"} LIMIT @ ${formatPrice(order.openPrice)} (${order.volume.toFixed(2)} lots)?`,
        [
          { text: "Keep", style: "cancel" },
          {
            text: "Cancel Order",
            style: "destructive",
            onPress: async () => {
              const result = await cancelOrder(order.id);
              if (!result.success) Alert.alert("Error", result.message);
              else await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            },
          },
        ],
      );
    },
    [cancelOrder],
  );

  const handleCloseStandalone = useCallback(
    async (group: Position[]) => {
      const results = await Promise.all(group.map((p) => closePosition(p.id)));
      const failed = results.filter((r) => !r.success);
      if (failed.length === 0) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Alert.alert(
          "Some positions failed",
          `${results.length - failed.length}/${results.length} closed.`,
        );
      }
    },
    [closePosition],
  );

  const standaloneGroups = useMemo(() => {
    const groups = new Map<string, Position[]>();
    for (const p of orphanPositions) {
      const dir = p.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
      const key = `${p.symbol}|${dir}`;
      const arr = groups.get(key) ?? [];
      arr.push(p);
      groups.set(key, arr);
    }
    return Array.from(groups.entries());
  }, [orphanPositions]);

  const hasZones = buckets.length > 0;
  const hasStandalone = standaloneGroups.length > 0 || orphanPending.length > 0;
  const hasAnything = hasZones || hasStandalone || positions.length > 0 || pendingOrders.length > 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopPad }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Positions</Text>
        <Text style={styles.openCount}>{positions.length} open</Text>
      </View>

      {positions.length > 0 && (
        <View
          style={[
            styles.plBanner,
            totalPL >= 0 ? styles.plBannerPositive : styles.plBannerNegative,
          ]}
        >
          <View>
            <Text style={styles.plBannerLabel}>TOTAL FLOATING P&L</Text>
            <Text style={styles.plBannerSub}>
              {positions.length} position{positions.length === 1 ? "" : "s"} open
              {buckets.length > 0 ? ` · ${buckets.length} zone${buckets.length === 1 ? "" : "s"}` : ""}
            </Text>
          </View>
          <Text style={[styles.plBannerValue, { color: totalPL >= 0 ? C.buy : C.sell }]}>
            {formatMoney(totalPL, { signed: true })}
          </Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={C.gold} />
        }
      >
        {status !== "connected" ? (
          <View style={styles.emptyState}>
            <Feather name="wifi-off" size={40} color={C.textMuted} />
            <Text style={styles.emptyTitle}>Not Connected</Text>
            <Text style={styles.emptyText}>Connect your MT5 account in Settings to see positions</Text>
          </View>
        ) : !hasAnything ? (
          <View style={styles.emptyState}>
            <Feather name="inbox" size={40} color={C.textMuted} />
            <Text style={styles.emptyTitle}>No Open Positions</Text>
            <Text style={styles.emptyText}>Head to the Trade tab to place your first XAUUSD trade</Text>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {buckets.map((b) => (
              <ZonePositionsCard
                key={b.zoneId}
                zoneId={b.zoneId}
                zone={b.zone}
                positions={b.positions}
                pendingOrders={b.pending}
                onCloseZone={closeZone}
                onCancelOrder={handleCancelOrder}
              />
            ))}

            {standaloneGroups.map(([key, group]) => {
              const [symbol, dir] = key.split("|") as [string, "buy" | "sell"];
              return (
                <StandaloneGroupCard
                  key={key}
                  symbol={symbol}
                  direction={dir}
                  positions={group}
                  onCloseAll={handleCloseStandalone}
                />
              );
            })}

            {orphanPending.map((o) => (
              <View key={o.id} style={styles.orphanPending}>
                <Text style={styles.orphanPendingTitle}>
                  Pending limit (no zone) · @ {formatPrice(o.openPrice)}
                </Text>
                <Pressable
                  style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.7 }]}
                  onPress={() => handleCancelOrder(o)}
                >
                  <Text style={styles.cancelBtnText}>Cancel Order</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {status === "connected" && (
          <Pressable
            style={({ pressed }) => [styles.syncRow, pressed && { opacity: 0.6 }]}
            onPress={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? (
              <ActivityIndicator size={12} color={C.textMuted} />
            ) : (
              <Feather name="refresh-cw" size={12} color={C.textMuted} />
            )}
            <Text style={styles.syncText}>
              {refreshing ? "Refreshing…" : sseConnected ? "Live sync" : "Polling · refresh"}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.background },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { fontSize: 28, fontFamily: "Inter_700Bold", color: C.text },
  openCount: { fontSize: 14, fontFamily: "Inter_500Medium", color: C.textMuted },
  plBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
  },
  plBannerPositive: {
    backgroundColor: C.buyDim,
    borderWidth: 1,
    borderColor: C.buyBorder,
  },
  plBannerNegative: {
    backgroundColor: C.sellDim,
    borderWidth: 1,
    borderColor: C.sellBorder,
  },
  plBannerLabel: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: C.textSecondary,
    letterSpacing: 0.8,
  },
  plBannerSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 2,
  },
  plBannerValue: { fontSize: 24, fontFamily: "Inter_700Bold" },
  scroll: { paddingHorizontal: 16, paddingTop: 4 },
  syncRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 16,
  },
  syncText: { fontSize: 11, fontFamily: "Inter_400Regular", color: C.textMuted },
  emptyState: {
    alignItems: "center",
    paddingVertical: 60,
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: C.textSecondary },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  standaloneCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 10,
  },
  standaloneHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  standaloneTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: C.text },
  standaloneMuted: { color: C.textSecondary, fontFamily: "Inter_400Regular" },
  standalonePnl: { fontSize: 18, fontFamily: "Inter_700Bold" },
  standaloneSub: { fontSize: 11, color: C.textMuted, fontFamily: "Inter_400Regular" },
  closeAllBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.sellBorder,
    backgroundColor: C.sellDim,
    alignItems: "center",
  },
  closeAllText: { fontSize: 13, fontFamily: "Inter_700Bold", color: C.sell },
  orphanPending: {
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    borderStyle: "dashed",
    padding: 12,
    gap: 8,
  },
  orphanPendingTitle: { fontSize: 12, fontFamily: "Inter_500Medium", color: C.textSecondary },
  cancelBtn: {
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    backgroundColor: C.surface,
  },
  cancelBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: C.textSecondary },
});
