import React from "react";
import { Platform, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

const CHART_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #0d0d0d; overflow: hidden; }
    .tradingview-widget-container { width: 100%; height: 100%; }
    .tradingview-widget-container__widget { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div class="tradingview-widget-container">
    <div class="tradingview-widget-container__widget"></div>
    <script
      type="text/javascript"
      src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"
      async
    >
    {
      "autosize": true,
      "symbol": "OANDA:XAUUSD",
      "interval": "5",
      "timezone": "Etc/UTC",
      "theme": "dark",
      "style": "1",
      "locale": "en",
      "backgroundColor": "#0d0d0d",
      "gridColor": "rgba(255,255,255,0.04)",
      "hide_top_toolbar": false,
      "hide_legend": true,
      "save_image": false,
      "calendar": false,
      "hide_volume": true,
      "support_host": "https://www.tradingview.com",
      "withdateranges": false,
      "allow_symbol_change": false,
      "studies": []
    }
    </script>
  </div>
</body>
</html>
`;

export function TradingViewChart({ height = 220 }: { height?: number }) {
  if (Platform.OS === "web") return null;

  return (
    <View style={[styles.wrapper, { height }]}>
      <WebView
        source={{ html: CHART_HTML }}
        style={styles.webview}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        androidHardwareAccelerationDisabled={false}
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: "100%",
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#0d0d0d",
    marginBottom: 12,
  },
  webview: {
    flex: 1,
    backgroundColor: "#0d0d0d",
  },
});
