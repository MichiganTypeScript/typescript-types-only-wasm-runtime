#!/bin/sh
# `bun check` - Bun's built-in TypeScript checker.
# In canary (>=1.4.3); NOT in stable 1.4.2. BUN_CHECK_BIN overrides the binary.
D=$(cd "$(dirname "$0")" && pwd)
BIN=${BUN_CHECK_BIN:-$D/canary/bun-darwin-aarch64/bun}
have() { [ -x "$1" ] && "$1" check --help 2>&1 | grep -q "Type check a TypeScript project"; }
if ! have "$BIN"; then
  if command -v bun >/dev/null 2>&1 && have "$(command -v bun)"; then BIN=$(command -v bun)
  else (cd "$D" && curl -sL -o canary.zip https://github.com/oven-sh/bun/releases/download/canary/bun-darwin-aarch64.zip \
          && unzip -oq canary.zip -d canary && rm -f canary.zip) >/dev/null 2>&1
       BIN=$D/canary/bun-darwin-aarch64/bun; fi
fi
[ "$1" = "--probe" ] && { have "$BIN" && echo "AVAILABLE bun $("$BIN" --version) canary" || echo "UNAVAILABLE: no bun with a 'check' subcommand (stable 1.4.2 has none)"; exit 0; }
"$BIN" check --no-pretty --all -p "$1" 2>&1
