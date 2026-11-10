
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Biome, Distribution } from "@biomejs/js-api";
import { config, createResultFilePath, errorFilePath, finalResultPath, formatterErrorFilePath, resultsDirectory, resumeMode, shouldTakeABreath, startFilePath } from "./config";
import type { EvaluationEnvironment } from "./ts";
import { inspect } from "node:util";
import { join } from "node:path";

export interface ProgramRun {
  env: EvaluationEnvironment;
  
  stopAt: number;

  filePath: string;

  justPrint?: boolean;

  /** the program can "take a breath" (meaning, dump everything to disk and start a new env) in order to avoid out-of-memory and call-stack-exceeded errors */
  timeSpentUnderwater: number;

  cleanup: () => void;

  /** the line to import ProgramState['funcs'] */
  funcImportLine: string;

  /** time since the very bigging of this run */
  startProgramTime: number;

  /** the instruction count of the previous run, used for IPS calculation */
  previousCount: number;

  /** the very first instruction of this entire run */
  startingCount: number;

  /** how long to spend exploring the abyss */
  timeSpentExploringTheAbyss: number;
}

export const consoleLog = (args: any) => {
  console.log(
    inspect(args, { maxArrayLength: null, maxStringLength: null, depth: null, colors: true})
  );
}

export const programIsComplete = (
  stopAt: number,
  current: number
) => {
  // stop because we've reached the specified instruction count maximum
  if (current >= stopAt) {
    return true;
  }
  // keep goin' lil' buddy
  return false;
};

const biome = await Biome.create({
  distribution: Distribution.NODE,
});
biome.applyConfiguration({
  files: {
    maxSize: 1024 * 1024 * 1024,
  },
});

const extractAddress = (line: string) => {
  const cleaned = line.split(":")[0].replaceAll("\"", "").trim();
  return Number.parseInt(cleaned, 2);
}

const sortMemoryLines = (memoryLines: string) => memoryLines.split('\n')
  .sort((a, b) => extractAddress(a) - extractAddress(b))
  .join('\n');

const sortSections = (data: string) => {
      // find the lines between `\tmemory: {` and `\t{`
      const memoryLines = data.match(/\tmemory: {\r?\n(.*?)\r?\n\t}/s);
      if (memoryLines) {
        const old = memoryLines[1];
        if (old.indexOf(`"111111111`) !== -1) {
          writeFileSync(errorFilePath, data, "utf-8");
          throw new Error(`found an invalid memory address!`);
        }
        const sorted = sortMemoryLines(old);
        data = data.replace(old, sorted)
      }

      const L1CacheLines = data.match(/\tL1Cache: {\r?\n(.*?)\r?\n\t}/s);
      if (L1CacheLines) {
        const old = L1CacheLines[1];
        const sorted = sortMemoryLines(old);
        data = data.replace(old, sorted)
      }

      const activeLocalsLines = data.match(/\tactiveLocals: {\r?\n(.*?)\r?\n\t}/s);
      if (activeLocalsLines) {
        const old = activeLocalsLines[1];
        const sorted = old.split('\n').sort().join('\n');
        data = data.replace(old, sorted)
      }

      return data;
}

export const fsWorker = {
  writeFile: (
    filePath: string,
    data: string,
    kind: 'ts' | 'json' | 'csv',
  ) => {
    if (kind === 'json' || kind === 'ts') {
      let { content, diagnostics } = biome.formatContent(data, {
        filePath,
      });
      if (diagnostics.length > 0) {
        writeFileSync(formatterErrorFilePath, biome.printDiagnostics(diagnostics, {
          filePath,
          verbose: true,
          fileSource: data,
        }));
        throw new Error(`diagnostics from formatter. see ${formatterErrorFilePath}`);
      }
      data = content;
    }

    if (kind === 'ts') {
      data = sortSections(data);
    }

    writeFileSync(filePath, data, "utf-8");
  },
};

export const getActiveInstruction = (
  file: string,
  current: number,
) => {
  const match = file.match(/kind: "([a-zA-Z0-9]*)"/m); // this assumes that ProgramState['instructions'] is (basically) first
  if (!match) {
    console.error("unable to find instruction", file, current);
    return "UnableToFindInstruction";
  }
  return match[1];
};

export const getCurrent = async (typeString: string) => {
  let current = Number(typeString.match(/count: (\d+);/)?.[1]);
  if (Number.isNaN(current)) {
    fsWorker.writeFile(errorFilePath, typeString, 'ts');
    throw new Error(`stopped because current is NaN:\n${typeString}`);
  }
  return current;
}

