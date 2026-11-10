import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { decodeTrie } from "./cfg/trie";
import { trieShape, initialMemoryLiteral, frameFrom } from "./doom/render-frame";
const initial = initialMemoryLiteral("./doom/doom.cfg.ts");
const shape = trieShape(readFileSync("./doom/doom.cfg.ts", "utf8"));
let hash = "", chunkAt = 0, mem = "";
const log = (s: string) => appendFileSync("/tmp/mon2.log", s + "\n");
const end = Date.now() + 3000000;
while (Date.now() < end) {
  let ck: any;
  try { ck = JSON.parse(readFileSync("/tmp/doom-live.json", "utf8")); } catch { await new Promise((r) => setTimeout(r, 4000)); continue; }
  const words = decodeTrie(ck.memory, shape.bits, shape.digitBits, initial);
  const { rgb, painted } = frameFrom(ck.memory, initial);
  const h = createHash("md5").update(rgb).digest("hex").slice(0, 8);
  const zone = words.get(174552 >>> 2) ?? 0;
  const frozen = ck.memory === mem;
  if (h !== hash || frozen || ck.done) {
    log(`chunk ${ck.chunks} ${h !== hash && hash ? "SCREEN CHANGED after " + (ck.chunks - chunkAt) + " chunks " : ""}painted ${painted} zone ${zone} pages ${parseInt(String(ck.globals[1]).replace(/'/g, ""), 2)}${frozen ? " MEM-FROZEN" : ""}${ck.done ? " DONE" : ""} top ${ck.frames[0]?.block}`);
    if (h !== hash) { hash = h; chunkAt = ck.chunks; }
  }
  mem = ck.memory;
  await new Promise((r) => setTimeout(r, 20000));
}
