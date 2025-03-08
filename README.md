# A TypeScript-types-only WebAssembly runtime

This is a WebAssembly runtime implemented purely in TypeScript types.  The basic idea is that you can turn C code (or just straight WebAssembly) into a TypeScript type (as in, with no JavaScript runtime code) that will compile the instructions and return a result.

## It can run Doom

This engine was built to service a project that aimed to demonstrate why Doom can't run in TypeScript types.  Well.  The funny thing is.. It can.  There's a video about it on the [MiTS YouTube](https://www.youtube.com/@MichiganTypeScript), and much much more to come soon to give more context on why and how this was made.

## Should I submit a PR to make this even better?

No, probably not.  What you’re viewing in this repo is basically an active crime scene.  There’s blood splattered about and although it’s clear the murder weapon is still in the house… it’s not clear exactly _where_ in the house it might be.

It might sounds strange, but I, @dimitropoulos, have absolutely no emotional attachment to this code and negative-BigInt-zero interest in making it do even more.  It runs Doom.  That's enough.  We can all rest easy now.  If you'd like to get it to run Crysis - I'll happily pass the project off to you, but if you look at the commit history you're going to find I completely stopped working on it the literal second it completed the mission.  I will, however, gladly spend a few hours on a call or something with anyone that might like to take this to the "next level" in the future, whatever you determine that to be.  It just won't be me.

## I have questions, thoughts, suggestions, ideas, etc.

Please don't open an issue - just come on [the MiTS Discord's `#doom` channel](https://discord.michigantypescript.com) and we'd be glad to chat about it.

## Tour of Ridiculous Types

In case you're here just heckle, here's some nightmare fuel for you:

- [ShiftRight](./packages/ts-type-math/shift.ts): this whole file has silly things, but hey, sometimes you gotta do whatcha gotta do.
- [Add](./packages/ts-type-math/add.ts): this is the cornerstone of the arithmetic in the application.  Upon seeing this for the first time, some people have said "I see TypeScript types on the screen, but I don't quite see where _addition_ is taking place".  Fair.  It's there, though.
- [Divide](./packages/ts-type-math/divide.ts) was _by far_ the hardest instruction to implement to get it up to 64 bits.  @teamchong gets all the credit for this one.  To get there, we had to build it up one bit at a time to see where it hit performance limitations with [the division playground](./packages/ts-type-math/divide-playground.ts).
- some of the [binary helpers](./packages/ts-type-math/binary.ts) are sorta artsy to look at fullscreen.
- [final-doom-pun-intended](./packages/playground/final-doom-pun-intended/) contains the files where the finish line was crossed.  While it was chugging away, we made mockups that demonstrated what it would look like when complete.  As it often goes, the mockups ended up being the real thing in the end, haha.
- [david-blass-incredibleness](./packages/playground/david-blass-incredibleness.ts), so-named because of a very important bit of insight that @ssalbdivad provided which caused an explosion of progress, is the main dashboard for development of individual tests.
- [conformance-tests](./packages/conformance-tests/) for the full loop (i.e. from C to WASM to types) as well as from straight WASM to types can be found here.  They're called conformance tests because the same inputs are tested agains the JavaScript built-in WebAssembly runtime, which was the way I made sure this engine's behavior is correct.
- Many of the instructions were surprisingly straightforward but some of the [control flow instructions](./packages/wasm-to-typescript-types/instructions/control-flow.ts) have some meat on the bone.
- [bootstrap](./packages/wasm-to-typescript-types/bootstrap.ts) shows how to boot the WebAssembly runtime within TypeScript types.
- There are probably more fun ones, but the last I'll mention is that you can find some of the core primitive types [here](./packages/wasm-to-typescript-types/types.ts) and the core "how does the state machine actually chug" [here](./packages/wasm-to-typescript-types/program.ts).

## What exact WebAssembly instructions does it implement?

These ones, all written while reading [the WebAssembly Instructions spec](https://webassembly.github.io/spec/core/syntax/instructions.html):

- block
- br
- br_if
- br_table
- call
- call_indirect
- drop
- else
- f32.reinterpret_i32
- f64.reinterpret_i64
- global.get
- global.set
- i32.add
- i32.and
- i32.clz
- i32.const
- i32.ctz
- i32.div_s
- i32.div_u
- i32.eq
- i32.eqz
- i32.extend_16_s
- i32.extend_8_s
- i32.ge_s
- i32.ge_u
- i32.gt_s
- i32.gt_u
- i32.le_u
- i32.le_s
- i32.load
- i32.load16_s
- i32.load16_u
- i32.load8_s
- i32.load8_u
- i32.lt_s
- i32.lt_u
- i32.mul
- i32.ne
- i32.or
- i32.popcnt
- i32.reinterpret_f32
- i32.rem_s
- i32.rem_u
- i32.rotl
- i32.rotr
- i32.shl
- i32.shr_s
- i32.shr_u
- i32.store
- i32.store_16
- i32.store_8
- i32.sub
- i32.trunc_f32_s
- i32.trunc_f64_s
- i32.trunc_f64_u
- i32.wrap_i64
- i32.xor
- i64.add
- i64.and
- i64.clz
- i64.const
- i64.ctz
- i64.div_s
- i64.div_u
- i64.eq
- i64.eqz
- i64.extend_i32_s
- i64.extend_i32_u
- i64.ge_s
- i64.ge_u
- i64.gt_s
- i64.gt_u
- i64.le_s
- i64.le_u
- i64.load
- i64.load16_s
- i64.load16_u
- i64.load32_s
- i64.load32_u
- i64.load8_s
- i64.load8_u
- i64.lt_s
- i64.lt_u
- i64.mul
- i64.ne
- i64.or
- i64.popcnt
- i64.reinterpret_f64
- i64.rem_s
- i64.rem_u
- i64.rotl
- i64.rotr
- i64.shl
- i64.shr_s
- i64.shr_u
- i64.store
- i64.store_16
- i64.store_32
- i64.store_8
- i64.sub
- i64.xor
- if
- local.get
- local.set
- local.tee
- loop
- memory.grow
- memory.size
- nop
- return
- select
- unreachable

Additionally, like many runtimes, a few "synthetic" instructions were created that are not according to any WebAssembly standard, but are sorta convenience features

- synth.end_block
- synth.end_func
- synth.end_loop
- synth.halt
