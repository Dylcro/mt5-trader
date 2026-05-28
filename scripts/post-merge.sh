#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

echo ""
echo "Running dependency drift check…"
if ! pnpm --filter @workspace/scripts dep-drift; then
  echo ""
  echo "ERROR: Dependency check failed — unpinned catalog ranges detected."
  echo "Pin each flagged entry to an exact version (remove ^ or ~) and re-run."
  exit 1
fi
