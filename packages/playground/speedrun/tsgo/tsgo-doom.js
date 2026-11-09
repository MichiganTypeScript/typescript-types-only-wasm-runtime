// tsgo-doom: typescript-go with checker memory and Wasm speedups,
// built with TinyGo for wasm32-wasip1. It speaks tsrs's ABI (tsrs_input / tsrs_run / tsrs_output and
// the tsrs_host.fs import), so the file system and request encoding come from tsrs's core.js.
//
// Unlike tsrs and stock tsgo, one instance serves every call. After the first run the build marks
// its heap, keeps the parsed and bound .d.ts files below the mark (lib.*.d.ts, ts-type-math, the
// doom module), and rewinds to the mark after each run. A new instance per call would parse all of
// them again every chunk. A trap leaves the instance in an unknown state, so it is dropped.
import { makeRequest, memoryFileSystem, NotFoundError } from "../tsrs/core.js";
import { decodeWasmDiagnostics } from "../run.browser.js?v=13";
import { parseDiagnostics } from "./tsgo.js";

const OP_READ = 0, OP_STAT = 1, OP_READ_DIR = 2, OP_REALPATH = 3, OP_WRITE = 4, OP_APPEND = 5, OP_REMOVE = 6, OP_CHTIMES = 7;
const EXIT_CRASHED = 5;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

class WasiExit extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.code = code;
  }
}

let loading;

/** Fetches and compiles tsgo-doom.wasm.gz (next to this file by default). A failed load is not cached. */
export function loadModule(url = new URL("./tsgo-doom.wasm.gz", import.meta.url)) {
  loading ??= (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`tsgo-doom: fetching ${url} failed with ${response.status}`);
    // Stored gzipped and served without Content-Encoding, like ts7.wasm.gz.
    const body = String(url).endsWith(".gz") ? response.body.pipeThrough(new DecompressionStream("gzip")) : response.body;
    return WebAssembly.compile(await new Response(body).arrayBuffer());
  })();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

// The instance and the run its imports currently serve.
let instance;
let memory;
let cur;

const view = () => new DataView(memory.buffer);
// Workers can reject subarray's species construction above 128 MiB; direct views work at those offsets.
const bytes = (ptr = 0, len) => new Uint8Array(memory.buffer, ptr >>> 0, len === undefined ? undefined : len >>> 0);
const getUint32 = (ptr) => view().getUint32(ptr >>> 0, true);
const setUint32 = (ptr, value) => view().setUint32(ptr >>> 0, value, true);
const setBigUint64 = (ptr, value) => view().setBigUint64(ptr >>> 0, value, true);
const text = (ptr, len) => decoder.decode(bytes(ptr, len));
const splitNul = (ptr, len) => {
  const b = bytes(ptr, len);
  const i = b.indexOf(0);
  return [decoder.decode(bytes(ptr, i < 0 ? len : i)), b.slice(i < 0 ? len : i + 1)];
};
const stage = (data) => {
  cur.staged = typeof data === "string" ? encoder.encode(data) : data;
  return cur.staged.length;
};

const fsCall = (op, ptr, len) => {
  const host = cur.host;
  try {
    switch (op) {
      case OP_READ:
        return stage(host.readFile(text(ptr, len)));
      case OP_STAT: {
        const s = host.stat(text(ptr, len));
        return stage(`${s.kind} ${s.size} ${s.mtimeNs}`);
      }
      case OP_READ_DIR:
        return stage(host.readDir(text(ptr, len)).map(([kind, name]) => `${kind}${name}\0`).join(""));
      case OP_REALPATH:
        return stage(host.realpath(text(ptr, len)));
      case OP_WRITE:
      case OP_APPEND: {
        const [path, data] = splitNul(ptr, len);
        host.writeFile(path, data, op === OP_APPEND);
        return stage("");
      }
      case OP_REMOVE:
        host.remove(text(ptr, len));
        return stage("");
      case OP_CHTIMES:
        return stage("");
      default:
        return -2 - stage(`unknown op ${op}`);
    }
  } catch (e) {
    if (e instanceof NotFoundError) return -1;
    return -2 - stage(String(e?.message ?? e));
  }
};

