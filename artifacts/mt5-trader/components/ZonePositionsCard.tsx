import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import Colors from "@/constants/colors";
import type { PendingOrder, Position } from "@/context/TradingContext";
import type { Zone } from "@/hooks/useZones";
import { formatMoney, formatPrice, pipsFromEntry } from "@/lib/formatters";
import { parseCascadeLeg } from "@/lib/zoneComments";

const C = Colors.dark;

function PositionLegRow({ position }: { position: Position }) {
  const isBuy = position.type === "POSITION_TYPE_BUY";
  const dir: "buy" | "sell" = isBuy ? "buy" : "sell";
  const parsed = parseCascadeLeg(position.comment);
  const pips = pipsFromEntry(dir, position.openPrice, position.currentPrice);
  const positive = position.profit >= 0;

  return (
    <View style={styles.legCard}>
      <View style={styles.legTop}>
        <View style={[styles.dirIcon, isBuy ? styles.dirIconBuy : styles.dirIconSell]}>
          <Feather
            name={isBuy ? "arrow-up-right" : "arrow-down-right"}
            size={14}
            color={isBuy ? C.buy : C.sell}
          />
        </View>
        <View style={styles.legTitleWrap}>
          <Text style={styles.legTitle}>
            <Text style={{ color: isBuy ? C.buy : C.sell, fontFamily: "Inter_700Bold" }}>
              {isBuy ? "BUY" : "SELL"}
            </Text>
            <Text style={styles.legTitleMuted}> · {position.volume.toFixed(2)} lot</Text>
          </Text>
          <Text style={styles.legSub}>
            {parsed ? `Cascade ${parsed.leg}/${parsed.total}` : "Cascade —"}
          </Text>
        </View>
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
      <View style={styles.legFooter}>
        <Text style={styles.pipsText}>{pips.toFixed(1)} pips</Text>
        <Text style={[styles.plText, { color: positive ? C.buy : C.sell }]}>
          {formatMoney(position.profit, { signed: true })}
        </Text>
      </View>
    </View>
  );
}

function PendingLegRow({
  order,
  onCancel,
}: {
  order: PendingOrder;
  onCancel: () => void;
}) {
  const isBuy = order.type.includes("BUY");
  const parsed = parseCascadeLeg(order.comment);
  const typeLabel = order.type.includes("BUY") ? "BUY LIMIT" : "SELL LIMIT";

  return (
    <View style={[styles.legCard, styles.pendingLeg]}>
      <View style={styles.legTop}>
        <View style={[styles.dirIcon, isBuy ? styles.dirIconBuy : styles.dirIconSell]}>
          <Feather name="clock" size={14} color={C.gold} />
        </View>
        <View style={styles.legTitleWrap}>
          <Text style={styles.legTitle}>
            <Text style={{ color: isBuy ? C.buy : C.sell, fontFamily: "Inter_700Bold" }}>
              {typeLabel}
            </Text>
            <Text style={styles.legTitleMuted}> · {order.volume.toFixed(2)} lot</Text>
          </Text>
          <Text style={styles.legSub}>
            {parsed ? `Cascade ${parsed.leg}/${parsed.total}` : "Pending leg"} · @ {formatPrice(order.openPrice)}
          </Text>
        </View>
      </View>
      <Pressable
        style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.7 }]}
        onPress={onCancel}
      >
        <Text style={styles.cancelBtnText}>Cancel Order</Text>
      </Pressable>
    </View>
  );
}

