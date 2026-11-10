import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { EvaluationProgram } from "./ts";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import {
  STATS_PREFIX,
  csvPath,
  config,
  statsDirectory,
  statsJsonPath,
  statsPath,
} from "./config";
import { Meter, MeteringDefinite } from "./metering";
import { fsWorker, getActiveInstruction } from "./utils";

const stackSize = (depth = 1): number => {
  try {
    return stackSize(depth + 1);
  } catch (e) {
    return depth;
  }
};

/**
 * There is a mode of operation where the program will run one instruction at a time, so we can benchmark individual instructions.
 */
export const isBenchmarkingIndividualInstructions =
  (config.incrementBy as number) === 1;

export const clearStats = () => {
  try {
    statSync(statsDirectory);
    const files = readdirSync(statsDirectory);
    for (const file of files) {
      unlinkSync(join(statsDirectory, file));
    }
  } catch (e) {
    if ((e as unknown as any).code === "ENOENT") {
      if (config.shouldComputeFullStats) {
        // if the directory doesn't exist, create it
        mkdirSync(statsDirectory);
      }
    }
  }
};

const getStdev = (array: number[]) => {
  const n = array.length;
  const mean = array.reduce((a, b) => a + b) / n;
  return Math.sqrt(
    array.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n,
  );
};

type SimpleTotals = {
  sum: number;
  min: number;
  max: number;
  avg: number;
  stdev: number;
  median: number;
};

interface Totals extends SimpleTotals {
  sumPerInstruction: number;
  minPerInstruction: number;
  maxPerInstruction: number;
  avgPerInstruction: number;
}

type ByInstructionStats = {
  instantiations: SimpleTotals;
  time: SimpleTotals;
  instantiationsPerMs: number;
};

type InstructionName = string;

type Reduction = {
  stats: ByInstructionStats;
  values: {
    instantiations: number[];
    time: number[];
  };
};

type ReductionByInstruction = Record<InstructionName, Reduction>;

type ProgramTotals = Record<keyof RunInfo, Record<string, Totals>>;

interface ProgramStats {
  programTime: number;
  stackSize: number;
  totals: ProgramTotals;
  byInstruction?: ReductionByInstruction;
  summary?: Record<string, number>;
}

type Runs = Record<string, RunInfo>;

interface RunInfo {
  stats: TSProgramStats;
  metering: MeteringDefinite;
  metadata: RunMetadata;
}

interface TSProgramStats {
  instantiations: number;
  types: number;
  symbols: number;
  identifiers: number;
  cache: Record<string, number>;
  files: number;
}

export const getProgramStats = (program: EvaluationProgram): TSProgramStats => ({
  instantiations: 0,
  types: 0,
  symbols: 0,
  identifiers: 0,
  files: program.getSourceFileNames().length,
  cache: {},
});

type RunMetadata = {
  typeStringLength: number;
  activeInstruction: string | null;
  instructions: number;
  current: number;
};

export const generateFullStats = async ({
  program,
  metadata,
  metering,
}: {
  program: EvaluationProgram;
  metadata: RunMetadata;
  metering: MeteringDefinite;
}) => {
  const stats = getProgramStats(program); // Note: this is the reason we can't move stats generation to a worker thread - we'd have to serialize the program object
  shortStats({
    stats,
    metadata,
    metering,
  });

  fsWorker.writeFile(
    statsJsonPath(metadata.current),
    JSON.stringify({ metering, stats, metadata }),
    'json'
  );
};

