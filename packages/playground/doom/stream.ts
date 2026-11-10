// Watch a running checkpoint and push each new screen to a browser.
//
// The driver writes its checkpoint after every chunk. Each one carries the
// whole of doom's memory, so the screen can be decoded from it without the
// wasm engine - the same read render-frame.ts does, on a timer instead of once.
// Frames go out over a websocket as PNGs, which needs no dependency: the
// handshake is a sha1 of one header, and a binary frame is two bytes plus the
// payload.
//
// The browser is a remote control and nothing more: it captures key and mouse
// state, draws it so a recording shows what was pressed, and sends it here.
// Every input lands in <checkpoint>.input as a revision counter plus the held
// buttons, which is the handoff the type-level frame runner reads. No input is
// interpreted here - a key is not a ticcmd until the checker turns it into one.
//
// Usage: node --import tsx stream.ts <checkpoint.json> [port]
//
// RECORD=<dir> also keeps every screen that changed: <dir>/NNNNNN.png named by
// chunk, and <dir>/frames.jsonl with the chunk, wall clock, checkpoint md5 and
// keys seen for each. A run is then a timelapse anyone can re-derive from the
// checkpoints:
//   ffmpeg -framerate 4 -pattern_type glob -i 'rec/*.png' -vf scale=960:600:flags=neighbor rec.mp4
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { encodePng, frameFrom, initialMemoryLiteral, screenOf } from "./render-frame";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WIDTH = 320;
const HEIGHT = 200;

const checkpointPath = process.argv[2];
const port = Number(process.argv[3] ?? 8787);
if (!checkpointPath) throw new Error("usage: stream.ts <checkpoint.json> [port]");
/// where the browser's buttons wait for the checker to pick them up
const inputPath = `${checkpointPath}.input`;

