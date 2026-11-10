import type { entry } from './loop.aot'

// Verify loop.aot.ts produces correct results
// Expected: input * 8 (since loop runs 3 times, each time doubling)

// Force evaluation of a specific test case
type Test1 = entry<[1]>  // Should be 8

// Assert result equals expected
type AssertEquals<T, U> = T extends U ? (U extends T ? true : false) : false
type _assert = AssertEquals<Test1, 8> extends true ? {} : never
const _check: _assert = {}