export const getFuncImportLine = () => {
  const startSource = readFileSync(startFilePath, "utf-8");

  const funcImportLine = startSource.split("\n")[0].replace(/from "/, 'from "../');

  if (funcImportLine === "" || !funcImportLine.includes("{ funcs }")) {
    throw new Error("didn't find a funcs import line in the playground file");
  }

  if (funcImportLine === null) {
    throw new Error(
      "so it's shitty, I'll give you that much, but there's an optimization in play whereby you need to make sure that the first line of the playground file matches the `funcs` import for the type you're asking for.  It gets transformed later into something fairly critical for performance (basically removing all static assets).",
    );
  }

  return funcImportLine;
};

/** may or may not write an artifact to disk */
export const gaspForBreath = async (
  timeSpentUnderwater: number,
  filePath: string,
  fileContents: string,
) => {
  if (shouldTakeABreath(timeSpentUnderwater)) {
    fsWorker.writeFile(filePath, fileContents, 'ts');
    return 0 + config.incrementBy; // reset the counter
  }
  return timeSpentUnderwater + config.incrementBy;
}

export const finalizeProgram = async ({
  lastInstructionCount,
  nextResultTypeName,
  resultTypeName,
  env,
}: {
  lastInstructionCount: number;
  nextResultTypeName: string;
  resultTypeName: string;
  env: EvaluationEnvironment;
}) => {
  const absoluteLastResult = createResultFilePath(lastInstructionCount)
  const relativeLastResult = absoluteLastResult.replace(resultsDirectory, ".");
  
  const readStringImportLine = config.readStringFromMemory
    ? [
        `import { ReadStringFromMemory } from '../../../ts-type-math';`,
        ``,
      ]
    : []

  const stringResultLine = config.readStringFromMemory
    ? [
        `type StringResult = ReadStringFromMemory<executeInstruction<${nextResultTypeName}, true>>`,
        `//   ^?`,
        ``,
      ]
    : []

  const fileContent = [
    `import { executeInstruction } from '../../../wasm-to-typescript-types/program';`,
    `import { ${nextResultTypeName} } from '${relativeLastResult}';`,
    ...readStringImportLine,
    ``,
    `type ${resultTypeName} = executeInstruction<${nextResultTypeName}, false>`,
    `//   ^?`,
    ``,
    ...stringResultLine,
    `//> `,
    `//> made by Dimitri Mitropoulos and Michigan TypeScript`,
    `//> `,
    `//> we owe a lot to the TypeScript team for making this possible and being such a great team.`,
    `//> `,
    ``,
  ].join('\n');

  fsWorker.writeFile(finalResultPath, fileContent, 'ts');
  env.createFile(finalResultPath, fileContent);
};

/**
 * this "file" is mostly on one line and it can get sorta long, so it's good to break it up in a few places
 * e.g. if the string ` instructions: [` is detected, replace it with `\ninstructions: [`
 */
export const preBreakFile = (text: string) =>
  [
    "stack",
    "activeLocals",
    "instructions",
    "activeBranches",
    "memory",
    "globals",
    "executionContexts",
  ].reduce((acc, value) => acc.replace(` ${value}: `, `\n${value}: `), text);


export const printType = (typeString: string) => {
  let output = typeString.replaceAll("\\n", "\n");

  // if the first two characters are `{ "` we presume it's an object and format it as such

  // object detection
  if (output.startsWith('{ "')) {
    const lines = output
      .replace(/{ "/g, '{\n  "')
      .replace(/"; "/g, '";\n  "')
      .replace(/"; }$/g, '";\n}\n')
      .split("\n");
    const sortedLines = lines.slice(1, lines.length - 1).sort();
    output = [lines[0], ...sortedLines, lines[lines.length - 1]].join("\n");
  }

  // string detection
  if (output.startsWith(`"`) && output.endsWith(`"`)) {
    output = output.slice(1, output.length - 1);

    if (output === "") {
      return "<empty string>";
    }
  }

  return output;
};

export const getStartFilePath = () => {
  if (!resumeMode) {
    return startFilePath;
  }

  const files = readdirSync(resultsDirectory);

  const resumeIndex = process.argv.indexOf("--resume");
  const nextArg = process.argv[resumeIndex + 1];

  
  if (nextArg) {
    const hitAnotherFlag = nextArg.startsWith("--");
    if (!hitAnotherFlag) {
      if (!files.includes(nextArg)) {
        throw new Error(`specified resume file '${nextArg}' not found in ${resultsDirectory}`);
      }
      return join(resultsDirectory, nextArg);
    }
  }

  const filenames = files.filter(file => {
    return file.startsWith("result-") && file.endsWith(".ts");
  }).sort();

  return join(resultsDirectory, filenames[filenames.length - 1]);
}
