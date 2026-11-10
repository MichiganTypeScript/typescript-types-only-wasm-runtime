# Word4 codegen recipe (validated)

Byte-tuple value representation `Word4 = [Byte,Byte,Byte,Byte]` replaces the 32-char
string `WasmValue`. Validated end-to-end: the generated `memory-offset` module,
transformed by this recipe, passes all 4 conformance cases (store@0/4/8 → load →
sub → add), bit-exact. See `packages/ts-type-math/word4.ts` for the op library.

Why: 82.8% of per-frame type instantiations are the per-bit template inference a
32-char string forces on arithmetic (`$b0..$b31`) and byte access (`$GetByte`/
`$SetByte` match a 32-char word). Byte-tuple makes byte/arith access indexed, not
inferred: measured 2.4x fewer instantiations per add.

## The transform the AOT compiler must emit (each step validated on memory-offset)

1. **Import**: `import type { Word4, Word4 as WasmValue, W4 as Wasm, ToStr, FromStr,
   GetByte4, SetByte4, Off4, Zero4 } from 'ts-type-math/word4'`. Aliasing WasmValue→Word4
   and Wasm→W4 converts all 62 `extends WasmValue` signature sites and every `Wasm.I32*`
   op name for free — no per-site edits.
2. **Literals**: every 32-char value literal `'bbbb…'` → `['b0-7','b8-15','b16-23','b24-31']`.
   (Block markers/fuel strings stay strings — they are not 32-char values.)
3. **Leaf/word**: `$Word<T> = T extends [infer W] ? W : Zero4`.
4. **Bytes**: `$GetByte`/`$SetByte`/`$Off` → the validated `GetByte4`/`SetByte4`/`Off4`.
5. **Address**: `$Slice`/`$Split` take Word4, `ToStr` internally; `$Load32`/`$Store32`
   aligned check on `ToStr<A>`.
6. **Unconstrain**: `$Fetch`/`$Under`/`$Get` — the fetched word is `Word4 | 'u' | 'x'`,
   so drop the `extends string` on `infer W`.
7. **$ToNumber**: convert via `ToStr` before `Convert.WasmValue.ToTSNumber`.
8. **Trampoline**: constrain `$Enter*`'s `$V` return param to `WasmValue`.
9. **64-bit** (`$Hi32`/`$Lo32`/`$Load64`/`$Store64`): a 64-bit value is two Word4s;
   doom uses I64 rarely — port or wrap via string.

The trie navigation ($Get/$Put/$Sel/$Set/$BSel/$BSet/$MergeAt/$Flush/$Buf/$Fetch/
$Under/$Node8/$DIdx/$DHi/$DLo) is generic over the leaf value and needs no change
beyond (3)/(5)/(6).
