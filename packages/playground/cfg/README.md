# Running pong inside the type checker

`pnpm arcade` compiles `pong-tiny.wasm` into TypeScript types and plays it. Each
frame is **one type evaluation**: the host hands the previous frame's memory in
as a type argument, `tsgo` computes the next frame, and the bytes that come back
are drawn. Roughly **18 frames per second** for the character version, **25-33**
for the pixel one.

![pixel pong, every frame computed by the TypeScript type checker](../../../docs/pixel-pong.gif)

That is a real framebuffer: 64x48 bytes of palette index, living in the wasm
memory the checker hands back each frame, recorded straight out of a run with
`GIF=docs/pixel-pong.gif pnpm gfx`. Nothing in the picture is drawn by the host -
it maps indices to colours and nothing else.

```
  pong, running inside the TypeScript type checker
  +----------------------------------------+
  |                    |                   |
  | =                  |                   |
  | =                  |         00      = |
  | =                  |         00      = |
  |                    |                 = |
  +----------------------------------------+
  0 - 0   frame 12   3.7 fps   1 evaluation   state 9.5kB
```

- `pnpm gfx` - play the pixel version (`w`/`s` to move, `q` to quit)
- `pnpm gfx:verify` - compare all 3072 pixels against V8, frame by frame
- `pnpm arcade` - play the character version
- `pnpm arcade:verify` - run the same wasm in V8 and compare every frame byte for byte
- `pnpm arcade:conform` - compile and check every module in `conformance-tests` against the engine
- `pnpm arcade:ceiling` - measure how much work one type evaluation can do

Current state: **69/69 supported modules and every pong frame are identical to
the wasm engine** (`pnpm arcade:conform`), conway included. Unsupported so far:
i64, floats, and imported-function calls; `call_indirect` works.

Memory accesses trap where the engine traps. An access that runs past the end of
memory used to succeed quietly - a store landed, a load returned zero - so
`storechain8`, which strides 512 bytes from 4096, ran long after it had left its
one declared page and the engine had stopped. `bounds.test.ts` pins both bound
shapes, which are separate paths in the compiler: a memory the module owns and
never grows is bounded at compile time, and a growing one is checked against the
live page count.

The bound is not the declared size when the memory is **imported**. A declared
size is the minimum the host must supply, not a limit: doom asks for 72 pages and
needs 128 - at 72 the real engine traps inside `entry` - so an imported memory is
bounded by its declared maximum, or by what the trie can address when it states
none. Note this is deliberately not the number `memory.size` reports, which has
to stay the declared minimum or doom's allocator puts its zone in the wrong place.

The check is characters, not arithmetic. `I32Add` + `I32LtU` per access cost 4-6x
on the storechain fixtures; comparing the address's leading characters against a
power-of-two limit is a template-literal match, which is free (measured: 658537
instantiations, the same as merely mentioning the address). Hiding the arithmetic
in a conditional's untaken branch does *not* work - tsc instantiates it anyway.
Overhead is now 15-30%, and doom is unchanged at 8 chunks in 37.4s against 36.6s.

What `arcade:conform` actually compares was widened, and it found five bugs that
the old version passed:

- It compared only the returned i32. A wasm function's memory is most of what it
  does - `memory-overwrite.wat` stores, loads, multiplies and stores again - so
  it now decodes the state trie and compares **every word** against the engine's
  linear memory.
- Every export was called once with a first argument of `0`, which makes stores
  invisible: storing zero over zero changes nothing. It now runs three argument
  vectors, none starting at zero, with mixed signs.
- `i32.shl`, `i32.shr_s`, `i32.shr_u` and `i32.rotl` did not mask their shift
  count. wasm masks it to 5 bits, so `7 << -3` is `7 << 29`; without the mask
  the count matched no branch of the shift table and the whole operation was
  `never`. Measured: `single-i32shl.wat` `entry(7, -3)` failed with "return
  value is not a word: never" where the engine gives 536870912.
