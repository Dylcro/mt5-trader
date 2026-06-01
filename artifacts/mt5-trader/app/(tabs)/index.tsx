import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
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

import AsyncStorage from "@react-native-async-storage/async-storage";

import { useTrading, type SLMode } from "@/context/TradingContext";
import { buildCascadeLevels, useCascadeSettings } from "@/hooks/useCascadeSettings";
import { useDisplayCurrency } from "@/hooks/useDisplayCurrency";
import { usePlatformStatus } from "@/hooks/usePlatformStatus";

const LOT_SIZE_SINGLE_KEY = "lot_size_single";
const LOT_SIZE_CASCADE_KEY = "lot_size_cascade";

const C = Colors.dark;

type SyncUiVariant = "ready" | "sync" | "wait" | "connect";

/** Single source of truth for the header sync button and the XAUUSD status chip. */
function resolveSyncUi(
  status: "connected" | "connecting" | "disconnected" | string,
  syncReady: boolean,
  connectionWarm: boolean,
  hasPrice: boolean,
  priceError: boolean,
): { variant: SyncUiVariant; actionLabel: string; statusLabel: string } {
  if (status === "disconnected") {
    return { variant: "connect", actionLabel: "Connect MT5", statusLabel: "OFFLINE" };
  }
  if (status === "connecting") {
    return { variant: "wait", actionLabel: "Connecting…", statusLabel: "CONNECTING" };
  }
  if (status === "connected" && !connectionWarm) {
    return { variant: "wait", actionLabel: "Syncing…", statusLabel: "SYNCING" };
  }
  if (status === "connected" && !hasPrice) {
    return { variant: "wait", actionLabel: "Syncing…", statusLabel: "FETCHING" };
  }
  if (priceError) {
    return { variant: "sync", actionLabel: "Tap to sync", statusLabel: "STALE" };
  }
  if (syncReady) {
    return { variant: "ready", actionLabel: "Ready to trade", statusLabel: "LIVE" };
  }
  return { variant: "sync", actionLabel: "Tap to sync", statusLabel: "NEEDS SYNC" };
}

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
  onDark,
}: {
  label: string;
  value: string;
  color: string;
  sublabel?: string;
  onDark?: boolean;
}) {
  return (
    <View style={styles.priceRow}>
      <Text style={[styles.priceLabel, onDark && styles.priceLabelOnDark]}>{label}</Text>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[styles.priceValue, { color }]}>{value}</Text>
        {sublabel ? (
          <Text style={[styles.priceSublabel, onDark && styles.priceSublabelOnDark]}>{sublabel}</Text>
        ) : null}
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
  const { status, price, priceError, accountInfo, placeTrade, placeCascadeOrders, connect, accountId, apiBase, region, cancelOrder, pendingOrders, refreshPendingOrders, positions, closePosition, connectionWarm, syncSession } = useTrading();

  const syncReady =
    status === "connected" &&
    connectionWarm &&
    price != null &&
    !priceError;

  const syncUi = resolveSyncUi(status, syncReady, connectionWarm, price != null, priceError);

  const handleHeaderSync = useCallback(() => {
    if (status === "disconnected") void connect();
    else void syncSession(true);
  }, [status, connect, syncSession]);
  const { formatMoney } = useDisplayCurrency();
  const { status: platformStatus } = usePlatformStatus();
  const platformRef = useRef(platformStatus);
  useEffect(() => { platformRef.current = platformStatus; }, [platformStatus]);
  const { settings: cascadeSettings } = useCascadeSettings();
  const cascadeSettingsRef = useRef(cascadeSettings);
  useEffect(() => { cascadeSettingsRef.current = cascadeSettings; }, [cascadeSettings]);

  // Refs for rapidly-changing values so trade callbacks are stable (never recreate on price ticks)
  const priceRef = useRef(price);
  useEffect(() => { priceRef.current = price; }, [price]);
  const isPlacingRef = useRef(false);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  const cancelOrderRef = useRef(cancelOrder);
  useEffect(() => { cancelOrderRef.current = cancelOrder; }, [cancelOrder]);
  const accountIdRef = useRef(accountId);
  useEffect(() => { accountIdRef.current = accountId; }, [accountId]);
  const apiBaseRef = useRef(apiBase);
  useEffect(() => { apiBaseRef.current = apiBase; }, [apiBase]);
  const regionRef = useRef(region);
  useEffect(() => { regionRef.current = region; }, [region]);

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
  const [lotSize, setLotSizeRaw] = useState(0.01);
  const setLotSize = useCallback((v: number) => {
    setLotSizeRaw(v);
    void AsyncStorage.setItem(LOT_SIZE_SINGLE_KEY, String(v));
  }, []);
  const [slMode, setSlMode] = useState<SLMode>("points");
  const [slPips, setSlPips] = useState(50);
  const [slPercent, setSlPercent] = useState(1);
  const [slManual, setSlManual] = useState(0);
  const [slManualText, setSlManualText] = useState("");

  // Cascade state
  const [cascadeDirection, setCascadeDirection] = useState<Direction>("buy");
  const [cascadeLotSize, setCascadeLotSizeRaw] = useState(0.04);
  const setCascadeLotSize = useCallback((v: number) => {
    setCascadeLotSizeRaw(v);
    void AsyncStorage.setItem(LOT_SIZE_CASCADE_KEY, String(v));
  }, []);

  // Zone TPs are configured globally in Settings as pip distances. At submit
  // time we convert them to absolute prices from the live market entry.
  // tp4Pips = 0 means "leave the final 25% open / manual close".
  const tpPipsValid =
    cascadeSettings.tp1Pips > 0 &&
    cascadeSettings.tp2Pips > cascadeSettings.tp1Pips &&
    cascadeSettings.tp3Pips > cascadeSettings.tp2Pips &&
    (cascadeSettings.tp4Pips === 0 || cascadeSettings.tp4Pips > cascadeSettings.tp3Pips);

  const [isPlacing, setIsPlacing] = useState(false);

  // Visible watcher state — mirrors tpWatchersRef so the UI can show what's armed
  const [armedWatchers, setArmedWatchers] = useState<Array<{ id: string; trigger: number; dir: Direction; pips: number }>>([]);

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

  // Load persisted lot sizes from AsyncStorage. Also runs on tab focus so that
  // values set in the Settings tab are picked up without a full app restart.
  const loadLotSizes = useCallback(() => {
    AsyncStorage.getMany([LOT_SIZE_SINGLE_KEY, LOT_SIZE_CASCADE_KEY]).then((record) => {
      const single = record[LOT_SIZE_SINGLE_KEY];
      const cascade = record[LOT_SIZE_CASCADE_KEY];
      if (single) setLotSizeRaw(parseFloat(single));
      if (cascade) {
        const parsed = parseFloat(cascade);
        const safe = Number.isFinite(parsed) && parsed >= 0.01 ? parsed : 0.01;
        setCascadeLotSizeRaw(safe);
        if (safe !== parsed) void AsyncStorage.setItem(LOT_SIZE_CASCADE_KEY, String(safe));
      }
    });
  }, []);
  useEffect(loadLotSizes, [loadLotSizes]);
  useFocusEffect(loadLotSizes);

  useFocusEffect(
    useCallback(() => {
      if (status !== "connected") return;
      void syncSession();
      const id = setInterval(() => void syncSession(), 10_000);
      return () => clearInterval(id);
    }, [status, syncSession]),
  );

  const tpWatchersRef = useRef<WatcherEntry[]>([]); // take-profit queue

  useEffect(() => {
    if (!price) return;
    const now = Date.now();

    // — Limit-cancel queue —
    const firedTpIds = new Set<string>();
    for (const tp of tpWatchersRef.current) {
      if (now < tp.readyAt) continue;
      const dist = tp.pipsTarget * 0.10;
      const hit = tp.direction === "buy" ? price.bid >= tp.entryPrice + dist : price.bid <= tp.entryPrice - dist;
      if (!hit) continue;
      firedTpIds.add(tp.id);

      const actualPips = ((tp.direction === "buy" ? price.bid - tp.entryPrice : tp.entryPrice - price.bid) / 0.10).toFixed(1);
      console.log(`[tp-watcher id=${tp.id}] FIRE dir=${tp.direction} target=+${tp.pipsTarget}pip actual=+${actualPips}pip bid=${price.bid} entry=${tp.entryPrice}`);

      // Capture watcher snapshot so async work below has a stable reference
      const snapshot = { ...tp };

      void (async () => {
        try {
          const accId = accountIdRef.current;
          const base = apiBaseRef.current;
          const rgn = regionRef.current;

          // Fetch ALL fresh pending orders and cancel every limit of matching direction.
          // This is the most reliable approach — avoids fragile ID/price matching
          // that can fail when REST placement doesn't echo back orderId or broker
          // normalises prices.
          const expectedType = snapshot.direction === "buy" ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_SELL_LIMIT";
          const idSet = new Set<string>();

          if (accId && base) {
            try {
              const res = await fetch(`${base}/mt5/account/${accId}/orders?region=${rgn}`);
              if (res.ok) {
                const raw = await res.json();
                const freshOrders: Array<Record<string, unknown>> = Array.isArray(raw)
                  ? raw as Array<Record<string, unknown>>
                  : Array.isArray((raw as Record<string, unknown>).orders)
                    ? (raw as { orders: Array<Record<string, unknown>> }).orders
                    : [];

                for (const ord of freshOrders) {
                  const ordId = String(ord.id ?? ord.orderId ?? "");
                  const ordType = String(ord.type ?? "");
                  if (!ordId) continue;
                  // Cancel all pending limits of matching direction
                  if (ordType === expectedType || (ordType.includes("LIMIT") && ordType.includes(snapshot.direction === "buy" ? "BUY" : "SELL"))) {
                    idSet.add(ordId);
                  }
                }
                console.log(`[tp-watcher id=${snapshot.id}] fresh fetch: ${freshOrders.length} total orders, ${idSet.size} ${expectedType} to cancel`);
              } else {
                console.log(`[tp-watcher id=${snapshot.id}] orders fetch failed: ${res.status}`);
              }
            } catch (fetchErr) {
              console.log(`[tp-watcher id=${snapshot.id}] orders fetch error: ${String(fetchErr)}`);
            }
          }

          const ordersToCancel = Array.from(idSet);
          console.log(`[tp-watcher id=${snapshot.id}] cancelling ids: ${ordersToCancel.join(",")}`);

          let cancelled = 0;
          let failed = 0;
          if (ordersToCancel.length > 0 && accId && base) {
            // Cancel directly via fetch — no TradingContext status guard
            const results = await Promise.all(
              ordersToCancel.map(async (ordId) => {
                try {
                  const r = await fetch(
                    `${base}/mt5/account/${accId}/order/${ordId}?region=${rgn}`,
                    { method: "DELETE" }
                  );
                  const d = await r.json() as { success?: boolean; message?: string };
                  console.log(`[tp-watcher] cancel ordId=${ordId} ok=${String(r.ok)} success=${String(d.success)} msg=${d.message ?? ""}`);
                  return d.success !== false && r.ok;
                } catch (e) {
                  console.log(`[tp-watcher] cancel ordId=${ordId} error: ${String(e)}`);
                  return false;
                }
              })
            );
            cancelled = results.filter(Boolean).length;
            failed = results.length - cancelled;
            void refreshPendingOrders();
          }

          void Haptics.notificationAsync(
            cancelled > 0 ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
          );
          if (ordersToCancel.length === 0) {
            showToast(`+${actualPips}pip reached — no pending limits found`, "error");
          } else if (failed === 0) {
            showToast(`+${actualPips}pip — ${cancelled} limit${cancelled !== 1 ? "s" : ""} cancelled`, "success", true);
          } else {
            showToast(`+${actualPips}pip — ${cancelled} cancelled, ${failed} failed`, cancelled > 0 ? "success" : "error");
          }
        } catch (err) {
          console.log(`[tp-watcher id=${snapshot.id}] unexpected error: ${String(err)}`);
          showToast(`Limit cancel error: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
      })();
    }
    if (firedTpIds.size > 0) {
      tpWatchersRef.current = tpWatchersRef.current.filter((tp) => !firedTpIds.has(tp.id));
      setArmedWatchers((prev) => prev.filter((w) => !firedTpIds.has(w.id)));
    }
  }, [price, showToast, refreshPendingOrders]);

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

  const handleSingleTrade = useCallback(async (dir?: Direction) => {
    const resolvedDir = dir ?? direction;
    console.log("[single] btn pressed dir=" + resolvedDir + " isPlacing=" + String(isPlacingRef.current) + " status=" + statusRef.current + " lot=" + String(lotSize));
    if (isPlacingRef.current) return;
    if (statusRef.current !== "connected") {
      Alert.alert("Not Connected", "Please connect your MT5 account in Settings first.");
      return;
    }
    if (!platformRef.current.trading_enabled) {
      Alert.alert("Trading paused", platformRef.current.message || "Trading is temporarily paused.");
      return;
    }
    // Lock button and fire haptics simultaneously — don't await haptics before locking
    isPlacingRef.current = true;
    setIsPlacing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (dir) setDirection(dir);
    try {
      const result = await placeTrade({ direction: resolvedDir, volume: lotSize, stopLoss: slRef.current });
      if (result.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast(`${resolvedDir.toUpperCase()} order placed ✓  ${lotSize} lot XAUUSD`, "success", true);
      } else {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showToast(result.message, "error");
      }
    } catch (err) {
      // Guarantees button unlocks even if placeTrade throws unexpectedly —
      // otherwise the button silently appears dead until the app restarts.
      console.log("[single] exception: " + String(err));
      showToast(err instanceof Error ? err.message : "Trade failed", "error");
    } finally {
      isPlacingRef.current = false;
      setIsPlacing(false);
    }
  }, [direction, lotSize, placeTrade, showToast]);

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
    if (!platformRef.current.trading_enabled) {
      Alert.alert("Trading paused", platformRef.current.message || "Trading is temporarily paused.");
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
      // Read current pip distances from Settings and convert to absolute prices
      // based on the live cascade entry. tp4Pips = 0 → leave the last 25% open.
      const { tp1Pips, tp2Pips, tp3Pips, tp4Pips } = cs;
      const pipsOk =
        tp1Pips > 0 && tp2Pips > tp1Pips && tp3Pips > tp2Pips &&
        (tp4Pips === 0 || tp4Pips > tp3Pips);
      if (!pipsOk) {
        isPlacingRef.current = false;
        setIsPlacing(false);
        Alert.alert("Invalid TP Settings", "Open Settings → Zone Take Profit and make sure TP1 < TP2 < TP3 (and TP4 if used).");
        return;
      }
      if (cascadeLotSize < 0.01) {
        isPlacingRef.current = false;
        setIsPlacing(false);
        Alert.alert("Lot Too Small", "Minimum cascade lot size is 0.01 (broker minimum).");
        return;
      }
      const PIP = 0.10;
      const sign = dir === "buy" ? 1 : -1;
      const round2 = (v: number) => parseFloat(v.toFixed(2));
      const tp1Price = round2(mktPrice + sign * tp1Pips * PIP);
      const tp2Price = round2(mktPrice + sign * tp2Pips * PIP);
      const tp3Price = round2(mktPrice + sign * tp3Pips * PIP);
      const tp4Price = tp4Pips > 0 ? round2(mktPrice + sign * tp4Pips * PIP) : undefined;
      const result = await placeCascadeOrders({
        direction: dir,
        volume: cascadeLotSize,
        limitEntries: levels.limitEntries,
        stopLoss: levels.stopLoss,
        tp1Price, tp2Price, tp3Price, tp4Price,
        anchorPrice: mktPrice,
        tp1Pct: cs.tp1Enabled ? cs.tp1Pct : 0,
        tp2Pct: cs.tp2Enabled ? cs.tp2Pct : 0,
        tp3Pct: cs.tp3Enabled ? cs.tp3Pct : 0,
        tp4Pct: cs.tp4Enabled ? cs.tp4Pct : 0,
        autoBeAtTp: cs.autoBeAtTp,
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
          setArmedWatchers((prev) => [...prev, { id: cascadeId, trigger: tpTrigger, dir, pips: cs.takeProfitPips }]);
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
            onPress={() => void handleHeaderSync()}
            hitSlop={8}
            accessibilityLabel={`${syncUi.statusLabel}. ${syncUi.actionLabel}`}
            style={({ pressed }) => [
              styles.liveDot,
              syncUi.variant === "ready" && styles.liveDotReady,
              syncUi.variant === "sync" && styles.liveDotSync,
              syncUi.variant === "wait" && styles.liveDotWait,
              syncUi.variant === "connect" && styles.liveDotConnect,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Animated.View
              style={[
                styles.dot,
                {
                  opacity: syncUi.variant === "ready" ? blinkAnim : 0.9,
                  backgroundColor:
                    syncUi.variant === "ready"
                      ? C.buy
                      : syncUi.variant === "wait"
                        ? C.gold
                        : C.sell,
                },
              ]}
            />
            <Text
              style={[
                styles.liveLabel,
                syncUi.variant === "ready" && { color: C.buy },
                syncUi.variant === "wait" && { color: C.gold },
                (syncUi.variant === "sync" || syncUi.variant === "connect") && { color: C.sell },
              ]}
            >
              {syncUi.statusLabel}
            </Text>
          </Pressable>
        </View>
        <Pressable
          onPress={() => void handleHeaderSync()}
          hitSlop={8}
          accessibilityLabel={`${syncUi.actionLabel}. Refreshes broker connection and live price.`}
          style={({ pressed }) => [
            styles.headerSyncPill,
            syncUi.variant === "ready" && styles.headerSyncPillReady,
            syncUi.variant === "sync" && styles.headerSyncPillSync,
            syncUi.variant === "wait" && styles.headerSyncPillWait,
            syncUi.variant === "connect" && styles.headerSyncPillConnect,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
        >
          {syncUi.variant === "wait" ? (
            <ActivityIndicator size="small" color={C.gold} />
          ) : syncUi.variant === "ready" ? (
            <Feather name="check-circle" size={18} color={C.buy} />
          ) : (
            <Feather name="refresh-cw" size={16} color={C.sell} />
          )}
          <Text
            style={[
              styles.headerSyncPillText,
              syncUi.variant === "ready" && { color: C.buy },
              (syncUi.variant === "sync" || syncUi.variant === "connect") && { color: C.sell },
              syncUi.variant === "wait" && { color: C.gold },
            ]}
          >
            {syncUi.actionLabel}
          </Text>
        </Pressable>
      </View>


      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
        keyboardShouldPersistTaps="handled"
      >
        {!platformStatus.trading_enabled ? (
          <View style={styles.advisoryBanner}>
            <Feather name="pause-circle" size={16} color={C.sell} />
            <Text style={styles.advisoryText}>
              {platformStatus.message || "Trading is temporarily paused."}
            </Text>
          </View>
        ) : null}
        {/* Price Card — navy hero */}
        <View style={[styles.card, styles.navyPriceCard]}>
          {price ? (
            <>
              <PriceRow label="BID" value={formatPrice(price.bid)} color={C.sell} sublabel="Sell at" onDark />
              <View style={[styles.divider, styles.dividerOnDark]} />
              <PriceRow label="ASK" value={formatPrice(price.ask)} color={C.buy} sublabel="Buy at" onDark />
              <View style={[styles.divider, styles.dividerOnDark]} />
              <PriceRow label="SPREAD" value={`${price.spread} pips`} color={C.onDarkMuted} onDark />
              {priceError && (
                <View style={styles.priceErrorBanner}>
                  <Feather name="wifi-off" size={12} color={C.sell} />
                  <Text style={styles.priceErrorText}>
                    Price feed interrupted — tap Tap to sync at the top right
                  </Text>
                </View>
              )}
            </>
          ) : (
            <View style={styles.noPrice}>
              <MaterialCommunityIcons name="chart-line" size={28} color={C.textMuted} />
              <Text style={styles.noPriceText}>
                {priceError
                  ? "Price feed failed — tap Tap to sync at the top right"
                  : status === "connecting"
                    ? "Fetching price..."
                    : "Connect account to see live price"}
              </Text>
            </View>
          )}
        </View>

        {/* BUY / SELL — always visible, above mode toggle */}
        {(() => {
          const tradeBlocked = status !== "connected" || !price;
          return (
            <View style={styles.cascadeExecRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.cascadeExecBtn,
                  styles.cascadeExecBtnBuy,
                  tradeBlocked && !isPlacing && { opacity: 0.5 },
                  pressed && { opacity: 0.8, transform: [{ scale: 0.97 }] },
                  isPlacing && { opacity: 0.6 },
                ]}
                onPress={() => {
                  if (tradeMode === "cascade") {
                    setCascadeDirection("buy");
                    void handleCascadeTrade("buy");
                  } else {
                    void handleSingleTrade("buy");
                  }
                }}
                disabled={isPlacing}
              >
                {isPlacing && (tradeMode === "cascade" ? cascadeDirection === "buy" : direction === "buy") ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <>
                    <Feather name="trending-up" size={20} color="#000" />
                    <Text style={[styles.cascadeExecLabel, { color: "#000" }]}>BUY</Text>
                    {price && (
                      <Text style={[styles.cascadeExecPrice, { color: "#000" }]}>
                        {formatPrice(price.ask)}
                      </Text>
                    )}
                  </>
                )}
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.cascadeExecBtn,
                  styles.cascadeExecBtnSell,
                  tradeBlocked && !isPlacing && { opacity: 0.5 },
                  pressed && { opacity: 0.8, transform: [{ scale: 0.97 }] },
                  isPlacing && { opacity: 0.6 },
                ]}
                onPress={() => {
                  if (tradeMode === "cascade") {
                    setCascadeDirection("sell");
                    void handleCascadeTrade("sell");
                  } else {
                    void handleSingleTrade("sell");
                  }
                }}
                disabled={isPlacing}
              >
                {isPlacing && (tradeMode === "cascade" ? cascadeDirection === "sell" : direction === "sell") ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Feather name="trending-down" size={20} color="#fff" />
                    <Text style={[styles.cascadeExecLabel, { color: "#fff" }]}>SELL</Text>
                    {price && (
                      <Text style={[styles.cascadeExecPrice, { color: "#fff" }]}>
                        {formatPrice(price.bid)}
                      </Text>
                    )}
                  </>
                )}
              </Pressable>
            </View>
          );
        })()}

        {status === "connecting" && (
          <Text style={styles.cascadeStatusHint}>
            Connecting to MT5… buy/sell unlock when price appears
          </Text>
        )}
        {status === "connected" && !price && (
          <Text style={styles.cascadeStatusHint}>
            Fetching live price…
          </Text>
        )}
        {status === "connected" && !syncReady && (
          <Text style={styles.cascadeStatusHint}>
            After a break, use Tap to sync (top right) — turns green when Ready to trade
          </Text>
        )}
        {status !== "connected" && status !== "connecting" && (
          <Text style={styles.cascadeStatusHint}>
            Connect your MT5 account in Settings to trade
          </Text>
        )}

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
            {/* Cascade summary strip — orders / spacing / SL at a glance */}
            <View style={styles.cascadeSummaryRow}>
              <View style={styles.cascadeSummaryItem}>
                <Text style={styles.cascadeSummaryValue}>{cascadeSettings.numPositions}</Text>
                <Text style={styles.cascadeSummaryLabel}>ORDERS</Text>
              </View>
              <View style={styles.cascadeSummaryDivider} />
              <View style={styles.cascadeSummaryItem}>
                <Text style={styles.cascadeSummaryValue}>{cascadeSettings.pipsBetween}</Text>
                <Text style={styles.cascadeSummaryLabel}>PIP STEP</Text>
              </View>
              <View style={styles.cascadeSummaryDivider} />
              <View style={styles.cascadeSummaryItem}>
                <Text style={[styles.cascadeSummaryValue, { color: C.sell }]}>{cascadeSettings.slPips}</Text>
                <Text style={styles.cascadeSummaryLabel}>SL PIPS</Text>
              </View>
              <View style={styles.cascadeSummaryDivider} />
              <View style={styles.cascadeSummaryItem}>
                <Text style={styles.cascadeSummaryValue}>
                  {cascadeLevels ? formatPrice(cascadeLevels.stopLoss) : "—"}
                </Text>
                <Text style={[styles.cascadeSummaryLabel, { color: C.sell }]}>SL PRICE</Text>
              </View>
            </View>

            {/* Lot Size */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Lot Size (per order)</Text>
                <Text style={styles.sectionHint}>1 lot = 100 oz gold</Text>
              </View>
              <StepInput value={cascadeLotSize} onChange={setCascadeLotSize} step={0.01} min={0.01} max={100} decimals={2} />
            </View>

            {/* Zone TP summary — sourced from Settings. Read-only here. */}
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Zone Take Profits</Text>
                <Text style={styles.sectionHint}>From Settings</Text>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                <View style={{ flex: 1, minWidth: 120 }}>
                  <Text style={[styles.cascadeSummaryLabel, { marginBottom: 4 }]}>TP1</Text>
                  <Text style={styles.cascadeSummaryValue}>{cascadeSettings.tp1Pips} pips</Text>
                </View>
                <View style={{ flex: 1, minWidth: 120 }}>
                  <Text style={[styles.cascadeSummaryLabel, { marginBottom: 4 }]}>TP2</Text>
                  <Text style={styles.cascadeSummaryValue}>{cascadeSettings.tp2Pips} pips</Text>
                </View>
                <View style={{ flex: 1, minWidth: 120 }}>
                  <Text style={[styles.cascadeSummaryLabel, { marginBottom: 4 }]}>TP3</Text>
                  <Text style={styles.cascadeSummaryValue}>{cascadeSettings.tp3Pips} pips</Text>
                </View>
                <View style={{ flex: 1, minWidth: 120 }}>
                  <Text style={[styles.cascadeSummaryLabel, { marginBottom: 4 }]}>TP4</Text>
                  <Text style={styles.cascadeSummaryValue}>
                    {cascadeSettings.tp4Pips > 0 ? `${cascadeSettings.tp4Pips} pips` : "Open"}
                  </Text>
                </View>
              </View>
              {!tpPipsValid && (
                <Text style={[styles.sectionHint, { color: C.sell, marginTop: 8 }]}>
                  TP pip levels must be strictly increasing (TP1 &lt; TP2 &lt; TP3, TP4 either 0 or &gt; TP3). Fix in Settings.
                </Text>
              )}
              {cascadeLotSize < 0.04 && cascadeLotSize >= 0.01 && (
                <Text style={[styles.sectionHint, { color: C.textMuted, marginTop: 6 }]}>
                  Small lot mode: {cascadeLotSize === 0.01 ? "full close at TP1" : cascadeLotSize === 0.02 ? "0.01 at TP1, remainder at TP2" : cascadeLotSize === 0.03 ? "0.01 at each of TP1 → TP3" : `${(cascadeLotSize * 0.25).toFixed(2)} lots per TP`}. Use 0.04+ for the standard 25% system.
                </Text>
              )}
            </View>

            {/* Cascade Ladder Preview — updates direction based on last button pressed */}
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

            {/* Armed watcher badge — confirms the limit-cancel watcher is active */}
            {armedWatchers.map((w) => (
              <View key={w.id} style={styles.watcherBadge}>
                <Feather name="clock" size={12} color={C.gold} />
                <Text style={styles.watcherBadgeText}>
                  {`Cancel limits armed · ${w.dir.toUpperCase()} +${w.pips}pip · trigger @ ${formatPrice(w.trigger)}`}
                </Text>
                {price && (
                  <Text style={[styles.watcherBadgeText, { color: C.textSecondary }]}>
                    {`(bid ${formatPrice(price.bid)})`}
                  </Text>
                )}
              </View>
            ))}
          </>
        )}

        {/* ═══ SINGLE MODE ════════════════════════════════════════════════════ */}
        {tradeMode === "single" && (
          <>
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
                  {sl != null ? `SL: ${formatPrice(sl)}` : "No SL set"}
                </Text>
              </View>
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
                      ? `Risk ${formatMoney(riskDollars)} → SL ${formatPrice(sl)}`
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
                    {sl != null ? formatPrice(sl) : "None"}
                  </Text>
                </View>
                <View style={styles.riskRow}>
                  <Text style={styles.riskLabel}>Est. Risk</Text>
                  <Text style={[styles.riskValue, { color: C.gold }]}>{formatMoney(riskDollars)}</Text>
                </View>
                {accountInfo && (
                  <View style={styles.riskRow}>
                    <Text style={styles.riskLabel}>Balance</Text>
                    <Text style={styles.riskValue}>{formatMoney(accountInfo.balance)}</Text>
                  </View>
                )}
              </View>
            )}

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
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  liveDotReady: {
    backgroundColor: C.buyDim,
    borderColor: C.buy,
  },
  liveDotSync: {
    backgroundColor: C.sellDim,
    borderColor: C.sell,
  },
  liveDotWait: {
    backgroundColor: C.goldLight,
    borderColor: C.goldBorder,
  },
  liveDotConnect: {
    backgroundColor: C.sellDim,
    borderColor: C.sell,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.buy },
  liveLabel: { fontSize: 10, fontFamily: "Inter_700Bold", color: C.buy, letterSpacing: 0.6 },
  headerSyncPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    maxWidth: 148,
  },
  headerSyncPillReady: {
    backgroundColor: C.buyDim,
    borderColor: C.buy,
  },
  headerSyncPillSync: {
    backgroundColor: C.sellDim,
    borderColor: C.sell,
  },
  headerSyncPillWait: {
    backgroundColor: C.goldLight,
    borderColor: C.goldBorder,
  },
  headerSyncPillConnect: {
    backgroundColor: C.sellDim,
    borderColor: C.sell,
  },
  headerSyncPillText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.3,
    flexShrink: 1,
  },
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
  navyPriceCard: {
    backgroundColor: C.navy,
    borderColor: C.navy,
  },
  priceLabelOnDark: { color: C.onDarkMuted },
  priceSublabelOnDark: { color: C.onDarkMuted },
  dividerOnDark: { backgroundColor: "rgba(255,255,255,0.15)" },
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
  advisoryBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(201,168,76,0.08)",
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.35)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  advisoryText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  advisoryTextBold: {
    fontFamily: "Inter_600SemiBold",
    color: C.gold,
  },
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
  cascadeSummaryRow: {
    flexDirection: "row",
    backgroundColor: C.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "space-around",
  },
  cascadeSummaryItem: { alignItems: "center", flex: 1 },
  cascadeSummaryValue: { fontSize: 15, fontFamily: "Inter_700Bold", color: C.text },
  cascadeSummaryLabel: { fontSize: 10, fontFamily: "Inter_400Regular", color: C.textMuted, marginTop: 2, letterSpacing: 0.5 },
  cascadeSummaryDivider: { width: 1, height: 28, backgroundColor: C.border },
  cascadeExecRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  cascadeExecBtn: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 18,
    borderRadius: 16,
  },
  cascadeExecBtnBuy: { backgroundColor: C.buy },
  cascadeExecBtnSell: { backgroundColor: C.sell },
  cascadeExecLabel: { fontSize: 18, fontFamily: "Inter_700Bold", letterSpacing: 1.5 },
  cascadeExecPrice: { fontSize: 12, fontFamily: "Inter_400Regular", opacity: 0.75 },
  cascadeStatusHint: {
    textAlign: "center",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 8,
  },
  watcherBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "rgba(212,175,55,0.1)",
    borderWidth: 1,
    borderColor: "rgba(212,175,55,0.35)",
    flexWrap: "wrap",
  },
  watcherBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.gold,
    flexShrink: 1,
  },
});
