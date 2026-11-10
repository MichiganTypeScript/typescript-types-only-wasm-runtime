import { createSession, run } from "./drive";
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");
const session = createSession();
for (const n of [500, 3000, 8000]) {
  const t0 = performance.now();
  const r = await run(`/Users/steven_chong/Downloads/repos/typescript-types-only-wasm-runtime/packages/playground/cfg/bench/hop.cfg.ts`, "run", [`'${bin(n)}'`], { fuel: n * 6 + 100, quiet: true, session, max: 1 });
  console.log(n, r.failed, r.value, "chunks", r.chunks, "fuel", r.fuel, ((performance.now() - t0) / 1000).toFixed(1) + "s");
}
