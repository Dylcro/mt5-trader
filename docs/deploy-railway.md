# Deploy API server to Railway

Use this instead of Replit **Publishing** when the monorepo keeps failing `pnpm install` on Replit. The phone app only needs a stable HTTPS API URL.

## What Railway runs

- **Dockerfile** at repo root: installs `@workspace/api-server` only (no Expo), starts with `tsx`.
- **Health check:** `GET /healthz` → `{"status":"ok"}` (or `unhealthy` if streams are idle).
- **Postgres:** Railway plugin sets `DATABASE_URL` automatically.

## 1. Create the project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Select **mt5-trader**.
3. Branch: **`cursor/bugfix-batch`** (or `main` after merge).
4. Railway should detect **`Dockerfile`** / `railway.toml`.

## 2. Add PostgreSQL

1. In the project → **+ New** → **Database** → **PostgreSQL**.
2. Open your **API service** → **Variables** → **Add reference** → link **`DATABASE_URL`** from the Postgres service.

Tables are created on startup by `artifacts/api-server/src/index.ts` (`ensureTables`).

## 3. Required environment variables

Copy values from your working Replit **Secrets** / deployment config:

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | Yes | From Postgres plugin (reference) |
| `METAAPI_TOKEN` | Yes | MetaAPI cloud token |
| `ADMIN_KEY` | Yes | Strong secret; also used as JWT signing key in current code |
| `PORT` | Auto | Railway sets this; Dockerfile defaults to `8080` |

Optional (if you use them on Replit):

| Variable | Notes |
|----------|--------|
| `STREAM_FRESHNESS_MS` | Default `60000` |
| `CASCADE_CONFIG_OVERRIDE` | JSON override for cascade config |

## 4. Deploy

1. **Deploy** (or push to the connected branch).
2. Open **Settings** → **Networking** → **Generate domain** (e.g. `mt5-trader-production.up.railway.app`).
3. Check logs for: `Server listening on port …`
4. Test: `https://YOUR-DOMAIN.up.railway.app/healthz`

## 5. Point the mobile app at Railway

When the API works, update **`artifacts/mt5-trader/eas.json`** (all profiles):

```json
"EXPO_PUBLIC_API_URL": "https://YOUR-DOMAIN.up.railway.app/api"
```

Rebuild iOS preview:

```bash
cd artifacts/mt5-trader
pnpm exec eas build --platform ios --profile preview --non-interactive
```

CORS already allows `*.up.railway.app` and your `RAILWAY_PUBLIC_DOMAIN`.

## 6. Cutover from Replit

| Step | Action |
|------|--------|
| Keep Replit running | Old app builds still hit `meta-trader-link.replit.app` until you change `eas.json` |
| New users / test | Use Railway URL in a new EAS build |
| Database | Railway Postgres is **empty** unless you migrate data from Replit (pg dump/restore) |
| DNS | Optional custom domain in Railway → update `eas.json` again |

## 7. Troubleshooting

| Issue | Fix |
|-------|-----|
| Build fails in Docker | Check build logs; ensure branch has `Dockerfile` |
| `DATABASE_URL must be set` | Link Postgres `DATABASE_URL` to the service |
| `METAAPI_TOKEN` / `ADMIN_KEY` errors | Add secrets in Railway Variables |
| App can’t connect | Confirm `EXPO_PUBLIC_API_URL` ends with `/api` |
| CORS error | Redeploy after setting domain; `RAILWAY_PUBLIC_DOMAIN` is added automatically |

## Local smoke (optional)

```bash
export DATABASE_URL=postgresql://127.0.0.1:5432/mt5_trader
export METAAPI_TOKEN=...
export ADMIN_KEY=...
export PORT=8080
pnpm --filter @workspace/api-server exec tsx ./src/index.ts
curl -s http://127.0.0.1:8080/healthz
```
