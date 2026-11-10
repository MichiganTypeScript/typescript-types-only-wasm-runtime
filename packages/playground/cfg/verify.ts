// Conformance: the type-level run must agree with the same wasm module executed
// by the real engine, byte for byte, frame after frame.
//
// This is the whole claim in one file. If the screen bytes match V8's own
// execution of pong-tiny.wasm for every frame, then the TypeScript type checker
// really is running the program - not approximating it, and not replaying
// something the host computed.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createSession, run } from "./drive";
import { decodeTrie, render } from "./trie";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");

const wasmPath = process.env.WASM ?? join(__dirname, "../pong-tiny/pong-tiny.wasm");
const modulePath = process.env.MODULE ?? join(__dirname, "../pong-tiny/pong-tiny.cfg.ts");
const frames = Number(process.env.FRAMES ?? 8);
const fuel = Number(process.env.FUEL ?? 1500);
const bits = Number(process.env.BITS ?? 15);
const digitBits = Number(process.env.DIGIT ?? 3);
const width = Number(process.env.WIDTH ?? 40);
const height = Number(process.env.HEIGHT ?? 24);
const buttons = (process.env.BUTTONS ?? "0").split(",").map(Number);

// the reference: the real engine running the same bytes
const memory = new WebAssembly.Memory({ initial: 1 });
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), { env: { memory } });
const nativeFrame = instance.exports.frame as (buttons: number) => number;
const nativeBytes = new Uint8Array(memory.buffer);

const session = createSession();
let state = "$InitialMemory";
let mismatch = 0;
let totalMs = 0;

for (let frame = 0; frame < frames; frame++) {
  const press = buttons[frame % buttons.length] ?? 0;

  const nativeScreen = nativeFrame(press);
  const result = await run(modulePath, "frame", [`'${bin(press)}'`], {
    fuel,
    memory: state,
    quiet: true,
    session,
  });
  if (result.failed) {
    console.log(`frame ${frame + 1}: FAILED ${result.failed}`);
    mismatch++;
    break;
  }
  state = result.memory;
  totalMs += result.totalMs;
  const typeScreen = parseInt(result.value ?? "0", 2);
  const words = decodeTrie(state, bits, digitBits);

  // compare the whole screen buffer, byte for byte
  let bad = 0;
  let firstBad = -1;
  for (let i = 0; i < width * height; i++) {
    const expected = nativeBytes[nativeScreen + i];
    const got = ((words.get((typeScreen + i) >>> 2) ?? 0) >>> (((typeScreen + i) & 3) * 8)) & 0xff;
    if (expected !== got) {
      bad++;
      if (firstBad < 0) firstBad = i;
    }
  }
  // and the game state that drives the next frame
  const stateWords = [0, 4, 8, 12, 16, 20, 24, 44, 48].map((offset) => ({
    offset,
    expected: new DataView(memory.buffer).getInt32(8192 + offset, true),
    got: (words.get((8192 + offset) >>> 2) ?? 0) | 0,
  }));
  const badState = stateWords.filter((w) => w.expected !== w.got);

  if (bad || badState.length) mismatch++;
  console.log(
    `frame ${String(frame + 1).padStart(2)}: screen@${typeScreen} ${bad === 0 ? "matches" : `${bad} bytes differ (first at ${firstBad})`}` +
      `, state ${badState.length === 0 ? "matches" : `differs: ${badState.map((w) => `+${w.offset} want ${w.expected} got ${w.got}`).join(", ")}`}` +
      `, ${result.chunks} chunk${result.chunks === 1 ? "" : "s"} in ${(result.totalMs / 1000).toFixed(2)}s` +
        ` (type evaluation ${(result.evalMs / 1000).toFixed(2)}s, host ${((result.totalMs - result.evalMs) / 1000).toFixed(2)}s)`,
  );
}

console.log(
  `\n${frames} frames: ${mismatch === 0 ? "IDENTICAL to the wasm engine" : `${mismatch} frame(s) differ`}` +
    `, ${(totalMs / frames / 1000).toFixed(2)}s per frame (${(1000 / (totalMs / frames)).toFixed(1)} FPS)`,
);

if (process.env.SHOW) {
  const words = decodeTrie(state, bits, digitBits);
  const rows = render(words, parseInt("0", 2) || 8244, width, height);
  console.log("+" + "-".repeat(width) + "+");
  for (const row of rows) console.log("|" + row + "|");
  console.log("+" + "-".repeat(width) + "+");
}
