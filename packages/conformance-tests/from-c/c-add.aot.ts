import type { Wasm, WasmValue, Convert } from 'ts-type-math'

type $unreachable = never

type $entry_impl<$p0 extends WasmValue, $p1 extends WasmValue> =
  Wasm.I32Add<$p0, $p1>

export type entry<Args extends [number, number]> =
  Convert.WasmValue.ToTSNumber<
    $entry_impl<
      Convert.U32Decimal.ToU32Binary<Args[0]>,
      Convert.U32Decimal.ToU32Binary<Args[1]>
    >,
    'i32'
  >