const round = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const getTotals = (runs: Runs) => {
  const totals = {} as ProgramTotals;
  const csv = {} as CSV;

  const [runId, runInfo] = Object.entries(runs)[0] as unknown as [
    keyof Runs,
    RunInfo,
  ];
  Object.entries(runInfo).forEach((entry) => {
    const [groupId, group] = entry as [keyof RunInfo, RunInfo[keyof RunInfo]];

    totals[groupId as keyof RunInfo] = {} as ProgramTotals[keyof RunInfo];

    Object.entries(group).forEach((stat) => {
      const [statId, statValue] = stat as [
        keyof RunInfo[keyof RunInfo],
        RunInfo[keyof RunInfo][keyof RunInfo[keyof RunInfo]],
      ];
      if (typeof statValue !== "number") {
        return;
      }

      /*
        Up to this point, we've essentially just been getting a path to all available statistics in such a way that doesn't require us to remember to add those statistics to this list in the future if more are ever added or removed
      */

      const values = Object.values(runs).map(
        (run) => run[groupId][statId],
      ) as number[];
      csv[`${groupId}.${statId}`] = values;

      const sum = values.reduce((acc, b) => acc + b, 0);
      const min = values.reduce((acc, b) => Math.min(acc, b), Infinity);
      const max = values.reduce((acc, b) => Math.max(acc, b), -Infinity);
      const median = [...values].sort((a, b) => a - b)[
        Math.floor(values.length / 2)
      ];
      const avg = sum / values.length;
      const stdev = getStdev(values);

      totals[groupId][statId] = {
        sum: round(sum),
        sumPerInstruction: round(sum / config.incrementBy),
        min: round(min),
        minPerInstruction: round(min / config.incrementBy),
        max: round(max),
        maxPerInstruction: round(max / config.incrementBy),
        avg: round(avg),
        avgPerInstruction: round(avg / config.incrementBy),
        median: round(median),
        stdev: round(stdev),
      };
    });
  });

  return { totals, csv };
};

const byInstruction = (
  runs: Runs,
): Pick<ProgramStats, "byInstruction" | "summary"> => {
  if (!isBenchmarkingIndividualInstructions) {
    return {};
  }

  const byInstruction = Object.values(runs).reduce((acc, run) => {
    const { activeInstruction } = run.metadata;
    if (typeof activeInstruction !== "string") {
      throw new Error(
        "activeInstruction must be a string by this point in the program because isPerfBenchmarking is true",
      );
    }

    const { instantiations } = run.stats;
    const { getTypeAtLocation } = run.metering;
    let current = acc[activeInstruction];
    if (!Object.hasOwn(acc, activeInstruction)) {
      current = {
        stats: {
          instantiations: {
            sum: 0,
            min: Infinity,
            max: -Infinity,
            avg: 0,
            stdev: 0,
            median: 0,
          },
          time: {
            sum: 0,
            min: Infinity,
            max: -Infinity,
            avg: 0,
            stdev: 0,
            median: 0,
          },
          instantiationsPerMs: 0,
        },
        values: {
          instantiations: [],
          time: [],
        },
      };
    }

    const values: Reduction["values"] = {
      instantiations: [...current.values.instantiations, instantiations],
      time: [...current.values.time, getTypeAtLocation],
    };

    const timeAvg =
      (current.stats.time.sum + getTypeAtLocation) / values.time.length;

    const result: ReductionByInstruction = {
      ...acc,
      [activeInstruction]: {
        stats: {
          instantiations: {
            sum: current.stats.instantiations.sum + instantiations,
            min: Math.min(current.stats.instantiations.min, instantiations),
            max: Math.max(current.stats.instantiations.max, instantiations),
            avg:
              (current.stats.instantiations.sum + instantiations) /
              [...values.instantiations, instantiations].length,
            stdev: getStdev([...values.instantiations, instantiations]),
            median: [...values.instantiations].sort((a, b) => a - b)[
              Math.floor(values.instantiations.length / 2)
            ],
          },
          time: {
            sum: current.stats.time.sum + getTypeAtLocation,
            min: Math.min(current.stats.time.min, getTypeAtLocation),
            max: Math.max(current.stats.time.max, getTypeAtLocation),
            avg: timeAvg,
            stdev: getStdev([...values.time, getTypeAtLocation]),
            median: [...values.time].sort((a, b) => a - b)[
              Math.floor(values.time.length / 2)
            ],
          },
          instantiationsPerMs: Math.round(
            values.instantiations.length / timeAvg,
          ),
        },
        values,
      },
    };

    return result;
  }, {} as ReductionByInstruction);

  const summary = Object.fromEntries(
    Object.entries(byInstruction)
      .map(([ins, v]) => [ins, v.stats.instantiationsPerMs] as const)
      .sort((a, b) => a[1] - b[1])
      .reverse(),
  );

  return {
    summary,
    byInstruction,
  };
};

type CSV = Record<string, number[]>;

const calculateTotals = async (
  programTime: ProgramStats["programTime"],
): Promise<{ programStats: ProgramStats; csv: CSV }> => {
  let runs: Runs = {};
  for (const file of await readdir(statsDirectory)) {
    if (!file.startsWith(STATS_PREFIX) || !file.endsWith(".json")) {
      // console.log('skipping', file)
      continue;
    }

    const contents = await readFile(join(statsDirectory, file), "utf-8");
    const parsed = JSON.parse(contents);
    const count = Number(file.match(/\d+/)?.[0]);
    runs[count] = parsed;
  }

  const { totals, csv } = getTotals(runs);

  return {
    programStats: {
      programTime,
      stackSize: stackSize(),
      totals,
      ...byInstruction(runs),
    },
    csv,
  };
};

