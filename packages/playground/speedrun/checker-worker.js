// Runs Doom in the TypeScript type checker: cfg/drive.ts (bundled as run.browser.js)
// walks doom-keys.cfg.ts chunk by chunk, and every chunk is type-checked by a
// TypeScript checker compiled to WebAssembly: tsgo-doom, tsgo or tsrs. Nothing here
// executes doom.wasm: each frame is read out of the memory the checker's types
// evaluated to.
//
// in:  { runId, keyScript, checker: "tsgo-doom" | "ts7" | "tsrs", meta }   a new run: one held-key list per frame
//      { ..., continue: true }    the same, but keep the frames of the saved run up to
//                                 where its key script stops matching this one
//      { resume: true }           continue the run saved in OPFS
// out: { kind: "status", text }                   loading / tsc timings
//      { kind: "progress", index, chunks, ms }     a chunk of frame `index` checked
//      { kind: "frame", index, rgba, chunks, ms }  frame `index` finished
//      { kind: "kept", frames }                    frames 0 to frames-1 are the saved run's
//      { kind: "log", text } | { kind: "end", result } | { kind: "error", text }
import {
  start,
  moduleShape,
  rgbaFrom,
  inspectCheckpoint,
  encodeCheckpoint,
  decodeCheckpoint,
  encodeInspection,
} from "./run.browser.js?v=13";
import * as tsrs from "./tsrs/browser.js";
import * as tsgo from "./tsgo/tsgo.js?v=5";
import * as tsgoDoom from "./tsgo/tsgo-doom.js?v=6";

const tsgoDoomWasmUrl = new URL("./tsgo/tsgo-doom.wasm.gz?v=3.gz", import.meta.url);
const CHECKERS = {
  "tsgo-doom": { label: "tsgo-doom", load: () => tsgoDoom.loadModule(tsgoDoomWasmUrl), tsc: (args, o) => tsgoDoom.tsc(args, o) },
  teamchong: { label: "tsgo-doom", load: () => tsgoDoom.loadModule(tsgoDoomWasmUrl), tsc: (args, o) => tsgoDoom.tsc(args, o) },
  "ts?": { label: "tsgo", load: () => tsgo.loadModule(), tsc: (args, o) => tsgo.tsc(args, o) },
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
  try {
    if (at === 0) h.truncate(bytes.byteLength);
    h.write(bytes, { at });
    h.flush();
  } catch (e) {
    if (e?.name === "QuotaExceededError" || /quota/i.test(String(e?.message ?? e))) {
      throw new Error("QuotaExceededError: Browser storage is full — delete old runs under Playback → Your runs (or Export run) to free disk space, then click Run to resume.");
    }
    throw e;
  }
};

