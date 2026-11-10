import type { ProgramState } from "../types";
import type { State } from '../state';
import type { WasmValue, Satisfies } from 'ts-type-math';
export type IConst = {
    kind: "Const";
    /** a constant value */
    value: WasmValue;
};
export type ConstInstruction = IConst;
export type Const<instruction extends IConst, state extends ProgramState> = Satisfies<ProgramState, State.Stack.push<instruction['value'], state>>;
export type HandleConstInstruction<instruction extends ConstInstruction, state extends ProgramState> = Satisfies<ProgramState, instruction extends IConst ? Const<instruction, state> : State.error<"unknown const instruction", instruction, state>>;
