import { Feather } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import Colors from "@/constants/colors";
import { triggerAppHaptic, useHapticSettings } from "@/hooks/useHapticSettings";
import type { Zone } from "@/hooks/useZones";

const C = Colors.dark;
const TP_BUFFER = 5.0;
const LOT_STEP = 0.01;

function btnPressed(pressed: boolean) {
  return pressed ? { opacity: 0.72, transform: [{ scale: 0.97 }] } : null;
}

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

function roundLot(v: number): number {
  return Math.round(v / LOT_STEP) * LOT_STEP;
}

type TpAction = {
  label: string;
  sub: string;
  call: () => void;
} | null;

type ClosePartialOpts = { pct?: number; lots?: number; tpLevel?: number; runnerN?: number; emergency?: boolean };

function getNextTpAction(
  zone: Zone,
  onClosePartial: ((zoneId: string, opts: ClosePartialOpts) => Promise<{ ok: boolean; message?: string }>) | undefined,
  setShowRunnerPanel: (v: boolean) => void,
): TpAction {
  const origVol = zone.originalVolume ?? 0;
  const tp1Lots = roundLot(origVol * (zone.tp1Pct ?? 25) / 100);
  const tp2Lots = roundLot(origVol * (zone.tp2Pct ?? 25) / 100);
  const tp3Lots = roundLot(origVol * (zone.tp3Pct ?? 25) / 100);

  if (zone.tp1Enabled !== false && !zone.tp1Hit) {
    return {
      label: "Take TP1",
      sub: `${tp1Lots.toFixed(2)} lots`,
      call: () => { void onClosePartial?.(zone.zoneId, { pct: zone.tp1Pct ?? 25, tpLevel: 1, emergency: true }); },
    };
  }
  if (zone.tp2Enabled !== false && !zone.tp2Hit) {
    return {
      label: "Take TP2",
      sub: `${tp2Lots.toFixed(2)} lots`,
      call: () => { void onClosePartial?.(zone.zoneId, { pct: zone.tp2Pct ?? 25, tpLevel: 2, emergency: true }); },
    };
  }
  if (zone.tp3Enabled !== false && !zone.tp3Hit) {
    return {
      label: "Take TP3",
      sub: `${tp3Lots.toFixed(2)} lots`,
      call: () => { void onClosePartial?.(zone.zoneId, { pct: zone.tp3Pct ?? 25, tpLevel: 3, emergency: true }); },
    };
  }
  if (!zone.runnerActive) {
    return {
      label: "Set Runners",
      sub: "open panel",
      call: () => setShowRunnerPanel(true),
    };
  }
  for (const n of [1, 2, 3] as const) {
    if (!zone[`runner${n}Hit`] && zone[`runner${n}Price`]) {
      return {
        label: `Bank R${n}`,
        sub: `${(zone[`runner${n}Lots`] ?? 0).toFixed(2)} lots`,
        call: () => { void onClosePartial?.(zone.zoneId, { lots: zone[`runner${n}Lots`] ?? undefined, runnerN: n }); },
      };
    }
  }
  return null;
}

function RunnerAutoChip({
  active,
  disabled,
  onPress,
}: {
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.runnerAutoChip,
        active && styles.runnerAutoChipOn,
        disabled && { opacity: 0.5 },
        btnPressed(pressed),
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.runnerAutoChipText, active && styles.runnerAutoChipTextOn]}>AUTO</Text>
    </Pressable>
  );
}

