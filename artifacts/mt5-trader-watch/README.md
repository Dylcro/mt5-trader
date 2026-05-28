# MT5 Trader — Apple Watch Companion (Scaffold)

This folder contains the **watchOS source code** for an Apple Watch companion to
the MT5 Trader phone app. It is *not* a runnable Replit artifact — Apple's
watchOS toolchain requires Xcode on a Mac.

## What the watch does

Three big buttons on a single screen:

1. **BUY** — fires a cascade BUY at the live market price, using the last lot
   size + TP geometry the user placed on the phone.
2. **SELL** — same, but SELL.
3. **RISK FREE** — sends the most-recently-opened zone into risk-free mode
   (close all but the best entry, move SL beyond entry).

The watch carries no UI for lot size or TPs — those are read from the
`/mt5/user/trade-defaults` endpoint, which the phone updates after every
cascade order.

## What's already done (server-side, in this repo)

- `GET /api/mt5/user/trade-defaults` — last-used lot + TPs for the signed-in user
- `PUT /api/mt5/user/trade-defaults` — phone writes this after every cascade
- `GET /api/mt5/account/:accountId/zones/latest-open` — newest OPEN zone, for the Risk Free button
- `POST /api/mt5/account/:accountId/zones/:zoneId/risk-free` — already existed
- Phone client now PUTs defaults automatically on each successful cascade
- New `user_trade_defaults` DB table

The watch app calls the existing `POST /mt5/account/:accountId/trade` endpoint
(market BUY/SELL) and the new GET endpoints above. Everything is JWT-protected
with the same bearer token the phone already uses.

## What's left for the Mac/Xcode side (manual)

These steps **cannot** be done in this Replit environment. You'll need a Mac
with Xcode 15+, an Apple Developer account, and physical access to your watch.

### 1. Switch the phone app off Expo Go onto an EAS dev build

Expo Go can't include native watch targets — you need a custom dev client.

```bash
cd artifacts/mt5-trader
npx eas-cli build --platform ios --profile development
```

(`eas.json` already exists in `artifacts/mt5-trader/`.)

Install the resulting `.ipa` on your iPhone via TestFlight or direct install.

### 2. Run `expo prebuild` and open the iOS project in Xcode

```bash
cd artifacts/mt5-trader
npx expo prebuild --platform ios
open ios/MT5Trader.xcworkspace
```

### 3. Add a watchOS App target

In Xcode: **File → New → Target → watchOS → App**.
- Product Name: `MT5TraderWatch`
- Bundle ID: `com.xauusdtrader.app.watchkitapp` (must be `<phone bundle id>.watchkitapp`)
- Interface: SwiftUI
- Language: Swift

### 4. Replace the auto-generated Swift files with the files in this folder

Copy these files into the new watchOS target group in Xcode:

- `MT5WatchApp.swift` → entry point
- `TradeView.swift` → 3-button UI
- `APIClient.swift` → talks to the API server
- `SessionStore.swift` → reads bearer token from WatchConnectivity

### 5. Add the iOS-side bridge to the phone app

Copy `ios-bridge/MT5WatchBridge.swift` into the iOS target in Xcode. This is a
small native module that ships the Clerk JWT + API base URL to the watch over
WatchConnectivity whenever the user signs in on the phone.

You'll also need to register it as an Expo native module — the bridge file
includes the `@objc` annotations and bridging header notes. See the comments at
the top of `MT5WatchBridge.swift`.

### 6. Build & run

Plug your iPhone into the Mac, choose the **MT5TraderWatch** scheme, choose
your physical watch as the destination, and hit Run.

The watch app will appear on the paired watch. Sign in on the phone first so
the bridge has a token to send; the watch will display "Sign in on phone"
until then.

## Costs / caveats

- Apple Developer Program: **$99/year** required to install on real devices.
- Watch app is **iOS-only** — Apple's sandbox prohibits a third-party app
  overlay on iOS (which is why the watch is the chosen solution).
- The watch fires market orders only — no limit ladders. The cascade
  *geometry* (lot, TPs, SL) is read from the user's last phone placement.
