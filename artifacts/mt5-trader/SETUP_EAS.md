# EAS Build & App Store Submission — Setup Guide

This guide walks you through compiling the app into a native iOS `.ipa` and Android
`.aab`, ready for App Store and Google Play submission.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | Already installed if you ran the dev server |
| EAS CLI | `npm install -g eas-cli` |
| Expo account | Free — sign up at expo.dev |
| Apple Developer account | $99/year — appleid.apple.com |
| Google Play Console account | $25 one-time — play.google.com/console |

---

## Step 1 — Create an Expo account and link the project

```bash
eas login                          # sign in to your Expo account
eas project:init                   # creates the project in Expo's dashboard
                                   # copies the projectId into app.json automatically
```

After running `eas project:init`, open `app.json` and set `owner` to your Expo
username. The `extra.eas.projectId` will be filled in automatically.

---

## Step 2 — Set the Clerk publishable key as an EAS secret

The native build needs the Clerk key baked in. It is referenced as
`$CLERK_PUBLISHABLE_KEY` in `eas.json` and must be stored as an EAS secret:

```bash
eas secret:create \
  --scope project \
  --name CLERK_PUBLISHABLE_KEY \
  --value "pk_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

Get the value from your Clerk dashboard → API Keys → Publishable key.

---

## Step 3 — Build for iOS

### 3a. Set your Apple Team ID

Open `app.json` and replace `PLACEHOLDER_APPLE_TEAM_ID` with your 10-character
Apple Team ID (found at developer.apple.com → Membership).

### 3b. Run the production build

```bash
eas build --platform ios --profile production
```

EAS will prompt you to log in to your Apple account and will handle:
- Provisioning profile creation
- Distribution certificate creation
- Uploading and compiling the binary

The finished `.ipa` URL will appear in the EAS dashboard and in your terminal.

---

## Step 4 — Build for Android

```bash
eas build --platform android --profile production
```

EAS will auto-generate a keystore for you on first run and store it securely in
the EAS credential store. The finished `.aab` URL will appear when complete.

---

## Step 5 — Submit to App Store (iOS)

### 5a. Create the app in App Store Connect

1. Go to appstoreconnect.apple.com → My Apps → "+"
2. Name: **XAUUSD Trader**, Bundle ID: `com.xauusdtrader.app`
3. Copy the **App Store Connect App ID** (numeric, e.g. `1234567890`)

### 5b. Update eas.json submit config

Open `eas.json` and replace the submit placeholders:
```json
"ios": {
  "appleId": "your@apple.id",
  "ascAppId": "1234567890",
  "appleTeamId": "ABCDE12345"
}
```

### 5c. Submit

```bash
eas submit --platform ios --profile production
```

---

## Step 6 — Submit to Google Play (Android)

### 6a. Create the app in Google Play Console

1. Go to play.google.com/console → Create app
2. Package name: `com.xauusdtrader.app`

### 6b. Download a service account key

1. Google Play Console → Setup → API access → Service accounts → Create
2. Download the JSON key file and save it as `google-service-account.json`
   in the `artifacts/mt5-trader/` folder (this file is gitignored — never commit it)

### 6c. Submit

```bash
eas submit --platform android --profile production
```

---

## Preview build (internal testing, no store needed)

To share with testers via a direct install link before going to the stores:

```bash
eas build --platform all --profile preview
```

Distribute the resulting links via EAS dashboard or `eas build:list`.

---

## Environment variables in builds

All three build profiles (`development`, `preview`, `production`) automatically inject:

| Variable | Value |
|---|---|
| `EXPO_PUBLIC_API_URL` | `https://workspaceapi-server-production-4768.up.railway.app/api` |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | from EAS secret `CLERK_PUBLISHABLE_KEY` |
| `EXPO_PUBLIC_CLERK_PROXY_URL` | `https://workspaceapi-server-production-4768.up.railway.app/api/__clerk` |

The production binary will always target the live deployed API — never the Replit
dev preview server.

---

## Privacy Policy

A Privacy Policy is live at:
**https://workspaceapi-server-production-4768.up.railway.app/privacy**

Both Apple and Google require a privacy policy URL for financial apps. Use this URL
when submitting to both stores.

---

## Bundle identifiers

| Platform | Identifier |
|---|---|
| iOS | `com.xauusdtrader.app` |
| Android | `com.xauusdtrader.app` |

These are already set in `app.json`. If you want a custom identifier (e.g.
`com.yourname.mt5trader`), update both `ios.bundleIdentifier` and `android.package`
in `app.json` before running your first build — they cannot be changed afterwards
without creating a new store listing.
