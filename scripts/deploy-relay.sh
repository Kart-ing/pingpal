#!/usr/bin/env bash
# Deploy the PingPal relay to Fly.io and print the wss:// URL to use as the
# default relay (PINGPAL_RELAY / DEFAULT_RELAY_URL).
#
# Prereqs (one-time):
#   - install flyctl:  curl -L https://fly.io/install.sh | sh
#   - log in:          fly auth login
#
# Usage:
#   bash scripts/deploy-relay.sh <app-name>
# e.g.
#   bash scripts/deploy-relay.sh pingpal-relay-kartikey
#
# App names are GLOBAL on Fly, so pick a unique one. The relay ends up at
# wss://<app-name>.fly.dev — set that as PINGPAL_RELAY (and as the baked-in
# default via `node scripts/set-default-relay.mjs wss://<app-name>.fly.dev`).
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-}"
if [[ -z "$APP" ]]; then
  echo "Usage: bash scripts/deploy-relay.sh <unique-app-name>"
  echo "  (app names are global on Fly; e.g. pingpal-relay-<you>)"
  exit 1
fi

command -v fly >/dev/null 2>&1 || command -v flyctl >/dev/null 2>&1 || {
  echo "flyctl not found. Install:  curl -L https://fly.io/install.sh | sh"
  exit 1
}
FLY="$(command -v fly || command -v flyctl)"

"$FLY" auth whoami >/dev/null 2>&1 || { echo "Not logged in. Run: fly auth login"; exit 1; }

echo "==> Creating the Fly app '$APP' (if it doesn't exist)…"
"$FLY" apps create "$APP" 2>/dev/null || echo "    (app may already exist — continuing)"

echo "==> Deploying the relay (builds packages/relay/Dockerfile from repo root)…"
# Pass the app name on the CLI so we don't have to mutate the committed fly.toml.
"$FLY" deploy \
  --app "$APP" \
  --config packages/relay/fly.toml \
  --dockerfile packages/relay/Dockerfile \
  .

URL="wss://${APP}.fly.dev"
echo
echo "==> Deployed. Your relay:"
echo "      $URL"
echo
echo "Next:"
echo "  1) Bake it in as the default so \`npx pingpal\` works cold for everyone:"
echo "       node scripts/set-default-relay.mjs $URL"
echo "       pnpm -r build && bash scripts/publish.sh"
echo "  2) Or just point yourself + a friend at it for now:"
echo "       export PINGPAL_RELAY=$URL   # then pingpal init / join"
echo
echo "Smoke test it:"
echo "  PINGPAL_RELAY=$URL pingpal start && pingpal status"
