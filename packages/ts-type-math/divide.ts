import { IsNegativeBinary, TwosComplementFlip } from './binary';
import { LessThanUnsignedBinary } from './comparison';
import { SubtractBinaryFixed } from "./subtract";
import { Wasm } from "./wasm";

/*
  Yes, I need this reference. I'm not good at this stuff.  Truly.

  Dividend / Divisor = Quotient

           Quotient
          __________
  Divisor | Dividend

  Dividend
  --------  =  Quotient
  Divisor
*/

// lifted from https://youtu.be/l3fM0XslOS0?t=350

type B = 0 | 1;

type FirstBit<Binary extends string> =
  Binary extends `${infer Bit}${string}` ? Bit : never;

type LeftShift<Binary extends string, Bit extends string> =
  Binary extends `${B}${infer tailBits}`
  ? `${tailBits}${Bit}`
  : never;

type Next<LeftShiftedA extends string, Q extends string, M extends string> =
  LessThanUnsignedBinary<LeftShiftedA, M> extends Wasm.I32True
    ? [ // restore
      LeftShiftedA,
      LeftShift<Q, '0'>,
    ]
    : [ // update
      SubtractBinaryFixed<LeftShiftedA, M>,
      LeftShift<Q, '1'>,
    ];

/*
  Restoring Division Algorithm for Unsigned Binary Numbers:
  
  The restoring division algorithm divides a binary number (dividend) by another (divisor) and finds the quotient and remainder.

  Steps:
  1. Initialize the accumulator (A) to 0, which will hold the partial remainders.
  2. The divisor (M) remains constant.
  3. The dividend is placed in the quotient register (Q).
  4. Perform the following steps for the number of bits in the dividend:
     a. Concatenate A and Q and perform a left shift (LS), shifting A and bringing in the next bit from Q.
     b. Subtract the divisor M from A.
     c. If the subtraction result is not negative (which means A >= M):
        - Set the least significant bit of Q to 1 and keep the new A.
     d. If the subtraction result is negative:
        - Set the least significant bit of Q to 0 and restore A to its value before the subtraction.
  5. The process is repeated until all bits in Q have been processed.
  6. The final content of Q is the quotient and A is the remainder.

  Example: Division of 7 (111) by 3 (011):
  - A starts at 000 and Q starts at 111. The divisor M is 011.
  - Concatenate A and Q, left-shift, and subtract M from A.
  - If the result of the subtraction is not negative, write 1 to the LSB of Q; otherwise, write 0 and restore A.
  - Continue this process until all bits in Q are processed.
  - The final Q is the quotient and A is the remainder.
*/
export type _DivideBinaryArbitrary<
  Q extends string, // dividend
  M extends string, // divisor
  A extends string,
  DebugStop extends string = never,
  ShrinkingQ extends string = Q,
> =
    ShrinkingQ extends '' | DebugStop
    ? [DebugStop] extends [never]
      ? {
        quotient: Q
        remainder: A
      }
      : Next<LeftShift<A, FirstBit<Q>>, Q, M> extends [infer NewA extends string, infer NewQ extends string]
        ? {
          quotient: Q
          remainder: A,
          M: M,
          A: A,
          Q: Q,
          _LeftShiftedA: LeftShift<A, FirstBit<Q>>,
          _LeftShiftedAMinusM: SubtractBinaryFixed<LeftShift<A, FirstBit<Q>>, M>,
          _newQ: NewQ,
          _newD: NewA
        }
        : never
    : Next<LeftShift<A, FirstBit<Q>>, Q, M> extends [infer NewA extends string, infer NewQ extends string]
      ? _DivideBinaryArbitrary<
          NewQ,
          M,
          NewA,
          DebugStop,
          ShrinkingQ extends `${B}${infer tailBits}` ? tailBits : ''
        >
      : never;

type ToPositiveBinary<N> =
  N extends `1${string}` ? TwosComplementFlip<N> : N;

type ToNegativeBinary<N> =
  N extends `0${string}` ? TwosComplementFlip<N> : N;

type ToNegativeProperties<O extends object, P extends keyof O> =
  { [K in keyof O]: K extends P ? ToNegativeBinary<O[K]> : O[K] };

/// Restoring division costs one step per dividend bit, and a leading zero bit
/// only rotates a zero through the accumulator.  Drop the leading zeros, divide
/// the significant bits, then pad the quotient back out.  Doom's operands are
/// screen coordinates and scales, so this is usually 8-16 steps, not 32.
type _StripLeading<S extends string, Pad extends string = ''> =
  S extends `0${infer Rest}`
    ? Rest extends '' ? { bits: S, pad: Pad } : _StripLeading<Rest, `${Pad}0`>
    : { bits: S, pad: Pad };

export type DivideUnsignedBinary32<
  dividend extends string,
  divisor extends string