/// The pad used to draw 18 keys while the driver forwarded 10, so W/A/S/D,
/// shift, alt and the number row lit up green and did nothing, and Y/N - which
/// the game does read, for the quit prompt - were missing. The list is read out
/// of the driver rather than copied, so the two cannot drift again.
const driverSource = readFileSync(join(__dirname, "..", "cfg", "drive.ts"), "utf8");
const forwardedCodes = (): string[] => {
  const table = driverSource.match(/const INPUT_BITS = \[([^\]]*)\]/);
  if (!table) throw new Error("drive.ts has no INPUT_BITS table to draw a pad from");
  return [...table[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
};
const BITS = forwardedCodes();

/// A frame is minutes, so "I pressed it" and "the game has it" are far apart
/// and the pad has to show both. The second one is in the checkpoint: the input
/// word carries a sentinel in its high bits, so the state the game is reading
/// can be grepped straight out of the memory the poll already parsed. Measured
/// on a live checkpoint: exactly one match, the fixed high bits plus one bit
/// per key in INPUT_BITS.
const SENTINEL = driverSource.match(/const INPUT_SENTINEL = "([01]+)"/)?.[1];
if (!SENTINEL) throw new Error("drive.ts has no INPUT_SENTINEL to find the input word with");
const INPUT_WORD = new RegExp(`${SENTINEL.slice(0, 32 - BITS.length)}([01]{${BITS.length}})`);

/// Which keys the game itself is holding, read back from the checkpoint.
const seenKeys = (memory: string): string[] => {
  const word = memory.match(INPUT_WORD);
  if (!word) return [];
  const bits = word[1]!;
  return BITS.filter((_, bit) => bits[bits.length - 1 - bit] === "1");
};

/// A press is two halves: the driver holds the bit until the game acks the
/// keydown, then clears it and waits for the ack to drop, which is the keyup.
/// Only the first half is visible in the checkpoint's input word, so a page
/// that reports the word alone blanks the badge a frame early - the key looks
/// dropped while its keyup is still owed. The driver's latch says which press
/// is in flight, so the badge stays lit until it is spent.
const latchPath = `${checkpointPath}.latch`;
type Latch = { phase?: string; code?: string; seen?: Record<string, number> };
const readLatch = (): Latch => {
  try {
    return JSON.parse(readFileSync(latchPath, "utf8")) as Latch;
  } catch {
    return {};
  }
};
const inFlight = (latch: Latch): string[] =>
  latch.code && (latch.phase === "sent" || latch.phase === "release") ? [latch.code] : [];

/// Whether a press is still owed, asked as a question about state rather than
/// watched for as an event. The page used to clear its own "queued" mark when
/// the key turned up in the checkpoint's input word, but that word holds the
/// key for one chunk and the page only hears about the chunks that get polled:
/// measured Enter delivered (latch seen Enter:1, the episode screen on the
/// glass) with the badge still reading "queued" 60s later, because the one
/// message that would have cleared it never went out. The driver owes
/// `presses - seen` presses for a key; when that is zero there is nothing
/// queued, whichever messages were missed.
const owed = (latch: Latch, code: string): number =>
  Math.max(0, (pending.presses[code] ?? 0) - (latch.seen?.[code] ?? 0));
const queuedKeys = (latch: Latch): string[] =>
  Object.keys(pending.presses).filter((code) => owed(latch, code) > 0);

/// The presses still waiting, oldest first. `order` remembers every press in
/// the order it was made; the game consumes a key's presses oldest first, so
/// the ones still owed are the last `owed` occurrences of that key.
const queueLeft = (latch: Latch): string[] => {
  const left: Record<string, number> = {};
  for (const code of Object.keys(pending.presses)) left[code] = owed(latch, code);
  const out: string[] = [];
  for (let i = pending.order.length - 1; i >= 0; i--) {
    const code = pending.order[i]!;
    if ((left[code] ?? 0) > 0) {
      left[code]!--;
      out.unshift(code);
    }
  }
  return out;
};

/// What each key does once the game has it, so the pad says why to press it.
/// Menu meaning first: the game boots into the menu, which is where a new
/// player is.
const WHAT: Record<string, [string, string]> = {
  Escape: ["menu", "opens and closes the menu, and backs out of a submenu"],
  Enter: ["select", "picks the highlighted menu item"],
  ArrowUp: ["up / fwd", "menu: previous item. in game: walk forward"],
  ArrowDown: ["down / back", "menu: next item. in game: walk backward"],
  ArrowLeft: ["left", "menu: slider down. in game: turn left"],
  ArrowRight: ["right", "menu: slider up. in game: turn right"],
  Space: ["use", "opens doors and works switches"],
  ControlLeft: ["fire", "left ctrl. fires the weapon"],
  KeyY: ["yes", "answers the quit and new-game prompts"],
  KeyN: ["no", "dismisses a prompt"],
  Digit1: ["fist / saw", "in game: chainsaw if you have it, else fist"],
  Digit2: ["pistol", "in game: the pistol"],
  Digit3: ["shotgun", "in game: the shotgun"],
  Digit4: ["chaingun", "in game: the chaingun"],
  Digit5: ["rockets", "in game: the rocket launcher"],
  Digit6: ["plasma", "in game: the plasma rifle"],
  Digit7: ["bfg", "in game: the BFG9000"],
  ShiftLeft: ["run", "hold with a direction to run"],
  AltLeft: ["strafe", "hold with left/right to sidestep instead of turn"],
  Tab: ["map", "toggles the automap"],
};

const page = `<!doctype html>
<title>doom, by the type checker</title>
<style>
  body { background: #111; color: #ccc; font: 13px ui-monospace, monospace;
         display: flex; flex-direction: column; align-items: center; gap: 10px; margin: 20px }
  #stage { display: flex; gap: 16px; align-items: flex-start }
  #left { display: flex; flex-direction: column; gap: 8px; max-width: ${WIDTH * 3}px }
  canvas { width: ${WIDTH * 3}px; height: ${HEIGHT * 3}px; image-rendering: pixelated;
           background: #000; cursor: crosshair }
  #pad { width: 260px; display: flex; flex-direction: column; gap: 10px }
  h2 { font: 600 11px ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase;
       color: #777; margin: 0 0 6px }
  #keys { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px }
  .key { border: 1px solid #333; border-radius: 3px; padding: 5px 6px; background: #171717;
         cursor: pointer; user-select: none; -webkit-user-select: none }
  .key:hover { border-color: #555 }
  .key b { display: block; font: 600 11px ui-monospace, monospace; color: #bbb }
  .key i { display: block; font: 10px ui-monospace, monospace; font-style: normal; color: #666 }
  .key b em { float: right; font-style: normal; font-size: 9px; letter-spacing: .06em }
  .key.on { background: #3ddc84; border-color: #3ddc84 }
  .key.on b, .key.on i { color: #04180c }
  /* waiting: the browser has it, the checker has not read it back yet */
  .key.wait { border-color: #ffd166 }
  .key.wait b em { color: #ffd166 }
  /* live: the game itself is holding this key in the last checkpoint */
  .key.live { border-color: #6cf; box-shadow: inset 0 0 0 1px #6cf }
  .key.live b em { color: #6cf }
  .key.on b em { color: #04180c }
  .key small { display: block; font: 10px ui-monospace, monospace; color: #7aa2f7 }
  .key.on small { color: #04180c }
  #queue { color: #ffd166 }
  #queue b { color: #6cf; font-weight: 600 }
  button { font: 11px ui-monospace, monospace; background: #222; color: #ccc; border: 1px solid #444;
           border-radius: 3px; padding: 2px 8px; cursor: pointer; margin-top: 4px }
  button:hover { border-color: #888 }
  #log { height: 190px; overflow: hidden; border: 1px solid #262626; border-radius: 3px;
         background: #0d0d0d; padding: 6px; font-size: 11px; line-height: 1.5; color: #8a8a8a }
  #log b { color: #3ddc84; font-weight: 600 }
  #log i { color: #ff7b72; font-style: normal }
  .meta { color: #666; font-size: 11px }
  .meta span { color: #ccc }
  #status { min-height: 18px }
</style>
<div id=stage>
  <div id=left>
    <canvas id=screen width=${WIDTH} height=${HEIGHT}></canvas>
    <div id=status>connecting to the stream server</div>
    <div class=meta>fps <span id=fps>-</span> | frame time <span id=ftime>-</span> | chunk time
      <span id=ctime>-</span> | next frame in <span id=eta>-</span> | this frame
      <span id=inframe>-</span> | painted <span id=painted>-</span></div>
  </div>
  <div id=pad>
    <div><h2>keys</h2><div id=keys></div>
      <div class=meta style="margin-top:6px">click a key or press its keyboard key (shown in blue). a press
        queues until the game takes it - a frame is minutes - and the queue is worked oldest first.</div>
    </div>
    <div><h2>sent to checker</h2>
      <div class=meta>rev <span id=rev>0</span> acked <span id=ack>0</span></div>
      <div class=meta>queued at chunk <span id=qchunk>-</span></div>
      <div class=meta>queue (oldest first): <span id=queue>empty</span></div>
      <button id=clearq title="drop every press the game has not taken yet">clear queue</button>
    </div>
    <div><h2>events</h2><div id=log></div></div>
  </div>
</div>
<script>
  var ctx = document.getElementById("screen").getContext("2d");
  var canvas = document.getElementById("screen");
  // Named statusEl, not status: a top-level var status in a page script
  // assigns to window.status, a legacy DOM property that coerces its value to a
  // string, so the element reference turns into "[object HTMLDivElement]" and
  // every textContent write on it is silently dropped. The metrics line kept
  // updating because it goes through document.getElementById, which is why the
  // page sat on "connecting to the stream server" while frames were painting.
  var statusEl = document.getElementById("status");
  var logEl = document.getElementById("log");
  var keysEl = document.getElementById("keys");
  var KEYS = ${JSON.stringify(forwardedCodes().map((code) => [code, ...(WHAT[code] ?? [code, code])]))};
  var cells = {};
  var badges = {};
  for (var i = 0; i < KEYS.length; i++) {
    (function (code, label, hint) {
      var cell = document.createElement("div");
      cell.className = "key";
      cell.title = code + " - " + hint + ". click to tap, hold to hold";
      var b = document.createElement("b");
      b.textContent = label;
      var badge = document.createElement("em");
      b.appendChild(badge);
      badges[code] = badge;
      var k = document.createElement("small");
      k.textContent = code;
      var s = document.createElement("i");
      s.textContent = hint;
      cell.appendChild(b);
      cell.appendChild(k);
      cell.appendChild(s);
      /// The pad is the only input on a phone and the only one that shows what
      /// a key is for, so a cell presses the same key the keyboard does.
      /// pointer events, not click: a click has no hold, and a menu that is
      /// read once per chunk needs the hold as much as the count.
      cell.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        cell.setPointerCapture(e.pointerId);
        press(code);
      });
      cell.addEventListener("pointerup", function () { release(code); });
      cell.addEventListener("pointercancel", function () { release(code); });
      keysEl.appendChild(cell);
      cells[code] = cell;
    })(KEYS[i][0], KEYS[i][1], KEYS[i][2]);
  }
  var held = {};
  var waiting = {};
  var live = {};
  var linger = {};
  var queued = {};   // presses of each key still owed, from the server
  var sending = null; // the press the driver is holding for the game right now
  /// three facts per key, because they are minutes apart: the browser holds it,
  /// the checker has not read it back yet, the game itself is holding it
  var paint = function (code) {
    var cell = cells[code];
    if (!cell) return;
    cell.classList.toggle("on", !!held[code]);
    cell.classList.toggle("wait", !!waiting[code] && !live[code]);
    cell.classList.toggle("live", !!live[code]);
    var n = queued[code] || 0;
    badges[code].textContent = live[code] ? "in game"
      : sending === code ? "sending" + (n > 1 ? " +" + (n - 1) : "")
      : n > 0 ? "queued" + (n > 1 ? " \u00d7" + n : "")
      : waiting[code] ? "queued" : "";
  };
  var paintQueue = function (list) {
    var el = document.getElementById("queue");
    if (!list || list.length === 0) { el.textContent = "empty"; return; }
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var code = list[i];
      var what = (KEYS.filter(function (k) { return k[0] === code; })[0] || [code, code])[1];
      var text = what + " (" + code + ")";
      parts.push(i === 0 && sending === code ? "<b>" + text + " \u2190 sending</b>" : text);
    }
    el.innerHTML = parts.join(" \u2192 ");
  };
  document.getElementById("clearq").addEventListener("click", function () {
    if (ws.readyState !== 1) return;
    rev++;
    document.getElementById("rev").textContent = rev;
    var down = [];
    for (var k in held) if (held[k]) down.push(k);
    ws.send(JSON.stringify({ rev: rev, keys: down, presses: {}, clear: true }));
    for (var c in cells) { waiting[c] = false; queued[c] = 0; }
    sending = null;
    paintQueue([]);
    for (var c2 in cells) paint(c2);
    log("up", "queue cleared");
  });
  /// A chunk is ~1.5s and the driver reads this file once per chunk, so a 100ms
  /// tap is invisible to it: measured 0 of 10 Enter taps reaching the state,
  /// while a 5s hold landed. Send the keydown as an edge. A cumulative object
  /// makes every later keyup resend every old press, and object insertion order
  /// can then replace a new Enter with the last key first pressed.
  var rev = 0;
  var lines = [];
  var ws = new WebSocket("ws://" + location.host);

  var log = function (mark, what) {
    lines.unshift("<" + (mark === "down" ? "b" : "i") + ">" +
      (mark === "down" ? "\\u25bc" : "\\u25b3") + "</" + (mark === "down" ? "b" : "i") + "> " +
      what + " <span style=color:#555>+" + Math.round(performance.now()) + "ms</span>");
    lines = lines.slice(0, 12);
    logEl.innerHTML = lines.join("<br>");
  };

  /// one shape for every input change: the checker gets state, not events
  var send = function (pressed) {
    if (ws.readyState !== 1) return;
    rev++;
    document.getElementById("rev").textContent = rev;
    var down = [];
    var presses = {};
    for (var k in held) if (held[k]) down.push(k);
    if (pressed) presses[pressed] = 1;
    ws.send(JSON.stringify({ rev: rev, keys: down, presses: presses }));
  };

  /// keyboard and pad go through the same two calls, so a clicked key and a
  /// typed key are the same event as far as the checker can tell
  var press = function (code) {
    if (held[code]) return;
    held[code] = true;
    /// A frame is minutes and a chunk is seconds, so a press that vanishes
    /// until the next paint reads as a dropped press. Mark it waiting the
    /// moment it is sent, and let the checkpoint clear it.
    waiting[code] = true;
    paint(code);
    log("down", code);
    send(code);
  };
  var release = function (code) {
    if (!held[code]) return;
    held[code] = false;
    paint(code);
    log("up", code);
    send();
  };

  window.addEventListener("keydown", function (e) {
    if (!cells[e.code]) return;
    e.preventDefault();
    press(e.code);
  });
  window.addEventListener("keyup", function (e) {
    if (!cells[e.code]) return;
    e.preventDefault();
    release(e.code);
  });
  /// a click used to grab the pointer for a mouse look nothing reads
  canvas.addEventListener("click", function () { canvas.focus(); });

  var painted = 0;
  var onMessage = async function (e) {
    if (typeof e.data === "string") {
      var msg = JSON.parse(e.data);
      if (msg.rev !== undefined) {
        document.getElementById("ack").textContent = msg.rev;
        document.getElementById("qchunk").textContent = msg.chunk;
        return;
      }
      if (msg.seen) {
        /// the server's queue is the truth about what is still owed: it only
        /// changes when the game takes a press (or the queue is cleared), so
        /// the pad and the picture move together however slow the frames are
        if (msg.queue) {
          queued = {};
          for (var qi = 0; qi < msg.queue.length; qi++) queued[msg.queue[qi]] = (queued[msg.queue[qi]] || 0) + 1;
          sending = msg.sending || null;
          paintQueue(msg.queue);
        }
        /// the checkpoint is the only honest answer to "did that register":
        /// once the key shows up in the game's own input word, the queue mark
        /// comes off, and a key that is still queued is still queued
        /// The picture a key produced and the seen list that reports it are
        /// one checkpoint apart: measured Escape's menu drawn at frame 3 with
        /// seen still empty, and seen:Escape arriving at frame 4. Blanking the
        /// badge the moment a key leaves seen therefore clears it one frame
        /// before the picture it caused shows up. Hold it one more message so
        /// the badge and the screen say the same thing.
        for (var c in cells) {
          var isLive = msg.seen.indexOf(c) >= 0;
          /// The server owes a press or it does not, and it says so every
          /// message. A page that only unsets this mark on the frame the key
          /// shows up in the input word keeps the mark forever when it misses
          /// that frame: measured Enter spent, episode screen drawn, badge
          /// still "queued" a minute later.
          if (msg.queued) waiting[c] = msg.queued.indexOf(c) >= 0;
          else if (isLive) waiting[c] = false;
          else if (live[c] && !held[c]) waiting[c] = false;
          if (isLive) linger[c] = 1;
          else if (linger[c] > 0) linger[c]--;
          live[c] = isLive || linger[c] > 0;
          paint(c);
        }
      }
      statusEl.textContent = msg.state;
      // metrics outlive the state line: an idle tick says nothing about rate,
      // so leave the last measured numbers standing instead of blanking them
      if (msg.fps === undefined) return;
      var set = function (id, text) { document.getElementById(id).textContent = text; };
      set("fps", msg.fps);
      set("ftime", msg.frameTime);
      set("ctime", msg.chunkTime);
      set("eta", msg.eta);
      set("inframe", msg.inFrame);
      set("painted", msg.painted);
      return;
    }
    var bitmap = await createImageBitmap(e.data);
    ctx.drawImage(bitmap, 0, 0);
    painted++;
  };
  /// The server dies with the driver, and this run restarts the driver often.
  /// A tab that only reports "disconnected" stays black forever even after the
  /// server is back, which reads as "doom is broken" when it is just a dead
  /// socket, so hold the last frame on the canvas and keep dialling.
  var wire = function (sock) {
    ws = sock;
    sock.binaryType = "blob";
    sock.onmessage = onMessage;
    sock.onclose = function () {
      statusEl.textContent = "stream server is gone, redialling every 1s";
      setTimeout(function () { wire(new WebSocket("ws://" + location.host)); }, 1000);
    };
  };
  wire(ws);
</script>`;

/// binary frame, server to client: no mask, three length encodings
const wsFrame = (payload: Buffer, opcode = 0x2) => {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
};

/// Client frames are masked. Pull whole frames out of the stream and hand back
/// the text ones; a partial frame stays in the buffer until the rest lands.
const readFrames = (buffered: Buffer): { rest: Buffer; texts: string[] } => {
  const texts: string[] = [];
  let buf = buffered;
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) break;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) break;
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const mask = masked ? offset : -1;
    if (masked) offset += 4;
    if (buf.length < offset + length) break;
    const body = Buffer.from(buf.subarray(offset, offset + length));
    if (masked) for (let i = 0; i < body.length; i++) body[i] ^= buf[mask + (i % 4)];
    if (opcode === 0x1) texts.push(body.toString("utf8"));
    buf = buf.subarray(offset + length);
  }
  return { rest: buf, texts };
};

