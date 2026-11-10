// Per-operation cost, measured the same way the game runs: a wasm loop of N
// iterations, compiled and evaluated in one chunk.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, run } from "./drive";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../../..");
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");
const N = Number(process.env.N ?? 200);
const session = createSession();

// hop.wat is the empty loop: everything else is measured against it
const cases = process.env.CASES ? process.env.CASES.split(",") : ["hop", "add", "mul", "and1", "lt5", "load", "store", "storeword", "arity2", "arity20", "call"];
// instructions per iteration, from the .wat: fuel has to cover the whole run or
// the case reports a partial time.
const perIter: Record<string, number> = { hop: 6, add: 10, mul: 10, and1: 10, lt5: 22, load: 11, store: 11, storeword: 13, store8s4: 13, store8same: 9, loadword: 13, arity2: 6, arity20: 6, call: 14, blit8: 20, blit64: 20, blit8v: 24, blit64v: 24, col: 230, span: 326 };
// A single run cannot tell a per-iteration cost from a one-time setup cost:
// dividing total by N charges the whole prologue to every iteration. Each case
// runs at N and 2N, so the slope is the real per-iteration cost and the
// intercept is the fixed cost of entering the chunk at all.
const slopes: Record<string, number> = {};
for (const name of cases) {
  const wasm = join(__dirname, `bench/${name}.wasm`);
  if (!process.env.SKIP_COMPILE) execFileSync(join(root, "target/debug/doom_but_typescript_types"), ["--aot-cfg", wasm], { stdio: "pipe" });
  const module = wasm.replace(/\.wasm$/, ".cfg.ts");
  const at = async (n: number) =>
    await run(module, "run", [`'${bin(n)}'`], {
      fuel: n * (perIter[name] ?? 6) + 40 + Number(process.env.FUEL_PAD ?? 0),
      quiet: true,
      session,
      max: 8,
    });
  // One pair of runs is not enough: back-to-back pairs have been seen to
  // disagree by 4x on the same case, which is bigger than every effect worth
  // chasing. Take the median slope over REPS pairs.
  const reps = Number(process.env.REPS ?? 3);
  const pairs: Array<[number, number]> = [];
  let chunks = 1;
  for (let r = 0; r < reps; r++) {
    const lo = await at(N);
    const hi = await at(N * 2);
    const bad = lo.failed ?? hi.failed;
    if (bad) {
      console.log(`${name.padEnd(9)} FAILED ${String(bad).slice(0, 70)}`);
      break;
    }
    chunks = hi.chunks;
    pairs.push([lo.evalMs, hi.evalMs]);
  }
  if (pairs.length < reps) continue;
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
  const slope = median(pairs.map(([lo, hi]) => (hi - lo) / N));
  const fixed = median(pairs.map(([lo]) => lo)) - slope * N;
  slopes[name] = slope;
  const net = name === "hop" ? 0 : slope - slopes.hop;
  console.log(
    `${name.padEnd(9)} ${(slope * 1000).toFixed(0).padStart(5)} µs/iteration  ${fixed.toFixed(0).padStart(4)} ms fixed` +
      (name === "hop" ? "   (empty loop: one hop, one add, one compare)" : `   -> ${(net * 1000).toFixed(0)} µs for the ${name}`) +
      `   ${chunks} chunk${chunks === 1 ? "" : "s"}`,
  );
}
