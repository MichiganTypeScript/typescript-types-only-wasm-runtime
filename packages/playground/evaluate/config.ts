import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** if `Infinity`, the fun never stops.  otherwise it will forcibly halt at a the specified instructions count */
  stopAt: number;

  /** the number of digits in the filenames and types.  so a value of 4 will yield "0001", "0002", etc. */
  digits: number;

  /** turns off statistics collection and logging (it's expensive over long runs) */
  shouldComputeFullStats: boolean;

  /**
   * controls how often the program prints to file.
   * set to 0 for it to always print
   */
  comeUpForAirEvery: number;

  /** how many instructions to add per run */
  incrementBy: number;

  /** how often the process should shed this mortal coil */
  transcendTheAstralPlane: number;

  /** whether the finishing step should include ReadStringFromMemory` */
  readStringFromMemory: boolean;
}

export const config = {
  stopAt: Infinity,
  digits: 8,
  shouldComputeFullStats: false,
  incrementBy: 10,
  comeUpForAirEvery: 1_000,
  transcendTheAstralPlane: 10_000,
  readStringFromMemory: true,
} satisfies Config;

/** this is the magic type alias that the script is looking for in the evaluationFilePath */
export const resultTypeName = 'Result';
export const nextResultTypeName = `Next${resultTypeName}`;
export const stringResultTypeName = `String${resultTypeName}`;

export const simpleTypeMode = process.argv.includes('--simple');
export const statsOnlyMode = process.argv.includes("--stats-only");
export const reportDiagnosticsMode = process.argv.includes("--report-ts-diagnostics");
export const resumeMode = process.argv.includes("--resume");
export const spawnMode = process.argv.includes("--spawn");
export const RESUME_CODE = 3;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const projectRoot = join(__dirname, '../../../');
export const globalDefinitions = join(__dirname, '../../../global.d.ts');
export const tsconfigFilePath = join(projectRoot, './tsconfig.json');
export const resultsDirectory = join(__dirname, 'results');
export const startFilePath = join(__dirname, 'start.ts');
export const finalResultPath = join(resultsDirectory, 'result.ts');
export const errorFilePath = join(resultsDirectory, 'error.ts');
export const formatterErrorFilePath = join(resultsDirectory, 'formatter-error.html');
export const bootstrapFilePath = join(resultsDirectory, 'bootstrap.ts');
export const statsDirectory = join(__dirname, 'stats');
export const statsPath = join(statsDirectory, 'program-stats.json');
export const csvPath = join(statsDirectory, 'program-stats.csv');

export const formatCurrent = (current: number) => String(current).padStart(config.digits, '0');
export const RESULT_PREFIX = 'result-';
export const createResultFilePath = (current: number) => join(resultsDirectory, `${RESULT_PREFIX}${formatCurrent(current)}.ts`)
export const STATS_PREFIX = 'stats-';
export const statsJsonPath = (current: number) => join(statsDirectory, `${STATS_PREFIX}${formatCurrent(current)}.json`);
export const shouldTakeABreath = (timeSpentUnderwater: number) => timeSpentUnderwater >= config.comeUpForAirEvery;
export const shouldSlingArrowsOfOutrageousFortune = (timeSpentExploringTheAbyss: number) => spawnMode && (timeSpentExploringTheAbyss >= config.transcendTheAstralPlane)
