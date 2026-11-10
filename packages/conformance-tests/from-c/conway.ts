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

type $countAliveNeighbors = Satisfies<Func, {
  kind: 'func';
  params: ['$p0', '$p1', '$p2', '$p3', '$p4', '$p5'];
  paramsTypes: ['i32', 'i32', 'i32', 'i32', 'i32', 'i32'];
  resultTypes: [];
  locals: ['$l6', '$l7', '$l8', '$l9', '$l10', '$l11'];
  instructions: [
    { kind: 'LocalGet'; id: '$p5' },
    { kind: 'Const'; value: '00000000000000000000000000000000' },
    { kind: 'Store'; subkind: 'I32Store' },
    { kind: 'LocalGet'; id: '$p4' },
    { kind: 'Const'; value: '00000000000000000000000000000001' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'LocalSet'; id: '$l8' },
    { kind: 'LocalGet'; id: '$p4' },
    { kind: 'LocalGet'; id: '$p3' },
    { kind: 'Const'; value: '00000000000000000000000000001001' },
    { kind: 'Multiply', type: 'i32' },
    { kind: 'Add', type: 'i32' },
    { kind: 'LocalGet'; id: '$p0' },
    { kind: 'Add', type: 'i32' },
    { kind: 'Const'; value: '00000000000000000000000000001010' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'LocalSet'; id: '$l6' },
    { kind: 'Const'; value: '11111111111111111111111111111111' },
    { kind: 'LocalSet'; id: '$p0' },
    { kind: 'Loop';
      id: '$L0';
      instructions: [
        { kind: 'LocalGet'; id: '$p0' },
        { kind: 'LocalGet'; id: '$p3' },
        { kind: 'Add', type: 'i32' },
        { kind: 'LocalTee'; id: '$l9' },
        { kind: 'LocalGet'; id: '$p1' },
        { kind: 'GreaterThanOrEqual', signed: true, type: 'i32' },
        { kind: 'LocalSet'; id: '$l10' },
        { kind: 'Const'; value: '00000000000000000000000000000000' },
        { kind: 'LocalSet'; id: '$p4' },
        { kind: 'Loop';
          id: '$L1';
          instructions: [
            { kind: 'Block';
              id: '$B2';
              instructions: [
                { kind: 'LocalGet'; id: '$l10' },
                { kind: 'LocalGet'; id: '$p4' },
                { kind: 'Const'; value: '00000000000000000000000000000001' },
                { kind: 'Subtract', type: 'i32' },
                { kind: 'LocalGet'; id: '$p0' },
                { kind: 'Or', type: 'i32' },
                { kind: 'EqualsZero', type: 'i32' },
                { kind: 'LocalGet'; id: '$l9' },
                { kind: 'Const'; value: '00000000000000000000000000000000' },
                { kind: 'LessThan', signed: true, type: 'i32' },
                { kind: 'Or', type: 'i32' },
                { kind: 'Or', type: 'i32' },
                { kind: 'BranchIf'; id: '$B2' },
                { kind: 'LocalGet'; id: '$p4' },
                { kind: 'LocalGet'; id: '$l8' },
                { kind: 'Add', type: 'i32' },
                { kind: 'LocalTee'; id: '$l11' },
                { kind: 'Const'; value: '00000000000000000000000000000000' },
                { kind: 'LessThan', signed: true, type: 'i32' },
                { kind: 'LocalGet'; id: '$p2' },
                { kind: 'LocalGet'; id: '$l11' },
                { kind: 'LessThanOrEqual', signed: true, type: 'i32' },
                { kind: 'Or', type: 'i32' },
                { kind: 'BranchIf'; id: '$B2' },
                { kind: 'LocalGet'; id: '$p4' },
                { kind: 'LocalGet'; id: '$l6' },
                { kind: 'Add', type: 'i32' },
                { kind: 'Load'; subkind: 'I32Load8u' },
                { kind: 'EqualsZero', type: 'i32' },
                { kind: 'BranchIf'; id: '$B2' },
                { kind: 'LocalGet'; id: '$p5' },
                { kind: 'LocalGet'; id: '$l7' },
                { kind: 'Const'; value: '00000000000000000000000000000001' },
                { kind: 'Add', type: 'i32' },
                { kind: 'LocalTee'; id: '$l7' },
                { kind: 'Store'; subkind: 'I32Store' },
              ];
            },
            { kind: 'LocalGet'; id: '$p4' },
            { kind: 'Const'; value: '00000000000000000000000000000001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalTee'; id: '$p4' },
            { kind: 'Const'; value: '00000000000000000000000000000011' },
            { kind: 'NotEqual', type: 'i32' },
            { kind: 'BranchIf'; id: '$L1' },
          ];
        },
        { kind: 'LocalGet'; id: '$l6' },
        { kind: 'Const'; value: '00000000000000000000000000001001' },
        { kind: 'Add', type: 'i32' },
        { kind: 'LocalSet'; id: '$l6' },
        { kind: 'LocalGet'; id: '$p0' },
        { kind: 'Const'; value: '00000000000000000000000000000001' },
        { kind: 'Add', type: 'i32' },
        { kind: 'LocalTee'; id: '$p0' },
        { kind: 'Const'; value: '00000000000000000000000000000010' },
        { kind: 'NotEqual', type: 'i32' },
        { kind: 'BranchIf'; id: '$L0' },
      ];
    },
  ];
}>

