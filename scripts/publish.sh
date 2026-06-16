#!/usr/bin/env bash
# Publish all PingPal packages to npm, in dependency order, after a clean
# build + test gate. pnpm rewrites `workspace:*` deps to real versions and
# publishes in topological order automatically.
#
# Prereqs (one-time):
#   - the `@pingpal` scope and the `pingpal` name must be available to you
#     (check: `npm view pingpal` / `npm view @pingpal/protocol` — a 404 = free)
#   - AUTH, one of:
#       (a) NPM_TOKEN=<granular token with bypass-2FA> bash scripts/publish.sh
#           — required if your account enforces 2FA on publish (recommended for
#             scripts: create at npmjs.com → Access Tokens → Granular, R/W).
#       (b) `npm login` first, IF your account does not require 2FA on publish.
#
# Usage:
#   NPM_TOKEN=npm_xxx bash scripts/publish.sh            # publish (token auth)
#   bash scripts/publish.sh --dry-run                    # pack only, publish nothing
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=""
if [[ "${1:-}" == "--dry-run" ]]; then DRY="--dry-run"; fi

# Token auth (bypasses 2FA). We write the token to a TEMP npmrc outside the repo
# and home dir, then point npm/pnpm at it via --userconfig / NPM_CONFIG_USERCONFIG.
# This makes our token the authoritative one and sidesteps a stale `npm login`
# session token in ~/.npmrc that would otherwise shadow it and cause a 403.
TMP_NPMRC=""
NPMRC_ARGS=()
if [[ -n "${NPM_TOKEN:-}" ]]; then
  TMP_NPMRC="$(mktemp -t pingpal-npmrc.XXXXXX)"
  chmod 600 "$TMP_NPMRC"
  {
    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}"
    echo "registry=https://registry.npmjs.org/"
  } > "$TMP_NPMRC"
  export NPM_CONFIG_USERCONFIG="$TMP_NPMRC"   # npm honors this
  NPMRC_ARGS=(--userconfig "$TMP_NPMRC")       # belt-and-suspenders for npm calls
  echo "==> Using NPM_TOKEN via a temp userconfig (overrides ~/.npmrc; bypasses 2FA)."
fi
cleanup() { [[ -n "$TMP_NPMRC" ]] && rm -f "$TMP_NPMRC"; }
trap cleanup EXIT

echo "==> Verifying npm auth (using the token if provided)…"
WHO="$(npm whoami "${NPMRC_ARGS[@]}" 2>/dev/null || true)"
if [[ -z "$WHO" ]]; then
  echo "Not authenticated. Set NPM_TOKEN=<granular token>, or run npm login."
  exit 1
fi
echo "    as $WHO"

# Fail fast: this account/registry requires a bypass token to publish (2FA
# enforced) and none was provided — don't burn a full build+test just to 403.
if [[ -z "${NPM_TOKEN:-}" && -z "$DRY" ]]; then
  echo
  echo "!! No NPM_TOKEN set, and your npm account requires a granular bypass token to publish."
  echo "   Re-run WITH the token in front:  NPM_TOKEN=npm_xxxx bash scripts/publish.sh"
  echo "   Create one: npmjs.com → Access Tokens → Granular → Read and write (+ 2FA bypass)."
  exit 1
fi

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
