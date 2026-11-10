import type { Expect, Equal } from 'type-testing';
import type { entry } from './call-indirect-offset.aot'

import { test, expect } from 'vitest';
import { getWasm } from '../utils'

// entry(a, b) = (a + b) + (a * b), where both calls go through the table
const name = 'call-indirect-offset';
test(`${name} AOT`, async () => {
  const wasm = await getWasm("from-wat", name);
  expect(wasm(3, 2)).toStrictEqual(11);
  expect(wasm(2, 2)).toStrictEqual(8);
  expect(wasm(1, 2)).toStrictEqual(5);
  expect(wasm(0, 2)).toStrictEqual(2);
})

type testCases = [
  Expect<Equal<entry<[3, 2]>, 11>>,
  Expect<Equal<entry<[2, 2]>, 8>>,
  Expect<Equal<entry<[1, 2]>, 5>>,
  Expect<Equal<entry<[0, 2]>, 2>>,
]
