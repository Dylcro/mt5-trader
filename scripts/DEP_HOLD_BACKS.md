# Dependency Hold-Backs

Packages deliberately held below their latest version, with reasons.
Update this file whenever a hold-back is added, removed, or the reason changes.

---

## Major-version upgrades requiring dedicated code changes

These packages have breaking API changes that cannot be applied automatically.
Each needs its own focused migration task.

| Package | Pinned | Latest | Reason |
|---------|--------|--------|--------|
| `vite` | 7.x | 8.x | Vite 8 drops several plugin APIs and changes the dev-server startup contract. Upgrade together with `@vitejs/plugin-react`. |
| `@vitejs/plugin-react` | 5.x | 6.x | v6 requires Vite 8. Upgrade together with `vite`. |
| `zod` | 3.x | 4.x | Zod 4 is a complete API redesign (`z.string().email()` → `z.email()`, etc.). All schemas in `lib/api-zod`, `lib/db`, and everywhere `zod` is imported need migration. |
| `zod-validation-error` | 3.x | 5.x | API changes alongside Zod 4. Migrate together with `zod`. |
| `typescript` | 5.x | 6.x | TypeScript 6 introduces stricter rules that surface new errors in the existing codebase. Needs a dedicated audit. |
| `lucide-react` | 0.x | 1.x | v1.0 renamed and removed many icons. Requires a full grep of all icon imports across the codebase before upgrading. |
| `recharts` | 2.x | 3.x | Recharts 3 changed the chart component API. Requires updating every chart in the mockup-sandbox. |
| `react-day-picker` | 9.x | 10.x | Breaking API changes to the picker component interface. |
| `react-resizable-panels` | 2.x | 4.x | Large version jump with breaking layout and prop changes. |
| `@hookform/resolvers` | 3.x | 5.x | Breaking resolver API changes; coordinate with `react-hook-form` testing. |
| `chokidar` | 4.x | 5.x | Breaking API changes in the file-watcher interface. |
| `date-fns` | 3.x | 4.x | Breaking formatting and locale API changes in v4. |

---

## Expo SDK ecosystem (upgrade as a coordinated bundle)

The mobile app (`artifacts/mt5-trader`) is on **Expo SDK 54 / React Native 0.81**.
All of the packages below must be upgraded together when the SDK is bumped.
Upgrading individual packages ahead of the SDK causes incompatible native module
ABI mismatches and Metro bundler errors.

Affected packages (all pinned in `artifacts/mt5-trader/package.json`):

| Package | Pinned | Latest |
|---------|--------|--------|
| `expo` | 54.0.33 | 56.x |
| `@expo/cli` | 54.0.23 | 56.x |
| `expo-auth-session` | 7.0.11 | 56.x |
| `expo-blur` | 15.0.8 | 56.x |
| `expo-constants` | 18.0.13 | 56.x |
| `expo-crypto` | 15.0.9 | 56.x |
| `expo-device` | 8.0.10 | 56.x |
| `expo-font` | 14.0.11 | 56.x |
| `expo-glass-effect` | 0.1.9 | 56.x |
| `expo-haptics` | 15.0.8 | 56.x |
| `expo-image` | 3.0.11 | 56.x |
| `expo-image-picker` | 17.0.10 | 56.x |
| `expo-linear-gradient` | 15.0.8 | 56.x |
| `expo-linking` | 8.0.11 | 56.x |
| `expo-location` | 19.0.8 | 56.x |
| `expo-notifications` | 0.32.17 | 56.x |
| `expo-router` | 6.0.23 | 56.x |
| `expo-secure-store` | 15.0.8 | 56.x |
| `expo-splash-screen` | 31.0.13 | 56.x |
| `expo-status-bar` | 3.0.9 | 56.x |
| `expo-symbols` | 1.0.8 | 56.x |
| `expo-system-ui` | 6.0.9 | 56.x |
| `expo-web-browser` | 15.0.10 | 56.x |
| `react-native` | 0.81.5 | 0.85.x |
| `react-native-gesture-handler` | 2.28.0 | 2.31.x |
| `react-native-keyboard-controller` | 1.21.0 | 1.21.x |
| `react-native-reanimated` | 4.1.6 | 4.4.x |
| `react-native-safe-area-context` | 5.6.2 | 5.8.x |
| `react-native-screens` | 4.16.0 | 4.25.x |
| `react-native-svg` | 15.12.1 | 15.15.x |
| `react-native-webview` | 13.15.0 | 13.16.x |
| `react-native-worklets` | 0.5.1 | 0.9.x |
| `@react-native-async-storage/async-storage` | 2.2.0 | 3.x (also major) |
| `@react-native-community/slider` | 5.0.1 | 5.2.x |
| `@clerk/expo` | 3.2.14 | 3.2.16 |
| `react` | 19.1.0 | 19.2.x | Expo SDK 54 requires exactly 19.1.0 (noted in `pnpm-workspace.yaml` catalog) |
| `react-dom` | 19.1.0 | 19.2.x | Same as `react` |
| `@types/react` | 19.1.17 | 19.2.x | Pinned directly in `mt5-trader/package.json` to match the Expo-required React version; catalog entry is already at latest |
| `@types/react-dom` | 19.1.11 | 19.2.x | Same as `@types/react` — mt5-trader direct pin |

---

## False positives (no real update available)

| Package | Reported | Actual status |
|---------|----------|--------------|
| `@types/bcryptjs` | 3.0.0 → 3.0.0 | Deprecated upstream; pnpm reports it as outdated even though latest is the same version. No upgrade path exists — switch to the types bundled in `bcryptjs` 3.x directly when convenient. |

---

## Overrides held for compatibility

| Package | Overridden to | Latest | Reason |
|---------|--------------|--------|--------|
| `esbuild` | 0.27.3 | 0.28.x | Override in `pnpm-workspace.yaml` replaces the vulnerable esbuild bundled inside `drizzle-kit`. Bump only after confirming drizzle-kit 0.31.x works with esbuild 0.28. |