const clients = new Set<Socket>();
const initial = initialMemoryLiteral(join(__dirname, "doom.cfg.ts"));

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});

/// Held keys are last-writer-wins; press counts are a queue the driver drains
/// one per chunk, so they accumulate here rather than in the page.
let inputRev = 0;
let pending = {
  keys: [] as string[],
  /// presses per key since this server started, never lowered while any of
  /// them is still owed: the driver retires them against its own `seen`
  presses: {} as Record<string, number>,
  /// every press in the order it was made; see `queueLeft`
  order: [] as string[],
};

const writeInput = () => {
  const latch = readLatch();
  writeFileSync(
    inputPath,
    JSON.stringify({
      rev: inputRev,
      chunk: lastChunk,
      keys: pending.keys,
      presses: pending.presses,
      // oldest first: the driver takes the head, so two different keys land
      // in the order they were pressed rather than the order they were first
      // ever pressed
      queue: queueLeft(latch),
    }),
  );
};

const acceptInput = (text: string) => {
  let message: { rev: number; keys: string[]; presses?: Record<string, number>; clear?: boolean };
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray(message.keys)) return;
  inputRev++;
  pending.keys = message.keys;
  if (message.clear) {
    // the player gave up on what is waiting: nothing owed, nothing ordered.
    // The driver reseats its `seen` when a count drops below it, so a press
    // it has latched but the game has not taken yet is dropped too.
    pending.presses = {};
    pending.order = [];
  }
  // Every press queues, oldest first, and stays queued until the game takes
  // it: a frame is minutes, and a press that vanished because a later one
  // arrived read as a dropped press. The page's clear button is the way out.
  for (const [code, count] of Object.entries(message.presses ?? {})) {
    for (let i = 0; i < count; i++) {
      pending.presses[code] = (pending.presses[code] ?? 0) + 1;
      pending.order.push(code);
    }
  }
  writeInput();
  const ack = Buffer.from(JSON.stringify({ rev: inputRev, chunk: lastChunk }));
  for (const socket of clients) socket.write(wsFrame(ack, 0x1));
};