type $updateGrid = Satisfies<Func, {
  kind: 'func';
  params: ['$p0', '$p1', '$p2'];
  paramsTypes: ['i32', 'i32', 'i32'];
  resultTypes: [];
  locals: ['$l3', '$l4', '$l5', '$l6', '$l7', '$l8', '$l9'];
  instructions: [
    { kind: 'GlobalGet'; id: '$g0' },
    { kind: 'Const'; value: '00000000000000000000000001110000' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'LocalTee'; id: '$l7' },
    { kind: 'GlobalSet'; id: '$g0' },
    { kind: 'Block';
      id: '$B0';
      instructions: [
        { kind: 'LocalGet'; id: '$p1' },
        { kind: 'Const'; value: '00000000000000000000000000000000' },
        { kind: 'LessThanOrEqual', signed: true, type: 'i32' },
        { kind: 'BranchIf'; id: '$B0' },
        { kind: 'LocalGet'; id: '$l7' },
        { kind: 'Const'; value: '00000000000000000000000000010000' },
        { kind: 'Add', type: 'i32' },
        { kind: 'LocalSet'; id: '$l4' },
        { kind: 'LocalGet'; id: '$p2' },
        { kind: 'Const'; value: '00000000000000000000000000000000' },
        { kind: 'LessThanOrEqual', signed: true, type: 'i32' },
        { kind: 'LocalSet'; id: '$l8' },
        { kind: 'LocalGet'; id: '$p0' },
        { kind: 'LocalSet'; id: '$l6' },
        { kind: 'Loop';
          id: '$L1';
          instructions: [
            { kind: 'LocalGet'; id: '$l8' },
            { kind: 'EqualsZero', type: 'i32' },
            { kind: 'If';
              then: [
                { kind: 'Const'; value: '00000000000000000000000000000000' },
                { kind: 'LocalSet'; id: '$l3' },
                { kind: 'Loop';
                  id: '$L3';
                  instructions: [
                    { kind: 'LocalGet'; id: '$p0' },
                    { kind: 'LocalGet'; id: '$p1' },
                    { kind: 'LocalGet'; id: '$p2' },
                    { kind: 'LocalGet'; id: '$l5' },
                    { kind: 'LocalGet'; id: '$l3' },
                    { kind: 'LocalGet'; id: '$l7' },
                    { kind: 'Const'; value: '00000000000000000000000000001100' },
                    { kind: 'Add', type: 'i32' },
                    { kind: 'Call'; id: '$countAliveNeighbors' },
                    { kind: 'LocalGet'; id: '$l3' },
                    { kind: 'LocalGet'; id: '$l4' },
                    { kind: 'Add', type: 'i32' },
                    { kind: 'LocalGet'; id: '$l7' },
                    { kind: 'Load'; subkind: 'I32Load'; offset: '00000000000000000000000000001100' },
                    { kind: 'LocalTee'; id: '$l9' },
                    { kind: 'Const'; value: '11111111111111111111111111111110' },
                    { kind: 'And', type: 'i32' },
                    { kind: 'Const'; value: '00000000000000000000000000000010' },
                    { kind: 'Equals', type: 'i32' },
                    { kind: 'LocalGet'; id: '$l9' },
                    { kind: 'Const'; value: '00000000000000000000000000000011' },
                    { kind: 'Equals', type: 'i32' },
                    { kind: 'LocalGet'; id: '$l3' },
                    { kind: 'LocalGet'; id: '$l6' },
                    { kind: 'Add', type: 'i32' },
                    { kind: 'Load'; subkind: 'I32Load8u' },
                    { kind: 'Select' },
                    { kind: 'Store'; subkind: 'I32Store8' },
                    { kind: 'LocalGet'; id: '$p2' },
                    { kind: 'LocalGet'; id: '$l3' },
                    { kind: 'Const'; value: '00000000000000000000000000000001' },
                    { kind: 'Add', type: 'i32' },
                    { kind: 'LocalTee'; id: '$l3' },
                    { kind: 'NotEqual', type: 'i32' },
                    { kind: 'BranchIf'; id: '$L3' },
                  ];
                },
              ];
            },
            { kind: 'LocalGet'; id: '$l4' },
            { kind: 'Const'; value: '00000000000000000000000000001001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalSet'; id: '$l4' },
            { kind: 'LocalGet'; id: '$l6' },
            { kind: 'Const'; value: '00000000000000000000000000001001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalSet'; id: '$l6' },
            { kind: 'LocalGet'; id: '$l5' },
            { kind: 'Const'; value: '00000000000000000000000000000001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalTee'; id: '$l5' },
            { kind: 'LocalGet'; id: '$p1' },
            { kind: 'NotEqual', type: 'i32' },
            { kind: 'BranchIf'; id: '$L1' },
          ];
        },
        { kind: 'LocalGet'; id: '$p1' },
        { kind: 'Const'; value: '00000000000000000000000000000000' },
        { kind: 'LessThanOrEqual', signed: true, type: 'i32' },
        { kind: 'BranchIf'; id: '$B0' },
        { kind: 'Const'; value: '00000000000000000000000000000000' },
        { kind: 'LocalSet'; id: '$l6' },
        { kind: 'LocalGet'; id: '$l7' },
        { kind: 'Const'; value: '00000000000000000000000000010000' },
        { kind: 'Add', type: 'i32' },
        { kind: 'LocalSet'; id: '$l4' },
        { kind: 'LocalGet'; id: '$p2' },
        { kind: 'Const'; value: '00000000000000000000000000000000' },
        { kind: 'LessThanOrEqual', signed: true, type: 'i32' },
        { kind: 'LocalSet'; id: '$l9' },
        { kind: 'Loop';
          id: '$L4';
          instructions: [
            { kind: 'LocalGet'; id: '$l4' },
            { kind: 'LocalSet'; id: '$l3' },
            { kind: 'LocalGet'; id: '$p0' },
            { kind: 'LocalSet'; id: '$l8' },
            { kind: 'LocalGet'; id: '$p2' },
            { kind: 'LocalSet'; id: '$l5' },
            { kind: 'LocalGet'; id: '$l9' },
            { kind: 'EqualsZero', type: 'i32' },
            { kind: 'If';
              then: [
                { kind: 'Loop';
                  id: '$L6';
                  instructions: [
                    { kind: 'LocalGet'; id: '$l8' },
                    { kind: 'LocalGet'; id: '$l3' },
                    { kind: 'Load'; subkind: 'I32Load8u' },
                    { kind: 'Store'; subkind: 'I32Store8' },
                    { kind: 'LocalGet'; id: '$l3' },
                    { kind: 'Const'; value: '00000000000000000000000000000001' },
                    { kind: 'Add', type: 'i32' },
                    { kind: 'LocalSet'; id: '$l3' },
                    { kind: 'LocalGet'; id: '$l8' },
                    { kind: 'Const'; value: '00000000000000000000000000000001' },
                    { kind: 'Add', type: 'i32' },
                    { kind: 'LocalSet'; id: '$l8' },
                    { kind: 'LocalGet'; id: '$l5' },
                    { kind: 'Const'; value: '00000000000000000000000000000001' },
                    { kind: 'Subtract', type: 'i32' },
                    { kind: 'LocalTee'; id: '$l5' },
                    { kind: 'BranchIf'; id: '$L6' },
                  ];
                },
              ];
            },
            { kind: 'LocalGet'; id: '$l4' },
            { kind: 'Const'; value: '00000000000000000000000000001001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalSet'; id: '$l4' },
            { kind: 'LocalGet'; id: '$p0' },
            { kind: 'Const'; value: '00000000000000000000000000001001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalSet'; id: '$p0' },
            { kind: 'LocalGet'; id: '$l6' },
            { kind: 'Const'; value: '00000000000000000000000000000001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalTee'; id: '$l6' },
            { kind: 'LocalGet'; id: '$p1' },
            { kind: 'NotEqual', type: 'i32' },
            { kind: 'BranchIf'; id: '$L4' },
          ];
        },
      ];
    },
    { kind: 'LocalGet'; id: '$l7' },
    { kind: 'Const'; value: '00000000000000000000000001110000' },
    { kind: 'Add', type: 'i32' },
    { kind: 'GlobalSet'; id: '$g0' },
  ];
}>

