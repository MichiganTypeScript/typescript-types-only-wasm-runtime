(module
  (type $t0 (func (param i32) (result i32)))
  (type $t1 (func (result i32)))
  (memory $env.memory (import "env" "memory") 1)
  (func $frame (export "frame") (type $t0) (param $p0 i32) (result i32)
    (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32) (local $l11 i32) (local $l12 i32) (local $l13 i32)
    (block $B0
      (block $B1
        (br_if $B1
          (i32.load offset=8192
            (i32.const 0)))
        (local.set $p0
          (i32.const 52))
        (loop $L2
          (i32.store8
            (i32.add
              (local.get $p0)
              (i32.const 8192))
            (i32.const 32))
          (br_if $L2
            (i32.ne
              (local.tee $p0
                (i32.add
                  (local.get $p0)
                  (i32.const 1)))
              (i32.const 1012))))
        (local.set $p0
          (i32.const 72))
        (loop $L3
          (i32.store8
            (i32.add
              (local.get $p0)
              (i32.const 8192))
            (i32.const 124))
          (br_if $L3
            (i32.ne
              (local.tee $p0
                (i32.add
                  (local.get $p0)
                  (i32.const 40)))
              (i32.const 1032))))
        (local.set $p0
          (i32.const 0))
        (i32.store offset=8192
          (i32.const 0)
          (i32.const 1))
        (local.set $l2
          (i32.add
            (i32.mul
              (local.tee $l1
                (i32.load offset=8212
                  (i32.const 0)))
              (i32.const 40))
            (i32.const 8245)))
        (loop $L4
          (block $B5
            (br_if $B5
              (i32.gt_u
                (i32.add
                  (local.get $l1)
                  (local.get $p0))
                (i32.const 23)))
            (i32.store8
              (local.get $l2)
              (i32.const 61)))
          (local.set $l2
            (i32.add
              (local.get $l2)
              (i32.const 40)))
          (br_if $L4
            (i32.ne
              (local.tee $p0
                (i32.add
                  (local.get $p0)
                  (i32.const 1)))
              (i32.const 4))))
        (local.set $p0
          (i32.const 0))
        (local.set $l2
          (i32.add
            (i32.mul
              (local.tee $l1
                (i32.load offset=8216
                  (i32.const 0)))
              (i32.const 40))
            (i32.const 8282)))
        (loop $L6
          (block $B7
            (br_if $B7
              (i32.gt_u
                (i32.add
                  (local.get $l1)
                  (local.get $p0))
                (i32.const 23)))
            (i32.store8
              (local.get $l2)
              (i32.const 61)))
          (local.set $l2
            (i32.add
              (local.get $l2)
              (i32.const 40)))
          (br_if $L6
            (i32.ne
              (local.tee $p0
                (i32.add
                  (local.get $p0)
                  (i32.const 1)))
              (i32.const 4))))
        (local.set $p0
          (i32.const 0))
        (local.set $l3
          (i32.load offset=8200
            (i32.const 0)))
        (local.set $l4
          (i32.load offset=8196
            (i32.const 0)))
        (local.set $l5
          (i32.const 1))
        (loop $L8
          (local.set $l6
            (i32.add
              (i32.mul
                (local.tee $p0
                  (i32.add
                    (local.get $p0)
                    (local.get $l3)))
                (i32.const 40))
              (local.get $l4)))
          (local.set $l7
            (i32.gt_u
              (local.get $p0)
              (i32.const 23)))
          (local.set $l2
            (i32.const 1))
          (local.set $p0
            (i32.const 0))
          (loop $L9
            (block $B10
              (br_if $B10
                (local.get $l7))
              (br_if $B10
                (i32.gt_u
                  (i32.add
                    (local.get $p0)
                    (local.get $l4))
                  (i32.const 39)))
              (i32.store8 offset=8244
                (i32.add
                  (local.get $l6)
                  (local.get $p0))
                (i32.const 48)))
            (local.set $p0
              (i32.const 1))
            (local.set $l1
              (i32.and
                (local.get $l2)
                (i32.const 1)))
            (local.set $l2
              (i32.const 0))
            (br_if $L9
              (local.get $l1)))
          (local.set $p0
            (i32.const 1))
          (local.set $l2
            (i32.and
              (local.get $l5)
              (i32.const 1)))
          (local.set $l5
            (i32.const 0))
          (br_if $L8
            (local.get $l2))
          (br $B0)))
      (i32.store offset=8220
        (i32.const 0)
        (local.tee $l6
          (i32.load offset=8196
            (i32.const 0))))
      (i32.store offset=8224
        (i32.const 0)
        (local.tee $l8
          (i32.load offset=8200
            (i32.const 0))))
      (i32.store offset=8228
        (i32.const 0)
        (local.tee $l9
          (i32.load offset=8212
            (i32.const 0))))
      (i32.store offset=8232
        (i32.const 0)
        (local.tee $l10
          (i32.load offset=8216
            (i32.const 0))))
      (block $B11
        (block $B12
          (block $B13
            (br_if $B13
              (i32.ne
                (local.get $p0)
                (i32.const 1)))
            (local.set $l2
              (i32.const -1))
            (br_if $B12
              (i32.gt_s
                (local.get $l9)
                (i32.const 0))))
          (local.set $l11
            (local.get $l9))
          (br_if $B11
            (i32.ne
              (local.get $p0)
              (i32.const 2)))
          (local.set $l2
            (i32.const 1))
          (local.set $l11
            (local.get $l9))
          (br_if $B11
            (i32.gt_s
              (local.get $l9)
              (i32.const 19))))
        (i32.store offset=8212
          (i32.const 0)
          (local.tee $l11
            (i32.add
              (local.get $l2)
              (local.get $l9)))))
      (local.set $l2
        (i32.sub
          (local.tee $l1
            (i32.add
              (local.get $l10)
              (local.tee $p0
                (i32.and
                  (i32.lt_s
                    (local.get $l10)
                    (i32.const 20))
                  (i32.lt_s
                    (local.tee $l2
                      (i32.add
                        (local.get $l10)
                        (i32.const 2)))
                    (local.get $l8))))))
          (local.tee $l1
            (i32.and
              (i32.gt_s
                (select
                  (i32.add
                    (local.get $l10)
                    (i32.const 3))
                  (local.get $l2)
                  (local.get $p0))
                (local.get $l8))
              (i32.gt_s
                (local.get $l1)
                (i32.const 0))))))
      (block $B14
        (block $B15
          (br_if $B15
            (local.get $p0))
          (local.set $l12
            (local.get $l10))
          (br_if $B14
            (i32.eqz
              (local.get $l1))))
        (i32.store offset=8216
          (i32.const 0)
          (local.get $l2))
        (local.set $l12
          (local.get $l2)))
      (local.set $l4
        (i32.lt_s
          (local.tee $l1
            (select
              (local.tee $p0
                (i32.add
                  (i32.load offset=8208
                    (i32.const 0))
                  (local.get $l8)))
              (i32.const 0)
              (i32.gt_s
                (local.get $p0)
                (i32.const 0))))
          (i32.const 22)))
      (local.set $l7
        (i32.add
          (i32.load offset=8204
            (i32.const 0))
          (local.get $l6)))
      (block $B16
        (br_if $B16
          (i32.lt_u
            (local.get $p0)
            (i32.const 23)))
        (i32.store offset=8208
          (i32.const 0)
          (select
            (i32.const -1)
            (i32.const 1)
            (i32.gt_s
              (local.get $p0)
              (i32.const 22)))))
      (local.set $l13
        (select
          (local.get $l1)
          (i32.const 22)
          (local.get $l4)))
      (block $B17
        (block $B18
          (block $B19
            (block $B20
              (block $B21
                (block $B22
                  (br_if $B22
                    (i32.gt_s
                      (local.get $l7)
                      (i32.const 2)))
                  (br_if $B21
                    (i32.le_s
                      (i32.add
                        (local.get $l13)
                        (i32.const 2))
                      (local.get $l11)))
                  (br_if $B21
                    (i32.ge_s
                      (local.get $l13)
                      (i32.add
                        (local.get $l11)
                        (i32.const 4))))
                  (local.set $l7
                    (i32.const 3))
                  (local.set $p0
                    (i32.const 1))
                  (br $B18))
                (br_if $B17
                  (i32.lt_u
                    (local.get $l7)
                    (i32.const 36)))
                (local.set $p0
                  (i32.const -1))
                (br_if $B20
                  (i32.le_s
                    (i32.add
                      (local.get $l13)
                      (i32.const 2))
                    (local.get $l2)))
                (br_if $B20
                  (i32.ge_s
                    (local.get $l13)
                    (i32.add
                      (local.get $l2)
                      (i32.const 4))))
                (local.set $l7
                  (i32.const 36))
                (br $B18))
              (br_if $B17
                (i32.gt_s
                  (local.get $l7)
                  (i32.const -1)))
              (local.set $p0
                (i32.const 1))
              (i32.store offset=8240
                (i32.const 0)
                (i32.add
                  (i32.load offset=8240
                    (i32.const 0))
                  (i32.const 1)))
              (br $B19))
            (br_if $B17
              (i32.lt_u
                (local.get $l7)
                (i32.const 39)))
            (i32.store offset=8236
              (i32.const 0)
              (i32.add
                (i32.load offset=8236
                  (i32.const 0))
                (i32.const 1))))
          (local.set $l13
            (i32.const 12))
          (local.set $l7
            (i32.const 20)))
        (i32.store offset=8204
          (i32.const 0)
          (local.get $p0)))
      (local.set $p0
        (i32.const 0))
      (i32.store offset=8200
        (i32.const 0)
        (local.get $l13))
      (i32.store offset=8196
        (i32.const 0)
        (local.get $l7))
      (local.set $l3
        (i32.const 1))
      (loop $L23
        (local.set $l5
          (i32.mul
            (local.tee $p0
              (i32.add
                (local.get $p0)
                (local.get $l8)))
            (i32.const 40)))
        (local.set $l4
          (i32.gt_u
            (local.get $p0)
            (i32.const 23)))
        (local.set $p0
          (i32.const 1))
        (local.set $l1
          (i32.const 0))
        (loop $L24
          (block $B25
            (br_if $B25
              (local.get $l4))
            (br_if $B25
              (i32.gt_u
                (local.tee $l2
                  (i32.add
                    (local.get $l1)
                    (local.get $l6)))
                (i32.const 39)))
            (i32.store8 offset=8244
              (i32.add
                (local.get $l2)
                (local.get $l5))
              (select
                (i32.const 124)
                (i32.const 32)
                (i32.eq
                  (local.get $l2)
                  (i32.const 20)))))
          (local.set $l1
            (i32.const 1))
          (local.set $l2
            (i32.and
              (local.get $p0)
              (i32.const 1)))
          (local.set $p0
            (i32.const 0))
          (br_if $L24
            (local.get $l2)))
        (local.set $p0
          (i32.const 1))
        (local.set $l2
          (i32.and
            (local.get $l3)
            (i32.const 1)))
        (local.set $l3
          (i32.const 0))
        (br_if $L23
          (local.get $l2)))
      (block $B26
        (br_if $B26
          (i32.eq
            (local.get $l9)
            (local.get $l11)))
        (local.set $l2
          (i32.add
            (i32.mul
              (local.get $l9)
              (i32.const 40))
            (i32.const 8245)))
        (local.set $p0
          (i32.const 0))
        (loop $L27
          (block $B28
            (br_if $B28
              (i32.gt_u
                (i32.add
                  (local.get $l9)
                  (local.get $p0))
                (i32.const 23)))
            (i32.store8
              (local.get $l2)
              (i32.const 32)))
          (local.set $l2
            (i32.add
              (local.get $l2)
              (i32.const 40)))
          (br_if $L27
            (i32.ne
              (local.tee $p0
                (i32.add
                  (local.get $p0)
                  (i32.const 1)))
              (i32.const 4)))))
      (block $B29
        (br_if $B29
          (i32.eq
            (local.get $l10)
            (local.get $l12)))
        (local.set $l2
          (i32.add
            (i32.mul
              (local.get $l10)
              (i32.const 40))
            (i32.const 8282)))
        (local.set $p0
          (i32.const 0))
        (loop $L30
          (block $B31
            (br_if $B31
              (i32.gt_u
                (i32.add
                  (local.get $l10)
                  (local.get $p0))
                (i32.const 23)))
            (i32.store8
              (local.get $l2)
              (i32.const 32)))
          (local.set $l2
            (i32.add
              (local.get $l2)
              (i32.const 40)))
          (br_if $L30
            (i32.ne
              (local.tee $p0
                (i32.add
                  (local.get $p0)
                  (i32.const 1)))
              (i32.const 4)))))
      (local.set $l2
        (i32.add
          (i32.mul
            (local.get $l11)
            (i32.const 40))
          (i32.const 8245)))
      (local.set $p0
        (i32.const 0))
      (loop $L32
        (block $B33
          (br_if $B33
            (i32.gt_u
              (i32.add
                (local.get $l11)
                (local.get $p0))
              (i32.const 23)))
          (i32.store8
            (local.get $l2)
            (i32.const 61)))
        (local.set $l2
          (i32.add
            (local.get $l2)
            (i32.const 40)))
        (br_if $L32
          (i32.ne
            (local.tee $p0
              (i32.add
                (local.get $p0)
                (i32.const 1)))
            (i32.const 4))))
      (local.set $l2
        (i32.add
          (i32.mul
            (local.get $l12)
            (i32.const 40))
          (i32.const 8282)))
      (local.set $p0
        (i32.const 0))
      (loop $L34
        (block $B35
          (br_if $B35
            (i32.gt_u
              (i32.add
                (local.get $l12)
                (local.get $p0))
              (i32.const 23)))
          (i32.store8
            (local.get $l2)
            (i32.const 61)))
        (local.set $l2
          (i32.add
            (local.get $l2)
            (i32.const 40)))
        (br_if $L34
          (i32.ne
            (local.tee $p0
              (i32.add
                (local.get $p0)
                (i32.const 1)))
            (i32.const 4))))
      (local.set $p0
        (i32.const 0))
      (local.set $l6
        (i32.const 1))
      (loop $L36
        (local.set $l4
          (i32.add
            (i32.mul
              (i32.add
                (local.get $p0)
                (local.get $l13))
              (i32.const 40))
            (local.get $l7)))
        (local.set $l2
          (i32.const 1))
        (local.set $p0
          (i32.const 0))
        (loop $L37
          (block $B38
            (br_if $B38
              (i32.gt_u
                (i32.add
                  (local.get $p0)
                  (local.get $l7))
                (i32.const 39)))
            (i32.store8 offset=8244
              (i32.add
                (local.get $l4)
                (local.get $p0))
              (i32.const 48)))
          (local.set $p0
            (i32.const 1))
          (local.set $l1
            (i32.and
              (local.get $l2)
              (i32.const 1)))
          (local.set $l2
            (i32.const 0))
          (br_if $L37
            (local.get $l1)))
        (local.set $p0
          (i32.const 1))
        (local.set $l2
          (i32.and
            (local.get $l6)
            (i32.const 1)))
        (local.set $l6
          (i32.const 0))
        (br_if $L36
          (local.get $l2))))
    (i32.const 8244))
  (func $score1 (export "score1") (type $t1) (result i32)
    (i32.load offset=8236
      (i32.const 0)))
  (func $score2 (export "score2") (type $t1) (result i32)
    (i32.load offset=8240
      (i32.const 0)))
  (table $T0 1 1 funcref)
  (global $g0 (mut i32) (i32.const 8192))
  (data $d0 (i32.const 8192) "\00\00\00\00\14\00\00\00\0c\00\00\00\01\00\00\00\01\00\00\00\0a\00\00\00\0a\00\00\00\14\00\00\00\0c\00\00\00\0a\00\00\00\0a\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00"))
