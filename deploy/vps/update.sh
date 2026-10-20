#!/usr/bin/env bash
# Updates the server to the latest code on GitHub (branch main): backup, git pull, rebuild, restart.
# deploy/.env and the database are kept; migrations run when the app container starts.
# Usage (as root):  bash /opt/manara/app/deploy/vps/update.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.yml" --env-file "$ROOT/deploy/.env")

before="$(git -C "$ROOT" rev-parse --short HEAD)"
git -C "$ROOT" fetch --quiet origin main
after="$(git -C "$ROOT" rev-parse --short origin/main)"
if [ "$before" = "$after" ]; then
  echo "Already up to date ($before)."
  exit 0
fi
echo "Updating $before -> $after:"
git -C "$ROOT" log --oneline "$before..$after"

if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx backup; then
  echo "Backup before the update..."
  "${COMPOSE[@]}" exec -T backup sh /backup.sh --once
fi

git -C "$ROOT" merge --ff-only --quiet origin/main
# Build and restart with the new code's deploy.sh.
exec bash "$ROOT/deploy/vps/deploy.sh"
