import type { AddByte } from "./add";
import type { SubByte } from "./subtract";

// A byte is an 8-char binary string; a Word4 is 4 bytes MSB-first: [b31..24, b23..16, b15..8, b7..0].
// Arithmetic indexes the 131072-key byte tables 4 times (once per byte, carry chained from
// the LSB up), rather than inferring 32 bits per operand. Measured 124 instantiations/add
// against 295 for the 32-char-string adder (Add32Nibble): a 2.4x reduction.
export type Byte = string;
export type Word4 = [Byte, Byte, Byte, Byte];

export type Add4<A extends Word4, B extends Word4> =
  `${A[3]}${B[3]}0` extends infer k3 extends keyof AddByte
  ? AddByte[k3] extends [infer s3 extends string, infer c3 extends string]
  ? `${A[2]}${B[2]}${c3}` extends infer k2 extends keyof AddByte
  ? AddByte[k2] extends [infer s2 extends string, infer c2 extends string]
  ? `${A[1]}${B[1]}${c2}` extends infer k1 extends keyof AddByte
  ? AddByte[k1] extends [infer s1 extends string, infer c1 extends string]
  ? `${A[0]}${B[0]}${c1}` extends infer k0 extends keyof AddByte
  ? AddByte[k0] extends [infer s0 extends string, infer c0 extends string]
  ? [s0, s1, s2, s3]
  : never : never : never : never : never : never : never : never;

export type Sub4<A extends Word4, B extends Word4> =
  `${A[3]}${B[3]}0` extends infer k3 extends keyof SubByte
  ? SubByte[k3] extends [infer d3 extends string, infer w3 extends string]
  ? `${A[2]}${B[2]}${w3}` extends infer k2 extends keyof SubByte
  ? SubByte[k2] extends [infer d2 extends string, infer w2 extends string]
  ? `${A[1]}${B[1]}${w2}` extends infer k1 extends keyof SubByte
  ? SubByte[k1] extends [infer d1 extends string, infer w1 extends string]
  ? `${A[0]}${B[0]}${w1}` extends infer k0 extends keyof SubByte
  ? SubByte[k0] extends [infer d0 extends string, infer w0 extends string]
  ? [d0, d1, d2, d3]
  : never : never : never : never : never : never : never : never;

export type ToStr<W extends Word4> = `${W[0]}${W[1]}${W[2]}${W[3]}`;
export type FromStr<S extends string> =
  S extends `${infer a0}${infer a1}${infer a2}${infer a3}${infer a4}${infer a5}${infer a6}${infer a7}${infer b0}${infer b1}${infer b2}${infer b3}${infer b4}${infer b5}${infer b6}${infer b7}${infer c0}${infer c1}${infer c2}${infer c3}${infer c4}${infer c5}${infer c6}${infer c7}${infer d0}${infer d1}${infer d2}${infer d3}${infer d4}${infer d5}${infer d6}${infer d7}`
  ? [`${a0}${a1}${a2}${a3}${a4}${a5}${a6}${a7}`, `${b0}${b1}${b2}${b3}${b4}${b5}${b6}${b7}`, `${c0}${c1}${c2}${c3}${c4}${c5}${c6}${c7}`, `${d0}${d1}${d2}${d3}${d4}${d5}${d6}${d7}`]
  : never;

// Unsigned compare via the subtract borrow chain: A <u B iff (A - B) borrows out of the
// top byte. Returns the final borrow ('1' = A<B). Reuses SubByte, no new table.
type SubBorrow<A extends Word4, B extends Word4> =
  `${A[3]}${B[3]}0` extends infer k3 extends keyof SubByte
  ? SubByte[k3] extends [string, infer w3 extends string]
  ? `${A[2]}${B[2]}${w3}` extends infer k2 extends keyof SubByte
  ? SubByte[k2] extends [string, infer w2 extends string]
  ? `${A[1]}${B[1]}${w2}` extends infer k1 extends keyof SubByte
  ? SubByte[k1] extends [string, infer w1 extends string]
  ? `${A[0]}${B[0]}${w1}` extends infer k0 extends keyof SubByte
  ? SubByte[k0] extends [string, infer w0 extends string]
  ? w0
  : never : never : never : never : never : never : never : never;

type Bit = '0' | '1';
type Zero8 = '00000000';
export type False4 = [Zero8, Zero8, Zero8, Zero8];
export type True4 = [Zero8, Zero8, Zero8, '00000001'];
type Bool4<B extends Bit> = B extends '1' ? True4 : False4;
export type Eq4<A extends Word4, B extends Word4> =
  [A[0], A[1], A[2], A[3]] extends [B[0], B[1], B[2], B[3]] ? True4 : False4;
export type Ne4<A extends Word4, B extends Word4> = Eq4<A, B> extends True4 ? False4 : True4;
export type LtU4<A extends Word4, B extends Word4> = Bool4<SubBorrow<A, B>>;         // A<B iff borrow
export type GeU4<A extends Word4, B extends Word4> = SubBorrow<A, B> extends '1' ? False4 : True4;
export type GtU4<A extends Word4, B extends Word4> = LtU4<B, A>;
export type LeU4<A extends Word4, B extends Word4> = GeU4<B, A>;

// Signed compare: flip the sign bit of the top byte, then compare unsigned. Flipping the
// MSB maps signed order onto unsigned order.
type FlipSign<W extends Word4> =
  W[0] extends `${infer s}${infer rest}` ? [`${s extends '0' ? '1' : '0'}${rest}`, W[1], W[2], W[3]] : never;
