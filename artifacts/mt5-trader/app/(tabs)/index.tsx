import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";

import { useTrading, type SLMode } from "@/context/TradingContext";
import { buildCascadeLevels, useCascadeSettings } from "@/hooks/useCascadeSettings";

const C = Colors.dark;

type Direction = "buy" | "sell";
type TradeMode = "single" | "cascade";

function formatPrice(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function PriceRow({
  label,
  value,
  color,
  sublabel,
}: {
  label: string;
  value: string;
  color: string;
  sublabel?: string;
}) {
  return (
    <View style={styles.priceRow}>
      <Text style={styles.priceLabel}>{label}</Text>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[styles.priceValue, { color }]}>{value}</Text>
        {sublabel ? <Text style={styles.priceSublabel}>{sublabel}</Text> : null}
      </View>
    </View>
  );
}

function StepInput({
  value,
  onChange,
  step,
  min,
  max,
  decimals = 2,
}: {
  value: number;
  onChange: (n: number) => void;
  step: number;
  min: number;
  max: number;
  decimals?: number;
}) {
  const [text, setText] = useState(value.toFixed(decimals));

  useEffect(() => {
    setText(value.toFixed(decimals));
  }, [value, decimals]);

  const dec = () => {
    const next = Math.max(min, parseFloat((value - step).toFixed(decimals)));
    onChange(next);
  };
  const inc = () => {
    const next = Math.min(max, parseFloat((value + step).toFixed(decimals)));
    onChange(next);
  };

  return (
    <View style={styles.stepRow}>
      <Pressable style={styles.stepBtn} onPress={dec} hitSlop={8}>
        <Feather name="minus" size={16} color={C.text} />
      </Pressable>
      <TextInput
        style={styles.stepInput}
        value={text}
        onChangeText={setText}
        keyboardType="decimal-pad"
        onBlur={() => {
          const n = parseFloat(text);
          if (!isNaN(n)) {
            const clamped = Math.min(max, Math.max(min, n));
            onChange(parseFloat(clamped.toFixed(decimals)));
          } else {
            setText(value.toFixed(decimals));
          }
        }}
        selectTextOnFocus
        placeholderTextColor={C.textMuted}
      />
      <Pressable style={styles.stepBtn} onPress={inc} hitSlop={8}>
        <Feather name="plus" size={16} color={C.text} />
      </Pressable>
    </View>
  );
}

type SLOption = { key: SLMode; label: string; icon: string };
const SL_OPTIONS: SLOption[] = [
  { key: "points", label: "Pips", icon: "trending-down" },
  { key: "percent", label: "% Risk", icon: "percent" },
  { key: "manual", label: "Manual", icon: "edit-2" },
];

// XAUUSD: 1 pip = $0.10 price movement
const PIP_SIZE = 0.10;

function computeSL(
  mode: SLMode,
  direction: Direction,
  entryPrice: number,
  slPips: number,
  slPercent: number,
  slManual: number,
  lotSize: number,
  balance: number
): number | undefined {
  if (entryPrice <= 0) return undefined;
  if (mode === "points") {
    const dist = slPips * PIP_SIZE;
    return direction === "buy"
      ? parseFloat((entryPrice - dist).toFixed(2))
      : parseFloat((entryPrice + dist).toFixed(2));
  }
  if (mode === "percent") {
    const riskDollars = balance * (slPercent / 100);
    const distDollars = riskDollars / (lotSize * 100);
    return direction === "buy"
      ? parseFloat((entryPrice - distDollars).toFixed(2))
      : parseFloat((entryPrice + distDollars).toFixed(2));
  }
  if (mode === "manual") {
    return slManual > 0 ? parseFloat(slManual.toFixed(2)) : undefined;
  }
  return undefined;
}

function computeRiskDollars(
  mode: SLMode,
  direction: Direction,
  entryPrice: number,
  slPips: number,
  slPercent: number,
  slManual: number,
  lotSize: number,
  balance: number
): number {
  const sl = computeSL(mode, direction, entryPrice, slPips, slPercent, slManual, lotSize, balance);
  if (sl == null || entryPrice <= 0) return 0;
  const dist = Math.abs(entryPrice - sl);
  return dist * lotSize * 100;
}

// ─── Cascade Ladder Preview ───────────────────────────────────────────────────
function CascadeLadder({
  marketPrice,
  limitEntries,
  stopLoss,
  direction,
  lotSize,
}: {
  marketPrice: number;
  limitEntries: number[];
  stopLoss: number;
  direction: Direction;
  lotSize: number;
}) {
  const color = direction === "buy" ? C.buy : C.sell;
  const allPrices = [marketPrice, ...limitEntries];
  const totalRisk = allPrices.reduce((sum, entry) => {
    return sum + Math.abs(entry - stopLoss) * lotSize * 100;
  }, 0);

  return (
    <View style={styles.ladder}>
      <View style={styles.ladderHeader}>
        <Text style={styles.ladderTitle}>ORDER LADDER</Text>
        <Text style={[styles.ladderRisk, { color: C.sell }]}>
          Total Risk ~{totalRisk.toFixed(2)}
        </Text>
      </View>

      <View style={styles.ladderList}>
        {/* Market order row — always first */}
        <View style={[styles.ladderRow, styles.ladderRowMarket]}>
          <View style={[styles.ladderDot, { backgroundColor: color }]} />
          <View style={styles.ladderLine} />
          <View style={styles.ladderEntry}>
            <Text style={[styles.ladderEntryLabel, { color }]}>
              {direction === "buy" ? "BUY" : "SELL"} #1 · MARKET
            </Text>
            <Text style={styles.ladderEntryPrice}>{formatPrice(marketPrice)}</Text>
          </View>
          <Text style={styles.ladderLot}>{lotSize.toFixed(2)} lot</Text>
        </View>

        {/* Limit order rows */}
        {limitEntries.map((price, i) => (
          <View key={i} style={styles.ladderRow}>
            <View style={[styles.ladderDot, { backgroundColor: color, opacity: 0.6 }]} />
            <View style={styles.ladderLine} />
            <View style={styles.ladderEntry}>
              <Text style={[styles.ladderEntryLabel, { color, opacity: 0.8 }]}>
                {direction === "buy" ? "BUY" : "SELL"} #{i + 2} · LIMIT
              </Text>
              <Text style={styles.ladderEntryPrice}>{formatPrice(price)}</Text>
            </View>
            <Text style={styles.ladderLot}>{lotSize.toFixed(2)} lot</Text>
          </View>
        ))}

        {/* SL Row */}
        <View style={[styles.ladderRow, { marginTop: 4 }]}>
          <View style={[styles.ladderDot, styles.ladderDotSL]} />
          <View style={[styles.ladderLine, { backgroundColor: C.sell }]} />
          <View style={styles.ladderEntry}>
            <Text style={[styles.ladderEntryLabel, { color: C.sell }]}>STOP LOSS · ALL</Text>
            <Text style={[styles.ladderEntryPrice, { color: C.sell }]}>{formatPrice(stopLoss)}</Text>
          </View>
          <Text style={styles.ladderLot}>{allPrices.length} orders</Text>
        </View>
      </View>
    </View>
  );
}

