// Replay a frame natively from a frame-boundary state and print block counts.
import { readFileSync } from "node:fs";
import { decodeTrie } from "/Users/steven_chong/Downloads/repos/typescript-types-only-wasm-runtime/packages/playground/cfg/trie.ts";
import { trieShape } from "/Users/steven_chong/Downloads/repos/typescript-types-only-wasm-runtime/packages/playground/doom/render-frame.ts";

const doom = "/Users/steven_chong/Downloads/repos/typescript-types-only-wasm-runtime/packages/playground/doom";
const statePath = process.argv[2] ?? `${doom}/.live/doom-live.json.final`;
const frames = Number(process.argv[3] ?? 1);
const t0 = performance.now();
const text = readFileSync(`${doom}/doom-keys.cfg.ts`, "utf8");
const shape = trieShape(text);
const initialLiteral = /(?:export )?type \$InitialMemory\s*=\s*([\s\S]*?)\n\n/.exec(text)?.[1]?.trim();
if (!initialLiteral) throw new Error("no initial");
const state = JSON.parse(readFileSync(statePath, "utf8"));
console.error("shape", shape, "frames", state.frames.length, "chunks", state.chunks);
const words = decodeTrie(state.memory, shape.bits, shape.digitBits, initialLiteral);
console.error(`decoded ${words.size} words in ${(performance.now() - t0).toFixed(0)}ms`);

const map = JSON.parse(readFileSync("/tmp/eq/doom-instr.map.json", "utf8"));
const counts = new Float64Array(map.length);
const memory = new WebAssembly.Memory({ initial: 128 });
const bytes = readFileSync("/tmp/eq/doom-instr.wasm");
const { instance } = await WebAssembly.instantiate(bytes, {
  env: { memory, __cnt: (id: number) => { counts[id]++; } },
});
const u32 = new Uint32Array(memory.buffer);
for (const [w, v] of words) u32[w] = v;
const entry = instance.exports.entry as () => number;
for (let f = 0; f < frames; f++) {
  counts.fill(0);
  const r = entry();
  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`frame ${f}: result ${(r >>> 0).toString(2).padStart(32, "0")} total block-hits ${total}`);
  const idx = [...counts.keys()].sort((a, b) => counts[b] - counts[a]).slice(0, 40);
  for (const i of idx) {
    const m = map[i];
    console.log(`${String(counts[i]).padStart(9)} ${(100 * counts[i] / total).toFixed(1).padStart(5)}% ${m.kind.padEnd(4)} ${m.fn} @${m.line}`);
  }
  // per-function totals (funcs + loops attributed to fn)
  const byFn = new Map<string, number>();
  for (let i = 0; i < map.length; i++) byFn.set(map[i].fn, (byFn.get(map[i].fn) ?? 0) + counts[i]);
  console.log("--- by function ---");
  for (const [fn, c] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 25))
    console.log(`${String(c).padStart(9)} ${(100 * c / total).toFixed(1).padStart(5)}% ${fn}`);
}