/// A press is retired by the driver's own count of what it delivered (its
/// latch `seen`), not by the key being seen held: two queued Enters would
/// otherwise both vanish the moment the first one landed. Here the order list
/// just drops what is no longer owed, so it does not grow for ever; the file
/// the driver reads is rewritten only when that changes what is queued.
const retirePresses = (latch: Latch) => {
  const before = pending.order.length;
  pending.order = queueLeft(latch);
  if (pending.order.length === before) return;
  inputRev++;
  writeInput();
};

server.on("upgrade", (req, socket: Socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  clients.add(socket);
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const { rest, texts } = readFrames(buffered);
    buffered = rest;
    for (const text of texts) acceptInput(text);
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
  if (last) socket.write(wsFrame(last));
  if (lastStatus) socket.write(wsFrame(Buffer.from(lastStatus), 0x1));
});

let last: Buffer | undefined;
let lastStatus = "";
/// RECORD=<dir>: one png per changed screen plus a jsonl index. Named by chunk
/// so a glob sorts them in play order and a rerun overwrites, not duplicates.
const recordDir = process.env.RECORD;
if (recordDir) mkdirSync(recordDir, { recursive: true });
let lastRecordedMd5 = "";
/// `entry` and `done` mark frame boundaries, which is what an fps overlay
/// needs: `done` is the call returning, and a poll that misses it still sees
/// `entry` (chunks into the current call) drop on the next frame.
const record = (
  checkpoint: { chunks: number; memory: string; entryChunks?: number; done?: boolean },
  png: Buffer,
  seen: string[],
) => {
  if (!recordDir) return;
  const md5 = createHash("md5").update(checkpoint.memory).digest("hex");
  if (md5 === lastRecordedMd5) return;
  lastRecordedMd5 = md5;
  const name = String(checkpoint.chunks).padStart(6, "0");
  writeFileSync(`${recordDir}/${name}.png`, png);
  appendFileSync(
    `${recordDir}/frames.jsonl`,
    JSON.stringify({
      chunk: checkpoint.chunks,
      entry: checkpoint.entryChunks,
      done: checkpoint.done || undefined,
      at: new Date().toISOString(),
      md5,
      seen,
    }) + "\n",
  );
};
let lastChunk = -1;
let lastAt = 0;
/// A frame took 3224 chunks to render, measured end to end. Chunk count is set
/// by where the program suspends - calls and block edges - so it barely moves
/// with the fuel setting: 3293 chunks at fuel 1024, 3224 at 16384.
// A frame is one `entry` call, and the driver counts chunks per call, so the
// chunk number dropping is the frame boundary. Frame length is not a constant to
// hardcode: the cold start pays doom's whole init (measured 2861 chunks) and
// every frame after it re-enters on a warm heap, so the length is measured here
// and reported as unknown until one boundary has been seen.
// The measurement outlives this process: restarting the stream throws away a
// frame length that cost 19 minutes to measure, and then fps reads `-` for a
// whole frame again even though the driver never stopped.
/// The counts in the input file outlive the driver: the play loop restarts the
/// driver on its own, and a fresh driver has an empty `pressesSeen`, so every
/// count still on disk reads as a press it owes the game. Measured after one
/// Enter tap against a file left holding {"ControlLeft":20,"Enter":4}: the game
/// got Escape, Enter, KeyY, KeyN and Space over the next 20 seconds, none of
/// them pressed by anyone. Start from nothing.
inputRev++;
writeInput();

