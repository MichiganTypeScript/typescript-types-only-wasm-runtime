import type { Expect, Equal } from 'type-testing';
import { expect, test } from 'vitest';
import { Wasm } from '../wasm';

/// wasm masks a shift or rotate count to the low 5 bits for i32. Before this
/// was implemented these all resolved to `never`, which the driver surfaced as
/// "return value is not a word: never" - `single-i32shl.wat` with entry(7, -3)
/// against a real engine's 536870912.
///
/// These are compile-time assertions: if the mask regresses, `Equal` fails to
/// typecheck and `pnpm --filter ts-type-math build` fails. The runtime body
/// keeps vitest reporting them as tests.
type B<N extends string> = N;

/// 7 << -3: -3 masks to 29, so 7 << 29 = 0xE0000000
type ShlNegative = Expect<Equal<
  Wasm.I32Shl<'00000000000000000000000000000111', '11111111111111111111111111111101'>,
  B<'11100000000000000000000000000000'>
>>;

/// 7 << 33: 33 masks to 1
type ShlOver32 = Expect<Equal<
  Wasm.I32Shl<'00000000000000000000000000000111', '00000000000000000000000000100001'>,
  B<'00000000000000000000000000001110'>
>>;

/// a count of exactly 32 masks to 0, so the value is unchanged
type ShlExactly32 = Expect<Equal<
  Wasm.I32Shl<'00000000000000000000000000000111', '00000000000000000000000000100000'>,
  B<'00000000000000000000000000000111'>
>>;

/// -8 >>> -3 is -8 >>> 29 = 7
type ShrUNegative = Expect<Equal<
  Wasm.I32ShrU<'11111111111111111111111111111000', '11111111111111111111111111111101'>,
  B<'00000000000000000000000000000111'>
>>;

/// -8 >> 29 keeps the sign: -1
type ShrSNegative = Expect<Equal<
  Wasm.I32ShrS<'11111111111111111111111111111000', '11111111111111111111111111111101'>,
  B<'11111111111111111111111111111111'>
>>;

/// i32.rotr had no implementation at all: the compiler emitted `Wasm.I32Rotr`
/// and nothing declared it. 1 rotr 1 = 0x80000000.
type RotrOne = Expect<Equal<
  Wasm.I32Rotr<'00000000000000000000000000000001', '00000000000000000000000000000001'>,
  B<'10000000000000000000000000000000'>
>>;

/// rotr by 0 is the identity, and is the case a naive 32-n rotate-left gets
/// wrong by rotating a full turn.
type RotrZero = Expect<Equal<
  Wasm.I32Rotr<'00000000000000000000000000000101', '00000000000000000000000000000000'>,
  B<'00000000000000000000000000000101'>
>>;

/// rotl masks its count too
type RotlOver32 = Expect<Equal<
  Wasm.I32Rotl<'00000000000000000000000000000001', '00000000000000000000000000100001'>,
  B<'00000000000000000000000000000010'>
>>;

test('shift and rotate counts are masked to 5 bits', () => {
  // the assertions above are the test; this keeps them in the vitest report
  const checked: Array<ShlNegative | ShlOver32 | ShlExactly32 | ShrUNegative |
    ShrSNegative | RotrOne | RotrZero | RotlOver32> = [true, true, true, true, true, true, true, true];
  expect(checked).toHaveLength(8);
});

/// The same values, checked against the engine that defines them. A hand-worked
/// expectation can be wrong in the same direction as the code it checks; these
/// come from wasm itself.
test('the masked results are what a real engine gives', () => {
  expect(7 << -3).toBe(0xe0000000 | 0);
  expect(7 << 33).toBe(14);
  expect(7 << 32).toBe(7);
  expect(-8 >>> -3).toBe(7);
  expect(-8 >> -3).toBe(-1);
  // rotr as the engine defines it, since JS has no rotate operator
  const rotr = (v: number, n: number) => {
    const s = n & 31;
    return s === 0 ? v | 0 : ((v >>> s) | (v << (32 - s))) | 0;
  };
  expect(rotr(1, 1)).toBe(0x80000000 | 0);
  expect(rotr(5, 0)).toBe(5);
});
