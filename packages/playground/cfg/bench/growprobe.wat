(module (memory 1)
  ;; grow by one page, then touch the caller's address. Addresses in the second
  ;; page are out of bounds before the grow and in bounds after it.
  (func (export "run") (param $a i32) (result i32)
    (drop (memory.grow (i32.const 1)))
    (i32.store (local.get $a) (i32.const 12345))
    (i32.load (local.get $a))))
