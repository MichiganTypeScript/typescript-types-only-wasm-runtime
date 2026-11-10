import { test } from 'vitest'
import { Equal, Expect } from "type-testing"
import { ProgramState } from "./types"
import type { evaluate, Satisfies } from 'ts-type-math'
import { executeInstruction } from "./program"

// The assertions in this file are `Expect<Equal<...>>`, checked by tsc rather
// than at runtime. vitest still has to find a suite here or it fails the file
// outright ("No test suite found"), which is how this one has been red - a
// collection error, not a failing assertion. Same marker as bootstrap.test.ts.
test("garbage collection")

type blank = Satisfies<ProgramState, {
  count: 0;
  results: [];
  stack: [];
  instructions: [];
  activeFuncId: "";
  activeBranches: {};
  activeStackDepth: 0;
  activeLocals: {};
  globals: {};
  L1Cache: {};
  memory: {};
  garbageCollection: 0;
  indirect: {};
  memorySize: "";
  executionContexts: [];
  funcs: {};
  callHistory: [];
}>

type s<
  Source extends ProgramState,
  Update extends Partial<ProgramState>,
> = Satisfies<ProgramState,
  evaluate<
    & Omit<
      Source,
      keyof Update
    >
    & Required<Update>
  >
>

// end-to-end test for garbage collection

type start1 = Satisfies<ProgramState, s<blank, {
  count: 1;
  stack: ["10000000000000000000000000000000", "00000000000000000000000000001111"]
  instructions: [
    { kind: 'Nop', ziltoid: 'theOmniscient' },
    { kind: 'Store', subkind: 'I32Store8' },
    { kind: 'Nop', ziltoid: 'theOmniscient' },
  ];
  L1Cache: {
    "00000000000000000000000000000000": "00101110"; // will not change because it matches the source
    "00000000000000000000000000000001": "00000000"; // will clear the source value
    "00000000000000000000000000000011": "00000000"; // will never be set in the first place
    "00000000000000000000000000000100": "01010101"; // will append this new value because it's not false
    "00000000000000000000000000000101": "00000000"; // will skip because it's false
    "00000000000000000000000000000111": "00000010"; // will modify the source value
  }
  memory: {
    "00000000000000000000000000000000": "00101110"; // will keep because it hasn't changed
    "00000000000000000000000000000001": "11111111"; // will be removed because the update for this address is false
    "00000000000000000000000000000111": "00000001"; // will be modified by the update
    "11111111111111111111111100000011": "00000001"; // will keep because it's random other data only present in the source
  };
  garbageCollection: 1023;
}>>

// no change to the garbage collection counter for regular instructions
type actual2 = executeInstruction<start1, true, 2>
type expected2 = Satisfies<ProgramState, s<start1 /* note: using `start1` here, not `blank` like the rest */, {
  count: 2;
  instructions: [
    { kind: 'Store', subkind: 'I32Store8' },
    { kind: 'Nop', ziltoid: 'theOmniscient' },
  ];
}>>
type test2 = Expect<Equal<actual2, expected2>>

type actual3 = executeInstruction<actual2, true, 3>
type expected3 = Satisfies<ProgramState, s<blank, {
  count: 3;
  instructions: [
    { kind: 'Nop', ziltoid: 'theOmniscient' },
  ];
  L1Cache: evaluate<start1['L1Cache'] & {
    "10000000000000000000000000000000": "00001111"; // from the I32Store8
  }>;
  memory: start1['memory'];
  garbageCollection: 1024;
}>>
type test3 = Expect<Equal<actual3, expected3>>

type actual4 = executeInstruction<actual3, true, 4>
type expected4 = Satisfies<ProgramState, s<blank, {
  count: 4;
  memory: {
    "00000000000000000000000000000000": "00101110"; // source and update match
  //"00000000000000000000000000000001": "11111111"; // the update cleared this value
    "00000000000000000000000000000100": "01010101"; // newly added by the update
    "00000000000000000000000000000111": "00000010"; // modified by the update
    "11111111111111111111111100000011": "00000001"; // the random other data only present in the source
    "10000000000000000000000000000000": "00001111"; // from the I32Store8
  }
  garbageCollection: 0;
}>>
type test4 = Expect<Equal<actual4, expected4>>
