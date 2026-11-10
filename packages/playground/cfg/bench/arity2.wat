(module (memory 1)
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $x0 i32) (local $x1 i32)
    (local.set $x0 (i32.const 1))
      (local.set $x1 (i32.const 2))
    (loop $top
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n))))
    (i32.add (local.get $x0) (local.get $x1))))
