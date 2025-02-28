import type { Func, bootstrap } from 'wasm-to-typescript-types'

type $__wasm_call_ctors = Satisfies<Func, {
  kind: 'func';
  params: [];
  paramsTypes: [];
  resultTypes: [];
  locals: [];
  instructions: [
    { kind: 'Call'; id: '$emscripten_stack_init' },
  ];
}>

type $entry = Satisfies<Func, {
  kind: 'func';
  params: ['$a', '$b'];
  paramsTypes: ['i32', 'i32'];
  resultTypes: ['i32'];
  locals: ['$stack_pointer', '$stack_size', '$this_stack', '$stack_a', '$stack_b', '$result'];
  instructions: [
    { kind: 'GlobalGet'; id: '$__stack_pointer' },
    { kind: 'LocalSet'; id: '$stack_pointer' },
    { kind: 'Const'; value: '00000000000000000000000000010000' },
    { kind: 'LocalSet'; id: '$stack_size' },
    { kind: 'LocalGet'; id: '$stack_pointer' },
    { kind: 'LocalGet'; id: '$stack_size' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'LocalSet'; id: '$this_stack' },
    { kind: 'LocalGet'; id: '$this_stack' },
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Store'; subkind: 'I32Store'; offset: '00000000000000000000000000001100' },
    { kind: 'LocalGet'; id: '$this_stack' },
    { kind: 'LocalGet'; id: '$b' },
    { kind: 'Store'; subkind: 'I32Store'; offset: '00000000000000000000000000001000' },
    { kind: 'LocalGet'; id: '$this_stack' },
    { kind: 'Load'; subkind: 'I32Load'; offset: '00000000000000000000000000001100' },
    { kind: 'LocalSet'; id: '$stack_a' },
    { kind: 'LocalGet'; id: '$this_stack' },
    { kind: 'Load'; subkind: 'I32Load'; offset: '00000000000000000000000000001000' },
    { kind: 'LocalSet'; id: '$stack_b' },
    { kind: 'LocalGet'; id: '$stack_a' },
    { kind: 'LocalGet'; id: '$stack_b' },
    { kind: 'Add', type: 'i32' },
    { kind: 'LocalSet'; id: '$result' },
    { kind: 'LocalGet'; id: '$result' },
    { kind: 'Return'; count: 1 },
  ];
}>

type $emscripten_stack_init = Satisfies<Func, {
  kind: 'func';
  params: [];
  paramsTypes: [];
  resultTypes: [];
  locals: [];
  instructions: [
    { kind: 'Const'; value: '00000000010100000000010000010000' },
    { kind: 'GlobalSet'; id: '$__stack_base' },
    { kind: 'Const'; value: '00000000000000000000010000000100' },
    { kind: 'Const'; value: '00000000000000000000000000001111' },
    { kind: 'Add', type: 'i32' },
    { kind: 'Const'; value: '11111111111111111111111111110000' },
    { kind: 'And', type: 'i32' },
    { kind: 'GlobalSet'; id: '$__stack_end' },
  ];
}>

export type funcs = {
  $__wasm_call_ctors: $__wasm_call_ctors;
  $entry: $entry;
  $emscripten_stack_init: $emscripten_stack_init;
}

export type entry<
  arguments extends [number, number],
  debugMode extends boolean = false,
  stopAt extends number = number,
> = bootstrap<
  {
    arguments: arguments;
    funcs: funcs;
    globals: {
      $__stack_pointer: '00000000010100000000010000010000';
      $__stack_end: '00000000000000000000000000000000';
      $__stack_base: '00000000000000000000000000000000';
    };
    memory: {};
    memorySize: '00000000000000000000000100000000';
    indirect: {
      '00000000000000000000000000000001' : '$__wasm_call_ctors';
    };
  },
  debugMode,
  stopAt
>
