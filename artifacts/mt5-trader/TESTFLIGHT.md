# TestFlight — invite demo traders (iOS)

## What you need

- **Apple Developer Program** (paid) — [developer.apple.com](https://developer.apple.com)
- **App Store Connect** access with the same Apple ID
- **EAS CLI** logged in (`eas whoami` → should show `dylcro`)
- API live at `https://workspaceapi-server-production-4768.up.railway.app` (Replit published on `main` — includes PR #21 trading fixes as of merge `1cc26d4`)

Bundle ID (already in the project): **`com.xauusdtrader.app`**

---

## Step 1 — Create the app in App Store Connect (one-time)

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps** → **+** → **New App**
2. Platform: **iOS**
3. Name: **XAUUSD Trader** (or your store name)
4. Bundle ID: select **`com.xauusdtrader.app`** (create it under [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) if missing)
5. SKU: e.g. `xauusd-trader`
6. Save — note the **Apple ID** of the app (numeric, e.g. `1234567890`) for submit later

Fill privacy URL: `https://workspaceapi-server-production-4768.up.railway.app/privacy`

---

## Step 2 — Production iOS build (EAS)

From your Mac (or machine with EAS logged in):

```bash
cd artifacts/mt5-trader   # from repo root on your Mac
git fetch origin && git checkout main && git pull origin main
eas build --platform ios --profile production
```

**Important:** Run `eas build` in an **interactive** terminal (not CI). The first production build after credential changes must prompt for Apple login — `--non-interactive` fails with “Credentials are not set up”.

- First time: EAS may ask you to sign in to **Apple** and will create distribution cert + provisioning.
- Wait until status is **finished** in [expo.dev builds](https://expo.dev/accounts/dylcro/projects/mt5-trader/builds).

This build includes `EXPO_PUBLIC_API_URL=https://workspaceapi-server-production-4768.up.railway.app/api` (live API).

---

## Step 3 — Upload to TestFlight

**Option A — EAS Submit (recommended)**

```bash
eas submit --platform ios --latest
```

Follow prompts: Apple ID, app-specific password if needed, pick the App Store Connect app you created.

**Option B — Auto-submit on build**

```bash
eas build --platform ios --profile production --auto-submit
```

Update `eas.json` → `submit.production.ios` with your real `appleId`, `ascAppId`, and `appleTeamId` to avoid prompts (Team ID: Membership details on developer.apple.com).

---

## Step 4 — TestFlight compliance (App Store Connect)

1. Open your app → **TestFlight** tab
2. When the build appears, complete **Export Compliance** (app uses `ITSAppUsesNonExemptEncryption: false` — typically “No” for custom encryption)
3. Add **Beta App Review** info if Apple asks (short description + demo MT5 note)
4. Wait for **Processing** → **Ready to Test** (often 10–30 minutes)

---

## Step 5 — Invite testers

**Internal testers** (up to 100, your team in ASC — instant, no Beta Review):

- Users and Access → invite emails → add to **Internal Testing** group

**External testers** (friends with demo accounts — needs Beta App Review once):

- TestFlight → **External Testing** → create group → add emails → submit for review

Testers install **TestFlight** from the App Store, accept the invite, install **XAUUSD Trader**.

They do **not** need Developer Mode.

---

## Step 6 — What to tell testers

1. Sign up in the app (email + password).
2. **Settings → MT5 Login** — use **demo** login, password, and server (not live money unless intended).
3. Trade tab — small lots on XAUUSD demo.
4. Report issues to you (screenshot + email).

**Admin:** cap members / invite code at `/api/admin?key=YOUR_KEY` → Membership.

---

## Troubleshooting

| Issue | Fix |
|--------|-----|
| Build fails signing | `eas credentials --platform ios` → production profile |
| Submit can’t find app | Create app in ASC with exact bundle `com.xauusdtrader.app` |
| Testers don’t see build | Build must be “Ready to Test”; external group needs Beta Review |
| App can’t connect API | Replit published; check `curl https://workspaceapi-server-production-4768.up.railway.app/api/system/status` |
| Old UI on TestFlight | New **production** build after merging latest `main` |

---

## Quick command recap

```bash
cd artifacts/mt5-trader
eas build --platform ios --profile production
eas submit --platform ios --latest
```

Then invite testers in App Store Connect → TestFlight.