const framePath = `${checkpointPath}.frame`;
let frameChunks = 0;
let frameSecondsSaved = 0;
let framesFrom = "";
try {
  const saved = JSON.parse(readFileSync(framePath, "utf8"));
  frameChunks = saved.frameChunks;
  frameSecondsSaved = saved.frameSeconds;
  framesFrom = " (measured before this stream started)";
} catch {
  // no measurement yet: report unknown rather than a guess
}
let lastEntry = -1;
// per-call counts going backwards while memory stands still: two drivers
let entryRewinds = 0;
let frameStartedAt = performance.now();
/// chunks a second, smoothed: a single chunk's time swings with how much of the
/// state it touches
let rate = 0;
/// The checkpoint counts the time the checker spent, not the time the run took:
/// the host spends the rest printing and re-parsing the state. Watching both
/// clocks tick gives the share without hardcoding it, and evalMs / share is
/// then the wall time of the whole run, including the part before we attached.
/// Seeded from two full frames - 680s of checker in 1103s, 648s in 1134s - so a
/// checkpoint that has stopped moving still reports, and refined from there.
let share = 0.6;
let lastEvalMs = 0;
/// last painted share, so an idle tick can still say what is on screen
let lastPaintedPercent = "";
/// Chunks that advanced without a single word of memory changing. doom's
/// Z_Malloc walks the zone block list with no stores until it finds a block, so
/// a zone pointer of 0 - Z_ZoneBase after a grow failure - is an endless walk
/// over null: chunks tick, the screen cannot change, and the run is dead. A
/// frozen memory catches that and every other storeless loop.
let lastMemory = "";
let frozenChunks = 0;

