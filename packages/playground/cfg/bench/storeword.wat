(module (memory 1)
  (func (export "run") (param $n i32) (result i32)
    (local $i i32)
    (loop $top
      (i32.store (i32.add (i32.const 4096) (i32.shl (local.get $i) (i32.const 2))) (i32.const 1094795585))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n))))
    (local.get $i)))
