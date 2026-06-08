import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import type { Price } from "@/context/TradingContext";

const C = Colors.dark;

function formatPrice(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type LivePriceStripProps = {
  price: Price | null;
  priceError: boolean;
  priceStale: boolean;
  connected: boolean;
  onSync: () => void;
};

export default function LivePriceStrip({
  price,
  priceError,
  priceStale,
  connected,
  onSync,
}: LivePriceStripProps) {
  const prevBidRef = useRef<number | null>(null);
  const [tickDir, setTickDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const bid = price?.bid;
    if (bid == null || !(bid > 0)) return;
    const prev = prevBidRef.current;
    if (prev != null && bid !== prev) {
      setTickDir(bid > prev ? "up" : "down");
      const t = setTimeout(() => setTickDir(null), 180);
      prevBidRef.current = bid;
      return () => clearTimeout(t);
    }
    prevBidRef.current = bid;
  }, [price?.bid]);

  const live = connected && price != null && !priceError && !priceStale;
  const stale = connected && (priceError || priceStale || !price);

  return (
    <Pressable
      onPress={stale ? onSync : undefined}
      style={({ pressed }) => [
        styles.strip,
        tickDir === "up" && styles.stripTickUp,
        tickDir === "down" && styles.stripTickDown,
        pressed && stale && { opacity: 0.9 },
      ]}
      accessibilityLabel={
        live
          ? `XAUUSD live. Bid ${price ? formatPrice(price.bid) : ""}, ask ${price ? formatPrice(price.ask) : ""}`
          : "XAUUSD price stale. Tap to sync."
      }
    >
      <View style={styles.topRow}>
        <View style={styles.symbolRow}>
          <Text style={styles.symbol}>XAUUSD</Text>
          <View style={[styles.livePill, live ? styles.livePillOn : styles.livePillOff]}>
            <View style={[styles.liveDot, live ? styles.liveDotOn : styles.liveDotOff]} />
            <Text style={[styles.liveText, live ? styles.liveTextOn : styles.liveTextOff]}>
              {live ? "LIVE" : stale ? "STALE" : "—"}
            </Text>
          </View>
        </View>
        {price ? (
          <Text style={styles.spread}>{price.spread} pip spread</Text>
        ) : (
          <ActivityIndicator size="small" color={C.gold} />
        )}
      </View>

      {price ? (
        <View style={styles.quoteRow}>
          <View style={styles.quoteCol}>
            <Text style={styles.quoteLabel}>BID</Text>
            <Text style={[styles.quoteValue, { color: C.sell }, tickDir === "down" && styles.quoteFlash]}>
              {formatPrice(price.bid)}
            </Text>
            <Text style={styles.quoteHint}>Sell at</Text>
          </View>
          <View style={styles.quoteDivider} />
          <View style={[styles.quoteCol, styles.quoteColRight]}>
            <Text style={styles.quoteLabel}>ASK</Text>
            <Text style={[styles.quoteValue, { color: C.buy }, tickDir === "up" && styles.quoteFlash]}>
              {formatPrice(price.ask)}
            </Text>
            <Text style={styles.quoteHint}>Buy at</Text>
          </View>
        </View>
      ) : (
        <View style={styles.waitingRow}>
          <Feather name="activity" size={14} color={C.onDarkMuted} />
          <Text style={styles.waitingText}>
            {connected ? "Fetching live price…" : "Connect MT5 for live price"}
          </Text>
          {stale && (
            <Text style={styles.tapSync}>Tap to sync</Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const styles = StyleSheet.create({
  strip: {
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: C.navy,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  stripTickUp: {
    borderColor: "rgba(11,173,107,0.45)",
  },
  stripTickDown: {
    borderColor: "rgba(224,52,80,0.45)",
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  symbolRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  symbol: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.onDark,
    letterSpacing: 0.6,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  livePillOn: {
    backgroundColor: "rgba(11,173,107,0.18)",
  },
  livePillOff: {
    backgroundColor: "rgba(224,52,80,0.15)",
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  liveDotOn: {
    backgroundColor: C.buy,
  },
  liveDotOff: {
    backgroundColor: C.sell,
  },
  liveText: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
  },
  liveTextOn: {
    color: C.buy,
  },
  liveTextOff: {
    color: C.sell,
  },
  spread: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    color: C.onDarkMuted,
  },
  quoteRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  quoteCol: {
    flex: 1,
    gap: 2,
  },
  quoteColRight: {
    alignItems: "flex-end",
  },
  quoteDivider: {
    width: 1,
    backgroundColor: "rgba(255,255,255,0.12)",
    marginHorizontal: 12,
  },
  quoteLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: C.onDarkMuted,
    letterSpacing: 1.1,
  },
  quoteValue: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.3,
    ...(Platform.OS === "android" ? { fontFamily: mono } : {}),
  },
  quoteFlash: {
    textShadowColor: "rgba(255,255,255,0.35)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  quoteHint: {
    fontSize: 9,
    fontFamily: "Inter_400Regular",
    color: C.onDarkMuted,
  },
  waitingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
  },
  waitingText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.onDarkMuted,
  },
  tapSync: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: C.gold,
  },
});