function RunnerSetupPanel({
  zone,
  remaining,
  currentMarketPrice,
  onActivate,
  onSkipClose,
  busy,
  editMode = false,
  initialTargets,
  initialAutos,
}: {
  zone: Zone;
  remaining: number;
  currentMarketPrice: number;
  onActivate: (
    targets: {
      r1?: { price: number; lots: number };
      r2?: { price: number; lots: number };
      r3?: { price: number; lots: number };
    },
    autos?: { r1Auto?: boolean; r2Auto?: boolean; r3Auto?: boolean },
  ) => Promise<{ ok: boolean; message?: string }>;
  onSkipClose: () => void;
  busy: boolean;
  editMode?: boolean;
  initialTargets?: {
    r1?: { price: number; lots: number };
    r2?: { price: number; lots: number };
    r3?: { price: number; lots: number };
  };
  initialAutos?: { r1Auto?: boolean; r2Auto?: boolean; r3Auto?: boolean };
}) {
  const [r1, setR1] = useState({
    price: initialTargets?.r1 ? String(initialTargets.r1.price) : "",
    lots: initialTargets?.r1 ? String(initialTargets.r1.lots) : "",
  });
  const [r2, setR2] = useState({
    price: initialTargets?.r2 ? String(initialTargets.r2.price) : "",
    lots: initialTargets?.r2 ? String(initialTargets.r2.lots) : "",
  });
  const [r3, setR3] = useState({
    price: initialTargets?.r3 ? String(initialTargets.r3.price) : "",
    lots: initialTargets?.r3 ? String(initialTargets.r3.lots) : "",
  });
  const [r1Auto, setR1Auto] = useState(initialAutos?.r1Auto ?? true);
  const [r2Auto, setR2Auto] = useState(initialAutos?.r2Auto ?? true);
  const [r3Auto, setR3Auto] = useState(initialAutos?.r3Auto ?? true);

  const filledPrices = [r1, r2, r3].filter((r) => r.price.trim().length > 0);
  const autoLot =
    filledPrices.length > 0
      ? Math.round((remaining / filledPrices.length) / LOT_STEP) * LOT_STEP
      : remaining;

  const rows = [
    { n: 1, s: r1, set: setR1, auto: r1Auto, setAuto: setR1Auto },
    { n: 2, s: r2, set: setR2, auto: r2Auto, setAuto: setR2Auto },
    { n: 3, s: r3, set: setR3, auto: r3Auto, setAuto: setR3Auto },
  ] as const;

  const total =
    (parseFloat(r1.lots) || (r1.price ? autoLot : 0)) +
    (parseFloat(r2.lots) || (r2.price ? autoLot : 0)) +
    (parseFloat(r3.lots) || (r3.price ? autoLot : 0));
  const pricesValid = filledPrices.every((r) => {
    const enteredPrice = parseFloat(r.price);
    if (!Number.isFinite(enteredPrice)) return false;
    return zone.direction === "buy"
      ? enteredPrice > currentMarketPrice
      : enteredPrice < currentMarketPrice;
  });
  const ok = total <= remaining + 0.001 && total >= LOT_STEP && filledPrices.length > 0 && pricesValid;

  const buildTargets = () => {
    const targets: {
      r1?: { price: number; lots: number };
      r2?: { price: number; lots: number };
      r3?: { price: number; lots: number };
    } = {};
    rows.forEach(({ n, s }) => {
      if (!s.price.trim()) return;
      const price = parseFloat(s.price);
      const lots = parseFloat(s.lots) || autoLot;
      if (n === 1) targets.r1 = { price, lots };
      if (n === 2) targets.r2 = { price, lots };
      if (n === 3) targets.r3 = { price, lots };
    });
    return targets;
  };

  return (
    <View style={styles.runnerPanel}>
      <View style={styles.runnerPanelHeader}>
        <Text style={styles.runnerPanelTitle}>
          {editMode ? "🏃 Update runner targets" : "🏃 Set runner targets"}
        </Text>
        <Text style={styles.runnerRemaining}>Remaining: {remaining.toFixed(2)} lots</Text>
      </View>
      {rows.map(({ n, s, set, auto, setAuto }) => (
        <View key={n} style={styles.runnerRow}>
          <Text style={styles.runnerRowLabel}>R{n}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.runnerFieldLabel}>Price{n > 1 ? " (opt)" : ""}</Text>
            <TextInput
              style={styles.runnerInput}
              value={s.price}
              onChangeText={(v) => {
                const price = v.replace(/[^0-9.]/g, "");
                set({ ...s, price, lots: s.lots || (price ? autoLot.toFixed(2) : "") });
                if (price.trim()) setAuto(true);
              }}
              keyboardType="decimal-pad"
              placeholderTextColor={C.specMuted}
            />
          </View>
          <View style={{ alignItems: "center", width: 48 }}>
            <Text style={styles.runnerFieldLabel}>Auto</Text>
            <RunnerAutoChip active={auto} disabled={busy} onPress={() => setAuto(!auto)} />
          </View>
          <View style={{ width: 72 }}>
            <Text style={styles.runnerFieldLabel}>Lots</Text>
            <TextInput
              style={styles.runnerInput}
              value={s.lots}
              onChangeText={(v) => set({ ...s, lots: v.replace(/[^0-9.]/g, "") })}
              keyboardType="decimal-pad"
              placeholderTextColor={C.specMuted}
            />
          </View>
        </View>
      ))}
      <Text style={[styles.runnerTotal, { color: ok ? C.specBuy : C.specSell }]}>
        Total: {total.toFixed(2)} lots {ok ? "✓" : "✗"}
      </Text>
      <Pressable
        style={({ pressed }) => [
          styles.runnerActivateBtn,
          (!ok || busy) && { backgroundColor: "#9CA3AF" },
          btnPressed(pressed),
        ]}
        disabled={!ok || busy}
        onPress={async () => {
          const result = await onActivate(buildTargets(), { r1Auto, r2Auto, r3Auto });
          if (!result.ok) Alert.alert("Activate failed", result.message ?? "Try again");
        }}
      >
        {busy ? <ActivityIndicator color="#fff" /> : (
          <Text style={styles.runnerActivateText}>
            {editMode ? "Update Runners 🏃" : "Activate Runner 🏃"}
          </Text>
        )}
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.runnerSkipBtn, btnPressed(pressed)]}
        onPress={onSkipClose}
        disabled={busy}
      >
        <Text style={styles.runnerSkipText}>Skip for now</Text>
      </Pressable>
    </View>
  );
}

