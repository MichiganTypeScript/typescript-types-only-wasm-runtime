import { Bit, To32Binary, ToDecimalSigned } from "./binary";
import { WasmValue } from "./wasm";
import type { Satisfies } from './utils'

type LookupBitAnd = {
  '0': {
    '0': '0';
    '1': '0';
  };
  '1': {
    '0': '0';
    '1': '1';
  };
}

type LookupBitOr = {
  '0': {
    '0': '0';
    '1': '1';
  };
  '1': {
    '0': '1';
    '1': '1';
  };
}

type LookupBitXor = {
  '0': {
    '0': '0';
    '1': '1';
  };
  '1': {
    '0': '1';
    '1': '0';
  };
}

// QUESTION maybe don't make Lookup generic for better performance?
type ProcessLookup<
  A extends string,
  B extends string,
  Lookup extends Record<Bit, Record<Bit, Bit>>,
> =
  A extends `${infer AHead extends Bit}${infer ATail extends string}`
  ? B extends `${infer BHead extends Bit}${infer BTail extends string}`
    ? `${Lookup[AHead][BHead]}${ProcessLookup<ATail, BTail, Lookup>}`

    : // B is empty
      ''

  : // A is empty
    ''

export type BitwiseAnd<
  T extends number,
  U extends number
> = ToDecimalSigned<BitwiseAndBinary<To32Binary<T>, To32Binary<U>>>

export type BitwiseAndBinary<
  T extends string,
  U extends string
> = ProcessLookup<T, U, LookupBitAnd>

export type BitwiseOr<
  T extends number,
  U extends number
> = ToDecimalSigned<BitwiseOrBinary<To32Binary<T>, To32Binary<U>>>

export type BitwiseOrBinary<
  T extends string,
  U extends string
> = ProcessLookup<T, U, LookupBitOr>

export type BitwiseXor<
  T extends number,
  U extends number
> = ToDecimalSigned<BitwiseXorBinary<To32Binary<T>, To32Binary<U>>>

export type BitwiseXorBinary<
  T extends string,
  U extends string
> = ProcessLookup<T, U, LookupBitXor>

type _BitwiseNotBinary<
  T extends string,
  _Acc extends string
> =
  T extends `${infer Head}${infer Tail}`
  ? _BitwiseNotBinary<Tail, `${_Acc}${Head extends '0' ? '1' : '0'}`>
  : _Acc

export type BitwiseNotBinary<
  T extends string
> = _BitwiseNotBinary<T, ''>

export type BitwiseNot<
  T extends number
> = ToDecimalSigned<BitwiseNotBinary<To32Binary<T>>>

/// Bit-driven rotation ladder.
///
/// The previous implementation walked one character per unit of shift
/// (`LeftRotateString`, up to 63 sequential recursive instantiations) and
/// reached that count by converting the masked shift operand through
/// `Convert.WasmValue.ToTSBigInt` -> `Convert.TSBigInt.ToTSNumber`. On i64 that
/// composed stack is what tripped TS2589 for the rotate operators, so
/// `i64.rotr` failed to resolve for *every* input rather than only for large
/// shifts. Decomposing the shift into powers of two turns the walk into at most
/// six conditional steps, each a single wide template-literal split, and drives
/// them off the mask characters directly so no numeric conversion is needed.

type Rotl32_1<T extends string> =
  T extends `${infer c0}${infer Rest}`
    ? `${Rest}${c0}`
    : never;
type Rotl32_2<T extends string> =
  T extends `${infer c0}${infer c1}${infer Rest}`
    ? `${Rest}${c0}${c1}`
    : never;
type Rotl32_4<T extends string> =
  T extends `${infer c0}${infer c1}${infer c2}${infer c3}${infer Rest}`
    ? `${Rest}${c0}${c1}${c2}${c3}`
    : never;
type Rotl32_8<T extends string> =
  T extends `${infer c0}${infer c1}${infer c2}${infer c3}${infer c4}${infer c5}${infer c6}${infer c7}${infer Rest}`
    ? `${Rest}${c0}${c1}${c2}${c3}${c4}${c5}${c6}${c7}`
    : never;
type Rotl32_16<T extends string> =
  T extends `${infer c0}${infer c1}${infer c2}${infer c3}${infer c4}${infer c5}${infer c6}${infer c7}${infer c8}${infer c9}${infer c10}${infer c11}${infer c12}${infer c13}${infer c14}${infer c15}${infer Rest}`
    ? `${Rest}${c0}${c1}${c2}${c3}${c4}${c5}${c6}${c7}${c8}${c9}${c10}${c11}${c12}${c13}${c14}${c15}`
    : never;

/// Applies the ladder for a 32-bit rotate left. `Bits` is the shift count
/// already masked to its low 5 bits, MSB first, so each character
/// selects whether that power-of-two rotation is applied.
export type Rotl32Bits<T extends string, Bits extends string> =
  Rotl32Step0<T, Bits>;

