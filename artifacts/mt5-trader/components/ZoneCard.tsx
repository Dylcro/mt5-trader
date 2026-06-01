import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import type { Zone } from "@/hooks/useZones";
import { tpDisplayState } from "@/lib/zoneComments";

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

function TpChip({ label, state }: { label: string; state: "pending" | "hit" | "disabled" }) {
  if (state === "disabled") {
    return (
      <View style={[styles.tpChip, styles.tpChipDisabled]}>
        <Text style={styles.tpChipTextDisabled}>{label}</Text>
      </View>
    );
  }
  const hit = state === "hit";
  return (
    <View style={[styles.tpChip, hit ? styles.tpChipHit : styles.tpChipPending]}>
      {hit && <Feather name="check" size={10} color="#000" />}
      <Text style={[styles.tpChipText, hit && { color: "#000" }]}>{label}</Text>
    </View>
  );
}

interface ZoneCardProps {
  zone: Zone;
  onRiskFree?: (
    zoneId: string,
    opts?: { riskFreePips?: number },
  ) => Promise<{ ok: boolean; message?: string }>;
  onCloseZone?: (zoneId: string) => Promise<{ ok: boolean; message?: string; closedCount?: number }>;
  onCancelOrders?: (zoneId: string) => Promise<{ ok: boolean; message?: string; cancelledCount?: number }>;
  riskFreePips?: number;
  historical?: boolean;
}

