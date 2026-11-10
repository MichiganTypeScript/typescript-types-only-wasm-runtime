// Measure TypeScript instantiations for AOT vs Interpreter
import ts from 'typescript-legacy';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function measureInstantiations(filePath: string): { instantiations: number; time: number } {
  const configPath = ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath!, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath!));

  const start = Date.now();
  const program = ts.createProgram([filePath], {
    ...parsedConfig.options,
    noEmit: true,
  });

  // Force type checking
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const time = Date.now() - start;

  return {
    instantiations: (program as any).getInstantiationCount?.() || 0,
    time
  };
}

async function main() {
  const tests = [
    { name: 'loop', aot: 'from-wat/loop.aot.ts', interp: 'from-wat/loop.ts' },
    { name: 'add', aot: 'from-wat/add.aot.ts', interp: 'from-wat/add.ts' },
  ];

  for (const test of tests) {
    console.log(`\n=== ${test.name.toUpperCase()} ===`);

    console.log(`AOT (${test.aot})...`);
    const aot = measureInstantiations(path.join(__dirname, test.aot));
    console.log(`  Instantiations: ${aot.instantiations.toLocaleString()}`);
    console.log(`  Time: ${aot.time}ms`);

    console.log(`Interpreter (${test.interp})...`);
    const interp = measureInstantiations(path.join(__dirname, test.interp));
    console.log(`  Instantiations: ${interp.instantiations.toLocaleString()}`);
    console.log(`  Time: ${interp.time}ms`);

    if (aot.time > 0 && interp.time > 0) {
      console.log(`\n  ** AOT is ${(interp.time / aot.time).toFixed(2)}x faster **`);
    }
  }
}

main().catch(console.error);
