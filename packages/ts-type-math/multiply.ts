import { Add32Nibble, Add64Byte, StringAddArbitraryReversed } from "./add";
import { IsNegativeBinary, ReverseString8Segments, ReverseStringTheWorstWayPossible, TwosComplementFlip } from "./binary";
import { Ensure } from "./ensure";
import { Wasm, WasmValue } from "./wasm";
import type { Satisfies } from './utils'

type a = "00000000000000000000000001100100"
type b = "00000000000000000000000000001010"

export type I32MultiplyBinary<
  a extends WasmValue,
  b extends WasmValue
> = Satisfies<WasmValue,
  a extends Wasm.I32False ? Wasm.I32False :
  b extends Wasm.I32False ? Wasm.I32False :
  a extends Wasm.I32True ? b :
  b extends Wasm.I32True ? a :
  Ensure.I32<_MultiplyI32<a, b>>
>

/// The loop runs once per digit of the multiplier up to its highest one bit, so
/// the multiplier's significant width, not the product, decides whether it
/// finishes. Multiplication commutes, so the narrower operand can always be the
/// one driving it. Measured: 255 * 393480 with 393480 driving is
/// "excessively deep" and comes back an error type; the same product with 255
/// driving compiles clean and correct.
type _Significant<s extends string> = s extends `0${infer rest}` ? _Significant<rest> : s

/// True when `a` is no wider than `b`. Consuming both a character at a time
/// compares widths without counting either.
type _NoWider<a extends string, b extends string> =
  a extends `${string}${infer aRest}`
  ? b extends `${string}${infer bRest}`
    ? _NoWider<aRest, bRest>
    : false
  : true

type _MultiplyNarrowest<a extends string, b extends string> =
  _NoWider<_Significant<b>, _Significant<a>> extends true
  ? _MultiplyBinary<ReverseString8Segments<a>, ReverseString8Segments<b>, '', ''>
  : _MultiplyBinary<ReverseString8Segments<b>, ReverseString8Segments<a>, '', ''>

/// Only the low 32 bits of an i32 product survive, so the accumulator never
/// needs more than 32 characters and every partial product is one fixed-width
/// `Add32Nibble` (8 table lookups, ~10 instantiations deep). The arbitrary-width
/// adder used for the 64-bit path is a non-tail recursion two levels deep per
/// character, so a 48-character accumulator alone was ~96 levels: measured,
/// -31 * 0xC082 came back TS2589 / `never` (doom's R_DrawColumn frac, killing
/// the first frame), while 0xC000 and 0x82 each worked. Bounding the width
/// bounds the depth regardless of how many one bits the multiplier has.
///
/// `aShift` is the multiplicand shifted left by the current digit's place: drop
/// the top character, append a zero. Cheaper than I32Shl and needs no place
/// counter.
type _Shl1<s extends string> = s extends `${string}${infer rest}` ? `${rest}0` : never

type _MulLoop<aShift extends string, revB extends string, acc extends string> =
  revB extends `${infer digit}${infer tail}`
  ? (digit extends '1' ? Add32Nibble<acc, aShift> : acc) extends infer next extends string
    ? tail extends `${string}1${string}`
      ? _MulLoop<_Shl1<aShift>, tail, next>
      : next
    : never
  : acc

type _MultiplyI32<a extends string, b extends string> =
  _NoWider<_Significant<b>, _Significant<a>> extends true
  ? _MulLoop<a, ReverseString8Segments<b>, Wasm.I32False>
  : _MulLoop<b, ReverseString8Segments<a>, Wasm.I32False>

/// Low and high 32 characters of a 64-character word, each widened back to 64.
type _Lo64<s extends string> =
  s extends `${infer _h0}${infer _h1}${infer _h2}${infer _h3}${infer _h4}${infer _h5}${infer _h6}${infer _h7}${infer _h8}${infer _h9}${infer _h10}${infer _h11}${infer _h12}${infer _h13}${infer _h14}${infer _h15}${infer _h16}${infer _h17}${infer _h18}${infer _h19}${infer _h20}${infer _h21}${infer _h22}${infer _h23}${infer _h24}${infer _h25}${infer _h26}${infer _h27}${infer _h28}${infer _h29}${infer _h30}${infer _h31}${infer lo}`
  ? lo
  : never
type _Hi64<s extends string> =
  s extends `${infer h0}${infer h1}${infer h2}${infer h3}${infer h4}${infer h5}${infer h6}${infer h7}${infer h8}${infer h9}${infer h10}${infer h11}${infer h12}${infer h13}${infer h14}${infer h15}${infer h16}${infer h17}${infer h18}${infer h19}${infer h20}${infer h21}${infer h22}${infer h23}${infer h24}${infer h25}${infer h26}${infer h27}${infer h28}${infer h29}${infer h30}${infer h31}${string}`
  ? `${h0}${h1}${h2}${h3}${h4}${h5}${h6}${h7}${h8}${h9}${h10}${h11}${h12}${h13}${h14}${h15}${h16}${h17}${h18}${h19}${h20}${h21}${h22}${h23}${h24}${h25}${h26}${h27}${h28}${h29}${h30}${h31}`
  : never

