import type { ProgramState } from "../types";
import type { State } from '../state';
import type { WasmValue, Satisfies, Wasm, Load } from "ts-type-math";
export type ILocalGet = {
    kind: "LocalGet";
    /** a local identifier */
    id: string;
};
export type ILocalSet = {
    kind: "LocalSet";
    /** a local identifier */
    id: string;
};
export type ILocalTee = {
    kind: "LocalTee";
    /** a local identifier */
    id: string;
};
export type IGlobalGet = {
    kind: "GlobalGet";
    /** a local identifier */
    id: string;
};
export type IGlobalSet = {
    kind: "GlobalSet";
    /** a local identifier */
    id: string;
};
export type VariableInstruction = ILocalGet | ILocalSet | ILocalTee | IGlobalGet | IGlobalSet;
export type HandleVariableInstructions<instruction extends VariableInstruction, state extends ProgramState> = Satisfies<ProgramState, instruction extends ILocalGet ? LocalGet<instruction, state> : instruction extends ILocalSet ? LocalSet<instruction, state> : instruction extends ILocalTee ? LocalTee<instruction, state> : instruction extends IGlobalGet ? GlobalGet<instruction, state> : instruction extends IGlobalSet ? GlobalSet<instruction, state> : State.error<"unknown variable instruction", instruction, state>>;
export type LocalGet<instruction extends ILocalGet, state extends ProgramState> = Satisfies<ProgramState, State.Stack.push<Load.IsUnknownOrAnyFallback<// the behavior of wasm
state['activeLocals'][instruction['id']], Wasm.I32False>, state>>;
export type LocalSet<instruction extends ILocalSet, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer value extends WasmValue
] ? State.Stack.set<remaining, State.ExecutionContexts.Active.Locals.insert<instruction['id'], value, state>> : State.error<"stack exhausted", instruction, state>>;
export type LocalTee<instruction extends ILocalTee, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer entry extends WasmValue
] ? State.ExecutionContexts.Active.Locals.insert<instruction['id'], entry, state> : State.error<"stack exhausted", instruction, state>>;
export type GlobalGet<instruction extends IGlobalGet, state extends ProgramState> = Satisfies<ProgramState, State.Stack.push<state['globals'][instruction['id']], // webassaembly mandates that globals are always initialized
state>>;
export type GlobalSet<instruction extends IGlobalSet, state extends ProgramState> = Satisfies<ProgramState, state['stack'] extends [
    ...infer remaining extends WasmValue[],
    infer a extends WasmValue
] ? State.Stack.set<remaining, State.Globals.insert<Record<instruction['id'], a>, state>> : State.error<"stack exhausted", instruction, state>>;
