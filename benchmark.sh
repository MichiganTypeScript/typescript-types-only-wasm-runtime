#!/bin/bash
# Benchmark script - runs Conway's Game of Life for a fixed number of instructions
# Usage: ./benchmark.sh [instructions]
# Default: 1000 instructions

INSTRUCTIONS=${1:-1000}

# Backup config
cp packages/playground/evaluate/config.ts packages/playground/evaluate/config.ts.bak

# Modify config for benchmark
sed -i '' "s/stopAt: Infinity/stopAt: $INSTRUCTIONS/" packages/playground/evaluate/config.ts
sed -i '' "s/shouldComputeFullStats: false/shouldComputeFullStats: true/" packages/playground/evaluate/config.ts

echo "=== TypeScript Types WASM Runtime Benchmark ==="
echo "Running $INSTRUCTIONS instructions..."
echo ""

START_TIME=$(date +%s)

# Run the eval
node \
  --stack-size=8192 \
  --max-old-space-size=16384 \
  --max-semi-space-size=16384 \
  --import tsx/esm \
  packages/playground/evaluate/run.ts 2>&1

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "=== Results ==="
echo "Total time: ${DURATION}s"
echo "Instructions: $INSTRUCTIONS"
if [ $DURATION -gt 0 ]; then
  IPS=$((INSTRUCTIONS / DURATION))
  echo "IPS (instructions/sec): $IPS"
fi

# Restore config
mv packages/playground/evaluate/config.ts.bak packages/playground/evaluate/config.ts

echo ""
echo "Baseline captured. Run again after changes to compare."
