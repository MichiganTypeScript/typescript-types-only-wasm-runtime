
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type * as SyncAPI from "typescript/sync";
import type { Program, Project, Snapshot } from "typescript/sync";
import type * as FsAPI from "typescript/fs";
import type * as IsAPI from "typescript/ast/is";
import type { TypeAliasDeclaration } from "typescript/ast";
import {
  createResultFilePath,
  globalDefinitions,
  projectRoot,
  tsconfigFilePath,
  nextResultTypeName,
  resultTypeName,
  config,
  errorFilePath,
  finalResultPath,
  stringResultTypeName,
} from "./config";
import { Meter } from "./metering";
import { createEnv6 } from "./ts6";
import { consoleLog, finalizeProgram, fsWorker, gaspForBreath, getCurrent, preBreakFile, printType } from './utils';

// TS_CHECKER picks the native checker. Each speaks its own revision of tsgo's
// --api protocol and its AST encoding, so each comes with the client built for
// it: tsrs and tsc-rs ship a fork of `typescript/sync` under `unstable/`, which
// spawns the binary it was published with. tsrs behind TS7's client finds the
// source file but decodes it with no `statements`.
const clients: Record<string, { sdk: string }> = {
  "ts7": { sdk: "typescript" },
  "tsc-rs": { sdk: "tsc-rs/unstable" },
  "tsrs": { sdk: "tsrs/unstable" },
};
const client = clients[process.env.TS_CHECKER ?? "ts7"] ?? clients.ts7;
const { API, NodeBuilderFlags }: typeof SyncAPI = await import(`${client.sdk}/sync`);
const { serverFS }: typeof FsAPI = await import(`${client.sdk}/fs`);
const { isTypeAliasDeclaration }: typeof IsAPI = await import(`${client.sdk}/ast/is`);

export interface EvaluationProgram {
  readonly native: Program;
  getSourceFile: Program["getSourceFile"];
  getSourceFileNames: Program["getSourceFileNames"];
  getTypeChecker: () => Project["checker"];
  // SyntaxKind numbers differ between TS6 and TS7, so each backend brings its own.
  isTypeAliasDeclaration: (node: unknown) => node is TypeAliasDeclaration;
}

export interface EvaluationEnvironment {
  sys: { fileExists: (filePath: string) => boolean };
  languageService: { getProgram: () => EvaluationProgram | undefined };
  createFile: (filePath: string, contents: string) => void;
  deleteFile: (filePath: string) => void;
  close: () => void;
}

// TS_CHECKER=ts6 swaps in the in-process TS6 compiler, =bun runs `bun check`;
// the rest are native checkers behind tsgo's API (see `clients`).
export const createEnv = (startFilePath: string): EvaluationEnvironment =>
  process.env.TS_CHECKER === "ts6" ? createEnv6(startFilePath) : createEnv7(startFilePath);

