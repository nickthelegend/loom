#!/usr/bin/env bash
# Loom installer — clone, build, link. Usage:
#   curl -fsSL https://raw.githubusercontent.com/nickthelegend/loom/main/scripts/install.sh | bash
# Env overrides: LOOM_REPO (git url), LOOM_SRC (checkout dir).
set -euo pipefail

REPO="${LOOM_REPO:-https://github.com/nickthelegend/loom.git}"
SRC="${LOOM_SRC:-$HOME/.loom-src}"

say() { printf '\033[36m[loom]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[loom] %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node is required (>= 22.5) — https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm is required"

node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>22||(M===22&&m>=5)?0:1)' \
  || die "node $(node -v) is too old — Loom needs >= 22.5 (node:sqlite)"

if [ -d "$SRC/.git" ]; then
  say "updating $SRC"
  git -C "$SRC" pull --ff-only
else
  say "cloning $REPO → $SRC"
  git clone --depth 1 "$REPO" "$SRC"
fi

cd "$SRC"
say "installing dependencies"
npm install --no-fund --no-audit --loglevel=error
say "building"
npm run build >/dev/null
say "linking the loom command (may ask for sudo depending on your npm prefix)"
npm link >/dev/null

say "installed: $(command -v loom || echo 'loom (restart your shell)')"
say "next: cd your-project && loom init && loom"
say "phone: loom up --restart --tailnet && loom pair"
