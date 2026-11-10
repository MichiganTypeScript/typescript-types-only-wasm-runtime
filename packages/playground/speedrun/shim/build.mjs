// Bundles shim/run.ts with drive.ts, swapping its Node imports for the shims.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
// esbuild is in the workspace only as a transitive dependency (vite's), so it is
// not on any package's resolution path: take it from the pnpm store directly.
const store = fileURLToPath(new URL("../../../../node_modules/.pnpm/", import.meta.url));
const dir = readdirSync(store).filter((d) => d.startsWith("esbuild@")).sort().at(-1);
const { build } = await import(`${store}${dir}/node_modules/esbuild/lib/main.js`);
const here = fileURLToPath(new URL(".", import.meta.url));
const platform = process.argv[2] ?? "node";
await build({
  entryPoints: [here + "run.ts"],
  outfile: here + `../run.${platform}.js`,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  alias: {
    "node:fs": here + "fs.ts",
    "node:path": here + "path.ts",
    "node:url": here + "url.ts",
    "capnstruct": process.env.CAPNSTRUCT_ENTRY ?? (process.env.HOME + "/repos/capnstruct/src/index.ts"),
  },
  plugins: [
    {
      name: "evaluate",
      setup(b) {
        b.onResolve({ filter: /\/evaluate\/ts$/ }, () => ({ path: here + "evaluate.ts" }));
      },
    },
  ],
  inject: [here + "process.ts"],
  define: { "import.meta.url": '"file:///p/drive.ts"' },
  logLevel: "warning",
});

// The browser also needs the inputs drive.ts reads off disk, and tsrs itself.
// All of it is generated into speedrun/ (gitignored): doom-keys.cfg.ts is 106 MB.
if (platform === "browser") {
  const { mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } = await import("node:fs");
  const { join, relative } = await import("node:path");
  const out = here + "../";
  const pg = here + "../../";
  const repo = pg + "../../";
  mkdirSync(out + "data", { recursive: true });
  mkdirSync(out + "tsrs", { recursive: true });
  // doom-keys.cfg.ts is 101 MiB, over Cloudflare's 25 MiB per-asset limit;
  // gzipped it is about 10 MiB. checker-worker.js inflates it.
  const { gzipSync } = await import("node:zlib");
  writeFileSync(out + "data/doom-keys.cfg.ts.gz", gzipSync(readFileSync(pg + "doom/doom-keys.cfg.ts"), { level: 9 }));
  copyFileSync(pg + "doom/.live/menu-boot.json", out + "data/menu-boot.json");
  const lib = { "/p/global.d.ts": readFileSync(repo + "global.d.ts", "utf8") };
  // ts-type-math goes in as declaration files: under skipLibCheck the checker
  // then never checks them, and tsgo parses their type literals lazily.
  // Imports like `./add` resolve to `add.d.ts` the same way.
  const ttm = pg + "../ts-type-math";
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (n === "node_modules" || n === "tests" || n === "test-cases") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) lib["/p/ttm/" + relative(ttm, p).replace(/(?<!\.d)\.ts$/, ".d.ts")] = readFileSync(p, "utf8");
    }
  };
  walk(ttm);
  writeFileSync(out + "data/lib.json", JSON.stringify(lib));
  // TSRS_PKG: a tsrs checkout's npm/tsrs-wasm with tsrs.wasm built in it
  const tsrs = process.env.TSRS_PKG ?? process.env.HOME + "/repos/tsrs/npm/tsrs-wasm";
  for (const f of ["browser.js", "core.js"]) copyFileSync(join(tsrs, f), out + "tsrs/" + f);
  copyFileSync(process.env.TSRS_WASM ?? join(tsrs, "tsrs.wasm"), out + "tsrs/tsrs.wasm");
  // Monaco is served from this directory, not a CDN. The locale bundles are
  // left out: the page is English only.
  const { cpSync } = await import("node:fs");
  cpSync(pg + "node_modules/monaco-editor/min/vs", out + "monaco/vs", {
    recursive: true,
    filter: (src) => !/nls\.messages\.[\w-]+\.js$/.test(src),
  });
}
