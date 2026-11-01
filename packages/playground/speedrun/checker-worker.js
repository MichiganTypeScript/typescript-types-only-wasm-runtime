// Runs Doom in the TypeScript type checker: cfg/drive.ts (bundled as run.browser.js)
// walks doom-keys.cfg.ts chunk by chunk, and every chunk is type-checked by a
// TypeScript checker compiled to WebAssembly: tsgo-doom, tsgo or tsrs. Nothing here
// executes doom.wasm: each frame is read out of the memory the checker's types
// evaluated to.
//
// in:  { runId, keyScript, checker: "teamchong" | "ts7" | "tsrs", meta }   a new run: one held-key list per frame
//      { ..., continue: true }    the same, but keep the frames of the saved run up to
//                                 where its key script stops matching this one
//      { resume: true }           continue the run saved in OPFS
// out: { kind: "status", text }                   loading / tsc timings
//      { kind: "progress", index, chunks, ms }     a chunk of frame `index` checked
//      { kind: "frame", index, rgba, chunks, ms }  frame `index` finished
//      { kind: "kept", frames }                    frames 0 to frames-1 are the saved run's
//      { kind: "log", text } | { kind: "end", result } | { kind: "error", text }
import { start, moduleShape, rgbaFrom } from "./run.browser.js?v=2";
import * as tsrs from "./tsrs/browser.js";
import * as tsgo from "./tsgo/tsgo.js";
import * as teamchong from "./tsgo/teamchong.js?v=2";

const CHECKERS = {
  teamchong: { label: "tsgo-doom", load: () => teamchong.loadModule(), tsc: (args, o) => teamchong.tsc(args, o) },
  ts7: { label: "tsgo", load: () => tsgo.loadModule(), tsc: (args, o) => tsgo.tsc(args, o) },
  tsrs: { label: "tsrs", load: () => tsrs.loadModule(new URL("./tsrs/tsrs.wasm", import.meta.url)), tsc: (args, o) => tsrs.tsc(args, { ...o, stackSizeMb: 1024 }) },
};

const post = (m, transfer) => self.postMessage(m, transfer ?? []);

// The run is saved as it goes, so a reload picks it up where it stopped (the
// page reads the same directory; see restoreRun in index.html):
//   meta.json                { runId, files, meta, keyScript, checker }, written when the run starts
//   <files>-frames.rgba      every finished frame, 320x200 RGBA, frame n at n * FRAME_BYTES
//   <files>-ckpt-0/1.json    { seq, point }: drive.ts's checkpoint, after every chunk
//   <files>-bounds.jsonl     the checkpoint at the end of every frame, appended
//   <files>-bounds.json      [at, length] of frame n's entry in bounds.jsonl, or null
//   end.json                 the run reached the end of its script
// `files` is the runId of the run that created the files: a continued run
// keeps the frames and frame-end checkpoints its script shares with the old
// one, so editing tic 200 restarts at frame 200 rather than at frame 0.
// The writes are synchronous, through access handles opened before the run:
// drive.ts keeps this thread busy between chunks, and an async OPFS call made
// from onCheckpoint did not settle until the run ended. Checkpoints alternate
// between two files and the reader takes the higher seq, so a tab closed
// mid-write still leaves the previous one whole. A frame is written before the
// checkpoint that counts it done, so a resume never skips one. The runId keeps
// files the previous run still had open when it was terminated (so clearRun
// could not delete them) out of this run.
const RUN_DIR = "current-run";
const FRAME_BYTES = 320 * 200 * 4;
const runDir = (async () => {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(RUN_DIR, { create: true });
  } catch {
    return null;
  }
})();

