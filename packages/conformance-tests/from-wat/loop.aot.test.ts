import type { Expect, Equal } from 'type-testing';
import type { entry } from './loop.aot'

import { test, expect } from 'vitest';
import { getWasm } from '../utils'

const name = 'loop';
test(`${name}.aot`, async () => {
  const entry = await getWasm("from-wat", name);
  expect(entry(3)).toStrictEqual(24);
  expect(entry(2)).toStrictEqual(16);
  expect(entry(1)).toStrictEqual(8);
  expect(entry(0)).toStrictEqual(0);
  expect(entry(-1)).toStrictEqual(-8);
  expect(entry(-2)).toStrictEqual(-16);
  expect(entry(-3)).toStrictEqual(-24);
});

type testCases = [
  Expect<Equal<entry<[3]>, 24>>,
  Expect<Equal<entry<[2]>, 16>>,
  Expect<Equal<entry<[1]>, 8>>,
  Expect<Equal<entry<[0]>, 0>>,
  Expect<Equal<entry<[-1]>, -8>>,
  Expect<Equal<entry<[-2]>, -16>>,
  Expect<Equal<entry<[-3]>, -24>>,
]