type $displayGrid = Satisfies<Func, {
  kind: 'func';
  params: ['$p0', '$p1', '$p2'];
  paramsTypes: ['i32', 'i32', 'i32'];
  resultTypes: ['i32'];
  locals: ['$l3', '$l4', '$l5', '$l6', '$l7'];
  instructions: [
    { kind: 'LocalGet'; id: '$p1' },
    { kind: 'Const'; value: '00000000000000000000000000000000' },
    { kind: 'GreaterThan', signed: true, type: 'i32' },
    { kind: 'If';
      then: [
        { kind: 'LocalGet'; id: '$p2' },
        { kind: 'Const'; value: '00000000000000000000000000000000' },
        { kind: 'LessThanOrEqual', signed: true, type: 'i32' },
        { kind: 'LocalSet'; id: '$l7' },
        { kind: 'Loop';
          id: '$L1';
          instructions: [
            { kind: 'LocalGet'; id: '$p0' },
            { kind: 'LocalSet'; id: '$l4' },
            { kind: 'LocalGet'; id: '$p2' },
            { kind: 'LocalSet'; id: '$l6' },
            { kind: 'LocalGet'; id: '$l7' },
            { kind: 'EqualsZero', type: 'i32' },
            { kind: 'If';
              then: [
                { kind: 'Loop';
                  id: '$L3';
                  instructions: [
                    { kind: 'LocalGet'; id: '$l3' },
                    { kind: 'Const'; value: '00000000000000000000000001001110' },
                    { kind: 'LessThanOrEqual', signed: true, type: 'i32' },
                    { kind: 'If';
                      then: [
                        { kind: 'LocalGet'; id: '$l3' },
                        { kind: 'Const'; value: '00000000000000000000010001100000' },
                        { kind: 'Add', type: 'i32' },
                        { kind: 'Const'; value: '00000000000000000000000000100100' },
                        { kind: 'Const'; value: '00000000000000000000000000101110' },
                        { kind: 'LocalGet'; id: '$l4' },
                        { kind: 'Load'; subkind: 'I32Load8u' },
                        { kind: 'Select' },
                        { kind: 'Store'; subkind: 'I32Store8' },
                        { kind: 'LocalGet'; id: '$l3' },
                        { kind: 'Const'; value: '00000000000000000000000000000001' },
                        { kind: 'Add', type: 'i32' },
                        { kind: 'LocalSet'; id: '$l3' },
                      ];
                    },
                    { kind: 'LocalGet'; id: '$l4' },
                    { kind: 'Const'; value: '00000000000000000000000000000001' },
                    { kind: 'Add', type: 'i32' },
                    { kind: 'LocalSet'; id: '$l4' },
                    { kind: 'LocalGet'; id: '$l6' },
                    { kind: 'Const'; value: '00000000000000000000000000000001' },
                    { kind: 'Subtract', type: 'i32' },
                    { kind: 'LocalTee'; id: '$l6' },
                    { kind: 'BranchIf'; id: '$L3' },
                  ];
                },
              ];
            },
            { kind: 'LocalGet'; id: '$l3' },
            { kind: 'Const'; value: '00000000000000000000000001001111' },
            { kind: 'LessThan', signed: true, type: 'i32' },
            { kind: 'If';
              then: [
                { kind: 'LocalGet'; id: '$l3' },
                { kind: 'Const'; value: '00000000000000000000010001100000' },
                { kind: 'Add', type: 'i32' },
                { kind: 'Const'; value: '00000000000000000000000000001010' },
                { kind: 'Store'; subkind: 'I32Store8' },
                { kind: 'LocalGet'; id: '$l3' },
                { kind: 'Const'; value: '00000000000000000000000000000001' },
                { kind: 'Add', type: 'i32' },
                { kind: 'LocalSet'; id: '$l3' },
              ];
            },
            { kind: 'LocalGet'; id: '$p0' },
            { kind: 'Const'; value: '00000000000000000000000000001001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalSet'; id: '$p0' },
            { kind: 'LocalGet'; id: '$l5' },
            { kind: 'Const'; value: '00000000000000000000000000000001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalTee'; id: '$l5' },
            { kind: 'LocalGet'; id: '$p1' },
            { kind: 'NotEqual', type: 'i32' },
            { kind: 'BranchIf'; id: '$L1' },
          ];
        },
      ];
    },
    { kind: 'LocalGet'; id: '$l3' },
    { kind: 'Const'; value: '00000000000000000000010001100000' },
    { kind: 'Add', type: 'i32' },
    { kind: 'Const'; value: '00000000000000000000000000000000' },
    { kind: 'Store'; subkind: 'I32Store8' },
    { kind: 'Const'; value: '00000000000000000000010001100000' },
  ];
}>

