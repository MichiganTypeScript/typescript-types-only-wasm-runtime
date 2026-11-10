(module
  (memory 1)
  (func (export "run") (param $n i32) (result i32)
    (local $i i32)
    (loop $top
      (i32.store8 (i32.add (i32.const 200) (local.get $i)) (i32.const 65))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n)))
    )
    (i32.load8_u (i32.const 200))
  )
)