// A terminated worker lets go of its access handles some time after
// terminate() returns; until then opening one throws NoModificationAllowedError.
const openHandleRetry = async (name, maxRetries = 100) => {
  for (let i = 0; ; i++) {
    try {
      return await openHandle(name);
    } catch (e) {
      if (e?.name !== "NoModificationAllowedError" || i >= maxRetries) throw e;
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
const readBytes = async (name) => {
  const dir = await runDir;
  try {
    return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
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
  return decodeCheckpoint(new Uint8Array(await file.slice(at, at + len).arrayBuffer()))?.point ?? null;
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
  const demoA = new Map(), demoB = new Map();
  const out = new Array(n).fill(false);
  let curA, curB;
  const step = (entry, mem, demo, cur) => {
    const keys = Array.isArray(entry) ? entry : (entry?.keys ?? []);
    const pokes = Array.isArray(entry) ? [] : (entry?.poke ?? []);
    const other = [];
    for (const [addr, w] of pokes) {
      if (isDemoP(addr)) cur = w;
      else if (addr >= 8192 && addr < 65536) demo.set(addr, w);
      else if (addr < 65536) mem.set(addr, w);
      else other.push([addr, w]);
    }
    let tic;
    if (cur !== undefined) {
      const w = demo.get(cur);
      if (w === undefined || w === DEMO_END) cur = undefined;
      else { tic = w; cur += 4; }
    }
    return { cur, sig: JSON.stringify([keys, tic, other]) };
  };
  for (let i = 0; i < n; i++) {
    const sa = step(a[i], memA, demoA, curA);
    const sb = step(b[i], memB, demoB, curB);
    curA = sa.cur;
    curB = sb.cur;
    if (sa.sig !== sb.sig || curA !== curB) break;
    out[i] = sameMap(memA, memB);
  }
  return out;
};
const diffDemoPokes = (a, b, kept) => {
  const demoA = new Map(), demoB = new Map();
  for (let i = 0; i < kept; i++) {
    for (const [addr, w] of (Array.isArray(a[i]) ? [] : (a[i]?.poke ?? []))) {
      if (addr >= 8192 && addr < 65536) demoA.set(addr, w);
    }
    for (const [addr, w] of (Array.isArray(b[i]) ? [] : (b[i]?.poke ?? []))) {
      if (addr >= 8192 && addr < 65536) demoB.set(addr, w);
    }
  }
  const patch = [];
  for (const [addr, w] of demoB) {
    if (demoA.get(addr) !== w) patch.push([addr, w]);
  }
  return patch;
};

const readCheckpoint = async (runId, headerOnly = false) => {
  const dir = await runDir;
  if (!dir) return null;
  const saved = [];
  for (const i of [0, 1]) {
    try {
      const file = await (await dir.getFileHandle(`${runId}-ckpt-${i}.json`)).getFile();
      const head = new Uint8Array(await file.slice(0, 128).arrayBuffer());
      const hdr =
        head[0] === 0x7b
          ? decodeCheckpoint(new Uint8Array(await file.arrayBuffer()))
          : decodeCheckpoint(head, file.size);
      if (hdr) saved.push({ hdr, file, isJson: head[0] === 0x7b });
    } catch {
      /* torn write; the other file is whole */
    }
  }
  const best = saved.sort((a, b) => b.hdr.seq - a.hdr.seq)[0];
  if (!best) return null;
  if (headerOnly || best.isJson) return best.hdr;
  return decodeCheckpoint(new Uint8Array(await best.file.arrayBuffer()));
};

// Deletes orphaned run files not referenced by any active tab's `meta*.json` or `keep`.
const clearRun = async (keep, endName = "end.json", currentMetaName = "meta.json", currentRunId = null) => {
  const dir = await runDir;
  if (!dir) return;
  await dir.removeEntry(endName).catch(() => {});
  const activeFiles = new Set();
  if (keep) activeFiles.add(keep);
  const names = [];
  for await (const name of dir.keys()) {
    names.push(name);
    if (/^meta(?:-[\w-]+)?\.json$/.test(name)) {
      if (name === currentMetaName || name === "meta.json") continue;
      try {
        const m = JSON.parse((await readText(name)) ?? "null");
        if (!m || (currentRunId && m.runId === currentRunId) || m.files === keep) {
          await dir.removeEntry(name).catch(() => {});
          continue;
        }
        if (m?.files) activeFiles.add(m.files);
        if (m?.runId) activeFiles.add(m.runId);
      } catch {}
    }
  }
  for (const name of names) {
    if (name.endsWith("-bounds.jsonl") || name.endsWith("-bounds.json")) {
      try {
        const h = await openHandleRetry(name, 3);
        if (h) { try { h.truncate(0); h.flush(); } finally { h.close(); } }
      } catch {}
      await dir.removeEntry(name).catch(() => {});
      continue;
    }
    if (/^(?:meta|end)(?:-[\w-]+)?\.json$/.test(name)) continue;
    if (![...activeFiles].some((f) => name.startsWith(f + "-"))) {
      try {
        const h = await openHandleRetry(name, 2);
        if (h) { try { h.truncate(0); h.flush(); } finally { h.close(); } }
      } catch {}
      await dir.removeEntry(name).catch(() => {});
    }
  }
  // Remove any duplicate unfinished history/<id>.rgba for the active in-progress run
  try {
    const root = await navigator.storage.getDirectory();
    const hDir = await root.getDirectoryHandle("history", { create: false });
    for (const id of new Set([keep, currentRunId].filter(Boolean))) {
      await hDir.removeEntry(`${id}.rgba`).catch(() => {});
      await hDir.removeEntry(`${id}.json`).catch(() => {});
    }
  } catch {}
};

const readBytesSlice = async (name, len) => {
  if (len <= 0) return new Uint8Array(0);
  const dir = await runDir;
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await file.slice(0, len).arrayBuffer());
  } catch {
    return new Uint8Array(0);
  }
};

// Set up by openStore before the run; null when OPFS is unavailable.
let store = null;
const closeStore = () => {
  if (!store) return;
  for (const h of [store.frames, ...(store.ckpts || [])]) {
    try { h?.flush?.(); } catch {}
    try { h?.close?.(); } catch {}
  }
  store = null;
};
// `kept` frames of an earlier run with these files stay; everything past them is cut.
// If another tab holds `files` open (`NoModificationAllowedError`), forks to `forkRunId`
// and copies the `kept` prefix bytes so both tabs persist independently.
const openStore = async (files, kept = 0, _boundsIndex = [], forkRunId = null) => {
  closeStore();
  await clearRun(files, "end.json", "meta.json", forkRunId);
  try {
    const [frames, ckpt0, ckpt1] = await Promise.all(
      ["frames.rgba", "ckpt-0.json", "ckpt-1.json"].map((n) => openHandleRetry(`${files}-${n}`, 15)),
    );
    if (!frames) return files;
    frames.truncate(kept * FRAME_BYTES);
    store = { frames, ckpts: [ckpt0, ckpt1] };
    return files;
  } catch (e) {
    if (e?.name === "NoModificationAllowedError") {
      const forked = forkRunId && forkRunId !== files ? forkRunId : crypto.randomUUID();
      try {
        const frameBytes = await readBytesSlice(`${files}-frames.rgba`, kept * FRAME_BYTES);
        const [frames, ckpt0, ckpt1] = await Promise.all(
          ["frames.rgba", "ckpt-0.json", "ckpt-1.json"].map((n) => openHandleRetry(`${forked}-${n}`, 15)),
        );
        if (frames) {
          writeAll(frames, frameBytes);
          store = { frames, ckpts: [ckpt0, ckpt1] };
          return forked;
        }
      } catch (e2) {
        post({ kind: "log", text: `progress will not survive a reload: ${e2}` });
        return files;
      }
    }
    post({ kind: "log", text: `progress will not survive a reload: ${e}` });
    return files;
  }
};
const saveCheckpoint = (seq, point) => {
  if (!store) return;
  const bytes = encodeCheckpoint(seq, point);
  writeAll(store.ckpts[seq % 2], bytes);
  return bytes;
};
const boundsEnd = (index) => Math.max(0, ...index.filter(Boolean).map(([at, len]) => at + len));
// Called with the JSON saveCheckpoint wrote for frame n's end.
const saveBound = () => {};
const saveFrame = (n, rgba) => {
  if (store) writeAll(store.frames, rgba, n * FRAME_BYTES);
};

// A .gz is stored gzipped, not served with Content-Encoding, so inflate it here.
const text = async (url, label, silent = false) => {
  if (!silent) post({ kind: "status", text: `fetching ${label}` });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (url.endsWith(".gz")) return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return r.text();
};

let assets;
const load = async (silent = false) => {
  assets ??= (async () => {
    const [moduleText, lib, resume] = await Promise.all([
      text("data/doom-keys.cfg.ts.gz", "doom-keys.cfg.ts (Doom as TypeScript types)", silent),
      text("data/lib.json", "ts-type-math", silent),
      text("data/menu-boot.json", "skill-menu checkpoint", silent),
    ]);
    const parsedResume = JSON.parse(resume);
    const shape = moduleShape(moduleText);
    return {
      moduleText,
      libFiles: JSON.parse(lib),
      resume: parsedResume,
      shape,
      bootInspection: inspectCheckpoint(shape, parsedResume),
    };
  })();
  return assets;
};

self.onmessage = async ({ data }) => {
  try {
    let { keyScript, checker: checkerName, runId, tabId } = data;
    const metaName = tabId ? `meta-${tabId}.json` : "meta.json";
    const endName = tabId ? `end-${tabId}.json` : "end.json";
    let files = runId;
    let savedMeta = data.meta;
    let resume = null;
    let seq = 0;
    let kept = 0;
    let boundsIndex = [];
    let baseMs = 0;
    const readSavedMeta = async () => JSON.parse((await readText(metaName)) ?? (await readText("meta.json")) ?? "null");
    if (data.inspectOnly) {
      const a = await load(true);
      let pt = data.point ?? null;
      if (!pt) {
        const saved = await readSavedMeta();
        const ckpt = saved ? await readCheckpoint(saved.files ?? saved.runId) : null;
        pt = ckpt?.point ?? null;
      }
      const hasCkpt = !!pt;
      pt ??= a.resume;
      const inspection = encodeInspection(inspectCheckpoint(a.shape, pt));
      const bootInspection = encodeInspection(a.bootInspection);
      return post(
        {
          kind: "inspected",
          index: hasCkpt ? (pt.scriptFrame ?? 0) + (pt.done ? 1 : 0) : 0,
          chunks: !pt?.done ? (pt?.entryChunks ?? 0) : 0,
          done: !!pt?.done,
          inspection,
          bootInspection,
        },
        [inspection?.buffer, bootInspection?.buffer].filter(Boolean),
      );
    }
    if (data.resume) {
      const saved = await readSavedMeta();
      if (!saved) throw new Error("no saved run to resume");
      ({ runId, keyScript, checker: checkerName } = saved);
      savedMeta = saved.meta;
      files = saved.files ?? runId;
      const ckpt = await readCheckpoint(files);
      if (ckpt) ({ seq, point: resume } = ckpt);
      boundsIndex = await readBoundsIndex(files);
      kept = resume ? (resume.scriptFrame ?? 0) + (resume.done ? 1 : 0) : 0;
      baseMs = resume?.elapsedMs ?? (saved.meta?.startedAt ? Math.max(0, Date.now() - saved.meta.startedAt) : 0);
    } else {
      const saved = data.continue ? await readSavedMeta() : null;
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
    if (latest && (sameScript || aligned[Math.min(latestAt, aligned.length - 1)]) && latestKept >= f + 1 && (latestKept > 0 || sameScript)) {
      resume = latest;
      f = latestKept - 1;
        } else if (f >= 0) resume = await readBound(old, boundsIndex[f]);
        if (resume) {
          files = old;
          kept = f + 1;
          baseMs = resume.elapsedMs ?? 0;
          if (!sameScript && kept > 0 && kept < keyScript.length) {
            const patch = diffDemoPokes(saved.keyScript, keyScript, kept);
            if (patch.length) {
              keyScript = keyScript.slice();
              const entry = keyScript[kept];
              const keys = Array.isArray(entry) ? entry : (entry?.keys ?? []);
              const poke = Array.isArray(entry) ? patch : [...patch, ...(entry?.poke ?? [])];
              keyScript[kept] = { ...(Array.isArray(entry) ? {} : entry), keys, poke };
            }
          }
        }
      }
    }
    const openedFiles = await openStore(files, kept, boundsIndex, runId);
    const forked = openedFiles !== files;
    files = openedFiles;
    if (forked) runId = files;
    const metaPayload = JSON.stringify({ runId, files, meta: savedMeta, keyScript, checker: checkerName });
    await writeFile(metaName, metaPayload).catch(() => {});
    if (metaName !== "meta.json") await writeFile("meta.json", metaPayload).catch(() => {});
    await clearRun(files, endName, metaName, runId);
    if (resume) {
      seq = Math.max(seq, (await readCheckpoint(files, true))?.seq ?? 0);
      saveCheckpoint(++seq, resume);
    }
    if (!data.resume) {
      post({ kind: "kept", frames: kept, elapsedMs: baseMs });
    }
    if (resume?.done && kept >= keyScript.length) {
      await writeFile(endName, JSON.stringify({ ms: Math.round(baseMs) })).catch(() => {});
      return post({ kind: "end", result: { chunks: 0, ms: baseMs } });
    }
    const checker = CHECKERS[checkerName] ?? CHECKERS["tsgo-doom"];
    const a = await load();
    const initPt = resume ?? a.resume;
    const initIndex = resume ? (resume.scriptFrame ?? 0) + (resume.done ? 1 : 0) : 0;
    const initInspection = encodeInspection(inspectCheckpoint(a.shape, initPt));
    const bootInspection = encodeInspection(a.bootInspection);
    const initChunks = !initPt?.done ? (initPt?.entryChunks ?? 0) : 0;
    post(
      {
        kind: "inspected",
        index: initIndex,
        chunks: initChunks,
        done: !!initPt?.done,
        inspection: initInspection,
        bootInspection,
      },
      [initInspection?.buffer, bootInspection?.buffer].filter(Boolean),
    );
    post({ kind: "status", text: `fetching ${checker.label}` });
    await checker.load();
    post({
      kind: "status",
      text: resume ? `resuming at frame ${(resume.scriptFrame ?? 0) + 1}` : "type-checking chunk 1",
      index: initIndex,
      chunks: initChunks,
    });
    const t0 = performance.now();
    let index = initIndex;
    let framesInWorker = 0;
    let lastMemBytes = 0;
    const RECYCLE_SIGNAL = "__RECYCLE_WORKER__";
    const result = await start({
      tsc: checker.tsc,
      moduleText: a.moduleText,
      libFiles: a.libFiles,
      keyScript,
      resume: initPt,
      fuel: 16384,
      onCheckpoint: (p, path) => {
        if (path.endsWith(".final")) return;
        const ms = baseMs + (performance.now() - t0);
        p.elapsedMs = Math.round(ms);
        // mid-frame the screen is in a buffer `entry` has not returned yet
        if (p.scriptFrame !== undefined) index = p.scriptFrame;
        const inspection = encodeInspection(inspectCheckpoint(a.shape, p));
        if (!p.done) {
          saveCheckpoint(++seq, p);
          return post(
            { kind: "progress", index, chunks: p.entryChunks, ms, inspection },
            inspection ? [inspection.buffer] : [],
          );
        }
        const rgba = rgbaFrom(a.shape, p.memory, p.result);
        saveFrame(index, rgba);
        saveBound(index, saveCheckpoint(++seq, p));
        post(
          { kind: "frame", index, rgba, chunks: p.entryChunks, ms, inspection },
          [rgba.buffer, ...(inspection ? [inspection.buffer] : [])],
        );
        index++;
        framesInWorker++;
        if (index < keyScript.length && (framesInWorker >= 40 || lastMemBytes > 1500 * 1024 * 1024)) {
          throw new Error(RECYCLE_SIGNAL);
        }
      },
      onLog: (t) => post({ kind: "log", text: t }),
      onCheck: (ms, n, memBytes) => {
        if (memBytes) lastMemBytes = memBytes;
        post({
          kind: "status",
          text: `tsc ${ms.toFixed(0)} ms, ${n} probes${memBytes ? `, ${(memBytes / 1073741824).toFixed(2)} GB` : ""}`,
          memBytes,
        });
      },
    });
    const totalMs = baseMs + (performance.now() - t0);
    closeStore();
    // A failed run is not finished: leave end.json out so a reload retries from the checkpoint.
    if (!result.failed) await writeFile(endName, JSON.stringify({ ms: Math.round(totalMs) })).catch(() => {});
    post({ kind: "end", result: { chunks: result.chunks, failed: result.failed, ms: totalMs } });
  } catch (e) {
    closeStore();
    if (String(e?.message ?? e).includes("__RECYCLE_WORKER__")) {
      post({ kind: "recycle" });
    } else {
      post({ kind: "error", text: String(e?.stack ?? e) });
    }
  } finally {
    closeStore();
  }
};
