# Doom in the type system: per-checker benchmark

Doom runs as WebAssembly evaluated purely by type resolution. Every checker
gets the same Doom, the same start state, the same driver and the same keys,
so the only thing that differs is how fast it resolves types.

## TAS: almostmatt1's 7.69s E1M1, replayed by the type checker

`tas.keys.json` replays almostmatt1's "[TAS] Doom E1M1 UV-Speed in 0:07.69"
(`e1m1x-769.lmp`, notes in `e1m1x-769.txt`, from dsdarchive) tic for tic: the
menu starts a UV game, then the demo plays from its first tic, fires where the
TAS fires and presses the exit switch on tic 269. Three more frames wipe to
the E1M1 clear screen, and a last one presses use so it skips the stats
count-up and shows TIME and PAR; the script stops before E1M2. 277 frames.

| TS | version | exit switch | clear screen |
|---|---|---|---|
| TS7.1 `tsgo` | 7.1.0-dev.20261023.1 | 18.3h | 18.4h |
| `tsrs` | 0.19.0-ts7.1.0-beta (`main` at bb5c6037) | 8.2h | 8.2h |

Apple M4 Pro, 48 GB. TS7.1 ran solo; tsrs ran next to a TS6 recording.
Both end on the same clear screen (identical png), but they are not identical
frame for frame yet: tsrs counts 275 frames to TS7.1's 277 (TS7.1 frames 5-7
are 2 frames in the tsrs log), and three more frames (TS7.1 152, 156, 169)
differ in monster pixels while HUD and view match.

```sh
node tas-keys.mjs e1m1x-769.lmp 269 3 > tas.keys.json   # regenerates the checked-in file
SEED=menu-boot.json.gz KEY_SCRIPT=tas.keys.json ./record.sh ts7 0
RESUME=1 SEED=menu-boot.json.gz KEY_SCRIPT=tas.keys.json ./record.sh ts7 0   # continue after a stop
KEY_SCRIPT=tas.keys.json ./side-by-side.sh ts7.1-tas.mp4 1000 ts7
KEY_SCRIPT=tas.keys.json ./side-by-side.sh tsrs-tas.mp4 1000 tsrs
```

1000x at 30 images/s is one image per 33s of run time; `side-by-side.sh`
prints how many frames it skipped (TS7.1: 0, tsrs: 1, its fastest frame took 16s).