interface ZoneCardProps {
  zone: Zone;
  liveVolume?: number;
  floatingPnl?: number;
  flash?: boolean;
  onRiskFree?: (zoneId: string) => Promise<{ ok: boolean; message?: string }>;
  onCloseAllWorst?: (zoneId: string) => Promise<{ ok: boolean; message?: string; closedCount?: number }>;
  onCloseZone?: (zoneId: string) => Promise<{ ok: boolean; message?: string; closedCount?: number }>;
  onClosePartial?: (zoneId: string, opts: ClosePartialOpts) => Promise<{ ok: boolean; message?: string }>;
  onActivateRunner?: (
    zoneId: string,
    targets: {
      r1?: { price: number; lots: number };
      r2?: { price: number; lots: number };
      r3?: { price: number; lots: number };
    },
    autos?: { r1Auto?: boolean; r2Auto?: boolean; r3Auto?: boolean },
  ) => Promise<{ ok: boolean; message?: string }>;
  onSetRunnerAuto?: (zoneId: string, runnerN: 1 | 2 | 3, auto: boolean) => Promise<{ ok: boolean; message?: string }>;
  onCancelOrders?: (zoneId: string) => Promise<{ ok: boolean; message?: string; cancelledCount?: number }>;
  historical?: boolean;
}