- `i32.rotr` had **no implementation at all**: the compiler emitted
  `Wasm.I32Rotr` and ts-type-math never declared it, so any module using it
  failed to resolve. `single-i32rotr.wat` is a new case covering it.

Running out of chunks is now reported separately from a wrong answer. Two conway
calls take arguments like `rows = 2147483647`, a two-billion-iteration loop that
the engine walks in a second and this runtime cannot finish; counting that as a
mismatch buries real ones.

## How it works

`cargo run -- --aot-cfg module.wasm` writes `module.cfg.ts`. Every wasm basic
block becomes a type; `br`, `br_if`, `br_table` and loop back-edges become tail
calls to those types; `if`/`else` join through a shared continuation. Nothing is
"skipped forward N ends" - the control flow graph is real, which is why loops and
nested branches behave.

Each block takes `(fuel, memory, globals, locals, stack)` and returns either

- `['r', memory, value?]` - the function returned, or
- `['s', 'fn_block', memory, ...live values]` - it ran out of fuel

On suspend the host re-enters the named block with fresh fuel, so a run of any
length is a sequence of bounded evaluations. `drive.ts` does that; `trie.ts`
decodes the memory that comes back.

## Three things had to be measured, not guessed

**Memory cannot be an intersection.** `S['memory'] & Record<Addr, Value>` looks
right and is unusable: intersecting two different literals for one address gives
`never`, so the *second* write to a word poisons it - and `i32.store8` is a
read-modify-write, so four byte stores into one word are enough. Memory is a
sparse 8-way trie keyed by address bits instead, which is why a write is
`$Put` and not an intersection.

**The state has to come back as printable text, and the printer gives up before
the checker does.** With a 14-level binary trie the *type* was always correct -
960 stores in one evaluation, every byte verified - but the type *printer* elides
deeply nested parts, printing them as `any`. Pasting that back silently corrupted
memory: a whole subtree of the screen would revert. An 8-way trie is 5 levels
deep, which prints cleanly, and `drive.ts` now validates every chunk against
exactly what the compiler is supposed to emit and refuses anything else.

**Depth is spent on nesting, not on work.** `I32Add<I32Add<..>,..>` inside
`$Store8` inside `$Put` stacks each operator's ~32 levels of bit recursion into
one chain, and ts-type-math raises TS2589 long before a block finishes. The
compiler emits SSA - every intermediate value gets a name - so a block is a flat
sequence of conditionals. After that, one evaluation handles 960 stores.

The speed came from the same observation applied to memory access: a byte store
is not arithmetic, it is *string surgery*. `$Off` reads the low two bits of an
address as the last two characters of its 32-character string, and `$SetByte`
splices eight characters into a word. No shifting, no masking, no adders. That
took pong's first frame from 26 evaluations and 5.5s down to one evaluation at
0.27s.

## Calls

An exported function is compiled *metered*: its blocks charge fuel and can
suspend. Anything it calls is compiled again in an *unmetered* flavour (`$u...`)
that runs to completion inside the caller's evaluation and hands back
`['r', memory, ...globals, value?]`, so a callee's writes to memory and to
globals are not lost. Suspending in the middle of a call would need a call stack
in the state, so for now a callee has to fit in one evaluation - fine for
conway's helpers, not yet enough for something as deep as DOOM.

## What an operation costs

`pnpm tsx packages/playground/cfg/bench.ts` times a 200-iteration wasm loop per
operation. Marginal cost of one operation, inside one evaluation:

| operation | µs |
| --- | --- |
| empty loop iteration (hop + add + compare) | ~157 |
| `i32.and` with a constant | ~10 |
| `i32.add` | ~50 |
| `i32.load8_u` | ~200 |
| `i32.store8` | ~210 |

The useful surprise: **the algorithm barely matters, the instantiation does.** A
hand-written 32-bit adder built from nibble lookup tables measured *slower* than
ts-type-math walking all 32 bits (130µs vs 110µs), and a hand-written comparison
lost too. What wins is collapsing an operation into a *single* template-literal
conditional - masks and constant shifts drop from ~100µs to ~10µs, and equality
becomes `A extends B`, no pattern at all. So the compiler specialises exactly
those and leaves the rest to ts-type-math.

