#!/bin/sh
# Wall-clock on the gate tests, for candidates that actually pass them.
# Startup-dominated, so this ranks only tools that cleared run-all.sh; the
# meaningful doom number is units/s from packages/playground/cfg/drive.ts.
cd "$(dirname "$0")" || exit 1
for c in ${*:-tsgo tsc-5.6.3}; do
  A=candidates/$c/adapter.sh
  case "$("$A" --probe 2>&1)" in AVAILABLE*) ;; *) echo "$c: skipped (unavailable)"; continue ;; esac
  S=$(python3 -c 'import time;print(time.time())')
  for i in 1 2 3; do for t in tests/t*.ts; do "$A" "$t" >/dev/null 2>&1; done; done
  E=$(python3 -c 'import time;print(time.time())')
  echo "$c: $(python3 -c "print(f'{($E-$S)/3:.3f}')")s per pass over $(ls tests/t*.ts | wc -l | tr -d ' ') tests"
done
