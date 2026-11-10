#!/bin/sh
# TypeRunner - C++ TS type checker (marcj/TypeRunner).
# TYPERUNNER_BIN overrides; otherwise we look for an npm build, then a source build.
D=$(cd "$(dirname "$0")" && pwd)
BIN=${TYPERUNNER_BIN:-$(ls "$D"/build/typerunner "$D"/src/build/typerunner 2>/dev/null | head -1)}
if [ "$1" = "--probe" ]; then
  [ -n "$BIN" ] && [ -x "$BIN" ] && { echo "AVAILABLE $BIN"; exit 0; }
  echo "UNAVAILABLE: see BUILD-NOTES.txt (npm typerunner@0.0.1 ships no binary or wasm; needs a cmake build from source)"
  exit 0
fi
[ -n "$BIN" ] && [ -x "$BIN" ] && "$BIN" "$1/index.ts" 2>&1 || echo "UNAVAILABLE"