A steady pong frame is ~120 hops and ~900 primitive operations. Getting
meaningfully faster needs *fewer operations*, not a faster adder.

## The thing that actually cost the most

A block is a chain of nested `infer`s, one per instruction:

```ts
Op<...> extends infer $t0 extends WasmValue
? Op<$t0, ...> extends infer $t1 extends WasmValue
? ...
```

The checker resolves that shape in time **exponential in its depth**. Measured on
a chain of i32 adds (`probes/probe-depth-run.ts`):

| depth | time |
| --- | --- |
| 8 | 6ms |
| 16 | 19ms |
| 18 | 57ms |
| 20 | 213ms |
| 22 | 798ms |
| 24 | 3214ms |
| 32 | did not finish in 17 minutes |

So a long basic block is not slow, it is fatal, and nothing stops a program from
having one. Blocks now cut themselves in two every 6 instructions and hand the
rest to a fresh block, which costs one hop (~200µs) and buys back an unbounded
amount. That one change took the worst benchmark from 1728µs an iteration to
182µs, and pong from 4.6 to 18 fps. The old ceiling had been luck: these
programs happened to top out at 17-deep blocks, just under the knee.

There is a way out of the shape entirely. Threading state through *alias
applications* instead of nested infers is linear - 128 sequenced adds in 17ms,
against 3214ms for 24 of them nested (`probes/probe-pipeline-run.ts`):

```ts
type $p0<$S extends $State> = [...$S, Wasm.I32Add<$S[3], $S[4]>]
$p2<$p1<$p0<[$M, $l0, $k0]>>> extends infer $S extends $State ? ... : never
```

That is now what a long block compiles to. Memory sits in slot 0 and a store
replaces it in place (`[$Store32<$S[0], ...>, ...$Rest<$S>]`); every other
instruction appends its result, and later instructions read it back as `$S[7]`.
The state is typed `[$Node, ...WasmValue[]]`, so a read needs no narrowing.

Branches come out of the same idea, and it is the sharper half of it. A
conditional is the shape that explodes, but indexing an object type picks an arm
without one, and only the arm you index is resolved:

```ts
cond extends '1' ? Then : Else        // nests
{ '1': Then, '0': Else }[cond]        // does not
```

Measured over a chain of branches each feeding the next
(`probes/probe-object-run.ts`):

| branches in a row | nested conditional | object index |
| --- | --- | --- |
| 8 | 7ms | 5ms |
| 16 | 10,359ms | 6ms |
| 20 | 821,726ms | 6ms |
| 24 | did not attempt | 7ms |

137,000x at twenty branches, and flat as far as it was measured. Worth knowing
that a conditional *inside* one of these steps is free - what compounds is
lexical nesting within a single type expression, not conditionals as such.

### Where it actually helps, which is not where I expected

Rendered as a pipeline at the *same* block boundaries, the games got slower, not
faster: gfx ran 16.8 frames a second nested against 10.4 as a pipeline. Below
about sixteen instructions, appending to the state tuple costs more per
instruction than one more `infer` does. The pipeline is only worth its overhead
once a block is long.

And these blocks are never long, because of a second limit that turns out to
bind first. Inside a block the memory is an unevaluated
`$Store32<$Store32<...>>` chain, and every later load walks it. Letting a block
hold eight memory operations instead of two took a gfx frame from 0.17s to
3.44s. Memory-touching blocks therefore still cut every 6 instructions, exactly
as before; a run of pure arithmetic, which builds no such chain, is allowed to
reach 64 and is rendered as a pipeline. gfx 17.7 fps, pong-tiny 20.4.

So the honest summary: the exponential in block length is now gone, and what
remains is a *memory* cost that the pipeline does nothing about. Fewer, cheaper
memory operations per frame is the next thing worth doing, not a wider block.

