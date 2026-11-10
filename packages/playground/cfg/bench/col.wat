(module (memory 2)
  ;; R_DrawColumn's inner loop, verbatim shape: dest = colormap[source[(frac>>16)&127]]
  ;; colormap ptr at 1000, source ptr at 1004 (memory-resident C globals)
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $d i32) (local $frac i32) (local $step i32) (local $c i32)
    i32.const 1000 i32.const 8192 i32.store
    i32.const 1004 i32.const 12288 i32.store
    (loop $top
      (local.set $d (i32.const 4096))
      (local.set $frac (i32.const 0))
      (local.set $step (i32.const 100000))
      (local.set $c (i32.const -8))
      (loop $b
        local.get $d
        i32.const 0
        i32.load offset=1000
        i32.const 0
        i32.load offset=1004
        local.get $frac
        i32.const 16
        i32.shr_u
        i32.const 127
        i32.and
        i32.add
        i32.load8_u
        i32.add
        i32.load8_u
        i32.store8
        local.get $frac
        local.get $step
        i32.add
        local.set $frac
        local.get $d
        i32.const 320
        i32.add
        local.set $d
        local.get $c
        i32.const 1
        i32.add
        local.tee $c
        br_if $b)
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n))))
    (local.get $i)))
