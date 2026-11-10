import type { Expect, Equal } from 'type-testing';
import type { entry } from './call-indirect.aot'

import { test, expect } from 'vitest';
import { getWasm } from '../utils'

// The AOT compiled output must agree with the real WASM engine
const name = 'call-indirect';
test(`${name} AOT`, async () => {
  const wasm = await getWasm("from-wat", name);
  expect(wasm(3, 2)).toStrictEqual(5);
  expect(wasm(2, 2)).toStrictEqual(4);
  expect(wasm(1, 2)).toStrictEqual(3);
  expect(wasm(0, 2)).toStrictEqual(2);
})

type testCases = [
  Expect<Equal<entry<[3, 2]>, 5>>,
  Expect<Equal<entry<[2, 2]>, 4>>,
  Expect<Equal<entry<[1, 2]>, 3>>,
  Expect<Equal<entry<[0, 2]>, 2>>,
  Expect<Equal<entry<[10, 20]>, 30>>,
]
