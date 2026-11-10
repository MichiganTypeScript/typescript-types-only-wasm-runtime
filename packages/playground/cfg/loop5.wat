(module
  (memory 1)
  (data (i32.const 100) "\07\00\00\00")
  (func (export "run") (param $n i32) (result i32)
    (local $i i32)
    (local $sum i32)
    (loop $top
      ;; mem[200 + i*4] = i * 3
      (i32.store
        (i32.add (i32.const 200) (i32.mul (local.get $i) (i32.const 4)))
        (i32.mul (local.get $i) (i32.const 3)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n)))
    )
    ;; sum = mem[200] + mem[208] + mem[100] + byte at 101
    (local.set $sum (i32.add (i32.load (i32.const 208)) (i32.load (i32.const 100))))
    (i32.store8 (i32.const 301) (i32.const 0x2a))
    (i32.add (local.get $sum) (i32.load8_u (i32.const 301)))
  )
)
