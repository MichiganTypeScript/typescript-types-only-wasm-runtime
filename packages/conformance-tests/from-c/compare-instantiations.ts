/**
 * Compare instantiation counts between AOT and Interpreter
 *
 * Run: npx tsx compare-instantiations.ts
 */
import * as ts from 'typescript-legacy';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function measureInstantiations(testCode: string, description: string): number {
  const configPath = path.resolve(__dirname, '../../../tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
  );

  // Create a virtual file with the test code
  const fileName = '/test.ts';
  const sourceFile = ts.createSourceFile(fileName, testCode, ts.ScriptTarget.Latest, true);

  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (name, ...args) => {
    if (name === fileName) return sourceFile;
    return originalGetSourceFile(name, ...args);
  };

  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();

  // Force evaluation by getting all types
  ts.forEachChild(sourceFile, node => {
    if (ts.isTypeAliasDeclaration(node)) {
      checker.getTypeAtLocation(node);
    }
  });

  const count = program.getInstantiationCount();
  console.log(`${description}: ${count.toLocaleString()} instantiations`);
  return count;
}

console.log('Measuring instantiation counts...\n');

// Test AOT version
const aotCode = `
import type { entry } from './packages/conformance-tests/from-c/c-add.aot';
type R1 = entry<[5, 3]>;
type R2 = entry<[100, 200]>;
type R3 = entry<[1000, 2000]>;
`;

// Test Interpreter version
const interpreterCode = `
import type { entry } from './packages/conformance-tests/from-c/c-add';
type R1 = entry<[5, 3]>;
type R2 = entry<[100, 200]>;
type R3 = entry<[1000, 2000]>;
`;

const aotCount = measureInstantiations(aotCode, 'AOT        ');
const interpreterCount = measureInstantiations(interpreterCode, 'Interpreter');

if (aotCount > 0) {
  console.log(`\nSpeedup: ${(interpreterCount / aotCount).toFixed(1)}x fewer instantiations with AOT`);
}
