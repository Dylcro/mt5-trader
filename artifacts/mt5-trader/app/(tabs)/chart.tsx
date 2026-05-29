import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";
import CandleChart from "@/components/CandleChart";
import { useTrading } from "@/context/TradingContext";
import type { CandleTimeframe } from "@/hooks/useCandles";

const C = Colors.dark;

export default function ChartScreen() {
  const insets = useSafeAreaInsets();
  const { accountId } = useTrading();
  const [timeframe, setTimeframe] = useState<CandleTimeframe>("5m");

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, paddingBottom: insets.bottom + 84 },
      ]}
    >
      <CandleChart
        accountId={accountId}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.background,
  },
});
