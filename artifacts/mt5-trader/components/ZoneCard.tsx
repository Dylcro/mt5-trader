import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import type { Zone } from "@/hooks/useZones";

const C = Colors.dark;

function formatPrice(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatClosedAt(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay) return `today ${time}`;
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${date} ${time}`;
}

function TpChip({ label, hit }: { label: string; hit: boolean }) {
  return (
    <View style={[styles.tpChip, hit ? styles.tpChipHit : styles.tpChipPending]}>
      {hit && <Feather name="check" size={10} color="#000" />}
      <Text style={[styles.tpChipText, hit && { color: "#000" }]}>{label}</Text>
    </View>
  );
}

interface ZoneCardProps {
  zone: Zone;
  onRiskFree?: (zoneId: string) => Promise<{ ok: boolean; message?: string }>;
  historical?: boolean;
}

export default function ZoneCard({ zone, onRiskFree, historical = false }: ZoneCardProps) {
  const isBuy = zone.direction === "buy";
  const [busy, setBusy] = useState(false);

  const handleRiskFree = () => {
    if (!onRiskFree) return;
    Alert.alert(
      "Lock in Risk Free?",
      `Close all but the best entry in this ${isBuy ? "BUY" : "SELL"} zone and move its stop loss 10 pips into profit. Pending limit orders for this zone will be cancelled.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Risk Free",
          style: "default",
          onPress: async () => {
            setBusy(true);
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            const result = await onRiskFree(zone.zoneId);
            setBusy(false);
            if (result.ok) {
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } else {
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              Alert.alert("Couldn't go risk-free", result.message ?? "Please try again.");
            }
          },
        },
      ],
    );
  };

  const statusLabel = zone.status === "RISK_FREE" ? "RISK-FREE" : zone.status === "CLOSED" ? "CLOSED" : "ACTIVE";
  const statusColor = zone.status === "RISK_FREE" ? C.gold : zone.status === "CLOSED" ? C.textMuted : C.buy;

  const canRiskFree =
    !historical && zone.status === "OPEN" && zone.positionCount > 1 && !!onRiskFree;

  return (
    <View style={[styles.card, historical && { opacity: 0.85 }]}>
      <View style={styles.topRow}>
        <View style={styles.leftGroup}>
          <View style={[styles.dirPill, isBuy ? styles.dirPillBuy : styles.dirPillSell]}>
            <Feather
              name={isBuy ? "trending-up" : "trending-down"}
              size={11}
              color={isBuy ? "#000" : "#fff"}
            />
            <Text style={[styles.dirPillText, { color: isBuy ? "#000" : "#fff" }]}>
              {isBuy ? "BUY" : "SELL"}
            </Text>
          </View>
          <View>
            <Text style={styles.anchorLabel}>ANCHOR</Text>
            <Text style={styles.anchorPrice}>
              {zone.anchorPrice > 0 ? formatPrice(zone.anchorPrice) : "—"}
            </Text>
          </View>
        </View>
        <View style={[styles.statusBadge, { borderColor: statusColor }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>

      <View style={styles.midRow}>
        <View style={styles.posCountWrap}>
          <Feather name="layers" size={12} color={C.textSecondary} />
          <Text style={styles.posCountText}>
            {zone.positionCount} {zone.positionCount === 1 ? "position" : "positions"}
          </Text>
        </View>
        <View style={styles.chipsRow}>
          <TpChip label={`TP1 ${zone.tp1Pips}p`} hit={zone.tp1Hit} />
          <TpChip label={`TP2 ${zone.tp2Pips}p`} hit={zone.tp2Hit} />
          <TpChip label={`TP3 ${zone.tp3Pips}p`} hit={zone.tp3Hit} />
        </View>
      </View>

      {!historical && zone.status !== "CLOSED" && zone.nextTp && zone.nextTp > 0 && (
        <View style={styles.progressBlock}>
          <View style={styles.progressHeader}>
            <Text style={styles.progressLabel} numberOfLines={1}>
              {typeof zone.currentPrice === "number" ? formatPrice(zone.currentPrice) : "—"}
              <Text style={styles.progressLabelMuted}>{"  \u2192  TP" + zone.nextTp}</Text>
              {typeof zone.nextTpPrice === "number" ? (
                <Text style={styles.progressLabelMuted}>{"  " + formatPrice(zone.nextTpPrice)}</Text>
              ) : null}
            </Text>
            <Text
              style={[
                styles.progressDistance,
                typeof zone.pipsToNextTp === "number" && zone.pipsToNextTp <= 0 && { color: C.buy },
              ]}
            >
              {typeof zone.pipsToNextTp === "number"
                ? zone.pipsToNextTp <= 0
                  ? "ready"
                  : `${zone.pipsToNextTp.toFixed(1)}p away`
                : "—"}
            </Text>
          </View>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${typeof zone.progressPct === "number" ? zone.progressPct : 0}%` },
              ]}
            />
          </View>
        </View>
      )}

      {historical && (
        <View style={styles.histRow}>
          <View style={styles.histItem}>
            <Feather name="clock" size={11} color={C.textMuted} />
            <Text style={styles.histText}>
              {zone.closedAt ? `closed ${formatClosedAt(zone.closedAt)}` : "closed"}
            </Text>
          </View>
          <View style={styles.histItem}>
            <Feather name="flag" size={11} color={C.textMuted} />
            <Text style={styles.histText}>
              {zone.finalTpReached && zone.finalTpReached > 0
                ? `final: TP${zone.finalTpReached}`
                : "no TP reached"}
            </Text>
          </View>
        </View>
      )}

      {canRiskFree && (
        <Pressable
          style={({ pressed }) => [
            styles.rfBtn,
            pressed && { opacity: 0.75 },
            busy && { opacity: 0.5 },
          ]}
          onPress={handleRiskFree}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator size="small" color={C.gold} />
          ) : (
            <>
              <Feather name="shield" size={13} color={C.gold} />
              <Text style={styles.rfBtnText}>Risk Free</Text>
            </>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: C.border,
    gap: 12,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  leftGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  dirPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 20,
  },
  dirPillBuy: { backgroundColor: C.buy },
  dirPillSell: { backgroundColor: C.sell },
  dirPillText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  anchorLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 0.8,
  },
  anchorPrice: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.6,
  },
  midRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  posCountWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  posCountText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  chipsRow: {
    flexDirection: "row",
    gap: 6,
  },
  tpChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  tpChipPending: {
    borderColor: C.border,
    backgroundColor: "transparent",
  },
  tpChipHit: {
    borderColor: C.gold,
    backgroundColor: C.gold,
  },
  tpChipText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 0.3,
  },
  progressBlock: {
    gap: 6,
  },
  progressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  progressLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
    flexShrink: 1,
  },
  progressLabelMuted: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
  },
  progressDistance: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    color: C.textSecondary,
    letterSpacing: 0.3,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: C.gold,
  },
  histRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  histItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  histText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: C.textMuted,
  },
  rfBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.gold,
    backgroundColor: "rgba(201,168,76,0.08)",
  },
  rfBtnText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.gold,
    letterSpacing: 0.3,
  },
});
