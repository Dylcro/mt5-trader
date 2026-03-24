import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useState } from "react";
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
import { useTrading, type PendingOrder, type Position } from "@/context/TradingContext";

const C = Colors.dark;

function formatPrice(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ProfitBadge({ profit }: { profit: number }) {
  const positive = profit >= 0;
  return (
    <View style={[styles.profitBadge, positive ? styles.profitPositive : styles.profitNegative]}>
      <Feather
        name={positive ? "arrow-up-right" : "arrow-down-right"}
        size={12}
        color={positive ? C.buy : C.sell}
      />
      <Text style={[styles.profitText, { color: positive ? C.buy : C.sell }]}>
        {positive ? "+" : ""}${profit.toFixed(2)}
      </Text>
    </View>
  );
}

function PositionCard({ pos, onClose }: { pos: Position; isBusy: boolean; onClose: () => void }) {
  const isBuy = pos.type === "POSITION_TYPE_BUY";
  const [closing, setClosing] = useState(false);

  const handleClose = async () => {
    setClosing(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onClose();
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
          <Text style={styles.posSymbol}>{pos.symbol}</Text>
          <Text style={styles.posVol}>{pos.volume} lots</Text>
        </View>
        <ProfitBadge profit={pos.profit} />
      </View>

      <View style={styles.posPriceRow}>
        <View style={styles.posPriceItem}>
          <Text style={styles.posPriceLabel}>OPEN</Text>
          <Text style={styles.posPriceVal}>{formatPrice(pos.openPrice)}</Text>
        </View>
        <View style={styles.posPriceDivider} />
        <View style={styles.posPriceItem}>
          <Text style={styles.posPriceLabel}>CURRENT</Text>
          <Text style={[styles.posPriceVal, { color: pos.profit >= 0 ? C.buy : C.sell }]}>
            {formatPrice(pos.currentPrice)}
          </Text>
        </View>
        {pos.stopLoss != null && (
          <>
            <View style={styles.posPriceDivider} />
            <View style={styles.posPriceItem}>
              <Text style={styles.posPriceLabel}>STOP LOSS</Text>
              <Text style={[styles.posPriceVal, { color: C.sell }]}>{formatPrice(pos.stopLoss)}</Text>
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
            <Text style={styles.closeBtnText}>Close Position</Text>
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
  const { positions, pendingOrders, status, refreshPositions, closePosition, cancelOrder, accountInfo } = useTrading();
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshPositions();
    setRefreshing(false);
  }, [refreshPositions]);

  const handleCancelOrder = useCallback(
    async (order: PendingOrder) => {
      Alert.alert(
        "Cancel Order",
        `Cancel ${order.type.includes("BUY") ? "BUY" : "SELL"} LIMIT @ ${formatPrice(order.openPrice)} (${order.volume} lots)?`,
        [
          { text: "Keep", style: "cancel" },
          {
            text: "Cancel Order",
            style: "destructive",
            onPress: async () => {
              setBusyId(order.id);
              const result = await cancelOrder(order.id);
              setBusyId(null);
              if (!result.success) {
                Alert.alert("Error", result.message);
              } else {
                await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            },
          },
        ]
      );
    },
    [cancelOrder]
  );

  const handleClose = useCallback(
    async (pos: Position) => {
      Alert.alert(
        "Close Position",
        `Close ${pos.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL"} ${pos.volume} lots @ ${formatPrice(pos.currentPrice)}?\n\nP&L: ${pos.profit >= 0 ? "+" : ""}${pos.profit.toFixed(2)}`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Close",
            style: "destructive",
            onPress: async () => {
              setBusyId(pos.id);
              const result = await closePosition(pos.id);
              setBusyId(null);
              if (!result.success) {
                Alert.alert("Error", result.message);
              } else {
                await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            },
          },
        ]
      );
    },
    [closePosition]
  );

  const totalPL = positions.reduce((sum, p) => sum + p.profit, 0);
  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const hasAnything = positions.length > 0 || pendingOrders.length > 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopPad }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Positions</Text>
        {positions.length > 0 && (
          <Text style={[styles.totalPL, { color: totalPL >= 0 ? C.buy : C.sell }]}>
            {totalPL >= 0 ? "+" : ""}{totalPL.toFixed(2)}
          </Text>
        )}
      </View>

      {accountInfo && (
        <View style={styles.accountBar}>
          <View style={styles.accountItem}>
            <Text style={styles.accountLabel}>BALANCE</Text>
            <Text style={styles.accountVal}>{formatPrice(accountInfo.balance)}</Text>
          </View>
          <View style={styles.accountDivider} />
          <View style={styles.accountItem}>
            <Text style={styles.accountLabel}>EQUITY</Text>
            <Text style={[styles.accountVal, { color: accountInfo.equity >= accountInfo.balance ? C.buy : C.sell }]}>
              {formatPrice(accountInfo.equity)}
            </Text>
          </View>
          <View style={styles.accountDivider} />
          <View style={styles.accountItem}>
            <Text style={styles.accountLabel}>FREE MARGIN</Text>
            <Text style={styles.accountVal}>{formatPrice(accountInfo.freeMargin)}</Text>
          </View>
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
            <Text style={styles.emptyText}>Connect your MetaAPI account in Settings to see positions</Text>
          </View>
        ) : !hasAnything ? (
          <View style={styles.emptyState}>
            <Feather name="inbox" size={40} color={C.textMuted} />
            <Text style={styles.emptyTitle}>No Open Positions</Text>
            <Text style={styles.emptyText}>Head to the Trade tab to place your first XAUUSD trade</Text>
          </View>
        ) : (
          <>
            {positions.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>OPEN  ·  {positions.length}</Text>
                {positions.map((pos) => (
                  <PositionCard
                    key={pos.id}
                    pos={pos}
                    isBusy={busyId === pos.id}
                    onClose={() => handleClose(pos)}
                  />
                ))}
              </>
            )}
            {pendingOrders.length > 0 && (
              <>
                <Text style={[styles.sectionLabel, { marginTop: positions.length > 0 ? 20 : 0 }]}>
                  PENDING  ·  {pendingOrders.length}
                </Text>
                {pendingOrders.map((order) => (
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
  totalPL: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
  },
  accountBar: {
    flexDirection: "row",
    backgroundColor: C.card,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  accountItem: {
    flex: 1,
    alignItems: "center",
    gap: 3,
  },
  accountLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 0.8,
  },
  accountVal: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  accountDivider: {
    width: 1,
    backgroundColor: C.border,
    marginVertical: 2,
  },
  scroll: {
    padding: 16,
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
  sectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: C.textMuted,
    letterSpacing: 1.2,
    marginBottom: 4,
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
