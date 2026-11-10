import { describe, test, expectTypeOf } from "vitest"
import type { entry as interpreterEntry } from './add'
import type { entry as aotEntry } from './add.aot'

describe("add AOT vs Interpreter comparison", () => {
  test("AOT and Interpreter produce same results", () => {
    // Basic cases
    expectTypeOf<aotEntry<[0, 0]>>().toEqualTypeOf<interpreterEntry<[0, 0]>>()
    expectTypeOf<aotEntry<[1, 1]>>().toEqualTypeOf<interpreterEntry<[1, 1]>>()
    expectTypeOf<aotEntry<[5, 3]>>().toEqualTypeOf<interpreterEntry<[5, 3]>>()
    expectTypeOf<aotEntry<[10, 20]>>().toEqualTypeOf<interpreterEntry<[10, 20]>>()
    expectTypeOf<aotEntry<[100, 200]>>().toEqualTypeOf<interpreterEntry<[100, 200]>>()
  })

  test("AOT produces correct values", () => {
    // Verify actual values
    expectTypeOf<aotEntry<[5, 3]>>().toEqualTypeOf<8>()
    expectTypeOf<aotEntry<[0, 0]>>().toEqualTypeOf<0>()
    expectTypeOf<aotEntry<[1, 1]>>().toEqualTypeOf<2>()
  })
})

