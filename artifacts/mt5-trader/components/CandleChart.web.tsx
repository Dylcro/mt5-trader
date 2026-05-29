import {
  CandlestickSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import React, { useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";
import { useCandles, type CandleTimeframe } from "@/hooks/useCandles";
import { useZones } from "@/hooks/useZones";

const C = Colors.dark;

const TF_MS: Record<CandleTimeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

const TF_OPTIONS: { label: string; value: CandleTimeframe }[] = [
  { label: "M1", value: "1m" },
  { label: "M5", value: "5m" },
  { label: "M15", value: "15m" },
  { label: "H1", value: "1h" },
];

export interface CandleChartProps {
  accountId: string;
  timeframe: CandleTimeframe;
  onTimeframeChange: (tf: CandleTimeframe) => void;
}

type BarState = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
};

export default function CandleChart({
  accountId,
  timeframe,
  onTimeframeChange,
}: CandleChartProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const containerRef = useRef<any>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<ISeriesApi<any> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const currentBarRef = useRef<BarState | null>(null);

  const { price, positions, pendingOrders, sseConnected } = useTrading();
  const { zones } = useZones(accountId, { sseConnected });
  const { candles } = useCandles(accountId, timeframe);

  const activeZone =
    zones
      .filter((z) => z.status !== "CLOSED")
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

  // ── Initialise chart (once) ───────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "#0A0A0A" },
        textColor: "#888888",
        fontFamily: "Inter_400Regular, -apple-system, sans-serif",
      },
      grid: {
        vertLines: { color: "#1A1A1A" },
        horzLines: { color: "#1A1A1A" },
      },
      crosshair: {
        vertLine: { color: "#444444", width: 1, labelBackgroundColor: "#282828" },
        horzLine: { color: "#444444", width: 1, labelBackgroundColor: "#282828" },
      },
      rightPriceScale: {
        borderColor: "#282828",
        textColor: "#888888",
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: "#282828",
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      autoSize: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const series = chart.addSeries(CandlestickSeries as any, {
      upColor: "#0ECB81",
      downColor: "#F6465D",
      borderUpColor: "#0ECB81",
      borderDownColor: "#F6465D",
      wickUpColor: "#0ECB81",
      wickDownColor: "#F6465D",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
      currentBarRef.current = null;
    };
  }, []);

  // ── Load historical candles ───────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    series.setData(candles as any);
    currentBarRef.current = null;
    chartRef.current?.timeScale().scrollToRealTime();
  }, [candles]);

  // ── Live price tick → extend / create current bar ────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !price) return;

    const mid = parseFloat(((price.bid + price.ask) / 2).toFixed(2));
    const msPerBar = TF_MS[timeframe];
    const barStart = (Math.floor(Date.now() / msPerBar) * (msPerBar / 1000)) as UTCTimestamp;

    const cur = currentBarRef.current;
    let bar: BarState;

    if (cur && cur.time === barStart) {
      bar = {
        time: barStart,
        open: cur.open,
        high: parseFloat(Math.max(cur.high, mid).toFixed(2)),
        low: parseFloat(Math.min(cur.low, mid).toFixed(2)),
        close: mid,
      };
    } else {
      bar = { time: barStart, open: mid, high: mid, low: mid, close: mid };
    }

    currentBarRef.current = bar;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    series.update(bar as any);
    chartRef.current?.timeScale().scrollToRealTime();
  }, [price, timeframe]);

  // ── Cascade overlay price lines ───────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* ignore */ }
    }
    priceLinesRef.current = [];

    if (!activeZone) return;

    const isBuy = activeZone.direction === "buy";
    const entryColor = isBuy ? "#2962FF" : "#F6465D";
    const tpColor = "#0ECB81";
    const slColor = "#F6465D";
    const lines: IPriceLine[] = [];

    // Market entry line
    if (activeZone.anchorPrice > 0) {
      lines.push(
        series.createPriceLine({
          price: activeZone.anchorPrice,
          color: entryColor,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: isBuy ? "BUY" : "SELL",
        }),
      );
    }

    // TP lines (not yet hit)
    const tpFields = [
      { price: activeZone.tp1Price, hit: activeZone.tp1Hit, label: "TP1" },
      { price: activeZone.tp2Price, hit: activeZone.tp2Hit, label: "TP2" },
      { price: activeZone.tp3Price, hit: activeZone.tp3Hit, label: "TP3" },
      { price: activeZone.tp4Price, hit: activeZone.tp4Hit, label: "TP4" },
    ];
    for (const tp of tpFields) {
      if (tp.price == null || tp.hit) continue;
      lines.push(
        series.createPriceLine({
          price: tp.price,
          color: tpColor,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: tp.label,
        }),
      );
    }

    // SL — first open position matching zone direction
    const dirType = isBuy ? "POSITION_TYPE_BUY" : "POSITION_TYPE_SELL";
    const slCandidates = positions
      .filter((p) => p.type === dirType && p.stopLoss != null)
      .map((p) => p.stopLoss!);
    if (slCandidates.length > 0) {
      lines.push(
        series.createPriceLine({
          price: slCandidates[0]!,
          color: slColor,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: "SL",
        }),
      );
    }

    // Limit entries — from pending orders matching direction
    const limitSide = isBuy ? "BUY" : "SELL";
    const limitOrders = pendingOrders
      .filter((o) => o.type.includes(limitSide) && o.type.includes("LIMIT"))
      .sort((a, b) =>
        isBuy ? b.openPrice - a.openPrice : a.openPrice - b.openPrice,
      );
    for (let i = 0; i < limitOrders.length; i++) {
      const ord = limitOrders[i]!;
      lines.push(
        series.createPriceLine({
          price: ord.openPrice,
          color: entryColor,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${limitSide} LIMIT  ${ord.volume.toFixed(2)}`,
        }),
      );
    }

    priceLinesRef.current = lines;
  }, [activeZone, positions, pendingOrders]);

  return (
    <View style={styles.container}>
      {/* Header bar */}
      <View style={styles.header}>
        <Text style={styles.symbolText}>XAUUSD</Text>
        <View style={styles.tfRow}>
          {TF_OPTIONS.map((opt) => (
            <Pressable
              key={opt.value}
              style={[
                styles.tfBtn,
                timeframe === opt.value && styles.tfBtnActive,
              ]}
              onPress={() => onTimeframeChange(opt.value)}
              hitSlop={8}
            >
              <Text
                style={[
                  styles.tfText,
                  timeframe === opt.value && styles.tfTextActive,
                ]}
              >
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {price ? (
          <Text style={styles.livePrice}>
            {((price.bid + price.ask) / 2).toFixed(2)}
          </Text>
        ) : null}
      </View>

      {/* Active zone legend */}
      {activeZone ? (
        <View style={styles.legendRow}>
          <View
            style={[
              styles.legendDot,
              {
                backgroundColor:
                  activeZone.direction === "buy" ? "#2962FF" : "#F6465D",
              },
            ]}
          />
          <Text style={styles.legendText}>
            {activeZone.direction === "buy" ? "BUY" : "SELL"} zone active
            {activeZone.status === "RISK_FREE" ? "  ·  Risk-free" : ""}
          </Text>
        </View>
      ) : null}

      {/* Chart canvas */}
      <View ref={containerRef} style={styles.chartArea} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0A0A0A",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 8,
  },
  symbolText: {
    color: C.text,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    marginRight: 2,
  },
  tfRow: {
    flexDirection: "row",
    gap: 3,
    flex: 1,
  },
  tfBtn: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: C.surface,
  },
  tfBtnActive: {
    backgroundColor: C.gold,
  },
  tfText: {
    color: C.textSecondary,
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  tfTextActive: {
    color: "#000",
    fontFamily: "Inter_600SemiBold",
  },
  livePrice: {
    color: C.text,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 5,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    color: C.textSecondary,
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  chartArea: {
    flex: 1,
  },
});