One attempt at that failed in a way worth keeping. A byte store is a read, a
splice and a write - two walks down the trie for one pixel - and fusing them
into a single descent that splices the leaf in place is obviously fewer
operations. It took pong-tiny from 19.9 frames a second to 12.5, three times,
consistently. The reason is that the spliced word is then stored *unevaluated*
inside the node: what the trie holds is a pending `$SetByte<...>` rather than 32
characters, and every later read of that word carries the expression along.
Values written into memory have to be flat. Fewer operations is not the same
thing as less work when the work can be deferred into the data.

## What is not true

Type arguments are not individually expensive, which is worth stating because
the opposite is easy to conclude. A loop carrying 20 string parameters costs the
same per iteration as one carrying 2 (`probes/probe-arity-run.ts`); an earlier
measurement suggesting ~90µs per argument turned out to be a fixed cost hiding
in a deep block, and the fix was the depth cap, not the arity. Passing fewer
locals per block still helps - about 25% - by shrinking the state threaded
through every hop and rebuilt in every suspend payload, not by saving a
per-argument fee.

Fuel length is free too: padding the fuel string by 16,000 characters changes
nothing measurable.

A hot-word register cache is not worth building. Instrumenting every memory op
in the native build of a real gameplay frame (243k ops after the fused loops
already absorbed the pixel walks): the top 16 words cover 25.1% of traffic, and
the top 256 still only 36.5%. The residue is flat. What concentration exists is
per-pixel reloads inside `R_DrawColumnLow`/`R_DrawSpanLow` - loads the `Tex`
fusion already reads once per loop at the type level - so the cacheable share
was spent before the cache could exist.

## Writing a game for this machine

The compiler is only half of it; the program can be shaped for the costs above.
The pixel game does three things a normal pong would not:

- **paddles four pixels wide and four-aligned.** A whole word costs one store,
  the same as one byte, because memory is a trie of 32-bit words and touching
  one byte means read, splice, write. Ten stores instead of forty.
- **the centre line precomputed into a table.** `(y / 3) % 2` per row per frame
  becomes one load per row, and only the rows the ball wiped are repainted.
- **delta redraw.** The court is painted once; each frame erases the previous
  ball and paddles and draws the new ones, so a steady frame is ~40 stores
  regardless of screen size.

Steady frame 0.06s -> 0.03s, with every pixel still identical to V8.

Unrolling the sprite loops took the work in a frame from 278 units to 102 - a
paddle row inside a loop costs the store plus a compare, an increment and a
jump, while unrolled the row offsets fold into the store instruction. The frame
time did not move. Fuel counts hops and stores, not arithmetic, and what
unrolling removed were the cheap units; a store at ~200µs is now most of a
frame. Worth keeping for the headroom, not for the clock.

Five other things that did not work, recorded so they are not tried twice.
All five were measured on the same E1M1 frame, from a checkpoint built by a
native run, view size 3, fuel 16000, ~100-110s a frame:

- **a wider trie.** 32-way, three levels deep, against 8-way at five: 0.04s a
  frame against 0.03s. Rebuilding a 32-element node costs more than the two
  levels it saves. `TRIE_DIGIT_BITS` sweeps it.
- **a table-driven FixedMul.** `(a*b)>>16` as sixteen byte-product lookups
  and ten adds instead of the generic 64-bit shift-add multiply. 5x fewer
  instantiations for the helper, and 103.0s a frame against 97.8s without it.
  doom's FixedMul arguments are mostly small, and the generic loop stops at
  the multiplier's last one bit, so the table is not competing with 20k
  instantiations - it is competing with a few hundred.
- **a narrower trie.** 16-way and 32-way against the 64-way in use, with a
  checkpoint rebuilt at each shape: 99.0s, 106.5s, 99.1s. Levels and fanout
  trade off almost exactly.
