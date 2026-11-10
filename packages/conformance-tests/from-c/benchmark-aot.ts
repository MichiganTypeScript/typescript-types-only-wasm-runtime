/**
 * Benchmark: AOT vs Interpreter
 *
 * This file is used to compare TypeScript instantiation counts between
 * the interpreter-based approach and the AOT-compiled approach.
 *
 * Run with: pnpm build:trace
 * Then check the trace file for instantiation counts.
 */

import type { entry as entryInterpreter } from './c-add'
import type { entry as entryAot } from './c-add.aot'

// Interpreter version - requires full VM execution
type InterpreterResult1 = entryInterpreter<[5, 3]>
type InterpreterResult2 = entryInterpreter<[100, 200]>
type InterpreterResult3 = entryInterpreter<[1000, 2000]>

// AOT version - direct type computation
type AotResult1 = entryAot<[5, 3]>
type AotResult2 = entryAot<[100, 200]>
type AotResult3 = entryAot<[1000, 2000]>

// Force evaluation
export type Results = {
  interpreter: [InterpreterResult1, InterpreterResult2, InterpreterResult3]
  aot: [AotResult1, AotResult2, AotResult3]
}
