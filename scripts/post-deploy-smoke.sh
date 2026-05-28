#!/usr/bin/env bash
# Post-deploy smoke runner
#
# Starts the production server immediately (so Replit's /healthz startup check
# passes), then runs the full smoke suite against it in the background once it
# is healthy. Results are printed to deployment logs with a clear PASS/FAIL
# banner so regressions are immediately visible after every deploy.
#
# The server stays up regardless of smoke outcome — there is no automatic
# rollback in Replit VM deployments. If smoke fails, roll back manually via
# the Replit deployments dashboard.

set -e

PORT="${PORT:-8080}"
BASE="http://localhost:${PORT}"

echo "[startup] Starting production server on port ${PORT}"
node artifacts/api-server/dist/index.cjs &
SERVER_PID=$!

# ── Post-deploy smoke (background) ───────────────────────────────────────────
(
  echo "[post-deploy-smoke] Waiting for server to become healthy..."
  HEALTHY=false
  for i in $(seq 1 120); do
    if curl -sf "${BASE}/healthz" > /dev/null 2>&1; then
      HEALTHY=true
      echo "[post-deploy-smoke] Server healthy after ${i}s — starting smoke suite"
      break
    fi
    sleep 1
  done

  if [ "${HEALTHY}" = "false" ]; then
    echo "[post-deploy-smoke] ❌ Server did not become healthy within 120s — skipping smoke"
    exit 0
  fi

  if SMOKE_BASE_URL="${BASE}" \
     pnpm --filter @workspace/api-server run smoke 2>&1; then
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  ✅  POST-DEPLOY SMOKE PASSED — build verified   ║"
    echo "╚══════════════════════════════════════════════════╝"
  else
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║  ❌  POST-DEPLOY SMOKE FAILED — see logs above   ║"
    echo "║  Roll back via the Replit deployments dashboard  ║"
    echo "╚══════════════════════════════════════════════════╝"
  fi
) &

# Keep the server in the foreground — Replit monitors this process
wait "${SERVER_PID}"
