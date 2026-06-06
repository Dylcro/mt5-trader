import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
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
import { useCascadeSettings } from "@/hooks/useCascadeSettings";
import type { Zone } from "@/hooks/useZones";

const C = Colors.dark;
const TP_BUFFER = 5.0;
const LOT_STEP = 0.01;

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

function computeTpLot(originalVol: number, tpPct: number): number | null {
  const snapped = Math.round((originalVol * tpPct / 100) / LOT_STEP) * LOT_STEP;
  return snapped >= LOT_STEP ? snapped : null;
}

function PipelineTrack({
  zone,
  currentPrice,
}: {
  zone: Zone;
  currentPrice: number;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const tpHit = [zone.tp1Hit, zone.tp2Hit, zone.tp3Hit];
  const tps = [
    { level: 1 as const, price: zone.tp1Price, hit: zone.tp1Hit },
    { level: 2 as const, price: zone.tp2Price, hit: zone.tp2Hit },
    { level: 3 as const, price: zone.tp3Price, hit: zone.tp3Hit },
  ].filter((t) => t.price != null) as Array<{ level: 1 | 2 | 3; price: number; hit: boolean }>;

  const tp4Viz = zone.tp3Price != null
    ? zone.direction === "buy"
      ? zone.tp3Price + 10
      : zone.tp3Price - 10
    : null;

  const allPrices = [
    zone.anchorPrice,
    ...tps.map((t) => t.price),
    ...(tp4Viz != null ? [tp4Viz] : []),
  ].filter((p): p is number => p != null);
  const priceMin = Math.min(...allPrices);
  const priceMax = Math.max(...allPrices);
  const buf = (priceMax - priceMin) * 0.18;
  const vizMin = priceMin - buf;
  const vizMax = priceMax + buf;
  const toPos = (p: number) => {
    const raw = Math.min(Math.max(((p - vizMin) / (vizMax - vizMin)) * 100, 0), 100);
    return zone.direction === "sell" ? 100 - raw : raw;
  };

  const nextTpIdx = tps.findIndex((t) => !t.hit);
  const nextTp = nextTpIdx >= 0 ? tps[nextTpIdx] : null;
  const allTpHit = tps.length > 0 && tps.every((t) => t.hit);
  const prevPrice = nextTpIdx > 0 ? tps[nextTpIdx - 1]!.price : nextTpIdx === 0 ? zone.anchorPrice : tps.at(-1)?.price ?? zone.anchorPrice;
  const nextPrice = allTpHit ? tp4Viz : nextTp?.price ?? null;
  const progressPct =
    nextPrice != null && prevPrice != null
      ? zone.direction === "buy"
        ? Math.min(Math.max(((currentPrice - prevPrice) / (nextPrice - prevPrice)) * 100, 0), 100)
        : Math.min(Math.max(((prevPrice - currentPrice) / (prevPrice - nextPrice)) * 100, 0), 100)
      : 100;
  const atLevel = nextPrice != null && (
    zone.direction === "buy"
      ? currentPrice >= nextPrice - 0.5
      : currentPrice <= nextPrice + 0.5
  );

  const fillPct = toPos(currentPrice);
  const fillAnim = useRef(new Animated.Value(fillPct)).current;
  const progAnim = useRef(new Animated.Value(progressPct)).current;

  useEffect(() => {
    Animated.timing(fillAnim, {
      toValue: fillPct,
      duration: 150,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
    Animated.timing(progAnim, {
      toValue: progressPct,
      duration: 150,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [fillPct, progressPct, fillAnim, progAnim]);

  return (
    <View style={{ marginBottom: 12 }}>
      <View
        style={{ height: 24, position: "relative" }}
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
      >
        <View style={[styles.pipeTrack, { width: trackWidth || "100%" }]} />
        {trackWidth > 0 && (
          <Animated.View
            style={[
              styles.pipeFill,
              zone.direction === "sell" && { left: undefined, right: 0 },
              {
                width: fillAnim.interpolate({
                  inputRange: [0, 100],
                  outputRange: ["0%", "100%"],
                  extrapolate: "clamp",
                }),
                backgroundColor: atLevel ? C.greenProgress : C.goldProgress,
              },
            ]}
          />
        )}
        {tps.map((tp) => {
          const hit = tp.hit;
          const isNext = !hit && nextTp?.level === tp.level;
          const left = trackWidth * toPos(tp.price) / 100 - 7;
          return (
            <View
              key={tp.level}
              style={[styles.pipeDot, { left: Math.max(0, left) }, hit && styles.pipeDotHit, isNext && styles.pipeDotNext]}
            >
              {hit && <Feather name="check" size={7} color="#fff" strokeWidth={3} />}
            </View>
          );
        })}
        {tp4Viz != null && trackWidth > 0 && (
          <View
            style={[
              styles.pipeDot,
              styles.pipeDotRunner,
              {
                left: Math.max(0, trackWidth * toPos(tp4Viz) / 100 - 7),
                backgroundColor: zone.runnerActive ? C.tealBg : "#fff",
                borderColor: zone.runnerActive ? C.teal : "#D1D5DB",
              },
            ]}
          />
        )}
        {trackWidth > 0 && (
          <View style={[styles.pipeNeedle, { left: Math.max(0, trackWidth * toPos(currentPrice) / 100 - 1) }]} />
        )}
      </View>
      <View style={styles.pipeLabels}>
        <Text style={[styles.pipeLabel, { color: C.specSell }]}>SL</Text>
        {tps.map((tp) => (
          <Text key={tp.level} style={[styles.pipeLabel, tp.hit && { color: C.specGold }]}>TP{tp.level}</Text>
        ))}
        <Text style={[styles.pipeLabel, zone.runnerActive && { color: C.teal }]}>Runner</Text>
      </View>
      {nextPrice != null && (
        <View style={{ marginTop: 10 }}>
          <View style={styles.progressHeader}>
            <Text style={styles.progressPrice}>{formatPrice(currentPrice)}</Text>
            <Text style={styles.progressTarget}>
              → {allTpHit ? "Runner" : `TP${nextTp!.level}`} {formatPrice(nextPrice)}
            </Text>
            <Text style={[styles.progressDist, atLevel && { color: C.specBuy }]}>
              {atLevel
                ? "ready ✓"
                : nextPrice != null
                  ? `${Math.abs((nextPrice - currentPrice) / 0.1).toFixed(1)}p away`
                  : "—"}
            </Text>
          </View>
          <View style={styles.progressTrack}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  width: progAnim.interpolate({
                    inputRange: [0, 100],
                    outputRange: ["0%", "100%"],
                    extrapolate: "clamp",
                  }),
                  backgroundColor: atLevel ? C.greenProgress : C.goldProgress,
                },
              ]}
            />
          </View>
        </View>
      )}
    </View>
  );
}

function RunnerSetupPanel({
  zone,
  remaining,
  currentMarketPrice,
  onActivate,
  onSkipClose,
  busy,
}: {
  zone: Zone;
  remaining: number;
  currentMarketPrice: number;
  onActivate: (targets: {
    r1?: { price: number; lots: number };
    r2?: { price: number; lots: number };
    r3?: { price: number; lots: number };
  }) => Promise<{ ok: boolean; message?: string }>;
  onSkipClose: () => void;
  busy: boolean;
}) {
  const [r1, setR1] = useState({ price: "", lots: "" });
  const [r2, setR2] = useState({ price: "", lots: "" });
  const [r3, setR3] = useState({ price: "", lots: "" });

  const filledPrices = [r1, r2, r3].filter((r) => r.price.trim().length > 0);
  const autoLot =
    filledPrices.length > 0
      ? Math.round((remaining / filledPrices.length) / LOT_STEP) * LOT_STEP
      : remaining;

  const rows = [
    { n: 1, s: r1, set: setR1 },
    { n: 2, s: r2, set: setR2 },
    { n: 3, s: r3, set: setR3 },
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
        <Text style={styles.runnerPanelTitle}>🏃 Set runner targets</Text>
        <Text style={styles.runnerRemaining}>Remaining: {remaining.toFixed(2)} lots</Text>
      </View>
      {rows.map(({ n, s, set }) => (
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
              }}
              keyboardType="decimal-pad"
              placeholderTextColor={C.specMuted}
            />
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
        style={[styles.runnerActivateBtn, (!ok || busy) && { backgroundColor: "#9CA3AF" }]}
        disabled={!ok || busy}
        onPress={async () => {
          const result = await onActivate(buildTargets());
          if (!result.ok) Alert.alert("Activate failed", result.message ?? "Try again");
        }}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.runnerActivateText}>Activate Runner 🏃</Text>}
      </Pressable>
      <Pressable style={styles.runnerSkipBtn} onPress={onSkipClose} disabled={busy}>
        <Text style={styles.runnerSkipText}>Skip for now</Text>
      </Pressable>
    </View>
  );
}

interface ZoneCardProps {
  zone: Zone;
  liveVolume?: number;
  floatingPnl?: number;
  onSafe?: (zoneId: string) => Promise<{ ok: boolean; message?: string }>;
  onCloseAllWorst?: (zoneId: string) => Promise<{ ok: boolean; message?: string; closedCount?: number }>;
  onCloseZone?: (zoneId: string) => Promise<{ ok: boolean; message?: string; closedCount?: number }>;
  onClosePartial?: (zoneId: string, opts: { pct?: number; lots?: number; tpLevel?: number }) => Promise<{ ok: boolean; message?: string }>;
  onActivateRunner?: (
    zoneId: string,
    targets: {
      r1?: { price: number; lots: number };
      r2?: { price: number; lots: number };
      r3?: { price: number; lots: number };
    },
  ) => Promise<{ ok: boolean; message?: string }>;
  onCancelOrders?: (zoneId: string) => Promise<{ ok: boolean; message?: string; cancelledCount?: number }>;
  historical?: boolean;
}

export default function ZoneCard({
  zone,
  liveVolume,
  floatingPnl,
  onSafe,
  onCloseAllWorst,
  onCloseZone,
  onClosePartial,
  onActivateRunner,
  onCancelOrders,
  historical = false,
}: ZoneCardProps) {
  const { settings: cs } = useCascadeSettings();
  const isBuy = zone.direction === "buy";
  const runnerActive = Boolean(zone.runnerActive);
  const [busy, setBusy] = useState(false);
  const [tpBusy, setTpBusy] = useState<number | null>(null);
  const [worstBusy, setWorstBusy] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [showRunnerPanel, setShowRunnerPanel] = useState(false);

  useEffect(() => {
    if (zone.tp3Hit && !zone.runnerActive) {
      setShowRunnerPanel(true);
    }
  }, [zone.tp3Hit, zone.runnerActive]);

  const origVol = zone.originalVolume ?? liveVolume ?? 0;
  const vol = liveVolume ?? origVol;
  const cmp = zone.currentPrice ?? zone.anchorPrice;

  const showTp3Notif =
    !historical &&
    !zone.tp3Hit &&
    zone.tp3Price != null &&
    (isBuy ? cmp >= zone.tp3Price - TP_BUFFER : cmp <= zone.tp3Price + TP_BUFFER);

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
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const result = await onCloseZone(zone.zoneId);
    setCloseBusy(false);
    if (!result.ok) Alert.alert("Couldn't close zone", result.message ?? "Try again");
  };

  const actionBusy = busy || worstBusy || closeBusy || delBusy || runnerBusy || tpBusy != null;

  const canSafe =
    !historical && (zone.status === "OPEN" || zone.status === "RISK_FREE") && zone.positionCount >= 1 && !!onSafe;
  const showCloseAllWorst = !historical && zone.status !== "CLOSED" && zone.status !== "ARMED" && !!onCloseAllWorst;
  const canCloseAllWorst = showCloseAllWorst && zone.positionCount >= 2;
  const canCloseZone = !historical && zone.status !== "CLOSED" && zone.positionCount >= 1 && !!onCloseZone;
  const canCancelOrders = !historical && zone.status !== "CLOSED" && !!onCancelOrders;
  const runnerPanelOpen =
    !historical && showRunnerPanel && zone.tp3Hit && !runnerActive && zone.status !== "CLOSED";
  const showActionRow = !runnerPanelOpen && (canSafe || showCloseAllWorst || canCancelOrders);

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

  return (
    <View style={[styles.card, runnerActive && styles.cardRunner]}>
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
            <Pressable style={styles.closeZoneTopBtn} onPress={() => void runCloseZone()} disabled={actionBusy}>
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

      <View style={[styles.pnlStrip, { backgroundColor: isBuy ? C.specBuyBg : "rgba(220,38,38,0.07)" }]}>
        <Text style={styles.pnlLeft}>
          {vol > 0.001 ? `${vol.toFixed(2)} lots running` : "position complete"}
        </Text>
        {floatingPnl != null && (
          <Text style={[styles.pnlRight, { color: floatingPnl >= 0 ? C.specBuy : C.specSell }]}>
            {floatingPnl >= 0 ? "+" : ""}{floatingPnl.toFixed(2)}
          </Text>
        )}
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

      <PipelineTrack zone={zone} currentPrice={cmp} />

      {runnerPanelOpen && onActivateRunner && (
        <RunnerSetupPanel
          zone={zone}
          remaining={vol}
          currentMarketPrice={cmp}
          busy={runnerBusy}
          onSkipClose={() => setShowRunnerPanel(false)}
          onActivate={async (targets) => {
            setRunnerBusy(true);
            const result = await onActivateRunner(zone.zoneId, targets);
            setRunnerBusy(false);
            if (result.ok) setShowRunnerPanel(false);
            return result;
          }}
        />
      )}

      {runnerActive && runners.length > 0 && (
        <View style={{ marginBottom: 8 }}>
          <Text style={styles.runnerSectionLabel}>RUNNER TARGETS · push notification when each is hit</Text>
          <View style={styles.tpBtnRow}>
            {runners.map((r) => {
              const isNext = !r.hit && r.n === nextRunnerN;
              return (
                <Pressable
                  key={r.n}
                  style={[
                    styles.tpBtn,
                    styles.tpBtnRunner,
                    r.hit && styles.tpBtnHit,
                    isNext && styles.tpBtnRunnerNext,
                    r.hit && { opacity: 0.75 },
                  ]}
                  disabled={r.hit || !onClosePartial || tpBusy != null}
                  onPress={async () => {
                    setTpBusy(r.n);
                    const result = await onClosePartial!(zone.zoneId, { lots: r.lots! });
                    setTpBusy(null);
                    if (!result.ok) Alert.alert("Close failed", result.message ?? "Try again");
                  }}
                >
                  <Text style={[styles.tpBtnSub, (r.hit || isNext) && { color: r.hit ? C.specGold : C.teal }]}>
                    {r.hit ? "✓ HIT" : `R${r.n}`}
                  </Text>
                  <Text style={[styles.tpBtnPrice, r.hit && { color: C.specGold }, isNext && { color: C.teal }]}>
                    {formatPrice(r.price!)}
                  </Text>
                  <Text style={[styles.tpBtnLots, r.hit && { color: C.specGold }]}>{r.lots!.toFixed(2)} lots</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {showActionRow && (
        <View style={styles.actionRow}>
          {canSafe && (
            <Pressable
              style={styles.rfBtn}
              onPress={async () => {
                if (!onSafe || busy) return;
                setBusy(true);
                const result = await onSafe(zone.zoneId);
                setBusy(false);
                if (!result.ok) Alert.alert("Safe failed", result.message ?? "Try again");
              }}
              disabled={actionBusy}
            >
              <Feather name="shield" size={12} color={C.specGold} />
              <Text style={styles.rfBtnText}>Safe</Text>
            </Pressable>
          )}
          {showCloseAllWorst && (
            <Pressable
              style={[styles.secureBtn, !canCloseAllWorst && { opacity: 0.45 }]}
              onPress={async () => {
                if (!onCloseAllWorst || worstBusy || !canCloseAllWorst) return;
                setWorstBusy(true);
                const result = await onCloseAllWorst(zone.zoneId);
                setWorstBusy(false);
                if (!result.ok) Alert.alert("Secure failed", result.message ?? "Try again");
              }}
              disabled={actionBusy || !canCloseAllWorst}
            >
              <Text style={styles.secureBtnText}>Secure</Text>
            </Pressable>
          )}
          {canCancelOrders && (
            <Pressable
              style={styles.delBtn}
              onPress={async () => {
                if (!onCancelOrders || delBusy) return;
                setDelBusy(true);
                const result = await onCancelOrders(zone.zoneId);
                setDelBusy(false);
                if (!result.ok) Alert.alert("Delete limits failed", result.message ?? "Try again");
              }}
              disabled={actionBusy}
            >
              <Text style={styles.delBtnText}>Del Limits</Text>
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
  pnlStrip: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  pnlLeft: { fontSize: 11, fontFamily: "Inter_500Medium", color: C.specMuted },
  pnlRight: { fontSize: 18, fontFamily: "Inter_700Bold" },
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
  pipeTrack: {
    position: "absolute",
    top: 10,
    left: 0,
    height: 4,
    backgroundColor: "#F3F4F6",
    borderRadius: 4,
  },
  pipeFill: { position: "absolute", top: 10, left: 0, height: 4, borderRadius: 4 },
  pipeDot: {
    position: "absolute",
    top: 4,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: "#D1D5DB",
    alignItems: "center",
    justifyContent: "center",
  },
  pipeDotHit: { backgroundColor: C.specGold, borderColor: C.specGold },
  pipeDotNext: { borderColor: C.specGold },
  pipeDotRunner: { borderStyle: "dashed" },
  pipeNeedle: {
    position: "absolute",
    top: 6,
    width: 2,
    height: 12,
    backgroundColor: C.specText,
    borderRadius: 1,
  },
  pipeLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginTop: 4,
  },
  pipeLabel: { fontSize: 8, fontFamily: "Inter_600SemiBold", color: C.specMuted },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  progressPrice: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: C.specMuted },
  progressTarget: { fontSize: 11, fontFamily: "Inter_500Medium", color: C.specMuted },
  progressDist: { fontSize: 11, fontFamily: "Inter_700Bold", color: C.specText },
  progressTrack: { height: 5, backgroundColor: "#F3F4F6", borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 4 },
  tpBtnRow: { flexDirection: "row", gap: 7 },
  tpBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: C.specBorder,
    backgroundColor: C.cardAlt,
  },
  tpBtnHit: { borderColor: C.specGoldBdr, backgroundColor: C.specGoldBg },
  tpBtnDone: { borderColor: "#D1D5DB", backgroundColor: "#F3F4F6" },
  tpBtnNext: { borderColor: C.specGoldBdr, backgroundColor: "rgba(201,137,46,0.05)" },
  tpBtnManual: { borderStyle: "dashed" },
  tpBtnRunner: { borderStyle: "dashed" },
  tpBtnRunnerNext: { borderColor: C.tealBdr, backgroundColor: C.tealBg },
  tpBtnSub: { fontSize: 8.5, fontFamily: "Inter_700Bold", color: C.specMuted, letterSpacing: 0.7, marginBottom: 2 },
  tpBtnMain: { fontSize: 13, fontFamily: "Inter_700Bold", color: C.specText },
  tpBtnManualText: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: C.specMuted },
  tpBtnPrice: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: C.specText },
  tpBtnLots: { fontSize: 9, color: C.specMuted, marginTop: 1 },
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
  runnerSectionLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: C.teal,
    letterSpacing: 0.7,
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.tealBdr,
  },
  actionRow: { flexDirection: "row", gap: 8 },
  rfBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 9,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: C.specGoldBdr,
    backgroundColor: C.specGoldBg,
  },
  rfBtnText: { fontSize: 11, fontFamily: "Inter_700Bold", color: C.specGold },
  secureBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(99,179,237,0.45)",
    backgroundColor: "rgba(99,179,237,0.08)",
  },
  secureBtnText: { fontSize: 11, fontFamily: "Inter_700Bold", color: "#2B6CB0" },
  delBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: "rgba(124,58,237,0.3)",
    backgroundColor: "rgba(124,58,237,0.06)",
  },
  delBtnText: { fontSize: 11, fontFamily: "Inter_700Bold", color: "#7C3AED" },
  histRow: { flexDirection: "row", justifyContent: "space-between" },
  histText: { fontSize: 11, fontFamily: "Inter_500Medium", color: C.textMuted },
});
