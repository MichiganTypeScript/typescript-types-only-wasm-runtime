(module
  (type $t0 (func (param i32) (result i32)))
  (type $t1 (func))
  (func $__wasm_call_ctors (export "__wasm_call_ctors") (type $t1))
  (func $toupper (export "toupper") (type $t0) (param $p0 i32) (result i32)
    (select
      (i32.sub
        (local.get $p0)
        (i32.const 32))
      (local.get $p0)
      (i32.lt_u
        (i32.sub
          (local.get $p0)
          (i32.const 97))
        (i32.const 26))))
  (func $entry (export "entry") (type $t0) (param $p0 i32) (result i32)
    (i32.store8
      (i32.const 1024)
      (select
        (i32.sub
          (local.get $p0)
          (i32.const 32))
        (local.get $p0)
        (i32.lt_u
          (i32.sub
            (local.get $p0)
            (i32.const 97))
          (i32.const 26))))
    (i32.store8
      (i32.const 1025)
      (i32.const 0))
    (i32.const 1024))
  (memory $memory (export "memory") 2)
  (global $__dso_handle (export "__dso_handle") i32 (i32.const 1024))
  (global $__data_end (export "__data_end") i32 (i32.const 1026))
  (global $__stack_low (export "__stack_low") i32 (i32.const 1040))
  (global $__stack_high (export "__stack_high") i32 (i32.const 66576))
  (global $__global_base (export "__global_base") i32 (i32.const 1024))
  (global $__heap_base (export "__heap_base") i32 (i32.const 66576))
  (global $__heap_end (export "__heap_end") i32 (i32.const 131072))
  (global $__memory_base (export "__memory_base") i32 (i32.const 0))
  (global $__table_base (export "__table_base") i32 (i32.const 1)))
