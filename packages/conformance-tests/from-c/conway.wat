(module
  (type $t0 (func))
  (type $t1 (func (param i32 i32 i32 i32 i32 i32)))
  (type $t2 (func (param i32 i32 i32)))
  (type $t3 (func (param i32 i32 i32) (result i32)))
  (type $t4 (func (param i32) (result i32)))
  (func $__wasm_call_ctors (export "__wasm_call_ctors") (type $t0))
  (func $countAliveNeighbors (export "countAliveNeighbors") (type $t1) (param $p0 i32) (param $p1 i32) (param $p2 i32) (param $p3 i32) (param $p4 i32) (param $p5 i32)
    (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32) (local $l11 i32)
    (i32.store
      (local.get $p5)
      (i32.const 0))
    (local.set $l8
      (i32.sub
        (local.get $p4)
        (i32.const 1)))
    (local.set $l6
      (i32.sub
        (i32.add
          (i32.add
            (local.get $p4)
            (i32.mul
              (local.get $p3)
              (i32.const 9)))
          (local.get $p0))
        (i32.const 10)))
    (local.set $p0
      (i32.const -1))
    (loop $L0
      (local.set $l10
        (i32.ge_s
          (local.tee $l9
            (i32.add
              (local.get $p0)
              (local.get $p3)))
          (local.get $p1)))
      (local.set $p4
        (i32.const 0))
      (loop $L1
        (block $B2
          (br_if $B2
            (i32.or
              (local.get $l10)
              (i32.or
                (i32.eqz
                  (i32.or
                    (i32.sub
                      (local.get $p4)
                      (i32.const 1))
                    (local.get $p0)))
                (i32.lt_s
                  (local.get $l9)
                  (i32.const 0)))))
          (br_if $B2
            (i32.or
              (i32.lt_s
                (local.tee $l11
                  (i32.add
                    (local.get $p4)
                    (local.get $l8)))
                (i32.const 0))
              (i32.le_s
                (local.get $p2)
                (local.get $l11))))
          (br_if $B2
            (i32.eqz
              (i32.load8_u
                (i32.add
                  (local.get $p4)
                  (local.get $l6)))))
          (i32.store
            (local.get $p5)
            (local.tee $l7
              (i32.add
                (local.get $l7)
                (i32.const 1)))))
        (br_if $L1
          (i32.ne
            (local.tee $p4
              (i32.add
                (local.get $p4)
                (i32.const 1)))
            (i32.const 3))))
      (local.set $l6
        (i32.add
          (local.get $l6)
          (i32.const 9)))
      (br_if $L0
        (i32.ne
          (local.tee $p0
            (i32.add
              (local.get $p0)
              (i32.const 1)))
          (i32.const 2)))))
  (func $updateGrid (export "updateGrid") (type $t2) (param $p0 i32) (param $p1 i32) (param $p2 i32)
    (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32)
    (global.set $g0
      (local.tee $l7
        (i32.sub
          (global.get $g0)
          (i32.const 112))))
    (block $B0
      (br_if $B0
        (i32.le_s
          (local.get $p1)
          (i32.const 0)))
      (local.set $l4
        (i32.add
          (local.get $l7)
          (i32.const 16)))
      (local.set $l8
        (i32.le_s
          (local.get $p2)
          (i32.const 0)))
      (local.set $l6
        (local.get $p0))
      (loop $L1
        (if $I2
          (i32.eqz
            (local.get $l8))
          (then
            (local.set $l3
              (i32.const 0))
            (loop $L3
              (call $countAliveNeighbors
                (local.get $p0)
                (local.get $p1)
                (local.get $p2)
                (local.get $l5)
                (local.get $l3)
                (i32.add
                  (local.get $l7)
                  (i32.const 12)))
              (i32.store8
                (i32.add
                  (local.get $l3)
                  (local.get $l4))
                (select
                  (i32.eq
                    (i32.and
                      (local.tee $l9
                        (i32.load offset=12
                          (local.get $l7)))
                      (i32.const -2))
                    (i32.const 2))
                  (i32.eq
                    (local.get $l9)
                    (i32.const 3))
                  (i32.load8_u
                    (i32.add
                      (local.get $l3)
                      (local.get $l6)))))
              (br_if $L3
                (i32.ne
                  (local.get $p2)
                  (local.tee $l3
                    (i32.add
                      (local.get $l3)
                      (i32.const 1))))))))
        (local.set $l4
          (i32.add
            (local.get $l4)
            (i32.const 9)))
        (local.set $l6
          (i32.add
            (local.get $l6)
            (i32.const 9)))
        (br_if $L1
          (i32.ne
            (local.tee $l5
              (i32.add
                (local.get $l5)
                (i32.const 1)))
            (local.get $p1))))
      (br_if $B0
        (i32.le_s
          (local.get $p1)
          (i32.const 0)))
      (local.set $l6
        (i32.const 0))
      (local.set $l4
        (i32.add
          (local.get $l7)
          (i32.const 16)))
      (local.set $l9
        (i32.le_s
          (local.get $p2)
          (i32.const 0)))
      (loop $L4
        (local.set $l3
          (local.get $l4))
        (local.set $l8
          (local.get $p0))
        (local.set $l5
          (local.get $p2))
        (if $I5
          (i32.eqz
            (local.get $l9))
          (then
            (loop $L6
              (i32.store8
                (local.get $l8)
                (i32.load8_u
                  (local.get $l3)))
              (local.set $l3
                (i32.add
                  (local.get $l3)
                  (i32.const 1)))
              (local.set $l8
                (i32.add
                  (local.get $l8)
                  (i32.const 1)))
              (br_if $L6
                (local.tee $l5
                  (i32.sub
                    (local.get $l5)
                    (i32.const 1)))))))
        (local.set $l4
          (i32.add
            (local.get $l4)
            (i32.const 9)))
        (local.set $p0
          (i32.add
            (local.get $p0)
            (i32.const 9)))
        (br_if $L4
          (i32.ne
            (local.tee $l6
              (i32.add
                (local.get $l6)
                (i32.const 1)))
            (local.get $p1)))))
    (global.set $g0
      (i32.add
        (local.get $l7)
        (i32.const 112))))
  (func $displayGrid (export "displayGrid") (type $t3) (param $p0 i32) (param $p1 i32) (param $p2 i32) (result i32)
    (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32)
    (if $I0
      (i32.gt_s
        (local.get $p1)
        (i32.const 0))
      (then
        (local.set $l7
          (i32.le_s
            (local.get $p2)
            (i32.const 0)))
        (loop $L1
          (local.set $l4
            (local.get $p0))
          (local.set $l6
            (local.get $p2))
          (if $I2
            (i32.eqz
              (local.get $l7))
            (then
              (loop $L3
                (if $I4
                  (i32.le_s
                    (local.get $l3)
                    (i32.const 78))
                  (then
                    (i32.store8
                      (i32.add
                        (local.get $l3)
                        (i32.const 1120))
                      (select
                        (i32.const 36)
                        (i32.const 46)
                        (i32.load8_u
                          (local.get $l4))))
                    (local.set $l3
                      (i32.add
                        (local.get $l3)
                        (i32.const 1)))))
                (local.set $l4
                  (i32.add
                    (local.get $l4)
                    (i32.const 1)))
                (br_if $L3
                  (local.tee $l6
                    (i32.sub
                      (local.get $l6)
                      (i32.const 1)))))))
          (if $I5
            (i32.lt_s
              (local.get $l3)
              (i32.const 79))
            (then
              (i32.store8
                (i32.add
                  (local.get $l3)
                  (i32.const 1120))
                (i32.const 10))
              (local.set $l3
                (i32.add
                  (local.get $l3)
                  (i32.const 1)))))
          (local.set $p0
            (i32.add
              (local.get $p0)
              (i32.const 9)))
          (br_if $L1
            (i32.ne
              (local.tee $l5
                (i32.add
                  (local.get $l5)
                  (i32.const 1)))
              (local.get $p1))))))
    (i32.store8
      (i32.add
        (local.get $l3)
        (i32.const 1120))
      (i32.const 0))
    (i32.const 1120))
  (func $entry (export "entry") (type $t4) (param $p0 i32) (result i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32)
    (global.set $g0
      (local.tee $l1
        (i32.sub
          (global.get $g0)
          (i32.const 96))))
    (loop $L0
      (local.set $l5
        (i32.add
          (local.get $l1)
          (local.get $l2)))
      (local.set $l3
        (i32.const 0))
      (loop $L1
        (i32.store8
          (i32.add
            (local.get $l3)
            (local.get $l5))
          (i32.load8_u
            (i32.add
              (i32.add
                (local.get $l2)
                (local.get $l3))
              (i32.const 1024))))
        (br_if $L1
          (i32.ne
            (local.tee $l3
              (i32.add
                (local.get $l3)
                (i32.const 1)))
            (i32.const 9))))
      (local.set $l2
        (i32.add
          (local.get $l2)
          (i32.const 9)))
      (br_if $L0
        (i32.ne
          (local.tee $l4
            (i32.add
              (local.get $l4)
              (i32.const 1)))
          (i32.const 9))))
    (if $I2
      (i32.gt_s
        (local.get $p0)
        (i32.const 0))
      (then
        (loop $L3
          (call $updateGrid
            (local.get $l1)
            (i32.const 9)
            (i32.const 9))
          (br_if $L3
            (local.tee $p0
              (i32.sub
                (local.get $p0)
                (i32.const 1)))))))
    (drop
      (call $displayGrid
        (local.get $l1)
        (i32.const 9)
        (i32.const 9)))
    (global.set $g0
      (i32.add
        (local.get $l1)
        (i32.const 96)))
    (i32.const 1120))
  (memory $memory (export "memory") 2)
  (global $g0 (mut i32) (i32.const 66752))
  (global $__dso_handle (export "__dso_handle") i32 (i32.const 1024))
  (global $__data_end (export "__data_end") i32 (i32.const 1201))
  (global $__stack_low (export "__stack_low") i32 (i32.const 1216))
  (global $__stack_high (export "__stack_high") i32 (i32.const 66752))
  (global $__global_base (export "__global_base") i32 (i32.const 1024))
  (global $__heap_base (export "__heap_base") i32 (i32.const 66752))
  (global $__heap_end (export "__heap_end") i32 (i32.const 131072))
  (global $__memory_base (export "__memory_base") i32 (i32.const 0))
  (global $__table_base (export "__table_base") i32 (i32.const 1))
  (data $d0 (i32.const 1024) "\01\01")
  (data $d1 (i32.const 1055) "\01\00\00\00\00\00\00\00\01\01\01\00\00\00\00\00\00\00\01"))
