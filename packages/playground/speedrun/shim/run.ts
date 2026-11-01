// drive.ts, unchanged, on a host with no Node: files come from `vfs`, every
// chunk is checked by `host.tsc` (tsrs.wasm), and each saved checkpoint is
// handed to `onCheckpoint` as it lands. Bundled by build.mjs for Node (to
// compare against the native checker) and for the browser worker.
import { vfs, hooks } from "./fs";
import { process, log } from "./process";
import { host, type Tsc } from "./evaluate";
import { run, type Checkpoint } from "../../cfg/drive";

export interface Start {
  tsc: Tsc;
  /// doom-keys.cfg.ts
  moduleText: string;
  /// ts-type-math and global.d.ts, keyed by path under /p
  libFiles: Record<string, string>;
  /// KEY_SCRIPT: one held-key list per frame
  keyScript: string[][];
  resume: Checkpoint;
  fuel: number;
  onCheckpoint: (point: Checkpoint & { frames?: unknown[] }, path: string) => void;
  onLog: (text: string) => void;
  onCheck?: (ms: number, names: number, memoryBytes?: number) => void;
}

const SAVE = "/p/run.json";

export const start = async (o: Start) => {
  vfs.clear();
  vfs.set("/p/doom-keys.cfg.ts", o.moduleText);
  vfs.set("/p/keys.json", JSON.stringify(o.keyScript));
  vfs.set(SAVE, JSON.stringify(o.resume));
  // drive.ts reads keys, KEY_SCRIPT included, only once `<save>.input` parses;
  // without the file every chunk lands in its catch and the game sees no keys.
  vfs.set(`${SAVE}.input`, JSON.stringify({ rev: 0, keys: [] }));
  process.env.KEY_SCRIPT = "/p/keys.json";
  log.write = (_s, text) => o.onLog(text);
  hooks.onWrite = (path, text) => {
    if (path === SAVE || path === `${SAVE}.final`) o.onCheckpoint(JSON.parse(text), path);
  };
  host.tsc = o.tsc;
  host.root = "/p";
  host.files = o.libFiles;
  host.onRun = o.onCheck;
  host.config = {
    compilerOptions: {
      target: "ESNext",
      module: "ES2022",
      moduleResolution: "bundler",
      noErrorTruncation: true,
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      types: [],
      paths: { "ts-type-math": ["./ttm/index.d.ts"], "ts-type-math/*": ["./ttm/*"] },
    },
  };
  return run("/p/doom-keys.cfg.ts", "entry", [], {
    resume: o.resume,
    save: SAVE,
    every: 1,
    fuel: o.fuel,
    max: 100000000,
  });
};

export { moduleShape, rgbaFrom } from "./frame";
