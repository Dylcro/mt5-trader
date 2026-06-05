#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Do NOT run drizzle-kit push here. The api-server applies schema at boot via
# ensureTables (ADD COLUMN IF NOT EXISTS only). drizzle push can propose
# destructive DROPs when Replit/DB drift — never auto-apply it.
echo "[post-merge] Verifying Drizzle schema (no push)…"
pnpm --filter @workspace/db run verify-schema

echo ""
echo "Running dependency drift check…"

# Capture stdout+stderr so we can both display it and pass context to the
# notification script.  The `if !` guard prevents set -e from aborting here.
DEP_DRIFT_OUTPUT=""
DEP_DRIFT_FAILED=0
if ! DEP_DRIFT_OUTPUT=$(pnpm --filter @workspace/scripts dep-drift 2>&1); then
  DEP_DRIFT_FAILED=1
fi

# Always print the dep-drift output so CI logs stay readable.
printf '%s\n' "$DEP_DRIFT_OUTPUT"

if [ "$DEP_DRIFT_FAILED" -eq 1 ]; then
  echo ""
  echo "ERROR: Dependency check failed — unpinned catalog ranges detected."
  echo "Pin each flagged entry to an exact version (remove ^ or ~) and re-run."

  # Send a push notification to all registered devices (best-effort).
  # Pipe the dep-drift output so the script can surface the exact packages.
  # `|| true` ensures a notification failure never masks the real exit code.
  printf '%s' "$DEP_DRIFT_OUTPUT" \
    | pnpm --filter @workspace/scripts notify-dep-drift-fail 2>&1 \
    || true

  exit 1
fi