const createEnv7 = (startFilePath: string): EvaluationEnvironment => {
  const evaluatorConfigPath = resolve(projectRoot, "tsconfig.evaluator.json");
  const rootFiles = new Set([globalDefinitions, startFilePath]);
  const getEvaluatorConfig = () => JSON.stringify({
    extends: "./tsconfig.json",
    files: [...rootFiles].map(filePath => relative(projectRoot, filePath)),
  });
  // Virtual files layered over the host fs. Callbacks answer only for these
  // paths and hand everything else back to tsgo's own OS filesystem.
  // The start file is seeded empty: tsgo refuses to open a file no project
  // can load, and a root that was missing at load time never comes back on a
  // `created` notification. The driver overwrites it before the first check.
  const files = new Map<string, string>([
    [evaluatorConfigPath, getEvaluatorConfig()],
    [startFilePath, ""],
  ]);
  const deletedFiles = new Set<string>();
  const api = new API({
    cwd: projectRoot,
    // TSGO_BIN points the sync API at a custom-built tsgo (e.g. one with the
    // conditional-flow-type memoization) instead of the installed binary.
    ...(process.env.TSGO_BIN ? { tsserverPath: process.env.TSGO_BIN } : {}),
    fs: {
      readFile: (filePath) => deletedFiles.has(filePath) ? undefined : files.get(filePath) ?? serverFS.useOS,
      fileExists: (filePath) => deletedFiles.has(filePath) ? false : files.has(filePath) || serverFS.useOS,
      directoryExists: serverFS.useOS,
      getAccessibleEntries: serverFS.useOS,
      realpath: serverFS.useOS,
      stat: serverFS.useOS,
      writeFile: serverFS.noop,
      removeFile: serverFS.noop,
    },
  });
  let snapshot: Snapshot = api.createSnapshot({
    openProjects: [evaluatorConfigPath],
    // globalDefinitions is a root via `files:`; opening it would make tsgo
    // also load the repo-root project (877 files) for it.
    openFiles: [startFilePath],
  });
  let project: Project | undefined;

  const updateProject = () => {
    project = snapshot.getConfiguredProject(evaluatorConfigPath)
      ?? snapshot.getDefaultProjectForFile(startFilePath)
      ?? snapshot.getProjects()[0];
  };
  const updateSnapshot = (params: Parameters<Snapshot["update"]>[0]) => {
    const previous = snapshot;
    // Programs are rebuilt lazily; without this the project keeps the
    // program from before the change.
    snapshot = previous.update({ ...params, ensurePrograms: true });
    previous.dispose();
    updateProject();
  };
  const getProgram = (): EvaluationProgram | undefined => project && ({
    native: project.program,
    getSourceFile: project.program.getSourceFile.bind(project.program),
    getSourceFileNames: project.program.getSourceFileNames.bind(project.program),
    getTypeChecker: () => project!.checker,
    isTypeAliasDeclaration: isTypeAliasDeclaration as EvaluationProgram["isTypeAliasDeclaration"],
  });
  updateProject();

  return {
    sys: {
      fileExists: (filePath) => !deletedFiles.has(filePath)
        && (files.has(filePath) || existsSync(filePath)),
    },
    languageService: { getProgram },
    createFile(filePath, contents) {
      const exists = files.has(filePath);
      files.set(filePath, contents);
      deletedFiles.delete(filePath);
      // Touching the config invalidates the whole program, and the program
      // holds doom's 107MB module: re-parsing it costs more than the chunk that
      // triggered it. The driver overwrites the same three paths every chunk,
      // so after the first one the root list never actually changes - only say
      // it did when it did. Measured per chunk on doom: parse 0.83s -> 0.00s.
      const isNewRoot = !rootFiles.has(filePath);
      if (isNewRoot) {
        rootFiles.add(filePath);
        files.set(evaluatorConfigPath, getEvaluatorConfig());
      }
      updateSnapshot({
        fileNotifications: exists
          ? { changed: isNewRoot ? [filePath, evaluatorConfigPath] : [filePath] }
          : { created: [filePath], ...(isNewRoot ? { changed: [evaluatorConfigPath] } : {}) },
        ...(exists ? {} : { openFiles: [filePath] }),
      });
    },
    deleteFile(filePath) {
      files.delete(filePath);
      deletedFiles.add(filePath);
      rootFiles.delete(filePath);
      files.set(evaluatorConfigPath, getEvaluatorConfig());
      updateSnapshot({
        fileNotifications: { deleted: [filePath], changed: [evaluatorConfigPath] },
        closeFiles: [filePath],
      });
    },
    close() {
      snapshot.dispose();
      api.close();
    },
  };
};

export const reportErrors = (program: EvaluationProgram) => {
  const diagnostics = [
    ...program.native.getConfigFileParsingDiagnostics(),
    ...program.native.getProgramDiagnostics(),
    ...program.native.getSyntacticDiagnostics(),
    ...program.native.getBindDiagnostics(),
    ...program.native.getSemanticDiagnostics(),
  ];
  const diagnostic = diagnostics[0];
  if (diagnostic) {
    throw new Error(`${diagnostic.fileName ?? "TypeScript"}:${diagnostic.pos}: ${diagnostic.text}`);
  }
};

