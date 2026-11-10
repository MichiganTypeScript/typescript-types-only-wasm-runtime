import { I32AddBinary, I64AddBinary } from "./add";
import { ShiftLeftBinaryO, ShiftRightBinary, ShiftRightBinary64, ShiftLeftBinary64 } from "./shift";
import { BitwiseAndBinary, BitwiseOrBinary, BitwiseXorBinary, Rotl32Bits, Rotr32Bits, Rotl64Bits, Rotr64Bits } from "./bitwise";
import { EqualsBinary, GreaterThanSignedBinary, GreaterThanUnsignedBinary, LessThanSignedBinary, LessThanUnsignedBinary, NotEqualsBinary } from "./comparison";
import { I32SubtractBinary, I64SubtractBinary } from "./subtract";
import { I32MultiplyBinary, I64MultiplyBinary } from "./multiply";
import { I64ExtendI32SBinary64, I64ExtendI32UBinary64, I32Extend16SBinary32 } from "./wasm-conversion";
import { I32ClzBinary, I64ClzBinary64, I32CtzBinary, I64CtzBinary64, I32PopcntBinary, I64PopcntBinary64 } from "./binary";
import { WrapBinary } from "./split";
import { Convert } from "./conversion";
import type { Satisfies } from './utils'
import { DivideSignedBinary32, DivideSignedBinary64, DivideUnsignedBinary32, DivideUnsignedBinary64 } from "./divide";
// import { DivideBinary32, RemainderBinary32 } from "./divide";

export type WasmType = 'i32' | 'i64' | 'f32' | 'f64';
export type WasmInt = 'i32' | 'i64';
export type WasmFloat = 'f32' | 'f64';

/**
 * This type is a wasm memory value.  Could be an item on the stack, or a global, or a byte in memory (or a few bytes)
 * this is a string with either 8, 16, 32 or 64 bits in binary
 */
export type WasmValue = string;

export namespace Wasm {
  /** 8 bits string (in binary) */
  export type Byte = string;
  /**
   * in WebAssembly, linear memory is "zeroed out" when the program initializes, which means it's actually totally fine to read memory beyond what's been written.
   * all that happens is you get zero bytes.  check out the single-i32store8.wat for a simple example.
   */
  export type I8False = '00000000';
  export type I32True  = '00000000000000000000000000000001'
  export type I32False = '00000000000000000000000000000000'
  export type I64True  = '0000000000000000000000000000000000000000000000000000000000000001'
  export type I64False = '0000000000000000000000000000000000000000000000000000000000000000'

  export type I32Add<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    I32AddBinary<a, b>
  >

  export type I64Add<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    I64AddBinary<a, b>
  >

  export type I32Sub<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    I32SubtractBinary<a, b>
  >

  export type I64Sub<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    I64SubtractBinary<a, b>
  >

  export type I32Mul<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    I32MultiplyBinary<a, b>
  >

  export type I64Mul<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    I64MultiplyBinary<a, b>
  >

  export type I32Eqz<
    a extends WasmValue
  > = Satisfies<WasmValue,
    a extends I32False ? I32True : I32False
  >

  export type I64Eqz<
    a extends WasmValue
  > = Satisfies<WasmValue,
    // note, even if it's an i64, it's still 32 bits that's returned
    a extends I64False ? I32True : I32False
  >

  export type I32Eq<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b>
  >

  export type I64Eq<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b>
  >

  export type I32Neq<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    NotEqualsBinary<a, b>
  >

  export type I64Neq<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    NotEqualsBinary<a, b>
  >

  /// wasm masks a shift or rotate count to the width of the value: i32.shl by
  /// 33 shifts by 1, and by -1 shifts by 31. The count arrives here as a full
  /// 32-bit word, so without the mask a count outside 0..31 decodes to a number
  /// no branch of the shift table matches and the operation is `never` -
  /// measured on `single-i32shl.wat`, `entry(7, -3)` gave "return value is not
  /// a word: never" where the engine gives 536870912.
  ///
  /// The low five characters of the word are the low 5 bits. Twenty-seven
  /// single-character `infer`s consume the high bits - each matches exactly one
  /// character - and the remainder is the masked count, re-padded to 32.
  /// A `${string}` prefix instead of the twenty-seven is not anchored: it
  /// matches greedily and the whole word falls through unmasked, which is the
  /// first version of this fix and it changed nothing.
  type Low5<b extends string> =
    b extends `${infer _1}${infer _2}${infer _3}${infer _4}${infer _5}${infer _6}${infer _7}${infer _8}${infer _9}${infer _10}${infer _11}${infer _12}${infer _13}${infer _14}${infer _15}${infer _16}${infer _17}${infer _18}${infer _19}${infer _20}${infer _21}${infer _22}${infer _23}${infer _24}${infer _25}${infer _26}${infer _27}${infer Rest}`
      ? `000000000000000000000000000${Rest}`
      : b

