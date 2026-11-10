// TS6 backend: the JavaScript compiler, in process. TS6 has no sync API, so
// this drives the classic one (createProgram -> getTypeChecker ->
// getTypeFromTypeNode -> typeToString) and presents it through the same
// EvaluationEnvironment the TS7 backend does. Selected by TS_CHECKER=ts6.
import ts from "typescript-6";
import { dirname, resolve } from "node:path";
import { globalDefinitions, projectRoot } from "./config";
import type { EvaluationEnvironment, EvaluationProgram } from "./ts";

export const createEnv6 = (startFilePath: string): EvaluationEnvironment => {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    resolve(projectRoot, "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } },
  );
  if (!parsed) throw new Error("could not parse tsconfig.json");
  const options = parsed.options;
  const rootFiles = new Set([globalDefinitions, startFilePath]);
  const files = new Map<string, string>([[startFilePath, ""]]);
  // Parsed SourceFiles survive across programs as long as their text does.
  // Without this every chunk re-parses doom's 107MB module declaration.
  const parsedFiles = new Map<string, { text: string; sourceFile: ts.SourceFile }>();

  const readFile = (fileName: string) => files.get(fileName) ?? ts.sys.readFile(fileName);
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(options, true),
    fileExists: (fileName) => files.has(fileName) || ts.sys.fileExists(fileName),
    readFile,
    getSourceFile(fileName, languageVersion) {
      const text = readFile(fileName);
      if (text === undefined) return undefined;
      const cached = parsedFiles.get(fileName);
      if (cached && cached.text === text) return cached.sourceFile;
      const sourceFile = ts.createSourceFile(fileName, text, languageVersion, false);
      parsedFiles.set(fileName, { text, sourceFile });
      return sourceFile;
    },
    getDefaultLibLocation: () => dirname(ts.getDefaultLibFilePath(options)),
  };

  let program: ts.Program | undefined;
  let dirty = true;

  const toDiagnostics = (diagnostics: readonly ts.Diagnostic[]) => diagnostics.map((d) => ({
    fileName: d.file?.fileName,
    pos: d.start ?? 0,
    text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  }));

  const getProgram = (): EvaluationProgram => {
    if (dirty || !program) {
      program = ts.createProgram({ rootNames: [...rootFiles], options, host, oldProgram: program });
      dirty = false;
    }
    const native = program;
    return {
      native: {
        getConfigFileParsingDiagnostics: () => toDiagnostics(native.getConfigFileParsingDiagnostics()),
        getProgramDiagnostics: () => toDiagnostics(native.getOptionsDiagnostics()),
        getSyntacticDiagnostics: () => toDiagnostics(native.getSyntacticDiagnostics()),
        getBindDiagnostics: () => [],
        getSemanticDiagnostics: () => toDiagnostics(native.getSemanticDiagnostics()),
      },
      getSourceFile: (fileName: string) => native.getSourceFile(fileName),
      getSourceFileNames: () => native.getSourceFiles().map((f) => f.fileName),
      getTypeChecker: () => native.getTypeChecker(),
      isTypeAliasDeclaration: ts.isTypeAliasDeclaration,
    } as unknown as EvaluationProgram;
  };

  return {
    sys: { fileExists: (filePath) => files.has(filePath) || ts.sys.fileExists(filePath) },
    languageService: { getProgram },
    createFile(filePath, contents) {
      files.set(filePath, contents);
      rootFiles.add(filePath);
      dirty = true;
    },
    deleteFile(filePath) {
      files.delete(filePath);
      parsedFiles.delete(filePath);
      rootFiles.delete(filePath);
      dirty = true;
    },
    close() {
      program = undefined;
      parsedFiles.clear();
    },
  };
};