type Rotl32Step0<T extends string, Bits extends string> =
  Bits extends `${infer b0}${infer b1}${infer b2}${infer b3}${infer b4}`
    ? (b0 extends '1' ? Rotl32_16<T> : T) extends infer Applied extends string
      ? Rotl32Step1<Applied, `${b1}${b2}${b3}${b4}`>
      : never
    : never;

type Rotl32Step1<T extends string, Bits extends string> =
  Bits extends `${infer b1}${infer b2}${infer b3}${infer b4}`
    ? (b1 extends '1' ? Rotl32_8<T> : T) extends infer Applied extends string
      ? Rotl32Step2<Applied, `${b2}${b3}${b4}`>
      : never
    : never;

type Rotl32Step2<T extends string, Bits extends string> =
  Bits extends `${infer b2}${infer b3}${infer b4}`
    ? (b2 extends '1' ? Rotl32_4<T> : T) extends infer Applied extends string
      ? Rotl32Step3<Applied, `${b3}${b4}`>
      : never
    : never;

type Rotl32Step3<T extends string, Bits extends string> =
  Bits extends `${infer b3}${infer b4}`
    ? (b3 extends '1' ? Rotl32_2<T> : T) extends infer Applied extends string
      ? Rotl32Step4<Applied, `${b4}`>
      : never
    : never;

type Rotl32Step4<T extends string, Bits extends string> =
  Bits extends `${infer b4}`
    ? (b4 extends '1' ? Rotl32_1<T> : T) extends infer Applied extends string
      ? Applied
      : never
    : never;

type Rotl64_1<T extends string> =
  T extends `${infer c0}${infer Rest}`
    ? `${Rest}${c0}`
    : never;
type Rotl64_2<T extends string> =
  T extends `${infer c0}${infer c1}${infer Rest}`
    ? `${Rest}${c0}${c1}`
    : never;
type Rotl64_4<T extends string> =
  T extends `${infer c0}${infer c1}${infer c2}${infer c3}${infer Rest}`
    ? `${Rest}${c0}${c1}${c2}${c3}`
    : never;
type Rotl64_8<T extends string> =
  T extends `${infer c0}${infer c1}${infer c2}${infer c3}${infer c4}${infer c5}${infer c6}${infer c7}${infer Rest}`
    ? `${Rest}${c0}${c1}${c2}${c3}${c4}${c5}${c6}${c7}`
    : never;
type Rotl64_16<T extends string> =
  T extends `${infer c0}${infer c1}${infer c2}${infer c3}${infer c4}${infer c5}${infer c6}${infer c7}${infer c8}${infer c9}${infer c10}${infer c11}${infer c12}${infer c13}${infer c14}${infer c15}${infer Rest}`
    ? `${Rest}${c0}${c1}${c2}${c3}${c4}${c5}${c6}${c7}${c8}${c9}${c10}${c11}${c12}${c13}${c14}${c15}`
    : never;
type Rotl64_32<T extends string> =
  T extends `${infer c0}${infer c1}${infer c2}${infer c3}${infer c4}${infer c5}${infer c6}${infer c7}${infer c8}${infer c9}${infer c10}${infer c11}${infer c12}${infer c13}${infer c14}${infer c15}${infer c16}${infer c17}${infer c18}${infer c19}${infer c20}${infer c21}${infer c22}${infer c23}${infer c24}${infer c25}${infer c26}${infer c27}${infer c28}${infer c29}${infer c30}${infer c31}${infer Rest}`
    ? `${Rest}${c0}${c1}${c2}${c3}${c4}${c5}${c6}${c7}${c8}${c9}${c10}${c11}${c12}${c13}${c14}${c15}${c16}${c17}${c18}${c19}${c20}${c21}${c22}${c23}${c24}${c25}${c26}${c27}${c28}${c29}${c30}${c31}`
    : never;

/// Applies the ladder for a 64-bit rotate left. `Bits` is the shift count
/// already masked to its low 6 bits, MSB first, so each character
/// selects whether that power-of-two rotation is applied.
export type Rotl64Bits<T extends string, Bits extends string> =
  Rotl64Step0<T, Bits>;

type Rotl64Step0<T extends string, Bits extends string> =
  Bits extends `${infer b0}${infer b1}${infer b2}${infer b3}${infer b4}${infer b5}`
    ? (b0 extends '1' ? Rotl64_32<T> : T) extends infer Applied extends string
      ? Rotl64Step1<Applied, `${b1}${b2}${b3}${b4}${b5}`>
      : never
    : never;

type Rotl64Step1<T extends string, Bits extends string> =
  Bits extends `${infer b1}${infer b2}${infer b3}${infer b4}${infer b5}`
    ? (b1 extends '1' ? Rotl64_16<T> : T) extends infer Applied extends string
      ? Rotl64Step2<Applied, `${b2}${b3}${b4}${b5}`>
      : never
    : never;

