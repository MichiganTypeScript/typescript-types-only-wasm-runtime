// Compile every wasm module we have with the CFG compiler, run each exported
// function at type level, and compare against the same call made by the real
// engine. Anything the compiler cannot handle is reported as unsupported rather
// than quietly passing.
//
//   node --import tsx/esm conform.ts [glob-ish path fragment]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, run } from "./drive";
import { decodeTrie } from "./trie";
import { trieShape } from "../doom/render-frame";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../../..");
const filter = process.argv[2];
const fuel = Number(process.env.FUEL ?? 2000);
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");
const asI32 = (bits: string) => (parseInt(bits, 2) | 0);

const dirs = [
  join(root, "packages/conformance-tests/from-c"),
  join(root, "packages/conformance-tests/from-wat"),
  join(root, "packages/conformance-tests/from-wat-single"),
];
const modules = dirs
  .filter(existsSync)
  .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".wasm")).map((f) => join(dir, f)))
  .filter((f) => !filter || f.includes(filter));

const session = createSession();
let ok = 0;
let mismatched = 0;
let unsupported = 0;

/// Argument vectors to try for exported functions. Each export used to get one
/// call, whose first argument was 0 - and a zero argument makes a whole class of
/// bug invisible: `memory-overwrite.wat` stores its parameter, multiplies by 3
/// and stores again, so with 0 in hand every store writes the zero that was
/// already there and the memory comparison below has nothing to look at. Three
/// vectors, none of them starting at zero, and the signs mixed so a sign-extend
/// bug in a compare cannot hide behind two positives.
const argVectors = [
  [7, -3, 42, 2, 5, 1, 3, 9],
  [1, 2, 3, 4, 5, 6, 7, 8],
  [-1, 2147483647, -2147483648, 0, 65535, 256, -7, 1],
];