tsrs here is built from source, not npm: `main` at
[oxc-project/tsrs@bb5c6037](https://github.com/oxc-project/tsrs/commit/bb5c6037),
packed with `node npm/build.mjs --binary aarch64-apple-darwin=target/release/tsrs --pack`
(see tsrs's `npm/README.md`) and installed over `packages/playground/node_modules/tsrs`.
The pinned npm `tsrs` 0.18.0 runs the same script with `TS_CHECKER=tsrs`.

## The benchmark: time to clear E1M1

From the skill menu (`menu-boot.json.gz`), play `clear.keys.json`
(200 frames: start the game, walk E1M1, press the exit switch at frame 171) and
time until the switch frame. TS7 is measured; a checker too slow to run it
in a reasonable time gets an estimate: TS7's clear time scaled by
TS7 units/s ÷ its units/s (warm throughput from `./fps.sh`).

| TS | version | time to clear E1M1 | how |
|---|---|---|---|
| TS7 `tsgo` | 7.1.0-dev.20261017.1 | 8.5h (switch at frame 171; 200 frames in 8.9h, ~2.7 min/frame) | measured |
| TS6 `tsc` | 6.0.3 | ~7.5x TS7 (~2.7 days) | estimate, warm ratio below |
| `tsrs` | 0.16.0-ts7.1.0-dev.20260929 | ~3.7h (TS7 ÷ 2.3) | estimate, warm ratio below |
| `tsc-rs` | 0.7.0 | ~4.7h (TS7 ÷ 1.8) | estimate, warm ratio below |
| `bun check` | 1.4.3 | can't run | no API that keeps a program alive between chunks, so no driver; see `./cold.sh` |

```sh
SEED=menu-boot.json.gz KEY_SCRIPT=clear.keys.json ./record.sh ts7 1800
```

## Kill run: every tic, monsters killed

`kill.keys.json` is 1999 entries, one per game tic (the driver sets
`singletics` when a key script is given): start on Hurt Me Plenty, kill the
monsters on the way, press the exit switch, land on the tally screen. tsrs,
tsc-rs and TS7 were recorded with it at the same time on one machine, so they
shared the CPU: the times are slower than a solo run and only comparable to
each other.

```sh
S=menu-boot.json.gz
SEED=$S KEY_SCRIPT=kill.keys.json ./record.sh tsrs 0          # 0 = no time limit
RESUME=1 SEED=$S KEY_SCRIPT=kill.keys.json ./record.sh tsrs 0 # continue after a crash or stop
KEY_SCRIPT=kill.keys.json ./side-by-side.sh tsrs-kill.mp4 500 tsrs
KEY_SCRIPT=kill.keys.json ./side-by-side.sh all-kill.mp4 500 "ts7 tsrs tsc-rs"
```

500x at 30 images/s shows every frame (one image per 16.7s of run time, and
no frame took under 25s); `side-by-side.sh` prints how many frames it skipped.

## Warm throughput: TS6 vs TS7

||TS6 (`tsc`, JS)|TS7 (`tsgo`)|TS7 vs TS6|
|---|---|---|---|
|version|6.0.3|7.1.0-dev.20261015.1||
|first chunk (parse 107MB module + first resolve)|492-515s|16.3-16.9s|**~31x**|
|warm throughput, 3 reps, fuel 12288|313-316 units/s|2332-2427 units/s|**~7.5x**|
|highest fuel it holds|9216 (drops from 12288, see below)|24576+||
|20 min of recording, from the same checkpoint|13 chunks, 15 screens|120 chunks, 128 screens||
|reaches the same screen|at 872s|at 58s|**15x**|

## Warm throughput: TS7 vs tsrs vs tsc-rs

`CHECKERS="ts7 tsrs tsc-rs" FUEL=12288 ./fps.sh 3 10`, 2026-10-17:

||TS7 (`tsgo`)|`tsrs`|`tsc-rs`|
|---|---|---|---|
|version|7.1.0-dev.20261017.1|0.16.0-ts7.1.0-dev.20260929|0.7.0|
|first chunk|17.3-17.8s|8.0-8.3s|11.1-11.4s|
|warm throughput, 3 reps, fuel 12288|2257-2344 units/s|5096-5263 units/s|4042-4164 units/s|
|vs TS7|1x|**~2.3x**|**~1.8x**|

`units/s` = wasm instructions executed per second through the type system
(what `packages/playground/cfg/drive.ts` prints), counted from chunk 2 on, wall
time including any retries. Spread is min-max of 3 interleaved reps.

Measured 2026-10-16 on an Apple M4 Pro, 48 GB, macOS (darwin 25.6.0),
Node v22.23.0.

## Video

`./side-by-side.sh` turns a recording into video, holding each screen for as
long as the checker really took to produce the next one. It defaults to TS7
alone; `./side-by-side.sh ts6-ts7.mp4 500 "ts6 ts7"` puts both side by side
at their real relative speed. The overlay shows frames done, seconds per frame,
how long the last frame took (frame ends come from `entry`/`done` in
frames.jsonl) and, with `KEY_SCRIPT` set, the keys held for that frame.

## Run it

```sh
pnpm install                      # repo root, once
cd bench/doom
./cold.sh                         # all five checkers, one chunk cold
./fps.sh 3 10                     # table: 3 interleaved reps, 10 chunks each
FUEL=12288 ./fps.sh 3 10          # the row above
FUEL6=6144 FUEL7=12288 ./fps.sh   # each checker at its own fuel
./record.sh ts7 20                # 20 min recording -> .work/rec-ts7/
./record.sh ts6 20                # run one at a time, never both at once
KEYS='"ArrowUp","ArrowRight"' ./record.sh ts7 20  # other hardcoded input
./side-by-side.sh                 # -> ts7.mp4 (needs ffmpeg)
# clear E1M1 from the skill menu (~200 frames, ~8h on TS7), with key overlay
SEED=menu-boot.json.gz KEY_SCRIPT=clear.keys.json ./record.sh ts7 1800
KEY_SCRIPT=clear.keys.json ./side-by-side.sh ts7.mp4 60
```

A full `fps.sh 3 10` takes ~40 min, almost all of it TS6. Outputs land in
`.work/` (gitignored). Every run starts from `e1m1.json.gz`, a checkpoint in
game on E1M1 at Doom's default view size, so nothing is precomputed past it.
`record.sh` holds `KEYS` (default `ArrowUp`, walk forward) from the first
chunk, so both checkers get the same input on the same chunk and play the same
frames; without input the game sits still and the video shows one view.

## How `clear.keys.json` was found

The type checker never plays: it replays a fixed list of keys, one entry per
frame. The list was found on the real wasm, where a run takes ~1s instead of
~13h, and it carries over because Doom is deterministic: the same binary,
start state and keys give the same frames, byte for byte.

```text
clear.keys.json[0..3]:  []  ["Enter"]  []  ["ArrowRight","ArrowUp","ShiftLeft"]
                        ^ menu-boot.json sits on the skill menu; Enter starts E1M1
```

1. **Run Doom natively.** Instantiate `packages/playground/doom/doom-keys.wasm`
   with `WebAssembly.Instance`, load `bench/doom/menu-boot.json.gz` into its
   memory (`decodeTrie` from `cfg/trie.ts`), write the key bitmask into the
   input word, call `entry()` once per frame. That is the same input slot,
   bitmask and frame boundary the type-level driver uses.
2. **Read the map.** E1M1's lumps (`VERTEXES`, `LINEDEFS`, `SIDEDEFS`,
   `SECTORS`, `THINGS`) come straight out of the IWAD inside the wasm memory.
   Drawing them shows the layout, doors and the exit.
3. **Plan a route.** A grid search over the map: cells blocked by walls,
   steps over 24 units, low ceilings and damaging floors. Doors count as open.
   The result is a list of waypoints from the start to the exit switch.
4. **Steer frame by frame.** A controller reads the player's x, y and angle
   from the player `mobj` in memory each frame, then picks keys: turn toward
   the next waypoint, `ArrowUp`+`ShiftLeft` to run, `Space` at doors and the
   switch. Each frame's keys are appended to the script.
5. **Fix it by trial and error.** Each failed run was cheap to see: stuck on
   a wall, a door that needed `Space` pressed while facing it, turning past
   the waypoint. Fix the waypoints or the controller, rerun. The exit switch
   is pressed at frame 171; the 200 entries leave the level-end screen in view.
6. **Freeze it.** The keys are saved as `clear.keys.json`, and
   `KEY_SCRIPT=clear.keys.json` makes `cfg/drive.ts` press exactly those keys
   on those frames. The type-level frames match the native run.

Prior knowledge covers the generic parts: the WAD format, Doom's controls and
roughly how the engine lays out the player in memory. The memory addresses
were confirmed by probing the running wasm, and the route and every key came
from the steps above. The native planning scripts are not in the repo.

## All five checkers, one chunk cold

`bun check` has no API that keeps a program alive between chunks, so the
driver can't play Doom on it. `./cold.sh` compares every checker the one way
they all share: the CLI checks one chunk (chunk 2 from `e1m1.json.gz`, fuel
12288) from scratch and exits. A checker that hits TS2589 is retried at lower
fuel, bisected.

| TS | version | fuel it holds | cold check |
|---|---|---|---|
| `tsrs` | 0.16.0-ts7.1.0-dev.20260929 | 12288 | 3.2s |
| `tsc-rs` | 0.7.0 | 12288 | 4.2s |
| `bun check` | 1.4.3 | ~2400 (TS2589 above) | 5.6s |
| TS7 `tsgo` | 7.1.0-dev.20261017.1 | 12288 | 7.0s |
| TS6 `tsc` | 6.0.3 | 12288 | 44.0s |

Cold time includes parsing the 67MB module, so it ranks startup plus one
resolve, not the warm per-chunk speed the driver measures. tsrs and tsc-rs
also run under the driver (`TS_CHECKER=tsrs|tsc-rs`).

## How TS6 is driven

TS7 is driven over its sync API (`typescript/unstable/sync`). TS6 has none, so
`TS_CHECKER=ts6` (`packages/playground/evaluate/ts6.ts`) uses the classic
in-process API to do the same thing:

```text
TS7: API.createSnapshot -> project.checker.getTypeFromTypeNode -> typeToString(.., NoTruncation)
TS6: ts.createProgram   -> program.getTypeChecker().getTypeFromTypeNode -> typeToString(.., NoTruncation)
```

Both run under `node --stack-size=16384 --max-old-space-size=16384`. Neither
checker is patched: `patches/` only patches `type-testing`; the
`tsgo-*.patch` files there are not applied to the npm `tsgo`.

## TS6 fuel limit

Fuel is how many wasm instructions one chunk runs before the type suspends. At
higher fuel TS6 hits its instantiation/depth limits and the driver halves fuel
and retries (`fuel changed:` in the table output), then climbs back:

```text
start 24576 -> 12288
start 16384 ->  8192 -> 12288
start 12288 ->  6144 ->  9216
start  8192 ->  4096 ->  6144
start  6144 ->  3072 ->  4608
```

The driver never weakens the computation to fit: a chunk that fails is re-run
from its start with less fuel, and every chunk must land on the same result.
At low fuel TS6 gets much slower per instruction, not faster: starting at 6144
it measured 30-33 units/s, against TS7's 1584-1620 at the same setting (~50x).
