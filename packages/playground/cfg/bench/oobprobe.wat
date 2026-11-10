(module (memory 1)
  ;; store at an address the caller picks, then read it back
  (func (export "run") (param $a i32) (result i32)
    (i32.store (local.get $a) (i32.const 12345))
    (i32.load (local.get $a))))
