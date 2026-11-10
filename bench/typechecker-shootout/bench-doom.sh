#!/bin/sh
# Real workload: type-check ONE doom chunk with each candidate and time it.
#
# A chunk is the unit the game runs in: the generated 100MB+ module, the memory
# state as a literal type, and one forced resolution of $Out_Tag. The forced
# error also reveals the computed tag ("r" or "s"), so candidates can be
# compared for agreement, not just speed.
#
# Seed is the checked-in doom/first-frame.json.gz, so this reproduces anywhere.
# Usage: ./bench-doom.sh [fuel] [reps]      (default: 8192 3)
set -e
cd "$(dirname "$0")"
FUEL=${1:-8192}; REPS=${2:-3}
REPO=$(cd ../.. && pwd); PG=$REPO/packages/playground
W=$(pwd)/.work; D=$W/doom-$FUEL
mkdir -p "$W"

if [ ! -f "$D/chunk.ts" ]; then
  echo "# dumping a chunk at fuel $FUEL from doom/first-frame.json.gz"
  gzip -dc "$PG/doom/first-frame.json.gz" > "$W/seed.json"
  rm -rf "$W/raw-$FUEL"; mkdir -p "$W/raw-$FUEL"
  (cd "$PG" && DUMP_CHUNKS="$W/raw-$FUEL" node --stack-size=16384 --max-old-space-size=16384 \
      --import tsx/esm ./cfg/drive.ts ./doom/doom-keys.cfg.ts entry \
      --resume "$W/seed.json" --max 1 --fuel "$FUEL" --quiet > "$W/dump-$FUEL.log" 2>&1)
  mkdir -p "$D"
  cp "$W/raw-$FUEL/module.d.ts" "$W/raw-$FUEL/chunk-0000.state.d.ts" "$D/"
  cp "$W/raw-$FUEL/chunk-0000.ts" "$D/chunk.ts"
  # force resolution; the resulting error prints the computed tag
  printf 'declare const __t: $Out_Tag;\nconst __f: "FORCE" = __t;\n' >> "$D/chunk.ts"
  cat > "$D/tsconfig.json" <<'JSON'
{ "extends": "../../../../tsconfig.json",
  "compilerOptions": { "noEmit": true, "skipLibCheck": true, "strict": false, "types": [] },
  "files": ["module.d.ts", "chunk-0000.state.d.ts", "chunk.ts"] }
JSON
  echo "# module $(wc -c < "$D/module.d.ts") B, state $(wc -c < "$D/chunk-0000.state.d.ts") B"
fi

printf '\n%-12s %-10s %-9s %s\n' CANDIDATE 'best(s)' TAG NOTE
for c in $(ls candidates); do
  A=candidates/$c/adapter.sh
  case "$("$A" --probe 2>&1)" in AVAILABLE*) ;; *) printf '%-12s %-10s %-9s %s\n' "$c" - - "skipped (unavailable)"; continue ;; esac
  best=""; tag="?"
  i=0; while [ "$i" -lt "$REPS" ]; do
    s=$(python3 -c 'import time;print(time.time())')
    out=$("$A" "$D" 2>&1 || true)
    e=$(python3 -c 'import time;print(time.time())')
    t=$(python3 -c "print(f'{$e-$s:.2f}')")
    [ -z "$best" ] && best=$t
    best=$(python3 -c "print(f'{min($best,$t):.2f}')")
    # the forced error reveals the computed tag: Type '"r"' is not assignable to type '"FORCE"'
    g=$(printf '%s' "$out" | grep -oE "Type '\"[a-z]\"' is not assignable" | head -1 | grep -oE '"[a-z]"' | head -1 | tr -d '"')
    [ -n "$g" ] && tag=$g
    i=$((i+1))
  done
  printf '%-12s %-10s %-9s %s\n' "$c" "$best" "$tag" "$("$A" --probe 2>&1 | sed 's/^AVAILABLE //')"
done
echo
echo "TAG is the chunk's computed result; all candidates must agree or the checker is wrong."
