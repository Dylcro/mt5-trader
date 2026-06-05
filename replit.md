# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

**Do not use `drizzle-kit push` on Replit production.** Schema is applied at api-server boot via `ensureTables` (`ADD COLUMN IF NOT EXISTS` only). Replit may still show a Database migration prompt on Publish — **always cancel/skip** if it contains any `DROP`. `pnpm --filter @workspace/db run push` only previews the diff and blocks destructive SQL; use `push-apply` manually in dev only when the preview is additive.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `artifacts/mt5-trader` (`@workspace/mt5-trader`)

Expo React Native mobile app for trading XAUUSD (Gold) on MetaTrader 5 via MetaAPI.

- Dark theme: gold `#C9A84C`, buy `#0ECB81`, sell `#F6465D`
- Features: live price feed, cascade ladder orders, single buy/sell, positions viewer
- Key files: `app/(tabs)/index.tsx` (trading), `app/(tabs)/positions.tsx`, `app/(tabs)/settings.tsx`
- State: `context/TradingContext.tsx` — all API calls, connection state, region-aware
- Settings: `hooks/useCascadeSettings.ts`
- API URL baked in via `EXPO_PUBLIC_API_URL=https://$REPLIT_DEV_DOMAIN/api`

### MetaAPI Integration (api-server)

The API server proxies MetaTrader 5 operations through MetaAPI Cloud.

**Critical DNS note**: From the Replit environment, `mt-provisioning-api-v1.agiliumtrade.ai` does NOT resolve (ENOTFOUND). Use the correct URL: `mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai` (double subdomain — this is MetaAPI's current working hostname). The client API `mt-client-api-v1.{region}.agiliumtrade.ai` resolves fine.

- Provisioning base: `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai`
- Client base: `https://mt-client-api-v1.{region}.agiliumtrade.ai`
- Region is returned from `/connect` and stored in AsyncStorage; passed as `?region=` query param on all subsequent calls
- `METAAPI_TOKEN` env secret is required

## Troubleshooting

### Status page
Visit `/status?key=YOUR_ADMIN_KEY` for a live health dashboard that shows:
- MetaAPI stream health per account (live / stale / silent duration)
- Open and risk-free zone counts
- Recent trade failures (last 20, with broker error code + message)
- Rate-limit hit count (broker code 10024)

The same data is available as JSON at `/api/admin/status?key=YOUR_ADMIN_KEY` for scripting or monitoring integrations. Check here first when debugging stream or trade issues.

## Deployment

### Target: Reserved VM (always-warm)

The API server is deployed as a **Reserved VM** (`deploymentTarget = "vm"` in `artifacts/api-server/.replit-artifact/artifact.toml`). This keeps the Node process running 24/7 so:

- MetaAPI streaming WebSockets stay connected between user sessions — no 30–50s cold-start reconnect on first request after idle.
- In-memory state (`zoneStates`, `activeConnections`, rate counters) is preserved across requests.
- Zone monitor ticks fire on a steady cadence even when no users are active.

A Reserved VM costs more than Autoscale but is required for this app because it holds persistent WebSocket connections. The Autoscale target would scale the server to zero on idle, disconnecting all streams and losing in-memory state.

### Health check

`GET /api/healthz` is wired as the startup health check in `artifact.toml`. It returns `{ "status": "ok" }` when the server is up. A separate stream-health endpoint (`GET /api/healthz/stream`) is planned (Task #43) to auto-restart the pod when MetaAPI streaming goes silent.

### Publish

To publish a new version: verify workflows are running cleanly, then click **Publish** in the Replit UI. Publishing builds the esbuild bundle (`pnpm --filter @workspace/api-server run build`), then starts the VM with `node artifacts/api-server/dist/index.cjs`.

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
