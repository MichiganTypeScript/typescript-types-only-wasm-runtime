// Sweep a compile-time cap and report us/iter per fixture.
//
// Every timing is checked against the real engine first. An earlier version of
// this file only timed, and that is exactly how PIPELINE_CAP shipped a default
// of 64: past cap 34 the generated module exceeds the checker's instantiation
// budget and resolves to `any`, which is *fast*. A sweep that does not compare
// answers rewards the cap that stopped computing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createSession, run } from "./drive";
const root = "/Users/stevenchongcloudflare.com/repos/typescript-types-only-wasm-runtime";
const dir = root + "/packages/playground/cfg/bench/";
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");
const N = Number(process.env.N ?? 200);
const perIter: Record<string, number> = { arith120: 123, storechain: 40, storechain8: 24, storechain32: 72, hop: 6, add: 10, and1: 10, and5: 26, load: 11, store: 11, storeword: 13, store32: 11 };
const names = (process.env.CASES ?? "storechain").split(",");
const caps = (process.env.CAPS ?? "6,12").split(",");
// which cap to sweep: DEPTH_CAP bounds memory/branch blocks, PIPELINE_CAP bounds
// straight-line pure-arithmetic runs. A loop body shorter than PIPELINE_CAP is
// cut by its own back edge first, so only a long-body fixture moves under it.
const knob = process.env.KNOB ?? "DEPTH_CAP";
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const out: Record<string, Record<string, string>> = {};
for (const cap of caps) {
  for (const name of names) {
    execFileSync(root + (process.env.BIN ?? "/target/release/doom_but_typescript_types"), ["--aot-cfg", dir + name + ".wasm"], { stdio: "pipe", env: { ...process.env, [knob]: cap } });
    const text = readFileSync(dir + name + ".cfg.ts", "utf8");
    const blocks = (text.match(/^export type \$b/gm) ?? []).length;
    // the oracle: the same bytes on the real engine
    const { instance } = await WebAssembly.instantiate(readFileSync(dir + name + ".wasm"), { env: {} });
    const native = instance.exports.run as (n: number) => number;
    const session = createSession();
    const at = async (n: number) => await run(dir + name + ".cfg.ts", "run", [`'${bin(n)}'`], { fuel: n * perIter[name] + 60, quiet: true, session, max: 12 });
    const pairs: Array<[number, number]> = [];
    let chunks = 0, bad: unknown;
    for (let r = 0; r < Number(process.env.REPS ?? 3); r++) {
      const lo = await at(N), hi = await at(N * 2);
      bad = lo.failed ?? hi.failed;
      if (bad) break;
      // A cap that makes the checker give up returns `any` and returns it
      // quickly, so the answer has to be right before the time means anything.
      for (const [n, got] of [[N, lo.value], [N * 2, hi.value]] as const) {
        // A fixture whose native run traps is being benchmarked past the end of
        // its own memory: storechain8 and storechain32 stride 512 bytes from
        // 4096, so anything from n=124 is out of bounds on their declared one
        // page. There is no answer to compare against, and the type-level run
        // does not trap there either (the trie carries 128 pages of headroom and
        // no bounds check), so N has to come down rather than be scored.
        let want: number;
        try {
          want = native(n) | 0;
        } catch (error) {
          bad = `n=${n} is out of bounds natively (${(error as Error).message}) - lower N`;
          break;
        }
        if ((parseInt(got ?? "", 2) | 0) !== want) {
          bad = `wrong answer at n=${n}: want ${want}, got ${String(got).slice(0, 24)}`;
          break;
        }
      }
      if (bad) break;
      chunks = hi.chunks;
      pairs.push([lo.evalMs, hi.evalMs]);
    }
    session.env.close();
    out[name] ??= {};
    if (bad) { out[name][cap] = "FAIL"; console.log(`cap ${cap} ${name} FAILED ${String(bad).slice(0,50)}`); continue; }
    const slope = median(pairs.map(([lo, hi]) => (hi - lo) / N)) * 1000;
    out[name][cap] = slope.toFixed(0);
    console.log(`cap ${cap.padStart(2)} ${name.padEnd(10)} ${slope.toFixed(0).padStart(6)} µs/iter  ${blocks} blocks  ${chunks} chunks`);
  }
}
console.log("\ncase       " + caps.map(c => ("d" + c).padStart(7)).join(""));
for (const n of names) console.log(n.padEnd(11) + caps.map(c => (out[n]?.[c] ?? "-").padStart(7)).join(""));
process.exit(0);