export const evaluateType = async (
  env: EvaluationEnvironment,
  filePath: string,
  program: EvaluationProgram,
  meter: Meter = new Meter(),
  searchFor = nextResultTypeName,
  force = false,
) => {
  meter.start("getSourceFile");
  const inputSourceFile = program.getSourceFile(filePath);
  if (!inputSourceFile) {
    consoleLog(program.getSourceFileNames().filter(fileName => fileName.includes("packages")));
    console.error(`file exists in virtual env?: ${env.sys.fileExists(filePath)}`);
    throw new Error(`the program could not find source file ${filePath}`);
  }
  meter.stop("getSourceFile");

  meter.start("getTypeAlias");
  const typeAlias = inputSourceFile.statements.find((node): node is TypeAliasDeclaration =>
    program.isTypeAliasDeclaration(node) && node.name.text === searchFor
  );
  if (!typeAlias) {
    fsWorker.writeFile(errorFilePath, inputSourceFile.text, 'ts');
    throw new Error(`could not find type alias ${searchFor} in ${filePath}`);
  }
  meter.stop("getTypeAlias");

  meter.start("checker");
  const checker = program.getTypeChecker();
  meter.stop("checker");

  meter.start("getTypeAtLocation");
  const type = checker.getTypeFromTypeNode(typeAlias.type);
  if (!type) throw new Error(`could not resolve type alias ${searchFor}`);
  meter.stop("getTypeAtLocation");

  meter.start("typeToString");
  const typeString = checker.typeToString(
    type,
    undefined,
    NodeBuilderFlags.NoTruncation | NodeBuilderFlags.UseStructuralFallback,
  );
  if (typeString === "" || typeString === "any") {
    fsWorker.writeFile(errorFilePath, typeString, 'ts');
    reportErrors(program);
    throw new Error(
      `typeString is empty for ${filePath}. was searching for ${searchFor}`,
    );
  }
  if (/instructions: \[\s*{\s*kind: "Halt";/.test(typeString)) {
    // the top instruction is a halt
    fsWorker.writeFile(errorFilePath, typeString, 'ts');
    throw new Error(`sorry, Charlie.  you gotta debug this now.`);
  }
  meter.stop("typeToString");

  if (force) {
    return {
      typeString,
      current: 0,
      cleanup: () => {},
    };
  }

  const current = await getCurrent(typeString);

  const foundNever = typeString.includes("never");
  const foundAnyArray = typeString.includes("any[]");
  const foundErrors = foundNever || foundAnyArray;
  if (foundErrors) {
    fsWorker.writeFile(errorFilePath, typeString, 'ts');
    throw new Error(
      `stopped because errors found in the file (search count ${current} for "${
        foundNever ? "never" : "any[]"
      }")`,
    );
  }

  return {
    typeString,
    current,
    cleanup: () => {
      // a word to the wise (or, in my case, very unwise): if you don't clean up the files, you'll effectively grow memory forever.
      // that, in itself, isn't so bad, but what _also_ happens is that the program slows down to a crawl.
      // calls to `.getProgram` go from taking 20ms to taking 10 seconds, perhaps understandably because the program gets so damn big.
      env.deleteFile(filePath);
    },
  }
}

export const createNewFile = async ({
  env,
  meter,
  typeString,
  funcImportLine,
  current,
  timeSpentUnderwater,
  program,
  startProgramTime,
}: {
  env: EvaluationEnvironment,
  meter: Meter,
  funcImportLine: string,
  typeString: string,
  current: number,
  timeSpentUnderwater: number,
  program: EvaluationProgram,
  startProgramTime: number,
}) => {
  meter.start("newFilePrep");
  const noMoreInstructions = typeString.includes("instructions: [];");
  const programImport = `import { executeInstruction } from '../../../wasm-to-typescript-types/program'`;
  let result = preBreakFile(`export type ${resultTypeName} = ${typeString}`);
  const nextStopAt = current + (noMoreInstructions ? 0 : config.incrementBy);
  const evaluate = `export type ${nextResultTypeName} = executeInstruction<${resultTypeName}, true, ${nextStopAt}>`;

  let fileContents = [
    funcImportLine,
    programImport,
    evaluate,
    result,
  ].join("\n\n");
  meter.stop("newFilePrep");

  // now that we have the typeString for the next file, let's create it
  meter.start("createVirtualFile");
  const filePath = createResultFilePath(current);
  env.createFile(filePath, fileContents);

  program

  meter.stop("createVirtualFile");

  meter.start("writeResults");

  const nextTimeSpentUnderwater = await gaspForBreath(
    timeSpentUnderwater,
    filePath,
    fileContents,
  );

  meter.stop("writeResults");

  if (noMoreInstructions) {
    // wrap up the very final Result/NextResult file
    fsWorker.writeFile(filePath, fileContents, 'ts');
    env.createFile(filePath, fileContents);

    // write the final results
    await finalizeProgram({
      lastInstructionCount: current,
      nextResultTypeName,
      resultTypeName,
      env,
    });

    console.log();
    console.log("total instructions", current);
    const totalTime = (performance.now() - startProgramTime) / 1000;
    console.log("total time", +(totalTime).toFixed(2));
    console.log("total ips", +(current / totalTime).toFixed(2));

    const {
      typeString: resultTypeString,
    } = await evaluateType(
      env,
      finalResultPath,
      env.languageService.getProgram()!,
      new Meter(),
      config.readStringFromMemory ? stringResultTypeName : resultTypeName,
      true,
    );

    console.log()
    console.log(printType(resultTypeString));

    process.exit(0);
  }

  return {
    filePath,
    nextTimeSpentUnderwater,
  };
}
