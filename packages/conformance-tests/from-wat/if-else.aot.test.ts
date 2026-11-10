import { describe, test, expectTypeOf } from "vitest"
import type { entry } from "./if-else.aot"

describe("if-else AOT", () => {
  test("positive values add 1", () => {
    expectTypeOf<entry<[10, 2]>>().toEqualTypeOf<11>()
    expectTypeOf<entry<[10, 1]>>().toEqualTypeOf<11>()
    expectTypeOf<entry<[10, 0]>>().toEqualTypeOf<11>()
  })

  test("negative values subtract 1", () => {
    expectTypeOf<entry<[10, -1]>>().toEqualTypeOf<9>()
    expectTypeOf<entry<[10, -2]>>().toEqualTypeOf<9>()
  })
})
