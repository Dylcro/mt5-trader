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

import Colors from "@/constants/colors";
import { useTrading, type Position } from "@/context/TradingContext";
import { useZones } from "@/hooks/useZones";
import { formatMoney, formatPrice, pipsFromEntry } from "@/lib/formatters";
import { isPositionRiskFree } from "@/lib/zoneStats";
import { parseCascadeLeg } from "@/lib/zoneComments";

const C = Colors.dark;

function PositionCard({
  position,
  cascadeLabel,
  riskFree,
  onPress,
}: {
  position: Position;
  cascadeLabel: string;
  riskFree: boolean;
  onPress: () => void;
}) {
  const isBuy = position.type === "POSITION_TYPE_BUY";
  const dir: "buy" | "sell" = isBuy ? "buy" : "sell";
  const pips = pipsFromEntry(dir, position.openPrice, position.currentPrice);
  const positive = position.profit >= 0;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.92 }]}
    >
      <View style={styles.cardTop}>
        <View style={[styles.dirIcon, isBuy ? styles.dirIconBuy : styles.dirIconSell]}>
          <Feather
            name={isBuy ? "arrow-up-right" : "arrow-down-right"}
            size={14}
            color={isBuy ? C.buy : C.sell}
          />
        </View>
        <View style={styles.cardTitleWrap}>
          <Text style={styles.cardTitle}>
            <Text style={{ color: isBuy ? C.buy : C.sell, fontFamily: "Inter_700Bold" }}>
              {isBuy ? "BUY" : "SELL"}
            </Text>
            <Text style={styles.cardTitleMuted}> · {position.volume.toFixed(2)} lot</Text>
          </Text>
          <Text style={styles.cascadeLabel}>{cascadeLabel}</Text>
        </View>
        {riskFree ? (
          <View style={styles.badgeRiskFree}>
            <Feather name="shield" size={10} color={C.buy} />
            <Text style={styles.badgeRiskFreeText}>RISK FREE</Text>
          </View>
        ) : (
          <View style={styles.badgeOpen}>
            <View style={styles.openDot} />
            <Text style={styles.badgeOpenText}>OPEN</Text>
          </View>
        )}
      </View>

      <View style={styles.statRow}>
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>Entry</Text>
          <Text style={styles.statValue}>{formatPrice(position.openPrice)}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>SL</Text>
          <Text style={[styles.statValue, { color: C.sell }]}>
            {position.stopLoss != null ? formatPrice(position.stopLoss) : "—"}
          </Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>Now</Text>
          <Text style={styles.statValue}>{formatPrice(position.currentPrice)}</Text>
        </View>
      </View>

      <View style={styles.cardFooter}>
        <Text style={styles.pipsText}>{pips.toFixed(1)} pips</Text>
        <Text style={[styles.plText, { color: positive ? C.buy : C.sell }]}>
          {formatMoney(position.profit, { signed: true })}
        </Text>
      </View>
    </Pressable>
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
  const { zones } = useZones(accountId, {
    includeClosed: true,
    pollIntervalMs: 10_000,
    sseConnected,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const zoneById = useMemo(() => {
    const map = new Map<string, (typeof zones)[number]>();
    for (const z of zones) map.set(z.zoneId, z);
    return map;
  }, [zones]);

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

  const handleClosePosition = useCallback(
    (position: Position) => {
      const dir = position.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL";
      Alert.alert(
        "Close Position",
        `Close ${dir} ${position.volume.toFixed(2)} lots?\n\nP&L: ${formatMoney(position.profit, { signed: true })}`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Close",
            style: "destructive",
            onPress: async () => {
              setBusyId(position.id);
              const result = await closePosition(position.id);
              setBusyId(null);
              if (!result.success) {
                Alert.alert("Error", result.message);
              } else {
                await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            },
          },
        ],
      );
    },
    [closePosition],
  );

  const resolveCascade = (position: Position) => {
    const parsed = parseCascadeLeg(position.comment);
    if (parsed) return `Cascade ${parsed.leg}/${parsed.total}`;
    return "Cascade —";
  };

  const resolveRiskFree = (position: Position) => {
    const parsed = parseCascadeLeg(position.comment);
    const zone = parsed ? zoneById.get(parsed.zoneId) : undefined;
    const dir = position.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
    return isPositionRiskFree(dir, position.openPrice, position.stopLoss, zone?.status);
  };

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
        ) : positions.length === 0 ? (
          <View style={styles.emptyState}>
            <Feather name="inbox" size={40} color={C.textMuted} />
            <Text style={styles.emptyTitle}>No Open Positions</Text>
            <Text style={styles.emptyText}>Head to the Trade tab to place your first XAUUSD trade</Text>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {positions.map((p) => (
              <View key={p.id} style={busyId === p.id ? { opacity: 0.5 } : undefined}>
                <PositionCard
                  position={p}
                  cascadeLabel={resolveCascade(p)}
                  riskFree={resolveRiskFree(p)}
                  onPress={() => handleClosePosition(p)}
                />
              </View>
            ))}
          </View>
        )}

        {status === "connected" && pendingOrders.length > 0 && (
          <View style={{ gap: 10, marginTop: positions.length > 0 ? 16 : 0 }}>
            <Text style={styles.pendingLabel}>PENDING · {pendingOrders.length}</Text>
            {pendingOrders.map((order) => {
              const isBuy = order.type.includes("BUY");
              return (
                <View key={order.id} style={[styles.card, styles.pendingCard]}>
                  <Text style={styles.cardTitle}>
                    <Text style={{ color: isBuy ? C.buy : C.sell, fontFamily: "Inter_700Bold" }}>
                      {isBuy ? "BUY" : "SELL"} LIMIT
                    </Text>
                    <Text style={styles.cardTitleMuted}> · {order.volume.toFixed(2)} lot</Text>
                  </Text>
                  <Text style={styles.cascadeLabel}>@ {formatPrice(order.openPrice)}</Text>
                  <Pressable
                    style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.7 }]}
                    onPress={() => {
                      Alert.alert(
                        "Cancel Order",
                        `Cancel limit @ ${formatPrice(order.openPrice)}?`,
                        [
                          { text: "Keep", style: "cancel" },
                          {
                            text: "Cancel",
                            style: "destructive",
                            onPress: async () => {
                              const result = await cancelOrder(order.id);
                              if (!result.success) Alert.alert("Error", result.message);
                            },
                          },
                        ],
                      );
                    }}
                  >
                    <Text style={styles.cancelBtnText}>Cancel Order</Text>
                  </Pressable>
                </View>
              );
            })}
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
  container: {
    flex: 1,
    backgroundColor: C.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  openCount: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: C.textMuted,
  },
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
  plBannerValue: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
  },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 12,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dirIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  dirIconBuy: { backgroundColor: C.buyDim },
  dirIconSell: { backgroundColor: C.sellDim },
  cardTitleWrap: { flex: 1 },
  cardTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  cardTitleMuted: {
    color: C.textSecondary,
    fontFamily: "Inter_400Regular",
  },
  cascadeLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 2,
  },
  badgeRiskFree: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: C.buyDim,
    borderWidth: 1,
    borderColor: C.buyBorder,
  },
  badgeRiskFreeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: C.buy,
    letterSpacing: 0.5,
  },
  badgeOpen: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: C.goldLight,
    borderWidth: 1,
    borderColor: C.goldBorder,
  },
  openDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.gold,
  },
  badgeOpenText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: C.gold,
    letterSpacing: 0.5,
  },
  statRow: {
    flexDirection: "row",
    backgroundColor: C.surface,
    borderRadius: 10,
    overflow: "hidden",
  },
  statCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    gap: 4,
  },
  statDivider: {
    width: 1,
    backgroundColor: C.border,
    marginVertical: 8,
  },
  statLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
  },
  statValue: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pipsText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
  },
  plText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  syncRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 16,
  },
  syncText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 60,
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    textAlign: "center",
    lineHeight: 20,
  },
  pendingLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: C.textMuted,
    letterSpacing: 1.2,
  },
  pendingCard: {
    borderStyle: "dashed",
    borderColor: C.gold,
  },
  cancelBtn: {
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    backgroundColor: C.surface,
  },
  cancelBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
  },
});
