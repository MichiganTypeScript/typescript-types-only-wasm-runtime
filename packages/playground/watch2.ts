import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { initialMemoryLiteral, frameFrom } from "./doom/render-frame";
const initial = initialMemoryLiteral("./doom/doom.cfg.ts");
let base = "", baseChunk = 0;
const end = Date.now() + 1500000;
while (Date.now() < end) {
  let ck: any;
  try { ck = JSON.parse(readFileSync("/tmp/doom-live.json", "utf8")); } catch { await new Promise((r) => setTimeout(r, 3000)); continue; }
  const { rgb, painted } = frameFrom(ck.memory, initial);
  const hash = createHash("md5").update(rgb).digest("hex").slice(0, 8);
  if (!base) { base = hash; baseChunk = ck.chunks; appendFileSync("/tmp/boundary.log", `base chunk ${ck.chunks} ${hash} painted ${painted}\n`); }
  else if (hash !== base) {
    appendFileSync("/tmp/boundary.log", `SCREEN CHANGED chunk ${ck.chunks} after ${ck.chunks - baseChunk} chunks painted ${painted} ${base} -> ${hash}\n`);
    base = hash; baseChunk = ck.chunks;
  }
  await new Promise((r) => setTimeout(r, 8000));
}
