import type { ProgramState } from "../types";
import type { Instruction } from "./instructions";
import type { State } from '../state';
import type { Satisfies } from 'ts-type-math';
/** this isn't really a webassembly instruction, but it's a sentinel put here so that the program can understand when to cull execution contexts (i.e. after the function returns) */
export type IEndFunction = {
    kind: "EndFunction";
    /** a function identifier */
    id: string;
};
/** a synthetic instruction for repeating the instructions of a loop */
export type IEndLoop = {
    kind: "EndLoop";
    id: string;
    instructions: Instruction[];
};
/** a synthetic instruction for repeating the instructions of a block */
export type IEndBlock = {
    kind: "EndBlock";
    id: string;
};
/** not a webassembly instruction. used for debugging: tells the program to immediately Halt */
export type IHalt = {
    kind: "Halt";
    /** if Halting because of an unrecognized instruction, it's useful to append it here */
    instruction?: Instruction;
    /** an optional reason for the halt */
    reason?: string;
    stuff?: any;
};
export type SyntheticInstruction = IEndFunction | IEndBlock | IEndLoop | IHalt;
export type HandleSyntheticInstructions<instruction extends SyntheticInstruction, state extends ProgramState> = Satisfies<ProgramState, instruction extends IEndLoop ? EndLoop<instruction, state> : instruction extends IEndFunction ? EndFunction<instruction, state> : instruction extends IEndBlock ? EndBlock<instruction, state> : instruction extends IHalt ? Halt<instruction, state> : State.error<"unknown synthetic instruction", instruction, state>>;
export type EndFunction<instruction extends IEndFunction, // unused
state extends ProgramState> = Satisfies<ProgramState, State.ExecutionContexts.pop<state>>;
export type EndLoop<instruction extends IEndLoop, state extends ProgramState> = Satisfies<ProgramState, State.Instructions.set<instruction['instructions'], State.ExecutionContexts.Active.Branches.insert<instruction['id'], [
    {
        kind: "Halt";
        reason: `the ${instruction['id']} loop ended, and thus should not be reachable`;
    }
], state>>>;
export type EndBlock<instruction extends IEndBlock, state extends ProgramState> = Satisfies<ProgramState, State.ExecutionContexts.Active.Branches.insert<instruction['id'], [
    {
        kind: "Halt";
        reason: `the ${instruction['id']} block ended, and thus should not be reachable`;
    }
], state>>;
export type Halt<instruction extends IHalt, state extends ProgramState> = state;
