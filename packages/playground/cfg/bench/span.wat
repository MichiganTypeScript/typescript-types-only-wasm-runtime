(module (memory 2)
  ;; R_DrawSpan's inner loop, verbatim shape:
  ;; dest[i] = colormap[source[((yf>>10)&4032) + ((xf>>16)&63)]]
  ;; colormap 1000, source 1004, xstep 1008, ystep 1012 (memory-resident C globals)
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $d i32) (local $yf i32) (local $xf i32) (local $c i32)
    i32.const 1000 i32.const 8192 i32.store
    i32.const 1004 i32.const 12288 i32.store
    i32.const 1008 i32.const 70000 i32.store
    i32.const 1012 i32.const 30000 i32.store
    (loop $top
      (local.set $d (i32.const 4096))
      (local.set $yf (i32.const 0))
      (local.set $xf (i32.const 0))
      (local.set $c (i32.const -8))
      (loop $b
        local.get $d
        i32.const 0
        i32.load offset=1000
        i32.const 0
        i32.load offset=1004
        local.get $yf
        i32.const 10
        i32.shr_u
        i32.const 4032
        i32.and
        i32.add
        local.get $xf
        i32.const 16
        i32.shr_u
        i32.const 63
        i32.and
        i32.add
        i32.load8_u
        i32.add
        i32.load8_u
        i32.store8
        local.get $d
        i32.const 1
        i32.add
        local.set $d
        i32.const 0
        i32.load offset=1012
        local.get $yf
        i32.add
        local.set $yf
        i32.const 0
        i32.load offset=1008
        local.get $xf
        i32.add
        local.set $xf
        local.get $c
        i32.const 1
        i32.add
        local.tee $c
        br_if $b)
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n))))
    (local.get $i)))