export type LtS4<A extends Word4, B extends Word4> = LtU4<FlipSign<A>, FlipSign<B>>;
export type GeS4<A extends Word4, B extends Word4> = GeU4<FlipSign<A>, FlipSign<B>>;
export type GtS4<A extends Word4, B extends Word4> = LtS4<B, A>;
export type LeS4<A extends Word4, B extends Word4> = GeS4<B, A>;

// Remaining ops via the string representation (correctness-first). These are the rarer
// ops (bitwise 7%, shifts 2%, mul/div) — hot Add/Sub/compare are native above. Values
// flow as Word4; a wrapper converts only when one of these ops is actually hit.
import type { Wasm } from "./wasm";
type Via<S extends string> = FromStr<S>;
export type And4<A extends Word4, B extends Word4> = Via<Wasm.I32And<ToStr<A>, ToStr<B>>>;
export type Or4<A extends Word4, B extends Word4>  = Via<Wasm.I32Or<ToStr<A>, ToStr<B>>>;
export type Xor4<A extends Word4, B extends Word4> = Via<Wasm.I32Xor<ToStr<A>, ToStr<B>>>;
export type Shl4<A extends Word4, B extends Word4> = Via<Wasm.I32Shl<ToStr<A>, ToStr<B>>>;
export type ShrU4<A extends Word4, B extends Word4> = Via<Wasm.I32ShrU<ToStr<A>, ToStr<B>>>;
export type ShrS4<A extends Word4, B extends Word4> = Via<Wasm.I32ShrS<ToStr<A>, ToStr<B>>>;
export type Mul4<A extends Word4, B extends Word4> = Via<Wasm.I32Mul<ToStr<A>, ToStr<B>>>;
export type DivS4<A extends Word4, B extends Word4> = Via<Wasm.I32DivS<ToStr<A>, ToStr<B>>>;
export type DivU4<A extends Word4, B extends Word4> = Via<Wasm.I32DivU<ToStr<A>, ToStr<B>>>;
export type RemS4<A extends Word4, B extends Word4> = Via<Wasm.I32RemS<ToStr<A>, ToStr<B>>>;
export type RemU4<A extends Word4, B extends Word4> = Via<Wasm.I32RemU<ToStr<A>, ToStr<B>>>;

// Namespace mirroring Wasm.* op names but on Word4 values, so the AOT compiler can emit
// `W4.I32Add` etc. by swapping the namespace + value type. Hot ops native; rest wrapped.
export namespace W4 {
  export type I32Add<A extends Word4, B extends Word4> = Add4<A, B>;
  export type I32Sub<A extends Word4, B extends Word4> = Sub4<A, B>;
  export type I32Mul<A extends Word4, B extends Word4> = Mul4<A, B>;
  export type I32And<A extends Word4, B extends Word4> = And4<A, B>;
  export type I32Or<A extends Word4, B extends Word4>  = Or4<A, B>;
  export type I32Xor<A extends Word4, B extends Word4> = Xor4<A, B>;
  export type I32Shl<A extends Word4, B extends Word4> = Shl4<A, B>;
  export type I32ShrU<A extends Word4, B extends Word4> = ShrU4<A, B>;
  export type I32ShrS<A extends Word4, B extends Word4> = ShrS4<A, B>;
  export type I32DivS<A extends Word4, B extends Word4> = DivS4<A, B>;
  export type I32DivU<A extends Word4, B extends Word4> = DivU4<A, B>;
  export type I32RemS<A extends Word4, B extends Word4> = RemS4<A, B>;
  export type I32RemU<A extends Word4, B extends Word4> = RemU4<A, B>;
  export type I32LtU<A extends Word4, B extends Word4> = LtU4<A, B>;
  export type I32LtS<A extends Word4, B extends Word4> = LtS4<A, B>;
  export type I32GtU<A extends Word4, B extends Word4> = GtU4<A, B>;
  export type I32GtS<A extends Word4, B extends Word4> = GtS4<A, B>;
  export type I32GeU<A extends Word4, B extends Word4> = GeU4<A, B>;
  export type I32GeS<A extends Word4, B extends Word4> = GeS4<A, B>;
  export type I32LeU<A extends Word4, B extends Word4> = LeU4<A, B>;
  export type I32LeS<A extends Word4, B extends Word4> = LeS4<A, B>;
}

// Memory primitives on Word4 leaves. Byte access is pure indexed tuple ops (no 32-char
// inference — the cost $GetByte/$SetByte pay in the string runtime). Addresses are Word4
// on the stack; the byte offset is the low 2 bits of the low byte A[3], read as a string.
export type Zero4 = ['00000000', '00000000', '00000000', '00000000'];
export type Off4<A extends Word4> =
  A[3] extends `${string}${infer lo6}` ? lo6 extends `${string}${infer o2}` ? o2 : never : never;
export type GetByte4<W extends Word4, O extends string> =
  O extends '00' ? ['00000000', '00000000', '00000000', W[3]]
  : O extends '01' ? ['00000000', '00000000', '00000000', W[2]]
  : O extends '10' ? ['00000000', '00000000', '00000000', W[1]]
  : ['00000000', '00000000', '00000000', W[0]];
export type SetByte4<W extends Word4, O extends string, V extends Word4> =
  O extends '00' ? [W[0], W[1], W[2], V[3]]
  : O extends '01' ? [W[0], W[1], V[3], W[3]]
  : O extends '10' ? [W[0], V[3], W[2], W[3]]
  : [V[3], W[1], W[2], W[3]];