export const serializeCSV = (csv: CSV) => {
  const header = Object.keys(csv).join("\t");
  const values = Object.values(csv);
  const body = values[0]
    .map((_, i) => values.map((row) => row[i]).join("\t"))
    .join("\n");
  return `${header}\n${body}`;
};

export const logFinalStats = async (startProgramTime: number) => {
  if (!config.shouldComputeFullStats) {
    return;
  }

  const totalTime = performance.now() - startProgramTime;
  console.log("total time (ms)", Math.round(totalTime));

  if (config.shouldComputeFullStats) {
    const { programStats, csv } = await calculateTotals(totalTime);
    console.log(
      "total instantiations ",
      programStats.totals.stats.instantiations.sum,
    );
    fsWorker.writeFile(statsPath, JSON.stringify(programStats), 'json');
    fsWorker.writeFile(csvPath, serializeCSV(csv), 'csv');
  }
};

export const printColumn = (
  name: string,
  columnWidth: number,
  value: number,
) => {
  const valueRounded = Math.round(value);
  const filler = " ".repeat(
    Math.max(0, columnWidth - valueRounded.toString().length),
  );

  return [
    `| ${name}${filler}`,
    valueRounded, // you see.. when you console.log a number it shows it in orange.  so we're going through some extra trouble to keep it that way
  ];
};

export const shortStats = ({
  stats: { instantiations },
  metadata: {
    typeStringLength,
    activeInstruction,
    current: count,
    instructions,
  },
  metering: { total: totalTime, getTypeAtLocation },
}: {
  stats: TSProgramStats;
  metadata: RunMetadata;
  metering: MeteringDefinite;
}) => {
  console.log(
    ...printColumn("count", config.digits, count),
    ...printColumn("time (ms)", 7, getTypeAtLocation),
    ...printColumn("wasm/sec", 5, instructions / (totalTime / 1000)),
    ...printColumn("instantiations", 10, instantiations),
    ...printColumn("instan/ms", 7, instantiations / getTypeAtLocation),
    ...printColumn("length", 10, typeStringLength),
    `|${activeInstruction ? ` ${activeInstruction} |` : ""}`,
  );
};

export const encourage = () => {
  const phrases = [
    "Expecto Patronum!",
    "Here's to escaping the Sarlacc pit.",
    "May your mana *cough cough* err. recursion limit.. never run out",
    "Achieve victory and return with honor",
    "You're probably going to need a bigger boat",
    "You're off to great places, today is your day!",
    "The truth is out there",
    "Are you tryna create a union that's too complex to represent.. again?",
    "I always trusted code more than people anyway.",
    "To excessive and possibly infinite depth and beyond!", // credit: DBlass
    '10 bucks says what comes next starts with "RangeError: Maximum call stack size exceeded at `instantiateTypes`"',
    "just another few months and this thing will finally work.. right?",
    "What if I told you everything you know about recursion is a lie?",
  ];

  console.log(phrases[Math.floor(Math.random() * phrases.length)]);
  console.log();
};

export const logStats = async ({
  typeString,
  current,
  program,
  meter,
  previousCount,
  startingCount,
  startProgramTime,
}: {
  typeString: string,
  current: number,
  program: EvaluationProgram,
  meter: Meter,
  previousCount: number,
  startingCount: number,
  startProgramTime: number,
}) => {
  if (config.shouldComputeFullStats) {
    const typeStringLength = typeString.length;
    const activeInstruction = isBenchmarkingIndividualInstructions
      ? getActiveInstruction(typeString, current)
      : null;
    await generateFullStats({
      program,
      metadata: {
        typeStringLength,
        activeInstruction,
        instructions: config.incrementBy,
        current,
      },
      metering: meter.finalize(),
    });
  } else {
    const runLifetime = meter.lifetime() / 1000;
    const actualCount = current - previousCount;
    const ips = Math.round(actualCount / runLifetime);

    const totalInstructions = current - startingCount;
    const totalTime = Math.round((performance.now() - startProgramTime) / 1000);
    const avg = Math.round(totalInstructions / totalTime);

    console.log(`current ${current} | ips ${ips} ${totalInstructions}/${totalTime}=${avg}`);
  }
}
