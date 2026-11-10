// The screen the type checker painted, as a PNG.
//
// doom's `entry` returns the address of its 320x200 screen, one byte per pixel,
// each byte an index into the PLAYPAL the module carries in its data segments.
// Both live in the memory the checker hands back, so a frame needs nothing from
// the wasm engine: decode the trie, read the palette out of it, look the pixels
// up, deflate.
//
// Usage: node --import tsx render-frame.ts <checkpoint.json> <out.png> [scale]
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeTrie } from "../cfg/trie";

const __dirname = dirname(fileURLToPath(import.meta.url));

/// The first frame's screen. Every `entry` call allocates its own buffer and
/// returns it (measured natively: 393480, 655624, 852232, ...), so a reader with
/// a checkpoint should pass the address that call returned; this is the default
/// for the first frame, before any call has come back.
const SCREEN = 393480;
const WIDTH = 320;
const HEIGHT = 200;
/// The trie shape is the emitter's to choose - TRIE_DIGIT_BITS sweeps it - and a
/// stale copy here decodes the memory into garbage rather than failing, so read
/// it back off the module: $KidN per branch slot, and the bits $Slice keeps.
export const trieShape = (moduleText: string) => {
  const fanout = (moduleText.match(/^(?:export )?type \$Kid\d+</gm) ?? []).length;
  const slice = /type \$Slice<A extends string> =[\s\S]*?\n\s*\?\s*`([^`]*)`/.exec(moduleText);
  if (!fanout || !slice) throw new Error("no $Kid/$Slice in module: cannot tell the trie shape");
  const bits = (slice[1]!.match(/\$\{/g) ?? []).length;
  const digitBits = Math.log2(fanout);
  if (!Number.isInteger(digitBits) || bits % digitBits !== 0) {
    throw new Error(`trie shape ${bits} bits does not split into ${fanout}-way digits`);
  }
  return { bits, digitBits };
};
/// PLAYPAL: 256 entries of r,g,b. DOOM Z_Mallocs the lump, so its address moves
/// between runs (83291 in one run, 821043 in the next). A hardcoded address
/// silently renders every pixel through garbage, so find it by its first four
/// entries instead: black, then the three darkest greys of the DOOM palette.
const PALETTE_SIGNATURE = [0, 0, 0, 31, 23, 11, 23, 15, 7, 75, 75, 75];
let paletteAddress: number | undefined;
const findPalette = (byteAt: (address: number) => number, limit: number) => {
  const matches = (base: number) =>
    PALETTE_SIGNATURE.every((byte, i) => byteAt(base + i) === byte);
  if (paletteAddress !== undefined && matches(paletteAddress)) return paletteAddress;
  for (let base = 0; base + PALETTE_SIGNATURE.length < limit; base++) {
    if (matches(base)) {
      paletteAddress = base;
      return base;
    }
  }
  throw new Error("no PLAYPAL in memory: cannot map colour indices to pixels");
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/// 8 bit truecolour, one filter byte per row, no interlacing
export const encodePng = (rgb: Buffer, width: number, height: number) => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/// the module's own `$InitialMemory`, so unwritten subtrees decode to the data
/// segments rather than to holes
let shape: { bits: number; digitBits: number } | undefined;

export const initialMemoryLiteral = (modulePath: string) => {
  const text = readFileSync(modulePath, "utf8");
  const match = /export type \$InitialMemory\s*=\s*([\s\S]*?)\n\n/.exec(text);
  if (!match) throw new Error(`no $InitialMemory in ${modulePath}`);
  // the same module says how its memory is shaped; read it while it is open
  shape = trieShape(text);
  return match[1]!.trim();
};

/// The buffer the checkpoint's own call drew into, when it has come back.
export const screenOf = (checkpoint: { result?: string }) =>
  checkpoint.result ? Number.parseInt(checkpoint.result.replace(/[^01]/g, ""), 2) : undefined;

export const frameFrom = (state: string, initial: string, screen = SCREEN) => {
  if (!shape) throw new Error("read the module with initialMemoryLiteral first: the trie shape comes from it");
  const words = decodeTrie(state, shape.bits, shape.digitBits, initial);
  const byteAt = (address: number) =>
    ((words.get(address >>> 2) ?? 0) >>> ((address & 3) * 8)) & 0xff;

  let limit = 0;
  for (const word of words.keys()) if (word > limit) limit = word;
  const palette = findPalette(byteAt, limit * 4 + 4);

  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  let painted = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const index = byteAt(screen + i);
    if (index !== 0) painted++;
    rgb[i * 3] = byteAt(palette + index * 3);
    rgb[i * 3 + 1] = byteAt(palette + index * 3 + 1);
    rgb[i * 3 + 2] = byteAt(palette + index * 3 + 2);
  }
  return { rgb, painted };
};

const scaleUp = (rgb: Buffer, scale: number) => {
  if (scale === 1) return rgb;
  const out = Buffer.alloc(WIDTH * scale * HEIGHT * scale * 3);
  for (let y = 0; y < HEIGHT * scale; y++)
    for (let x = 0; x < WIDTH * scale; x++) {
      const from = (((y / scale) | 0) * WIDTH + ((x / scale) | 0)) * 3;
      const to = (y * WIDTH * scale + x) * 3;
      rgb.copy(out, to, from, from + 3);
    }
  return out;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , checkpointPath, outPath, scaleArg] = process.argv;
  if (!checkpointPath || !outPath) {
    throw new Error("usage: render-frame.ts <checkpoint.json> <out.png> [scale]");
  }
  const scale = Number(scaleArg ?? 3);
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
  const initial = initialMemoryLiteral(join(__dirname, "doom.cfg.ts"));
  const { rgb, painted } = frameFrom(checkpoint.memory, initial, screenOf(checkpoint));
  writeFileSync(outPath, encodePng(scaleUp(rgb, scale), WIDTH * scale, HEIGHT * scale));
  const percent = ((painted / (WIDTH * HEIGHT)) * 100).toFixed(1);
  console.log(
    `${outPath}: ${painted}/${WIDTH * HEIGHT} pixels painted (${percent}%)` +
      `, chunk ${checkpoint.chunks}`,
  );
}