for (const wasmPath of modules) {
  const name = basename(wasmPath);
  let compiled: string;
  try {
    execFileSync(join(root, "target/debug/doom_but_typescript_types"), ["--aot-cfg", wasmPath], {
      stdio: "pipe",
    });
    compiled = wasmPath.replace(/\.wasm$/, ".cfg.ts");
    if (!existsSync(compiled)) throw new Error("no output");
  } catch (error) {
    const message = String((error as { stderr?: Buffer }).stderr ?? (error as Error).message)
      .split("\n")
      .find((l) => l.includes("failed")) ?? "compile failed";
    console.log(`${name.padEnd(28)} unsupported: ${message.replace("aot-cfg failed: ", "").slice(0, 80)}`);
    unsupported++;
    continue;
  }

  // the reference run
  const bytes = readFileSync(wasmPath);
  let instance: WebAssembly.Instance;
  let importedMemory: WebAssembly.Memory;
  try {
    importedMemory = new WebAssembly.Memory({ initial: 2 });
    instance = (await WebAssembly.instantiate(bytes, { env: { memory: importedMemory } })).instance;
  } catch (error) {
    console.log(`${name.padEnd(28)} skipped: engine could not instantiate (${(error as Error).message.slice(0, 40)})`);
    continue;
  }

  const source = readFileSync(compiled, "utf8");

  /// The returned i32 is one word out of the whole machine, and most of what a
  /// wasm function does never reaches it: `memory-overwrite.wat` stores, loads,
  /// multiplies and stores again, and a compiler that dropped every store but
  /// the last would still return the right number. Comparing the memory is what
  /// makes a store observable to this suite.
  ///
  /// A module can declare its own memory or import one; the engine side reads
  /// whichever the instance actually used. The type side hands back a trie whose
  /// unwritten subtrees mean "still whatever the data segments put there", so
  /// decoding needs the module's own `$InitialMemory` to fall through to.
  const initialLiteral = /(?:export )?type \$InitialMemory\s*=\s*([\s\S]*?)\n\n/.exec(source)?.[1]?.trim();
  const shape = (() => {
    try {
      return trieShape(source);
    } catch {
      return undefined; // no memory in this module
    }
  })();
  const engineMemory = () => {
    const exported = instance.exports.memory;
    return exported instanceof WebAssembly.Memory ? exported : importedMemory;
  };
  /// Words that differ between the two runs, capped: one wrong store and one
  /// wrong base address look identical at "mismatch", and the first few
  /// addresses say which.
  const memoryDiff = (state: string) => {
    if (!shape || initialLiteral === undefined) return [];
    const words = decodeTrie(state, shape.bits, shape.digitBits, initialLiteral);
    const native = new Uint32Array(engineMemory().buffer);
    const bad: string[] = [];
    // Only the words one side or the other actually holds: the engine's memory
    // is 2 pages of mostly zeroes, and the trie says nothing about them either.
    const addresses = new Set<number>(words.keys());
    for (let w = 0; w < native.length; w++) if (native[w] !== 0) addresses.add(w);
    for (const w of [...addresses].sort((a, b) => a - b)) {
      const mine = (words.get(w) ?? 0) >>> 0;
      const theirs = (native[w] ?? 0) >>> 0;
      if (mine !== theirs && bad.length < 4) bad.push(`[${w * 4}]=${mine}, want ${theirs}`);
    }
    return bad;
  };
  const entries = [...source.matchAll(/^export type \$([A-Za-z_][\w]*)<\$F extends string/gm)].map((m) => m[1]);
  let checked = 0;
  let failures: string[] = [];
  const unfinished: string[] = [];

  for (const entry of entries) {
    const nativeExport = instance.exports[entry];
    if (typeof nativeExport !== "function") continue;
    const arity = (source.match(new RegExp(`export type \\$${entry}<[^>]*`))?.[0].match(/\$p\d+/g) ?? []).length;
    for (const vector of argVectors) {
      const args = vector.slice(0, arity);
      // A fresh instance per call: the engine keeps whatever the last call
      // stored, and the type run always starts from the data segments, so
      // comparing memory against a reused instance reports every earlier call's
      // writes as a mismatch.
      let expected: number | undefined;
      try {
        importedMemory = new WebAssembly.Memory({ initial: 2 });
        const fresh = await WebAssembly.instantiate(bytes, { env: { memory: importedMemory } });
        instance = fresh.instance;
        const call = instance.exports[entry] as (...a: number[]) => number;
        expected = call(...args) | 0;
      } catch {
        continue; // traps natively; not a useful comparison
      }
      const maxChunks = 400;
      const result = await run(compiled, entry, args.map((a) => `'${bin(a)}'`), {
        fuel,
        quiet: true,
        session,
        max: maxChunks,
      });
      // Running out of chunks is not a wrong answer, and calling it one buries
      // real mismatches. `conway.displayGrid(-1, 2147483647, -2147483648)` is a
      // two-billion-iteration loop: the engine walks it in a second and this
      // runtime would need weeks, which says nothing about whether the compiler
      // is correct. Report it separately and do not fail on it.
      if (!result.failed && result.value === undefined && result.chunks >= maxChunks) {
        unfinished.push(`${entry}(${args})`);
        continue;
      }
      checked++;
      if (result.failed) failures.push(`${entry}(${args}) failed: ${result.failed.slice(0, 60)}`);
      else if (result.value === undefined) {
        if (expected !== 0 && expected !== undefined) failures.push(`${entry}(${args}) returned nothing, want ${expected}`);
      } else if (asI32(result.value) !== expected) {
        failures.push(`${entry}(${args}) = ${asI32(result.value)}, want ${expected}`);
      }
      if (!result.failed) {
        const bad = memoryDiff(result.memory);
        if (bad.length) failures.push(`${entry}(${args}) memory: ${bad.join("; ")}`);
      }
      // An arity-0 export takes the same call however many vectors there are
      if (arity === 0) break;
    }
  }

  const note = unfinished.length ? ` (${unfinished.length} did not finish in 400 chunks)` : "";
  if (!checked) {
    console.log(`${name.padEnd(28)} ${unfinished.length ? `no call finished in 400 chunks` : "no comparable exports"}`);
  } else if (failures.length === 0) {
    console.log(`${name.padEnd(28)} ok (${checked} export${checked === 1 ? "" : "s"} match the engine)${note}`);
    ok++;
  } else {
    console.log(`${name.padEnd(28)} MISMATCH: ${failures[0]}${note}`);
    mismatched++;
  }
}

console.log(`\n${ok} modules match the engine, ${mismatched} mismatched, ${unsupported} unsupported`);
