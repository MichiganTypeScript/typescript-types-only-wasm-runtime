/**
 * Apples-to-apples benchmark: AOT vs Interpreter
 *
 * Both compute the same thing: loop(2) = 2 * 2 * 2 * 2 = 16
 *
 * Run: npx tsc --noEmit --extendedDiagnostics benchmark-comparison.ts
 */

// === INTERPRETER VERSION ===
// Uses the full wasm-to-typescript-types runtime
import type { entry as InterpreterEntry } from './from-wat/loop'

type InterpreterResult = InterpreterEntry<[2]>
// Forces full VM execution: parsing, stack simulation, memory, etc.


// === AOT VERSION ===
// Direct type computation, no VM overhead
import type { entry as AotEntry } from './from-wat/loop.aot'

type AotResult = AotEntry<[2]>
// Direct: $loop_0<$p0, $p0, 0, $p0> recursively computes result


// Verify both produce same result
type _CheckSame = InterpreterResult extends AotResult
  ? AotResult extends InterpreterResult
    ? true
    : false
  : false

// Export to force evaluation
export type Results = {
  interpreter: InterpreterResult  // Should be 16
  aot: AotResult                  // Should be 16
  same: _CheckSame                // Should be true
}