  export type I32Shl<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    ShiftLeftBinaryO<a, Low5<b>>
  >

  export type I32ShrU<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    ShiftRightBinary<a, Low5<b>, false>
  >

  export type I32ShrS<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    ShiftRightBinary<a, Low5<b>, true>
  >

  export type I32And<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    BitwiseAndBinary<a, b>
  >

  export type I32Or<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    BitwiseOrBinary<a, b>
  >

  export type I32Xor<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    BitwiseXorBinary<a, b>
  >

  export type I64And<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    BitwiseAndBinary<a, b>
  >

  export type I64Or<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    BitwiseOrBinary<a, b>
  >

  export type I64Xor<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    BitwiseXorBinary<a, b>
  >

  export type I32GtU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    GreaterThanUnsignedBinary<a, b>
  >

  export type I32GeU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b> extends I32True
    ? I32True
    : GreaterThanUnsignedBinary<a, b>
  >

  export type I32LtU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    LessThanUnsignedBinary<a, b>
  >

  export type I32LeU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b> extends I32True
    ? I32True
    : LessThanUnsignedBinary<a, b>
  >


  export type I32GtS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    GreaterThanSignedBinary<a, b>
  >

  export type I32GeS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b> extends I32True
    ? I32True
    : GreaterThanSignedBinary<a, b>
  >

  export type I32LtS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    LessThanSignedBinary<a, b>
  >

  export type I32LeS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b> extends I32True
    ? I32True
    : LessThanSignedBinary<a, b>
  >

  export type I64GtU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    GreaterThanUnsignedBinary<a, b>
  >

  export type I64GeU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b> extends I32True
    ? I32True
    : GreaterThanUnsignedBinary<a, b>
  >

  export type I64LtU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    LessThanUnsignedBinary<a, b>
  >

  export type I64LeU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b> extends I32True
    ? I32True
    : LessThanUnsignedBinary<a, b>
  >


  export type I64GtS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    GreaterThanSignedBinary<a, b>
  >

  export type I64GeS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b> extends I32True
    ? I32True
    : GreaterThanSignedBinary<a, b>
  >

  export type I64LtS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    LessThanSignedBinary<a, b>
  >

  export type I64LeS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    EqualsBinary<a, b> extends I32True
    ? I32True
    : LessThanSignedBinary<a, b>
  >

  /// The i64 analogue of `Low5`. WebAssembly masks i64 shift and rotate
  /// counts to the low 6 bits of the operand (`count % 64`), so a shift of 64
  /// is a no-op, not a wipe. Without this the 64-bit shifts either produced
  /// `never` (counts >= 64 walk off the end of the word) or shifted by the
  /// unmasked amount, which is wrong for every count outside 0..63.
  ///
  /// Same construction as `Low5`: 58 single-character `infer`s eat the high
  /// bits, each matching exactly one character, and `Rest` is the surviving
  /// 6-bit count re-padded to 64. A `${string}` prefix would match greedily
  /// and let the whole word through unmasked.
  type Low6<b extends string> =
    b extends `${infer _1}${infer _2}${infer _3}${infer _4}${infer _5}${infer _6}${infer _7}${infer _8}${infer _9}${infer _10}${infer _11}${infer _12}${infer _13}${infer _14}${infer _15}${infer _16}${infer _17}${infer _18}${infer _19}${infer _20}${infer _21}${infer _22}${infer _23}${infer _24}${infer _25}${infer _26}${infer _27}${infer _28}${infer _29}${infer _30}${infer _31}${infer _32}${infer _33}${infer _34}${infer _35}${infer _36}${infer _37}${infer _38}${infer _39}${infer _40}${infer _41}${infer _42}${infer _43}${infer _44}${infer _45}${infer _46}${infer _47}${infer _48}${infer _49}${infer _50}${infer _51}${infer _52}${infer _53}${infer _54}${infer _55}${infer _56}${infer _57}${infer _58}${infer Rest}`
      ? `0000000000000000000000000000000000000000000000000000000000${Rest}`
      : b

  export type I64Shl<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    ShiftLeftBinary64<a, Low6<b>, '0'>
  >

  export type I64ShrU<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    ShiftRightBinary64<a, Low6<b>, false>
  >

  export type I64ShrS<
    /** value to shift */
    a extends WasmValue,
    /** amount to shift by */
    b extends WasmValue
  > = Satisfies<WasmValue,
    ShiftRightBinary64<a, Low6<b>, true>
  >

  export type I64ExtendI32U<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I64ExtendI32UBinary64<a>
  >

  export type I64ExtendI32S<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I64ExtendI32SBinary64<a>
  >

  export type I32Extend16S<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I32Extend16SBinary32<a>
  >

