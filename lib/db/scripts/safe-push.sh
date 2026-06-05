#!/usr/bin/env bash
# Preview drizzle-kit push and abort if any destructive SQL is proposed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required"
  exit 1
fi

echo "[safe-push] Previewing schema diff…"
OUTPUT="$(pnpm exec drizzle-kit push --explain --config ./drizzle.config.ts 2>&1)" || true
printf '%s\n' "$OUTPUT"

if printf '%s' "$OUTPUT" | grep -qiE 'DROP[[:space:]]+(TABLE|COLUMN)'; then
  echo ""
  echo "ERROR: Destructive migration blocked (DROP detected)."
  echo "Do not apply. Use api-server ensureTables on boot, or reconcile schema manually."
  exit 1
fi

echo ""
echo "[safe-push] No destructive changes — run 'pnpm run push-apply' to apply additive diff only."