export default function ZoneCard({
  zone, onRiskFree, onCloseZone, onCancelOrders, riskFreePips,
  historical = false,
}: ZoneCardProps) {
  const isBuy = zone.direction === "buy";
  const [busy, setBusy] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [delBusy, setDelBusy] = useState(false);

  // One-tap: no confirm dialog. The button fires the API call immediately
  // and only surfaces an alert if the operation FAILS.
  const handleRiskFree = async () => {
    if (!onRiskFree || busy) return;
    setBusy(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const opts: { riskFreePips?: number } = {};
    if (riskFreePips !== undefined) opts.riskFreePips = riskFreePips;
    const result = await onRiskFree(zone.zoneId, opts);
    setBusy(false);
    if (result.ok) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    const errMsg = result.message ?? "Please try again.";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(`Couldn't go risk-free\n\n${errMsg}`);
    } else {
      Alert.alert("Couldn't go risk-free", errMsg);
    }
  };

  const statusLabel = zone.status === "RISK_FREE" ? "RISK-FREE" : zone.status === "CLOSED" ? "CLOSED" : "ACTIVE";
  const statusColor = zone.status === "RISK_FREE" ? C.gold : zone.status === "CLOSED" ? C.textMuted : C.buy;

  const canRiskFree =
    !historical && zone.status === "OPEN" && zone.positionCount >= 1 && !!onRiskFree;
  // Close Zone is allowed for any non-historical, non-closed zone that still
  // has at least one tracked position. We allow it on RISK_FREE zones too —
  // the user might want to bail out completely even after going risk-free.
  const canCloseZone =
    !historical && zone.status !== "CLOSED" && zone.positionCount >= 1 && !!onCloseZone;
  // Delete Orders cancels pending cascade limit fills without touching open
  // positions. Only meaningful on non-historical, non-closed zones — we
  // always show the button when those conditions hold and let the server
  // no-op (cancelledCount:0) if there's nothing pending.
  const canCancelOrders =
    !historical && zone.status !== "CLOSED" && !!onCancelOrders;

  // One-tap: no confirm dialog. The user asked for instant action —
  // misfires are recoverable (re-place from the trade tab) and the extra
  // OK button was just adding friction.
  const handleCloseZone = async () => {
    if (!onCloseZone || closeBusy) return;
    setCloseBusy(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const result = await onCloseZone(zone.zoneId);
    setCloseBusy(false);
    if (result.ok) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    const errMsg = result.message ?? "Please try again.";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(`Couldn't close zone\n\n${errMsg}`);
    } else {
      Alert.alert("Couldn't close zone", errMsg);
    }
  };

  // One-tap cancel of all pending cascade limit orders for this zone.
  const handleCancelOrders = async () => {
    if (!onCancelOrders || delBusy) return;
    setDelBusy(true);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const result = await onCancelOrders(zone.zoneId);
    setDelBusy(false);
    if (result.ok) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    const errMsg = result.message ?? "Please try again.";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(`Couldn't delete orders\n\n${errMsg}`);
    } else {
      Alert.alert("Couldn't delete orders", errMsg);
    }
  };

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
          <TpChip
            label={zone.tp1Price != null ? `TP1 ${formatPrice(zone.tp1Price)}` : "TP1 —"}
            state={tpDisplayState(zone.tp1Enabled !== false, zone.tp1Hit)}
          />
          <TpChip
            label={zone.tp2Price != null ? `TP2 ${formatPrice(zone.tp2Price)}` : "TP2 —"}
            state={tpDisplayState(zone.tp2Enabled !== false, zone.tp2Hit)}
          />
          <TpChip
            label={zone.tp3Price != null ? `TP3 ${formatPrice(zone.tp3Price)}` : "TP3 —"}
            state={tpDisplayState(zone.tp3Enabled !== false, zone.tp3Hit)}
          />
          <TpChip
            label={zone.tp4Price != null ? `TP4 ${formatPrice(zone.tp4Price)}` : "TP4 manual"}
            state={tpDisplayState(zone.tp4Enabled !== false, zone.tp4Hit)}
          />
        </View>
        {zone.enabledTpCount != null && zone.enabledTpCount > 0 && (
          <Text style={styles.tpTally}>
            {zone.hitEnabledTpCount ?? 0}/{zone.enabledTpCount} TPs hit
          </Text>
        )}
      </View>

      {!historical && zone.tp2Hit && zone.tp2SlIsBestEffort && zone.status !== "CLOSED" && (
        <View style={styles.warnRow}>
          <Feather name="alert-triangle" size={11} color="#E6A23C" />
          <Text style={styles.warnText}>
            SL set to safest protective level — true BE pending (price retraced through entry)
          </Text>
        </View>
      )}

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

      {(canRiskFree || canCloseZone || canCancelOrders) && (
        <View style={styles.actionRow}>
          {canRiskFree && (
            <Pressable
              style={({ pressed }) => [
                styles.rfBtn,
                { flex: 1 },
                pressed && { opacity: 0.75 },
                busy && { opacity: 0.5 },
              ]}
              onPress={handleRiskFree}
              disabled={busy || closeBusy || delBusy}
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
          {canCloseZone && (
            <Pressable
              style={({ pressed }) => [
                styles.closeBtn,
                { flex: 1 },
                pressed && { opacity: 0.75 },
                closeBusy && { opacity: 0.5 },
              ]}
              onPress={handleCloseZone}
              disabled={closeBusy || busy || delBusy}
            >
              {closeBusy ? (
                <ActivityIndicator size="small" color={C.sell} />
              ) : (
                <>
                  <Feather name="x-octagon" size={13} color={C.sell} />
                  <Text style={styles.closeBtnText}>Close Zone</Text>
                </>
              )}
            </Pressable>
          )}
          {canCancelOrders && (
            <Pressable
              style={({ pressed }) => [
                styles.delBtn,
                { flex: 1 },
                pressed && { opacity: 0.75 },
                delBusy && { opacity: 0.5 },
              ]}
              onPress={handleCancelOrders}
              disabled={delBusy || busy || closeBusy}
            >
              {delBusy ? (
                <ActivityIndicator size="small" color={C.textSecondary} />
              ) : (
                <>
                  <Feather name="trash-2" size={13} color={C.textSecondary} />
                  <Text style={styles.delBtnText}>Delete Orders</Text>
                </>
              )}
            </Pressable>
          )}
        </View>
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
  tpChipDisabled: {
    borderColor: C.border,
    backgroundColor: "transparent",
    opacity: 0.45,
  },
  tpChipTextDisabled: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
    letterSpacing: 0.3,
  },
  tpTally: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: C.textMuted,
    marginTop: 4,
  },
  tpChipText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 0.3,
  },
  warnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(230,162,60,0.45)",
    backgroundColor: "rgba(230,162,60,0.10)",
  },
  warnText: {
    flex: 1,
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "#E6A23C",
    letterSpacing: 0.2,
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
  actionRow: {
    flexDirection: "row",
    gap: 8,
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
  closeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.sell,
    backgroundColor: "rgba(229,57,53,0.08)",
  },
  closeBtnText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.sell,
    letterSpacing: 0.3,
  },
  delBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  delBtnText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.textSecondary,
    letterSpacing: 0.3,
  },
});