  export type I32Clz<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I32ClzBinary<a>
  >

  export type I64Clz<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I64ClzBinary64<a>
  >

  export type I32Ctz<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I32CtzBinary<a>
  >

  export type I64Ctz<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I64CtzBinary64<a>
  >

  export type I32Popcnt<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I32PopcntBinary<a>
  >

  export type I64Popcnt<
    a extends WasmValue
  > = Satisfies<WasmValue,
    I64PopcntBinary64<a>
  >

  export type I32WrapI64<
    a extends WasmValue
  > = Satisfies<WasmValue,
    WrapBinary<a>
  >

  /// The rotate count only ever uses its low bits, so instead of converting a
  /// masked value into a number and counting down to it, these pull the low 5
  /// (or 6) characters straight out of the bit string and hand them to the
  /// table-driven ladder: no numeric conversion, no per-step recursion.
  type Tail5<b extends string> =
    b extends `${infer _1}${infer _2}${infer _3}${infer _4}${infer _5}${infer _6}${infer _7}${infer _8}${infer _9}${infer _10}${infer _11}${infer _12}${infer _13}${infer _14}${infer _15}${infer _16}${infer _17}${infer _18}${infer _19}${infer _20}${infer _21}${infer _22}${infer _23}${infer _24}${infer _25}${infer _26}${infer _27}${infer Rest}` ? Rest : never

  type Tail6<b extends string> =
    b extends `${infer _1}${infer _2}${infer _3}${infer _4}${infer _5}${infer _6}${infer _7}${infer _8}${infer _9}${infer _10}${infer _11}${infer _12}${infer _13}${infer _14}${infer _15}${infer _16}${infer _17}${infer _18}${infer _19}${infer _20}${infer _21}${infer _22}${infer _23}${infer _24}${infer _25}${infer _26}${infer _27}${infer _28}${infer _29}${infer _30}${infer _31}${infer _32}${infer _33}${infer _34}${infer _35}${infer _36}${infer _37}${infer _38}${infer _39}${infer _40}${infer _41}${infer _42}${infer _43}${infer _44}${infer _45}${infer _46}${infer _47}${infer _48}${infer _49}${infer _50}${infer _51}${infer _52}${infer _53}${infer _54}${infer _55}${infer _56}${infer _57}${infer _58}${infer Rest}` ? Rest : never

  export type I32Rotl<
    a extends WasmValue,
    shiftBy extends WasmValue
  > = Satisfies<WasmValue,
    Rotl32Bits<a, Tail5<shiftBy>>
  >

  /// `i32.rotr` had no implementation at all: the compiler emitted
  /// `Wasm.I32Rotr` (src/aot_cfg.rs, I32Rotr => env.binary(..)) and nothing
  /// here declared it, so any module using it failed to resolve rather than
  /// giving a wrong answer. Rotating right by n is rotating left by 32-n, with
  /// n=0 staying a no-op; the negation is a table lookup, not a subtraction.
  export type I32Rotr<
    a extends WasmValue,
    shiftBy extends WasmValue
  > = Satisfies<WasmValue,
    Rotr32Bits<a, Tail5<shiftBy>>
  >

  /// i64 rotates mask their count to 6 bits, the same way the i64 shifts do.
  /// Unmasked, the old counting implementation walked up to the raw operand, so
  /// a rotate by 65 or by a negative count never matched its terminating
  /// condition and the whole operation resolved to `never`.
  export type I64Rotl<
    a extends WasmValue,
    shiftBy extends WasmValue
  > = Satisfies<WasmValue,
    Rotl64Bits<a, Tail6<shiftBy>>
  >

  /// `i64.rotr` had no implementation, the same gap `i32.rotr` had: the
  /// interpreter emitted a RotateRight instruction that fell through to
  /// `State.unimplemented`.
  export type I64Rotr<
    a extends WasmValue,
    shiftBy extends WasmValue
  > = Satisfies<WasmValue,
    Rotr64Bits<a, Tail6<shiftBy>>
  >

  export type I32DivS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    DivideSignedBinary32<a, b>['quotient']
  >

  export type I32DivU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    DivideUnsignedBinary32<a, b>['quotient']
  >

  export type I64DivS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    DivideSignedBinary64<a, b>['quotient']
  >

  export type I64DivU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    DivideUnsignedBinary64<a, b>['quotient']
  >

  export type I32RemS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    DivideSignedBinary32<a, b>['remainder']
  >

  export type I32RemU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    DivideUnsignedBinary32<a, b>['remainder']
  >

  export type I64RemS<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    DivideSignedBinary64<a, b>['remainder']
  >

  export type I64RemU<
    a extends WasmValue,
    b extends WasmValue
  > = Satisfies<WasmValue,
    DivideUnsignedBinary64<a, b>['remainder']
  >

}
