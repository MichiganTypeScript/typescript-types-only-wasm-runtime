;; A table whose slots mix an *imported* function with defined ones.
;;
;; An imported function has no body to inline, so the AOT dispatch has to leave
;; its slot as a trap rather than routing it to some defined function's impl.
;; Every checked-in module happens to have an import-free table, so without this
;; fixture the "skip imports" branch of emit_indirect_dispatch is never taken.
(module
  (type $t0 (func (param i32 i32) (result i32)))

  (import "env" "imported_add" (func $imported_add (type $t0)))

  (func $add (type $t0) (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.add
  )

  (func $multiply (type $t0) (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.mul
  )

  (table $T0 3 3 funcref)

  ;; slot 0 -> the import (must trap), slot 1 -> $add, slot 2 -> $multiply
  (elem $e0 (i32.const 0) func $imported_add $add $multiply)

  (func $entry (export "entry") (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.const 1
    call_indirect $T0 (type $t0)

    local.get $a
    local.get $b
    i32.const 2
    call_indirect $T0 (type $t0)

    i32.add
  )
)