/// Every status the page can show names the state it is in. A placeholder that
/// never changes cannot tell "no checkpoint yet" from "the driver died" from
/// "a chunk takes half a second", and those want three different actions.
const say = (text: string) => {
  lastStatus = JSON.stringify({ state: text });
  for (const socket of clients) socket.write(wsFrame(Buffer.from(lastStatus), 0x1));
};

const poll = () => {
  let checkpoint: { memory: string; chunks: number; entryChunks?: number; evalMs: number; done?: boolean };
  try {
    // the driver rewrites this file while we read it
    checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch {
    // half-written JSON is normal and clears on the next tick; a missing file
    // means nothing is driving this checkpoint at all
    say(
      existsSync(checkpointPath)
        ? `checkpoint ${basename(checkpointPath)} is mid-write, reading again in 1s`
        : `no checkpoint at ${checkpointPath} - start the driver: pnpm run start`,
    );
    return;
  }
  if (checkpoint.chunks === lastChunk) {
    // the driver saves every chunk, so silence is the chunk still running
    const idle = ((performance.now() - lastAt) / 1000).toFixed(0);
    say(
      `chunk ${checkpoint.chunks}, no save for ${idle}s - ` +
        (Number(idle) > 120 ? "driver looks stopped" : "chunk in progress") +
        (lastPaintedPercent ? `, screen ${lastPaintedPercent}% painted` : ""),
    );
    return;
  }
  // A chunk count that jumps backwards is two drivers saving to one file, not
  // progress: each tick then sees a 13000 chunk delta and the rate is fiction.
  // Report it instead of averaging it in - the fix is killing one driver.
  if (checkpoint.chunks < lastChunk) {
    say(
      `checkpoint went backwards, ${lastChunk} -> ${checkpoint.chunks}: two ` +
        `drivers are writing ${basename(checkpointPath)}, kill one`,
    );
    lastChunk = checkpoint.chunks;
    lastEvalMs = checkpoint.evalMs;
    lastAt = performance.now();
    rate = 0;
    return;
  }
  if (checkpoint.memory === lastMemory) frozenChunks += checkpoint.chunks - lastChunk;
  else {
    frozenChunks = 0;
    entryRewinds = 0;
  }
  lastMemory = checkpoint.memory;
  // A frame is 3224 chunks, so a couple of hundred storeless chunks is already
  // far past any real loop in the renderer.
  if (frozenChunks > 200) {
    // Two causes, and they need opposite fixes. Two drivers on one checkpoint
    // rewind each other, so the file's memory never moves while its chunk count
    // climbs, and each driver's own per-call count keeps jumping backwards -
    // that is the signature to test, and killing one driver fixes it. A single
    // driver whose stores have stopped is the real wedge. Measured: a run
    // reported as wedged three times over sat at the identical memory hash
    // a9058f06 with two `cfg/drive.ts` processes, and a fresh single-driver run
    // from the same seed advanced normally.
    say(
      entryRewinds > 1
        ? `two drivers are writing ${basename(checkpointPath)}: ${frozenChunks} ` +
            `chunks with no memory write and ${entryRewinds} restarts of the ` +
            `per-call count, so they are rewinding each other. Kill all but one: ` +
            `pkill -f 'node.*cfg/drive.ts', then run pnpm run start once.`
        : `wedged: ${frozenChunks} chunks with no memory write from a single ` +
            `driver, so the screen cannot change (doom's zone pointer is 0 - ` +
            `Z_Init found no heap after a restart on used memory). Kill the ` +
            `driver, rm ${basename(checkpointPath)}, and run pnpm run start again.`,
    );
    lastChunk = checkpoint.chunks;
    lastEvalMs = checkpoint.evalMs;
    lastAt = performance.now();
    return;
  }
  const now = performance.now();
  if (lastAt) {
    const sample = ((checkpoint.chunks - lastChunk) / (now - lastAt)) * 1000;
    rate = rate ? rate * 0.8 + sample * 0.2 : sample;
    const evalShare = (checkpoint.evalMs - lastEvalMs) / (now - lastAt);
    if (evalShare > 0 && evalShare <= 1) {
      share = share ? share * 0.8 + evalShare * 0.2 : evalShare;
    }
  }
  // A frame is one `entry` call, and only `done` says that call returned, so
  // that is the one thing a frame length can be measured between. The per-call
  // count restarting does not mean a frame landed: the play loop restarts the
  // driver on takeover too, and treating that as a boundary reported a 2.4
  // second frame - `fps 0.41750, frame time 0.0m` - next to a 15 minute eta.
  const entry = checkpoint.entryChunks;
  if (checkpoint.done) {
    frameChunks = entry ?? lastEntry;
    frameSecondsSaved = (now - frameStartedAt) / 1000;
    frameStartedAt = now;
    framesFrom = "";
    writeFileSync(framePath, JSON.stringify({ frameChunks, frameSeconds: frameSecondsSaved }));
  } else if (entry !== undefined && entry < lastEntry) {
    entryRewinds++;
    // a restart mid-frame: this frame's elapsed time starts again here, and the
    // last completed frame's length stays the best thing to project from
    frameStartedAt = now;
  }
  if (entry !== undefined) lastEntry = entry;
  lastAt = now;
  lastEvalMs = checkpoint.evalMs;
  lastChunk = checkpoint.chunks;
  const latch = readLatch();
  const nowSeen = [...new Set([...seenKeys(checkpoint.memory), ...inFlight(latch)])];
  retirePresses(latch);
  const nowQueued = queuedKeys(latch);
  const nowQueue = queueLeft(latch);
  const nowSending = latch.phase === "sent" && latch.code ? latch.code : null;
  const started = performance.now();
  const { rgb, painted } = frameFrom(checkpoint.memory, initial, screenOf(checkpoint));
  last = encodePng(rgb, WIDTH, HEIGHT);
  record(checkpoint, last, nowSeen);
  const percent = ((painted / (WIDTH * HEIGHT)) * 100).toFixed(1);
  // fps from the measured save rate, not from evalMs / share: share is a ratio
  // of two clocks sampled a second apart, and one tick where the checker's
  // clock barely moves flips the reported frame time between 17m and 1.4m.
  // rate is chunks a second, smoothed, and already drives the eta below.
  lastPaintedPercent = percent;
  const inFrame = checkpoint.entryChunks ?? checkpoint.chunks;
  // fps from the last completed frame, not from the chunk rate over a guessed
  // frame length: the two disagree by more than 2x between the cold start and a
  // re-entry, and a guess that reads as a measurement is worse than a dash
  const frameSeconds = frameSecondsSaved;
  const fps = frameSeconds > 0 ? 1 / frameSeconds : 0;
  const left = frameChunks - inFrame;
  const etaMin = rate > 0 && left > 0 ? left / rate / 60 : 0;
  lastStatus = JSON.stringify({
    state: frameChunks
      ? `chunk ${inFrame} of this frame, last frame took ${frameChunks} chunks${framesFrom}`
      : `chunk ${inFrame} of the first frame - its length is measured when it lands`,
    // undefined fields drop out of JSON, so the page keeps its last numbers
    // until two saves have been timed rather than showing a made up rate
    fps: fps ? fps.toFixed(5) : undefined,
    frameTime: fps ? `${(frameSeconds / 60).toFixed(1)}m` : undefined,
    chunkTime: rate > 0 ? `${(1 / rate).toFixed(2)}s` : undefined,
    eta: etaMin > 0 ? `${etaMin.toFixed(0)}m` : undefined,
    inFrame: frameChunks ? `${inFrame}/${frameChunks}` : `${inFrame}/?`,
    painted: `${painted}/${WIDTH * HEIGHT} (${percent}%)`,
    seen: nowSeen,
    queued: nowQueued,
    queue: nowQueue,
    sending: nowSending,
    chunk: checkpoint.chunks,
  });
  for (const socket of clients) {
    socket.write(wsFrame(last));
    socket.write(wsFrame(Buffer.from(lastStatus), 0x1));
  }
};

setInterval(poll, 1000);
// The first poll is a second away, and a hardcoded "wait 2s" was wrong every
// time the driver was still starting: a warm resume needs 2s to load a 3.2MB
// checkpoint and finish its first chunk, a cold one longer. Report the file's
// age instead, which is a fact the server already has.
const sayStartup = () => {
  if (!existsSync(checkpointPath)) {
    say(`no checkpoint at ${checkpointPath} - start the driver: pnpm run start`);
    return;
  }
  const age = ((Date.now() - statSync(checkpointPath).mtimeMs) / 1000).toFixed(0);
  say(
    `checkpoint ${basename(checkpointPath)} last written ${age}s ago, ` +
      `waiting for the driver's next save`,
  );
};

server.listen(port, () => {
  sayStartup();
  console.log(`http://localhost:${port}`);
});