export default function ZonePositionsCard({
  zone,
  zoneId,
  positions,
  pendingOrders,
  onCloseZone,
  onCancelOrder,
}: {
  zone?: Zone;
  zoneId: string;
  positions: Position[];
  pendingOrders: PendingOrder[];
  onCloseZone: (zoneId: string) => Promise<{ ok: boolean; message?: string }>;
  onCancelOrder: (order: PendingOrder) => void;
}) {
  const [closeBusy, setCloseBusy] = useState(false);

  const direction = zone?.direction ?? (positions[0]?.type === "POSITION_TYPE_SELL" ? "sell" : "buy");
  const isBuy = direction === "buy";
  const riskFree = zone?.status === "RISK_FREE";
  const totalLots =
    positions.reduce((s, p) => s + p.volume, 0) +
    pendingOrders.reduce((s, o) => s + o.volume, 0);
  const zonePnl = positions.reduce((s, p) => s + p.profit, 0);

  const sortedPositions = useMemo(
    () =>
      [...positions].sort((a, b) => {
        const la = parseCascadeLeg(a.comment)?.leg ?? 99;
        const lb = parseCascadeLeg(b.comment)?.leg ?? 99;
        return la - lb;
      }),
    [positions],
  );

  const sortedPending = useMemo(
    () =>
      [...pendingOrders].sort((a, b) => {
        const la = parseCascadeLeg(a.comment)?.leg ?? 99;
        const lb = parseCascadeLeg(b.comment)?.leg ?? 99;
        return la - lb;
      }),
    [pendingOrders],
  );

  const handleCloseAll = () => {
    const legCount = positions.length + pendingOrders.length;
    Alert.alert(
      "Close All",
      `Close this entire zone?\n\nThis cancels ${pendingOrders.length} pending limit${pendingOrders.length === 1 ? "" : "s"} and closes ${positions.length} open position${positions.length === 1 ? "" : "s"} (${legCount} leg${legCount === 1 ? "" : "s"} total). Other zones are not affected.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Close All",
          style: "destructive",
          onPress: async () => {
            setCloseBusy(true);
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            const result = await onCloseZone(zoneId);
            setCloseBusy(false);
            if (result.ok) {
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } else {
              Alert.alert("Couldn't close zone", result.message ?? "Please try again.");
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.zoneCard}>
      <View style={styles.zoneHeader}>
        <View style={[styles.dirIcon, isBuy ? styles.dirIconBuy : styles.dirIconSell]}>
          <Feather
            name={isBuy ? "arrow-up-right" : "arrow-down-right"}
            size={16}
            color={isBuy ? C.buy : C.sell}
          />
        </View>
        <View style={styles.zoneHeaderText}>
          <Text style={styles.zoneTitle}>
            <Text style={{ color: isBuy ? C.buy : C.sell, fontFamily: "Inter_700Bold" }}>
              {isBuy ? "BUY" : "SELL"}
            </Text>
            <Text style={styles.zoneTitleMuted}>
              {" "}
              · {totalLots > 0 ? `${totalLots.toFixed(2)} lot` : "—"}
            </Text>
          </Text>
          <Text style={styles.zoneSub}>
            {positions.length} open
            {pendingOrders.length > 0 ? ` · ${pendingOrders.length} pending` : ""}
            {zonePnl !== 0 ? ` · ${formatMoney(zonePnl, { signed: true })}` : ""}
          </Text>
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

      <View style={styles.legs}>
        {sortedPositions.map((p) => (
          <PositionLegRow key={p.id} position={p} />
        ))}
        {sortedPending.map((o) => (
          <PendingLegRow key={o.id} order={o} onCancel={() => onCancelOrder(o)} />
        ))}
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.closeAllBtn,
          pressed && { opacity: 0.85 },
          closeBusy && { opacity: 0.5 },
        ]}
        onPress={handleCloseAll}
        disabled={closeBusy}
      >
        {closeBusy ? (
          <ActivityIndicator size="small" color={C.sell} />
        ) : (
          <>
            <Feather name="x-circle" size={14} color={C.sell} />
            <Text style={styles.closeAllText}>Close All</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  zoneCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 12,
  },
  zoneHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  zoneHeaderText: { flex: 1 },
  zoneTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  zoneTitleMuted: {
    color: C.textSecondary,
    fontFamily: "Inter_400Regular",
  },
  zoneSub: {
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
  legs: { gap: 10 },
  legCard: {
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    gap: 10,
  },
  pendingLeg: {
    borderStyle: "dashed",
    borderColor: C.goldBorder,
  },
  legTop: {
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
  legTitleWrap: { flex: 1 },
  legTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
  },
  legTitleMuted: {
    color: C.textSecondary,
    fontFamily: "Inter_400Regular",
  },
  legSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 2,
  },
  statRow: {
    flexDirection: "row",
    backgroundColor: C.card,
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
  legFooter: {
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
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  cancelBtn: {
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    backgroundColor: C.card,
  },
  cancelBtnText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
  },
  closeAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.sellBorder,
    backgroundColor: C.sellDim,
  },
  closeAllText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.sell,
  },
});