type $entry = Satisfies<Func, {
  kind: 'func';
  params: ['$p0'];
  paramsTypes: ['i32'];
  resultTypes: ['i32'];
  locals: ['$l1', '$l2', '$l3', '$l4', '$l5'];
  instructions: [
    { kind: 'GlobalGet'; id: '$g0' },
    { kind: 'Const'; value: '00000000000000000000000001100000' },
    { kind: 'Subtract', type: 'i32' },
    { kind: 'LocalTee'; id: '$l1' },
    { kind: 'GlobalSet'; id: '$g0' },
    { kind: 'Loop';
      id: '$L0';
      instructions: [
        { kind: 'LocalGet'; id: '$l1' },
        { kind: 'LocalGet'; id: '$l2' },
        { kind: 'Add', type: 'i32' },
        { kind: 'LocalSet'; id: '$l5' },
        { kind: 'Const'; value: '00000000000000000000000000000000' },
        { kind: 'LocalSet'; id: '$l3' },
        { kind: 'Loop';
          id: '$L1';
          instructions: [
            { kind: 'LocalGet'; id: '$l3' },
            { kind: 'LocalGet'; id: '$l5' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalGet'; id: '$l2' },
            { kind: 'LocalGet'; id: '$l3' },
            { kind: 'Add', type: 'i32' },
            { kind: 'Const'; value: '00000000000000000000010000000000' },
            { kind: 'Add', type: 'i32' },
            { kind: 'Load'; subkind: 'I32Load8u' },
            { kind: 'Store'; subkind: 'I32Store8' },
            { kind: 'LocalGet'; id: '$l3' },
            { kind: 'Const'; value: '00000000000000000000000000000001' },
            { kind: 'Add', type: 'i32' },
            { kind: 'LocalTee'; id: '$l3' },
            { kind: 'Const'; value: '00000000000000000000000000001001' },
            { kind: 'NotEqual', type: 'i32' },
            { kind: 'BranchIf'; id: '$L1' },
          ];
        },
        { kind: 'LocalGet'; id: '$l2' },
        { kind: 'Const'; value: '00000000000000000000000000001001' },
        { kind: 'Add', type: 'i32' },
        { kind: 'LocalSet'; id: '$l2' },
        { kind: 'LocalGet'; id: '$l4' },
        { kind: 'Const'; value: '00000000000000000000000000000001' },
        { kind: 'Add', type: 'i32' },
        { kind: 'LocalTee'; id: '$l4' },
        { kind: 'Const'; value: '00000000000000000000000000001001' },
        { kind: 'NotEqual', type: 'i32' },
        { kind: 'BranchIf'; id: '$L0' },
      ];
    },
    { kind: 'LocalGet'; id: '$p0' },
    { kind: 'Const'; value: '00000000000000000000000000000000' },
    { kind: 'GreaterThan', signed: true, type: 'i32' },
    { kind: 'If';
      then: [
        { kind: 'Loop';
          id: '$L3';
          instructions: [
            { kind: 'LocalGet'; id: '$l1' },
            { kind: 'Const'; value: '00000000000000000000000000001001' },
            { kind: 'Const'; value: '00000000000000000000000000001001' },
            { kind: 'Call'; id: '$updateGrid' },
            { kind: 'LocalGet'; id: '$p0' },
            { kind: 'Const'; value: '00000000000000000000000000000001' },
            { kind: 'Subtract', type: 'i32' },
            { kind: 'LocalTee'; id: '$p0' },
            { kind: 'BranchIf'; id: '$L3' },
          ];
        },
      ];
    },
    { kind: 'LocalGet'; id: '$l1' },
    { kind: 'Const'; value: '00000000000000000000000000001001' },
    { kind: 'Const'; value: '00000000000000000000000000001001' },
    { kind: 'Call'; id: '$displayGrid' },
    { kind: 'Drop' },
    { kind: 'LocalGet'; id: '$l1' },
    { kind: 'Const'; value: '00000000000000000000000001100000' },
    { kind: 'Add', type: 'i32' },
    { kind: 'GlobalSet'; id: '$g0' },
    { kind: 'Const'; value: '00000000000000000000010001100000' },
  ];
}>

export type funcs = {
  $__wasm_call_ctors: $__wasm_call_ctors;
  $countAliveNeighbors: $countAliveNeighbors;
  $updateGrid: $updateGrid;
  $displayGrid: $displayGrid;
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
      $g0: '00000000000000010000010011000000';
      $__dso_handle: '00000000000000000000010000000000';
      $__data_end: '00000000000000000000010010110001';
      $__stack_low: '00000000000000000000010011000000';
      $__stack_high: '00000000000000010000010011000000';
      $__global_base: '00000000000000000000010000000000';
      $__heap_base: '00000000000000010000010011000000';
      $__heap_end: '00000000000000100000000000000000';
      $__memory_base: '00000000000000000000000000000000';
      $__table_base: '00000000000000000000000000000001';
    };
    memory:
      & $d0
      & $d1
    ;
    memorySize: '00000000000000000000000000000010';
    indirect: {};
  },
  debugMode,
  stopAt
>

/**  */
type $d0 = {
  '00000000000000000000010000000000': '00000001'; // 
  '00000000000000000000010000000001': '00000001'; // 
}

/**                */
type $d1 = {
  '00000000000000000000010000011111': '00000001'; // 
  '00000000000000000000010000100111': '00000001'; // 
  '00000000000000000000010000101000': '00000001'; // 
  '00000000000000000000010000101001': '00000001'; // 
  '00000000000000000000010000110001': '00000001'; // 
}