export default function ZoneCard({
  zone,
  liveVolume,
  floatingPnl,
  flash = false,
  onRiskFree,
  onCloseAllWorst,
  onCloseZone,
  onClosePartial,
  onActivateRunner,
  onSetRunnerAuto,
  onCancelOrders,
  historical = false,
}: ZoneCardProps) {
  const { hapticEnabled } = useHapticSettings();
  const isBuy = zone.direction === "buy";
  const runnerActive = Boolean(zone.runnerActive);
  const [busy, setBusy] = useState(false);
  const [takeTpBusy, setTakeTpBusy] = useState(false);
  const [tpBusy, setTpBusy] = useState<number | null>(null);
  const [worstBusy, setWorstBusy] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [showRunnerPanel, setShowRunnerPanel] = useState(false);
  const [showEditRunners, setShowEditRunners] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const flashAnim = useRef(new Animated.Value(flash ? 1 : 0)).current;

  useEffect(() => {
    if (!flash) return;
    flashAnim.setValue(1);
    Animated.timing(flashAnim, {
      toValue: 0,
      duration: 2000,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [flash, flashAnim]);

  useEffect(() => {
    if (zone.tp3Hit && !zone.runnerActive) {
      setShowRunnerPanel(true);
    }
  }, [zone.tp3Hit, zone.runnerActive]);

  const origVol = zone.originalVolume ?? liveVolume ?? 0;
  const vol = liveVolume ?? origVol;
  const cmp = zone.currentPrice ?? zone.anchorPrice;

  const showTp3Notif = !historical && zone.tp3Hit && !runnerActive;

  const runnerNotif = useMemo(() => {
    if (!runnerActive || historical) return null;
    for (const n of [1, 2, 3] as const) {
      const px = zone[`runner${n}Price`];
      const hit = zone[`runner${n}Hit`];
      if (px == null || hit) continue;
      const reached = isBuy ? cmp >= px - TP_BUFFER : cmp <= px + TP_BUFFER;
      if (reached) return { n, price: px };
    }
    return null;
  }, [runnerActive, zone, cmp, isBuy, historical]);

  const runners = ([1, 2, 3] as const)
    .map((n) => ({
      n,
      price: zone[`runner${n}Price`],
      lots: zone[`runner${n}Lots`],
      hit: Boolean(zone[`runner${n}Hit`]),
    }))
    .filter((r) => r.price != null && r.lots != null);

  const nextRunnerN = runners.find((r) => !r.hit)?.n;

  const runCloseZone = async () => {
    if (!onCloseZone || closeBusy) return;
    setCloseBusy(true);
    await triggerAppHaptic(hapticEnabled, "heavy");
    const result = await onCloseZone(zone.zoneId);
    setCloseBusy(false);
    if (!result.ok) Alert.alert("Couldn't close zone", result.message ?? "Try again");
  };

  const actionBusy = busy || worstBusy || closeBusy || delBusy || runnerBusy || tpBusy != null || takeTpBusy;

  const nextTpAction = useMemo(
    () => getNextTpAction(zone, onClosePartial, setShowRunnerPanel),
    [zone, onClosePartial],
  );

  const canRiskFree =
    !historical && (zone.status === "OPEN" || zone.status === "RISK_FREE") && zone.positionCount >= 1 && !!onRiskFree;
  const showCloseAllWorst = !historical && zone.status !== "CLOSED" && zone.status !== "ARMED" && !!onCloseAllWorst;
  const canCloseAllWorst = showCloseAllWorst && zone.positionCount >= 2;
  const canCloseZone = !historical && zone.status !== "CLOSED" && zone.positionCount >= 1 && !!onCloseZone;
  const canCancelOrders = !historical && zone.status !== "CLOSED" && !!onCancelOrders;
  const runnerPanelOpen =
    !historical && showRunnerPanel && zone.tp3Hit && !runnerActive && zone.status !== "CLOSED";
  const editRunnerPanelOpen = !historical && showEditRunners && runnerActive && zone.status !== "CLOSED";
  const hasUnhitRunners = runners.some((r) => !r.hit);
  const showMenuBtn = !runnerPanelOpen && !editRunnerPanelOpen && (canRiskFree || showCloseAllWorst || canCancelOrders);
  const runnerInitialTargets = {
    r1: zone.runner1Price != null && zone.runner1Lots != null
      ? { price: zone.runner1Price, lots: zone.runner1Lots } : undefined,
    r2: zone.runner2Price != null && zone.runner2Lots != null
      ? { price: zone.runner2Price, lots: zone.runner2Lots } : undefined,
    r3: zone.runner3Price != null && zone.runner3Lots != null
      ? { price: zone.runner3Price, lots: zone.runner3Lots } : undefined,
  };
  const runnerInitialAutos = {
    r1Auto: Boolean(zone.runner1Auto),
    r2Auto: Boolean(zone.runner2Auto),
    r3Auto: Boolean(zone.runner3Auto),
  };

  if (historical) {
    return (
      <View style={[styles.card, { opacity: 0.88 }]}>
        <View style={styles.topRow}>
          <View style={styles.leftGroup}>
            <View style={[styles.dirPill, isBuy ? styles.dirPillBuy : styles.dirPillSell]}>
              <Feather name={isBuy ? "trending-up" : "trending-down"} size={11} color="#fff" />
              <Text style={styles.dirPillText}>{isBuy ? "BUY" : "SELL"}</Text>
            </View>
            <View>
              <Text style={styles.anchorLabel}>ANCHOR</Text>
              <Text style={styles.anchorPrice}>{formatPrice(zone.anchorPrice)}</Text>
            </View>
          </View>
        </View>
        <View style={styles.histRow}>
          <Text style={styles.histText}>
            {zone.closedAt ? `closed ${formatClosedAt(zone.closedAt)}` : "closed"}
          </Text>
          <Text style={styles.histText}>
            {zone.finalTpReached === 4
              ? "Runner hit"
              : zone.finalTpReached && zone.finalTpReached > 0
                ? `final: TP${zone.finalTpReached}`
                : "no TP reached"}
          </Text>
        </View>
      </View>
    );
  }

  const flashBorderColor = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [runnerActive ? C.tealBdr : C.specBorder, C.specGold],
  });
  const flashShadowOpacity = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.09, 0.7],
  });

  return (
    <Animated.View
      style={[
        styles.card,
        runnerActive && styles.cardRunner,
        flash && {
          borderColor: flashBorderColor,
          shadowColor: C.specGold,
          shadowOpacity: flashShadowOpacity,
          shadowRadius: 16,
        },
      ]}
    >
      <View style={styles.topRow}>
        <View style={styles.leftGroup}>
          <View style={[styles.dirPill, isBuy ? styles.dirPillBuy : styles.dirPillSell]}>
            <Feather name={isBuy ? "trending-up" : "trending-down"} size={11} color="#fff" />
            <Text style={styles.dirPillText}>{isBuy ? "BUY" : "SELL"}</Text>
          </View>
          <View>
            <Text style={styles.anchorLabel}>ANCHOR</Text>
            <Text style={styles.anchorPrice}>{formatPrice(zone.anchorPrice)}</Text>
          </View>
        </View>
        <View style={styles.topRight}>
          {canCloseZone && (
            <Pressable
              style={({ pressed }) => [styles.closeZoneTopBtn, btnPressed(pressed)]}
              onPress={() => void runCloseZone()}
              disabled={actionBusy}
            >
              {closeBusy ? (
                <ActivityIndicator size="small" color={C.specSell} />
              ) : (
                <>
                  <Feather name="x" size={10} color={C.specSell} />
                  <Text style={styles.closeZoneTopText}>Close Zone</Text>
                </>
              )}
            </Pressable>
          )}
          <View style={[styles.statusBadge, runnerActive ? styles.statusRunner : isBuy ? styles.statusActiveBuy : styles.statusActiveSell]}>
            <Text style={[styles.statusText, runnerActive && { color: C.teal }]}>
              {runnerActive ? "🏃 RUNNER ACTIVE" : zone.status === "RISK_FREE" ? "RISK-FREE" : "ACTIVE"}
            </Text>
          </View>
        </View>
      </View>

      {(showTp3Notif || runnerNotif) && (
        <View style={styles.notifBar}>
          <Feather name="zap" size={14} color={C.teal} />
          <View style={{ flex: 1 }}>
            <Text style={styles.notifTitle}>
              {showTp3Notif
                ? "⚡ TP3 reached — set your runners below"
                : `🏃 Runner ${runnerNotif!.n} reached at ${formatPrice(runnerNotif!.price)} — tap to close`}
            </Text>
          </View>
        </View>
      )}

      {zone.tp2SlIsBestEffort && (
        <View style={styles.warnRow}>
          <Feather name="alert-triangle" size={12} color="#E6A23C" />
          <Text style={styles.warnText}>SL not at break-even — protective level applied</Text>
        </View>
      )}

      {runnerPanelOpen && onActivateRunner && (
        <RunnerSetupPanel
          zone={zone}
          remaining={vol}
          currentMarketPrice={cmp}
          busy={runnerBusy}
          onSkipClose={() => setShowRunnerPanel(false)}
          onActivate={async (targets, autos) => {
            setRunnerBusy(true);
            const result = await onActivateRunner(zone.zoneId, targets, autos);
            setRunnerBusy(false);
            if (result.ok) setShowRunnerPanel(false);
            return result;
          }}
        />
      )}

      {editRunnerPanelOpen && onActivateRunner && (
        <RunnerSetupPanel
          zone={zone}
          remaining={vol}
          currentMarketPrice={cmp}
          busy={runnerBusy}
          editMode
          initialTargets={runnerInitialTargets}
          initialAutos={runnerInitialAutos}
          onSkipClose={() => setShowEditRunners(false)}
          onActivate={async (targets, autos) => {
            setRunnerBusy(true);
            const result = await onActivateRunner(zone.zoneId, targets, autos);
            setRunnerBusy(false);
            if (result.ok) setShowEditRunners(false);
            return result;
          }}
        />
      )}

      {runnerActive && hasUnhitRunners && !editRunnerPanelOpen && onActivateRunner && (
        <Pressable
          style={({ pressed }) => [styles.editRunnersBtn, btnPressed(pressed)]}
          onPress={() => setShowEditRunners(true)}
          disabled={actionBusy}
        >
          <Text style={styles.editRunnersText}>Edit Runners</Text>
        </Pressable>
      )}

      {runnerActive && runners.length > 0 && (
        <View style={styles.runnerTargetsBox}>
          {runners.map((r) => {
            const isNext = !r.hit && r.n === nextRunnerN;
            const statusLabel = r.hit ? "✓ banked" : isNext ? "watching" : "pending";
            const statusColor = r.hit ? C.specGold : isNext ? C.teal : C.specMuted;
            return (
              <View key={r.n} style={[styles.runnerTargetRow, isNext && styles.runnerTargetRowNext]}>
                <Text style={[styles.runnerTargetLabel, { color: r.hit ? C.specGold : C.teal }]}>
                  R{r.n}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.runnerTargetPrice}>{formatPrice(r.price!)}</Text>
                  <Text style={[styles.runnerTargetSub, { color: statusColor }]}>
                    {r.lots!.toFixed(2)} lots · {statusLabel}
                  </Text>
                </View>
                {!r.hit && onSetRunnerAuto && (
                  <RunnerAutoChip
                    active={Boolean(zone[`runner${r.n}Auto`])}
                    disabled={tpBusy != null}
                    onPress={() => void onSetRunnerAuto(zone.zoneId, r.n, !zone[`runner${r.n}Auto`])}
                  />
                )}
              </View>
            );
          })}
        </View>
      )}

      {nextTpAction && !runnerActive && !runnerPanelOpen && !editRunnerPanelOpen && (
        <Pressable
          style={({ pressed }) => [styles.takeTpBtn, takeTpBusy && { opacity: 0.6 }, btnPressed(pressed)]}
          disabled={actionBusy}
          onPress={async () => {
            setTakeTpBusy(true);
            await triggerAppHaptic(hapticEnabled, "medium");
            nextTpAction.call();
            setTakeTpBusy(false);
          }}
        >
          <Text style={styles.takeTpLabel}>Take TP NOW</Text>
          <Text style={styles.takeTpSub}>{nextTpAction.label} · {nextTpAction.sub}</Text>
        </Pressable>
      )}

      {showMenuBtn && (
        <View style={styles.menuWrap}>
          {menuOpen && (
            <View style={styles.menuDropdown}>
              {canRiskFree && (
                <Pressable
                  style={({ pressed }) => [styles.menuItem, btnPressed(pressed)]}
                  onPress={async () => {
                    setMenuOpen(false);
                    if (!onRiskFree || busy) return;
                    setBusy(true);
                    await triggerAppHaptic(hapticEnabled, "medium");
                    const result = await onRiskFree(zone.zoneId);
                    setBusy(false);
                    if (!result.ok) Alert.alert("Risk Free failed", result.message ?? "Try again");
                  }}
                  disabled={actionBusy}
                >
                  <Text style={styles.menuItemText}>🛡 Risk Free</Text>
                </Pressable>
              )}
              {showCloseAllWorst && (
                <Pressable
                  style={({ pressed }) => [styles.menuItem, !canCloseAllWorst && { opacity: 0.45 }, btnPressed(pressed)]}
                  onPress={async () => {
                    setMenuOpen(false);
                    if (!onCloseAllWorst || worstBusy || !canCloseAllWorst) return;
                    setWorstBusy(true);
                    await triggerAppHaptic(hapticEnabled, "medium");
                    const result = await onCloseAllWorst(zone.zoneId);
                    setWorstBusy(false);
                    if (!result.ok) Alert.alert("Secure failed", result.message ?? "Try again");
                  }}
                  disabled={actionBusy || !canCloseAllWorst}
                >
                  <Text style={styles.menuItemText}>Secure Profits</Text>
                </Pressable>
              )}
              {canCancelOrders && (
                <Pressable
                  style={({ pressed }) => [styles.menuItem, btnPressed(pressed)]}
                  onPress={async () => {
                    setMenuOpen(false);
                    if (!onCancelOrders || delBusy) return;
                    setDelBusy(true);
                    await triggerAppHaptic(hapticEnabled, "light");
                    const result = await onCancelOrders(zone.zoneId);
                    setDelBusy(false);
                    if (!result.ok) Alert.alert("Delete limits failed", result.message ?? "Try again");
                  }}
                  disabled={actionBusy}
                >
                  <Text style={styles.menuItemText}>🗑 Delete Limits</Text>
                </Pressable>
              )}
            </View>
          )}
          <Pressable
            style={({ pressed }) => [styles.menuBtn, btnPressed(pressed)]}
            onPress={() => setMenuOpen((v) => !v)}
            disabled={actionBusy}
          >
            <Text style={styles.menuBtnText}>···</Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.specBorder,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.09,
    shadowRadius: 10,
    elevation: 3,
  },
  cardRunner: {
    borderColor: C.tealBdr,
    shadowOpacity: 0.05,
  },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  topRight: { alignItems: "flex-end", gap: 5 },
  leftGroup: { flexDirection: "row", alignItems: "center", gap: 9 },
  dirPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 22,
  },
  dirPillBuy: { backgroundColor: C.specBuy },
  dirPillSell: { backgroundColor: C.specSell },
  dirPillText: { fontSize: 11, fontFamily: "Inter_700Bold", color: "#fff", letterSpacing: 0.7 },
  anchorLabel: { fontSize: 9, fontFamily: "Inter_700Bold", color: C.specMuted, letterSpacing: 1 },
  anchorPrice: { fontSize: 19, fontFamily: "Inter_700Bold", color: C.specText },
  closeZoneTopBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "rgba(220,38,38,0.4)",
    backgroundColor: "rgba(220,38,38,0.07)",
  },
  closeZoneTopText: { fontSize: 10, fontFamily: "Inter_700Bold", color: C.specSell },
  statusBadge: { borderWidth: 1.5, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  statusActiveBuy: { borderColor: C.specBuy },
  statusActiveSell: { borderColor: C.specSell },
  statusRunner: { borderColor: C.teal, backgroundColor: C.tealBg, borderStyle: "dashed" },
  statusText: { fontSize: 9, fontFamily: "Inter_700Bold", color: C.specBuy, letterSpacing: 0.8 },
  notifBar: {
    backgroundColor: C.tealBg,
    borderWidth: 1,
    borderColor: C.tealBdr,
    borderRadius: 11,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  notifTitle: { fontSize: 12, fontFamily: "Inter_700Bold", color: C.teal },
  warnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 8,
    borderRadius: 8,
    backgroundColor: "rgba(230,162,60,0.10)",
    borderWidth: 1,
    borderColor: "rgba(230,162,60,0.45)",
  },
  warnText: { flex: 1, fontSize: 11, fontFamily: "Inter_500Medium", color: "#E6A23C" },
  runnerTargetsBox: {
    backgroundColor: C.tealBg,
    borderWidth: 1.5,
    borderColor: C.tealBdr,
    borderRadius: 12,
    padding: 10,
    gap: 8,
    marginBottom: 4,
  },
  runnerTargetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 4,
  },
  runnerTargetRowNext: {
    borderWidth: 1,
    borderColor: C.tealBdr,
    borderRadius: 8,
    paddingHorizontal: 8,
    backgroundColor: "rgba(14,116,144,0.06)",
  },
  runnerTargetLabel: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    width: 24,
  },
  runnerTargetPrice: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.specText,
  },
  runnerTargetSub: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    marginTop: 1,
  },
  runnerAutoChip: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.specBorder,
    backgroundColor: "#fff",
  },
  runnerAutoChipOn: { borderColor: C.teal, backgroundColor: C.tealBg },
  runnerAutoChipText: { fontSize: 7, fontFamily: "Inter_700Bold", color: C.specMuted, letterSpacing: 0.5 },
  runnerAutoChipTextOn: { color: C.teal },
  runnerPanel: {
    backgroundColor: C.tealBg,
    borderWidth: 1.5,
    borderColor: C.tealBdr,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  runnerPanelHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  runnerPanelTitle: { fontSize: 13, fontFamily: "Inter_700Bold", color: C.teal },
  runnerRemaining: { fontSize: 11, fontFamily: "Inter_700Bold", color: C.teal },
  runnerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  runnerRowLabel: { fontSize: 10, fontFamily: "Inter_700Bold", color: C.teal, width: 20 },
  runnerFieldLabel: { fontSize: 8, color: C.specMuted, marginBottom: 2 },
  runnerInput: {
    borderWidth: 1,
    borderColor: C.tealBdr,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    backgroundColor: "#fff",
  },
  runnerTotal: { fontSize: 11, fontFamily: "Inter_700Bold", textAlign: "right", marginVertical: 4 },
  runnerActivateBtn: {
    paddingVertical: 12,
    borderRadius: 11,
    backgroundColor: C.teal,
    alignItems: "center",
  },
  runnerActivateText: { fontSize: 13, fontFamily: "Inter_700Bold", color: "#fff" },
  runnerSkipBtn: {
    paddingVertical: 9,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: C.specBorder,
    alignItems: "center",
  },
  runnerSkipText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: C.specMuted },
  takeTpBtn: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: C.specGold,
    backgroundColor: C.specGoldBg,
    gap: 2,
  },
  takeTpLabel: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: C.specGold,
  },
  takeTpSub: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: C.specGold,
    opacity: 0.85,
  },
  editRunnersBtn: {
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.tealBdr,
    backgroundColor: C.tealBg,
    alignItems: "center",
    marginBottom: 4,
  },
  editRunnersText: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    color: C.teal,
  },
  menuWrap: {
    alignItems: "center",
    marginTop: 2,
  },
  menuDropdown: {
    width: "100%",
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.specBorder,
    borderRadius: 12,
    marginBottom: 6,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 4,
  },
  menuItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.specBorder,
  },
  menuItemText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: C.specText,
  },
  menuBtn: {
    width: "100%",
    alignItems: "center",
    paddingVertical: 8,
  },
  menuBtnText: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: C.specMuted,
    letterSpacing: 2,
  },
  histRow: { flexDirection: "row", justifyContent: "space-between" },
  histText: { fontSize: 11, fontFamily: "Inter_500Medium", color: C.textMuted },
});
