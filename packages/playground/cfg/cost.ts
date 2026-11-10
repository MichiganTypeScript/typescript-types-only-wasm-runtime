// What does a frame actually cost, without a stopwatch?
//
// Wall time on a laptop swings by 40% between identical runs, which is wider
// than most of the changes worth making. `tsc --extendedDiagnostics` reports
// instantiations instead, and that number is deterministic. The catch is that
// most of it is the checker looking at declarations, which the driver never
// pays for - it asks for one type and the checker resolves only what that
// needs. So the honest figure is the *difference* between the chunk as it ran
// and the same chunk with its entry call replaced by a constant: everything
// that is left is the program running.
//
// Measured against the clock once, to be sure it means anything: a gfx chunk
// came out at 0.101s of marginal check time against 99ms of evaluation inside
// the driver.
//
// Dump chunks to feed it with:
//   DUMP_CHUNKS=/tmp/chunks WASM=... MODULE=... tsx packages/playground/cfg/verify.ts
//   tsx packages/playground/cfg/cost.ts /tmp/chunks/*.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../../..");
const scratch = join(root, "packages/playground/probes/measure");
const tsc = join(root, "node_modules/typescript/lib/tsc.js");
const ZERO = `'${"0".repeat(32)}'`;

mkdirSync(scratch, { recursive: true });
writeFileSync(
  join(scratch, "tsconfig.json"),
  JSON.stringify({
    extends: "../../../../tsconfig.json",
    compilerOptions: { incremental: false, tsBuildInfoFile: null },
    include: ["./one.ts", "./module.d.ts", "./state.d.ts"],
  }),
);

const instantiations = (text: string) => {
  writeFileSync(join(scratch, "one.ts"), text);
  // tsc exits nonzero whenever the chunk has an error, but the count is still
  // on stdout and still the number we came for
  const run = () =>
    execFileSync(process.execPath, [tsc, "--noEmit", "--extendedDiagnostics", "-p", scratch], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  let out: string;
  try {
    out = run();
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
  return Number(/Instantiations:\s+(\d+)/.exec(out)?.[1] ?? NaN);
};

// the same file with nothing to run: whatever this costs is not the program
const idle = (text: string) =>
  text
    .split("\n")
    .map((line) => (line.startsWith("type $Result = ") ? `type $Result = ['r', $Zero, ${ZERO}]` : line))
    .join("\n");

let total = 0;
for (const path of process.argv.slice(2)) {
  // the dump splits one program across three files; the chunk alone has no $Buf
  writeFileSync(join(scratch, "module.d.ts"), readFileSync(join(dirname(path), "module.d.ts"), "utf8"));
  writeFileSync(join(scratch, "state.d.ts"), readFileSync(path.replace(/\.ts$/, ".state.d.ts"), "utf8"));
  const text = readFileSync(path, "utf8");
  const work = instantiations(text) - instantiations(idle(text));
  total += work;
  console.log(`${path.split("/").slice(-1)[0].padEnd(20)} ${work.toString().padStart(9)}`);
}
if (process.argv.length > 3) console.log(`${"total".padEnd(20)} ${total.toString().padStart(9)}`);
rmSync(scratch, { recursive: true, force: true });
