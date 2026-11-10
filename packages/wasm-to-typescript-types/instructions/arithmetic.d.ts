import type { ProgramState } from "../types";
import type { State } from '../state';
import { WasmType, WasmValue, Wasm, WasmInt, Satisfies } from "ts-type-math";
export type IAdd = {
    kind: "Add";
    type: WasmType;
};
export type ISubtract = {
    kind: "Subtract";
    type: WasmType;
};
export type IMultiply = {
    kind: "Multiply";
    type: WasmType;
};
export type IDivide = {
    kind: "Divide";
    signed: boolean;
    type: WasmType;
};
export type IRemainder = {
    kind: "Remainder";
    signed: boolean;
    type: WasmInt;
};
export type ArithmeticInstruction = IAdd | ISubtract | IMultiply | IDivide | IRemainder;
export type HandleArithmeticInstructions<instruction extends ArithmeticInstruction, state extends ProgramState> = Satisfies<ProgramState, instruction extends IAdd ? Add<instruction, state> : instruction extends ISubtract ? Subtract<instruction, state> : instruction extends IMultiply ? Multiply<instruction, state> : instruction extends IDivide ? Divide<instruction, state> : instruction extends IRemainder ? Remainder<instruction, state> : State.error<"unknown arithmetic instruction", instruction, state>>;
export type Add<instruction extends IAdd, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer b extends WasmValue,
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? Wasm.I32Add<a, b> : instruction['type'] extends 'i64' ? Wasm.I64Add<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type Subtract<instruction extends ISubtract, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? Wasm.I32Sub<a, b> : instruction['type'] extends 'i64' ? Wasm.I64Sub<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type Multiply<instruction extends IMultiply, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer b extends WasmValue,
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? Wasm.I32Mul<a, b> : instruction['type'] extends 'i64' ? Wasm.I64Mul<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type Divide<instruction extends IDivide, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? instruction['signed'] extends true ? Wasm.I32DivS<a, b> : Wasm.I32DivU<a, b> : instruction['type'] extends 'i64' ? instruction['signed'] extends true ? Wasm.I64DivS<a, b> : Wasm.I64DivU<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type Remainder<instruction extends IRemainder, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? instruction['signed'] extends true ? Wasm.I32RemS<a, b> : Wasm.I32RemU<a, b> : instruction['type'] extends 'i64' ? instruction['signed'] extends true ? Wasm.I64RemS<a, b> : Wasm.I64RemU<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
