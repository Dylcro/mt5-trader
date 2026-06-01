# Deploy API server to Railway

Use this instead of Replit **Publishing** when the monorepo keeps failing `pnpm install` on Replit. The phone app only needs a stable HTTPS API URL.

## Why Railway created 5 services

Importing this repo as a **pnpm workspace** makes Railway auto-stage one service per package (`api-server`, `mt5-trader`, `mockup-sandbox`, etc.). Only **`@workspace/api-server`** should deploy.

## 1. Keep one service, delete the rest

In the Railway project canvas:

1. **Keep** the service for `@workspace/api-server` (rename it **api-server** if you like).
2. **Delete** every other auto-created service (mt5-trader, mockup-sandbox, onboarding-demo, scripts, …):  
   Service → **Settings** → scroll to **Danger** → **Delete Service**.

## 2. Configure the api-server service

| Setting | Value |
|--------|--------|
| **Root Directory** | *(empty — repository root `/`)* |
| **Builder** | **Dockerfile** |
| **Dockerfile path** | `Dockerfile` |
| **Branch** | `main` |

Do **not** set Root Directory to `artifacts/api-server`. The API depends on `lib/*` and workspace files at the repo root; Docker copies `artifacts/api-server` + `lib` from `/`.

**Watch paths** (optional; also in `railway.toml`):

```text
artifacts/api-server/**
lib/**
Dockerfile
railway.toml
package.json
pnpm-lock.yaml
```

### If build logs show Railpack / Nixpacks (wrong)

Symptoms:

- `Scope: all 10 workspace projects`
- `export:web` or Expo errors
- Building `mockup-sandbox` or `mt5-trader`

**Fix:** Settings → Build → **Builder = Dockerfile** (not Railpack/Nixpacks). Redeploy.

### If you must use Nixpacks (no Docker)

Root Directory = `/` (empty). Override commands:

| Field | Command |
|-------|---------|
| **Build** | `CI=true npm_config_user_agent=pnpm/10.0.0 pnpm install --frozen-lockfile --filter @workspace/api-server...` |
| **Start** | `pnpm --filter @workspace/api-server exec tsx ./src/index.ts` |

Repo includes `nixpacks.toml` with the same intent. Do **not** use `pnpm --filter @workspace/api-server run build` as the deploy build unless Builder is Dockerfile (that was the old script that pulled Expo).

## 3. Add PostgreSQL

1. Project → **+ New** → **Database** → **PostgreSQL**.
2. Open **api-server** → **Variables** → **Add reference** → `DATABASE_URL` from Postgres.

Tables are created on startup (`ensureTables` in `artifacts/api-server/src/index.ts`).

## 4. Required environment variables

Copy values from working Replit **Secrets**:

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | **Yes** | Reference from Postgres plugin |
| `METAAPI_TOKEN` | **Yes** | MetaAPI cloud token |
| `ADMIN_KEY` | **Yes** | Strong secret; JWT signing + admin routes (server **won’t start** if missing/placeholder) |
| `PORT` | Auto | Railway sets this; image defaults to `8080` |

Optional:

| Variable | Notes |
|----------|--------|
| `STREAM_FRESHNESS_MS` | Default `60000` |
| `CASCADE_CONFIG_OVERRIDE` | JSON override for cascade config |
| `RAILWAY_PUBLIC_DOMAIN` | Set automatically when you add a public domain |

Clerk packages are in `package.json` but no `CLERK_*` env is required for current routes.

## 5. Deploy and verify

1. **Deploy** (or push to `main`).
2. **Settings** → **Networking** → **Generate domain**.
3. Logs should show: `Server listening on port …`
4. Test: `https://YOUR-DOMAIN.up.railway.app/healthz` → `{"status":"ok"}` (or unhealthy if no MT5 streams yet).

## 6. Point the mobile app at Railway

Update `artifacts/mt5-trader/eas.json` (all profiles):

```json
"EXPO_PUBLIC_API_URL": "https://YOUR-DOMAIN.up.railway.app/api"
```

Rebuild:

```bash
cd artifacts/mt5-trader
pnpm exec eas build --platform ios --profile preview --non-interactive
```

CORS allows `*.up.railway.app` and `RAILWAY_PUBLIC_DOMAIN`.

## 7. Troubleshooting

| Issue | Fix |
|-------|-----|
| Five services, all failed | Delete extras; keep api-server; use Dockerfile builder |
| Root Directory `artifacts/api-server` | Clear it (use repo root) |
| `METAAPI_TOKEN is not configured` | Add `METAAPI_TOKEN` variable |
| `ADMIN_KEY environment variable is required` | Add `ADMIN_KEY` (not `changeme`) |
| `DATABASE_URL must be set` | Link Postgres `DATABASE_URL` |
| Build still runs Expo | Switch builder to **Dockerfile** |

## Local smoke (optional)

```bash
export DATABASE_URL=postgresql://127.0.0.1:5432/mt5_trader
export METAAPI_TOKEN=...
export ADMIN_KEY=...
export PORT=8080
pnpm --filter @workspace/api-server exec tsx ./src/index.ts
curl -s http://127.0.0.1:8080/healthz
```
