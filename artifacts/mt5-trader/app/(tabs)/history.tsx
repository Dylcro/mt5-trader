import { Feather } from "@expo/vector-icons";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";

import PeriodToggle from "@/components/PeriodToggle";
import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";
import { useRealizedPnl } from "@/hooks/useRealizedPnl";
import { useZones, type Zone } from "@/hooks/useZones";
import { useDisplayCurrency } from "@/hooks/useDisplayCurrency";
import { formatDuration, formatHistoryDate, formatPrice } from "@/lib/formatters";
import { tpDisplayState } from "@/lib/zoneComments";
import {
  countManualCloses,
  countRiskFreeSlExits,
  countSlHits,
  countZonesReachedTp,
  filterClosedZonesByPeriod,
  isTp4LevelEnabled,
  tpPillStyle,
  zoneReachedTpLevel,
  zonePrimaryOutcome,
  zoneTpLevelsHit,
  type Period,
} from "@/lib/zoneStats";

const C = Colors.dark;

function SummaryCell({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={styles.summaryCell}>
      <Text style={[styles.summaryValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function TpChip({ n, zone }: { n: 1 | 2 | 3 | 4; zone: Zone }) {
  const enabled = n === 4
    ? isTp4LevelEnabled(zone)
    : zone[`tp${n}Enabled` as keyof Zone] !== false;
  const hit = zoneReachedTpLevel(zone, n);
  const state = tpDisplayState(enabled, hit);
  if (state === "disabled") return null;
  const isHit = state === "hit";
  return (
    <View style={[styles.tpChip, isHit ? styles.tpChipHit : styles.tpChipPending]}>
      {isHit ? (
        <Feather name="check" size={10} color={C.buy} />
      ) : (
        <View style={styles.tpChipCircle} />
      )}
      <Text style={[styles.tpChipText, isHit && { color: C.buy }]}>TP{n}</Text>
    </View>
  );
}

function ExitChip({
  label,
  hit,
  variant,
}: {
  label: string;
  hit: boolean;
  variant: "manual" | "sl" | "rf";
}) {
  const hitStyle =
    variant === "sl" ? styles.tpChipSlHit
      : variant === "rf" ? styles.tpChipRfHit
        : styles.tpChipManualHit;
  const hitColor = variant === "sl" ? C.sell : C.gold;
  return (
    <View style={[styles.tpChip, hit ? hitStyle : styles.tpChipPending]}>
      {hit ? (
        <Feather name="check" size={10} color={hitColor} />
      ) : (
        <View style={styles.tpChipCircle} />
      )}
      <Text style={[styles.tpChipText, hit && { color: hitColor }]}>{label}</Text>
    </View>
  );
}

function HistoryCard({ zone }: { zone: Zone }) {
  const isBuy = zone.direction === "buy";
  const { hit, enabled } = zoneTpLevelsHit(zone);
  const pill = tpPillStyle(hit);
  const closedTs = zone.closedAt ?? zone.createdAt;
  const duration = formatDuration(closedTs - zone.createdAt);
  const lot =
    zone.originalVolume != null && zone.originalVolume > 0
      ? zone.originalVolume.toFixed(2)
      : "—";

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={[styles.dirIcon, isBuy ? styles.dirIconBuy : styles.dirIconSell]}>
          <Feather
            name={isBuy ? "arrow-up-right" : "arrow-down-right"}
            size={16}
            color={isBuy ? C.buy : C.sell}
          />
        </View>
        <View style={styles.cardTitleWrap}>
          <Text style={styles.cardTitle}>{isBuy ? "BUY CASCADE" : "SELL CASCADE"}</Text>
          <Text style={styles.cardDate}>{formatHistoryDate(closedTs)}</Text>
        </View>
        <View
          style={[
            styles.tpPill,
            pill === "green" && styles.tpPillGreen,
            pill === "gold" && styles.tpPillGold,
            pill === "grey" && styles.tpPillGrey,
          ]}
        >
          <Text
            style={[
              styles.tpPillText,
              pill === "green" && { color: C.buy },
              pill === "gold" && { color: C.gold },
              pill === "grey" && { color: C.textMuted },
            ]}
          >
            {enabled > 0 ? `${hit}/${enabled} TPs` : "—"}
          </Text>
        </View>
      </View>

      <View style={styles.statRow}>
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>ENTRY</Text>
          <Text style={styles.statValue}>{formatPrice(zone.anchorPrice)}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>DURATION</Text>
          <Text style={styles.statValue}>{duration}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={styles.statLabel}>LOT</Text>
          <Text style={styles.statValue}>{lot}</Text>
        </View>
      </View>

      <View style={styles.tpChipRow}>
        {([1, 2, 3, 4] as const).map((n) => (
          <TpChip key={n} n={n} zone={zone} />
        ))}
        <ExitChip label="MANUAL" hit={zonePrimaryOutcome(zone) === "MANUAL"} variant="manual" />
        <ExitChip label="RF" hit={zonePrimaryOutcome(zone) === "RF"} variant="rf" />
        <ExitChip label="SL" hit={zonePrimaryOutcome(zone) === "SL"} variant="sl" />
      </View>
    </View>
  );
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const { formatMoney } = useDisplayCurrency();
  const { accountId, region, sseConnected, status, syncSession } = useTrading();
  const { zones, loading, error, refresh } = useZones(accountId, {
    includeClosed: true,
    pollIntervalMs: 30_000,
    sseConnected,
  });
  const [period, setPeriod] = useState<Period>("today");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useFocusEffect(
    useCallback(() => {
      if (status !== "connected" || !accountId) return;
      void syncSession();
      const id = setInterval(() => void syncSession(), 10_000);
      return () => clearInterval(id);
    }, [status, accountId, syncSession]),
  );

  const periodZones = useMemo(
    () => filterClosedZonesByPeriod(zones, period),
    [zones, period],
  );
  const sorted = useMemo(
    () =>
      [...periodZones].sort(
        (a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt),
      ),
    [periodZones],
  );

  const { pnl: periodPnl, loading: pnlLoading } = useRealizedPnl(
    accountId,
    period,
    region,
    refreshKey,
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshKey((k) => k + 1);
    setRefreshing(false);
  };

  const periodLabel = period === "today" ? "Today" : "This week";

  return (
    <ScrollView
      style={[styles.screen, { paddingTop: insets.top + 12 }]}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={C.gold} />
      }
    >
      <Text style={styles.title}>History</Text>

      <View style={styles.toolbar}>
        <PeriodToggle value={period} onChange={setPeriod} />
        {accountId && (
          <Text
            style={[
              styles.periodPnl,
              periodPnl != null && periodPnl >= 0 ? { color: C.buy } : periodPnl != null ? { color: C.sell } : null,
            ]}
          >
            {pnlLoading && periodPnl == null
              ? "…"
              : periodPnl != null
                ? `${periodLabel} ${formatMoney(periodPnl, { signed: true })}`
                : `${periodLabel} —`}
          </Text>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.summaryScroll}
        contentContainerStyle={styles.summaryBar}
      >
        <SummaryCell label="ZONES" value={String(periodZones.length)} />
        <View style={styles.summaryDivider} />
        <SummaryCell label="TP1" value={String(countZonesReachedTp(periodZones, 1))} color={C.buy} />
        <View style={styles.summaryDivider} />
        <SummaryCell label="TP2" value={String(countZonesReachedTp(periodZones, 2))} color={C.buy} />
        <View style={styles.summaryDivider} />
        <SummaryCell label="TP3" value={String(countZonesReachedTp(periodZones, 3))} color={C.gold} />
        <View style={styles.summaryDivider} />
        <SummaryCell label="TP4" value={String(countZonesReachedTp(periodZones, 4))} color={C.gold} />
        <View style={styles.summaryDivider} />
        <SummaryCell label="MANUAL" value={String(countManualCloses(periodZones))} color={C.gold} />
        <View style={styles.summaryDivider} />
        <SummaryCell label="RF" value={String(countRiskFreeSlExits(periodZones))} color={C.gold} />
        <View style={styles.summaryDivider} />
        <SummaryCell label="SL" value={String(countSlHits(periodZones))} color={C.sell} />
      </ScrollView>

      {!accountId && (
        <Text style={styles.empty}>Connect MT5 in Settings to load history.</Text>
      )}

      {loading && sorted.length === 0 && (
        <ActivityIndicator color={C.gold} style={{ marginTop: 24 }} />
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {!loading && accountId && sorted.length === 0 && (
        <View style={styles.emptyBox}>
          <Feather name="inbox" size={32} color={C.textMuted} />
          <Text style={styles.empty}>No closed zones for this period.</Text>
        </View>
      )}

      {sorted.map((z) => (
        <HistoryCard key={z.zoneId} zone={z} />
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
    marginBottom: 12,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    gap: 12,
  },
  periodPnl: {
    flex: 1,
    textAlign: "right",
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: C.textSecondary,
  },
  summaryScroll: {
    marginBottom: 16,
    flexGrow: 0,
  },
  summaryBar: {
    flexDirection: "row",
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 12,
    paddingHorizontal: 4,
    alignItems: "center",
  },
  summaryCell: {
    minWidth: 52,
    paddingHorizontal: 6,
    alignItems: "center",
  },
  summaryValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  summaryLabel: {
    fontSize: 8,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
    marginTop: 4,
    letterSpacing: 0.5,
  },
  summaryDivider: {
    width: 1,
    height: 36,
    backgroundColor: C.border,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    marginBottom: 12,
    gap: 12,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  dirIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  dirIconBuy: { backgroundColor: C.buyDim },
  dirIconSell: { backgroundColor: C.sellDim },
  cardTitleWrap: { flex: 1 },
  cardTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  cardDate: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textMuted,
    marginTop: 2,
  },
  tpPill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  tpPillGreen: { backgroundColor: C.buyDim },
  tpPillGold: { backgroundColor: C.goldLight },
  tpPillGrey: { backgroundColor: C.surface },
  tpPillSlHit: { backgroundColor: C.sellDim },
  tpPillText: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
  },
  statRow: {
    flexDirection: "row",
    backgroundColor: C.surface,
    borderRadius: 10,
    overflow: "hidden",
  },
  statCell: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    gap: 4,
  },
  statDivider: {
    width: 1,
    backgroundColor: C.border,
    marginVertical: 8,
  },
  statLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
    letterSpacing: 0.8,
  },
  statValue: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  tpChipRow: {
    flexDirection: "row",
    gap: 6,
  },
  tpChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  tpChipHit: {
    backgroundColor: C.buyDim,
    borderColor: C.buyBorder,
  },
  tpChipManualHit: {
    backgroundColor: C.goldLight,
    borderColor: C.gold,
  },
  tpChipRfHit: {
    backgroundColor: C.goldLight,
    borderColor: C.gold,
  },
  tpChipSlHit: {
    backgroundColor: C.sellDim,
    borderColor: C.sell,
  },
  tpChipPending: {
    backgroundColor: C.card,
    borderColor: C.border,
  },
  tpChipDisabled: {
    backgroundColor: C.surface,
    borderColor: C.border,
    opacity: 0.6,
  },
  tpChipCircle: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: C.textMuted,
  },
  tpChipText: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
  },
  tpChipTextDisabled: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
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
