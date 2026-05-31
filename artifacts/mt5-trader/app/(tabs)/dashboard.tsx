import { Feather } from "@expo/vector-icons";
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";
import { useZones } from "@/hooks/useZones";

const C = Colors.dark;

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const { status, accountInfo, price, accountId, refreshPositions } = useTrading();
  const { zones, refresh, loading } = useZones(accountId, { pollIntervalMs: 10_000 });
  const [refreshing, setRefreshing] = React.useState(false);

  const openZones = zones.filter((z) => z.status === "OPEN" || z.status === "RISK_FREE");
  const closedZones = zones.filter((z) => z.status === "CLOSED");

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refresh(), refreshPositions()]);
    setRefreshing(false);
  };

  const connected = status === "connected";

  return (
    <ScrollView
      style={[styles.screen, { paddingTop: insets.top + 12 }]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={C.gold} />
      }
    >
      <Text style={styles.title}>Dashboard</Text>
      <View style={[styles.statusPill, connected ? styles.statusOk : styles.statusOff]}>
        <View style={[styles.statusDot, connected ? styles.dotOk : styles.dotOff]} />
        <Text style={styles.statusText}>{connected ? "MT5 connected" : status}</Text>
      </View>

      <View style={styles.statRow}>
        <StatCard
          label="Balance"
          value={accountInfo ? `$${accountInfo.balance.toFixed(2)}` : "—"}
          sub={accountInfo?.currency}
        />
        <StatCard
          label="Equity"
          value={accountInfo ? `$${accountInfo.equity.toFixed(2)}` : "—"}
        />
      </View>
      <View style={styles.statRow}>
        <StatCard
          label="Free margin"
          value={accountInfo ? `$${accountInfo.freeMargin.toFixed(2)}` : "—"}
        />
        <StatCard
          label="XAUUSD"
          value={price ? price.bid.toFixed(2) : "—"}
          sub={price ? `spread ${price.spread.toFixed(1)}` : undefined}
        />
      </View>

      <Text style={styles.sectionTitle}>Zones</Text>
      <View style={styles.zoneSummary}>
        <Feather name="layers" size={18} color={C.gold} />
        <Text style={styles.zoneSummaryText}>
          {loading ? "Loading…" : `${openZones.length} active · ${closedZones.length} closed`}
        </Text>
      </View>
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
    marginBottom: 12,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    marginBottom: 20,
  },
  statusOk: { backgroundColor: "rgba(14,203,129,0.12)" },
  statusOff: { backgroundColor: "rgba(136,136,136,0.12)" },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  dotOk: { backgroundColor: C.buy },
  dotOff: { backgroundColor: C.textSecondary },
  statusText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: C.text },
  statRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  statCard: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
  },
  statLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: C.textSecondary,
    marginBottom: 6,
  },
  statValue: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  statSub: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: C.text,
    marginTop: 8,
    marginBottom: 10,
  },
  zoneSummary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
  },
  zoneSummaryText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: C.text,
  },
});
