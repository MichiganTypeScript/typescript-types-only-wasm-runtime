(module (memory 2)
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $d i32) (local $s i32) (local $c i32)
    (loop $top
      (local.set $d (i32.const 4096))
      (local.set $s (i32.const 70000))
      (local.set $c (i32.const 64))
      (block $done
        (loop $b
          (br_if $done (i32.eqz (local.get $c)))
          (i32.store8 (local.get $d) (i32.load8_u (local.get $s)))
          (local.set $d (i32.add (local.get $d) (i32.const 320)))
          (local.set $s (i32.add (local.get $s) (i32.const 1)))
          (local.set $c (i32.add (local.get $c) (i32.const -1)))
          (br $b)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n))))
    (local.get $i)))
