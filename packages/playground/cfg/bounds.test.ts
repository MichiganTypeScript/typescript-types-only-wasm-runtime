import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, run } from "./drive";

/// Memory accesses have to trap exactly where the engine traps.
///
/// wasm refuses an access that runs past the end of memory; the type level has
/// to refuse it too, or a program reads a word it never allocated and keeps
/// going. It used to keep going: a store past the end silently landed and a load
/// past the end returned zero, so `storechain8` - which strides 512 bytes from
/// 4096 and leaves its one declared page at n=124 - ran happily long after the
/// engine had stopped.
///
/// Both bound shapes are covered, because they are different code paths in the
/// compiler: a memory the module owns and never grows has its end fixed at
/// compile time, while one that grows has to be checked against the live page
/// count. Getting the second wrong is invisible to the first.
const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");
const root = join(__dirname, "../../..");
const compiler = join(root, "target/release/doom_but_typescript_types");

/// The compiler is a build artifact, so skip rather than fail when it is absent.
const haveCompiler = existsSync(compiler);

const answersFor = async (name: string, addresses: number[]) => {
  const wasm = join(__dirname, `bench/${name}.wasm`);
  execFileSync(compiler, ["--aot-cfg", wasm], { stdio: "pipe" });
  const bytes = readFileSync(wasm);
  const session = createSession();
  const rows: Array<{ addr: number; native: string; types: string }> = [];
  try {
    for (const addr of addresses) {
      // a fresh instance per address: `growprobe` grows, and a reused instance
      // would carry the previous call's pages while the type level starts over
      let native: string;
      try {
        const { instance } = await WebAssembly.instantiate(bytes, { env: {} });
        native = String((instance.exports.run as (n: number) => number)(addr) | 0);
      } catch {
        native = "TRAP";
      }
      const result = await run(join(__dirname, `bench/${name}.cfg.ts`), "run", [`'${bin(addr)}'`], {
        fuel: 800,
        quiet: true,
        session,
      });
      // a trap is `never`, which the driver reports as an unusable result
      const types = result.failed
        ? /tag is never|state has/.test(String(result.failed))
          ? "TRAP"
          : `FAILED ${String(result.failed).slice(0, 60)}`
        : String(Number.parseInt(result.value ?? "", 2) | 0);
      rows.push({ addr, native, types });
    }
  } finally {
    session.env.close();
  }
  return rows;
};

describe.skipIf(!haveCompiler)("memory accesses trap where the engine traps", () => {
  it("refuses an access past the end of a fixed memory", async () => {
    // one page: 65532 is the last aligned word that fits, and 65533 onwards is
    // a 4-byte access that starts inside and runs over
    const rows = await answersFor("oobprobe", [
      0, 4096, 65528, 65532, 65533, 65535, 65536, 131072, 4294967295,
    ]);
    expect(rows.map((r) => `${r.addr} ${r.types}`)).toEqual(
      rows.map((r) => `${r.addr} ${r.native}`),
    );
    // and the fixture is actually exercising both sides
    expect(rows.filter((r) => r.native === "TRAP").length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.native !== "TRAP").length).toBeGreaterThan(0);
  }, 600_000);

  it("follows the end of memory when the module grows it", async () => {
    // grows by one page first, so the whole second page is legal and the third
    // is not: a guard that kept the page count from block entry fails here
    const rows = await answersFor("growprobe", [
      0, 65536, 131068, 131069, 131072, 4294967295,
    ]);
    expect(rows.map((r) => `${r.addr} ${r.types}`)).toEqual(
      rows.map((r) => `${r.addr} ${r.native}`),
    );
    // the point of the fixture: addresses past the *declared* page are fine
    expect(rows.find((r) => r.addr === 65536)?.native).not.toBe("TRAP");
    expect(rows.find((r) => r.addr === 131072)?.native).toBe("TRAP");
  }, 600_000);
});
