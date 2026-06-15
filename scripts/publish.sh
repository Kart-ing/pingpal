#!/usr/bin/env bash
# Publish all PingPal packages to npm, in dependency order, after a clean
# build + test gate. pnpm rewrites `workspace:*` deps to real versions and
# publishes in topological order automatically.
#
# Prereqs (one-time):
#   - `npm login` (publishes under your account)
#   - the `@pingpal` scope and the `pingpal` name must be available to you
#     (check: `npm view pingpal` / `npm view @pingpal/protocol` — a 404 = free)
#
# Usage:
#   bash scripts/publish.sh            # publish current versions
#   bash scripts/publish.sh --dry-run  # pack only, publish nothing
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=""
if [[ "${1:-}" == "--dry-run" ]]; then DRY="--dry-run"; fi

echo "==> Verifying you're logged in to npm…"
npm whoami >/dev/null 2>&1 || { echo "Not logged in. Run: npm login"; exit 1; }
echo "    as $(npm whoami)"

echo "==> Clean build…"
pnpm -r build

echo "==> Test gate…"
pnpm -r test

echo "==> Publishing packages (pnpm handles order + workspace: rewriting)…"
# --no-git-checks: we may publish from a feature branch / dirty tree intentionally.
# --access public: scoped packages default to restricted otherwise.
pnpm -r publish --access public --no-git-checks $DRY

echo
if [[ -n "$DRY" ]]; then
  echo "Dry run complete — nothing was published."
else
  echo "Published. Try it cold:  npx pingpal@latest init"
fi
