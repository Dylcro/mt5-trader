#!/usr/bin/env bash
# Replit API Server publish — install only api-server graph (skip Expo/mobile bins).
set -euxo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "[replit-api-build] ROOT=$ROOT"

export CI=true
export npm_config_user_agent='pnpm/10.0.0'
# Build does not need a real DB; runtime uses Replit DATABASE_URL secret.
export DATABASE_URL="${DATABASE_URL:-postgresql://127.0.0.1:5432/replit_build}"

echo "[replit-api-build] pnpm install (api-server only)..."
pnpm install --frozen-lockfile --config.minimumReleaseAge=0 --filter @workspace/api-server...

echo "[replit-api-build] esbuild api-server..."
pnpm --filter @workspace/api-server run build:replit

echo "[replit-api-build] OK"
