import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
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
  const { status, price, priceError, accountInfo, placeTrade, placeCascadeOrders, refreshPrice, connect, accountId, apiBase, region } = useTrading();
  const { settings: cascadeSettings } = useCascadeSettings();

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

  // Cascade state
  const [cascadeDirection, setCascadeDirection] = useState<Direction>("buy");
  const [cascadeLotSize, setCascadeLotSize] = useState(0.01);

  const [isPlacing, setIsPlacing] = useState(false);

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

  // Cascade levels — built from live market price (ask for buy, bid for sell)
  const cascadeMarketPrice = cascadeDirection === "buy" ? (price?.ask ?? 0) : (price?.bid ?? 0);
  const cascadeLevels = cascadeMarketPrice > 0
    ? buildCascadeLevels(cascadeMarketPrice, cascadeDirection, cascadeSettings)
    : null;

  const handleSingleTrade = useCallback(async () => {
    if (isPlacing) return;
    if (status !== "connected") {
      Alert.alert("Not Connected", "Please connect your MT5 account in Settings first.");
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsPlacing(true);
    const result = await placeTrade({ direction, volume: lotSize, stopLoss: sl });
    setIsPlacing(false);
    if (result.success) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showToast(`${direction.toUpperCase()} order placed ✓  ${lotSize} lot XAUUSD`, "success", true);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showToast(result.message, "error");
    }
  }, [isPlacing, status, direction, lotSize, sl, placeTrade, showToast]);

  const handleCascadeTrade = useCallback(async (dir: Direction) => {
    console.log("[cascade] btn pressed dir=" + dir + " isPlacing=" + String(isPlacing) + " status=" + status + " ask=" + String(price?.ask) + " bid=" + String(price?.bid));
    if (isPlacing) {
      Alert.alert("Please Wait", "An order is already being placed. Please wait for it to complete.");
      return;
    }
    if (status !== "connected") {
      Alert.alert("Not Connected", "Please connect your MT5 account in Settings first, then return here to trade.");
      return;
    }
    const mktPrice = dir === "buy" ? (price?.ask ?? 0) : (price?.bid ?? 0);
    if (!price || mktPrice <= 0) {
      Alert.alert("No Price Yet", "Waiting for a live price from your broker. Please wait a moment, then try again.\n\nTip: tap ↻ in the top-right to force a refresh.");
      return;
    }
    // Compute levels fresh — no stale closure dependency
    const levels = buildCascadeLevels(mktPrice, dir, cascadeSettings);
    const total = 1 + levels.limitEntries.length;
    const limitList = levels.limitEntries.map((p) => formatPrice(p)).join(", ");
    console.log("[cascade] showing confirm dialog mktPrice=" + String(mktPrice) + " levels=" + levels.limitEntries.join(",") + " sl=" + String(levels.stopLoss));
    Alert.alert(
      `Place ${total} ${dir.toUpperCase()} Orders`,
      `#1 Market @ ${formatPrice(mktPrice)}${levels.limitEntries.length > 0 ? `\nLimits: ${limitList}` : ""}\nStop Loss: ${formatPrice(levels.stopLoss)}\nLot per order: ${cascadeLotSize.toFixed(2)}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: async () => {
            console.log("[cascade] confirmed, placing dir=" + dir + " vol=" + String(cascadeLotSize) + " entries=[" + levels.limitEntries.join(",") + "] sl=" + String(levels.stopLoss));
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
            setIsPlacing(true);
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
              } else {
                await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                showToast(result.message, "error");
              }
            } catch (err) {
              console.log("[cascade] exception: " + String(err));
              showToast(err instanceof Error ? err.message : "Cascade failed", "error");
            } finally {
              setIsPlacing(false);
            }
          },
        },
      ]
    );
  }, [isPlacing, status, price, cascadeSettings, cascadeLotSize, placeCascadeOrders, showToast]);

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
