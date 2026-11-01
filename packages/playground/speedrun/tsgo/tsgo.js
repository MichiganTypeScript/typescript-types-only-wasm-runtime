// TS7.1's checker (tsgo, typescript-go built with GOOS=js GOARCH=wasm) behind the same
// `tsc(args, { cwd, files, diagnostics: "json" })` call as tsrs's browser.js, so drive.ts can
// run on either. Go's syscall/js reaches the file system through `globalThis.fs` and
// `globalThis.process`, Node's API shape; both are swapped for in-memory versions for the
// length of one run. A Go instance runs `main` once, so every call gets a new instance of
// the module, which is compiled once.
import "./wasm_exec.js";

let loading;

/** Fetches and compiles ts7.wasm.gz (next to this file by default). A failed load is not cached. */
export function loadModule(url = new URL("./ts7.wasm.gz", import.meta.url)) {
  loading ??= (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`tsgo: fetching ${url} failed with ${response.status}`);
    // Stored gzipped (Cloudflare's 25 MiB per-file limit) and served without Content-Encoding.
    const body = String(url).endsWith(".gz") ? response.body.pipeThrough(new DecompressionStream("gzip")) : response.body;
    return WebAssembly.compile(await new Response(body).arrayBuffer());
  })();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
// The 100 MiB doom-keys.cfg.ts is the same string on every call; encode it once.
const encoded = new Map();
const bytesOf = (path, text) => {
  const hit = encoded.get(path);
  if (hit && hit.text === text) return hit.bytes;
  const bytes = encoder.encode(text);
  encoded.set(path, { text, bytes });
  return bytes;
};

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const errno = (code) => Object.assign(new Error(code), { code });

function memoryFs(files, onOut) {
  const dirs = new Set(["/"]);
  for (const p of Object.keys(files)) for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) dirs.add(p.slice(0, i));
  const norm = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  const stat = (p) => {
    p = norm(p);
    const isDir = dirs.has(p);
    if (!isDir && !(p in files)) return null;
    const size = isDir ? 0 : bytesOf(p, files[p]).length;
    return {
      dev: 0, ino: 0, mode: isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size, blksize: 4096, blocks: Math.ceil(size / 512), atimeMs: 0, mtimeMs: 0, ctimeMs: 0,
      isDirectory: () => isDir,
    };
  };
  const fds = new Map();
  let nextFd = 3;
  const write = (fd, buf) => {
    if (fd === 1 || fd === 2) onOut(fd, buf.slice());
    return buf.length;
  };
  return {
    constants: { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_TRUNC: 512, O_APPEND: 1024, O_EXCL: 128, O_DIRECTORY: 65536 },
    writeSync: write,
    write(fd, buf, offset, length, position, cb) {
      cb(null, write(fd, buf.subarray(offset, offset + length)));
    },
    open(path, flags, _mode, cb) {
      const st = stat(path);
      if (flags & 3) return cb(errno("EROFS")); // the checker runs with noEmit; nothing is written
      if (!st) return cb(errno("ENOENT"));
      const fd = nextFd++;
      fds.set(fd, { path: norm(path), pos: 0, st });
      cb(null, fd);
    },
    close(fd, cb) {
      fds.delete(fd);
      cb(null);
    },
    fstat(fd, cb) {
      const f = fds.get(fd);
      f ? cb(null, f.st) : cb(errno("EBADF"));
    },
    stat(path, cb) {
      const st = stat(path);
      st ? cb(null, st) : cb(errno("ENOENT"));
    },
    lstat(path, cb) {
      this.stat(path, cb);
    },
    read(fd, buffer, offset, length, position, cb) {
      const f = fds.get(fd);
      if (!f) return cb(errno("EBADF"));
      if (f.st.isDirectory()) return cb(errno("EISDIR"));
      const bytes = bytesOf(f.path, files[f.path]);
      const at = position ?? f.pos;
      const n = Math.max(0, Math.min(length, bytes.length - at));
      buffer.set(bytes.subarray(at, at + n), offset);
      if (position == null) f.pos += n;
      cb(null, n);
    },
    readdir(path, cb) {
      const p = norm(path);
      if (!dirs.has(p)) return cb(errno("ENOENT"));
      const prefix = p === "/" ? "/" : p + "/";
      const names = new Set();
      for (const q of [...dirs, ...Object.keys(files)])
        if (q.startsWith(prefix) && q.length > prefix.length) names.add(q.slice(prefix.length).split("/")[0]);
      cb(null, [...names]);
    },
    readlink: (_p, cb) => cb(errno("EINVAL")),
    fsync: (_fd, cb) => cb(null),
    ...Object.fromEntries(
      ["chmod", "chown", "fchmod", "fchown", "ftruncate", "lchown", "link", "mkdir", "rename", "rmdir", "symlink", "truncate", "unlink", "utimes"].map(
        (name) => [name, (...args) => args.at(-1)(errno("EROFS"))],
      ),
    ),
  };
}

// `--pretty false` prints one `file(line,col): error TS1234: message` per diagnostic, with the
// message's elaboration on indented lines after it.
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error|warning|message) TS(\d+): (.*)$/;

/** Runs `tsgo args` over `options.files`; diagnostics come back in tsrs's JSON shape. */
export async function tsc(args, options = {}) {
  const module = options.module ?? (await loadModule(options.url));
  const cwd = options.cwd ?? "/";
  const out = [];
  const err = [];
  const saved = { fs: globalThis.fs, process: globalThis.process };
  globalThis.fs = memoryFs(options.files ?? {}, (fd, b) => (fd === 1 ? out : err).push(b));
  globalThis.process = {
    getuid: () => -1, getgid: () => -1, geteuid: () => -1, getegid: () => -1, getgroups: () => [], pid: -1, ppid: -1,
    umask: () => 0o22, cwd: () => cwd, chdir: () => { throw errno("ENOSYS"); },
  };
  const go = new globalThis.Go();
  go.argv = ["tsgo", ...args, "--pretty", "false"];
  go.env = options.env ?? {};
  let exitCode = 0;
  go.exit = (code) => {
    exitCode = code;
  };
  let memoryBytes = 0;
  try {
    const instance = await WebAssembly.instantiate(module, go.importObject);
    await go.run(instance);
    memoryBytes = instance.exports.mem?.buffer?.byteLength ?? 0;
  } finally {
    globalThis.fs = saved.fs;
    globalThis.process = saved.process;
  }
  const text = (chunks) => chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
  const stdout = text(out);
  const result = { exitCode, stdout, stderr: text(err), memoryBytes };
  if (options.diagnostics === "json") result.diagnostics = parseDiagnostics(stdout, cwd);
  return result;
}

/** `--pretty false` output in tsrs's JSON diagnostic shape. */
export function parseDiagnostics(stdout, cwd) {
  const diagnostics = [];
  for (const line of stdout.split("\n")) {
    const m = DIAGNOSTIC.exec(line);
    if (m) {
      const file = m[1].startsWith("/") ? m[1] : `${cwd.replace(/\/$/, "")}/${m[1]}`;
      diagnostics.push({ fileName: file, startPosition: { line: Number(m[2]) - 1, character: Number(m[3]) - 1 }, code: Number(m[5]), category: m[4], text: m[6] });
    } else if (diagnostics.length && /^\s/.test(line)) diagnostics.at(-1).text += "\n" + line.trim();
  }
  return diagnostics;
}