const openHandle = async (name) => {
  const dir = await runDir;
  return dir && (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
};

const writeAll = (h, bytes, at = 0) => {
  if (at === 0) h.truncate(bytes.byteLength);
  h.write(bytes, { at });
  h.flush();
};

// A terminated worker lets go of its access handles some time after
// terminate() returns; until then opening one throws NoModificationAllowedError.
const openHandleRetry = async (name) => {
  for (let i = 0; ; i++) {
    try {
      return await openHandle(name);
    } catch (e) {
      if (e?.name !== "NoModificationAllowedError" || i >= 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
};

const writeFile = async (name, text) => {
  const h = await openHandle(name);
  if (!h) return;
  try { writeAll(h, new TextEncoder().encode(text)); } finally { h.close(); }
};

const readText = async (name) => {
  const dir = await runDir;
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
};

const readBoundsIndex = async (files) => {
  try { return JSON.parse((await readText(`${files}-bounds.json`)) ?? "[]"); } catch { return []; }
};
const readBound = async (files, [at, len]) => {
  const dir = await runDir;
  const file = await (await dir.getFileHandle(`${files}-bounds.jsonl`)).getFile();
  return JSON.parse(await file.slice(at, at + len).text());
};

// Frames where both scripts reach the same VM state: identical keys, active
// demo ticcmd, non-demo pokes, and demo buffer contents at frame end.
const isDemoP = (addr) => addr === 4408264 || addr === 3272296;
const DEMO_END = 128;
const sameMap = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
};
const alignedFrames = (a, b) => {
  const n = Math.min(a.length, b.length);
  const memA = new Map(), memB = new Map();
  const out = new Array(n).fill(false);
  let curA, curB;
  const step = (entry, mem, cur) => {
    const keys = Array.isArray(entry) ? entry : (entry?.keys ?? []);
    const pokes = Array.isArray(entry) ? [] : (entry?.poke ?? []);
    const other = [];
    for (const [addr, w] of pokes) {
      if (isDemoP(addr)) cur = w;
      else if (addr < 65536) mem.set(addr, w);
      else other.push([addr, w]);
    }
    let tic;
    if (cur !== undefined) {
      const w = mem.get(cur);
      if (w === undefined || w === DEMO_END) cur = undefined;
      else { tic = w; cur += 4; }
    }
    return { cur, sig: JSON.stringify([keys, tic, other]) };
  };
  for (let i = 0; i < n; i++) {
    const sa = step(a[i], memA, curA);
    const sb = step(b[i], memB, curB);
    curA = sa.cur;
    curB = sb.cur;
    if (sa.sig !== sb.sig || curA !== curB) break;
    out[i] = sameMap(memA, memB);
  }
  return out;
};

const readCheckpoint = async (runId) => {
  const saved = [];
  for (const i of [0, 1]) {
    const t = await readText(`${runId}-ckpt-${i}.json`);
    try { if (t) saved.push(JSON.parse(t)); } catch { /* torn write; the other file is whole */ }
  }
  return saved.sort((a, b) => b.seq - a.seq)[0] ?? null;
};

// Deletes the saved run's files, except those whose names start with `keep`.
const clearRun = async (keep) => {
  const dir = await runDir;
  if (!dir) return;
  const names = [];
  for await (const name of dir.keys()) names.push(name);
  for (const name of names) if (!keep || !name.startsWith(keep + "-")) await dir.removeEntry(name).catch(() => {});
};

// Set up by openStore before the run; null when OPFS is unavailable.
let store = null;
// `kept` frames of an earlier run with these files stay; everything past them is cut.
const openStore = async (files, kept = 0, boundsIndex = []) => {
  try {
    const [frames, ckpt0, ckpt1, bounds, boundsAt] = await Promise.all(
      ["frames.rgba", "ckpt-0.json", "ckpt-1.json", "bounds.jsonl", "bounds.json"].map((n) => openHandleRetry(`${files}-${n}`)),
    );
    if (!frames) return;
    const index = boundsIndex.slice(0, kept);
    frames.truncate(kept * FRAME_BYTES);
    bounds.truncate(boundsEnd(index));
    writeAll(boundsAt, new TextEncoder().encode(JSON.stringify(index)));
    store = { frames, ckpts: [ckpt0, ckpt1], bounds, boundsAt, index };
  } catch (e) {
    post({ kind: "log", text: `progress will not survive a reload: ${e}` });
  }
};
const encoder = new TextEncoder();
const saveCheckpoint = (seq, point) => {
  if (!store) return;
  const json = typeof point === "string" ? point : JSON.stringify(point);
  writeAll(store.ckpts[seq % 2], encoder.encode(`{"seq":${seq},"point":${json}}`));
  return json;
};
const boundsEnd = (index) => Math.max(0, ...index.filter(Boolean).map(([at, len]) => at + len));
// Called with the JSON saveCheckpoint wrote for frame n's end.
const saveBound = (n, json) => {
  if (!store || !json) return;
  const bytes = encoder.encode(json);
  const at = boundsEnd(store.index);
  store.bounds.write(bytes, { at });
  store.bounds.flush();
  store.index[n] = [at, bytes.byteLength];
  writeAll(store.boundsAt, encoder.encode(JSON.stringify(store.index)));
};
const saveFrame = (n, rgba) => {
  if (store) writeAll(store.frames, rgba, n * FRAME_BYTES);
};

// A .gz is stored gzipped, not served with Content-Encoding, so inflate it here.
const text = async (url, label) => {
  post({ kind: "status", text: `fetching ${label}` });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (url.endsWith(".gz")) return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return r.text();
};

let assets;
const load = async () => {
  assets ??= (async () => {
    const [moduleText, lib, resume] = await Promise.all([
      text("data/doom-keys.cfg.ts.gz", "doom-keys.cfg.ts (Doom as TypeScript types)"),
      text("data/lib.json", "ts-type-math"),
      text("data/menu-boot.json", "skill-menu checkpoint"),
    ]);
    return { moduleText, libFiles: JSON.parse(lib), resume: JSON.parse(resume), shape: moduleShape(moduleText) };
  })();
  return assets;
};

self.onmessage = async ({ data }) => {
  try {
    let { keyScript, checker: checkerName, runId } = data;
    let files = runId;
    let resume = null;
    let seq = 0;
    let kept = 0;
    let boundsIndex = [];
    let baseMs = 0;
    if (data.resume) {
      const saved = JSON.parse((await readText("meta.json")) ?? "null");
      if (!saved) throw new Error("no saved run to resume");
      ({ runId, keyScript, checker: checkerName } = saved);
      files = saved.files ?? runId;
      const ckpt = await readCheckpoint(files);
      if (ckpt) ({ seq, point: resume } = ckpt);
      boundsIndex = await readBoundsIndex(files);
      kept = resume ? (resume.scriptFrame ?? 0) + (resume.done ? 1 : 0) : 0;
      baseMs = resume?.elapsedMs ?? (saved.meta?.startedAt ? Math.max(0, Date.now() - saved.meta.startedAt) : 0);
    } else {
      const saved = data.continue ? JSON.parse((await readText("meta.json")) ?? "null") : null;
      if (saved && Array.isArray(saved.keyScript)) {
        const old = saved.files ?? saved.runId;
        boundsIndex = await readBoundsIndex(old);
        // The newest frame end the two scripts agree on and a checkpoint was
        // saved for. An imported run has no bounds, only its latest checkpoint.
        const aligned = alignedFrames(saved.keyScript, keyScript);
        const sameScript = saved.keyScript.length === keyScript.length && aligned.every(Boolean);
        let f = Math.min(aligned.length - 1, boundsIndex.length - 1);
        while (f >= 0 && (!boundsIndex[f] || !aligned[f])) f--;
        // The latest checkpoint wins while its frame is still aligned, even
        // mid-frame — except when 0 frames finished and the user switched scripts,
        // where restarting from 0 should reset the timer and start fresh.
        const latest = (await readCheckpoint(old))?.point;
        const latestAt = latest ? latest.scriptFrame ?? 0 : -1;
        const latestKept = latest ? latestAt + (latest.done ? 1 : 0) : 0;
        if (latest && aligned[latestAt] && latestKept >= f + 1 && (latestKept > 0 || sameScript)) {
          resume = latest;
          f = latestKept - 1;
        } else if (f >= 0) resume = await readBound(old, boundsIndex[f]);
        if (resume) {
          files = old;
          kept = f + 1;
          baseMs = resume.elapsedMs ?? 0;
        }
      }
      await clearRun(resume ? files : null);
      await writeFile("meta.json", JSON.stringify({ runId, files, meta: data.meta, keyScript, checker: checkerName }));
    }
    await openStore(files, kept, boundsIndex);
    if (!data.resume) {
      post({ kind: "kept", frames: kept, elapsedMs: baseMs });
      // a reload now resumes from the kept frame's end, not from where the old run was
      if (resume) seq = Math.max(seq, (await readCheckpoint(files))?.seq ?? 0), saveCheckpoint(++seq, resume);
    }
    if (resume?.done && kept >= keyScript.length) {
      await writeFile("end.json", JSON.stringify({ ms: Math.round(baseMs) }));
      return post({ kind: "end", result: { chunks: 0, ms: baseMs } });
    }
    const checker = CHECKERS[checkerName] ?? CHECKERS.teamchong;
    const a = await load();
    post({ kind: "status", text: `fetching ${checker.label}` });
    await checker.load();
    post({ kind: "status", text: resume ? `resuming at frame ${(resume.scriptFrame ?? 0) + 1}` : "type-checking chunk 1" });
    const t0 = performance.now();
    let index = resume ? (resume.scriptFrame ?? 0) + (resume.done ? 1 : 0) : 0;
    const result = await start({
      tsc: checker.tsc,
      moduleText: a.moduleText,
      libFiles: a.libFiles,
      keyScript,
      resume: resume ?? a.resume,
      fuel: 12288,
      onCheckpoint: (p, path) => {
        if (path.endsWith(".final")) return;
        const ms = baseMs + (performance.now() - t0);
        p.elapsedMs = Math.round(ms);
        // mid-frame the screen is in a buffer `entry` has not returned yet
        if (p.scriptFrame !== undefined) index = p.scriptFrame;
        if (!p.done) {
          saveCheckpoint(++seq, p);
          return post({ kind: "progress", index, chunks: p.entryChunks, ms });
        }
        const rgba = rgbaFrom(a.shape, p.memory, p.result);
        saveFrame(index, rgba);
        saveBound(index, saveCheckpoint(++seq, p));
        post({ kind: "frame", index, rgba, chunks: p.entryChunks, ms }, [rgba.buffer]);
        index++;
      },
      onLog: (t) => post({ kind: "log", text: t }),
      onCheck: (ms, n) => post({ kind: "status", text: `tsc ${ms.toFixed(0)} ms, ${n} probes` }),
    });
    const totalMs = baseMs + (performance.now() - t0);
    // A failed run is not finished: leave end.json out so a reload retries from the checkpoint.
    if (!result.failed) await writeFile("end.json", JSON.stringify({ ms: Math.round(totalMs) }));
    post({ kind: "end", result: { chunks: result.chunks, failed: result.failed, ms: totalMs } });
  } catch (e) {
    post({ kind: "error", text: String(e?.stack ?? e) });
  }
};