> =
  [divisor] extends [Wasm.I32False] ? { quotient: Wasm.I32False, remainder: Wasm.I32False } : // if divide by zero return zero
  [dividend] extends [divisor] ? { quotient: Wasm.I32True, remainder: Wasm.I32False } : // if equal return 1
  [divisor] extends [Wasm.I32True] ? { quotient: dividend, remainder: Wasm.I32False } : // if divide by 1 return dividend

  _StripLeading<dividend> extends { bits: infer Bits extends string, pad: infer Pad extends string }
    ? _DivideNarrow<Bits, `00${divisor}`, `00${Wasm.I32False}`> extends
        [infer Q extends string, infer A extends string]
      ? { quotient: `${Pad}${Q}`, remainder: _Low32<A> }
      : never
    : never;

export type DivideSignedBinary32<
  dividend extends string,
  divisor extends string
> =
  IsNegativeBinary<dividend> extends true
  ? IsNegativeBinary<divisor> extends true
    ? ToNegativeProperties<
        DivideUnsignedBinary32<
          ToPositiveBinary<dividend>,
          ToPositiveBinary<divisor>
        >, 'remainder'
      >
    : ToNegativeProperties<
        DivideUnsignedBinary32<
          ToPositiveBinary<dividend>,
          divisor
        >, 'quotient' | 'remainder'
      >
  : IsNegativeBinary<divisor> extends true
    ? ToNegativeProperties<
        DivideUnsignedBinary32<
          dividend,
          ToPositiveBinary<divisor>
        >, 'quotient'
      >
    : DivideUnsignedBinary32<
        dividend,
        divisor
      >;


/// Shift one bit into the accumulator, dropping the top character.  Restoring
/// division keeps the accumulator below the divisor, so with two spare
/// characters the character being dropped is always '0'.
type _ShiftIn<A extends string, Bit extends string> =
  A extends `${B}${infer tailBits}` ? `${tailBits}${Bit}` : never;

/// One restoring-division step per bit of the dividend, against an accumulator
/// only as wide as the divisor needs.
type _DivideNarrow<
  Bits extends string,   // dividend bits still to shift in
  M extends string,      // divisor, two characters wider than 32
  A extends string,      // accumulator, same width as M
  Q extends string = '', // quotient bits decided so far
> =
  Bits extends `${infer bit}${infer rest}`
    ? _ShiftIn<A, bit> extends infer shifted extends string
      ? LessThanUnsignedBinary<shifted, M> extends Wasm.I32True
        ? _DivideNarrow<rest, M, shifted, `${Q}0`>
        : _DivideNarrow<rest, M, SubtractBinaryFixed<shifted, M>, `${Q}1`>
      : never
    : [Q, A];

/// The accumulator is 34 characters, so its value is the last 32.
type _Low32<A extends string> = A extends `${B}${B}${infer rest}` ? rest : never;

export type DivideUnsignedBinary64<
  dividend extends string,
  divisor extends string
> =
  [divisor] extends [Wasm.I64False] ? { quotient: Wasm.I64False, remainder: Wasm.I64False } : // if divide by zero return zero
  [dividend] extends [divisor] ? { quotient: Wasm.I64True, remainder: Wasm.I64False } : // if equal return 1
  [divisor] extends [Wasm.I64True] ? { quotient: dividend, remainder: Wasm.I64False } : // if divide by 1 return dividend

  // A divisor that fits in 32 bits - which is every divisor doom's FixedDiv
  // produces, since it sign-extends an i32 - only needs a 34 character
  // accumulator.  Subtracting the full 64 characters 64 times instead costs
  // enough instantiations to trip TypeScript's limit, and a division that
  // exceeds the limit comes back as `never` and poisons the memory word it is
  // stored into.
  divisor extends `${Wasm.I32False}${infer m extends string}`
    ? _DivideNarrow<dividend, `00${m}`, `00${Wasm.I32False}`> extends [infer Q extends string, infer A extends string]
      ? { quotient: Q, remainder: `${Wasm.I32False}${_Low32<A>}` }
      : never
    : _DivideBinaryArbitrary<
        dividend,
        divisor,
        Wasm.I64False
      >;

export type DivideSignedBinary64<
  dividend extends string,
  divisor extends string
> =
  IsNegativeBinary<dividend> extends true
  ? IsNegativeBinary<divisor> extends true
    ? ToNegativeProperties<
        DivideUnsignedBinary64<
          ToPositiveBinary<dividend>,
          ToPositiveBinary<divisor>
        >, 'remainder'
      >
    : ToNegativeProperties<
        DivideUnsignedBinary64<
          ToPositiveBinary<dividend>,
          divisor
        >, 'quotient' | 'remainder'
      >
  : IsNegativeBinary<divisor> extends true
    ? ToNegativeProperties<
        DivideUnsignedBinary64<
          dividend,
          ToPositiveBinary<divisor>
        >, 'quotient'
      >
    : DivideUnsignedBinary64<
        dividend,
        divisor
      >;
