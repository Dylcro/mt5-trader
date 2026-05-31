import React, { useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { WebView, type WebView as WebViewRef } from "react-native-webview";

function buildHtml(apiBase: string, accountId: string, region: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #0d0d0d; overflow: hidden; font-family: -apple-system, sans-serif; }
    #chart-wrap { display: flex; flex-direction: column; width: 100%; height: 100%; }
    #tf-bar { display: flex; align-items: center; padding: 4px 10px; gap: 2px; background: #111; flex-shrink: 0; }
    .tf { color: #555; font-size: 11px; font-weight: 600; background: none; border: none; padding: 5px 9px; border-radius: 5px; cursor: pointer; letter-spacing: 0.3px; }
    .tf.on { color: #C9A84C; background: rgba(201,168,76,0.12); }
    #chart { flex: 1; width: 100%; min-height: 0; }
    #msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #444; font-size: 13px; pointer-events: none; }
  </style>
</head>
<body>
  <div id="chart-wrap">
    <div id="tf-bar">
      <button class="tf" data-tf="1m">1m</button>
      <button class="tf on" data-tf="5m">5m</button>
      <button class="tf" data-tf="15m">15m</button>
      <button class="tf" data-tf="1h">1h</button>
      <button class="tf" data-tf="4h">4h</button>
      <button class="tf" data-tf="1d">1d</button>
    </div>
    <div id="chart"></div>
  </div>
  <div id="msg">Loading…</div>

  <script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
  <script>
    var API  = "${apiBase}";
    var ACC  = "${accountId}";
    var REG  = "${region}";
    var tf   = "5m";
    var chart, series, timer;

    function init() {
      var el = document.getElementById("chart");
      chart = LightweightCharts.createChart(el, {
        layout:  { background: { color: "#0d0d0d" }, textColor: "#555" },
        grid:    { vertLines: { color: "#161616" }, horzLines: { color: "#161616" } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: "#222", minimumWidth: 68 },
        timeScale: { borderColor: "#222", timeVisible: true, secondsVisible: false, fixLeftEdge: true },
        handleScroll: true,
        handleScale:  true,
      });

      series = chart.addCandlestickSeries({
        upColor:         "#0ECB81",
        downColor:       "#F6465D",
        borderUpColor:   "#0ECB81",
        borderDownColor: "#F6465D",
        wickUpColor:     "#0ECB81",
        wickDownColor:   "#F6465D",
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      });

      window.addEventListener("resize", resize);
      resize();
      load(tf);
      timer = setInterval(function() { load(tf); }, 8000);
    }

    function resize() {
      var el = document.getElementById("chart");
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    }

    async function load(t) {
      try {
        var r = await fetch(API + "/mt5/account/" + ACC + "/candles?region=" + REG + "&timeframe=" + t + "&limit=150");
        if (!r.ok) throw new Error("bad response");
        var data = await r.json();
        if (!Array.isArray(data)) throw new Error("invalid");
        if (data.length === 0) {
          document.getElementById("msg").textContent = "Building chart \u2014 prices accumulate every 5s\u2026";
          document.getElementById("msg").style.display = "flex";
          return;
        }
        var candles = data.map(function(c) {
          return {
            time: Math.floor(new Date(c.time).getTime() / 1000),
            open: c.open, high: c.high, low: c.low, close: c.close
          };
        });
        candles.sort(function(a, b) { return a.time - b.time; });
        series.setData(candles);
        chart.timeScale().fitContent();
        document.getElementById("msg").style.display = "none";
      } catch(e) {
        document.getElementById("msg").textContent = "Chart unavailable";
        document.getElementById("msg").style.display = "flex";
      }
    }

    document.querySelectorAll(".tf").forEach(function(btn) {
      btn.addEventListener("click", function() {
        document.querySelectorAll(".tf").forEach(function(b) { b.classList.remove("on"); });
        btn.classList.add("on");
        tf = btn.dataset.tf;
        clearInterval(timer);
        document.getElementById("msg").textContent = "Loading\u2026";
        document.getElementById("msg").style.display = "flex";
        load(tf);
        timer = setInterval(function() { load(tf); }, 8000);
      });
    });

    // Receive live price tick from React Native to patch last candle close
    window.addEventListener("message", function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === "tick" && series) {
          var nowSec = Math.floor(Date.now() / 1000);
          series.update({ time: nowSec, open: msg.price, high: msg.price, low: msg.price, close: msg.price });
        }
      } catch(_) {}
    });

    if (typeof LightweightCharts !== "undefined") {
      init();
    } else {
      document.querySelector("script[src]").addEventListener("load", init);
    }
  </script>
</body>
</html>`;
}

interface Props {
  height?: number;
  apiBase: string;
  accountId: string;
  region: string;
  liveBid?: number;
}

export function TradingViewChart({ height = 215, apiBase, accountId, region, liveBid }: Props) {
  const wvRef = useRef<WebViewRef>(null);
  const prevBid = useRef<number | null>(null);

  if (Platform.OS === "web") return null;

  // Push live price tick into the chart whenever bid changes
  if (liveBid && liveBid !== prevBid.current) {
    prevBid.current = liveBid;
    wvRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'tick',price:${liveBid}})}));true;`
    );
  }

  const html = buildHtml(apiBase, accountId, region);

  return (
    <View style={[styles.wrapper, { height }]}>
      <WebView
        ref={wvRef}
        source={{ html }}
        style={styles.webview}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        setSupportMultipleWindows={false}
        cacheEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: "100%",
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#F0F2F5",
    marginBottom: 12,
  },
  webview: {
    flex: 1,
    backgroundColor: "#F0F2F5",
  },
});
