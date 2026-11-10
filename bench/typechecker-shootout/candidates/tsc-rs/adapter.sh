#!/bin/sh
# tsc-rs - Rust port of the TypeScript 7 compiler (github.com/pingdotgg/ts-rust,
# npm `tsc-rs`). Builds from git HEAD; falls back to the npm release.
D=$(cd "$(dirname "$0")" && pwd)
BIN=${TSC_RS_BIN:-$D/bin/tsc-rs}
if [ ! -x "$BIN" ]; then
  if command -v cargo >/dev/null 2>&1; then
    [ -d "$D/src" ] || git clone --depth 1 https://github.com/pingdotgg/ts-rust.git "$D/src" >/dev/null 2>&1
    (cd "$D/src" && cargo build --release >/dev/null 2>&1)
    mkdir -p "$D/bin"
    B=$(ls "$D"/src/target/release/goport "$D"/src/target/release/tsc-rs 2>/dev/null | head -1)
    [ -n "$B" ] && cp "$B" "$D/bin/tsc-rs"
  fi
  [ -x "$D/bin/tsc-rs" ] && BIN=$D/bin/tsc-rs || {
    [ -d "$D/node_modules" ] || (cd "$D" && npm init -y >/dev/null 2>&1 && npm i tsc-rs@latest --no-audit --no-fund >/dev/null 2>&1)
    BIN=$(ls "$D"/node_modules/@tsc-rs/*/lib/tsc 2>/dev/null | head -1); }
fi
[ "$1" = "--probe" ] && { [ -x "$BIN" ] && echo "AVAILABLE tsc-rs ($("$BIN" --version 2>&1 | head -1))" || echo "UNAVAILABLE: build and npm fallback both failed"; exit 0; }
"$BIN" -p "$1" 2>&1
