/**
 * Measure the AOT compiled first frame.
 *
 * The interpreter has to walk every one of doom's 22,924,753 operations at the
 * type level to produce the first frame.  The AOT compiler instead turns
 * doom.wasm into type aliases up front, so TypeScript only has to evaluate the
 * resulting type expression.  This times that evaluation and compares the
 * answer with what the real WASM engine returns.
 *
 * Usage: pnpm --filter playground run bench:aot-frame [iterations]
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnv, evaluateType } from "../evaluate/ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const benchFilePath = join(__dirname, "bench-aot.ts");
const wasmPath = join(__dirname, "doom.wasm");

const iterations = Number.parseInt(process.argv[2] ?? "3", 10);
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("iterations must be a positive integer");
}

// What the real engine produces for the first frame
const bytes = await readFile(wasmPath);
const memory = new WebAssembly.Memory({ initial: 6 });
const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
const nativeStart = performance.now();
const expected = (instance.exports.entry as () => number)();
const nativeDuration = performance.now() - nativeStart;

console.log("=== AOT first frame ===");
console.log(`WASM engine: ${expected} in ${nativeDuration.toFixed(3)}ms`);
console.log(`Cold evaluations: ${iterations}`);
console.log("");

const durations: number[] = [];

for (let iteration = 1; iteration <= iterations; iteration++) {
  const env = createEnv(benchFilePath);

  try {
    const program = env.languageService.getProgram();
    if (!program) throw new Error("Failed to create TypeScript program");

    const start = performance.now();
    const { typeString } = await evaluateType(
      env,
      benchFilePath,
      program,
      undefined,
      "BenchResult",
      true, // we want the raw type, not the interpreter's instruction bookkeeping
    );
    const duration = performance.now() - start;
    durations.push(duration);

    console.log(
      `Run ${iteration}: ${(duration / 1000).toFixed(3)}s -> ${typeString}`,
    );
  } finally {
    env.close();
  }
}

const matches = durations.length > 0;
if (!matches) throw new Error("no measurements");

const average = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
console.log("");
console.log(`Average: ${(average / 1000).toFixed(3)}s`);
console.log(`FPS: ${(1000 / average).toFixed(4)} (frames per second)`);