/// Assemble the 64-bit product out of 32-bit pieces.
///
/// The partial-product loop costs one add over the whole accumulator per one bit
/// of the multiplier, so at 64 characters it exhausts the checker's budget on
/// almost anything: 5 * 3 was already TS2589, and every test case whose narrower
/// operand was wider than one bit failed. Only the low 64 bits survive, so
///
///   a * b = aLo*bLo + ((aHi*bLo + aLo*bHi) << 32)
///
/// aLo*bLo is the one piece that needs all 64 bits (its high half is the carry
/// into the top word). The cross terms only need their low 32, which is
/// `I32Mul`. The three cross terms above the low 64 bits are discarded, exactly
/// as the CFG backend's `$Mul64` does - that one is checked against V8 on
/// `i64-arith.wasm`, 24 exports matching, so this mirrors a structure known to
/// be right.
///
/// Written as a chain of `infer` bindings rather than nested calls: each step
/// hands the next a name that is already resolved, so the checker does not
/// re-walk the prefix.
type _Magnitude64<a extends string, b extends string> =
  _MulWide<_Lo64<a>, _Lo64<b>> extends infer full extends string
  ? Wasm.I32Mul<_Hi64<a>, _Lo64<b>> extends infer ahbl extends string
    ? Wasm.I32Mul<_Lo64<a>, _Hi64<b>> extends infer albh extends string
      ? Wasm.I32Add<Wasm.I32Add<ahbl, albh>, _Hi64<full>> extends infer hi extends string
        ? `${hi}${_Lo64<full>}`
        : never
      : never
    : never
  : never

/// Full 64-bit product of two 32-bit values, needed for the carry out of the
/// low half. Same shape as `_MulLoop`, over a fixed 64-character accumulator
/// with `Add64Byte` (8 table lookups). The arbitrary-width adder it replaced is
/// a non-tail recursion two levels deep per character; at 64 characters that
/// was TS2589 on every wide-by-wide case (4248100 * 83719208 and nine more in
/// the i64 table), and those are what FixedMul feeds it. Fixed width bounds the
/// depth regardless of how many one bits the multiplier has.
type _MulLoop64<aShift extends string, revB extends string, acc extends string> =
  revB extends `${infer digit}${infer tail}`
  ? (digit extends '1' ? Add64Byte<acc, aShift> : acc) extends infer next extends string
    ? tail extends `${string}1${string}`
      ? _MulLoop64<_Shl1<aShift>, tail, next>
      : next
    : never
  : acc

type _MulWide<a extends string, b extends string> =
  _NoWider<_Significant<b>, _Significant<a>> extends true
  ? _MulLoop64<`${Wasm.I32False}${a}`, ReverseString8Segments<b>, Wasm.I64False>
  : _MulLoop64<`${Wasm.I32False}${b}`, ReverseString8Segments<a>, Wasm.I64False>

/// A zero bit costs the partial-product loop nothing, but a one bit costs an add
/// over the whole accumulator - and a sign-extended negative i32 carries 32
/// leading one bits, so doom's FixedMul paid 32 extra adds over 128 characters
/// and came back `never`. Two's complement multiplication does not care about
/// sign, so multiplying magnitudes and negating once at the end gives the same
/// low 64 bits with those leading bits back to being zeros.
export type I64MultiplyBinary<
  a extends WasmValue,
  b extends WasmValue
> = Satisfies<WasmValue,
  a extends Wasm.I64False ? Wasm.I64False :
  b extends Wasm.I64False ? Wasm.I64False :
  a extends Wasm.I64True ? b :
  b extends Wasm.I64True ? a :
  IsNegativeBinary<a> extends true
    ? IsNegativeBinary<b> extends true
      ? _Magnitude64<TwosComplementFlip<a>, TwosComplementFlip<b>>
      : TwosComplementFlip<_Magnitude64<TwosComplementFlip<a>, b>>
    : IsNegativeBinary<b> extends true
      ? TwosComplementFlip<_Magnitude64<a, TwosComplementFlip<b>>>
      : _Magnitude64<a, b>
>

/// Once the remaining multiplier digits are all zero every further step is a
/// no-op that still costs a recursion carrying the whole accumulator. The
/// reversed multiplier puts the high bits last, so a small multiplier - a
/// constant, a fixed-point fraction - spends most of the loop there. Stopping
/// at the last one bit gives the same accumulator for less work.
type _MulStep<
  a extends string,
  tail extends string,
  _Place extends string,
  _Acc extends string
> =
  tail extends `${string}1${string}`
  ? _MultiplyBinary<a, tail, _Place, _Acc>
  : ReverseStringTheWorstWayPossible<_Acc>

export type _MultiplyBinary<
  a extends string,
  revB extends string,

  _Place extends string,
  _Acc extends string
> =
  revB extends `${infer digit}${infer tail}`
  ? digit extends "0"
    ? // there's no point in doing any "work", so we can just move on to the next digit
      _MulStep<
        a,
        tail,
        `0${_Place}`,
        _Acc
      >

    : // we have a digit to multiply
      _MulStep<
        a,
        tail,
        `0${_Place}`,

        StringAddArbitraryReversed<
          `${_Place}${a}`,
          _Acc,
          []
        >
      >

  : ReverseStringTheWorstWayPossible<_Acc>
