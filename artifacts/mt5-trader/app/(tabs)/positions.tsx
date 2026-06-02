import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
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
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";
import { useTrading, type PendingOrder, type Position } from "@/context/TradingContext";
import { useCascadeSettings } from "@/hooks/useCascadeSettings";
import { useZones } from "@/hooks/useZones";
import ZoneCard from "@/components/ZoneCard";
import { useDisplayCurrency } from "@/hooks/useDisplayCurrency";
import {
  buildDisplayActiveZones,
  pendingWithoutZone,
  positionsWithoutZone,
} from "@/lib/zoneDisplay";

const C = Colors.dark;

function formatPrice(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ProfitBadge({ profit }: { profit: number }) {
  const { formatMoney } = useDisplayCurrency();
  const positive = profit >= 0;
  return (
    <View style={[styles.profitBadge, positive ? styles.profitPositive : styles.profitNegative]}>
      <Feather
        name={positive ? "arrow-up-right" : "arrow-down-right"}
        size={12}
        color={positive ? C.buy : C.sell}
      />
      <Text style={[styles.profitText, { color: positive ? C.buy : C.sell }]}>
        {formatMoney(profit, { signed: true })}
      </Text>
    </View>
  );
}

// Groups one direction's worth of orphan positions (positions that aren't
// tracked by any zone — typically a cascade whose zone wasn't created, or a
// legacy trade) into a single zone-style card. The user explicitly does not
// want per-position cards: every open trade is shown as a roll-up so the
// Positions tab always looks like "N zones / N groups", never a flat list.
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
  // Volume-weighted average entry — the right number to show for a cascade
  // where each leg has the same lot size but lands at different prices.
  const avgEntry = totalVolume > 0
    ? positions.reduce((s, p) => s + p.openPrice * p.volume, 0) / totalVolume
    : 0;
  const currentPrice = positions[0]?.currentPrice ?? 0;
  // Show a single SL value only if every position shares it (the cascade
  // case). Mixed SLs would be misleading rolled into one number.
  const slValues = positions.map((p) => p.stopLoss).filter((sl): sl is number => sl != null);
  const sharedSl = slValues.length === positions.length && slValues.length > 0
    && slValues.every((sl) => Math.abs(sl - slValues[0]!) < 0.005)
    ? slValues[0]!
    : null;

  const handleClose = async () => {
    if (closing) return;
    setClosing(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onCloseAll(positions);
    setClosing(false);
  };

  return (
    <View style={styles.posCard}>
      <View style={styles.posTop}>
        <View style={styles.posLeft}>
          <View style={[styles.dirPill, isBuy ? styles.dirPillBuy : styles.dirPillSell]}>
            <Feather
              name={isBuy ? "trending-up" : "trending-down"}
              size={12}
              color={isBuy ? "#000" : "#fff"}
            />
            <Text style={[styles.dirPillText, { color: isBuy ? "#000" : "#fff" }]}>
              {isBuy ? "BUY" : "SELL"}
            </Text>
          </View>
          <Text style={styles.posSymbol}>{symbol}</Text>
          <Text style={styles.posVol}>
            {positions.length} {positions.length === 1 ? "position" : "positions"}  ·  {totalVolume.toFixed(2)} lots
          </Text>
        </View>
        <ProfitBadge profit={totalProfit} />
      </View>

      <View style={styles.posPriceRow}>
        <View style={styles.posPriceItem}>
          <Text style={styles.posPriceLabel}>AVG ENTRY</Text>
          <Text style={styles.posPriceVal}>{formatPrice(avgEntry)}</Text>
        </View>
        <View style={styles.posPriceDivider} />
        <View style={styles.posPriceItem}>
          <Text style={styles.posPriceLabel}>CURRENT</Text>
          <Text style={[styles.posPriceVal, { color: totalProfit >= 0 ? C.buy : C.sell }]}>
            {formatPrice(currentPrice)}
          </Text>
        </View>
        {sharedSl != null && (
          <>
            <View style={styles.posPriceDivider} />
            <View style={styles.posPriceItem}>
              <Text style={styles.posPriceLabel}>STOP LOSS</Text>
              <Text style={[styles.posPriceVal, { color: C.sell }]}>{formatPrice(sharedSl)}</Text>
            </View>
          </>
        )}
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.closeBtn,
          pressed && { opacity: 0.7 },
          closing && { opacity: 0.5 },
        ]}
        onPress={handleClose}
        disabled={closing}
      >
        {closing ? (
          <ActivityIndicator size="small" color={C.text} />
        ) : (
          <>
            <Feather name="x-circle" size={14} color={C.textSecondary} />
            <Text style={styles.closeBtnText}>
              Close {positions.length === 1 ? "Position" : `All (${positions.length})`}
            </Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

function PendingOrderCard({ order, onCancel }: { order: PendingOrder; onCancel: () => void }) {
  const isBuyLimit = order.type.includes("BUY");
  const [cancelling, setCancelling] = useState(false);

  const typeLabel = order.type === "ORDER_TYPE_BUY_LIMIT" ? "BUY LIMIT"
    : order.type === "ORDER_TYPE_SELL_LIMIT" ? "SELL LIMIT"
    : order.type === "ORDER_TYPE_BUY_STOP" ? "BUY STOP"
    : order.type === "ORDER_TYPE_SELL_STOP" ? "SELL STOP"
    : order.type.replace("ORDER_TYPE_", "").replace(/_/g, " ");

  const handleCancel = async () => {
    setCancelling(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onCancel();
    setCancelling(false);
  };

  return (
    <View style={[styles.posCard, styles.pendingCard]}>
      <View style={styles.posTop}>
        <View style={styles.posLeft}>
          <View style={[styles.dirPill, isBuyLimit ? styles.dirPillBuy : styles.dirPillSell]}>
            <Feather name={isBuyLimit ? "trending-up" : "trending-down"} size={12} color={isBuyLimit ? "#000" : "#fff"} />
            <Text style={[styles.dirPillText, { color: isBuyLimit ? "#000" : "#fff" }]}>{typeLabel}</Text>
          </View>
          <Text style={styles.posSymbol}>{order.symbol}</Text>
          <Text style={styles.posVol}>{order.volume} lots</Text>
        </View>
        <View style={styles.pendingBadge}>
          <Text style={styles.pendingBadgeText}>PENDING</Text>
        </View>
      </View>

      <View style={styles.posPriceRow}>
        <View style={styles.posPriceItem}>
          <Text style={styles.posPriceLabel}>LIMIT PRICE</Text>
          <Text style={[styles.posPriceVal, { color: isBuyLimit ? C.buy : C.sell }]}>{formatPrice(order.openPrice)}</Text>
        </View>
        {order.stopLoss != null && (
          <>
            <View style={styles.posPriceDivider} />
            <View style={styles.posPriceItem}>
              <Text style={styles.posPriceLabel}>STOP LOSS</Text>
              <Text style={[styles.posPriceVal, { color: C.sell }]}>{formatPrice(order.stopLoss)}</Text>
            </View>
          </>
        )}
        {order.comment != null && order.comment !== "" && (
          <>
            <View style={styles.posPriceDivider} />
            <View style={[styles.posPriceItem, { flex: 2 }]}>
              <Text style={styles.posPriceLabel}>NOTE</Text>
              <Text style={[styles.posPriceVal, { fontSize: 11 }]} numberOfLines={1}>{order.comment}</Text>
            </View>
          </>
        )}
      </View>

      <Pressable
        style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.7 }, cancelling && { opacity: 0.5 }]}
        onPress={handleCancel}
        disabled={cancelling}
      >
        {cancelling ? (
          <ActivityIndicator size="small" color={C.text} />
        ) : (
          <>
            <Feather name="x-circle" size={14} color={C.textSecondary} />
            <Text style={styles.closeBtnText}>Cancel Order</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

export default function PositionsScreen() {
  const insets = useSafeAreaInsets();
  const { formatMoney } = useDisplayCurrency();
  const { positions, pendingOrders, status, refreshPositions, refreshPendingOrders, closePosition, cancelOrder, accountId, sseConnected, price, syncSession } = useTrading();
  const { zones, refresh: refreshZones, riskFree, closeZone, cancelZoneOrders } = useZones(accountId, { includeClosed: true, pollIntervalMs: 10_000, sseConnected });
  const { settings: cs } = useCascadeSettings();
  const displayActiveZones = useMemo(
    () => buildDisplayActiveZones(zones, positions, cs, price),
    [zones, positions, cs, price],
  );
  const displayZoneIds = useMemo(
    () => new Set(displayActiveZones.map((z) => z.zoneId)),
    [displayActiveZones],
  );
  const standalonePositions = useMemo(
    () => positionsWithoutZone(positions, displayZoneIds),
    [positions, displayZoneIds],
  );
  const orphanPendingOrders = useMemo(
    () => pendingWithoutZone(pendingOrders, displayZoneIds),
    [pendingOrders, displayZoneIds],
  );
  const pastZones = zones
    .filter((z) => z.status === "CLOSED")
    .sort((a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt))
    .slice(0, 25);
  const [pastExpanded, setPastExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshZones(), refreshPositions(), refreshPendingOrders()]);
    setRefreshing(false);
  }, [refreshZones, refreshPositions, refreshPendingOrders]);

  // Poll while focused so MT5-side closes/cancels appear without manual refresh.
  useFocusEffect(
    useCallback(() => {
      if (status !== "connected" || !accountId) return;
      void syncSession();
      const sync = () => void Promise.all([
        syncSession(),
        refreshZones(),
        refreshPositions(),
        refreshPendingOrders(),
      ]);
      sync();
      const id = setInterval(sync, 4_000);
      return () => clearInterval(id);
    }, [status, accountId, syncSession, refreshZones, refreshPositions, refreshPendingOrders]),
  );

  const handleCancelOrder = useCallback(
    async (order: PendingOrder) => {
      setBusyId(order.id);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const result = await cancelOrder(order.id);
      setBusyId(null);
      if (!result.success) {
        Alert.alert("Error", result.message);
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    },
    [cancelOrder]
  );

  // Close every position in a standalone group in parallel — fires all the
  // POSITION_CLOSE_ID calls together rather than serially, matching the same
  // pattern used by the zone Close button server-side.
  const handleCloseGroup = useCallback(
    async (group: Position[]) => {
      if (group.length === 0) return;
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      const results = await Promise.all(group.map((p) => closePosition(p.id)));
      const failed = results.filter((r) => !r.success);
      if (failed.length === 0) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Alert.alert(
          "Some Positions Failed",
          `${results.length - failed.length}/${results.length} closed. ${failed[0]!.message}`,
        );
      }
    },
    [closePosition]
  );

  const [cancellingAll, setCancellingAll] = useState(false);

  const handleCancelAllLimits = useCallback(async () => {
    if (cancellingAll || orphanPendingOrders.length === 0) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setCancellingAll(true);
    await Promise.all(orphanPendingOrders.map((o) => cancelOrder(o.id)));
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCancellingAll(false);
  }, [cancellingAll, orphanPendingOrders, cancelOrder]);

  const totalPL = positions.reduce((sum, p) => sum + p.profit, 0);
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const showStandalone = standalonePositions.length > 0;
  const hasAnything =
    displayActiveZones.length > 0 || showStandalone || orphanPendingOrders.length > 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopPad }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Positions</Text>
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
              {displayActiveZones.length > 0
                ? ` · ${displayActiveZones.length} zone${displayActiveZones.length === 1 ? "" : "s"}`
                : ""}
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
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={C.gold}
          />
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
          <>
            {displayActiveZones.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>ACTIVE ZONES  ·  {displayActiveZones.length}</Text>
                <View style={{ gap: 10, marginBottom: showStandalone || orphanPendingOrders.length > 0 ? 20 : 0 }}>
                  {displayActiveZones.map((z) => (
                    <ZoneCard
                      key={z.zoneId}
                      zone={z}
                      onRiskFree={riskFree}
                      onCloseZone={closeZone}
                      onCancelOrders={cancelZoneOrders}
                      riskFreePips={cs.riskFreePips}
                    />
                  ))}
                </View>
              </>
            )}
            {showStandalone && (() => {
              const groups = new Map<string, Position[]>();
              for (const p of standalonePositions) {
                const dir = p.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
                const key = `${p.symbol}|${dir}`;
                const arr = groups.get(key) ?? [];
                arr.push(p);
                groups.set(key, arr);
              }
              const groupList = Array.from(groups.entries());
              return (
                <>
                  <Text style={styles.sectionLabel}>
                    OPEN  ·  {standalonePositions.length}
                  </Text>
                  <View style={{ gap: 10 }}>
                    {groupList.map(([key, group]) => {
                      const [symbol, dir] = key.split("|") as [string, "buy" | "sell"];
                      return (
                        <StandaloneGroupCard
                          key={key}
                          positions={group}
                          symbol={symbol}
                          direction={dir}
                          onCloseAll={handleCloseGroup}
                        />
                      );
                    })}
                  </View>
                </>
              );
            })()}
            {orphanPendingOrders.length > 0 && (
              <>
                <View style={[styles.sectionRow, { marginTop: positions.length > 0 ? 20 : 0 }]}>
                  <Text style={styles.sectionLabel}>PENDING  ·  {orphanPendingOrders.length}</Text>
                  <Pressable
                    style={({ pressed }) => [styles.cancelAllBtn, (pressed || cancellingAll) && { opacity: 0.6 }]}
                    onPress={handleCancelAllLimits}
                    disabled={cancellingAll}
                  >
                    {cancellingAll ? (
                      <ActivityIndicator size="small" color={C.sell} />
                    ) : (
                      <>
                        <Feather name="x" size={12} color={C.sell} />
                        <Text style={styles.cancelAllText}>Cancel All Limits</Text>
                      </>
                    )}
                  </Pressable>
                </View>
                {orphanPendingOrders.map((order) => (
                  <PendingOrderCard
                    key={order.id}
                    order={order}
                    onCancel={() => handleCancelOrder(order)}
                  />
                ))}
              </>
            )}
          </>
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

        {status === "connected" && pastZones.length > 0 && (
          <View style={{ marginTop: hasAnything ? 20 : 0 }}>
            <Pressable
              onPress={() => setPastExpanded((v) => !v)}
              style={({ pressed }) => [styles.pastHeader, pressed && { opacity: 0.7 }]}
              hitSlop={8}
            >
              <Text style={styles.sectionLabel}>
                PAST ZONES  ·  {pastZones.length}
              </Text>
              <Feather
                name={pastExpanded ? "chevron-up" : "chevron-down"}
                size={16}
                color={C.textSecondary}
              />
            </Pressable>
            {pastExpanded && (
              <View style={{ gap: 10, marginTop: 6 }}>
                {pastZones.map((z) => (
                  <ZoneCard key={z.zoneId} zone={z} historical />
                ))}
              </View>
            )}
          </View>
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
  headerTitle: {
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
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 4,
    gap: 12,
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
  posCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
    gap: 14,
  },
  posTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  posLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dirPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  dirPillBuy: {
    backgroundColor: C.buy,
  },
  dirPillSell: {
    backgroundColor: C.sell,
  },
  dirPillText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  posSymbol: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  posVol: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  profitBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  profitPositive: {
    backgroundColor: C.buyDim,
  },
  profitNegative: {
    backgroundColor: C.sellDim,
  },
  profitText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
  },
  posPriceRow: {
    flexDirection: "row",
    backgroundColor: C.surface,
    borderRadius: 12,
    overflow: "hidden",
  },
  posPriceItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    gap: 3,
  },
  posPriceDivider: {
    width: 1,
    backgroundColor: C.border,
    marginVertical: 8,
  },
  posPriceLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 0.8,
  },
  posPriceVal: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  closeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
  },
  closeBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
  },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  pastHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: C.textMuted,
    letterSpacing: 1.2,
  },
  cancelAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(246,70,93,0.35)",
    backgroundColor: "rgba(246,70,93,0.1)",
  },
  cancelAllText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: C.sell,
  },
  pendingCard: {
    borderStyle: "dashed",
    borderColor: C.gold,
    opacity: 0.9,
  },
  pendingBadge: {
    backgroundColor: "rgba(201,168,76,0.15)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.4)",
  },
  pendingBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    color: C.gold,
    letterSpacing: 1,
  },
});
