import type { ProgramState } from "../types";
import type { State } from '../state';
import * as TypeMath from "ts-type-math";
import { WasmValue, WasmInt, Wasm, Satisfies } from "ts-type-math";
export type IAnd = {
    kind: "And";
    type: WasmInt;
};
export type IOr = {
    kind: "Or";
    type: WasmInt;
};
export type IXor = {
    kind: "Xor";
    type: WasmInt;
};
export type IShiftLeft = {
    kind: "ShiftLeft";
    type: WasmInt;
};
export type IShiftRight = {
    kind: "ShiftRight";
    signed: boolean;
    type: WasmInt;
};
export type IRotateLeft = {
    kind: "RotateLeft";
    type: WasmInt;
};
export type IRotateRight = {
    kind: "RotateRight";
    type: WasmInt;
};
export type ICountLeadingZeros = {
    kind: "CountLeadingZeros";
    type: WasmInt;
};
export type ICountTrailingZeros = {
    kind: "CountTrailingZeros";
    type: WasmInt;
};
export type IPopCount = {
    kind: "PopCount";
    type: WasmInt;
};
export type BitwiseInstruction = IAnd | IOr | IXor | IShiftLeft | IShiftRight | IRotateLeft | IRotateRight | ICountLeadingZeros | ICountTrailingZeros | IPopCount;
export type HandleBitwiseInstructions<instruction extends BitwiseInstruction, state extends ProgramState> = Satisfies<ProgramState, instruction extends IAnd ? And<instruction, state> : instruction extends IOr ? Or<instruction, state> : instruction extends IXor ? Xor<instruction, state> : instruction extends IShiftLeft ? ShiftLeft<instruction, state> : instruction extends IShiftRight ? ShiftRight<instruction, state> : instruction extends IRotateLeft ? RotateLeft<instruction, state> : instruction extends IRotateRight ? RotateRight<instruction, state> : instruction extends ICountLeadingZeros ? CountLeadingZeros<instruction, state> : instruction extends ICountTrailingZeros ? CountTrailingZeros<instruction, state> : instruction extends IPopCount ? PopCount<instruction, state> : State.error<"unknown bitwise instruction", instruction, state>>;
type And<instruction extends IAnd, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer b extends WasmValue,
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? TypeMath.Wasm.I32And<a, b> : instruction['type'] extends 'i64' ? TypeMath.Wasm.I64And<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
type Or<instruction extends IOr, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer b extends WasmValue,
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? TypeMath.Wasm.I32Or<a, b> : instruction['type'] extends 'i64' ? TypeMath.Wasm.I64Or<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
type Xor<instruction extends IXor, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer b extends WasmValue,
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? TypeMath.Wasm.I32Xor<a, b> : instruction['type'] extends 'i64' ? TypeMath.Wasm.I64Xor<a, b> : never
], state> : State.error<"stack exhausted", instruction, state>>;
type ShiftLeft<instruction extends IShiftLeft, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? TypeMath.Wasm.I32Shl<a, b> : TypeMath.Wasm.I64Shl<a, b>
], state> : State.error<"stack exhausted", instruction, state>>;
type ShiftRight<instruction extends IShiftRight, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? instruction['signed'] extends true ? TypeMath.Wasm.I32ShrS<a, b> : TypeMath.Wasm.I32ShrU<a, b> : instruction['signed'] extends true ? TypeMath.Wasm.I64ShrS<a, b> : TypeMath.Wasm.I64ShrU<a, b>
], state> : State.error<"stack exhausted", instruction, state>>;
type RotateLeft<instruction extends IRotateLeft, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue,
    infer b extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? Wasm.I32Rotl<a, b> : Wasm.I64Rotl<a, b>
], state> : State.error<"stack exhausted", instruction, state>>;
type RotateRight<instruction extends IRotateRight, state extends ProgramState> = Satisfies<ProgramState, State.unimplemented<instruction, state>>;
type CountLeadingZeros<instruction extends ICountLeadingZeros, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue
] ? State.Stack.set<[
    ...remaining,
    instruction['type'] extends 'i32' ? TypeMath.Wasm.I32Clz<a> : TypeMath.Wasm.I64Clz<a>
], state> : State.error<"stack exhausted", instruction, state>>;
type CountTrailingZeros<instruction extends ICountTrailingZeros, state extends ProgramState> = Satisfies<ProgramState, State.unimplemented<instruction, state>>;
type PopCount<instruction extends IPopCount, state extends ProgramState> = Satisfies<ProgramState, State.unimplemented<instruction, state>>;
export {};
