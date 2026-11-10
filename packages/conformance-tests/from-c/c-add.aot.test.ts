import { describe, test, expectTypeOf } from "vitest"
import type { entry } from "./c-add.aot"

describe("c-add AOT", () => {
  test("adds two numbers", () => {
    expectTypeOf<entry<[5, 3]>>().toEqualTypeOf<8>()
    expectTypeOf<entry<[0, 0]>>().toEqualTypeOf<0>()
    expectTypeOf<entry<[1, 1]>>().toEqualTypeOf<2>()
  })
})
