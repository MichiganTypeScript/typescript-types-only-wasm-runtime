(module (memory 1)
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (loop $top
      (local.set $acc (i32.load8_u (i32.add (i32.const 4096) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n))))
    (local.get $acc)))
