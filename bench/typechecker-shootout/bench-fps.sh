#!/bin/sh
# Game throughput (the fps question) for each checker that can actually drive it.
#
# Runs the real driver on the checked-in seed with a WARM checker session, which
# is how the game runs, and reports wasm-instructions/sec plus seconds/chunk.
# A checker that cannot speak the sync API is reported as blocked, with why.
#
# Usage: ./bench-fps.sh [chunks]        (default 12)
set -e
cd "$(dirname "$0")"
N=${1:-12}
REPO=$(cd ../.. && pwd); PG=$REPO/packages/playground
W=$(pwd)/.work; mkdir -p "$W"
gzip -dc "$PG/doom/first-frame.json.gz" > "$W/fps-seed.json"

printf '%-12s %-13s %-11s %-9s %s\n' CANDIDATE 'units/sec' 'sec/chunk' 'chunks' NOTE
for c in $(ls candidates); do
  case "$c" in
    tsgo)   BIN=$(ls -d "$REPO"/node_modules/.pnpm/@typescript+typescript-darwin-arm64@*/node_modules/@typescript/typescript-darwin-arm64/lib/tsc 2>/dev/null | head -1) ;;
    tsc-rs) BIN=$(ls -d candidates/tsc-rs/node_modules/@tsc-rs/*/lib/tsc 2>/dev/null | head -1) ;;
    *)      printf '%-12s %-13s %-11s %-9s %s\n' "$c" blocked - - "no sync-API type printing; cannot drive the game"; continue ;;
  esac
  if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
    printf '%-12s %-13s %-11s %-9s %s\n' "$c" blocked - - "binary not installed"; continue
  fi
  cp "$W/fps-seed.json" "$W/fps-run.json"
  out=$(cd "$PG" && TSGO_BIN="$BIN" node --stack-size=16384 --max-old-space-size=16384 --import tsx/esm \
          ./cfg/drive.ts ./doom/doom-keys.cfg.ts entry --resume "$W/fps-run.json" --max "$N" 2>&1 || true)
  line=$(printf '%s' "$out" | grep -oE "[0-9]+ chunks in [0-9.]+s \([0-9]+ fuel units, [0-9]+ units/s, fuel [0-9]+\)" | tail -1)
  if [ -z "$line" ]; then
    err=$(printf '%s' "$out" | grep -oE "Error: .*" | head -1)
    printf '%-12s %-13s %-11s %-9s %s\n' "$c" blocked - - "${err:-did not complete a chunk}"; continue
  fi
  us=$(printf '%s' "$line" | grep -oE '[0-9]+ units/s' | grep -oE '[0-9]+')
  secs=$(printf '%s' "$line" | grep -oE 'in [0-9.]+s' | grep -oE '[0-9.]+')
  spc=$(python3 -c "print(f'{$secs/$N:.2f}')")
  printf '%-12s %-13s %-11s %-9s %s\n' "$c" "$us" "$spc" "$N" "fuel 24576 (DEFAULT_FUEL), warm session"
done
cat <<'TXT'

units/sec = wasm instructions executed per second through the type system.
A doom frame is a few hundred thousand instructions, so fps ~= units/sec / ~295k.
TXT
