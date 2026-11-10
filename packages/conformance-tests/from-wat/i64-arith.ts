import type { Func, bootstrap } from 'wasm-to-typescript-types'

type $mul_fixed = Satisfies<Func, {
  kind: 'func';
  params: ['$a', '$b'];
  paramsTypes: ['i32', 'i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Extend', signed: true, from: 32 },
    { kind: 'LocalGet'; id: '$b' },
    { kind: 'Extend', signed: true, from: 32 },
    { kind: 'Multiply', type: 'i64' },
    { kind: 'Const'; value: '0000000000000000000000000000000000000000000000000000000000010000' },
    { kind: 'ShiftRight', signed: false, type: 'i64' },
    { kind: 'Wrap' },
  ];
}>

type $add64 = Satisfies<Func, {
  kind: 'func';
  params: ['$a', '$b'];
  paramsTypes: ['i32', 'i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Extend', signed: true, from: 32 },
    { kind: 'LocalGet'; id: '$b' },
    { kind: 'Extend', signed: true, from: 32 },
    { kind: 'Add', type: 'i64' },
    { kind: 'Wrap' },
  ];
}>

type $sub64 = Satisfies<Func, {
  kind: 'func';
  params: ['$a', '$b'];
  paramsTypes: ['i32', 'i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Extend', signed: true, from: 32 },
    { kind: 'LocalGet'; id: '$b' },
    { kind: 'Extend', signed: true, from: 32 },
    { kind: 'Subtract', type: 'i64' },
    { kind: 'Wrap' },
  ];
}>

type $add64_hi = Satisfies<Func, {
  kind: 'func';
  params: ['$a', '$b'];
  paramsTypes: ['i32', 'i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Extend', signed: false, from: 32 },
    { kind: 'LocalGet'; id: '$b' },
    { kind: 'Extend', signed: false, from: 32 },
    { kind: 'Add', type: 'i64' },
    { kind: 'Const'; value: '0000000000000000000000000000000000000000000000000000000000100000' },
    { kind: 'ShiftRight', signed: false, type: 'i64' },
    { kind: 'Wrap' },
  ];
}>

type $mul64_hi = Satisfies<Func, {
  kind: 'func';
  params: ['$a', '$b'];
  paramsTypes: ['i32', 'i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Extend', signed: false, from: 32 },
    { kind: 'LocalGet'; id: '$b' },
    { kind: 'Extend', signed: false, from: 32 },
    { kind: 'Multiply', type: 'i64' },
    { kind: 'Const'; value: '0000000000000000000000000000000000000000000000000000000000100000' },
    { kind: 'ShiftRight', signed: false, type: 'i64' },
    { kind: 'Wrap' },
  ];
}>

type $mul_big = Satisfies<Func, {
  kind: 'func';
  params: ['$a'];
  paramsTypes: ['i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Const'; value: '00000000000000001010011111001110' },
    { kind: 'Add', type: 'i32' },
    { kind: 'Extend', signed: false, from: 32 },
    { kind: 'Const'; value: '0000000000000000000000000000000000000000100000000000000000000000' },
    { kind: 'Multiply', type: 'i64' },
    { kind: 'Const'; value: '0000000000000000000000000000000000000000000000000000000000010000' },
    { kind: 'ShiftRight', signed: false, type: 'i64' },
    { kind: 'Wrap' },
  ];
}>

type $mul_big_hi = Satisfies<Func, {
  kind: 'func';
  params: ['$a'];
  paramsTypes: ['i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Const'; value: '00010010001101000101011001111000' },
    { kind: 'Add', type: 'i32' },
    { kind: 'Extend', signed: false, from: 32 },
    { kind: 'Const'; value: '10011010101111001101111011110000' },
    { kind: 'Extend', signed: false, from: 32 },
    { kind: 'Multiply', type: 'i64' },
    { kind: 'Const'; value: '0000000000000000000000000000000000000000000000000000000000100000' },
    { kind: 'ShiftRight', signed: false, type: 'i64' },
    { kind: 'Wrap' },
  ];
}>

type $shl_far = Satisfies<Func, {
  kind: 'func';
  params: ['$a'];
  paramsTypes: ['i32'];
  resultTypes: ['i32'];
  locals: [];
  instructions: [
    { kind: 'LocalGet'; id: '$a' },
    { kind: 'Extend', signed: false, from: 32 },
    { kind: 'Const'; value: '0000000000000000000000000000000000000000000000000000000000101000' },
    { kind: 'ShiftLeft', type: 'i64' },
    { kind: 'Const'; value: '0000000000000000000000000000000000000000000000000000000000101000' },
    { kind: 'ShiftRight', signed: false, type: 'i64' },
    { kind: 'Wrap' },
  ];
}>

export type funcs = {
  $mul_fixed: $mul_fixed;
  $add64: $add64;
  $sub64: $sub64;
  $add64_hi: $add64_hi;
  $mul64_hi: $mul64_hi;
  $mul_big: $mul_big;
  $mul_big_hi: $mul_big_hi;
  $shl_far: $shl_far;
}

export type entry<
  arguments extends [],
  debugMode extends boolean = false,
  stopAt extends number = number,
> = bootstrap<
  {
    arguments: arguments;
    funcs: funcs;
    globals: {};
    memory: {};
    memorySize: '00000000000000000000000000000000';
    indirect: {};
  },
  debugMode,
  stopAt
>
