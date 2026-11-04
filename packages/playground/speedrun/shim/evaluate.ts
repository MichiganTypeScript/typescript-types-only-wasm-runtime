// Stands in for ../evaluate/ts when drive.ts runs on tsrs.wasm, the TypeScript
// checker compiled to WebAssembly. That build has no language-service API, only
// `tsc`, so a type is read the way a person reads one off the command line:
// assign a number to it and take the type back out of the error.
//
//   export type $Out_Tag = $Tag<$Result>
//   export const __p0: $Out_Tag = 12345;
//   -> Type '12345' is not assignable to type '"s"'.
//
// One `tsc` run per chunk probes every `$Out_*` alias at once: the chunk's cost
// is evaluating `$Result`, which every reader shares, so reading 4100 names
// costs what reading one does (measured on doom chunk 1: 7.9s check either way).

export type Tsc = (
  args: string[],
  options: { cwd: string; files: Record<string, string>; diagnostics: "json" },
) => Promise<{ exitCode: number; memoryBytes?: number; diagnostics?: { fileName: string; startPosition: { line: number }; code: number; text: string }[] }>;

/// Set by the host before `run`: node.js's `tsc` in Node, browser.js's in a worker.
export const host: { tsc?: Tsc; root: string; files: Record<string, string>; config: object; onRun?: (ms: number, names: number, memoryBytes?: number) => void } = {
  root: "/p",
  files: {},
  config: {},
};

// A literal target keeps the literal ('12345'); any other target widens it ('number').
const PROBE = /^Type '(?:12345|number)' is not assignable to type '(.*)'\.$/;

export interface EvaluationEnvironment {
  files: Map<string, string>;
  sys: { fileExists: (p: string) => boolean };
  createFile: (p: string, text: string) => void;
  deleteFile: (p: string) => void;
  close: () => void;
  languageService: { getProgram: () => ProbeProgram };
}

export const createEnv = (startFilePath: string): EvaluationEnvironment => {
  const files = new Map<string, string>([[startFilePath, ""]]);
  let generation = 0;
  return {
    files,
    sys: { fileExists: (p: string) => files.has(p) },
    createFile: (p: string, text: string) => {
      files.set(p, text);
      generation++;
    },
    deleteFile: (p: string) => {
      files.delete(p);
      generation++;
    },
    close: () => files.clear(),
    languageService: {
      getProgram: () => new ProbeProgram(files, generation),
    },
  };
};

class ProbeProgram {
  private results?: Promise<Map<string, string>>;
  constructor(private files: Map<string, string>, readonly generation: number) {}

  read(path: string, name: string): Promise<string> {
    this.results ??= this.check(path);
    return this.results.then(async (r) => {
      let text = r.get(name);
      if (text === undefined && name.startsWith("$Out_Mem_")) {
        await this.checkBranch(path, name, r);
        text = r.get(name);
      }
      if (text === undefined) throw new Error(`typeString is empty for ${path}. Was searching for ${name}`);
      return text;
    });
  }

  private async checkBranch(path: string, name: string, out: Map<string, string>): Promise<void> {
    const parts = name.split("_");
    const parent = parts.length === 4 ? `$Out_Mem_${parts[2]}` : "$Out_Mem";
    const source = this.files.get(path) ?? "";
    const fanout = [...source.matchAll(/^(?:export )?type \$Out_Mem_\d+ =/gm)].length || 64;
    const names: string[] = [];
    const extraTypes: string[] = [];
    for (let j = 0; j < fanout; j++) {
      const child = `${parent}_${j}`;
      names.push(child);
      if (parts.length === 4 && !source.includes(`type ${child} =`)) {
        extraTypes.push(`export type ${child} = $Kid${j}<${parent}>;`);
      }
    }
    const prefix = extraTypes.length ? `${source}\n${extraTypes.join("\n")}` : source;
    const branchMap = await this.runProbes(path, prefix, names);
    for (const [k, v] of branchMap) out.set(k, v);
  }

  private async check(path: string): Promise<Map<string, string>> {
    const source = this.files.get(path) ?? "";
    const names = [...source.matchAll(/^export type (\$Out_\w+)/gm)].map((m) => m[1]!);
    return this.runProbes(path, source, names);
  }

  private async runProbes(path: string, source: string, names: string[]): Promise<Map<string, string>> {
    if (!host.tsc) throw new Error("shim/evaluate: host.tsc is not set");
    const lines = source.split("\n").length;
    const probed = `${source}\n${names.map((n, k) => `export const __p${k}: ${n} = 12345;`).join("\n")}\n`;
    const rel = (p: string) => (p.startsWith(host.root + "/") ? p.slice(host.root.length + 1) : p);
    const files: Record<string, string> = { ...host.files };
    for (const [p, text] of this.files) files[p] = p === path ? probed : text;
    files[`${host.root}/tsconfig.json`] = JSON.stringify({
      ...host.config,
      files: [...Object.keys(host.files).filter((p) => p.endsWith("global.d.ts")), ...this.files.keys()].map(rel),
    });
    const t = performance.now();
    const result = await host.tsc(["-p", "."], { cwd: host.root, files, diagnostics: "json" });
    host.onRun?.(performance.now() - t, names.length, result.memoryBytes);
    const out = new Map<string, string>();
    const errors: string[] = [];
    for (const d of result.diagnostics ?? []) {
      const k = d.fileName === path ? d.startPosition.line - lines : -1;
      const first = d.text.split("\n")[0]!;
      const m = k >= 0 && k < names.length ? PROBE.exec(first) : null;
      if (m) out.set(names[k]!, m[1]!);
      else if (d.fileName === path) errors.push(first);
    }
    // TS2589 and friends: drive.ts backs off on "excessively deep" in the message.
    if (errors.length && out.size === 0) throw new Error(errors.join("\n"));
    if (result.exitCode > 2) throw new Error(`tsrs.wasm exited ${result.exitCode}`);
    return out;
  }
}

export const evaluateType = async (
  _env: EvaluationEnvironment,
  filePath: string,
  program: ProbeProgram,
  _meter: unknown,
  searchFor: string,
) => {
  const typeString = await program.read(filePath, searchFor);
  if (typeString === "" || typeString === "any") throw new Error(`typeString is empty for ${filePath}. was searching for ${searchFor}`);
  return { typeString, current: 0, cleanup: () => {} };
};
