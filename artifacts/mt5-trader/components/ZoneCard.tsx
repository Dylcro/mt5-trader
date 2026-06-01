import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";

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

type TpChipState = "pending" | "hit" | "disabled" | "manual";

function TpChip({ label, state }: { label: string; state: TpChipState }) {
  if (state === "disabled") {
    return (
      <View style={[styles.tpChip, styles.tpChipDisabled]}>
        <Text style={styles.tpChipTextDisabled}>{label}</Text>
      </View>
    );
  }
  const hit = state === "hit";
  const manual = state === "manual";
  return (
    <View
      style={[
        styles.tpChip,
        hit ? styles.tpChipHit : manual ? styles.tpChipManual : styles.tpChipPending,
      ]}
    >
      {hit && <Feather name="check" size={10} color="#000" />}
      <Text
        style={[
          styles.tpChipText,
          hit && { color: "#000" },
          manual && { color: C.gold },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function tpEnabledAtPlacement(zone: Zone, level: 1 | 2 | 3 | 4): boolean {
  if (level === 1) return zone.tp1Enabled === true;
  if (level === 2) return zone.tp2Enabled === true;
  if (level === 3) return zone.tp3Enabled === true;
  return zone.tp4Enabled === true;
}

function tpChipState(zone: Zone, level: 1 | 2 | 3 | 4): TpChipState {
  const enabled = tpEnabledAtPlacement(zone, level);
  const hit = Boolean(zone[`tp${level}Hit` as keyof Zone]);
  if (!enabled) return "disabled";
  if (hit) return "hit";
  if (level === 4 && zone.nextTp === 4) return "manual";
  return "pending";
}

function tpChipLabel(zone: Zone, level: 1 | 2 | 3 | 4): string {
  const price = zone[`tp${level}Price` as keyof Zone] as number | null | undefined;
  if (!tpEnabledAtPlacement(zone, level)) {
    return level === 4 ? "MANUAL" : `TP${level} OFF`;
  }
  if (price != null) return `TP${level} ${formatPrice(price)}`;
  return level === 4 ? "TP4 manual" : `TP${level} —`;
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

  const runCloseZone = async () => {
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

  const handleCloseZone = () => {
    void runCloseZone();
  };

  const runCancelOrders = async () => {
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

  const handleCancelOrders = () => {
    void runCancelOrders();
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
          <TpChip label={tpChipLabel(zone, 1)} state={tpChipState(zone, 1)} />
          <TpChip label={tpChipLabel(zone, 2)} state={tpChipState(zone, 2)} />
          <TpChip label={tpChipLabel(zone, 3)} state={tpChipState(zone, 3)} />
          <TpChip label={tpChipLabel(zone, 4)} state={tpChipState(zone, 4)} />
        </View>
        {zone.enabledTpCount != null && zone.enabledTpCount > 0 && (
          <Text style={styles.tpTally}>
            {zone.hitEnabledTpCount ?? 0}/{zone.enabledTpCount} TPs hit
          </Text>
        )}
      </View>

      {!historical && zone.tp2SlIsBestEffort && zone.status !== "CLOSED" && (
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
  tpChipManual: {
    borderColor: C.gold,
    backgroundColor: C.goldLight,
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
