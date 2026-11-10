import { I32AddBinary } from "../ts-type-math/add";
import type { Instruction } from "./instructions/instructions";
import { IEndFunction } from "./instructions/synthetic";
import type { SweepL1Every, ExecutionContext, GlobalsById, MemoryAddress, ProgramState, FuncId } from "./types";
import * as TypeMath from "ts-type-math";
import { WasmValue, WasmType, Convert, Wasm, evaluate, Satisfies } from 'ts-type-math';
/** update Source with Update */
export type Patch<Source, Update> = evaluate<Omit<Source, keyof Update> & Update>;
export type IDugMyselfANiceBigHoleAndNowIHaveToDebugMyWayOutOfItSomehow = false;
export declare namespace State {
    type error<reason extends string, instruction extends Instruction, state extends ProgramState> = Satisfies<ProgramState, State.Instructions.unshift<{
        kind: 'Halt';
        reason: `ERROR(${state['count']}): ${reason}`;
        instruction: instruction;
    }, state>>;
    type debug<stuff extends any, state extends ProgramState> = Satisfies<ProgramState, State.Instructions.unshift<{
        kind: "Halt";
        stuff: stuff;
    }, state>>;
    type unimplemented<instruction extends Instruction, state extends ProgramState> = Satisfies<ProgramState, State.Instructions.unshift<{
        kind: 'Halt';
        reason: "Unimplemented Instruction";
        instruction: instruction;
    }, state>>;
    namespace CallHistory {
        type record<funcId extends FuncId, state extends ProgramState> = Satisfies<ProgramState, IDugMyselfANiceBigHoleAndNowIHaveToDebugMyWayOutOfItSomehow extends true ? {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'] extends [] ? [
                [
                    funcId,
                    state['count']
                ]
            ] : [
                ...state['callHistory'],
                [
                    funcId,
                    state['count']
                ]
            ];
        } : state>;
    }
    namespace Count {
        type increment<state extends ProgramState> = Satisfies<ProgramState, {
            count: TypeMath.Add<state['count'], 1>;
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        }>;
    }
    /** Helpers for Instruction manipulation */
    namespace Instructions {
        type set<instructions extends Instruction[], state extends ProgramState> = Satisfies<ProgramState, {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: instructions;
            activeBranches: state['activeBranches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        }>;
        type concat<instructions extends Instruction[], state extends ProgramState> = Satisfies<ProgramState, set<[
            ...instructions,
            ...state['instructions']
        ], state>>;
        type push<instruction extends Instruction, state extends ProgramState> = Satisfies<ProgramState, set<[
            ...state['instructions'],
            instruction
        ], state>>;
        type unshift<instruction extends Instruction, state extends ProgramState> = Satisfies<ProgramState, set<[
            instruction,
            ...state['instructions']
        ], state>>;
    }
    /** Helpers for Stack manipulation */
    namespace Stack {
        type set<stack extends WasmValue[], state extends ProgramState> = Satisfies<ProgramState, {
            count: state['count'];
            stack: stack;
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        }>;
        type push<value extends WasmValue, state extends ProgramState> = Satisfies<ProgramState, set<[
            ...state['stack'],
            value
        ], state>>;
    }
    /** Helpers for ExecutionContext manipulation */
    namespace ExecutionContexts {
        /** push a brand new execution context */
        type push<executionContext extends ExecutionContext, newInstructions extends Instruction[], state extends ProgramState> = Satisfies<ProgramState, {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: executionContext['funcId'];
            activeStackDepth: executionContext['stackDepth'];
            activeLocals: executionContext['locals'];
            instructions: newInstructions;
            activeBranches: executionContext['branches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: [
                ...state['executionContexts'],
                {
                    locals: state['activeLocals'];
                    funcId: state['activeFuncId'];
                    branches: state['activeBranches'];
                    stackDepth: state['activeStackDepth'];
                    instructions: state['instructions'];
                }
            ];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        }>;
        /** pop a brand new execution context */
        type pop<state extends ProgramState> = Satisfies<ProgramState, state['executionContexts'] extends [
            ...infer remaining extends ExecutionContext[],
            infer active extends ExecutionContext
        ] ? {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: active['funcId'];
            activeStackDepth: active['stackDepth'];
            activeLocals: active['locals'];
            instructions: active['instructions'];
            activeBranches: active['branches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: remaining;
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        } : state['instructions'] extends IEndFunction[] ? {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: 'hope you found what you were looking for';
            activeStackDepth: 1337;
            activeLocals: {};
            instructions: state['instructions'];
            activeBranches: {};
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: [];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        } : State.error<"execution contexts exhausted", Instruction, state>>;
        namespace Active {
            namespace Locals {
                type insert<id extends string, value extends WasmValue, state extends ProgramState> = Satisfies<ProgramState, {
                    count: state['count'];
                    stack: state['stack'];
                    activeFuncId: state['activeFuncId'];
                    activeStackDepth: state['activeStackDepth'];
                    activeLocals: Patch<state['activeLocals'], {
                        [k in id]: value;
                    }>;
                    instructions: state['instructions'];
                    activeBranches: state['activeBranches'];
                    L1Cache: state['L1Cache'];
                    memory: state['memory'];
                    executionContexts: state['executionContexts'];
                    funcs: state['funcs'];
                    garbageCollection: state['garbageCollection'];
                    globals: state['globals'];
                    memorySize: state['memorySize'];
                    indirect: state['indirect'];
                    results: state['results'];
                    callHistory: state['callHistory'];
                }>;
            }
            namespace Branches {
                type insert<id extends string, instructions extends Instruction[], state extends ProgramState> = Satisfies<ProgramState, {
                    count: state['count'];
                    stack: state['stack'];
                    activeFuncId: state['activeFuncId'];
                    activeStackDepth: state['activeStackDepth'];
                    activeLocals: state['activeLocals'];
                    instructions: state['instructions'];
                    activeBranches: Patch<state['activeBranches'], {
                        [k in id]: instructions;
                    }>;
                    L1Cache: state['L1Cache'];
                    memory: state['memory'];
                    executionContexts: state['executionContexts'];
                    funcs: state['funcs'];
                    garbageCollection: state['garbageCollection'];
                    globals: state['globals'];
                    memorySize: state['memorySize'];
                    indirect: state['indirect'];
                    results: state['results'];
                    callHistory: state['callHistory'];
                }>;
            }
        }
    }
    /** Helpers for Globals manipulation */
    namespace Globals {
        type insert<globals extends GlobalsById, state extends ProgramState> = Satisfies<ProgramState, {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: Patch<state['globals'], globals>;
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        }>;
    }
    namespace Memory {
        type CollectBytes<address extends WasmValue, bytes extends Wasm.Byte[], _Acc extends Record<WasmValue, Wasm.Byte> = {}> = Satisfies<Record<WasmValue, Wasm.Byte>, bytes extends [
            ...infer tail extends Wasm.Byte[],
            infer head extends Wasm.Byte
        ] ? CollectBytes<I32AddBinary<address, Wasm.I32True>, tail, _Acc & {
            [k in address]: head;
        }> : _Acc>;
        export type insert<address extends MemoryAddress, bytes extends Wasm.Byte[], state extends ProgramState, _update extends Record<WasmValue, Wasm.Byte> = CollectBytes<address, bytes>> = Satisfies<ProgramState, {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: Patch<state['L1Cache'], _update>;
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        }>;
        export type grow<state extends ProgramState, growBy extends WasmValue> = Satisfies<ProgramState, {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: I32AddBinary<state['memorySize'], growBy>;
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        }>;
        export {};
    }
    namespace GarbageCollection {
        type increment<state extends ProgramState> = Satisfies<ProgramState, {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: TypeMath.Add<state['garbageCollection'], 1>;
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        }>;
        type collect<state extends ProgramState, force extends 'force' | 'schedule' = 'schedule', _shoudlCollect extends boolean = force extends 'force' ? true : state['garbageCollection'] extends SweepL1Every ? true : false> = Satisfies<ProgramState, _shoudlCollect extends true ? {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: {};
            memory: TypeMath.GarbageCollect<Patch<state['memory'], state['L1Cache']>>;
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: 0;
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: state['results'];
            callHistory: state['callHistory'];
        } : state>;
    }
    namespace Result {
        export type getResultTypes<state extends ProgramState> = Satisfies<WasmType[], state['funcs']['$entry']['resultTypes']>;
        type WasmTypeToTSNumber<type extends WasmType, value extends WasmValue> = type extends 'i32' | 'f32' | 'f64' ? Convert.WasmValue.ToTSNumber<value, type> : Convert.WasmValue.ToTSBigInt<value>;
        type CollectResults<stack extends WasmValue[], resultTypes extends WasmType[], _Acc extends (number | bigint)[] = []> = Satisfies<(number | bigint)[], stack extends [
            infer pop extends WasmValue,
            ...infer remainingStack extends WasmValue[]
        ] ? resultTypes extends [
            infer type extends WasmType,
            ...infer remainingTypes extends WasmType[]
        ] ? CollectResults<remainingStack, remainingTypes, [
            ..._Acc,
            WasmTypeToTSNumber<type, pop>
        ]> : never : _Acc>;
        export type set<state extends ProgramState, _resultTypes extends WasmType[] = getResultTypes<state>> = Satisfies<ProgramState, {
            count: state['count'];
            stack: state['stack'];
            activeFuncId: state['activeFuncId'];
            activeStackDepth: state['activeStackDepth'];
            activeLocals: state['activeLocals'];
            instructions: state['instructions'];
            activeBranches: state['activeBranches'];
            L1Cache: state['L1Cache'];
            memory: state['memory'];
            executionContexts: state['executionContexts'];
            funcs: state['funcs'];
            garbageCollection: state['garbageCollection'];
            globals: state['globals'];
            memorySize: state['memorySize'];
            indirect: state['indirect'];
            results: _resultTypes['length'] extends 1 ? WasmTypeToTSNumber<_resultTypes[0], state['stack'][0]> : CollectResults<state['stack'], _resultTypes>;
            callHistory: state['callHistory'];
        }>;
        export type finish<state extends ProgramState> = Satisfies<(number | bigint)[] | (number | bigint) | null, set<State.GarbageCollection.collect<state, 'force'>>['results']>;
        export {};
    }
}
