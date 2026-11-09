// Host driver for a CFG-compiled module.
//
// The compiled module is pure types: every basic block is a type, and a block
// that runs out of fuel returns ['s', '<fn>_<block>', <memory>, ...live values]
// instead of recursing further. This driver evaluates one chunk, reads the
// suspend tuple, and re-enters the named block with fresh fuel - so a run of
// any length is a sequence of bounded type evaluations.
//
// Usage: tsx drive.ts <module.cfg.ts> <entry> [args...] [--fuel N] [--max N]
import { basename, dirname, join } from "node:path";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEnv, evaluateType } from "../evaluate/ts";

/// A kill between open and close leaves a truncated checkpoint behind, and the
/// play script reads a file that does not end in `}` as a dead run and starts
/// over: every run this session died that way, each time throwing away frames
/// that took 20 minutes each. rename() is atomic, so a reader gets the whole
/// old checkpoint or the whole new one, never a prefix.
const saveCheckpoint = (path: string, text: string): void => {
  writeFileSync(`${path}.writing`, text);
  renameSync(`${path}.writing`, path);
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");

/// split a printed tuple body on its top-level commas
export const splitTop = (text: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '"') quote = false;
      continue;
    }
    if (c === '"') quote = true;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
};

/// a printed type ("..." / [..]) turned back into source we can paste
const toSource = (printed: string) => printed.replace(/"/g, "'");

/// A word, `u` for a subtree nothing has written, a `$name` the compiler prints
/// as an alias, or a branch. A one element tuple is a leaf standing for every
/// word below it, which is how a whole subtree of one value stays one token.
type Trie = string | Trie[];
const ABSENT = "u";
const ZERO_WORD = "0".repeat(32);

/// `prev` is what the alias `$IN` stands for. A chunk is called as
/// `$entry<$FUEL, $IN, ...>`, so every subtree the chunk did not write prints
/// back as `$IN` rather than as its contents. Resolving it to the trie the host
/// already holds keeps the state small; pasting the name back would make the
/// next state file define `$IN` in terms of itself.
const parseTrie = (src: string, prev: Trie = ABSENT, aliases: Map<string, string> = new Map()): Trie => {
  let at = 0;
  const skip = () => {
    while (at < src.length && (src[at] === "," || /\s/.test(src[at]!))) at++;
  };
  const node = (): Trie => {
    skip();
    if (src[at] === "[") {
      at++;
      const kids: Trie[] = [];
      for (;;) {
        skip();
        if (src[at] === "]") {
          at++;
          break;
        }
        kids.push(node());
      }
      return kids.length === 1 ? kids[0]! : kids;
    }
    if (src[at] === "'" || src[at] === '"') {
      const quote = src[at++];
      const start = at;
      while (at < src.length && src[at] !== quote) at++;
      return src.slice(start, at++);
    }
    const start = at;
    while (at < src.length && !/[\s,\]]/.test(src[at]!)) at++;
    const token = src.slice(start, at);
    if (token === "$IN") return prev;
    const alias = aliases.get(token);
    if (alias !== undefined) return alias;
    return token === "$Zero" ? ZERO_WORD : token === "$Absent" ? ABSENT : token;
  };
  return node();
};

