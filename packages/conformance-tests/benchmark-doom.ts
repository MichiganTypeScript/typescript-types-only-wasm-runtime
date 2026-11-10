/**
 * Doom benchmark: AOT vs Interpreter
 *
 * Run AOT only:
 *   npx tsc --noEmit --extendedDiagnostics benchmark-doom-aot.ts
 *
 * Run Interpreter only:
 *   npx tsc --noEmit --extendedDiagnostics benchmark-doom-interpreter.ts
 *
 * Compare the "Types" and "Check time" metrics
 */

// === AOT VERSION ===
// Direct type expressions, no VM simulation
import type { entry as AotEntry } from '../playground/doom/doom.aot'

type AotResult = AotEntry<[]>

export type Results = {
  aot: AotResult
}
