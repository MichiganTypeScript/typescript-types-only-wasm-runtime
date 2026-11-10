// Minimal repro of the only thing blocking a checker from driving the game.
//
// The driver (packages/playground/evaluate/ts.ts) does exactly this per chunk:
//   createSnapshot({openProjects, openFiles}) -> getProject -> project.checker
//   -> getTypeFromTypeNode(alias.type) -> typeToString(.., NoTruncation)
// It never reads diagnostics; the resolved type text IS the computed result.
//
// Usage: node repro-api.mjs <path-to-checker-binary>
//        node repro-api.mjs            # uses tsgo from node_modules (control)
import { API, NodeBuilderFlags } from "typescript/sync";
import { isTypeAliasDeclaration } from "typescript/ast/is";
import { serverFS } from "typescript/fs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), "repro-api-"));
const tsconfig = join(dir, "tsconfig.json");
const file = join(dir, "index.ts");
writeFileSync(file, `type Count<F extends string, A extends unknown[]> =
  F extends \`1\${infer R}\` ? Count<R, [...A, 1]> : A['length'];
export type Answer = Count<'11111', []>;
`);
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: { noEmit: true, strict: false, types: [] }, files: ["index.ts"],
}));

// Callbacks registered, each deferring to the checker's own disk access. This
// is the shape the driver uses (its virtual files answer, the rest defer).
const fs = {
  readFile: () => serverFS.useOS, fileExists: () => serverFS.useOS,
  directoryExists: serverFS.useOS, getAccessibleEntries: serverFS.useOS,
  realpath: serverFS.useOS, stat: serverFS.useOS,
  writeFile: serverFS.noop, removeFile: serverFS.noop,
};
const api = new API({ cwd: dir, ...(bin ? { tsserverPath: bin } : {}), fs });

console.log(`checker: ${bin ?? "(bundled tsgo)"}`);
try {
  const snapshot = api.createSnapshot({ openProjects: [tsconfig], openFiles: [file] });
  console.log("createSnapshot: ok");
  const project = snapshot.getConfiguredProject(tsconfig) ?? snapshot.getDefaultProjectForFile(file) ?? snapshot.getProjects()[0];
  console.log("getProject:", project ? "ok" : "MISSING");
  const sf = project.program.getSourceFile(file);
  console.log("getSourceFile:", sf ? "ok" : "MISSING");
  const alias = sf.statements.find((s) => isTypeAliasDeclaration(s) && s.name.text === "Answer");
  const type = project.checker.getTypeFromTypeNode(alias.type);
  console.log("getTypeFromTypeNode: ok");
  const text = project.checker.typeToString(type, undefined, NodeBuilderFlags.NoTruncation);
  console.log(`typeToString: ${text}   <- must be 5`);
  console.log(text === "5" ? "RESULT: PASS (can drive the game)" : `RESULT: WRONG ANSWER (${text})`);
} catch (e) {
  console.log(`RESULT: FAIL -> ${e.message}`);
  process.exitCode = 1;
}
