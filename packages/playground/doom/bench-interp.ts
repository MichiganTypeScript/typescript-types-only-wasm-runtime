// Benchmark Interpreter - evaluates the doom entry type
import type { entry } from './doom'

// Force type evaluation by using a conditional type
type Result = entry<[], false, 100>  // debugMode=false, stopAt=100 instructions

// Export to ensure it's not tree-shaken
export type BenchResult = Result extends number ? Result : never
