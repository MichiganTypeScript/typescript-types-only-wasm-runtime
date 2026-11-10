// Benchmark AOT - evaluates the doom entry type
import type { entry } from './doom.aot'

// Force type evaluation by using a conditional type
type Result = entry<[]>

// Export to ensure it's not tree-shaken
export type BenchResult = Result extends number ? Result : never
