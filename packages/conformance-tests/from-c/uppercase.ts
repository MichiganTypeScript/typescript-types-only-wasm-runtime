import type { Func, bootstrap } from 'wasm-to-typescript-types'

type $__wasm_call_ctors = Satisfies<Func, {
  kind: 'func';
  params: [];
  paramsTypes: [];
  resultTypes: [];
  locals: [];
  instructions: [
  ];
}>

type $toupper = Satisfies<Func, {
  kind: 'func';
  params: ['$p0'];
  paramsTypes: ['i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$p0' },
    { kind: 'Const'; value: '00000000000000000000000000100000' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'LocalGet'; id: '$p0' },
    { kind: 'LocalGet'; id: '$p0' },
    { kind: 'Const'; value: '00000000000000000000000001100001' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'Const'; value: '00000000000000000000000000011010' },
    { kind: 'LessThan', signed: false, type: 'i32' },
    { kind: 'Select' },
  ];
}>

type $entry = Satisfies<Func, {
  kind: 'func';
  params: ['$p0'];
  paramsTypes: ['i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'Const'; value: '00000000000000000000010000000000' },
    { kind: 'LocalGet'; id: '$p0' },
    { kind: 'Const'; value: '00000000000000000000000000100000' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'LocalGet'; id: '$p0' },
    { kind: 'LocalGet'; id: '$p0' },
    { kind: 'Const'; value: '00000000000000000000000001100001' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'Const'; value: '00000000000000000000000000011010' },
    { kind: 'LessThan', signed: false, type: 'i32' },
    { kind: 'Select' },
    { kind: 'Store'; subkind: 'I32Store8' },
    { kind: 'Const'; value: '00000000000000000000010000000001' },
    { kind: 'Const'; value: '00000000000000000000000000000000' },
    { kind: 'Store'; subkind: 'I32Store8' },
    { kind: 'Const'; value: '00000000000000000000010000000000' },
  ];
}>

export type funcs = {
  $__wasm_call_ctors: $__wasm_call_ctors;
  $toupper: $toupper;
  $entry: $entry;
}

export type entry<
  arguments extends [number],
  debugMode extends boolean = false,
  stopAt extends number = number,
> = bootstrap<
  {
    arguments: arguments;
    funcs: funcs;
    globals: {
      $__dso_handle: '00000000000000000000010000000000';
      $__data_end: '00000000000000000000010000000010';
      $__stack_low: '00000000000000000000010000010000';
      $__stack_high: '00000000000000010000010000010000';
      $__global_base: '00000000000000000000010000000000';
      $__heap_base: '00000000000000010000010000010000';
      $__heap_end: '00000000000000100000000000000000';
      $__memory_base: '00000000000000000000000000000000';
      $__table_base: '00000000000000000000000000000001';
    };
    memory: {};
    memorySize: '00000000000000000000000000000010';
    indirect: {};
  },
  debugMode,
  stopAt
>
