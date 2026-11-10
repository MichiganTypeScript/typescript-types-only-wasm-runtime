// Minimal test to verify AOT types work
import type { entry } from './doom/doom.aot'

// The entry function takes no arguments and returns a number
type Result = entry<[]>

// Export to force evaluation
export type { Result }
