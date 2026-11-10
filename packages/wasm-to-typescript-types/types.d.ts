import type { Instruction } from "./instructions/instructions";
import type { WasmType, WasmValue, Wasm } from "ts-type-math";
export type MemoryAddress = WasmValue;
export type MemoryByAddress = Record<MemoryAddress, Wasm.Byte>;
export type BranchId = string;
export type GlobalsById = Record<string, WasmValue>;
export type Param = string;
export type FuncId = string;
export type Func = {
    kind: 'func';
    params: Param[];
    paramsTypes: WasmType[];
    resultTypes: WasmType[];
    locals: string[];
    instructions: Instruction[];
};
export type LocalsById = Record<string, WasmValue>;
export type BranchesById = Record<BranchId, Instruction[]>;
export type FuncsById = Record<FuncId, Func>;
export type GarbageCollection = number;
export type IndirectTable = Record<MemoryAddress, FuncId>;
/** do a memory sweep every 4 kibibytes */
export type SweepL1Every = 1024;
export type StorageBits = 8 | 16 | 32 | 64;
export type ExecutionContext = {
    /** the current local variable values */
    locals: LocalsById;
    /** not really required, but really helpful for debugging */
    funcId: string;
    /**
     * a control flow helper that tells the program how to interpret the next when it hits a branch
     */
    branches: BranchesById;
    /** the size of the stack right before this function is called (but after params are populated) */
    stackDepth: number;
    /** the state of the instruction stack right before this function was called, we will resume from this */
    instructions: Instruction[];
};
/** matches what JS implementations do regarding returning one vs multiple values */
export type Results = (number | bigint)[] | (number | bigint) | null;
export type Count = number;
export type CallHistory = [FuncId, Count];
export type ProgramState = {
    /** the number of instructions we've executed, useful for debugging */
    count: Count;
    /** a stack of values */
    stack: WasmValue[];
    /** the current execution context funcId */
    activeFuncId: string;
    /** the current execution context's stack depth */
    activeStackDepth: number;
    /** the current execution context locals */
    activeLocals: LocalsById;
    /** the currently executing instructions */
    instructions: Instruction[];
    /** the current execution context branches */
    activeBranches: BranchesById;
    /** the L1 cache */
    L1Cache: MemoryByAddress;
    /** the linear memory of the program */
    memory: MemoryByAddress;
    /** a stack of execution contexts */
    executionContexts: ExecutionContext[];
    funcs: FuncsById;
    /** records interval for GarbageCollection */
    garbageCollection: GarbageCollection;
    globals: GlobalsById;
    memorySize: WasmValue;
    /** used for dynamic dispatch: maps directly to funcs */
    indirect: IndirectTable;
    /** the result of the program */
    results: Results;
    /** used for debugging */
    callHistory: CallHistory[];
};
export type ProgramInput = Pick<ProgramState, "memory" | "indirect" | "globals" | "memorySize"> & {
    arguments: number[] | bigint[];
    funcs: FuncsById & {
        $entry: Func;
    };
};