type Rotl64Step2<T extends string, Bits extends string> =
  Bits extends `${infer b2}${infer b3}${infer b4}${infer b5}`
    ? (b2 extends '1' ? Rotl64_8<T> : T) extends infer Applied extends string
      ? Rotl64Step3<Applied, `${b3}${b4}${b5}`>
      : never
    : never;

type Rotl64Step3<T extends string, Bits extends string> =
  Bits extends `${infer b3}${infer b4}${infer b5}`
    ? (b3 extends '1' ? Rotl64_4<T> : T) extends infer Applied extends string
      ? Rotl64Step4<Applied, `${b4}${b5}`>
      : never
    : never;

type Rotl64Step4<T extends string, Bits extends string> =
  Bits extends `${infer b4}${infer b5}`
    ? (b4 extends '1' ? Rotl64_2<T> : T) extends infer Applied extends string
      ? Rotl64Step5<Applied, `${b5}`>
      : never
    : never;

type Rotl64Step5<T extends string, Bits extends string> =
  Bits extends `${infer b5}`
    ? (b5 extends '1' ? Rotl64_1<T> : T) extends infer Applied extends string
      ? Applied
      : never
    : never;

/// Rotating right by `n` is rotating left by `width - n`, and for `n = 0`
/// it is a no-op rather than a full turn. Rather than run a subtraction
/// through the binary adder to find that count, this maps the already-masked
/// 5-bit count straight to its negation: one flat table lookup, no
/// instantiation depth, and the same ladder then does the rotation.
type Neg5Table = {
  '00000': '00000';
  '00001': '11111';
  '00010': '11110';
  '00011': '11101';
  '00100': '11100';
  '00101': '11011';
  '00110': '11010';
  '00111': '11001';
  '01000': '11000';
  '01001': '10111';
  '01010': '10110';
  '01011': '10101';
  '01100': '10100';
  '01101': '10011';
  '01110': '10010';
  '01111': '10001';
  '10000': '10000';
  '10001': '01111';
  '10010': '01110';
  '10011': '01101';
  '10100': '01100';
  '10101': '01011';
  '10110': '01010';
  '10111': '01001';
  '11000': '01000';
  '11001': '00111';
  '11010': '00110';
  '11011': '00101';
  '11100': '00100';
  '11101': '00011';
  '11110': '00010';
  '11111': '00001';
};

/// Rotating right by `n` is rotating left by `width - n`, and for `n = 0`
/// it is a no-op rather than a full turn. Rather than run a subtraction
/// through the binary adder to find that count, this maps the already-masked
/// 6-bit count straight to its negation: one flat table lookup, no
/// instantiation depth, and the same ladder then does the rotation.
type Neg6Table = {
  '000000': '000000';
  '000001': '111111';
  '000010': '111110';
  '000011': '111101';
  '000100': '111100';
  '000101': '111011';
  '000110': '111010';
  '000111': '111001';
  '001000': '111000';
  '001001': '110111';
  '001010': '110110';
  '001011': '110101';
  '001100': '110100';
  '001101': '110011';
  '001110': '110010';
  '001111': '110001';
  '010000': '110000';
  '010001': '101111';
  '010010': '101110';
  '010011': '101101';
  '010100': '101100';
  '010101': '101011';
  '010110': '101010';
  '010111': '101001';
  '011000': '101000';
  '011001': '100111';
  '011010': '100110';
  '011011': '100101';
  '011100': '100100';
  '011101': '100011';
  '011110': '100010';
  '011111': '100001';
  '100000': '100000';
  '100001': '011111';
  '100010': '011110';
  '100011': '011101';
  '100100': '011100';
  '100101': '011011';
  '100110': '011010';
  '100111': '011001';
  '101000': '011000';
  '101001': '010111';
  '101010': '010110';
  '101011': '010101';
  '101100': '010100';
  '101101': '010011';
  '101110': '010010';
  '101111': '010001';
  '110000': '010000';
  '110001': '001111';
  '110010': '001110';
  '110011': '001101';
  '110100': '001100';
  '110101': '001011';
  '110110': '001010';
  '110111': '001001';
  '111000': '001000';
  '111001': '000111';
  '111010': '000110';
  '111011': '000101';
  '111100': '000100';
  '111101': '000011';
  '111110': '000010';
  '111111': '000001';
};

/// Applies the ladder for a 32-bit rotate right. `Bits` is the count already
/// masked to its low 5 bits, MSB first.
export type Rotr32Bits<T extends string, Bits extends string> =
  Bits extends keyof Neg5Table ? Rotl32Bits<T, Neg5Table[Bits]> : never;

/// Applies the ladder for a 64-bit rotate right. `Bits` is the count already
/// masked to its low 6 bits, MSB first.
export type Rotr64Bits<T extends string, Bits extends string> =
  Bits extends keyof Neg6Table ? Rotl64Bits<T, Neg6Table[Bits]> : never;
