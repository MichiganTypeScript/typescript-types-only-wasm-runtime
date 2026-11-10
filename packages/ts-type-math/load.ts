import { Add32Nibble } from "./add";
import { WasmValue, Wasm } from "./wasm";
import type { Satisfies } from './utils'

type FalseByte = '00000000';

export namespace Load {
  /**
   * this function will use a fallback if the resulting value is equal to any or unknown
   * 
   * specifically, this is useful for when you're reading from memory and you want to use a fallback value if the memory is uninitialized.
   */
  export type IsUnknownOrAnyFallback<T, Fallback> = unknown extends T ? Fallback : T

  export type Read1Byte<
    /** L1 Cache memory to read from first */
    L1Cache extends Record<WasmValue, Wasm.Byte>,

    /** memory object to read from */
    memory extends Record<WasmValue, Wasm.Byte>,
  
    address extends WasmValue,

    _b0 extends string = memory[address]
  > =
    address extends keyof L1Cache
    ? L1Cache[address]
    : address extends keyof memory
      ? memory[address]
      : FalseByte
  
  export type Read2Bytes<
    /** L1 Cache memory to read from first */
    L1Cache extends Record<WasmValue, Wasm.Byte>,
    
    /** memory object to read from */
    memory extends Record<WasmValue, Wasm.Byte>,

    address extends WasmValue,

    // WARNING using AddBinary here is dangerous because it can overflow past I32 but the other (safer) option is to use Wasm.I32Add which does a Clamp, which is very expensive.
    // this is such an incredibly hot path for memory management that if we actually overflow here.. well.. that's gonna be a rough debugging day.  just gonna have to hope that doesn't happen.
    _b1 extends string = memory[Add32Nibble<address, '00000000000000000000000000000001'>],
    _b0 extends string = memory[address],
  > =
    `${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000001'>>
    }${
      Read1Byte<L1Cache, memory, address>
    }`
  
  export type Read4Bytes<
    /** L1 Cache memory to read from first */
    L1Cache extends Record<WasmValue, Wasm.Byte>,

    /** memory object to read from */
    memory extends Record<WasmValue, Wasm.Byte>,
  
    // WARNING using AddBinary here is dangerous because it can overflow past I32 but the other (safer) option is to use Wasm.I32Add which does a Clamp, which is very expensive.
    // this is such an incredibly hot path for memory management that if we actually overflow here.. well.. that's gonna be a rough debugging day.  just gonna have to hope that doesn't happen.
    address extends WasmValue,
  > =
    `${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000011'>>
    }${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000010'>>
    }${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000001'>>
    }${
      Read1Byte<L1Cache, memory, address>
    }`
  
  export type Read8Bytes<
    /** L1 Cache memory to read from first */
    L1Cache extends Record<WasmValue, Wasm.Byte>,

    /** memory object to read from */
    memory extends Record<WasmValue, Wasm.Byte>,
  
    // WARNING using AddBinary here is dangerous because it can overflow past I32 but the other (safer) option is to use Wasm.I32Add which does a Clamp, which is very expensive.
    // this is such an incredibly hot path for memory management that if we actually overflow here.. well.. that's gonna be a rough debugging day.  just gonna have to hope that doesn't happen.
    address extends WasmValue,
  > =
    `${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000111'>>
    }${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000110'>>
    }${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000101'>>
    }${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000100'>>
    }${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000011'>>
    }${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000010'>>
    }${
      Read1Byte<L1Cache, memory, Add32Nibble<address, '00000000000000000000000000000001'>>
    }${
      Read1Byte<L1Cache, memory, address>
    }`


  export type JoinBytes<
    T extends Wasm.Byte[],

    Acc extends WasmValue = ''
  > = Satisfies<WasmValue,
    T extends [
      infer byte extends Wasm.Byte,
      ...infer Tail extends Wasm.Byte[],
    ]
    ? JoinBytes<Tail, `${Acc}${byte & Wasm.Byte}`>
    : Acc
  >
}