/// Word4 I/O boundary. The byte-tuple module represents a 32-bit word as a
/// 4-tuple of 8-char bytes (`['b0','b1','b2','b3']`), and a memory leaf as that
/// tuple in the 1-tuple leaf wrapper (`[['b0','b1','b2','b3']]`). The whole
/// driver - trie, aliases, frames, checkpoints - stays in 32-char strings, so
/// the two reps only meet here: encode on the way into the emitted chunk,
/// decode on the way back out. A word arg (a bare WasmValue) is the bare tuple;
/// a memory leaf's own `['<32>']` bracket becomes the leaf wrapper for free.
const w4Encode = (text: string): string =>
  text.replace(/(["'])([01]{32}(?:[01]{32})?)\1/g, (_m, _q, bits: string) =>
    `[${bits.match(/.{8}/g)!.map((b) => `'${b}'`).join(", ")}]`,
  );
const w4Decode = (text: string): string => {
  const B = `["'][01]{8}["']`;
  const join = (m: string) => {
    const q = m.includes('"') ? '"' : "'";
    return `${q}${m.match(/[01]{8}/g)!.join("")}${q}`;
  };
  return text
    // Word8 (i64 values) first, so the 4-byte rule cannot eat half of one
    .replace(new RegExp(`\\[\\s*(?:${B}\\s*,\\s*){7}${B}\\s*\\]`, "g"), join)
    .replace(new RegExp(`\\[\\s*(?:${B}\\s*,\\s*){3}${B}\\s*\\]`, "g"), join);
};

/// The number of type arguments an imported name is applied with, read off its
/// first `name<...>` use by walking to the matching `>` and counting top-level
/// commas. 0 means it is never used as a generic. Used to emit a generic
/// passthrough alias (see the import rewrite) instead of a plain, non-generic
/// one that would make `ToStr<A>` an error and collapse the result to `any`.
const genericArity = (text: string, name: string): number => {
  const at = new RegExp(`(?<![\\w$])(?<![^.]\\.)${name}<`).exec(text);
  if (!at) return 0;
  let depth = 1;
  let commas = 0;
  for (let i = at.index + at[0].length; i < text.length && depth > 0; i++) {
    const c = text[i]!;
    if (c === "<" || c === "[" || c === "(") depth++;
    else if (c === ">" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 1) commas++;
  }
  return commas + 1;
};

const printTrie = (node: Trie): string =>
  Array.isArray(node)
    ? `[${node.map(printTrie).join(", ")}]`
    : node === ABSENT
      ? "$Absent"
      : node.startsWith("$")
        ? node
        : node === ZERO_WORD
          ? // The module already declares `$Zero = ['<32 zeros>']`, so this is the
            // same leaf spelled in 5 characters instead of 35, and the parser
            // above already reads it back as the word. A zero stored over a
            // nonzero initial word cannot become $Absent - $Fetch would read the
            // module's data back through it - so this is what those words cost.
            // Measured on doom at frame 2, chunk 1270: 21539 of 77343 stored
            // words are that zero.
            "$Zero"
          : `['${node}']`;

/// The state text is 82% word literals - measured on doom at frame 2: 63627 of
/// them, 2.23MB of the 2.73MB - and a word costs 35 characters every chunk
/// however often it repeats. The checker re-parses the whole state on each
/// chunk, so the repeats are what to attack: 10012 of those words are the
/// all-ones word alone. Declaring the common ones as aliases in the state file
/// makes each use 3 characters. 64 is where the measured curve flattens: top-8
/// saves 15% of the text, top-64 saves 25%, top-4096 saves 50%. The extra
/// declarations are cheaper than the text they remove: at doom's frame-5 state
/// (7.3MB), raising the cap from 64 to 4096 cut the emitted state from 5.54MB to
/// 2.75MB and the chunk from 371ms to 243ms, of which tsgo's resolve went 260ms
/// -> 138ms. Past 4096 the text keeps shrinking (2.29MB at 20000) but the time
/// does not (242ms), so the win is the repeated literals, not the node count.
///
/// Before: [['11111111111111111111111111111111'], ['11111111111111111111111111111111']]
/// After:  type $A0 = ['11111111111111111111111111111111']
///         [$A0, $A0]
const ALIAS_TOP = 4096;

const aliasWordsOf = (node: Trie): string[] => {
  const seen = new Map<string, number>();
  const count = (n: Trie): void => {
    if (Array.isArray(n)) {
      for (const kid of n) count(kid);
      return;
    }
    if (n === ABSENT || n.startsWith("$")) return;
    seen.set(n, (seen.get(n) ?? 0) + 1);
  };
  count(node);
  return [...seen]
    .filter(([, hits]) => hits > 1)
    .sort((left, right) => right[1] - left[1])
    .slice(0, ALIAS_TOP)
    .map(([word]) => word);
};

const printAliased = (node: Trie, names: Map<string, string>): string =>
  Array.isArray(node)
    ? `[${node.map((kid) => printAliased(kid, names)).join(", ")}]`
    : node === ABSENT
      ? "$Absent"
      : node.startsWith("$")
        ? node
        : (names.get(node) ?? (node === ZERO_WORD ? "$Zero" : `['${node}']`));


/// A store that writes a word back at the value the module already holds leaves
/// a word in the state that reads exactly like reading through to
/// $InitialMemory would. Dropping it costs the next chunk nothing and the state
/// is 93% words: measured on doom at chunk 765, 37423 words down to 20048.
/// The host reads the memory two levels down and $Kid<M> is a tuple match, so
/// it gives never for a leaf. The top two levels stay branches - 72 nodes, and
/// a leaf that lands there gets split back out into its eight copies.
const SPLIT_DEPTH = 2;


/// Writes one word, splitting any leaf that stands for a whole subtree on the
/// way down. `prune` puts back whatever this leaves collapsible.
const setWord = (node: Trie, word: number, value: string, fanout: number, levels: number): Trie => {
  if (levels === 0) return value;
  const bits = Math.log2(fanout);
  const index = (word >>> ((levels - 1) * bits)) & (fanout - 1);
  const kids: Trie[] = Array.isArray(node) ? node.slice() : Array.from({ length: fanout }, () => node);
  kids[index] = setWord(kids[index]!, word, value, fanout, levels - 1);
  return kids;
};


/// The run hands back an overlay - every word it wrote, `u` everywhere else -
/// because a store into the overlay costs 385 instantiations against 3661 into
/// the whole of memory. Folding the overlay back into `$IN` is left to the
/// checker too, once, after the run:
///
///     $Merge<$IN, $MemOf<$Result>>
///
/// so the host only re-parses what the checker printed. A leaf is a word tuple
/// (`['0101..']`, or four bytes under --word4), so `string[]` tells it from a
/// branch; a base leaf standing for a whole subtree is handed to every child.
/// Measured on doom chunks 0-5 on TS7.1: the same memory the host walk built,
/// for ~20ms of a ~1.7s read.
const MERGE_TYPE = `type $Merge<B, O> = O extends string[]
  ? (O extends $Absent ? B : O)
  : { [K in keyof O]: $Merge<B extends string[] ? B : B[K & keyof B], O[K]> }`;

/// Reads one word out of the state, falling through `$Absent` to the module's
/// own initial data the way the checker's own loads do.
const getWord = (node: Trie, base: Trie, word: number, fanout: number, levels: number): string => {
  if (levels === 0) return node === ABSENT ? (typeof base === "string" ? base : ZERO_WORD) : (node as string);
  const bits = Math.log2(fanout);
  const index = (word >>> ((levels - 1) * bits)) & (fanout - 1);
  return getWord(
    Array.isArray(node) ? node[index]! : node,
    Array.isArray(base) ? base[index]! : base,
    word,
    fanout,
    levels - 1,
  );
};

const prune = (node: Trie, base: Trie, fanout: number, depth = 0): Trie => {
  const kid = (index: number) => (Array.isArray(base) ? base[index]! : base);
  if (depth < SPLIT_DEPTH && !(typeof node === "string" && node !== ABSENT && node.startsWith("$"))) {
    return Array.from({ length: fanout }, (_unused, index) =>
      prune(Array.isArray(node) ? node[index]! : node, kid(index), fanout, depth + 1),
    );
  }
  if (Array.isArray(node)) {
    const kids = node.map((child, index) => prune(child, kid(index), fanout, depth + 1));
    if (kids.every((child) => child === ABSENT)) return ABSENT;
    const first = kids[0]!;
    if (typeof first === "string" && first !== ABSENT && kids.every((child) => child === first)) return first;
    return kids;
  }
  if (node === ABSENT || node.startsWith("$")) return node;
  return !Array.isArray(base) && base === node ? ABSENT : node;
};

/// Doom reads its keys from one word it never writes:
///
///     volatile int ts_input_mask = 0x5A100000;  /* low 20 bits are the keys */
///
/// `entry` loads it, masks off the sentinel, and hands the bits to
/// `ts_post_input`, which turns each changed bit into a D_PostEvent. A word the
/// host writes into the state shadows the module's data, so a keypress is a
/// single `setWord` per chunk - not a patch of the 117MB module text, which is
/// what the sentinel in the high bits was originally there to find.
const INPUT_SENTINEL = "01011010000100000000000000000000";

/// `ts_post_input` keeps the last word it posted, and compares each incoming
/// bit against it: that shadow is the game's acknowledgement, and it is the
/// only signal the host has that a key was actually taken. Measured on the
/// wasm build, one bit set and then cleared:
///
///     word 0..01, ack 0..00   bit written, frame not run yet
///     word 0..01, ack 0..01   frame ran: keydown posted
///     word 0..00, ack 0..01   bit cleared, frame not run yet
///     word 0..00, ack 0..00   frame ran: keyup posted
///
/// So a press is: set the bit, wait for the ack to show it, clear the bit, wait
/// for the ack to drop it. No frame counting, and it survives the host being
/// restarted between frames, which it is - one process is one frame.
const ACK_WORD = 4410172 / 4;

/// Bit order is the select chain `ts_post_input` walks: bit 0 ESC, 1 ENTER,
/// 2..5 the arrows, 6 use, 7 fire, 8 y, 9 n, 10..16 the weapon digits, 17 run,
/// 18 strafe, 19 map. The names are KeyboardEvent.code, which is what stream.ts
/// writes to <checkpoint>.input.
const INPUT_BITS = [
  "Escape",
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "ControlLeft",
  "KeyY",
  "KeyN",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "ShiftLeft",
  "AltLeft",
  "Tab",
];

/// Where that word lives, as a word index, read off the module's own data
/// rather than hardcoded: the address moves whenever doom is rebuilt.
///
/// It has to come out of the trie the host writes into, not out of a regex over
/// the module text. `$InitialMap` prints the same word as a key nested one page
/// deep - `'0..010010': '0101101..'` - so a flat match reads back the index
/// within the page (18) and its key length as the depth (8 bits, which is not
/// even a whole number of trie levels). setWord then wrote the keys into word
/// 18, the game never saw a keypress, and the menu never opened. Walking
/// `$InitialMemory` gives the whole path: word 50962, byte 203848, which is
/// where the native module holds `ts_input_mask`.
const inputWordOf = (base: Trie, fanout: number) => {
  const walk = (node: Trie, word: number, depth: number): { word: number; levels: number } | undefined => {
    if (!Array.isArray(node)) return node === INPUT_SENTINEL ? { word, levels: depth * Math.log2(fanout) } : undefined;
    for (const [index, child] of node.entries()) {
      const found = walk(child, word * node.length + index, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(base, 0, 0);
};

const inputMaskWord = (keys: string[]) => {
  let mask = 0;
  for (const [bit, code] of INPUT_BITS.entries()) if (keys.includes(code)) mask |= 1 << bit;
  // The sentinel stays in the high 12 bits: `entry` ands with 0xFFFFF, so they
  // are dead to the game, and keeping them makes a state word recognisable.
  return (INPUT_SENTINEL.slice(0, 32 - INPUT_BITS.length) +
    mask.toString(2).padStart(INPUT_BITS.length, "0"));
};

/// The module's own initial memory, as the host sees it.
const initialMemory = (moduleText: string): Trie => {
  const marker = "type $InitialMemory = ";
  const at = moduleText.indexOf(marker);
  if (at < 0) return ABSENT;
  const end = moduleText.indexOf("\n", at);
  return parseTrie(moduleText.slice(at + marker.length, end < 0 ? undefined : end));
};

/// Did the checker actually finish, or did it hand back an approximation?
///
/// Running past a limit does not reliably raise an error. The checker can
/// return `errorType`, which prints as `any`; it can leave a conditional
/// deferred and print that type's *constraint*, the union of the branches it
/// never chose; and the printer elides parts of large types as `any` even when
/// the type itself is fine. Any of those pasted into the next chunk corrupts
/// the run silently, so every piece is checked against exactly what the
/// compiler is supposed to emit: nested tuples, the `$Zero` alias for untouched
/// subtrees, and 32-character binary literals.
const WORD = /^"[01]{32}"$/;
// a block name as the compiler spells it: function index, then block index
const BLOCK = /^"?(?:trap_)?\d+_\d+"?$/;
// `$Zero`, `$Absent` and `$InitialMemory` are aliases the compiler emits; the
// checker prints them back and the host can paste them straight into the next
// chunk. `"u"` is a subtree the program has never written: it reads through to
// the module's initial memory, so the state only carries what was stored.
// Words that came out of $InitialMemory print with the quotes that file uses,
// so both styles are words. Either one pastes back into the next chunk as is.
// `$IN` is the alias the chunk was called with: subtrees it never wrote print
// under that name, and the parser resolves them against the incoming trie.
const TOKEN_STEP = /(?:[[\],\s]+|\$Zero|\$Absent|\$IN|\$InitialMemory|\$A\d+|["']u["']|"[01]{32}"|'[01]{32}')/y;

/// The first offset the state stops being a state at. Uses a sticky (/y) step
/// loop rather than `^${TOKEN}+$` so a 15MB+ state string (~1.5M tokens) never
/// overflows the JS engine's RegExp backtracking stack.
const offence = (state: string): number => {
  let at = 0;
  while (at < state.length) {
    TOKEN_STEP.lastIndex = at;
    if (!TOKEN_STEP.test(state)) return at;
    at = TOKEN_STEP.lastIndex;
  }
  return at;
};

export const degraded = (
  tag: string,
  state: string,
  live: string,
  value: string,
  globals = "[]",
): string | undefined => {
  if (tag !== '"s"' && tag !== '"r"') return `result tag is ${tag.slice(0, 40)}`;
  const at = offence(state);
  if (!state.length || at < state.length) {
    return `state has ${JSON.stringify(state.slice(at, at + 48))} at ${at} of ${state.length}`;
  }
  if (tag === '"s"') {
    // the frames are pasted back verbatim, so every part of every one of them
    // has to be exactly what the compiler emits: a block name, then words
    const body = live.slice(live.indexOf("[") + 1, live.lastIndexOf("]"));
    for (const part of splitTop(body)) {
      if (!part.length) continue;
      if (!part.startsWith("[")) return `frame is not a tuple: ${part.slice(0, 40)}`;
      const inner = splitTop(part.slice(part.indexOf("[") + 1, part.lastIndexOf("]")));
      const [name, wants, ...values] = inner.filter((piece) => piece.length > 0);
      if (!BLOCK.test(name ?? "")) return `frame block is not a name: ${String(name).slice(0, 40)}`;
      if (!/^"?[01]"?$/.test(wants ?? "")) return `frame marker is not a flag: ${String(wants).slice(0, 40)}`;
      for (const one of values) {
        if (!WORD.test(one)) return `live value is not a word: ${one.slice(0, 40)}`;
      }
    }
  } else if (value !== '"void"' && !WORD.test(value)) {
    return `return value is not a word: ${value.slice(0, 40)}`;
  }
  // globals travel with every chunk in both directions
  for (const one of splitTop(globals.slice(1, globals.lastIndexOf("]")))) {
    if (one.length && !WORD.test(one)) return `global is not a word: ${one.slice(0, 40)}`;
  }
  return undefined;
};

/// A saved call: the block to come back to, whether a returned value belongs on
/// its stack, and then the values it takes - the locals it reads and the stack
/// it left behind, already in parameter order.
export type Frame = { block: string; wantsValue: boolean; saved: string[] };

/// The printed frame list, turned back into source we can paste. The compiler
/// emits `[['50_105', '000...1'], ['51_2']]`, innermost first.
export const parseFrames = (printed: string): Frame[] => {
  const body = printed.slice(printed.indexOf("[") + 1, printed.lastIndexOf("]"));
  return splitTop(body)
    .filter((part) => part.length > 0)
    .map((part) => {
      const inner = part.slice(part.indexOf("[") + 1, part.lastIndexOf("]"));
      const pieces = splitTop(inner).filter((piece) => piece.length > 0);
      return {
        block: pieces[0].replace(/"/g, ""),
        wantsValue: pieces[1].replace(/"/g, "") === "1",
        saved: pieces.slice(2).map(toSource),
      };
    });
};

/// The call that re-enters a frame: its block, the frames still below it, the
/// memory and globals it inherits, and - when a call is returning into it - the
/// value that call produced, which belongs on the top of its stack.
///
/// `$Exit` wraps it because this is a result the host reads: a return keeps its
/// write buffer inside the types, and only what gets printed has to be flushed.
const printFrame = (f: Frame) =>
  `['${f.block}', '${f.wantsValue ? 1 : 0}'${f.saved.length ? ", " + f.saved.join(", ") : ""}]`;

export const enter = (
  frame: Frame,
  below: Frame[],
  globals: string[],
  value?: string,
): string => {
  // the value only goes on when the frame asked for one: a void call leaves the
  // stack as it was, and the blocks after it were compiled for that stack
  const returned = frame.wantsValue && value !== undefined ? [value] : [];
  const rest = `[${below.map(printFrame).join(", ")}]`;
  const args = [`$FUEL`, rest, `$Buf<$IN>`, ...globals, ...frame.saved, ...returned];
  // Each frame below is re-entered by the host, one chunk per return. Tried:
  // re-entering them in-type as a chain of tail aliases ($U0..$Un), so a
  // suspension's whole stack unwinds in one chunk. At a fixed 10752 fuel that
  // was 97s against 136s for this frame; but a chunk that unwinds a deep
  // stack and then recurses back into the renderer trips the checker's depth
  // limit at the fuel that otherwise lands (21504), and the failed attempt
  // costs its full evaluation before it fails: adaptive fuel came in at 140s
  // against 80s. Until calls stop nesting evaluations (a return that jumps
  // to its continuation instead of matching inline), the host round trip
  // is the cheaper of the two.
  return `$Exit<$b${frame.block}<${args.join(", ")}>>`;
};

/// Did the printer give up part way through?
/// Fuel per chunk. What ends a chunk is not wall time but the checker giving
/// up: it stops at 4,029,558 instantiations and reports "excessively deep".
/// Measured on doom chunk 24551 by re-checking the dumped chunk standalone at
/// a fixed state, so the numbers are deterministic:
///
///     fuel     1  ->  1.27M instantiations      fuel  1100 -> 3.57M
///     fuel   768  ->  2.90M                     fuel  1280 -> 3.95M  (ok)
///     fuel  1024  ->  3.43M                     fuel  1536 -> gives up
///
/// Those numbers were measured on the flat `Record<string, string>` memory,
/// where instantiation cost scaled with fuel and the checker gave up past
/// 1280. The 64-way trie broke that link: cost now scales with words touched,
/// not words held, and the same in-level state retires 655,360 fuel in
/// ~1.1s/chunk with zero elisions (measured live at chunk ~4800, E1M1).
/// The adaptive ladder below still doubles from 10 and halves on "too deep",
/// so the default is a cap, not a promise: on states the checker cannot
/// afford, it settles lower by itself. 1,310,720 was knocked back to 655,360
/// on the same state, which is where the ceiling sits today.
/// Extra segments per chunk, on top of the first one.
///
/// A chunk used to be one chain of tail instantiations, and the checker's
/// tail-recursion elision quits at 1000 iterations: measured on a doom chunk,
/// 940 and 980 land while 1000, 1020 and 1060 all report TS2589. Cost was never
/// the limit - the marginal cost is 275 instantiations per instruction, so the
/// 5M instantiation budget is worth ~18,000 of them against the ~1000 the cap
/// allowed.
///
/// Segments live inside the chunk now: `$Run` in the module re-enters the
/// innermost frame at every segment mark in the fuel (see `fuelType` and
/// wrap_block in the compiler), so a chunk is many tail chains rather than
/// one, and the old host-side `$Drive` loop over segments is gone. The reason
/// the old one had to stay at one segment is fixed too: it re-entered with a
/// fresh `$Buf`, which threw away the previous segment's stores, while `$Run`
/// carries the overlay through untouched.

/// A probe that fails costs time in proportion to its fuel, and the big ones
/// cost minutes: from the mid-level state in /tmp/prof.json, walking down from
/// 655360 (655360, 327680, 163840, 81920 all "too deep") took 547s before the
/// first chunk landed at 20480; starting at 40960 landed in 25s. The same
/// state runs 2754 units/s at 8640 against 1342 at 1080, so the ceiling only
/// needs to sit above the sweet spot, not at the top of the ladder.
///
/// Equal-budget gameplay sweep from the live7 checkpoint (49152 total fuel):
/// 8192x6 chunks -> 98 frames in 93.19s (1.05 fps) against 16384x3 -> 46
/// frames in 77.53s (0.59 fps); single-chunk sweep put 8192 ahead of 6144,
/// 10240, 12288, 16384, 20480, 24576 and 32768 as well. Checker cost per
/// chunk grew superlinearly with fuel while frames landed grow ~linearly,
/// so the smaller chunk won on wall-clock fps despite more resume overhead.
///
/// Re-measured 2026-08-22 on tsgo 7.1.0-dev.20260822 + flow memoization:
/// the superlinear term is gone. Equal-budget sweep (49152 total fuel,
/// same seed, same 7 frames landed in every run): 4096x12 -> 183.9s
/// (267 units/s), 8192x6 -> 116.9s (420 units/s), 16384x3 -> 90.4s
/// (544 units/s, 2.04x). 32768 and 49152 trip the checker's depth ceiling,
/// fail, and auto-halve - the wasted attempt makes them net losers
/// (319/353 units/s). 16384 is the sweet spot.
///
/// Re-measured 2026-08-22 after the part-split state + conditional-flow work:
/// the depth ceiling no longer trips at 24576/32768. Clean interleaved 3x3
/// probe (live session paused, same seed, same chunks each run):
/// 16384 -> 229/237/238 units/s, 24576 -> 288/291/288 (+22%),
/// 32768 -> 289/290/289 (flat). 24576 is the new sweet spot; going higher
/// buys nothing and just lengthens the worst-case key-to-frame latency.
const DEFAULT_FUEL = 24576;

/// How long one chunk may take before its fuel counts as over the edge.
///
/// The ceiling above is a cap on instructions, not on time, and the two came
/// apart on doom: a chunk that retires 655,360 fuel in ~1.1s at one state sat
/// for 56 minutes at another. Keys reach the game between chunks, so a chunk
/// that runs for minutes is indistinguishable from a hang at the keyboard.
/// Keys are latched by the host until the game acks them, and the game only
/// reads them once per frame, so chunk length is not key latency: it is the
/// unit of state round trip (~1-3s of print/parse per chunk on a 4MB level
/// state). Measured on an E1M1 frame, chunk cost is ~linear in fuel (10752 ->
/// 27s, 21504 -> 50s standalone) while the round trips are not, so the guard
/// only has to catch a genuine hang: 30s.
///
/// Raised to 90s for DEFAULT_FUEL = 24576: a healthy 24576 chunk runs
/// ~40-45s wall (measured 2026-08-22), so 30s was auto-halving every chunk
/// and silently undoing the fuel bump. The hangs this guard exists for sat
/// for minutes, so 2x the healthy ceiling still catches them.
const SLOW_CHUNK_MS = 90000;

/// see fuelType
const FUEL_SEGMENT = 400;

const TRUNCATED = /\bany\b/;

/// Read the memory, splitting it into branches only if the printer truncated.
///
/// One read is the normal case and costs one evaluation. When the state grows
/// past what the printer will emit, the same subtree is asked for a branch at a
/// time and stitched back together here - the pieces are the checker's own
/// output, so the result is the same text it would have printed if it could.
export const readState = async (
  read: (name: string) => Promise<string>,
  fanout: number,
  // Which readers have already come back truncated. A memory that has outgrown
  // the printer once does not shrink back, and asking again costs a full print -
  // the most expensive read in the chunk - to learn what we already know.
  split: Set<string>,
): Promise<string> => {
  const readOr = async (name: string, children: () => Promise<string>): Promise<string> => {
    if (!split.has(name)) {
      const whole = await read(name);
      if (!TRUNCATED.test(whole)) return whole;
      split.add(name);
    }
    return children();
  };
  if (fanout === 0) return read("$Out_Mem");
  return readOr("$Out_Mem", async () => {
    const branches: string[] = [];
    for (let i = 0; i < fanout; i++) {
      branches.push(
        await readOr(`$Out_Mem_${i}`, async () => {
          const inner: string[] = [];
          for (let j = 0; j < fanout; j++) inner.push(await read(`$Out_Mem_${i}_${j}`));
          return `[${inner.join(", ")}]`;
        }),
      );
    }
    return `[${branches.join(", ")}]`;
  });
};

/// Everything needed to pick a run up again: where it was, what it was holding,
/// and how much of it has already been paid for.
export interface Checkpoint {
  /// The run reached a top-level return: `call` is an answer, not a
  /// continuation. Both print as $Exit<..>, so only the driver can tell them
  /// apart, and a resumer that guesses either re-reports an old answer or
  /// throws away a suspended frame.
  done?: boolean;
  call: string;
  memory: string;
  frames: Frame[];
  globals: string[];
  chunks: number;
  /// The KEY_SCRIPT index of the frame this call is running. A resume that
  /// restarted the script at 0 would replay frame 0's keys on frame 990.
  scriptFrame?: number;
  /// The address the finished call returned: the screen it drew into.
  result?: string;
  /// The screen the frame *before* this one returned. The renderer draws
  /// `result`, so that buffer has to stay readable; this is the one that is
  /// safe to drop.
  prevResult?: string;
  /// Chunks this `entry` call has done, where `chunks` counts every chunk since
  /// the seed. A frame is one `entry` call, so this is what a reader watches to
  /// see a frame boundary: `chunks` only ever climbs, including across the
  /// re-entry the play loop does for the next frame.
  entryChunks: number;
  evalMs: number;
  split: string[];
  /// The fuel search state, which is a property of the module and not of the
  /// process that found it. Nine evaluations at chunk 0 are spent walking
  /// 655360 down to the edge, and a cold resume that starts at DEFAULT_FUEL
  /// pays them again for an edge the previous run already located. A/B on one
  /// checkpoint, six chunks each, differing only in whether the edge was
  /// saved: 344 units/s with it against 129 without, and the cold run also
  /// overshoots to fuel 1280 where the warm one holds the measured 980.
  fuel?: number;
  /// The lowest fuel known to fail. `Infinity` is not JSON, so an unbounded
  /// cap is written as absent rather than as `null`.
  capFail?: number;
}

export interface RunResult {
  value?: string;
  memory: string;
  chunks: number;
  backoffs: number;
  units: number;
  fuel: number;
  evalMs: number;
  totalMs: number;
  failed?: string;
}

/// One compiler instance, reused across chunks and frames: creating it costs
/// more than a chunk evaluation does.
export type Session = { env: ReturnType<typeof createEnv>; path: string };

/// The checker is Go, and more than half of a chunk's profile is its garbage
/// collector (`madvise`, `scanObject`, `typePointersOfUnchecked`, ...): the
/// module alone is 1.4GB live before any work, so the default GOGC=100 - grow
/// the heap 100% between collections - collects constantly. Measured on one
/// E1M1 frame at fuel 16000: 109.9s at 100, 90.5s and 89.2s at 400, 92.9s at
/// 800 (and 1.9GB of RSS instead of 1.2GB), so 400 is the knee.
const GC_HEADROOM = process.env.GOGC ?? "400";

export const createSession = (): Session => {
  process.env.GOGC = GC_HEADROOM;
  const path = join(__dirname, `chunk-${process.pid}.ts`);
  return { env: createEnv(path), path };
};

export const run = async (
  modulePath: string,
  entry: string,
  args: string[],
  options: {
    fuel?: number;
    max?: number;
    quiet?: boolean;
    memory?: string;
    session?: Session;
    /// pick up where a previous run left off
    resume?: Checkpoint;
    /// where to write the checkpoint, and how often
    save?: string;
    every?: number;
    /// the module represents words as byte-tuples (see w4Encode/w4Decode)
    word4?: boolean;
    onCheckpoint?: (point: Checkpoint, path: string) => void;
  } = {},
): Promise<RunResult> => {
  let fuel = options.fuel ?? DEFAULT_FUEL;
  const minFuel = 4;
  const max = options.max ?? 10000;
  const moduleText = readFileSync(modulePath, "utf8")
    // the chunk file inlines the module, so its imports must resolve from here
    .replace(/^export type/gm, "type");
  // The module and the incoming state go in `.d.ts` files, and `skipLibCheck`
  // means the checker never checks a declaration file: an alias in there is
  // instantiated only where the chunk actually reads it. Inlined into the
  // chunk instead, every one of the module's ~2200 declarations is resolved
  // before the chunk runs a single step. Measured on doom chunk-0000, a chunk
  // with its evaluation stubbed out to a constant:
  //
  //     inlined     2,768,896 instantiations   0.650s
  //     .d.ts       2,002,187 instantiations   0.285s
  //
  // The evaluation itself is 11,461 instantiations, 0.4% of either number.
  // A declaration file with no top-level import or export is global, so the
  // chunk sees every name in it without importing anything - hence rewriting
  // the one import to `import('ts-type-math').X` types.
  //
  // One alias per imported name, not one `import()` per use site. Every
  // `import(...)` in a file is a dynamic import as far as the compiler is
  // concerned, and it rescans the whole file to locate each one
  // (ForEachDynamicImportOrRequireCall -> GetNodeAtPosition, which walks the
  // AST from the root per occurrence). doom's module inlined 92,751 of them,
  // and the program is rebuilt once per chunk. Measured on a gameplay chunk:
  //
  //     per use site   parse 6.322s   check 0.771s   total 7.312s
  //     one alias      parse 0.806s   check 0.993s   total 2.021s
  //
  // The resulting tag, globals and frames are identical.
  const globalModuleText = (() => {
    // `$InitialMemory` is 39MB of doom's 107MB module and no *type* refers to
    // it: `$InitFetch` reads the paged `$InitialMap` instead, and this
    // declaration exists for the host, which parses it out of the .cfg.ts
    // itself (see `initialMemory` and render-frame). Handing it to the checker
    // costs a parse and a bind of 39MB on every compiler instance for nothing.
    const oldSlice = `type $Slice<A extends string> =
  A extends \`000000\${infer B extends string}00\`
    ? B
    : $SliceWide<A>`;
    const newSlice = `type $Slice<A extends string> =
  A extends \`000000\${infer B extends string}00\` ? B
  : A extends \`000000\${infer B extends string}01\` ? B
  : A extends \`000000\${infer B extends string}10\` ? B
  : A extends \`000000\${infer B extends string}11\` ? B
  : $SliceWide<A>`;
    const oldSplit = `type $Split<A extends string> =
  A extends \`000000\${infer b0}\${infer b1}\${infer b2}\${infer b3}\${infer b4}\${infer b5}\${infer b6}\${infer b7}\${infer b8}\${infer b9}\${infer b10}\${infer b11}\${infer b12}\${infer b13}\${infer b14}\${infer b15}\${infer b16}\${infer b17}\${infer b18}\${infer b19}\${infer b20}\${infer b21}\${infer b22}\${infer b23}00\`
    ? [\`\${b0}\${b1}\${b2}\${b3}\${b4}\${b5}\${b6}\${b7}\${b8}\${b9}\${b10}\${b11}\${b12}\${b13}\${b14}\${b15}\${b16}\${b17}\`, [\`\${b0}\${b1}\${b2}\${b3}\${b4}\${b5}\`, \`\${b6}\${b7}\${b8}\${b9}\${b10}\${b11}\`, \`\${b12}\${b13}\${b14}\${b15}\${b16}\${b17}\`], \`\${b18}\${b19}\${b20}\${b21}\${b22}\${b23}\`]
    : $SplitWide<A>`;
    const newSplit = `type $Split<A extends string> =
  $Slice<A> extends \`\${infer b0}\${infer b1}\${infer b2}\${infer b3}\${infer b4}\${infer b5}\${infer b6}\${infer b7}\${infer b8}\${infer b9}\${infer b10}\${infer b11}\${infer b12}\${infer b13}\${infer b14}\${infer b15}\${infer b16}\${infer b17}\${infer d}\`
    ? [\`\${b0}\${b1}\${b2}\${b3}\${b4}\${b5}\${b6}\${b7}\${b8}\${b9}\${b10}\${b11}\${b12}\${b13}\${b14}\${b15}\${b16}\${b17}\`, [\`\${b0}\${b1}\${b2}\${b3}\${b4}\${b5}\`, \`\${b6}\${b7}\${b8}\${b9}\${b10}\${b11}\`, \`\${b12}\${b13}\${b14}\${b15}\${b16}\${b17}\`], d]
    : never`;
    const oldWrite = `type $Write<M extends $Node, A extends WasmValue, V extends WasmValue> =
  $Split<A> extends [infer K extends string, infer B extends unknown[], infer D extends string]
    ? M extends [infer T, infer MK, infer MB extends unknown[], infer S extends unknown[][], infer Base]
      ? K extends MK
        ? [T, MK, MB, $BSet<S, D, [V]>, Base]
        : [(MK extends 'eeeeeeeeeeeeeeeeee' ? T : $MergeAt<T, MB, S>), K, B, $BSet<$Empty, D, [V]>, Base]
      : never
    : never`;
    const newWrite = `type $Write<M extends $Node, A extends WasmValue, V extends WasmValue> =
  M extends [infer T, infer MK extends string, infer MB extends unknown[], infer S extends unknown[][], infer Base]
    ? $Slice<A> extends infer P extends string
      ? P extends \`\${MK}\${infer D}\`
        ? [T, MK, MB, $BSet<S, D, [V]>, Base]
        : $Split<A> extends [infer K extends string, infer B extends unknown[], infer D extends string]
          ? [(MK extends 'eeeeeeeeeeeeeeeeee' ? T : $MergeAt<T, MB, S>), K, B, $BSet<$Empty, D, [V]>, Base]
          : never
      : never
    : never`;
    const oldBlit = `type $Blit8<M extends $Node, D extends WasmValue, S extends WasmValue, C extends WasmValue, DS extends WasmValue, SS extends WasmValue> =
  C extends '00000000000000000000000000000000'
  ? M
  : C extends \`00000000000000000000000\${string}\`
  ? ($Store8<M, D, $Load8U<M, S>> extends infer M2 extends $Node
    ? $Blit8<M2, Wasm.I32Add<D, DS>, Wasm.I32Add<S, SS>, Wasm.I32Sub<C, '00000000000000000000000000000001'>, DS, SS>
    : never)
  : $BlitH<C> extends infer H extends WasmValue
    ? $Blit8<M, D, S, H, DS, SS> extends infer M2 extends $Node
      ? $Blit8<M2, Wasm.I32Add<D, Wasm.I32Mul<H, DS>>, Wasm.I32Add<S, Wasm.I32Mul<H, SS>>, Wasm.I32Sub<C, H>, DS, SS>
      : never
    : never`;
   const newBlit = `type $Blit8<M extends $Node, D extends WasmValue, S extends WasmValue, C extends WasmValue, DS extends WasmValue, SS extends WasmValue> =
   C extends '00000000000000000000000000000000'
   ? M
   : [C, DS, SS, D, S] extends ['00000000000000000000000000000100', '00000000000000000000000000000001', '00000000000000000000000000000001', \`\${string}00\`, \`\${string}00\`]
     ? $Write<M, D, $Read<M, S>>
     : C extends \`00000000000000000000000000000\${string}\`
       ? ($Store8<M, D, $Load8U<M, S>> extends infer M2 extends $Node ? $Blit8<M2, Wasm.I32Add<D, DS>, Wasm.I32Add<S, SS>, Wasm.I32Sub<C, '00000000000000000000000000000001'>, DS, SS> : never)
       : $BlitH<C> extends infer H extends WasmValue
         ? $Blit8<M, D, S, H, DS, SS> extends infer M2 extends $Node
           ? $Blit8<M2, Wasm.I32Add<D, Wasm.I32Mul<H, DS>>, Wasm.I32Add<S, Wasm.I32Mul<H, SS>>, Wasm.I32Sub<C, H>, DS, SS>
           : never
         : never`;
    const oldFill = `type $Fill8<M extends $Node, D extends WasmValue, V extends WasmValue, C extends WasmValue> =
  C extends '00000000000000000000000000000000'
  ? M
  : C extends \`00000000000000000000000\${string}\`
  ? ($Store8<M, D, V> extends infer M2 extends $Node
    ? $Fill8<M2, Wasm.I32Add<D, '00000000000000000000000000000001'>, V, Wasm.I32Sub<C, '00000000000000000000000000000001'>>
    : never)
  : $BlitH<C> extends infer H extends WasmValue
    ? $Fill8<M, D, V, H> extends infer M2 extends $Node
      ? $Fill8<M2, Wasm.I32Add<D, H>, V, Wasm.I32Sub<C, H>>
      : never
    : never`;
   const newFill = `type $Low8<V extends string> = V extends \`000000000000000000000000\${infer B}\` ? B : V extends \`\${infer _0}\${infer _1}\${infer _2}\${infer _3}\${infer _4}\${infer _5}\${infer _6}\${infer _7}\${infer _8}\${infer _9}\${infer _10}\${infer _11}\${infer _12}\${infer _13}\${infer _14}\${infer _15}\${infer _16}\${infer _17}\${infer _18}\${infer _19}\${infer _20}\${infer _21}\${infer _22}\${infer _23}\${infer B}\` ? B : never
 type $Fill8<M extends $Node, D extends WasmValue, V extends WasmValue, C extends WasmValue> =
   C extends '00000000000000000000000000000000'
   ? M
   : [C, D] extends ['00000000000000000000000000000100', \`\${string}00\`]
     ? ($Low8<V> extends infer B extends string ? $Write<M, D, \`\${B}\${B}\${B}\${B}\`> : never)
     : C extends \`00000000000000000000000000000\${string}\`
       ? ($Store8<M, D, V> extends infer M2 extends $Node ? $Fill8<M2, Wasm.I32Add<D, '00000000000000000000000000000001'>, V, Wasm.I32Sub<C, '00000000000000000000000000000001'>> : never)
       : $BlitH<C> extends infer H extends WasmValue
         ? $Fill8<M, D, V, H> extends infer M2 extends $Node
           ? $Fill8<M2, Wasm.I32Add<D, H>, V, Wasm.I32Sub<C, H>>
           : never
         : never`;
    const oldCol = `type $Tex_16_0_7<M extends $Node, D extends WasmValue, KD extends WasmValue, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, B extends WasmValue, DB extends WasmValue, C extends WasmValue, D2 extends WasmValue, KD2 extends WasmValue> =
  C extends '00000000000000000000000000000000'
  ? M
  : C extends \`00000000000000000000000\${string}\`
  ? ($Load8U<M, Wasm.I32Add<CM, $Load8U<M, Wasm.I32Add<SRC, $TexIdx_16_0_7<A, B>>>>> extends infer V extends WasmValue
    ? $Store8<M, D, V> extends infer M2 extends $Node
      ? $Tex_16_0_7<M2, Wasm.I32Add<D, KD>, KD, CM, SRC, Wasm.I32Add<A, DA>, DA, Wasm.I32Add<B, DB>, DB, Wasm.I32Sub<C, '00000000000000000000000000000001'>, D2, KD2>
      : never
    : never)
  : $BlitH<C> extends infer H extends WasmValue
    ? $Tex_16_0_7<M, D, KD, CM, SRC, A, DA, B, DB, H, D2, KD2> extends infer M2 extends $Node
      ? $Tex_16_0_7<M2, Wasm.I32Add<D, Wasm.I32Mul<H, KD>>, KD, CM, SRC, Wasm.I32Add<A, Wasm.I32Mul<H, DA>>, DA, Wasm.I32Add<B, Wasm.I32Mul<H, DB>>, DB, Wasm.I32Sub<C, H>, D2, KD2>
      : never
    : never`;
    const oldIdx16 = `type $TexIdx_16_0_7<A extends WasmValue, B extends WasmValue> =
  A extends \`\${infer a0}\${infer a1}\${infer a2}\${infer a3}\${infer a4}\${infer a5}\${infer a6}\${infer a7}\${infer a8}\${infer a9}\${infer a10}\${infer a11}\${infer a12}\${infer a13}\${infer a14}\${infer a15}\${infer a16}\${infer a17}\${infer a18}\${infer a19}\${infer a20}\${infer a21}\${infer a22}\${infer a23}\${infer a24}\${infer a25}\${infer a26}\${infer a27}\${infer a28}\${infer a29}\${infer a30}\${infer a31}\` ? \`0000000000000000000000000\${a9}\${a10}\${a11}\${a12}\${a13}\${a14}\${a15}\` : never`;
    const newIdx16 = `type $TexIdx_16_0_7<A extends WasmValue, _B extends WasmValue> =
  A extends \`\${infer _a0}\${infer _a1}\${infer _a2}\${infer _a3}\${infer _a4}\${infer _a5}\${infer _a6}\${infer _a7}\${infer _a8}\${infer a9}\${infer a10}\${infer a11}\${infer a12}\${infer a13}\${infer a14}\${infer a15}\${string}\` ? \`0000000000000000000000000\${a9}\${a10}\${a11}\${a12}\${a13}\${a14}\${a15}\` : never`;
    const oldIdxSpan = `type $TexIdx_10_6_6_16_0_6<A extends WasmValue, B extends WasmValue> =
  A extends \`\${infer a0}\${infer a1}\${infer a2}\${infer a3}\${infer a4}\${infer a5}\${infer a6}\${infer a7}\${infer a8}\${infer a9}\${infer a10}\${infer a11}\${infer a12}\${infer a13}\${infer a14}\${infer a15}\${infer a16}\${infer a17}\${infer a18}\${infer a19}\${infer a20}\${infer a21}\${infer a22}\${infer a23}\${infer a24}\${infer a25}\${infer a26}\${infer a27}\${infer a28}\${infer a29}\${infer a30}\${infer a31}\` ? B extends \`\${infer b0}\${infer b1}\${infer b2}\${infer b3}\${infer b4}\${infer b5}\${infer b6}\${infer b7}\${infer b8}\${infer b9}\${infer b10}\${infer b11}\${infer b12}\${infer b13}\${infer b14}\${infer b15}\${infer b16}\${infer b17}\${infer b18}\${infer b19}\${infer b20}\${infer b21}\${infer b22}\${infer b23}\${infer b24}\${infer b25}\${infer b26}\${infer b27}\${infer b28}\${infer b29}\${infer b30}\${infer b31}\` ? \`00000000000000000000\${a10}\${a11}\${a12}\${a13}\${a14}\${a15}\${b10}\${b11}\${b12}\${b13}\${b14}\${b15}\` : never : never`;
    const newIdxSpan = `type $TexIdx_10_6_6_16_0_6<A extends WasmValue, B extends WasmValue> =
  A extends \`\${infer _a0}\${infer _a1}\${infer _a2}\${infer _a3}\${infer _a4}\${infer _a5}\${infer _a6}\${infer _a7}\${infer _a8}\${infer _a9}\${infer a10}\${infer a11}\${infer a12}\${infer a13}\${infer a14}\${infer a15}\${string}\` ? B extends \`\${infer _b0}\${infer _b1}\${infer _b2}\${infer _b3}\${infer _b4}\${infer _b5}\${infer _b6}\${infer _b7}\${infer _b8}\${infer _b9}\${infer b10}\${infer b11}\${infer b12}\${infer b13}\${infer b14}\${infer b15}\${string}\` ? \`00000000000000000000\${a10}\${a11}\${a12}\${a13}\${a14}\${a15}\${b10}\${b11}\${b12}\${b13}\${b14}\${b15}\` : never : never`;
    const newCol = `type $GetByte8<W extends string, O extends string> =
  O extends '11'
    ? (W extends \`\${infer w0}\${infer w1}\${infer w2}\${infer w3}\${infer w4}\${infer w5}\${infer w6}\${infer w7}\${string}\` ? \`\${w0}\${w1}\${w2}\${w3}\${w4}\${w5}\${w6}\${w7}\` : never)
    : O extends '10'
      ? (W extends \`\${infer _0}\${infer _1}\${infer _2}\${infer _3}\${infer _4}\${infer _5}\${infer _6}\${infer _7}\${infer w8}\${infer w9}\${infer w10}\${infer w11}\${infer w12}\${infer w13}\${infer w14}\${infer w15}\${string}\` ? \`\${w8}\${w9}\${w10}\${w11}\${w12}\${w13}\${w14}\${w15}\` : never)
      : O extends '01'
        ? (W extends \`\${infer _0}\${infer _1}\${infer _2}\${infer _3}\${infer _4}\${infer _5}\${infer _6}\${infer _7}\${infer _8}\${infer _9}\${infer _10}\${infer _11}\${infer _12}\${infer _13}\${infer _14}\${infer _15}\${infer w16}\${infer w17}\${infer w18}\${infer w19}\${infer w20}\${infer w21}\${infer w22}\${infer w23}\${string}\` ? \`\${w16}\${w17}\${w18}\${w19}\${w20}\${w21}\${w22}\${w23}\` : never)
        : (W extends \`\${infer _0}\${infer _1}\${infer _2}\${infer _3}\${infer _4}\${infer _5}\${infer _6}\${infer _7}\${infer _8}\${infer _9}\${infer _10}\${infer _11}\${infer _12}\${infer _13}\${infer _14}\${infer _15}\${infer _16}\${infer _17}\${infer _18}\${infer _19}\${infer _20}\${infer _21}\${infer _22}\${infer _23}\${infer B}\` ? B : never)
type $SetByte8<W extends string, O extends string, B extends string> =
  O extends '11'
    ? (W extends \`\${infer _0}\${infer _1}\${infer _2}\${infer _3}\${infer _4}\${infer _5}\${infer _6}\${infer _7}\${infer Rest}\` ? \`\${B}\${Rest}\` : never)
    : O extends '10'
      ? (W extends \`\${infer w0}\${infer w1}\${infer w2}\${infer w3}\${infer w4}\${infer w5}\${infer w6}\${infer w7}\${infer _8}\${infer _9}\${infer _10}\${infer _11}\${infer _12}\${infer _13}\${infer _14}\${infer _15}\${infer Rest}\` ? \`\${w0}\${w1}\${w2}\${w3}\${w4}\${w5}\${w6}\${w7}\${B}\${Rest}\` : never)
      : O extends '01'
        ? (W extends \`\${infer w0}\${infer w1}\${infer w2}\${infer w3}\${infer w4}\${infer w5}\${infer w6}\${infer w7}\${infer w8}\${infer w9}\${infer w10}\${infer w11}\${infer w12}\${infer w13}\${infer w14}\${infer w15}\${infer _16}\${infer _17}\${infer _18}\${infer _19}\${infer _20}\${infer _21}\${infer _22}\${infer _23}\${infer Rest}\` ? \`\${w0}\${w1}\${w2}\${w3}\${w4}\${w5}\${w6}\${w7}\${w8}\${w9}\${w10}\${w11}\${w12}\${w13}\${w14}\${w15}\${B}\${Rest}\` : never)
        : (W extends \`\${infer w0}\${infer w1}\${infer w2}\${infer w3}\${infer w4}\${infer w5}\${infer w6}\${infer w7}\${infer w8}\${infer w9}\${infer w10}\${infer w11}\${infer w12}\${infer w13}\${infer w14}\${infer w15}\${infer w16}\${infer w17}\${infer w18}\${infer w19}\${infer w20}\${infer w21}\${infer w22}\${infer w23}\${string}\` ? \`\${w0}\${w1}\${w2}\${w3}\${w4}\${w5}\${w6}\${w7}\${w8}\${w9}\${w10}\${w11}\${w12}\${w13}\${w14}\${w15}\${w16}\${w17}\${w18}\${w19}\${w20}\${w21}\${w22}\${w23}\${B}\` : never)
type $Add5Top20<S extends string> =
  S extends \`\${infer H}00\` ? \`\${$IncTop18<H>}01\` :
  S extends \`\${infer H}01\` ? \`\${$IncTop18<H>}10\` :
  S extends \`\${infer H}10\` ? \`\${$IncTop18<H>}11\` :
  S extends \`\${infer H}11\` ? \`\${$IncTop18<$IncTop18<H>>}00\` :
  never
type $SplitP20<P extends string> =
  P extends \`\${infer p0}\${infer p1}\${infer p2}\${infer p3}\${infer p4}\${infer p5}\${infer p6}\${infer p7}\${infer p8}\${infer p9}\${infer p10}\${infer p11}\${infer p12}\${infer p13}\${infer p14}\${infer p15}\${infer p16}\${infer p17}\${infer p18}\${infer p19}\${infer L4}\`
    ? [\`\${p0}\${p1}\${p2}\${p3}\${p4}\${p5}\${p6}\${p7}\${p8}\${p9}\${p10}\${p11}\${p12}\${p13}\${p14}\${p15}\${p16}\${p17}\${p18}\${p19}\`, L4]
    : never
type $ColLoad8U<T, Base, A extends WasmValue> = $GetByte<$Under<T, Base, $Slice<A>>, $Off<A>>
type $ColPix8<R, Base, CM extends WasmValue, SRC extends WasmValue, IDX extends WasmValue> =
  Wasm.I32Add<CM, $ColLoad8U<R, Base, Wasm.I32Add<SRC, IDX>>> extends infer CMA extends WasmValue
    ? $GetByte8<$Under<R, Base, $Slice<CMA>>, $Off<CMA>>
    : never
type $ColLoopFast<T, R, Base, O extends string, P20 extends string, L4 extends string, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, C extends WasmValue> =
  C extends '00000000000000000000000000000000'
  ? T
  : ($ColPix8<R, Base, CM, SRC, $TexIdx_16_0_7<A, '00000000000000000000000000000000'>> extends infer B8 extends string
    ? \`\${P20}\${L4}\` extends infer P extends string
      ? $SetByte8<$Under<T, Base, P>, O, B8> extends infer W extends string
        ? $Put<T, P, W> extends infer T2
          ? $ColLoopFast<T2, R, Base, O, $Add5Top20<P20>, L4, CM, SRC, Wasm.I32Add<A, DA>, DA, $DecTop32<C>>
          : never
        : never
      : never
    : never)
type $ColLoop<T, R, Base, O extends string, D extends WasmValue, KD extends WasmValue, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, C extends WasmValue> =
  C extends '00000000000000000000000000000000'
  ? T
  : C extends \`00000000000000000000000\${string}\`
  ? ($ColPix8<R, Base, CM, SRC, $TexIdx_16_0_7<A, '00000000000000000000000000000000'>> extends infer B8 extends string
    ? (D extends \`000000\${infer P extends string}00\` ? P : $Slice<D>) extends infer P extends string
      ? $SetByte8<$Under<T, Base, P>, O, B8> extends infer W extends string
        ? $Put<T, P, W> extends infer T2
          ? $ColLoop<T2, R, Base, O, Wasm.I32Add<D, KD>, KD, CM, SRC, Wasm.I32Add<A, DA>, DA, $DecTop32<C>>
          : never
        : never
      : never
    : never)
  : $BlitH<C> extends infer H extends WasmValue
    ? $ColLoop<T, R, Base, O, D, KD, CM, SRC, A, DA, H> extends infer T2
      ? $ColLoop<T2, R, Base, O, Wasm.I32Add<D, Wasm.I32Mul<H, KD>>, KD, CM, SRC, Wasm.I32Add<A, Wasm.I32Mul<H, DA>>, DA, Wasm.I32Sub<C, H>>
      : never
    : never
type $Tex_16_0_7<M extends $Node, D extends WasmValue, KD extends WasmValue, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, _B extends WasmValue, _DB extends WasmValue, C extends WasmValue, _D2 extends WasmValue, _KD2 extends WasmValue> =
  M extends [infer T, infer MK, infer MB extends unknown[], infer S extends unknown[][], infer Base]
    ? (MK extends 'eeeeeeeeeeeeeeeeee' ? T : $MergeAt<T, MB, S>) extends infer T0
      ? (KD extends '00000000000000000000000101000000'
        ? (C extends \`00000000000000000000000\${string}\`
          ? ($SplitP20<$Slice<D>> extends [infer P20 extends string, infer L4 extends string]
            ? [$ColLoopFast<T0, T0, Base, $Off<D>, P20, L4, CM, SRC, A, DA, C>, 'eeeeeeeeeeeeeeeeee', [], $Empty, Base]
            : never)
          : [$ColLoop<T0, T0, Base, $Off<D>, $AlignAddr<D>, KD, CM, SRC, A, DA, C>, 'eeeeeeeeeeeeeeeeee', [], $Empty, Base])
        : [$ColLoop<T0, T0, Base, $Off<D>, $AlignAddr<D>, KD, CM, SRC, A, DA, C>, 'eeeeeeeeeeeeeeeeee', [], $Empty, Base])
      : never
    : never`;
    const oldSpan = `type $Tex_10_6_6_16_0_6<M extends $Node, D extends WasmValue, KD extends WasmValue, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, B extends WasmValue, DB extends WasmValue, C extends WasmValue, D2 extends WasmValue, KD2 extends WasmValue> =
  C extends '00000000000000000000000000000000'
  ? M
  : C extends \`00000000000000000000000\${string}\`
  ? ($Load8U<M, Wasm.I32Add<CM, $Load8U<M, Wasm.I32Add<SRC, $TexIdx_10_6_6_16_0_6<A, B>>>>> extends infer V extends WasmValue
    ? $Store8<M, D, V> extends infer M2 extends $Node
      ? $Tex_10_6_6_16_0_6<M2, Wasm.I32Add<D, KD>, KD, CM, SRC, Wasm.I32Add<A, DA>, DA, Wasm.I32Add<B, DB>, DB, Wasm.I32Sub<C, '00000000000000000000000000000001'>, D2, KD2>
      : never
    : never)
  : $BlitH<C> extends infer H extends WasmValue
    ? $Tex_10_6_6_16_0_6<M, D, KD, CM, SRC, A, DA, B, DB, H, D2, KD2> extends infer M2 extends $Node
      ? $Tex_10_6_6_16_0_6<M2, Wasm.I32Add<D, Wasm.I32Mul<H, KD>>, KD, CM, SRC, Wasm.I32Add<A, Wasm.I32Mul<H, DA>>, DA, Wasm.I32Add<B, Wasm.I32Mul<H, DB>>, DB, Wasm.I32Sub<C, H>, D2, KD2>
      : never
    : never`;
    const newSpan = `type $SpanPix<R extends $Node, CM extends WasmValue, SRC extends WasmValue, IDX extends WasmValue> =
  $Load8U<R, Wasm.I32Add<CM, $Load8U<R, Wasm.I32Add<SRC, IDX>>>>
type $SpanLoop<M extends $Node, R extends $Node, D extends WasmValue, KD extends WasmValue, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, B extends WasmValue, DB extends WasmValue, C extends WasmValue> =
  C extends '00000000000000000000000000000000'
  ? M
  : C extends \`00000000000000000000000\${string}\`
  ? ($Store8<M, D, $SpanPix<R, CM, SRC, $TexIdx_10_6_6_16_0_6<A, B>>> extends infer M2 extends $Node
    ? $SpanLoop<M2, R, KD extends '00000000000000000000000000000001' ? $IncTop32<D> : Wasm.I32Add<D, KD>, KD, CM, SRC, Wasm.I32Add<A, DA>, DA, Wasm.I32Add<B, DB>, DB, $DecTop32<C>>
    : never)
  : $BlitH<C> extends infer H extends WasmValue
    ? $SpanLoop<M, R, D, KD, CM, SRC, A, DA, B, DB, H> extends infer M2 extends $Node
      ? $SpanLoop<M2, R, Wasm.I32Add<D, Wasm.I32Mul<H, KD>>, KD, CM, SRC, Wasm.I32Add<A, Wasm.I32Mul<H, DA>>, DA, Wasm.I32Add<B, Wasm.I32Mul<H, DB>>, DB, Wasm.I32Sub<C, H>>
      : never
    : never
type $Tex_10_6_6_16_0_6<M extends $Node, D extends WasmValue, KD extends WasmValue, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, B extends WasmValue, DB extends WasmValue, C extends WasmValue, _D2 extends WasmValue, _KD2 extends WasmValue> =
  $SpanLoop<M, M, D, KD, CM, SRC, A, DA, B, DB, C>`;
    const withoutInitial = (process.env.KEEP_INITIAL ? moduleText : moduleText.replace(
      /^type \$InitialMemory = [^\n]*\n/m,
      "type $InitialMemory = $Absent\n",
    ))
      .replace(oldSlice, newSlice)
      .replace(oldSplit, newSplit)
      .replace(oldWrite, newWrite)
      .replace(oldBlit, newBlit)
      .replace(oldFill, newFill)
      .replace(oldIdx16, newIdx16)
      .replace(oldIdxSpan, newIdxSpan)
      .replace(oldCol, newCol)
     .replace(oldSpan, newSpan)
      .replace("${c28}${c29}${c30}` : never", "${c28}00` : never")
      .replace("type $State = [$Node, ...WasmValue[]]", "type $State = [any, ...WasmValue[]]")
      .replace(
        /type \$b(43_46|163_6|166_10|621_1)<([^>]+)> =\n  \$F extends `1\$\{infer \$F1\}`\n  \? never/g,
        "type $$b$1<$2> =\n  $$F extends `1$${infer $$F1}`\n  ? ['s', [['trap_$1', '0'], ...$$K], $$M, $$g0, $$g1]",
      );
    // The string module has one import (`from 'ts-type-math'`, bare names); the
    // Word4 module has two (`Convert` from the package, and the byte-tuple
    // helpers from the `/word4` subpath, some `X as Y` aliased and one a
    // namespace, `W4 as Wasm`). Any top-level import left in place makes the
    // .d.ts a module, so its names stop being global and the chunk's `$entry`
    // resolves to nothing - the whole result then defers as `$Tag<$entry<..>>`.
    // So rewrite every ts-type-math import (both sources), honouring `as`.
    const importRe = /^import type \{([^}]*)\} from ['"](ts-type-math(?:\/word4)?)['"];?\n/gm;
    const specs = [...withoutInitial.matchAll(importRe)];
    if (specs.length === 0) return withoutInitial;
    let text = withoutInitial.replace(importRe, "");
    const aliases: string[] = [];
    for (const spec of specs) {
      const src = spec[2]!;
      for (const raw of spec[1]!.split(",")) {
        const part = raw.trim();
        if (!part) continue;
        // `Word4` or `Word4 as WasmValue`: `imported` is the export, `local`
        // the name the body uses.
        const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(part);
        if (!m) continue;
        const imported = m[1]!;
        const local = m[2] ?? m[1]!;
        // A type alias cannot stand in for a namespace, and `import X =
        // import('m').Y` is not legal here, so only the bare uses collapse to an
        // alias; a qualified head (`Wasm.I32Add`) keeps its inline import. Bare
        // uses are 89,140 of doom's 92,751, so the rescan cost goes with them.
        const alias = `$TTM_${local}`;
        // A generic helper (ToStr<W>, FromStr<S>, GetByte4<W,O>, ...) cannot be
        // a bare `type X = import('m').ToStr` alias - that alias is not generic,
        // so `X<A>` is an error and the whole result silently degrades to `any`.
        // Count the type arguments at the first `local<...>` use and forward
        // them through a generic passthrough. `= any` defaults keep a bare use
        // (should one exist) legal too. Non-generic names keep the plain alias.
        const arity = genericArity(text, local);
        const params = Array.from({ length: arity }, (_, k) => `A${k}`);
        let used = false;
        // not `Convert.WasmValue.ToTSNumber`: only the head of a qualified name.
        // A spread (`...WasmValue[]`) is a bare use: only a single `.` qualifies.
        text = text.replace(new RegExp(`(?<![\\w$])(?<![^.]\\.)${local}\\b(\\.)?`, "g"), (_mm, dot: string | undefined) => {
          if (dot) return `import('${src}').${imported}.`;
          used = true;
          return alias;
        });
        if (used) {
          aliases.push(
            arity === 0
              ? `type ${alias} = import('${src}').${imported};`
              : `type ${alias}<${params.map((p) => `${p} = any`).join(", ")}> = import('${src}').${imported}<${params.join(", ")}>;`,
          );
        }
      }
    }
    return aliases.join("\n") + "\n" + text;
  })();
  // the emitter writes these with an `export` in front; a pattern that misses
  // them silently reports a flat memory, and the host then reads `$Out_Mem`
  // whole instead of the split readers and never sees a write land
  const fanout = (moduleText.match(/^(?:export )?type \$Kid\d+</gm) ?? []).length;
  const base = initialMemory(moduleText);
  const inputSlot = inputWordOf(base, fanout);
  const inputPath = options.save ? `${options.save}.input` : "";
  let inputRev = -1;
  // Held keys are a level, but a tap is an edge the poll never sees: a chunk is
  // ~1.5s and a keypress is ~100ms, and 0 of 10 measured Enter taps reached the
  // state while a 5s hold did. The page counts keydowns instead, and each count
  // not yet handed to the game is held down here.
  //
  // How long "held down" has to be is not a guess, and it is not a timer
  // either. `entry` reads the word once, in its first instruction, and hands it
  // to `ts_post_input` before `D_OneFrame`; a measured frame is 194 chunks, so
  // a bit that is up for one chunk is read with probability 1/194 - which is
  // what "I pressed Enter and the menu just sat there" was. The game says when
  // it has taken a key (see ACK_WORD), so a press is a handshake:
  //
  //   idle    -> bit set, once a press is owed
  //   sent    -> hold the bit until the ack shows it: that is the keydown
  //   release -> clear the bit until the ack drops it: that is the keyup
  //
  // Measured: with no released frame between two presses the menu reads them as
  // one long press (`Esc Enter Enter Enter` back-to-back leaves gamestate 3,
  // with a released frame it reaches 0), so `release` is not optional.
  let heldKeys: string[] = [];
  // KEY_SCRIPT=<file>: a JSON array with one held-key list per frame, frame 0
  // being the call the run starts in. It replaces the page's keys, so two runs
  // at different speeds still see the same keys on the same frame, and the run
  // stops when the script does. An entry may instead be `{ keys, poke }`:
  // `poke` is `[byteAddress, u32]` pairs written as that frame's `entry` call
  // starts, which is how bench/doom/tas-keys.mjs hands the game a demo.
  type ScriptFrame = string[] | { keys?: string[]; poke?: [number, number][] };
  const keyScript: ScriptFrame[] | undefined = process.env.KEY_SCRIPT
    ? JSON.parse(readFileSync(process.env.KEY_SCRIPT, "utf8"))
    : undefined;
  const scriptKeys = (frame: number): string[] => {
    const entry = keyScript?.[frame];
    return Array.isArray(entry) ? entry : (entry?.keys ?? []);
  };
  let scriptFrame = 0;
  // One process is one frame, so the handshake has to outlive it. `seen` used
  // to be per-process, which re-owed every press the page had ever counted on
  // every frame: that is the menu opening and closing on its own.
  const latchPath = options.save ? `${options.save}.latch` : "";
  const latchState: {
    seen?: Record<string, number>;
    phase?: "idle" | "sent" | "release";
    code?: string;
  } = (() => {
    try {
      return JSON.parse(readFileSync(latchPath, "utf8"));
    } catch {
      return {};
    }
  })();
  const pressesSeen: Record<string, number> = latchState.seen ?? {};
  /// `pressCounts` is a counter in the page's server process; `pressesSeen`
  /// outlives it in the latch file. Measured: the server restarted at 13:20:34
  /// with its counter back at zero while the latch still said
  /// `{Enter:2,Escape:3}`, so `count - seen` was negative for every key and no
  /// press was ever owed again - both badges stuck on "queued" forever. A
  /// count below its seen value can only mean the counter restarted, so drop
  /// the stale seen. Within one session counts only rise, so this cannot
  /// re-send a press that already landed.
  /// Persisted, not just held: the reseat has to survive this process. The
  /// latch is only written when a phase changes, so a reseat that fixed the
  /// counters in memory left `{"Enter":1}` on disk for an hour (measured: the
  /// page server restarted at 16:01 with presses `{}` while the latch still
  /// read `Enter:1` at 15:02), and the next driver would load the stale count
  /// and swallow the next Enter.
  const reseatSeen = (counts: Record<string, number>) => {
    let changed = false;
    for (const code of Object.keys(pressesSeen)) {
      if ((counts[code] ?? 0) < pressesSeen[code]!) {
        pressesSeen[code] = 0;
        changed = true;
      }
    }
    if (changed) saveLatch();
  };
  let phase: "idle" | "sent" | "release" = latchState.phase ?? "idle";
  let sending: string | undefined = latchState.code;
  /// `ts_post_input` runs once per `entry` call, so the ack word only moves at
  /// a frame boundary: measured 40 chunks of a 72-chunk frame with the bit
  /// already cleared and ack still holding the keydown. Waiting for the keyup
  /// ack before accepting the next press therefore costs a second whole frame
  /// (~2.5 min measured), and the page has already retired the count by then,
  /// so the player sees the badge clear and the key do nothing. The keyup does
  /// not need an ack: the bit is cleared in the state, so the game posts it on
  /// its own next frame either way. Go idle as soon as the keydown lands and
  /// only hold back a repeat of that same key until its release is seen - a
  /// same-key press written before the keyup is posted is no edge at all. The
  /// ack word itself says which keys those are, so nothing needs to be latched.
  const saveLatch = () => {
    if (process.env.TRACE_LATCH)
      process.stderr.write(`\nLATCH phase=${phase} code=${sending} seen=${JSON.stringify(pressesSeen)} counts=${JSON.stringify(pressCounts)}\n`);
    if (latchPath) writeFileSync(latchPath, JSON.stringify({ seen: pressesSeen, phase, code: sending }));
  };
  let pressCounts: Record<string, number> = {};
  let pressOrder: string[] = [];
  let inputMask = "";
  // Readers for the memory a branch at a time, two levels down. They cost
  // nothing until one is asked for: a type alias is only instantiated when
  // something reads it, and the whole point is that almost always only the
  // root is read.
  const splitReaders = (active: Set<string>): string => {
    const lines: string[] = [];
    const exp1 = active.has("$Out_Mem") ? "export " : "";
    for (let i = 0; i < fanout; i++) {
      const m1 = `$Out_Mem_${i}`;
      lines.push(`${exp1 && !active.has(m1) ? "export " : ""}type ${m1} = $Kid${i}<$Out_Mem>`);
      if (active.has(m1) || process.env.DUMP_CHUNKS) {
        const exp2 = active.has(m1) ? "export " : "";
        for (let j = 0; j < fanout; j++) {
          lines.push(`${exp2}type ${m1}_${j} = $Kid${j}<${m1}>`);
        }
      }
    }
    return lines.join("\n");
  };
  // one '1' per unit of work; taking a prefix off a string is free, unlike
  // re-slicing a tuple on every hop
  /// Where a finished frame's successor comes from.
///
/// Calling a spent `entry` again traps: doom's init runs sbrk, and sbrk's bump
/// pointer already moved, so memset runs off the end of memory. Native wasm
/// says so directly - "memory access out of bounds", every memory size from 16
/// to 256 pages - and this runtime turns the same fault into a silent spin,
/// because an out-of-range `$Read` answers 0 instead of trapping.
///
/// Zero that one word and re-entry works. Measured natively, six calls:
///
///   frame 1 ptr 393480  hash 4262db231b
///   frame 2 ptr 655624  hash 6f44692aa8
///   frame 3 ptr 852232  hash a2a8ce9d5b   (title screen, static until the demo)
///
/// The picture advances and each call returns the buffer it drew into, so the
/// frame after this one is `entry` again over the same memory with sbrk reset.
/// Restoring the rest of the allocator's words instead traps in func 12: init
/// wants a virgin zone, and the heap it would re-init is still live.
///
/// sbrk is the function that loads and stores one constant address and calls
/// memset, so the address comes out of the module rather than a constant here.
function sbrkWord(moduleText: string) {
  const funcs = new Map<string, string>();
  for (const m of moduleText.matchAll(/type \$b(\d+)_\d+<[^=]*=([\s\S]*?)(?=(?:export )?type \$)/g))
    funcs.set(m[1]!, (funcs.get(m[1]!) ?? "") + m[2]!);
  for (const [, body] of funcs) {
    const loads = new Set([...body.matchAll(/\$Load32<\$M, '([01]{32})'>/g)].map((m) => m[1]!));
    const stores = new Set([...body.matchAll(/\$Store32<\$[mM]\d*, '([01]{32})'/g)].map((m) => m[1]!));
    const both = [...loads].filter((a) => stores.has(a));
    const calls = new Set([...body.matchAll(/\$call(\d+)</g)].map((m) => m[1]!));
    if (both.length === 1 && calls.size === 1) return both[0]!;
  }
  return undefined;
}

  const entryShape =
    /(?:export )?type \$entry<[^=]*=\s*\$Exit<\$b(\d+)_(\d+)<\$F, \[\], \$Buf<\$M>((?:,\s*'[01]+')*)\s*>>/.exec(moduleText);
  const entryFunc = entryShape?.[1] ?? "";

  // A segment mark every FUEL_SEGMENT units: a block that meets it re-enters
  // itself nested, which restarts the checker's 1000-iteration tail limit at
  // one level of depth per segment (see wrap_block in the compiler). Sized so
  // a segment stays under the tail limit with ~2 tail steps per unit, and a
  // 30k chunk spends ~75 of the 100 depth levels on segments.
  const fuelType = (n: number) => {
    let out = "";
    for (let left = n; left > 0; left -= FUEL_SEGMENT) {
      if (out) out += "x";
      out += "1".repeat(Math.min(FUEL_SEGMENT, left));
    }
    return `'${out}'`;
  };
  // A block whose fuel check asks for a leading `0` is a frame boundary: an
  // ordinary all-ones string cannot match it, so control arriving there suspends
  // and its record reports the loop head's locals. Resuming it needs the one
  // fuel string that gets past the check.
  const boundaryBlocks = new Set(
    [...moduleText.matchAll(/type \$b(\d+_\d+)<[^=]*=\s*\$F extends `0/g)].map((m) => m[1]!),
  );
  const fuelFor = (call: string, n: number) => {
    const at = /\$b(\d+_\d+)</.exec(call)?.[1];
    return at && boundaryBlocks.has(at) ? `'0${"1".repeat(Math.max(n - 1, 0))}'` : fuelType(n);
  };

  let call = `$${entry}<$FUEL, $IN${args.length ? ", " + args.join(", ") : ""}>`;
  // `$Absent` is not an empty address space: a read falls through it to the
  // module's own data. Measured against the module's accessors:
  //
  //   $Load32<$Buf<$Absent>, 65536>   -> 8       (the bucket size table)
  //   $Load32<$Buf<$Absent>, 173636>  -> 76800
  //
  // So a cold run starts here, and `prune` collapsing a subtree back to
  // `$Absent` is how the state stays small rather than a loss.
  let memory = options.memory ?? "$Absent";
  let memoryTrie: Trie = parseTrie(memory);
  // the table the current chunk's state file declares, to read its result back
  let aliasBack = new Map<string, string>();
  let chunks = 0;
  let carried = 0;
  let lastGlobals: string[] = [];
  // the frames below the block currently running, innermost first: what the
  // host has to hand back to when a call returns after a suspension
  let frames: Frame[] = [];
  // which memory readers have already outgrown the printer
  let split = new Set<string>(options.resume?.split ?? []);
  // Chunks since the last backoff. A block deep enough to need less fuel is
  // usually a few blocks, not the rest of the run, so the fuel climbs back:
  // staying at half throughput after one awkward block costs more than the
  // occasional retry does.
  let settled = 0;
  // $entry bakes the module-initial globals into its own call, so calling it
  // again rewinds the stack pointer while memory keeps a heap grown past it:
  // a fresh call, with sbrk reset so init can run again (see sbrkWord). The
  // globals are $entry's own baked ones except the page count (see below);
  // native re-entry is a fresh call, and that is what animates.
  const freshEntryCall = (carriedGlobals: string[]): string => {
    const shape =
      // `moduleText` has already had its `export ` prefixes stripped
      /(?:export )?type \$entry<[^=]*=\s*\$Exit<\$b(\d+_\d+)<\$F, \[\], \$Buf<\$M>((?:,\s*'[01]+')*)\s*>>/.exec(
        moduleText,
      );
    if (!shape) throw new Error("cannot find $entry's call in the module: nothing to restart");
    const baked = shape[2]!.match(/'[01]+'/g) ?? [];
    // ...except the page count, which is not part of a call. It is the last
    // global (`memory.size` answers it), an instance only ever grows it, and
    // doom writes what it implies into its own heap bookkeeping: 174508 holds
    // `memory.size << 16 - 393216`. Frame 2 read that back as a heap it had
    // and a `memory.size` it did not:
    //
    //   174508 = 524288   -> 14 pages when the frame before stored it
    //   $entry's baked g1 = 6
    //
    // so sbrk asked to grow by (524288 - what 6 pages hold) >> 16 = 28277
    // pages, over the trie's 1024, took the refused-grow path and landed on
    // `unreachable` - which is `never`, and reads back as `result tag is
    // never` at every fuel: FAILED chunk 0 at fuel 4 after 4589 chunks and
    // two landed frames (393480, then 655624).
    const pages = baked.length - 1;
    if (carriedGlobals[pages] !== undefined) baked[pages] = carriedGlobals[pages]!;
    const sbrk = sbrkWord(moduleText);
    if (!sbrk) throw new Error("cannot find sbrk's bump pointer in the module: re-entry would trap in init");
    const zero = `'${"0".repeat(32)}'`;
    return (
      `$Exit<$b${shape[1]}<$FUEL, [], $Store32<$Buf<$IN>, '${sbrk}', ${zero}>` +
      `${baked.map((g) => `, ${g}`).join("")}>>`
    );
  };
  if (options.resume) {
    // A checkpoint saved after the run finished holds a terminal call, $Exit<..>.
    // Resuming that re-reports the same answer without running anything, so the
    // frame never advances. Start a fresh call instead: doom keeps the whole
    // game in linear memory, so resumed memory plus a new `entry` is the next
    // frame. Only a suspended call is worth picking up where it left off.
    if (!options.resume.done) {
      call = options.resume.call;
      frames = options.resume.frames;
      // a checkpoint written by the short-lived in-type unwinding wraps the
      // call in `$U0<...>`: the frame it enters is the same, so unwrap it
      if (call.startsWith("$Exit<$U0<")) call = `$Exit<${call.slice("$Exit<$U0<".length, -1)}`;
    } else {
      call = freshEntryCall(options.resume.globals ?? []);
    }
    // a state saved before the split levels were kept can hold a leaf up top
    memoryTrie = prune(parseTrie(options.resume.memory), base, fanout);
    memory = printTrie(memoryTrie);
    carried = options.resume.chunks;
    // A done checkpoint is saved before the index moves on, so its next frame
    // is one past it. KEY_SCRIPT_FRAME covers checkpoints older than the
    // field: record.sh counts it from frames.jsonl.
    if (options.resume.scriptFrame !== undefined)
      scriptFrame = options.resume.scriptFrame + (options.resume.done ? 1 : 0);
    else if (process.env.KEY_SCRIPT_FRAME) scriptFrame = Number(process.env.KEY_SCRIPT_FRAME);
  }
  // An explicit --fuel is an instruction and outranks the saved edge; the
  // checkpoint only speaks when the caller did not.
  // ...but a checkpoint saved at a high edge drags resumes down: inheriting
  // 32768 from live7 lands 42 frames / 157.63s (0.27 fps) where DEFAULT_FUEL
  // 4096 lands 41 / 14.40s (2.85 fps) - chunk cost was superlinear in fuel
  // while frames landed are ~flat. Cap the inherited fuel at DEFAULT_FUEL;
  // an explicit --fuel still outranks both.
  //
  // The same cap also has to be a floor: after the 2026-08-22 re-measure
  // moved DEFAULT_FUEL to 16384, a checkpoint written at the old 4096 edge
  // would otherwise pin every resume at 4096 forever (min only lowers).
  // Start resumes at DEFAULT_FUEL, clamped by the checkpoint's own failure
  // edge (capFail, doubled - same headroom the ladder uses) so a state that
  // genuinely fails above its saved fuel does not eat a wasted big probe.
  if (options.fuel === undefined && options.resume?.fuel !== undefined) {
    const savedEdge = options.resume.capFail !== undefined
      ? options.resume.capFail * 2
      : Infinity;
    fuel = Math.min(DEFAULT_FUEL, savedEdge);
  }
  let backoffs = 0;
  // The fuel that lands is a cliff, not a slope: measured on one real chunk in
  // the session, 640/720/800/960 all come back with a tag and cost the same
  // (852/814/799/803ms), 1120 and 1280 come back never. Cost per chunk barely
  // moves with fuel, so the instructions covered per chunk is set by how close
  // the fuel sits to that edge, and doubling past it wastes a whole evaluation.
  // The cap is inherited across a restart, doubled. Not inheriting it replayed
  // the whole ladder every frame: from 1414 the driver settled up through
  // 2828, 5656, 11312, 22624, 32768, then failed "too deep" at 16384, 8192,
  // 4096, 2048, 1024 and landed back at ~1200 - profiled at 90.7s of retries
  // in a 125.3s frame (eval 25.5s). Inheriting it exactly can pin a stale low
  // edge (a checkpoint once carried capFail 240 where the state held 960), so
  // the doubled cap leaves the midpoint probe one step of headroom above the
  // saved edge: from lastGood 1232 / cap 1408 it tries ~2000 once, at low
  // fuel, rather than 32768.
  let capFail = options.fuel === undefined && options.resume?.capFail !== undefined
    ? options.resume.capFail * 2
    : Infinity;
  // The fuel we are resuming at already landed for the run that saved it, so
  // it is a floor to back off to, not an unknown to re-derive.
  let lastGood = options.fuel === undefined && options.resume?.fuel !== undefined
    ? Math.min(options.resume.fuel, DEFAULT_FUEL)
    : 0;
  let units = 0;
  let evalMs = 0;
  let trieMs = 0;
  let trieParseMs = 0;
  let triePruneMs = 0;
  let triePrintMs = 0;
  let fileMs = 0;
  let saveMs = 0;
  let recycles = 0;
  const why: Record<string, number> = {};
  const lifetimes: number[] = [];
  let recycleMs = 0;
  let degMs = 0;
  let globMs = 0;
  // Every millisecond of the loop lands in exactly one bucket: `mark` closes
  // the span since the previous mark, and the first mark of an iteration
  // closes the tail of the one before it, including the `continue` paths.
  const spans: Record<string, number> = {};
  let last = performance.now();
  const mark = (name: string) => {
    const now = performance.now();
    spans[name] = (spans[name] ?? 0) + (now - last);
    last = now;
  };
  let value_: string | undefined;
  let failed: string | undefined;
  // Chunk count at the current `entry` call's start: `entryChunks` is per
  // frame, and with in-process re-entry one process spans many frames.
  // A resumed mid-frame call keeps counting from where it stopped, or the
  // reader sees `entry` drop and counts a frame that never landed.
  let entryStart = options.resume && !options.resume.done ? -(options.resume.entryChunks ?? 0) : 0;
  // The screen chain across in-process frames: what `resume.result` and
  // `resume.prevResult` carry across processes, carried here across re-entries.
  let lastResult = options.resume?.result;
  let prevLastResult = options.resume?.prevResult;
  const t0 = performance.now();
  const session = options.session ?? createSession();
  // The compiler instance is reused across chunks because creating one costs
  // more than a chunk does - but it does not stay fresh forever. After a few
  // thousand chunks it starts handing back `never` for work it did correctly
  // earlier: the same chunk, re-evaluated in a new instance, comes out right.
  // So a failure that survives all the way down to the minimum fuel is treated
  // as the instance being worn out rather than the work being too big.
  let { env, path } = session;
  // Sound off: with snd_SfxVolume and snd_MusicVolume at 0,
  // S_StartSoundAtVolume returns before touching channels
  // (`if (volume < 1) return`). The view is 10: full width with the status
  // bar, the largest that still shows ammo and health. 11 drops the status bar
  // and stretches the 3D view over its rows, which reads as zoomed in. Doom's
  // own default, 9, leaves a border. setblocks drives the renderer, screenblocks is the Options menu's
  // copy, and setsizeneeded makes the next D_Display apply it. Written only
  // when the words differ, so a resume does not redo the resize.
  //
  // A key script also sets `singletics` (4401632, what `-timedemo` sets), so
  // `D_OneFrame` runs exactly one tic per `entry`. Without it TryRunTics
  // catches up to the host clock, and a type-level frame takes minutes of
  // wall time, so every frame runs the most tics it may (5): the video shows
  // every 5th tic. With it the script has one entry per tic.
  /// Pokes land only between `entry` calls. A checkpoint from inside a frame
  /// already holds them, and writing them again would rewind what the frame
  /// has done since: a demo pointer reset after the tic read its command.
  const applyPokes = () => {
    const entry = keyScript?.[scriptFrame];
    if (!inputSlot || Array.isArray(entry) || !entry?.poke?.length) return;
    const levels = inputSlot.levels / Math.log2(fanout);
    for (const [addr, value] of entry.poke)
      memoryTrie = setWord(memoryTrie, addr / 4, (value >>> 0).toString(2).padStart(32, "0"), fanout, levels);
    memoryTrie = prune(memoryTrie, base, fanout);
    memory = printTrie(memoryTrie);
  };
  if (inputSlot) {
    const levels = inputSlot.levels / Math.log2(fanout);
    const bits = (n: number) => n.toString(2).padStart(32, "0");
    const want: (readonly [number, number])[] = [
      [132960 / 4, 0],
      [132964 / 4, 0],
      [4463604 / 4, 10],
      [4410852 / 4, 10],
      ...(keyScript ? [[4401632 / 4, 1] as const] : []),
    ];
    if (want.some(([word, value]) => getWord(memoryTrie, base, word, fanout, levels) !== bits(value))) {
      for (const [word, value] of [...want, [4463600 / 4, 1] as const]) {
        memoryTrie = setWord(memoryTrie, word, bits(value), fanout, levels);
      }
      memoryTrie = prune(memoryTrie, base, fanout);
      memory = printTrie(memoryTrie);
    }
    if (options.resume?.done) applyPokes();
    if (process.env.VIEW_PROBE)
      for (const w of [4463600 / 4, 4463604 / 4, 4463608 / 4])
        process.stderr.write(`VIEW word=${w} val=${getWord(memoryTrie, base, w, fanout, levels)}\n`);
  }
  if (inputSlot && process.env.ACK_ZERO) {
    const levels = inputSlot.levels / Math.log2(fanout);
    memoryTrie = prune(
      setWord(memoryTrie, ACK_WORD, "0".repeat(32), fanout, levels),
      base,
      fanout,
    );
    memory = printTrie(memoryTrie);
    process.stderr.write(`ACKZERO ${getWord(memoryTrie, base, ACK_WORD, fanout, levels)}\n`);
  }
  const modulePathDts = join(__dirname, `module-${process.pid}.d.ts`);
  const statePathDts = join(__dirname, `state-${process.pid}.d.ts`);
  // The module text never changes, so it is written once per compiler instance.
  env.createFile(modulePathDts, globalModuleText);
  const recycle = (reason: string) => {
    const c0 = performance.now();
    env.close();
    const fresh = createSession();
    session.env = fresh.env;
    session.path = fresh.path;
    env = fresh.env;
    path = fresh.path;
    env.createFile(modulePathDts, globalModuleText);
    recycles++;
    why[reason] = (why[reason] ?? 0) + 1;
    recycleMs += performance.now() - c0;
  };
  let recycled = 0;
  // Chunks the current compiler has done, and how many the last one managed
  // before it went bad. Wear tracks work, not chunks: in doom's renderer nine
  // chunks is enough, while the memset at the start goes thousands. Waiting to
  // be told costs a wasted evaluation and a run of halvings first, so once one
  // instance has worn out we replace the next one just before the same point.
  let since = 0;
  let lifetime = Infinity;
  // Counted separately from `since`, which any replacement resets: the interval
  // to learn is how long an instance lasts under this phase's work, and a
  // replacement made early on purpose says nothing about that.
  let worked = 0;

  while (chunks < max) {
    mark("tail");
    // Keys, if the browser sent any since the last chunk. Writing the word
    // every chunk (rather than once a frame) is what makes a tap land: a press
    // and its release can both arrive inside one frame's worth of chunks.
    if (inputSlot && inputPath) {
      try {
        const sent = JSON.parse(readFileSync(inputPath, "utf8")) as {
          rev: number;
          keys: string[];
          presses?: Record<string, number>;
          queue?: string[];
        };
        if (sent.rev !== inputRev) {
          inputRev = sent.rev;
          heldKeys = sent.keys ?? [];
          pressCounts = sent.presses ?? {};
          // the presses still owed, oldest first: two different keys land in
          // the order they were pressed, not the order they were first ever
          // pressed. An older server writes no queue; then per-key order.
          pressOrder = sent.queue ?? Object.keys(pressCounts);
          reseatSeen(pressCounts);
        }
        if (keyScript) heldKeys = scriptKeys(scriptFrame);
        // What the game says it last took, read out of the state the same way
        // the module would read it.
        const ack = parseInt(
          getWord(memoryTrie, base, ACK_WORD, fanout, inputSlot.levels / Math.log2(fanout)),
          2,
        );
        const bitOf = (code: string) => 1 << INPUT_BITS.indexOf(code);
        if (process.env.TRACE_LATCH)
          process.stderr.write(
            `\nACK chunk=${chunks} ack=${ack.toString(2)} word=${getWord(memoryTrie, base, inputSlot.word, fanout, inputSlot.levels / Math.log2(fanout))} phase=${phase} code=${sending} counts=${JSON.stringify(pressCounts)} seen=${JSON.stringify(pressesSeen)}\n`,
          );
        /// A key whose ack bit is still high is one the game has posted a
        /// keydown for and not yet a keyup. Writing that bit again is not an
        /// edge, so the press would vanish; and a bit left high from before
        /// this run - the stale live state carried `Enter` high - would read
        /// as an instant landing for a press the game never saw. Both cases
        /// are the same rule: only send a key whose ack bit is low.
        const owedFor = (code: string) => (pressCounts[code] ?? 0) - (pressesSeen[code] ?? 0);
        const nextPress = () =>
          [...pressOrder, ...Object.keys(pressCounts)].find(
            (code) => INPUT_BITS.includes(code) && owedFor(code) > 0 && (ack & bitOf(code)) === 0,
          );
        // the queue was cleared under a press the game has not taken yet:
        // nothing owes it any more, so stop holding it
        if (phase === "sent" && sending && owedFor(sending) <= 0 && (ack & bitOf(sending)) === 0) {
          phase = "idle";
          sending = undefined;
          saveLatch();
        }
        // The server keeps only the newest intent. If another key arrives
        // before the game acknowledges this keydown, replace it now instead
        // of making the player wait a whole frame for an obsolete press. Once
        // ack is high the keydown landed and its release must still complete.
        const replacement = nextPress();
        if (
          phase === "sent" &&
          sending &&
          replacement &&
          replacement !== sending &&
          (ack & bitOf(sending)) === 0
        ) {
          phase = "idle";
          sending = undefined;
          saveLatch();
        }
        if (phase === "idle") {
          sending = nextPress();
          if (sending) {
            phase = "sent";
            saveLatch();
          }
        } else if (phase === "sent" && sending && (ack & bitOf(sending)) !== 0) {
          // keydown landed: the press is spent. Clearing the bit here is the
          // keyup; the game posts it next frame with no further help.
          pressesSeen[sending] = (pressesSeen[sending] ?? 0) + 1;
          phase = "idle";
          sending = undefined;
          saveLatch();
        } else if (phase === "release" && sending) {
          // a latch written by the older two-ack machine
          pressesSeen[sending] = (pressesSeen[sending] ?? 0) + 1;
          phase = "idle";
          sending = undefined;
          saveLatch();
        }
        const latched = phase === "sent" && sending ? [sending] : [];
        const mask = inputMaskWord([...heldKeys, ...latched]);
        if (mask !== inputMask) {
          inputMask = mask;
          memoryTrie = prune(
            setWord(memoryTrie, inputSlot.word, mask, fanout, inputSlot.levels / Math.log2(fanout)),
            base,
            fanout,
          );
          memory = printTrie(memoryTrie);
        }
      } catch {
        // no input file yet, or a half-written one: the game just sees no keys
      }
    }
    // The state is printed as its own top-level type, never nested inside the
    // result tuple. Measured reason: the printer elides deeply nested parts as
    // `any` once they sit a couple of levels down inside a bigger type, and
    // that `any` pasted back into the next chunk corrupts memory silently. The
    // *type* is correct either way - only the printout was lossy.
    const f0 = performance.now();
    const aliasWords = aliasWordsOf(memoryTrie);
    const aliasNames = new Map(aliasWords.map((word, index) => [word, `$A${index}`]));
    aliasBack = new Map(aliasWords.map((word, index) => [`$A${index}`, word]));
    mark("alias");
    const stateText = `${aliasWords
      .map((word, index) => `type $A${index} = ['${word}']`)
      .join("\n")}\ntype $IN = ${printAliased(memoryTrie, aliasNames)}\n`;
    mark("print");
    // Encode words to byte-tuples only in what the module actually sees; the
    // internal `call`/`stateText` stay 32-char strings so checkpoints and frame
    // parsing are unchanged, and fuel (a bare run of 1s/0s) is never touched.
    const emittedState = options.word4 ? w4Encode(stateText) : stateText;
    const emittedCall = options.word4 ? w4Encode(call) : call;
    env.createFile(statePathDts, emittedState);
    if (fanout > 0 && memory.length > 800000 && Array.isArray(memoryTrie)) {
      split.add("$Out_Mem");
      for (let i = 0; i < fanout; i++) {
        const child = memoryTrie[i];
        if (Array.isArray(child) && !split.has(`$Out_Mem_${i}`) && printTrie(child).length > 800000) {
          split.add(`$Out_Mem_${i}`);
        }
      }
    }
    // The slow guard below can lower `fuel` after this chunk ran; count and
    // report what it actually ran with.
    const ranFuel = fuel;
    const file = `type $FUEL = ${fuelType(fuel)}
type $Result = ${emittedCall}
export type $Out_Tag = $Tag<$Result>
export type $Out_Frames = $Frames<$Result>
export type $Out_Globals = $GlobalsOf<$Result>
export type $Out_Value = $ValueOf<$Result>
${MERGE_TYPE}
${split.has("$Out_Mem") ? "" : "export "}type $Out_Mem = $Merge<$IN, $MemOf<$Result>>
${splitReaders(split)}
`;
    env.createFile(path, file);
    fileMs += performance.now() - f0;
    mark("file");
    // A chunk dumped to disk can be re-checked by tsc standalone, which reports
    // Instantiations - a deterministic cost number, unlike wall time.
    if (process.env.DUMP_CHUNKS) {
      const stem = `${process.env.DUMP_CHUNKS}/chunk-${String(chunks).padStart(4, "0")}`;
      // the module and state live in sibling declaration files now, so a dump
      // is only re-checkable standalone if all three land next to each other
      writeFileSync(`${stem}.ts`, file);
      writeFileSync(`${stem}.state.d.ts`, emittedState);
      writeFileSync(`${process.env.DUMP_CHUNKS}/module.d.ts`, globalModuleText);
    }
    const e0 = performance.now();
    // One program per chunk, not one per read. `getProgram()` re-synchronises
    // the language service against the file system, and this chunk asks for 77
    // types: the state file gets re-parsed and re-bound 76 times for nothing.
    const p0 = performance.now();
    const chunkProgram = env.languageService.getProgram()!;
    const syncMs = performance.now() - p0;
    if (process.env.TIME_READS) process.stderr.write(`    getProgram: ${syncMs.toFixed(0)}ms\n`);
    // Where the forcing read actually goes: resolving the type, or printing it.
    if (process.env.TIME_SPLIT) {
      const sf = chunkProgram.getSourceFile(path)!;
      const alias = [...sf.statements].find(
        (n) => (n as { name?: { text?: string } }).name?.text === "$Out_Tag",
      ) as unknown as { type: Parameters<ReturnType<typeof chunkProgram.getTypeChecker>["getTypeFromTypeNode"]>[0] };
      const checker = chunkProgram.getTypeChecker();
      const a0 = performance.now();
      const resolved = checker.getTypeFromTypeNode(alias.type);
      const a1 = performance.now();
      checker.typeToString(resolved, undefined, 1 << 0);
      const a2 = performance.now();
      process.stderr.write(`    $Out_Tag resolve ${(a1 - a0).toFixed(0)}ms print ${(a2 - a1).toFixed(0)}ms\n`);
    }
    const read = async (name: string) => {
      const t = performance.now();
      const raw = (
        await evaluateType(env, path, chunkProgram, undefined, name, true)
      ).typeString.trim();
      const out = options.word4 ? w4Decode(raw) : raw;
      if (process.env.TIME_READS) process.stderr.write(`    read ${name}: ${(performance.now() - t).toFixed(0)}ms\n`);
      return out;
    };
    let tag: string;
    let state: string;
    let live: string;
    let value: string;
    let globals: string;
    try {
      tag = await read("$Out_Tag");
      state = await readState(read, fanout, split);
      // A chunk that stored nothing hands the memory straight back, and the
      // printer prints it as the alias it came in as rather than expanding it.
      if (state.trim() === "$IN") state = memory;
      // the frames double as the live-value list for the checks below: every
      // value inside them has to be a word, whichever frame it belongs to
      live = tag === '"s"' ? await read("$Out_Frames") : "[]";
      globals = await read("$Out_Globals");
      value = tag === '"r"' ? await read("$Out_Value") : '"void"';
    } catch (error) {
      const message = (error as Error).message.split("\n")[0];
      // TS2589 is the checker refusing outright, rather than quietly handing
      // back an approximation: same remedy, less fuel.
      if (/excessively deep/.test(message) && fuel > minFuel) {
        backoffs++;
        settled = 0;
        capFail = Math.min(capFail, fuel);
        // Strictly below the fuel that just failed, or the run livelocks: a
        // chunk that lands at 1280 sets lastGood there, and a later chunk that
        // fails at 1280 asks for 1280 again forever (seen at chunk 186).
        // A fuel that landed before and fails now hit the checker's depth
        // limit where this chunk's calls nest deepest, not a cost edge: step
        // down a quarter, not half. Measured on an E1M1 frame: 21504 landed
        // twice, failed once, and the halving to 10752 for the rest of the
        // frame cost 142s against 98s at a steady 10752 and 80s at 31360.
        fuel = lastGood > 0 && lastGood < fuel
          ? lastGood
          : Math.max(minFuel, Math.floor((fuel * 3) / 4));
        if (lastGood >= fuel) lastGood = 0;
        if (!options.quiet) process.stdout.write(`\r  chunk ${chunks}: too deep; fuel -> ${fuel}    \n`);
        mark("retry");
        continue;
      }
      if (recycled !== chunks) {
        recycled = chunks;
        // Keep the fuel that was landing: resetting to the ceiling here paid
        // the whole run of halvings again on every replacement.
        fuel = lastGood > 0 ? lastGood : options.fuel ?? DEFAULT_FUEL;
        lifetime = Math.max(1, worked - 1);
        since = 0;
        worked = 0;
        recycle("worn");
        if (!options.quiet) process.stdout.write(`\r  chunk ${chunks}: worn out; new compiler every ${lifetime}    \n`);
        mark("retry");
        continue;
      }
      // A fresh compiler failing too means the chunk is too big for this
      // checker, not that the instance wore out: TS6 hands back `any` at a
      // fuel TS7 lands (chunk 109 of the scripted kill run, fuel 12288).
      if (fuel > minFuel) {
        backoffs++;
        settled = 0;
        capFail = Math.min(capFail, fuel);
        fuel = Math.max(minFuel, Math.floor((fuel * 3) / 4));
        if (lastGood >= fuel) lastGood = 0;
        if (!options.quiet) process.stdout.write(`\r  chunk ${chunks}: fails on a fresh compiler; fuel -> ${fuel}    \n`);
        mark("retry");
        continue;
      }
      failed = `chunk ${chunks}: ${message}`;
      break;
    }
    const chunkMs = performance.now() - e0;
    evalMs += chunkMs;
    mark("eval");

    // The ladder below climbs on success and only backs off when a chunk
    // *fails*. A chunk that merely takes forever never fails, so the climb can
    // walk into a fuel where one evaluation runs for an hour: measured live,
    // the checkpoint at 18:34 carried fuel 640, the ladder doubled from there,
    // and the compiler then sat on one chunk for 56 minutes at 99% CPU. Keys
    // are only posted between chunks, so the game stops answering the keyboard.
    // The same state runs 2.5s/chunk at fuel 640.
    //
    // Time is the thing that matters here, so bound it: a chunk slower than
    // this marks its fuel as over the edge, the same as a failure would.
    //
    // Only fuel that has not landed yet can be blamed for the time. Most of a
    // chunk is not the fuel: at fuel 157-315 the same state still costs
    // 4.3-4.5s a chunk, while at 960 it costs 1.9-2.9s. Charging that floor to
    // the fuel makes the guard cut a fuel that was never the cost, and each cut
    // buys fewer instructions for the same 4.4s - the live session walked
    // itself down to 157 and 49 units/s that way. `lastGood` is the last fuel
    // that produced an accepted chunk, so `fuel > lastGood` is true only on the
    // first chunk after a climb - the one that can actually run for an hour.
    if (chunkMs > SLOW_CHUNK_MS && fuel > minFuel && fuel > lastGood) {
      capFail = Math.min(capFail, fuel);
      fuel = Math.max(minFuel, Math.floor(fuel / 2));
      settled = 0;
      if (!options.quiet) {
        process.stdout.write(
          `\r  chunk ${chunks}: slow (${(chunkMs / 1000).toFixed(1)}s); fuel -> ${fuel}    \n`,
        );
      }
    }

    // The chunk counter only advances on a chunk that was accepted. Counting a
    // retry as a chunk moves `chunks` out from under the `recycled !== chunks`
    // guard below, so every retry looks like the first failure of a new chunk:
    // the driver replaces the compiler forever and never reaches the fuel
    // halving. That reads as progress in the log - the chunk numbers climb -
    // while the state stays byte for byte identical.
    const d0 = performance.now();
    const bad = degraded(tag, state, live, value, globals);
    if (process.env.DUMP_BAD && bad) {
      process.stderr.write(`\n[DUMP_BAD] ${bad}\n  tag=${tag}\n  live=${live.slice(0, 4000)}\n  state=${state.slice(0, 400)}\n`);
    }
    degMs += performance.now() - d0;
    mark("degraded");
    if (bad) {
      // An approximation handed back quietly - `any` or `never` - is not a fuel
      // problem: the same chunk that came back never at fuel 1024 still came
      // back never at fuel 4, then evaluated correctly in a new compiler. So
      // replace the compiler first and only decide what it is once a fresh one
      // has had its say. This is doubly true for the Word4 module, whose ~3x
      // heavier per-op instantiation wears a reused session fast: a value that
      // prints as `any` on the worn session is a clean word on a fresh one.
      if (recycled !== chunks) {
        recycled = chunks;
        lifetime = Math.max(1, worked - 1);
        since = 0;
        worked = 0;
        recycle("bad");
        if (!options.quiet) process.stdout.write(`\r  chunk ${chunks}: ${bad}; new compiler every ${lifetime}    \n`);
        mark("retry");
        continue;
      }
      // A *fresh* compiler still hands back `any`: now it is the checker hitting
      // its own instantiation budget on a block too big to resolve at all - the
      // compile-time caps, not this run. It is deterministic at every fuel, so
      // the fuel ladder would only turn one wrong answer into a long one (arith120
      // at PIPELINE_CAP=64 walked fuel 20000 -> 4 reporting a fuel problem the
      // whole way). But a deep-per-op module (Word4) overruns the checker's
      // budget at high fuel and re-wears the session doing it, so `any` here can
      // still be a fuel-too-high that a lower fuel on its own fresh compiler
      // clears. Only give up once the smallest fuel, freshly compiled, still
      // says `any`.
      if (fuel > minFuel) {
        backoffs++;
        settled = 0;
        capFail = Math.min(capFail, fuel);
        // Strictly below the fuel that just failed, or the run livelocks: a
        // chunk that lands at 1280 sets lastGood there, and a later chunk that
        // fails at 1280 asks for 1280 again forever (seen at chunk 186).
        // A fuel that landed before and fails now hit the checker's depth
        // limit where this chunk's calls nest deepest, not a cost edge: step
        // down a quarter, not half. Measured on an E1M1 frame: 21504 landed
        // twice, failed once, and the halving to 10752 for the rest of the
        // frame cost 142s against 98s at a steady 10752 and 80s at 31360.
        fuel = lastGood > 0 && lastGood < fuel
          ? lastGood
          : Math.max(minFuel, Math.floor((fuel * 3) / 4));
        if (lastGood >= fuel) lastGood = 0;
        // Force a fresh compiler at the new fuel: the failed higher-fuel try
        // just wore this one, and the lower fuel that fits needs a clean session
        // to show it (a worn one hands back the same `any` at every fuel).
        recycled = -1;
        if (!options.quiet) process.stdout.write(`\r  chunk ${chunks}: ${bad}; fuel -> ${fuel}    \n`);
        mark("retry");
        continue;
      }
      // Smallest fuel, freshly compiled, still degraded. A bare `any` now is the
      // checker's own instantiation budget on a block too big to resolve at all.
      if (/\bany\b/.test(bad)) {
        failed = `chunk ${chunks}: ${bad}
  the checker gave up on a block rather than running out of fuel - a block is
  too large to resolve, so lower DEPTH_CAP or PIPELINE_CAP and recompile.
  (a bare \`tsc\` on the generated module reports this as TS2589.)`;
      } else {
        failed = `chunk ${chunks} at fuel ${fuel}: ${bad}`;
      }
      writeFileSync(join(__dirname, "failing-chunk.ts"), file);
      writeFileSync(join(__dirname, "failing-output.txt"), `tag ${tag}\nvalue ${value}\nlive ${live}\nstate ${state}`);
      break;
    }
    chunks++;
    lastGood = fuel;
    units += ranFuel;
    // A fresh compiler does not make the work smaller, so the fuel that was
    // fitting before still fits. Raising it back to the ceiling here costs a
    // full run of halvings, once per replacement.
    worked++;
    if (++since >= lifetime) {
      lifetimes.push(lifetime);
      recycle("wear");
      since = 0;
      // A compiler that used up its whole allowance without ever handing back
      // an approximation says the allowance is too small, and nothing else
      // ever raises it: one bad chunk early in the run used to pin `lifetime`
      // at 2 for good, paying a 700ms replacement every second chunk. Climb
      // the same way the fuel does, and let the next bad chunk set it back.
      lifetime = lifetime * 2;
    }
    const ceiling = options.fuel ?? DEFAULT_FUEL;
    if (fuel < ceiling && ++settled >= 5) {
      settled = 0;
      // Doubling is only right while nothing has failed yet. Once a fuel is
      // known to be over the edge, the useful next try is between the two:
      // doubling from 640 asks for 1280, which fails and costs the chunk,
      // where the midpoint 960 lands and covers 1.5x the instructions for the
      // same 0.68s (1086 -> 1625 units/s over 25 chunks).
      const next = capFail === Infinity
        ? fuel * 2
        : Math.floor((fuel + Math.min(capFail, ceiling + 1)) / 2);
      // Stop once the edge is bracketed closely. Every probe that fails costs a
      // whole chunk, and re-probing 1120 then 1040 every five chunks cost more
      // than sitting at 960 won: 1154 units/s against 1625 pinned at 960.
      const converged = capFail !== Infinity && (capFail - fuel) / fuel < 0.15;
      if (next > fuel && next < capFail && !converged) {
        fuel = Math.min(ceiling, next);
        if (!options.quiet) process.stdout.write(`\r  chunk ${chunks}: settled; fuel -> ${fuel}    \n`);
      }
    }

    const r0 = performance.now();
    // A chunk that stored nothing merges to `$IN` itself, which prints as the
    // name; inside a branch the checker prints `$IN[K]` out as its contents.
    const parsedTrie = parseTrie(state, memoryTrie, aliasBack);
    const r1 = performance.now();
    const prunedTrie = prune(parsedTrie, base, fanout);
    const r2 = performance.now();
    memoryTrie = prunedTrie;
    memory = printTrie(prunedTrie);
    const r3 = performance.now();
    trieParseMs += r1 - r0;
    triePruneMs += r2 - r1;
    triePrintMs += r3 - r2;
    trieMs += r3 - r0;
    mark("trie");
    const g0 = performance.now();
    const globalValues = splitTop(globals.slice(1, globals.lastIndexOf("]")))
      .filter((v) => v.length > 0)
      .map(toSource);
    lastGlobals = globalValues;
    globMs += performance.now() - g0;
    mark("globals");

    // Chunk count is the only progress bar there is - at half a second a chunk
    // the frame is half an hour, and printing the chunk without the rate hides
    // that - but the frame's length is not a constant. This line used to divide
    // by 3224 and the frame it was describing ran past 3595 chunks without
    // returning, so the bar read `frame 821/3224, ETA 16m` while the real
    // remainder was unknown. The length comes from a frame that actually landed:
    // the stream writes one next to the checkpoint when `entry` returns.
    const framePath = options.save ? `${options.save}.frame` : "";
    let frameChunks = 0;
    try {
      frameChunks = JSON.parse(readFileSync(framePath, "utf8")).frameChunks ?? 0;
    } catch {
      // no frame has landed yet: report the rate and no total
    }
    const eta = () => {
      const spc = (performance.now() - t0) / 1000 / Math.max(chunks, 1);
      const left = frameChunks - chunks;
      if (!frameChunks) return `${spc.toFixed(2)}s/chunk, frame chunk ${chunks}, length unknown until it lands`;
      return (
        `${spc.toFixed(2)}s/chunk` +
        (left > 0 ? `, frame ${chunks}/${frameChunks}, ETA ${((left * spc) / 60).toFixed(0)}m` : `, frame past the last one's ${frameChunks}`)
      );
    };

    const checkpoint = (next: string, done = false) => {
      if (!options.save) return;
      // the last state of a frame is worth saving whatever the interval says
      if (!done && chunks % (options.every ?? 100) !== 0) return;
      const point: Checkpoint = {
        done,
        call: next,
        memory,
        frames,
        globals: globalValues,
        chunks: carried + chunks,
        scriptFrame: keyScript ? scriptFrame : undefined,
        entryChunks: chunks - entryStart,
        evalMs,
        split: [...split],
        fuel,
        capFail: capFail === Infinity ? undefined : capFail,
        // each `entry` call allocates its own screen and returns it, so a fixed
        // address reads the frame before this one
        result: done ? value_ : lastResult,
        prevResult: done ? lastResult : prevLastResult,
      };
      const s0 = performance.now();
      if (options.onCheckpoint) options.onCheckpoint(point, options.save);
      else saveCheckpoint(options.save, JSON.stringify(point));
      saveMs += performance.now() - s0;
    };

    if (tag === '"r"') {
      // `$Run` carries a return into every frame still pending inside the
      // chunk, so a return that reaches the host is the whole call coming
      // back (a suspension on the way out comes back as 's' with its frames).
      frames = [];
      value_ = value === '"void"' ? undefined : value.replace(/"/g, "");
      checkpoint(call, true);
      // Each `entry` call is one frame: it returns its screen and re-entry
      // animates. Exiting here made the sh loop cold-start node+tsx+tsgo for
      // every frame - measured 296s/frame where the chunks inside cost ~130s.
      // Re-enter in-process instead: the same fresh call the done-resume path
      // builds, on the same warmed compiler session.
      if (options.save && chunks < (options.max ?? Infinity)) {
        if (keyScript && ++scriptFrame >= keyScript.length) break;
        applyPokes();
        call = freshEntryCall(globalValues);
        prevLastResult = lastResult;
        lastResult = value_;
        value_ = undefined;
        entryStart = chunks;
        // The per-frame process restart this replaces was also an accidental
        // compiler refresh, and without one the reused session wears: measured
        // 5.2s/chunk on frame 1 climbing to 13.2s/chunk two frames later. A
        // recycle costs seconds where the process cold start cost ~160s.
        recycle("frame");
        continue;
      }
      break;
    }

    // suspended: the innermost frame is where to pick up, the rest is the
    // stack it has to return through
    const parsed = parseFrames(live);
    if (parsed.length === 0) {
      failed = `chunk ${chunks}: suspended with no frame to resume`;
      break;
    }
    const [innermost, ...outer] = parsed;
    if (innermost.block.startsWith("trap_")) {
      failed = `chunk ${carried + chunks}: wasm unreachable trap at ${innermost.block.slice(5)} (${outer.map((f) => f.block).join(" <- ")})`;
      break;
    }
    // A back edge in the entry's own function is the start of the next frame:
    // record it while the locals are in hand, because once `entry` returns they
    // are gone and re-calling `entry` re-runs init (see backEdgeReentry).
    frames = outer;
    call = enter(innermost, outer, globalValues);
    checkpoint(call);
    mark("frames");
    if (!options.quiet) {
      process.stdout.write(
        `\r  chunk ${chunks}: suspended in ${innermost.block}, ${outer.length} frames, ` +
          `state ${memory.length} chars, fuel ${ranFuel}, ${eta()}   `,
      );
    }
  }
  // The `every` modulo means the last state a run reaches is usually not the
  // one on disk, and a return breaks out before the next multiple: re-entering
  // the entry point needs the memory as it stood *after* the call came back,
  // because a snapshot from the middle of one catches the heap mid-mutation and
  // a walk over a half-linked list follows a garbage pointer.
  if (options.save && value_ !== undefined) {
    const point: Checkpoint = {
      call: `$${entry}<$FUEL, $IN>`,
      memory,
      frames: [],
      // wasm globals persist across exported calls, but `$entry` bakes in their
      // module-initial values, so a second call silently rewinds them. Record
      // what they actually were at the return to make that visible.
      globals: [...lastGlobals],
      chunks: 0,
      entryChunks: 0,
      evalMs,
      split: [...split],
    };
    if (options.onCheckpoint) options.onCheckpoint(point, `${options.save}.final`);
    else saveCheckpoint(`${options.save}.final`, JSON.stringify(point));
  }
  if (!options.session) env.close();
  if (!options.quiet) process.stdout.write("\n");
  if (process.env.TIME_READS) {
    const totalMs = performance.now() - t0;
    process.stderr.write(
      `  split: ` +
        Object.entries(spans)
          .sort((a, b) => b[1] - a[1])
          .map(([name, ms]) => `${name} ${ms.toFixed(0)}ms`)
          .join(" ") +
        ` | trie parse ${trieParseMs.toFixed(0)}ms prune ${triePruneMs.toFixed(0)}ms print ${triePrintMs.toFixed(0)}ms` +
        ` | save ${saveMs.toFixed(0)}ms` +
        ` | recycle ${recycleMs.toFixed(0)}ms in ${recycles} ${JSON.stringify(why)}` +
        ` lifetimes ${JSON.stringify(lifetimes)} of ${totalMs.toFixed(0)}ms\n`,
    );
  }
  return { value: value_, memory, chunks: carried + chunks, backoffs, units, fuel, evalMs, totalMs: performance.now() - t0, failed };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const positional: string[] = [];
  const options: {
    fuel?: number;
    max?: number;
    save?: string;
    every?: number;
    quiet?: boolean;
    resume?: Checkpoint;
    word4?: boolean;
  } = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--fuel") options.fuel = Number(process.argv[++i]);
    else if (arg === "--max") options.max = Number(process.argv[++i]);
    else if (arg === "--save") options.save = process.argv[++i];
    else if (arg === "--every") options.every = Number(process.argv[++i]);
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--word4") options.word4 = true;
    else if (arg === "--resume") {
      const from = process.argv[++i];
      options.resume = JSON.parse(readFileSync(from, "utf8")) as Checkpoint;
    } else if (arg.startsWith("--")) {
      // An unknown flag used to fall through to `positional` and be spliced
      // into the generated type as an argument to `$entry`, so the failure
      // surfaced ~650KB into a generated file as
      //   chunk-5952.ts:655449: '>' expected
      // pointing at `$entry<$FUEL, $IN, --quiet>`. Name the flag instead.
      console.error(`unknown flag ${arg}`);
      process.exit(2);
    } else positional.push(arg);
  }
  const [modulePath, entry, ...rest] = positional;
  const args = rest.map((a) => (/^-?\d+$/.test(a) ? `'${bin(Number(a))}'` : a));
  const result = await run(modulePath, entry, args, options);
  // exit nonzero: a caller in a per-frame loop reads a zero exit as "that frame
  // is done, start the next one" and re-resumes the same wedged state forever.
  // Measured: the 2.3MB frame-3 state failed at chunk 0 and the play loop
  // reran it four times a minute until it was killed.
  if (result.failed) {
    console.log(`FAILED ${result.failed}`);
    process.exitCode = 1;
  }
  console.log(
    `${basename(modulePath)} ${entry}: ${result.chunks} chunks in ${(result.totalMs / 1000).toFixed(2)}s` +
      ` (${result.units} fuel units, ${(result.units / (result.totalMs / 1000)).toFixed(0)} units/s, fuel ${result.fuel})` +
      (result.value === undefined ? "" : ` -> ${result.value} (${parseInt(result.value, 2) | 0})`),
  );
}
