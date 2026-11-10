#!/bin/sh
# tsrs - Rust port of the TypeScript 7 type checker (github.com/maschwenk/tsrs).
# Builds from git HEAD (active development; npm releases lag). Needs cargo.
# TSRS_BIN overrides.
D=$(cd "$(dirname "$0")" && pwd)
BIN=${TSRS_BIN:-$D/bin/tsrs}
if [ ! -x "$BIN" ]; then
  [ -d "$D/src" ] || git clone --depth 1 https://github.com/maschwenk/tsrs.git "$D/src" >/dev/null 2>&1
  (cd "$D/src" && cargo build --release -p tsrs_cli >/dev/null 2>&1)
  mkdir -p "$D/bin" && cp "$D/src/target/release/tsrs" "$D/bin/tsrs" 2>/dev/null
  BIN=$D/bin/tsrs
fi
if [ "$1" = "--probe" ]; then
  if [ -x "$BIN" ]; then echo "AVAILABLE $("$BIN" --version 2>&1 | head -1)"
  else echo "UNAVAILABLE: build failed (needs cargo; prebuilt npm fallback: npm i @maschwenk/tsrs)"; fi
  exit 0
fi
"$BIN" -p "$1" 2>&1
