(module (memory 1)
  (func $FixedDiv2 (param i32 i32) (result i32)
    (local i32 i32 i32 i32 i32 i32)
    i32.const 31
    local.set 2
    local.get 1
    local.get 1
    i32.const 31
    i32.shr_s
    local.tee 3
    i32.xor
    local.get 3
    i32.sub
    local.set 4
    local.get 0
    local.get 0
    i32.const 31
    i32.shr_s
    local.tee 3
    i32.xor
    local.get 3
    i32.sub
    local.tee 3
    i32.const 16
    i32.shl
    local.set 5
    local.get 3
    i32.const 16
    i32.shr_u
    local.set 3
    i32.const 0
    local.set 6
    loop (result i32)  ;; label = @1
      block  ;; label = @2
        local.get 2
        i32.const -1
        i32.gt_s
        br_if 0 (;@2;)
        i32.const 0
        local.get 6
        i32.sub
        local.get 6
        local.get 1
        local.get 0
        i32.xor
        i32.const 0
        i32.lt_s
        select
        return
      end
      local.get 3
      i32.const 1
      i32.shl
      local.get 5
      local.get 2
      i32.shr_u
      i32.const 1
      i32.and
      i32.or
      local.tee 7
      i32.const 0
      local.get 4
      local.get 3
      i32.const -1
      i32.gt_s
      local.get 7
      local.get 4
      i32.lt_u
      i32.and
      local.tee 7
      select
      i32.sub
      local.set 3
      i32.const 0
      i32.const 1
      local.get 2
      i32.shl
      local.get 7
      select
      local.get 6
      i32.or
      local.set 6
      local.get 2
      i32.const -1
      i32.add
      local.set 2
      br 0 (;@1;)
    end)

  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (loop $top
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $acc (i32.add (local.get $acc)
        (call $FixedDiv2 (i32.mul (local.get $i) (i32.const 123457)) (i32.add (i32.mul (local.get $i) (i32.const 3011)) (i32.const 77)))))
      (br_if $top (i32.lt_s (local.get $i) (local.get $n))))
    (local.get $acc)))
