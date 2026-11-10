// Turn a Doom v1.9 demo (.lmp) into a KEY_SCRIPT that replays it from
// packages/playground/doom/.live/menu-boot.json, one entry per game tic.
//
//   node tas-keys.mjs e1m1x-769.lmp 269 3 > tas.keys.json
//
// 269 is how many demo tics to play: the TAS presses the exit switch on its
// 269th tic (7.69s). The demo ends right after, and G_CheckDemoStatus would
// leave the level before the clear screen draws, so the last argument adds
// that many frames with the demo stretched by idle tics: the screen wipes to
// the E1M1 clear screen. One more frame presses use, which skips the stats
// count-up so TIME and PAR show, and the script stops there, before E1M2.
//
// A demo cannot just be started: G_DoNewGame clears `demoplayback` in the same
// tic it loads the map, and that tic runs with the keyboard's command, so the
// player would be a tic behind the demo from the first step. Instead the menu
// starts a UV game normally, and on the next frame the script pokes the state
// a death in single player leaves: player 0 PST_REBORN, which makes G_Ticker
// reload the map exactly as G_InitNew does. With the random index cleared,
// `demoplayback` set and `demo_p` on the tics, the reload's first tic reads
// demo tic 0, the same as G_DoPlayDemo.
import { readFileSync } from "node:fs";

const [lmpPath, ticsArg, holdArg] = process.argv.slice(2);
const lmp = readFileSync(lmpPath);
if (lmp[0] !== 109) throw new Error(`not a v1.9 demo: version ${lmp[0]}`);
if (lmp[1] !== 3 || lmp[2] !== 1 || lmp[3] !== 1) throw new Error("not a UV E1M1 demo");
const ticData = lmp.subarray(13);
const total = ticData.indexOf(0x80) >= 0 ? countTics(ticData) : 0;
const tics = Number(ticsArg ?? total);
if (!(tics > 0 && tics <= total)) throw new Error(`tics must be 1..${total}`);

function countTics(data) {
  let n = 0;
  while (n * 4 < data.length && data[n * 4] !== 0x80) n++;
  return n;
}

// Addresses in doom-keys.wasm's data segment, read off its disassembly:
const DEMO_P = 4408264; // G_ReadDemoTiccmd's cursor
const DEMOPLAYBACK = 4407472; // G_Ticker reads the demo when set
const PLAYER0_STATE = 4406320 + 4; // players[0].playerstate
const PST_REBORN = 2;
const RNDINDEX = 4411108; // M_ClearRandom zeroes both
const PRNDINDEX = 4411112;
// Under the stack: wasm-ld put the stack first (0..65536, growing down) and
// the E1M1 TAS never takes it below 44640, so the tics stay put.
const DEMO_AT = 8192;

const words = [];
const bytes = Buffer.concat([ticData.subarray(0, tics * 4), Buffer.from([0x80, 0, 0, 0])]);
for (let i = 0; i < bytes.length; i += 4) words.push([DEMO_AT + i, bytes.readUInt32LE(i)]);

const label = (t) => {
  const f = ticData.readInt8(t * 4);
  const s = ticData.readInt8(t * 4 + 1);
  const turn = ticData[t * 4 + 2];
  const b = ticData[t * 4 + 3];
  const parts = [];
  if (f) parts.push(f > 0 ? `fwd ${f}` : `back ${-f}`);
  if (s) parts.push(s > 0 ? `right ${s}` : `left ${-s}`);
  if (turn) parts.push(`turn ${turn < 128 ? `left ${turn}` : `right ${256 - turn}`}`);
  if (b & 1) parts.push("fire");
  if (b & 2) parts.push("use");
  return parts.join(" ") || "-";
};

// frame 0 is the call the seed checkpoint is in; the skill menu opens on
// Hurt Me Plenty, one ArrowDown is Ultra-Violence
const script = [[], ["ArrowDown"], [], ["Enter"]];
for (let t = 0; t < tics; t++) {
  const entry = { keys: [], label: label(t) };
  if (t === 0)
    entry.poke = [
      ...words,
      [DEMO_P, DEMO_AT],
      [DEMOPLAYBACK, 1],
      [PLAYER0_STATE, PST_REBORN],
      [RNDINDEX, 0],
      [PRNDINDEX, 0],
    ];
  script.push(entry);
}
// Idle tics past the switch keep `demoplayback` going while the level exits.
const IDLE_TICS = 40;
const hold = Number(holdArg ?? 0);
for (let h = 0; h < hold; h++) {
  const entry = { keys: [], label: "-" };
  if (h === 0) {
    entry.poke = [];
    for (let i = 0; i <= IDLE_TICS; i++)
      entry.poke.push([DEMO_AT + (tics + i) * 4, i === IDLE_TICS ? 0x80 : 0]);
  }
  script.push(entry);
}
// The clear screen counts KILLS, ITEMS and SECRET up before it draws TIME, and
// the type checker needs tens of minutes a frame there. A use press makes
// WI_Ticker jump to the final stats. It goes in the next demo tic G_Ticker
// reads: the wipe in the 3 hold frames ran only 3 idle tics, so demo_p is on
// idle tic 3 (read off a native replay of the checkpoint).
const BT_USE = 2;
if (hold === 3)
  script.push({ keys: [], label: "use", poke: [[DEMO_AT + (tics + 3) * 4, BT_USE << 24]] });
process.stdout.write(JSON.stringify(script) + "\n");