const wasi = {
  args_sizes_get(argc, size) {
    setUint32(argc, 0);
    setUint32(size, 0);
    return 0;
  },
  args_get: () => 0,
  environ_sizes_get(count, size) {
    setUint32(count, 0);
    setUint32(size, 0);
    return 0;
  },
  environ_get: () => 0,
  clock_time_get(id, _precision, out) {
    const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
    setBigUint64(out, BigInt(Math.round(ms * 1e6)));
    return 0;
  },
  clock_res_get(_id, out) {
    setBigUint64(out, 1000n);
    return 0;
  },
  random_get(ptr, len) {
    const p = ptr >>> 0, n = len >>> 0;
    for (let off = 0; off < n; off += 65536) crypto.getRandomValues(bytes(p + off, Math.min(65536, n - off)));
    return 0;
  },
  fd_write(fd, iovs, count, written) {
    if (fd !== 1 && fd !== 2) return 8;
    let total = 0;
    const base = iovs >>> 0;
    for (let i = 0; i < (count >>> 0); i++) {
      const ptr = getUint32(base + i * 8);
      const len = getUint32(base + i * 8 + 4);
      (fd === 1 ? cur.out : cur.err).push(bytes(ptr, len).slice());
      total += len;
    }
    setUint32(written, total);
    return 0;
  },
  fd_fdstat_get(fd, out) {
    if (fd > 2) return 8;
    bytes(out, 24).fill(0);
    return 0;
  },
  fd_prestat_get: () => 8,
  fd_prestat_dir_name: () => 8,
  fd_close: () => 8,
  proc_exit(code) {
    throw new WasiExit(code);
  },
  sched_yield: () => 0,
  poll_oneoff: () => 0,
};

async function getInstance(module) {
  if (instance) return instance;
  const imports = { tsrs_host: { fs: fsCall, fs_take: (ptr) => bytes(ptr, cur.staged.length).set(cur.staged) }, wasi_snapshot_preview1: {} };
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module === "wasi_snapshot_preview1") imports.wasi_snapshot_preview1[imp.name] = wasi[imp.name] ?? (() => 52);
  }
  const inst = await WebAssembly.instantiate(module, imports);
  memory = inst.exports.memory;
  inst.exports._initialize?.();
  instance = inst;
  return inst;
}

/** Same call shape as tsrs's browser.js `tsc`. options.module: an already compiled WebAssembly.Module. */
export async function tsc(args, options = {}) {
  const module = options.module ?? (await loadModule(options.url));
  const inst = await getInstance(module);
  const host = memoryFileSystem(options.files ?? {}, { caseInsensitive: !!options.caseInsensitive });
  const json = options.diagnostics === "json";
  const cwd = options.cwd ?? "/";
  cur = { host, out: [], err: [], staged: new Uint8Array(0) };
  // Pass capnDiagnostics (flag bit 8) so wasm_wasip1.go runs with --quiet and packs
  // result.Diagnostics into the pre-watermark 16 MiB capnstruct WasmDiagBatch buffer
  // before ResetWasmHeapToWatermark() rewinds the TinyGo bump heap.
  const request = makeRequest(args, { cwd, json: false, caseInsensitive: !!options.caseInsensitive });
  if (json) request.flags = (request.flags ?? 0) | 8;
  let exitCode;
  try {
    const req = encoder.encode([request.cwd, String(request.flags ?? 0), ...request.args].join("\0"));
    const inPtr = inst.exports.tsrs_input(req.length);
    bytes(inPtr, req.length).set(req);
    exitCode = inst.exports.tsrs_run();
  } catch (e) {
    if (e instanceof WasiExit) {
      exitCode = e.code;
    } else if (e instanceof WebAssembly.RuntimeError || (e instanceof RangeError && /call stack/i.test(e.message))) {
      cur.err.push(encoder.encode(`error: tsgo-doom trapped (${e.name}: ${e.message})\n`));
      exitCode = EXIT_CRASHED;
      instance = undefined;
    } else {
      instance = undefined;
      throw e;
    }
  }
  const joined = (chunks) => chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
  const stdout = cur.out.length ? joined(cur.out) : "";
  let diagnostics;
  if (json) {
    const outLen = instance && typeof inst.exports.tsrs_output_len === "function" ? inst.exports.tsrs_output_len() >>> 0 : 0;
    if (outLen >= 8 && typeof inst.exports.tsrs_output === "function") {
      diagnostics = decodeWasmDiagnostics(memory, inst.exports.tsrs_output() >>> 0, outLen);
    } else {
      diagnostics = parseDiagnostics(stdout, cwd);
    }
  }
  return {
    exitCode,
    stdout,
    stderr: joined(cur.err),
    diagnostics,
    files: Object.fromEntries(host.written),
    memoryBytes: memory.buffer.byteLength,
  };
}
