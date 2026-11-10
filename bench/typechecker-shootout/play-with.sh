#!/bin/sh
# Run the actual game with a chosen type checker.
#
#   ./play-with.sh tsgo       # the checker the project ships with
#   ./play-with.sh tsrs       # Rust port, 1.5x faster per chunk (API blocker, see README)
#   ./play-with.sh tsc-rs     # Rust port of TS7
#   ./play-with.sh bun        # bun check  (will fail: no type-printing API)
#
# Mechanism: packages/playground/evaluate/ts.ts honours $TSGO_BIN as the
# checker binary (sync API, `tsserverPath`). Anything that speaks that protocol
# can drive the game; see README for who does.
#
# Extra args are passed to the driver, e.g. `./play-with.sh tsgo --max 5`.
set -e
cd "$(dirname "$0")"
C=${1:?usage: ./play-with.sh <tsgo|tsc-rs|bun> [driver args...]}; shift || true
REPO=$(cd ../.. && pwd)

case "$C" in
  tsgo)   BIN=$(ls -d "$REPO"/node_modules/.pnpm/@typescript+typescript-darwin-arm64@*/node_modules/@typescript/typescript-darwin-arm64/lib/tsc | head -1) ;;
  tsrs)   candidates/tsrs/adapter.sh --probe >/dev/null
          BIN=$(pwd)/candidates/tsrs/bin/tsrs
          # the sync client spawns `<bin> api ...` on older clients and `--api` on newer;
          # tsrs only knows --api, so hand the driver a translating shim
          SHIM=$(pwd)/candidates/tsrs/api-shim.sh
          printf '#!/bin/sh\nBIN="%s"\nif [ "$1" = "api" ]; then shift; exec "$BIN" --api "$@"; fi\nexec "$BIN" "$@"\n' "$BIN" > "$SHIM"
          chmod +x "$SHIM"; BIN=$SHIM ;;
  tsc-rs) candidates/tsc-rs/adapter.sh --probe >/dev/null
          BIN=$(ls -d candidates/tsc-rs/node_modules/@tsc-rs/*/lib/tsc | head -1); BIN=$(cd "$(dirname "$BIN")" && pwd)/tsc ;;
  bun)    echo "bun check cannot drive the game: it is a CLI checker with no API to resolve"
          echo "and print a type, which is how the driver reads results back (README, req. 2)."
          exit 2 ;;
  typerunner) echo "TypeRunner is not compatible; see candidates/typerunner/BUILD-NOTES.txt"; exit 2 ;;
  *) echo "unknown candidate: $C"; exit 2 ;;
esac
[ -x "$BIN" ] || { echo "no binary for $C (run pnpm install at the repo root)"; exit 1; }
echo "# $C -> $BIN"
echo "# $("$BIN" --version)"

# No driver args: play for real (browser UI on :8787). With args: run headless.
if [ $# -eq 0 ]; then
  echo "# starting the game; open http://localhost:8787"
  cd "$REPO/packages/playground" && TSGO_BIN="$BIN" exec pnpm start
else
  S=$(mktemp -d); gzip -dc "$REPO/packages/playground/doom/first-frame.json.gz" > "$S/seed.json"
  cd "$REPO/packages/playground"
  TSGO_BIN="$BIN" exec node --stack-size=16384 --max-old-space-size=16384 --import tsx/esm \
    ./cfg/drive.ts ./doom/doom-keys.cfg.ts entry --resume "$S/seed.json" "$@"
fi
