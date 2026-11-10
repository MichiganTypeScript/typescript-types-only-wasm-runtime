import { createSession, run } from "./drive";
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");
const session = createSession();
for (const name of ["blit8v", "blit64v", "colv", "spanlowv"]) for (const n of [3, 6]) {
  const r = await run(`/Users/steven_chong/Downloads/repos/typescript-types-only-wasm-runtime/packages/playground/cfg/bench/${name}.cfg.ts`, "run", [`'${bin(n)}'`], { fuel: 4000, quiet: true, session, max: 8 });
  console.log(name, n, r.failed ?? parseInt(String(r.value ?? r.result ?? "").replace(/'/g, ""), 2), JSON.stringify(r).slice(0, 200));
}
