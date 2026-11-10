import type { entry } from './add.aot'

// Simple verification that add.aot.ts produces correct results
// This file should have NO type errors if AOT is working correctly

type Test1 = entry<[5, 3]> extends 8 ? true : false
type Test2 = entry<[0, 0]> extends 0 ? true : false
type Test3 = entry<[1, 1]> extends 2 ? true : false
type Test4 = entry<[10, 20]> extends 30 ? true : false

// These should all be true
type AllPass = Test1 & Test2 & Test3 & Test4

// Force error if any test fails
type _assert = AllPass extends true ? {} : never
const _check: _assert = {}
