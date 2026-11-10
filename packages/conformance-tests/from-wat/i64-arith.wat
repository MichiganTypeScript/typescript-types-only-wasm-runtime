;; 64-bit add, subtract and multiply, reached through i32 params so the
;; conformance runner can compare every one of them against the engine.
;;
;; doom's renderer is full of the last one: a fixed-point multiply is
;; `(i64)a * (i64)b >> 16` wrapped back to i32, and it is on the path of every
;; scaled column it draws.
(module
  (func $mul_fixed (export "mul_fixed") (param $a i32) (param $b i32) (result i32)
    (i32.wrap_i64
      (i64.shr_u
        (i64.mul
          (i64.extend_i32_s (local.get $a))
          (i64.extend_i32_s (local.get $b)))
        (i64.const 16))))

  (func $add64 (export "add64") (param $a i32) (param $b i32) (result i32)
    (i32.wrap_i64
      (i64.add
        (i64.extend_i32_s (local.get $a))
        (i64.extend_i32_s (local.get $b)))))

  (func $sub64 (export "sub64") (param $a i32) (param $b i32) (result i32)
    (i32.wrap_i64
      (i64.sub
        (i64.extend_i32_s (local.get $a))
        (i64.extend_i32_s (local.get $b)))))

  ;; the high half, so a carry out of bit 31 cannot hide
  (func $add64_hi (export "add64_hi") (param $a i32) (param $b i32) (result i32)
    (i32.wrap_i64
      (i64.shr_u
        (i64.add
          (i64.extend_i32_u (local.get $a))
          (i64.extend_i32_u (local.get $b)))
        (i64.const 32))))

  (func $mul64_hi (export "mul64_hi") (param $a i32) (param $b i32) (result i32)
    (i32.wrap_i64
      (i64.shr_u
        (i64.mul
          (i64.extend_i32_u (local.get $a))
          (i64.extend_i32_u (local.get $b)))
        (i64.const 32))))

  ;; Products big enough to reach the high half. The sample arguments the runner
  ;; uses are all small, and a 64-bit shift that keeps the wrong end of the
  ;; string still looks right while every term fits in 32 bits - this is the
  ;; shape doom actually hits, and it is what caught it.
  (func $mul_big (export "mul_big") (param $a i32) (result i32)
    (i32.wrap_i64
      (i64.shr_u
        (i64.mul
          (i64.extend_i32_u (i32.add (local.get $a) (i32.const 42958)))
          (i64.const 8388608))
        (i64.const 16))))

  (func $mul_big_hi (export "mul_big_hi") (param $a i32) (result i32)
    (i32.wrap_i64
      (i64.shr_u
        (i64.mul
          (i64.extend_i32_u (i32.add (local.get $a) (i32.const 305419896)))
          (i64.extend_i32_u (i32.const 2596069104)))
        (i64.const 32))))

  (func $shl_far (export "shl_far") (param $a i32) (result i32)
    (i32.wrap_i64
      (i64.shr_u
        (i64.shl
          (i64.extend_i32_u (local.get $a))
          (i64.const 40))
        (i64.const 40))))
)
