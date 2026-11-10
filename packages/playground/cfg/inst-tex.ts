// Deterministic cost of the fused vs interpreted texture loops: dump one
// chunk of each and count instantiations with tsgo.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createSession, run } from "./drive";
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");
const root = "/Users/steven_chong/Downloads/repos/typescript-types-only-wasm-runtime";
const N = Number(process.env.N ?? 8);
for (const name of process.env.CASES?.split(",") ?? ["colv", "spanv"]) for (const mode of ["interp", "fused"]) {
  const wasm = `${root}/packages/playground/cfg/bench/${name}.wasm`;
  execFileSync(`${root}/target/debug/doom_but_typescript_types`, ["--aot-cfg", wasm], { stdio: "pipe", env: { ...process.env, ...(mode === "interp" ? { NO_TEX: "1", NO_FDIV: "1", NO_FMUL: "1" } : {}) } });
  const dir = `/tmp/inst-${name}-${mode}`;
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
  const session = createSession();
  process.env.DUMP_CHUNKS = dir;
  const r = await run(wasm.replace(/\.wasm$/, ".cfg.ts"), "run", [`'${bin(N)}'`], { fuel: N * 1200 + 40, quiet: true, session, max: 4 });
  const value = parseInt(String(r.value).replace(/'/g, ""), 2);
  // exports are lazy: force the same reads the driver makes
  writeFileSync(`${dir}/force.ts`, readFileSync(`${dir}/chunk-0000.ts`, "utf8") + `declare const __v: $Out_Value;
export const __force: "___force___" = __v;
declare const __m: $Out_Mem;
export const __force2: "___force___" = __m;
`);
  writeFileSync(`${dir}/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true, module: "ES2022", moduleResolution: "bundler", noErrorTruncation: true, paths: { "ts-type-math": [`${root}/packages/ts-type-math/index.d.ts`], "wasm-to-typescript-types": [`${root}/packages/wasm-to-typescript-types/index.d.ts`] } }, files: ["module.d.ts", "chunk-0000.state.d.ts", "force.ts"] }));
  let out = ""; try { out = execFileSync(`${root}/node_modules/.bin/tsgo`, ["-p", "tsconfig.json", "--extendedDiagnostics"], { encoding: "utf8", cwd: dir }).toString(); } catch (e: any) { out = e.stdout ?? ""; }
  const inst = /Instantiations:\s+(\d+)/.exec(out)?.[1];
  const time = /Check time:\s+([\d.]+)s/.exec(out)?.[1];
  console.log(name.padEnd(6), mode.padEnd(7), "N", N, "value", value, "chunks", r.chunks, "instantiations", inst, "check", time, "s");
}