type ToastState = { message: string; type: "success" | "error" } | null;

function TradeToast({ toast, insetTop }: { toast: ToastState; insetTop: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (toast) {
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, damping: 14, stiffness: 160 }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    }
  }, [toast, anim]);
  if (!toast) return null;
  const isOk = toast.type === "success";
  return (
    <Animated.View style={[
      styles.toast,
      { top: insetTop + 8, backgroundColor: isOk ? C.buy : C.sell,
        transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-80, 0] }) }],
        opacity: anim }
    ]}>
      <Feather name={isOk ? "check-circle" : "alert-circle"} size={18} color="#fff" />
      <Text style={styles.toastText}>{toast.message}</Text>
    </Animated.View>
  );
}

export default function TradeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { status, price, priceError, accountInfo, placeTrade, placeCascadeOrders, refreshPrice, connect, accountId, apiBase, region, cancelOrder, pendingOrders, refreshPendingOrders, positions, closePosition, modifyPosition, refreshPositions } = useTrading();
  const { settings: cascadeSettings } = useCascadeSettings();
  const cascadeSettingsRef = useRef(cascadeSettings);
  useEffect(() => { cascadeSettingsRef.current = cascadeSettings; }, [cascadeSettings]);

  // Refs for rapidly-changing values so trade callbacks are stable (never recreate on price ticks)
  const priceRef = useRef(price);
  useEffect(() => { priceRef.current = price; }, [price]);
  const isPlacingRef = useRef(false);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  const [toast, setToast] = useState<ToastState>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: "success" | "error", navigatePositions = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
    if (navigatePositions && type === "success") {
      setTimeout(() => router.navigate("/(tabs)/positions"), 1000);
    }
  }, [router]);

  // Mode
  const [tradeMode, setTradeMode] = useState<TradeMode>("cascade");

  // Single trade state
  const [direction, setDirection] = useState<Direction>("buy");
  const [lotSize, setLotSize] = useState(0.01);
  const [slMode, setSlMode] = useState<SLMode>("points");
  const [slPips, setSlPips] = useState(50);
  const [slPercent, setSlPercent] = useState(1);
  const [slManual, setSlManual] = useState(0);
  const [slManualText, setSlManualText] = useState("");

  // Shared SL session (single order mode — trades placed inside this app)
  type SharedSLSession = { direction: Direction; stopLoss: number; anchorEntry: number };
  const [sharedSLSession, setSharedSLSession] = useState<SharedSLSession | null>(null);
  const sharedSLSessionRef = useRef<SharedSLSession | null>(null);
  useEffect(() => { sharedSLSessionRef.current = sharedSLSession; }, [sharedSLSession]);
  const sharedSLHasHadPositionRef = useRef(false);

  // MT5 monitor session — server-side SL monitor (state is UI mirror of server)
  type MT5MonitorSession = { direction: Direction; stopLoss: number; anchorEntry: number | null; patchedCount: number };
  const [mt5MonitorSession, setMT5MonitorSession] = useState<MT5MonitorSession | null>(null);

  // Cascade state
  const [cascadeDirection, setCascadeDirection] = useState<Direction>("buy");
  const [cascadeLotSize, setCascadeLotSize] = useState(0.01);

  const [isPlacing, setIsPlacing] = useState(false);

  // Per-cascade watcher entry — each cascade gets its own entry so they never interfere
  type WatcherEntry = {
    id: string; // unique per cascade placement
    entryPrice: number;
    direction: "buy" | "sell";
    pipsTarget: number;
    readyAt: number;
    marketPositionId?: string;
    limitOrderIds?: string[];
    limitPrices?: number[]; // to find filled limits that became positions
  };

  const watchersRef = useRef<WatcherEntry[]>([]); // delete-limits queue
  const tpWatchersRef = useRef<WatcherEntry[]>([]); // take-profit queue

  useEffect(() => {
    if (!price) return;
    const now = Date.now();

    // — Take profit queue —
    const firedTpIds = new Set<string>();
    for (const tp of tpWatchersRef.current) {
      if (now < tp.readyAt) continue;
      const dist = tp.pipsTarget * 0.10;
      const hit = tp.direction === "buy" ? price.bid >= tp.entryPrice + dist : price.bid <= tp.entryPrice - dist;
      if (!hit) continue;
      firedTpIds.add(tp.id);

      // Close only the specific market position from this cascade (by stored positionId)
      const positionsToClose: string[] = [];
      if (tp.marketPositionId) positionsToClose.push(tp.marketPositionId);

      // Cancel all limit order IDs from this cascade — don't filter against pendingOrders because
      // the 10s poll may not have run yet. The API returns 4754 gracefully for already-gone orders.
      const ordersToCancel = tp.limitOrderIds ?? [];

      const actualPips = ((tp.direction === "buy" ? price.bid - tp.entryPrice : tp.entryPrice - price.bid) / 0.10).toFixed(1);
      console.log(`[tp-watcher id=${tp.id}] FIRE dir=${tp.direction} target=+${tp.pipsTarget}pip actual=+${actualPips}pip bid=${price.bid} entry=${tp.entryPrice} — closing posId=${tp.marketPositionId}, cancelling ${ordersToCancel.length} limits`);
      void Promise.all([
        ...positionsToClose.map((id) => closePosition(id)),
        ...ordersToCancel.map((id) => cancelOrder(id)),
      ]).then(() => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast(
          `TP +${actualPips}pip hit (target ${tp.pipsTarget})`,
          "success",
          true
        );
        void refreshPendingOrders();
      });
    }
    if (firedTpIds.size > 0) {
      // Remove fired TP entries and their matching limits-delete entries
      tpWatchersRef.current = tpWatchersRef.current.filter((tp) => !firedTpIds.has(tp.id));
      watchersRef.current = watchersRef.current.filter((w) => !firedTpIds.has(w.id));
    }

    // — Delete-limits queue —
    const firedLimitIds = new Set<string>();
    for (const w of watchersRef.current) {
      if (now < w.readyAt) continue;
      const dist = w.pipsTarget * 0.10;
      const hit = w.direction === "buy" ? price.bid >= w.entryPrice + dist : price.bid <= w.entryPrice - dist;
      if (!hit) continue;
      firedLimitIds.add(w.id);

      // Use all limitOrderIds directly — don't filter against pendingOrders (poll may be stale).
      // The API returns 4754 gracefully for already-gone orders.
      const ordersToCancel = w.limitOrderIds ?? [];
      if (ordersToCancel.length === 0) continue;
      const actualPips = ((w.direction === "buy" ? price.bid - w.entryPrice : w.entryPrice - price.bid) / 0.10).toFixed(1);
      console.log(`[watcher id=${w.id}] FIRE dir=${w.direction} target=+${w.pipsTarget}pip actual=+${actualPips}pip bid=${price.bid} entry=${w.entryPrice} — cancelling ${ordersToCancel.length} limit(s)`);
      void Promise.all(ordersToCancel.map((id) => cancelOrder(id))).then(() => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast(
          `Deleted ${ordersToCancel.length} limit${ordersToCancel.length !== 1 ? "s" : ""} at +${w.pipsTarget}pip`,
          "success",
          true
        );
        void refreshPendingOrders();
      });
    }
    if (firedLimitIds.size > 0) {
      watchersRef.current = watchersRef.current.filter((w) => !firedLimitIds.has(w.id));
    }
  }, [price, cancelOrder, closePosition, refreshPendingOrders, showToast]);

  // Auto-reset shared SL session when all positions in the range are closed
  useEffect(() => {
    const session = sharedSLSession;
    if (!session) { sharedSLHasHadPositionRef.current = false; return; }
    const [lo, hi] = session.direction === "buy"
      ? [session.stopLoss, session.anchorEntry]
      : [session.anchorEntry, session.stopLoss];
    const posType = session.direction === "buy" ? "POSITION_TYPE_BUY" : "POSITION_TYPE_SELL";
    const hasPosition = positions.some(
      (p) => p.type === posType && p.openPrice >= lo - 0.01 && p.openPrice <= hi + 0.01
    );
    if (hasPosition) {
      sharedSLHasHadPositionRef.current = true;
    } else if (sharedSLHasHadPositionRef.current) {
      setSharedSLSession(null);
      sharedSLHasHadPositionRef.current = false;
      showToast("SL session reset — all positions closed", "success");
    }
  }, [positions, sharedSLSession, showToast]);

  // Fetch server monitor status and sync to local state
  const fetchServerMonitorStatus = useCallback(async () => {
    if (!accountId) return;
    try {
      const res = await fetch(`${apiBase}/mt5/account/${accountId}/monitor`);
      const data = await res.json() as {
        active: boolean; direction?: Direction; stopLoss?: number;
        anchorEntry?: number | null; patchedCount?: number; lastPollError?: string | null;
      };
      if (data.active && data.direction && data.stopLoss != null) {
        setMT5MonitorSession((prev) => {
          const next = {
            direction: data.direction!,
            stopLoss: data.stopLoss!,
            anchorEntry: data.anchorEntry ?? null,
            patchedCount: data.patchedCount ?? 0,
          };
          // Toast when new patches applied
          if (prev && data.patchedCount != null && data.patchedCount > (prev.patchedCount ?? 0)) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            showToast(`SL ${formatPrice(data.stopLoss!)} applied to MT5 ${data.direction!.toUpperCase()} trade`, "success", true);
          }
          return next;
        });
      } else if (!data.active && mt5MonitorSessionRef.current) {
        setMT5MonitorSession(null);
        showToast("MT5 monitor session reset — all positions closed", "success");
      }
    } catch {}
  }, [accountId, apiBase, showToast]);

  // Poll server status every 4s when session is active
  const mt5MonitorSessionRef = useRef(mt5MonitorSession);
  useEffect(() => { mt5MonitorSessionRef.current = mt5MonitorSession; }, [mt5MonitorSession]);
  useEffect(() => {
    if (!mt5MonitorSession) return;
    const id = setInterval(() => { void fetchServerMonitorStatus(); }, 4000);
    return () => clearInterval(id);
  }, [mt5MonitorSession, fetchServerMonitorStatus]);

  // Immediate server status fetch when app returns to foreground
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && mt5MonitorSessionRef.current) {
        void fetchServerMonitorStatus();
      }
    });
    return () => sub.remove();
  }, [fetchServerMonitorStatus]);

  // Safety valve: if isPlacing somehow gets stuck, auto-reset after 90 seconds
  useEffect(() => {
    if (!isPlacing) return;
    const t = setTimeout(() => setIsPlacing(false), 90_000);
    return () => clearTimeout(t);
  }, [isPlacing]);

  const blinkAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blinkAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(blinkAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    );
    if (status === "connected") loop.start();
    else loop.stop();
    return () => loop.stop();
  }, [status, blinkAnim]);

  const marketEntry = direction === "buy" ? (price?.ask ?? 0) : (price?.bid ?? 0);
  const balance = accountInfo?.balance ?? 10000;
  const sl = computeSL(slMode, direction, marketEntry, slPips, slPercent, slManual, lotSize, balance);
  const riskDollars = computeRiskDollars(slMode, direction, marketEntry, slPips, slPercent, slManual, lotSize, balance);
  const slRef = useRef(sl);
  useEffect(() => { slRef.current = sl; }, [sl]);

  // Cascade levels — built from live market price (ask for buy, bid for sell)
  const cascadeMarketPrice = cascadeDirection === "buy" ? (price?.ask ?? 0) : (price?.bid ?? 0);
  const cascadeLevels = cascadeMarketPrice > 0
    ? buildCascadeLevels(cascadeMarketPrice, cascadeDirection, cascadeSettings)
    : null;

  // Session-aware SL for single order mode
  const sessionActive = sharedSLSession !== null && sharedSLSession.direction === direction;
  const sessionInRange = (() => {
    if (!sessionActive || !sharedSLSession) return false;
    const currentPrice = direction === "buy" ? (price?.ask ?? 0) : (price?.bid ?? 0);
    const [lo, hi] = direction === "buy"
      ? [sharedSLSession.stopLoss, sharedSLSession.anchorEntry]
      : [sharedSLSession.anchorEntry, sharedSLSession.stopLoss];
    return currentPrice > lo && currentPrice <= hi;
  })();
  const effectiveDisplaySL = sessionInRange ? sharedSLSession!.stopLoss : sl;

  const handleSingleTrade = useCallback(async () => {
    if (isPlacingRef.current) return;
    if (statusRef.current !== "connected") {
      Alert.alert("Not Connected", "Please connect your MT5 account in Settings first.");
      return;
    }
    const p = priceRef.current;
    const session = sharedSLSessionRef.current;

    // Determine effective SL — use session SL automatically when price is within session range
    let effectiveSL: number | undefined = slRef.current;
    let isSessionTrade = false;
    if (session && session.direction === direction) {
      const [lo, hi] = direction === "buy"
        ? [session.stopLoss, session.anchorEntry]
        : [session.anchorEntry, session.stopLoss];
      const currentPrice = direction === "buy" ? (p?.ask ?? 0) : (p?.bid ?? 0);
      if (currentPrice > lo && currentPrice <= hi) {
        effectiveSL = session.stopLoss;
        isSessionTrade = true;
      }
    }

    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    isPlacingRef.current = true;
    setIsPlacing(true);
    const result = await placeTrade({ direction, volume: lotSize, stopLoss: effectiveSL });
    isPlacingRef.current = false;
    setIsPlacing(false);

    if (result.success) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (!session && effectiveSL != null) {
        // Start a new session anchored at this entry price
        const anchorEntry = direction === "buy" ? (p?.ask ?? 0) : (p?.bid ?? 0);
        setSharedSLSession({ direction, stopLoss: effectiveSL, anchorEntry });
        showToast(`${direction.toUpperCase()} placed ✓ — SL session started, SL ${formatPrice(effectiveSL)}`, "success", true);
      } else {
        showToast(
          isSessionTrade
            ? `${direction.toUpperCase()} ✓ — shared SL ${formatPrice(effectiveSL!)} applied`
            : `${direction.toUpperCase()} order placed ✓  ${lotSize} lot`,
          "success", true
        );
      }
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showToast(result.message, "error");
    }
  }, [direction, lotSize, placeTrade, showToast]);

  const [mt5MonitorStarting, setMT5MonitorStarting] = useState(false);

  const openMT5AndMonitor = useCallback(async () => {
    if (statusRef.current !== "connected") {
      Alert.alert("Not Connected", "Please connect your MT5 account in Settings first.");
      return;
    }
    // Use sl directly — it is captured in the closure via the dependency array
    if (sl == null) {
      const hint = slMode === "manual"
        ? "Enter a price in the Stop Loss field first."
        : "Connect your account so a price-based SL can be calculated, or switch to Manual SL.";
      Alert.alert("No Stop Loss Set", hint);
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setMT5MonitorStarting(true);
    // Register session on server — server polls every 2s regardless of app state
    try {
      const res = await fetch(`${apiBase}/mt5/account/${accountId}/monitor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, stopLoss: sl, region }),
      });
      const data = await res.json() as { active?: boolean; error?: string };
      if (!res.ok || !data.active) {
        showToast(data.error ?? "Failed to start server monitor", "error");
        setMT5MonitorStarting(false);
        return;
      }
    } catch (e) {
      showToast(`Server error: ${e instanceof Error ? e.message : "check connection"}`, "error");
      setMT5MonitorStarting(false);
      return;
    }
    setMT5MonitorStarting(false);
    setMT5MonitorSession({ direction, stopLoss: sl, anchorEntry: null, patchedCount: 0 });
    showToast(`Monitor ON — SL ${formatPrice(sl)} auto-applies to every MT5 ${direction.toUpperCase()}`, "success", true);
    try {
      const canOpen = await Linking.canOpenURL("metatrader5://");
      if (canOpen) {
        await Linking.openURL("metatrader5://");
      } else {
        showToast("MT5 app not found — open it manually", "error");
      }
    } catch {
      showToast("Could not open MT5 — open it manually", "error");
    }
  }, [direction, sl, slMode, apiBase, accountId, region, showToast]);

  const handleCascadeTrade = useCallback(async (dir: Direction) => {
    const p = priceRef.current;
    console.log("[cascade] btn pressed dir=" + dir + " isPlacing=" + String(isPlacingRef.current) + " status=" + statusRef.current + " ask=" + String(p?.ask) + " bid=" + String(p?.bid));
    if (isPlacingRef.current) {
      Alert.alert("Please Wait", "An order is already being placed. Please wait for it to complete.");
      return;
    }
    if (statusRef.current !== "connected") {
      Alert.alert("Not Connected", "Please connect your MT5 account in Settings first, then return here to trade.");
      return;
    }
    const mktPrice = dir === "buy" ? (p?.ask ?? 0) : (p?.bid ?? 0);
    if (!p || mktPrice <= 0) {
      Alert.alert("No Price Yet", "Waiting for a live price from your broker. Please wait a moment, then try again.\n\nTip: tap ↻ in the top-right to force a refresh.");
      return;
    }
    const cs = cascadeSettingsRef.current;
    const levels = buildCascadeLevels(mktPrice, dir, cs);
    const total = 1 + levels.limitEntries.length;
    // Lock immediately so button shows loading and double-taps are blocked
    isPlacingRef.current = true;
    setIsPlacing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    console.log("[cascade] placing dir=" + dir + " vol=" + String(cascadeLotSize) + " entries=[" + levels.limitEntries.join(",") + "] sl=" + String(levels.stopLoss));
    try {
      const result = await placeCascadeOrders({
        direction: dir,
        volume: cascadeLotSize,
        limitEntries: levels.limitEntries,
        stopLoss: levels.stopLoss,
      });
      console.log("[cascade] done placed=" + String(result.placed) + " failed=" + String(result.failed) + " success=" + String(result.success) + " msg=" + result.message);
      if (result.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const failNote = result.failed > 0 ? ` (${result.failed} limit${result.failed > 1 ? "s" : ""} failed)` : "";
        showToast(`${result.placed}/${total} ${dir.toUpperCase()} orders placed ✓${failNote}`, "success", true);
        const cascadeId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const limitPrices = levels.limitEntries;
        const readyAt = Date.now() + 3000;
        // Always use bid as the reference price for watcher triggers — same price the user sees on the chart
        const watcherEntryPrice = p?.bid ?? mktPrice;
        if (cs.autoCloseLimitsEnabled && cs.autoCloseLimitsPips > 0) {
          const lTrigger = dir === "buy" ? watcherEntryPrice + cs.autoCloseLimitsPips * 0.10 : watcherEntryPrice - cs.autoCloseLimitsPips * 0.10;
          console.log(`[watcher id=${cascadeId}] arming +${cs.autoCloseLimitsPips}pip dir=${dir} entry(bid)=${watcherEntryPrice} trigger=${lTrigger} limitOrderIds=${JSON.stringify(result.limitOrderIds)}`);
          watchersRef.current.push({
            id: cascadeId,
            entryPrice: watcherEntryPrice,
            direction: dir,
            pipsTarget: cs.autoCloseLimitsPips,
            readyAt,
            marketPositionId: result.marketPositionId,
            limitOrderIds: result.limitOrderIds,
            limitPrices,
          });
        }
        if (cs.takeProfitEnabled && cs.takeProfitPips > 0) {
          const tpTrigger = dir === "buy" ? watcherEntryPrice + cs.takeProfitPips * 0.10 : watcherEntryPrice - cs.takeProfitPips * 0.10;
          console.log(`[tp-watcher id=${cascadeId}] arming +${cs.takeProfitPips}pip dir=${dir} entry(bid)=${watcherEntryPrice} trigger=${tpTrigger} posId=${result.marketPositionId}`);
          tpWatchersRef.current.push({
            id: cascadeId,
            entryPrice: watcherEntryPrice,
            direction: dir,
            pipsTarget: cs.takeProfitPips,
            readyAt,
            marketPositionId: result.marketPositionId,
            limitOrderIds: result.limitOrderIds,
            limitPrices,
          });
        }
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showToast(result.message, "error");
      }
    } catch (err) {
      console.log("[cascade] exception: " + String(err));
      showToast(err instanceof Error ? err.message : "Cascade failed", "error");
    } finally {
      isPlacingRef.current = false;
      setIsPlacing(false);
    }
  }, [cascadeLotSize, placeCascadeOrders, showToast]);

  const webTopPad = Platform.OS === "web" ? 67 : 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopPad }]}>
      <TradeToast toast={toast} insetTop={insets.top + webTopPad} />
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.symbol}>XAUUSD</Text>
          <Pressable
            onPress={() => {
              if (status === "disconnected") connect();
            }}
            hitSlop={12}
          >
            <View style={styles.liveDot}>
              <Animated.View style={[styles.dot, { opacity: status === "connected" ? blinkAnim : 0.2, backgroundColor: status === "connected" ? C.buy : status === "connecting" ? C.gold : C.sell }]} />
              <Text style={[styles.liveLabel, status === "disconnected" && { color: C.sell }]}>
                {status === "connected" ? "LIVE" : status === "disconnected" ? "TAP TO RECONNECT" : status.toUpperCase()}
              </Text>
            </View>
          </Pressable>
        </View>
        <Pressable onPress={refreshPrice} hitSlop={12}>
          <Feather name="refresh-cw" size={18} color={C.textSecondary} />
        </Pressable>
      </View>


      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Price Card */}
        <View style={styles.card}>
          {price ? (
            <>
              <PriceRow label="BID" value={formatPrice(price.bid)} color={C.sell} sublabel="Sell at" />
              <View style={styles.divider} />
              <PriceRow label="ASK" value={formatPrice(price.ask)} color={C.buy} sublabel="Buy at" />
              <View style={styles.divider} />
              <PriceRow label="SPREAD" value={`${price.spread} pips`} color={C.textSecondary} />
              {priceError && (
                <View style={styles.priceErrorBanner}>
                  <Feather name="wifi-off" size={12} color={C.sell} />
                  <Text style={styles.priceErrorText}>Price feed interrupted — tap{" "}
                    <Text style={{ color: C.textSecondary }} onPress={refreshPrice}>↻</Text> to retry
                  </Text>
                </View>
              )}
            </>
          ) : (
            <View style={styles.noPrice}>
              <MaterialCommunityIcons name="chart-line" size={28} color={C.textMuted} />
              <Text style={styles.noPriceText}>
                {priceError
                  ? "Price feed failed — tap ↻ to retry"
                  : status === "connecting"
                    ? "Fetching price..."
                    : "Connect account to see live price"}
              </Text>
            </View>
          )}
        </View>

        {/* Mode Toggle */}
        <View style={styles.modeToggle}>
          <Pressable
            style={[styles.modeBtn, tradeMode === "cascade" && styles.modeBtnActive]}
            onPress={() => { setTradeMode("cascade"); Haptics.selectionAsync(); }}
          >
            <Feather name="layers" size={14} color={tradeMode === "cascade" ? C.gold : C.textSecondary} />
            <Text style={[styles.modeBtnText, tradeMode === "cascade" && styles.modeBtnTextActive]}>
              Cascade
            </Text>
          </Pressable>
          <Pressable
            style={[styles.modeBtn, tradeMode === "single" && styles.modeBtnActive]}
            onPress={() => { setTradeMode("single"); Haptics.selectionAsync(); }}
          >
            <Feather name="zap" size={14} color={tradeMode === "single" ? C.gold : C.textSecondary} />
            <Text style={[styles.modeBtnText, tradeMode === "single" && styles.modeBtnTextActive]}>
              Single Order
            </Text>
          </Pressable>
        </View>

        {/* ═══ CASCADE MODE ═══════════════════════════════════════════════════ */}
        {tradeMode === "cascade" && (
          <>
            {/* Direction */}
            <View style={styles.directionRow}>
              <Pressable
                style={[styles.dirBtn, cascadeDirection === "buy" && styles.dirBtnBuyActive]}
                onPress={() => { setCascadeDirection("buy"); void Haptics.selectionAsync(); }}
              >
                <Feather name="trending-up" size={18} color={cascadeDirection === "buy" ? "#000" : C.buy} />
                <Text style={[styles.dirLabel, cascadeDirection === "buy" ? styles.dirLabelActiveBuy : { color: C.buy }]}>BUY</Text>
              </Pressable>
              <Pressable
                style={[styles.dirBtn, cascadeDirection === "sell" && styles.dirBtnSellActive]}
                onPress={() => { setCascadeDirection("sell"); void Haptics.selectionAsync(); }}
              >
                <Feather name="trending-down" size={18} color={cascadeDirection === "sell" ? "#fff" : C.sell} />
                <Text style={[styles.dirLabel, cascadeDirection === "sell" ? styles.dirLabelActiveSell : { color: C.sell }]}>SELL</Text>
              </Pressable>
            </View>

            {/* Live price info card */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Market Entry</Text>
                <Pressable onPress={refreshPrice} hitSlop={8}>
                  <Text style={styles.useMarketBtn}>Refresh</Text>
                </Pressable>
              </View>
              {cascadeMarketPrice > 0 ? (
                <>
                  <Text style={[styles.liveEntryPrice, { color: cascadeDirection === "buy" ? C.buy : C.sell }]}>
                    {formatPrice(cascadeMarketPrice)}
                  </Text>
                  <Text style={styles.priceInputNote}>
                    {cascadeDirection === "buy"
                      ? `Order #1 buys instantly at this price. ${cascadeSettings.numPositions - 1} limit order${cascadeSettings.numPositions - 1 !== 1 ? "s" : ""} placed ${cascadeSettings.pipsBetween} pips apart below.`
                      : `Order #1 sells instantly at this price. ${cascadeSettings.numPositions - 1} limit order${cascadeSettings.numPositions - 1 !== 1 ? "s" : ""} placed ${cascadeSettings.pipsBetween} pips apart above.`}
                  </Text>
                </>
              ) : (
                <Text style={styles.priceInputNote}>Connect your MT5 account to see the live price.</Text>
              )}
            </View>

            {/* Lot Size */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Lot Size (per order)</Text>
                <Text style={styles.sectionHint}>1 lot = 100 oz gold</Text>
              </View>
              <StepInput value={cascadeLotSize} onChange={setCascadeLotSize} step={0.01} min={0.01} max={100} decimals={2} />
            </View>

            {/* Cascade Ladder Preview */}
            {cascadeLevels && cascadeMarketPrice > 0 ? (
              <CascadeLadder
                marketPrice={cascadeMarketPrice}
                limitEntries={cascadeLevels.limitEntries}
                stopLoss={cascadeLevels.stopLoss}
                direction={cascadeDirection}
                lotSize={cascadeLotSize}
              />
            ) : (
              <View style={styles.cascadeHint}>
                <Feather name="info" size={14} color={C.textMuted} />
                <Text style={styles.cascadeHintText}>
                  Connect your account to preview the order ladder. Adjust positions, spacing and SL in Settings.
                </Text>
              </View>
            )}

            {/* Place cascade button */}
            {(() => {
              const cascadeReady = status === "connected" && !!price && cascadeMarketPrice > 0;
              const cascadeBtnLabel = isPlacing
                ? ""
                : status !== "connected"
                ? "Connect Account in Settings"
                : !price || cascadeMarketPrice <= 0
                ? "Waiting for Price..."
                : `Place ${cascadeSettings.numPositions} ${cascadeDirection.toUpperCase()} Orders`;
              const cascadeBtnColor = cascadeDirection === "buy" ? "#000" : "#fff";
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.tradeBtn,
                    cascadeDirection === "buy" ? styles.tradeBtnBuy : styles.tradeBtnSell,
                    !cascadeReady && !isPlacing && { opacity: 0.55 },
                    pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] },
                    isPlacing && { opacity: 0.6 },
                  ]}
                  onPress={() => handleCascadeTrade(cascadeDirection)}
                >
                  {isPlacing ? (
                    <ActivityIndicator color={cascadeBtnColor} />
                  ) : (
                    <>
                      <Feather
                        name={cascadeReady ? "layers" : status !== "connected" ? "wifi-off" : "clock"}
                        size={20}
                        color={cascadeBtnColor}
                      />
                      <Text style={[styles.tradeBtnText, { color: cascadeBtnColor }]}>
                        {cascadeBtnLabel}
                      </Text>
                    </>
                  )}
                </Pressable>
              );
            })()}
          </>
        )}

        {/* ═══ SINGLE MODE ════════════════════════════════════════════════════ */}
        {tradeMode === "single" && (
          <>
            {/* MT5 Monitor Session Banner */}
            {mt5MonitorSession && (
              <View style={[styles.sectionCard, { borderColor: "#4A90E2", borderWidth: 1 }]}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Feather name="eye" size={14} color="#4A90E2" />
                    <Text style={{ color: "#4A90E2", fontWeight: "700", fontSize: 13 }}>
                      MT5 Monitor — {mt5MonitorSession.direction.toUpperCase()} Active
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => {
                      void fetch(`${apiBase}/mt5/account/${accountId}/monitor`, { method: "DELETE" });
                      setMT5MonitorSession(null);
                      void Haptics.selectionAsync();
                    }}
                    hitSlop={8}
                  >
                    <Feather name="x" size={16} color={C.textSecondary} />
                  </Pressable>
                </View>
                <View style={{ marginTop: 8, gap: 4 }}>
                  <Text style={{ color: C.textSecondary, fontSize: 12 }}>
                    Auto-SL: <Text style={{ color: C.sell, fontWeight: "600" }}>{formatPrice(mt5MonitorSession.stopLoss)}</Text>
                    {mt5MonitorSession.anchorEntry != null
                      ? <Text>{"   "}Anchor: <Text style={{ color: C.text }}>{formatPrice(mt5MonitorSession.anchorEntry)}</Text></Text>
                      : <Text style={{ color: C.textMuted }}> — waiting for first trade…</Text>}
                  </Text>
                  <Text style={{ color: C.textMuted, fontSize: 11 }}>
                    {mt5MonitorSession.patchedCount > 0
                      ? `${mt5MonitorSession.patchedCount} trade${mt5MonitorSession.patchedCount !== 1 ? "s" : ""} patched — server monitoring active`
                      : `Server monitoring active — place a ${mt5MonitorSession.direction} in MT5`}
                  </Text>
                </View>
              </View>
            )}

            {/* Shared SL Session Banner */}
            {sharedSLSession && (
              <View style={[styles.sectionCard, { borderColor: C.gold, borderWidth: 1 }]}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Feather name="shield" size={14} color={C.gold} />
                    <Text style={{ color: C.gold, fontWeight: "700", fontSize: 13 }}>
                      {sharedSLSession.direction.toUpperCase()} Session Active
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => { setSharedSLSession(null); sharedSLHasHadPositionRef.current = false; void Haptics.selectionAsync(); }}
                    hitSlop={8}
                  >
                    <Feather name="x" size={16} color={C.textSecondary} />
                  </Pressable>
                </View>
                <View style={{ marginTop: 8, gap: 4 }}>
                  <Text style={{ color: C.textSecondary, fontSize: 12 }}>
                    Anchor: <Text style={{ color: C.text }}>{formatPrice(sharedSLSession.anchorEntry)}</Text>
                    {"   "}SL: <Text style={{ color: C.sell }}>{formatPrice(sharedSLSession.stopLoss)}</Text>
                  </Text>
                  <Text style={{ color: sessionInRange ? C.buy : C.textMuted, fontSize: 12 }}>
                    {sessionInRange
                      ? `Price in range — next ${sharedSLSession.direction} uses SL ${formatPrice(sharedSLSession.stopLoss)} automatically`
                      : `Price outside range [${formatPrice(Math.min(sharedSLSession.stopLoss, sharedSLSession.anchorEntry))}–${formatPrice(Math.max(sharedSLSession.stopLoss, sharedSLSession.anchorEntry))}]`}
                  </Text>
                </View>
              </View>
            )}

            {/* Direction Toggle */}
            <View style={styles.directionRow}>
              <Pressable
                style={[styles.dirBtn, direction === "buy" && styles.dirBtnBuyActive]}
                onPress={() => { setDirection("buy"); Haptics.selectionAsync(); }}
              >
                <Feather name="trending-up" size={18} color={direction === "buy" ? "#000" : C.buy} />
                <Text style={[styles.dirLabel, direction === "buy" ? styles.dirLabelActiveBuy : { color: C.buy }]}>
                  BUY
                </Text>
              </Pressable>
              <Pressable
                style={[styles.dirBtn, direction === "sell" && styles.dirBtnSellActive]}
                onPress={() => { setDirection("sell"); Haptics.selectionAsync(); }}
              >
                <Feather name="trending-down" size={18} color={direction === "sell" ? "#fff" : C.sell} />
                <Text style={[styles.dirLabel, direction === "sell" ? styles.dirLabelActiveSell : { color: C.sell }]}>
                  SELL
                </Text>
              </Pressable>
            </View>

            {/* Lot Size */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Lot Size</Text>
                <Text style={styles.sectionHint}>1 lot = 100 oz gold</Text>
              </View>
              <StepInput value={lotSize} onChange={setLotSize} step={0.01} min={0.01} max={100} decimals={2} />
            </View>

            {/* Stop Loss */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Stop Loss</Text>
                <Text style={[styles.sectionHint, { color: C.sell }]}>
                  {effectiveDisplaySL != null ? `SL: ${formatPrice(effectiveDisplaySL)}` : "No SL set"}
                </Text>
              </View>

              {sessionInRange ? (
                /* Locked to session SL — no manual controls */
                <View style={[styles.slInputArea, { alignItems: "center", paddingVertical: 6 }]}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Feather name="lock" size={14} color={C.gold} />
                    <Text style={{ color: C.gold, fontWeight: "700", fontSize: 15 }}>
                      {formatPrice(sharedSLSession!.stopLoss)}
                    </Text>
                    <Text style={{ color: C.textSecondary, fontSize: 12 }}>shared from session</Text>
                  </View>
                </View>
              ) : (
                <>
                  <View style={styles.slModeRow}>
                    {SL_OPTIONS.map((opt) => (
                      <Pressable
                        key={opt.key}
                        style={[styles.slModeBtn, slMode === opt.key && styles.slModeBtnActive]}
                        onPress={() => { setSlMode(opt.key); Haptics.selectionAsync(); }}
                      >
                        <Feather name={opt.icon as any} size={12} color={slMode === opt.key ? C.gold : C.textSecondary} />
                        <Text style={[styles.slModeLabel, slMode === opt.key && styles.slModeLabelActive]}>
                          {opt.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>

                  {slMode === "points" && (
                    <View style={styles.slInputArea}>
                      <StepInput value={slPips} onChange={setSlPips} step={5} min={5} max={500} decimals={0} />
                      <Text style={styles.slNote}>
                        {marketEntry > 0 && sl != null
                          ? `Entry ${formatPrice(marketEntry)} → SL ${formatPrice(sl)}  (${slPips} pips = ${(slPips * PIP_SIZE).toFixed(2)})`
                          : "Connect to see calculated SL"}
                      </Text>
                    </View>
                  )}

                  {slMode === "percent" && (
                    <View style={styles.slInputArea}>
                      <StepInput value={slPercent} onChange={setSlPercent} step={0.1} min={0.1} max={20} decimals={1} />
                      <Text style={styles.slNote}>
                        {marketEntry > 0 && sl != null
                          ? `Risk ${riskDollars.toFixed(2)} → SL ${formatPrice(sl)}`
                          : "Connect to calculate"}
                      </Text>
                    </View>
                  )}

                  {slMode === "manual" && (
                    <View style={styles.slInputArea}>
                      <TextInput
                        style={styles.manualInput}
                        placeholder="Enter exact SL price"
                        placeholderTextColor={C.textMuted}
                        keyboardType="decimal-pad"
                        value={slManualText}
                        onChangeText={(t) => {
                          setSlManualText(t);
                          const n = parseFloat(t);
                          if (!isNaN(n)) setSlManual(n);
                        }}
                      />
                      {sl != null && marketEntry > 0 && (
                        <Text style={styles.slNote}>
                          {`Distance: ${Math.abs(marketEntry - sl).toFixed(2)}  (${(Math.abs(marketEntry - sl) / PIP_SIZE).toFixed(0)} pips)`}
                        </Text>
                      )}
                    </View>
                  )}
                </>
              )}
            </View>

            {/* Risk Summary */}
            {status === "connected" && marketEntry > 0 && (
              <View style={styles.riskCard}>
                <View style={styles.riskRow}>
                  <Text style={styles.riskLabel}>Entry</Text>
                  <Text style={styles.riskValue}>{formatPrice(marketEntry)}</Text>
                </View>
                <View style={styles.riskRow}>
                  <Text style={styles.riskLabel}>Stop Loss</Text>
                  <Text style={[styles.riskValue, { color: C.sell }]}>
                    {effectiveDisplaySL != null ? formatPrice(effectiveDisplaySL) : "None"}
                    {sessionInRange ? <Text style={{ color: C.gold, fontSize: 11 }}> 🔒</Text> : null}
                  </Text>
                </View>
                <View style={styles.riskRow}>
                  <Text style={styles.riskLabel}>Est. Risk</Text>
                  <Text style={[styles.riskValue, { color: C.gold }]}>{riskDollars.toFixed(2)}</Text>
                </View>
                {accountInfo && (
                  <View style={styles.riskRow}>
                    <Text style={styles.riskLabel}>Balance</Text>
                    <Text style={styles.riskValue}>{formatPrice(accountInfo.balance)}</Text>
                  </View>
                )}
              </View>
            )}

            {/* Trade Button */}
            <Pressable
              style={({ pressed }) => [
                styles.tradeBtn,
                direction === "buy" ? styles.tradeBtnBuy : styles.tradeBtnSell,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                isPlacing && { opacity: 0.6 },
              ]}
              onPress={handleSingleTrade}
              disabled={isPlacing}
            >
              {isPlacing ? (
                <ActivityIndicator color={direction === "buy" ? "#000" : "#fff"} />
              ) : (
                <>
                  <Feather
                    name={direction === "buy" ? "trending-up" : "trending-down"}
                    size={20}
                    color={direction === "buy" ? "#000" : "#fff"}
                  />
                  <Text style={[styles.tradeBtnText, direction === "buy" ? { color: "#000" } : { color: "#fff" }]}>
                    {direction === "buy" ? "BUY XAUUSD" : "SELL XAUUSD"}
                  </Text>
                </>
              )}
            </Pressable>

            {/* Trade in MT5 Button */}
            <Pressable
              style={({ pressed }) => [
                styles.tradeBtn,
                {
                  backgroundColor: mt5MonitorSession ? "#1a2a40" : "#121a28",
                  borderWidth: 1,
                  borderColor: mt5MonitorSession ? "#4A90E2" : "#2a3a50",
                  marginTop: 8,
                },
                pressed && { opacity: 0.8 },
                mt5MonitorStarting && { opacity: 0.6 },
              ]}
              onPress={mt5MonitorSession
                ? () => {
                    void fetch(`${apiBase}/mt5/account/${accountId}/monitor`, { method: "DELETE" });
                    setMT5MonitorSession(null);
                    void Haptics.selectionAsync();
                  }
                : openMT5AndMonitor
              }
              disabled={mt5MonitorStarting}
            >
              {mt5MonitorStarting
                ? <ActivityIndicator size="small" color="#4A90E2" />
                : <Feather name={mt5MonitorSession ? "eye-off" : "external-link"} size={18} color="#4A90E2" />
              }
              <Text style={[styles.tradeBtnText, { color: "#4A90E2" }]}>
                {mt5MonitorStarting ? "Starting monitor…" : mt5MonitorSession ? "Stop MT5 Monitor" : "Trade in MT5 App"}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  symbol: { fontSize: 22, fontFamily: "Inter_700Bold", color: C.text, letterSpacing: 1 },
  liveDot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.surface,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.buy },
  liveLabel: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: C.buy, letterSpacing: 0.5 },
  scroll: { padding: 16, gap: 12 },
  stickyFooter: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.background,
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
  },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
  },
  priceLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: C.textSecondary, letterSpacing: 1 },
  priceValue: { fontSize: 26, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  priceSublabel: { fontSize: 10, fontFamily: "Inter_400Regular", color: C.textSecondary, textAlign: "right", marginTop: 1 },
  divider: { height: 1, backgroundColor: C.border },
  noPrice: { alignItems: "center", paddingVertical: 20, gap: 8 },
  noPriceText: { fontSize: 14, fontFamily: "Inter_400Regular", color: C.textMuted, textAlign: "center" },
  priceErrorBanner: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.border },
  priceErrorText: { fontSize: 12, fontFamily: "Inter_400Regular", color: C.sell, flex: 1 },
  toast: {
    position: "absolute", left: 16, right: 16, zIndex: 999,
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 14,
    borderRadius: 14, shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  toastText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff", flex: 1 },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 4,
    gap: 4,
  },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
  },
  modeBtnActive: { backgroundColor: "rgba(201,168,76,0.12)", borderWidth: 1, borderColor: C.gold },
  modeBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: C.textSecondary },
  modeBtnTextActive: { color: C.gold },
  directionRow: { flexDirection: "row", gap: 10 },
  dirBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: C.card,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  dirBtnBuyActive: { backgroundColor: C.buy, borderColor: C.buy },
  dirBtnSellActive: { backgroundColor: C.sell, borderColor: C.sell },
  dirLabel: { fontSize: 16, fontFamily: "Inter_700Bold", letterSpacing: 1.5 },
  dirLabelActiveBuy: { color: "#000" },
  dirLabelActiveSell: { color: "#fff" },
  sectionCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
    gap: 14,
  },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: C.textSecondary,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  sectionHint: { fontSize: 12, fontFamily: "Inter_500Medium", color: C.textSecondary },
  useMarketBtn: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: C.gold },
  priceInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.gold,
    paddingHorizontal: 16,
    height: 56,
    gap: 8,
  },
  priceInputCurrency: { fontSize: 20, fontFamily: "Inter_700Bold", color: C.textSecondary },
  priceInput: {
    flex: 1,
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: C.text,
    height: 56,
  },
  priceInputNote: { fontSize: 11, fontFamily: "Inter_400Regular", color: C.textMuted, lineHeight: 16 },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderRadius: 12,
    overflow: "hidden",
  },
  stepBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  stepInput: {
    flex: 1,
    height: 44,
    textAlign: "center",
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  slModeRow: { flexDirection: "row", gap: 8 },
  slModeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  slModeBtnActive: { borderColor: C.gold, backgroundColor: "rgba(201, 168, 76, 0.1)" },
  slModeLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: C.textSecondary },
  slModeLabelActive: { color: C.gold },
  slInputArea: { gap: 8 },
  slNote: { fontSize: 12, fontFamily: "Inter_400Regular", color: C.textSecondary, textAlign: "center" },
  manualInput: {
    backgroundColor: C.surface,
    borderRadius: 12,
    height: 44,
    paddingHorizontal: 16,
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
    textAlign: "center",
  },
  // Ladder
  ladder: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
    gap: 12,
  },
  ladderHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  ladderTitle: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: C.textSecondary, letterSpacing: 1, textTransform: "uppercase" },
  ladderRisk: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  ladderList: { gap: 6 },
  ladderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  ladderRowMarket: { borderWidth: 1, borderColor: C.gold + "55" },
  ladderDot: { width: 10, height: 10, borderRadius: 5 },
  ladderDotSL: { backgroundColor: C.sell },
  ladderLine: { width: 2, height: 18, backgroundColor: C.border, borderRadius: 1 },
  ladderEntry: { flex: 1, gap: 1 },
  ladderEntryLabel: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 0.8 },
  ladderEntryPrice: { fontSize: 16, fontFamily: "Inter_700Bold", color: C.text },
  ladderLot: { fontSize: 11, fontFamily: "Inter_500Medium", color: C.textMuted },
  liveEntryPrice: { fontSize: 28, fontFamily: "Inter_700Bold", marginTop: 4, marginBottom: 4 },
  cascadeHint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  cascadeHintText: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: C.textMuted, lineHeight: 18 },
  riskCard: {
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: C.border,
    gap: 10,
  },
  riskRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  riskLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: C.textSecondary },
  riskValue: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: C.text },
  tradeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 18,
    borderRadius: 16,
    marginTop: 4,
  },
  tradeBtnRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  tradeBtnHalf: { flex: 1, marginTop: 0 },
  tradeBtnBuy: { backgroundColor: C.buy },
  tradeBtnSell: { backgroundColor: C.sell },
  tradeBtnText: { fontSize: 17, fontFamily: "Inter_700Bold", letterSpacing: 1.5 },
});
