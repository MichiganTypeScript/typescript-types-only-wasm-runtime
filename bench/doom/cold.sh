#!/bin/sh
# One Doom chunk, checked cold by each checker's CLI: parse the module, resolve
# the chunk, exit. This is the only way to time `bun check`, which has no API
# to keep a program alive between chunks, so the driver can't run on it.
#
# TS7 dumps chunk 2 from `e1m1.json.gz` (DUMP_CHUNKS in cfg/drive.ts). The
# probe line `const __probe: $Out_Tag = 12345` makes the checker resolve the
# whole chunk to report the error; a checker that ran the chunk prints
# `not assignable to type '"s"'` (suspended). A checker that hits TS2589 at
# FUEL is retried at lower fuel, bisected, so the row shows the most it holds.
#
# Usage: ./cold.sh [fuel=12288]   CHECKERS="ts7 tsrs tsc-rs bun ts6"
set -e
cd "$(dirname "$0")"
FUEL=${1:-12288}; CHECKERS=${CHECKERS:-ts7 tsrs tsc-rs bun ts6}
REPO=$(cd ../.. && pwd); PG=$REPO/packages/playground
D=$(pwd)/.work/cold; rm -rf "$D"; mkdir -p "$D"
gzip -dc e1m1.json.gz > "$D/seed.json"
(cd "$PG" && DUMP_CHUNKS="$D" node --stack-size=16384 --max-old-space-size=16384 --import tsx/esm \
  ./cfg/drive.ts ./doom/doom-keys.cfg.ts entry --resume "$D/seed.json" --max 2 --fuel "$FUEL") >/dev/null 2>&1
# module.d.ts imports ts-type-math through the root tsconfig's `paths`
cat > "$D/tsconfig.json" <<EOF
{"extends": "$REPO/tsconfig.json", "compilerOptions": {"incremental": false},
 "files": ["$REPO/global.d.ts", "module.d.ts", "chunk-0001.state.d.ts", "probe.ts"]}
EOF
probe() { python3 - "$D" "$1" <<'PY'
import sys
d, n = sys.argv[1], int(sys.argv[2])
head, rest = open(f"{d}/chunk-0001.ts").read().split("\n", 1)
segs = ["1" * min(400, n - i) for i in range(0, n, 400)]  # FUEL_SEGMENT in drive.ts
open(f"{d}/probe.ts", "w").write(f"type $FUEL = '{'x'.join(segs)}'\n{rest}\nexport const __probe: $Out_Tag = 12345;\n")
PY
}
bin() { (cd "$PG" && node -p "require('path').join(require.resolve('$1/package.json'), '..', require('$1/package.json').bin['$2'])"); }
ver() { (cd "$PG" && node -p "require('$1/package.json').version"); }
cmd() { case $1 in
  ts6) echo "node --stack-size=16384 --max-old-space-size=16384 $(bin typescript-6 tsc) -p ." ;;
  ts7) echo "node $(bin typescript tsc) -p ." ;;
  tsrs) echo "$(bin tsrs tsrs) -p ." ;;
  tsc-rs) echo "$(bin tsc-rs tsc-rs) -p ." ;;
  bun) echo "bun check -p . --no-pretty" ;;
esac; }
v() { case $1 in ts6) ver typescript-6 ;; ts7) ver typescript ;; bun) bun --version ;; *) ver "$1" ;; esac; }
run() { # fuel -> "ok seconds" | "deep seconds" | "fail seconds"
  probe "$2"; s=$(python3 -c 'import time; print(time.time())')
  out=$(cd "$D" && $(cmd "$1") 2>&1 || true)
  t=$(python3 -c "import time; print(f'{time.time() - $s:.2f}')")
  case $out in *TS2589*) echo "deep $t" ;; *"type '\"s\"'"*) echo "ok $t" ;; *) echo "fail $t" ;; esac
}
printf '%-7s %-28s %6s %8s\n' TS version fuel cold_s
for ts in $CHECKERS; do
  f=$FUEL; set -- $(run "$ts" "$f")
  if [ "$1" = deep ]; then # bisect the highest fuel that does not hit TS2589
    lo=0; hi=$f
    while [ $((hi - lo)) -gt 64 ]; do m=$(((lo + hi) / 2)); set -- $(run "$ts" "$m"); [ "$1" = ok ] && lo=$m || hi=$m; done
    f=$lo; set -- $(run "$ts" "$f")
  fi
  printf '%-7s %-28s %6s %8s%s\n' "$ts" "$(v "$ts")" "$f" "$2" "$([ "$1" = ok ] || echo "  $1")"
done
