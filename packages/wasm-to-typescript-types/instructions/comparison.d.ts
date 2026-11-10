import type { ProgramState } from "../types";
import type { State } from '../state';
import { WasmValue, WasmType, Wasm, Satisfies } from "ts-type-math";
export type IEqualsZero = {
    kind: "EqualsZero";
    type: WasmType;
};
export type IEquals = {
    kind: "Equals";
    type: WasmType;
};
export type INotEqual = {
    kind: "NotEqual";
    type: WasmType;
};
export type IGreaterThan = {
    kind: "GreaterThan";
    type: WasmType;
    signed: boolean;
};
export type ILessThan = {
    kind: "LessThan";
    type: WasmType;
    signed: boolean;
};
export type IGreaterThanOrEqual = {
    kind: "GreaterThanOrEqual";
    type: WasmType;
    signed: boolean;
};
export type ILessThanOrEqual = {
    kind: "LessThanOrEqual";
    type: WasmType;
    signed: boolean;
};
export type ComparisonInstruction = IEqualsZero | IEquals | INotEqual | IGreaterThan | ILessThan | IGreaterThanOrEqual | ILessThanOrEqual;
export type HandleComparisonInstruction<instruction extends ComparisonInstruction, state extends ProgramState> = Satisfies<ProgramState, instruction extends IEquals ? Equals<instruction, state> : instruction extends IEqualsZero ? EqualsZero<instruction, state> : instruction extends INotEqual ? NotEqual<instruction, state> : instruction extends IGreaterThan ? GreaterThan<instruction, state> : instruction extends ILessThan ? LessThan<instruction, state> : instruction extends IGreaterThanOrEqual ? GreaterThanOrEqual<instruction, state> : instruction extends ILessThanOrEqual ? LessThanOrEqual<instruction, state> : State.error<"unknown comparison instruction", instruction, state>>;
export type EqualsZero<instruction extends IEqualsZero, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? Wasm.I32Eqz<a> : instruction['type'] extends 'i64' ? Wasm.I64Eqz<a> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type Equals<instruction extends IEquals, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer b extends WasmValue,
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? Wasm.I32Eq<a, b> : instruction['type'] extends 'i64' ? Wasm.I64Eq<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type NotEqual<instruction extends INotEqual, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer b extends WasmValue,
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? Wasm.I32Neq<a, b> : instruction['type'] extends 'i64' ? Wasm.I64Neq<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type GreaterThan<instruction extends IGreaterThan, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? instruction['signed'] extends true ? Wasm.I32GtS<a, b> : Wasm.I32GtU<a, b> : instruction['type'] extends 'i64' ? instruction['signed'] extends true ? Wasm.I64GtS<a, b> : Wasm.I64GtU<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type LessThan<instruction extends ILessThan, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? instruction['signed'] extends true ? Wasm.I32LtS<a, b> : Wasm.I32LtU<a, b> : instruction['type'] extends 'i64' ? instruction['signed'] extends true ? Wasm.I64LtS<a, b> : Wasm.I64LtU<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type GreaterThanOrEqual<instruction extends IGreaterThanOrEqual, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? instruction['signed'] extends true ? Wasm.I32GeS<a, b> : Wasm.I32GeU<a, b> : instruction['type'] extends 'i64' ? instruction['signed'] extends true ? Wasm.I64GeS<a, b> : Wasm.I64GeU<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
export type LessThanOrEqual<instruction extends ILessThanOrEqual, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? instruction['signed'] extends true ? Wasm.I32LeS<a, b> : Wasm.I32LeU<a, b> : instruction['type'] extends 'i64' ? instruction['signed'] extends true ? Wasm.I64LeS<a, b> : Wasm.I64LeU<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
