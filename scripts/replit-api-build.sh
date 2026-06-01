#!/usr/bin/env bash
# Replit API Server publish — install only api-server graph (skip Expo/mobile bins).
set -euo pipefail
cd "$(dirname "$0")/.."
export CI=true
export npm_config_user_agent='pnpm/10.0.0'
pnpm install --frozen-lockfile --filter @workspace/api-server...
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run build:replit
