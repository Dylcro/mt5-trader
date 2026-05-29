import React from "react";
import { StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import type { CandleTimeframe } from "@/hooks/useCandles";

const C = Colors.dark;

export interface CandleChartProps {
  accountId: string;
  timeframe: CandleTimeframe;
  onTimeframeChange: (tf: CandleTimeframe) => void;
}

export default function CandleChart(_props: CandleChartProps) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.text}>Chart is only available in the web app.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: C.background },
  text: { color: C.textMuted, fontSize: 14 },
});
