import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";
import { useZones, type Zone } from "@/hooks/useZones";

const C = Colors.dark;

function formatDate(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function HistoryRow({ zone }: { zone: Zone }) {
  const isBuy = zone.direction === "buy";
  const tpLabel = zone.finalTpReached ? `TP${zone.finalTpReached}` : "—";
  return (
    <View style={styles.row}>
      <View style={[styles.dirBadge, isBuy ? styles.dirBuy : styles.dirSell]}>
        <Text style={[styles.dirText, isBuy ? styles.dirTextBuy : styles.dirTextSell]}>
          {isBuy ? "BUY" : "SELL"}
        </Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>Zone {zone.zoneId.slice(0, 8)}…</Text>
        <Text style={styles.rowMeta}>
          Entry {zone.anchorPrice.toFixed(2)} · Final {tpLabel}
        </Text>
        <Text style={styles.rowTime}>
          {zone.closedAt ? formatDate(zone.closedAt) : formatDate(zone.createdAt)}
        </Text>
      </View>
      <Feather name="check-circle" size={20} color={C.textMuted} />
    </View>
  );
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const { accountId } = useTrading();
  const { zones, loading, error, refresh } = useZones(accountId, {
    includeClosed: true,
    pollIntervalMs: 30_000,
  });
  const [refreshing, setRefreshing] = React.useState(false);

  const closed = zones
    .filter((z) => z.status === "CLOSED")
    .sort((a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt));

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  return (
    <ScrollView
      style={[styles.screen, { paddingTop: insets.top + 12 }]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={C.gold} />
      }
    >
      <Text style={styles.title}>History</Text>
      <Text style={styles.subtitle}>Closed cascade zones for this account</Text>

      {!accountId && (
        <Text style={styles.empty}>Connect MT5 in Settings to load history.</Text>
      )}

      {loading && closed.length === 0 && (
        <ActivityIndicator color={C.gold} style={{ marginTop: 24 }} />
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {!loading && accountId && closed.length === 0 && (
        <View style={styles.emptyBox}>
          <Feather name="inbox" size={32} color={C.textMuted} />
          <Text style={styles.empty}>No closed zones yet.</Text>
        </View>
      )}

      {closed.map((z) => (
        <HistoryRow key={z.zoneId} zone={z} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  content: { paddingHorizontal: 16, paddingBottom: 120 },
  title: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: C.text,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    marginBottom: 20,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    marginBottom: 10,
  },
  dirBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  dirBuy: { backgroundColor: C.buyDim },
  dirSell: { backgroundColor: C.sellDim },
  dirText: { fontSize: 11, fontFamily: "Inter_700Bold" },
  dirTextBuy: { color: C.buy },
  dirTextSell: { color: C.sell },
  rowBody: { flex: 1 },
  rowTitle: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
    marginBottom: 2,
  },
  rowMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  rowTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 4,
  },
  emptyBox: {
    alignItems: "center",
    gap: 12,
    paddingVertical: 40,
  },
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    textAlign: "center",
  },
  error: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: C.sell,
    marginBottom: 12,
  },
});