- **a two-level write buffer.** The buffer is one row of 64 slots and a store
  rewrites the row; splitting it 8x8 so a store rewrites one group and one
  slot took a store from 540 instantiations to 205, and the frame from 108.7s
  to 108.2s - which is noise. Instantiation count is not what the clock
  measures here: a chunk's profile is ~31% `getConditionalFlowTypeOfType`
  (the checker walking a node's enclosing conditionals) and ~35% Go GC, so
  what costs time is conditional evaluations and template-literal matches,
  not the tuple elements a mapped type copies.

- **blaming the infer constraint.** `infer $t extends WasmValue`, `infer $t
  extends string` and a plain `infer $t` all explode identically with depth
  (~3.2s at 24). The nesting is the problem, not the constraint.

- **a table-driven unsigned compare.** `lt_u`/`gt_u` as four 8-bit lookups in
  a 65k-key `CmpByte` table instead of the bit-at-a-time recursion. On a loop
  micro-bench (`i=i+1; br_if i<n`) it cut 455 to 269 instantiations an
  iteration. On a real gameplay chunk: 25.78M to 25.70M instantiations, and
  the check went from 17.2s to 18.5-19.8s with +72MB. Compares are too rare
  in doom's frame to pay for the table's construction and its
  `keyof` guard.

- **tuning the checker's GC.** A 3-chunk gameplay check profiles as 34%
  `getConditionalFlowTypeOfType` and ~38% GC (`memclr`/`madvise`/`scanObject`),
  so the GC half looked buyable from the environment. `GOGC=off
  GOMEMLIMIT=12GiB`: 61.7-62.2s against a 63.6-67.2s default, `GOGC=800`:
  67.2s. Reported memory is identical (~4.0GB) either way; the 3-5% is inside
  run-to-run spread. The allocation rate, not collection policy, is the cost.

The floor, for reference: an evaluation that hands back the same 30kB of state
without touching it costs 4ms. A frame is 33ms, so the round trip is not what is
in the way yet.

## Fuel

Fuel is a string of `'1'`s, one per unit of work, and a block charges one per hop
plus one per store. Taking a prefix off a string is free; the obvious
`[any, ...infer Rest]` tuple copies every remaining element on every hop, and at
a few thousand units that alone dominated the frame.

The host starts optimistic and backs off: if a chunk comes back with TS2589, or
prints something that is not a fully concrete state, fuel is halved and the same
block is retried. Whatever fuel survives is reused for the next frame, so the
runtime settles onto the checker's real limit instead of assuming one.

## Chunk size (corrected)

An earlier revision here claimed bigger chunks amortize to 2.17s/frame. That
number came from the tsgo probe, which only checks `chunk-0000.state.d.ts` —
the state load, identical across runs (37,057,789 instantiations regardless of
frame count). Pointing tsgo at the chunk itself dies in TS2589
(`bitwise.ts:82`, `conversion.ts:129`) before evaluating any frame, so the
probe cannot measure chunks at all. Only driver wall-clock counts.

Driver A/B on an idle machine, same state, `--max 1`, reproduced twice:

| fuel  | frames | chunk time | fps  |
|-------|--------|-----------|------|
| 4096  | 10     | 5.9s      | 1.69 |
| 8192  | 25     | 7.7-8.4s  | ~3.0 |
| 16384 | 10     | 9.6-11.0s | ~1.0 |
| 32768 | 16     | 30.8s     | 0.52 |

Per-frame cost is not monotonic in chunk size: where the chunk suspends
(435_11 vs 356_9 vs 493_10) decides whether it stalls in an expensive
stretch. fuel 8192 is the measured winner at ~3 fps.

Sustained confirmation (3 consecutive chunks, fuel 8192, same state):
25 + 12 + 9 = 46 frames in 21.1s chunk time — ~2.2 fps sustained, ~4x the
fuel-32768 rate. Frames/chunk varies (25/12/9) because fuel is spent on
work, not frames, but the win holds across chunk boundaries.

fuel 4096 vs 8192, tie-break from identical state (3 chunks each):
4096: 41 frames / 16.25s = 2.52 fps; 8192: 46 frames / 20.82s = 2.21 fps.
4096 won both replicates (2.26 vs 2.18 earlier). 2048 collapses to 1.57 fps
(resume overhead dominates). DEFAULT_FUEL lowered 8192 -> 4096.
