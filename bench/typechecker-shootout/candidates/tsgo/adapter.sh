#!/bin/sh
# tsgo - TypeScript 7 native (Go), the checker this project ships with.
# Prefers a git build of microsoft/typescript-go (archived Sept 2026; TS7 work
# continues in microsoft/TypeScript), falls back to the pnpm-installed release.
D=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$D/../../../.." && pwd)
BIN=${TSGO_BUILD_BIN:-$D/bin/tsgo}
if [ ! -x "$BIN" ]; then
  if command -v go >/dev/null 2>&1; then
    [ -d "$D/src" ] || git clone --depth 1 https://github.com/microsoft/typescript-go.git "$D/src" >/dev/null 2>&1
    mkdir -p "$D/bin" && (cd "$D/src" && go build -o "$D/bin/tsgo" ./cmd/tsgo >/dev/null 2>&1)
  fi
  [ -x "$D/bin/tsgo" ] || BIN=$(ls -d "$REPO"/node_modules/.pnpm/@typescript+typescript-darwin-arm64@*/node_modules/@typescript/typescript-darwin-arm64/lib/tsc 2>/dev/null | head -1)
fi
[ -x "$BIN" ] || BIN=$(ls -d "$REPO"/node_modules/.pnpm/@typescript+typescript-darwin-arm64@*/node_modules/@typescript/typescript-darwin-arm64/lib/tsc 2>/dev/null | head -1)
[ "$1" = "--probe" ] && { [ -x "$BIN" ] && echo "AVAILABLE $("$BIN" --version)" || echo "UNAVAILABLE: need go, or pnpm install at the repo root"; exit 0; }
"$BIN" -p "$1" 2>&1
