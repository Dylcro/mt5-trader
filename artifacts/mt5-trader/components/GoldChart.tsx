import { useFocusEffect } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";

import Colors from "@/constants/colors";

const C = Colors.dark;

type Interval = "1" | "5" | "15" | "60" | "240" | "D";

const INTERVAL_PARAM: Record<Interval, string> = {
  "1": "1",
  "5": "5",
  "15": "15",
  "60": "60",
  "240": "240",
  D: "D",
};

const ALLOWED_HOSTS = [
  "tradingview.com",
  "s3.tradingview.com",
  "s.tradingview.com",
  "www.tradingview.com",
  "static.tradingview.com",
  "charting-library.tradingview-widget.com",
];

function isAllowedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function buildHtml(interval: Interval) {
  const intervalParam = INTERVAL_PARAM[interval];
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <style>
      html, body { margin: 0; padding: 0; background: ${C.background}; height: 100%; overflow: hidden; }
      #tv { height: 100vh; width: 100vw; }
    </style>
  </head>
  <body>
    <div id="tv"></div>
    <script src="https://s3.tradingview.com/tv.js"></script>
    <script>
      new TradingView.widget({
        autosize: true,
        symbol: "OANDA:XAUUSD",
        interval: "${intervalParam}",
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "en",
        toolbar_bg: "${C.background}",
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
        allow_symbol_change: false,
        container_id: "tv"
      });
    </script>
  </body>
</html>`;
}

export default function GoldChart({ height = 320 }: { height?: number }) {
  const [interval] = useState<Interval>("15");
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setHasLoadedOnce(true);
    }, [])
  );

  const html = useMemo(() => buildHtml(interval), [interval]);

  if (!hasLoadedOnce) {
    return (
      <View style={[styles.wrap, styles.placeholder, { height }]}>
        <ActivityIndicator color={C.gold} />
      </View>
    );
  }

  if (Platform.OS === "web") {
    const src = `https://s.tradingview.com/widgetembed/?symbol=OANDA%3AXAUUSD&interval=${INTERVAL_PARAM[interval]}&theme=dark&style=1&locale=en&toolbarbg=${encodeURIComponent(
      C.background
    )}&hide_side_toolbar=0&allow_symbol_change=0&save_image=0`;
    return (
      <View style={[styles.wrap, { height }]}>
        <iframe
          src={src}
          style={{ width: "100%", height: "100%", border: "0" }}
          sandbox="allow-scripts allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
          allow=""
        />
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { height }]}>
      <WebView
        originWhitelist={ALLOWED_HOSTS.map((h) => `https://*.${h}`).concat(
          ALLOWED_HOSTS.map((h) => `https://${h}`)
        )}
        source={{ html, baseUrl: "https://www.tradingview.com" }}
        style={{ backgroundColor: C.background }}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        allowsInlineMediaPlayback
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(req: WebViewNavigation) => {
          // about:blank and the initial HTML doc are fine; otherwise only allow TradingView.
          if (!req.url || req.url === "about:blank") return true;
          if (req.url.startsWith("data:") || req.url.startsWith("blob:")) return true;
          return isAllowedUrl(req.url);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: C.background,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: C.border,
  },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
  },
});
