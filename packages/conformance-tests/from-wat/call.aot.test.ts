import { describe, test, expectTypeOf } from "vitest"
import type { entry } from "./call.aot"

describe("call AOT", () => {
  test("calls function and returns result", () => {
    expectTypeOf<entry<[]>>().toEqualTypeOf<43>()
  })
})
