/**
 * Benchmark TypeScript's evaluation of the completed Doom snapshot.
 * Usage: pnpm run benchmark [iterations]
 * Default: 3 iterations
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnv, evaluateType } from "./evaluate/ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotPath = join(
  __dirname,
  "final-doom-pun-intended/data/result-15895321.ts",
);
const expectedInstructionCount = 15_895_321;
const iterations = Number.parseInt(process.argv[2] ?? "3", 10);

if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("iterations must be a positive integer");
}

console.log("=== TypeScript Types WASM Runtime Benchmark ===");
console.log(`Snapshot: ${expectedInstructionCount.toLocaleString()} instructions`);
console.log(`Cold evaluations: ${iterations}`);
console.log("");

const durations: number[] = [];

for (let iteration = 1; iteration <= iterations; iteration++) {
  const env = createEnv(snapshotPath);

  try {
    const program = env.languageService.getProgram();
    if (!program) {
      throw new Error("Failed to create TypeScript program");
    }

    const start = performance.now();
    const { current } = await evaluateType(
      env,
      snapshotPath,
      program,
      undefined,
      "NextResult",
    );
    const duration = performance.now() - start;

    if (current !== expectedInstructionCount) {
      throw new Error(
        `Expected ${expectedInstructionCount} instructions, received ${current}`,
      );
    }

    durations.push(duration);
    console.log(`Run ${iteration}: ${(duration / 1000).toFixed(2)}s`);
  } finally {
    env.close();
  }
}

const total = durations.reduce((sum, duration) => sum + duration, 0);
const average = total / durations.length;
const ips = Math.round(expectedInstructionCount / (average / 1000));
const fps = 1000 / average;

console.log("");
console.log("=== Results ===");
console.log(`Average: ${(average / 1000).toFixed(2)}s`);
console.log(`FPS (completed snapshot evaluations/sec): ${fps.toFixed(2)}`);
console.log(`IPS (instructions/sec): ${ips.toLocaleString()}`);
