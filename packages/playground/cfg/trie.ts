// Decoding the state the type checker hands back.
//
// The memory trie prints as nested tuples of 32-character binary literals, with
// the `$Zero` alias standing in for any subtree nothing has written to. That is
// valid TypeScript, so the host can paste it straight back into the next chunk -
// and it is also easy to read here, which is how the bytes become pixels.
/// The trie prints as nested tuples: [word] is a leaf, an n-tuple is a branch,
/// and `$Zero` is a shared all-zero subtree. Walk it back into memory.
export const decodeTrie = (
  source: string,
  bits: number,
  digitBits = 3,
  /// the module's `$InitialMemory` literal. A compacted state keeps whole
  /// subtrees nothing wrote to as one `$InitialMemory` or `u` token, and a load
  /// reading one of those falls back to the initial data - so decoding one has
  /// to fall back the same way, or the data segments go missing from the dump.
  initial?: string,
): Map<number, number> => {
  if (source.trim() === "$InitialMemory") source = initial ?? "$Zero";
  if (source.trim() === "$Zero") return new Map();
  const initialWords =
    initial === undefined ? undefined : decodeTrie(initial, bits, digitBits);
  const fanout = 1 << digitBits;
  const levels = Math.ceil(bits / digitBits);
  const words = new Map<number, number>();
  let pos = 0;
  const skipSpace = () => {
    while (pos < source.length && /\s/.test(source[pos])) pos++;
  };
  const fill = (depth: number, path: number, word: number) => {
    if (word === 0) return;
    const span = fanout ** (levels - depth);
    const base = path * span;
    for (let i = 0; i < span; i++) words.set(base + i, word);
  };
  /// an unwritten subtree still reads as whatever the data segments put there
  const fallback = (depth: number, path: number) => {
    if (!initialWords) return;
    const span = fanout ** (levels - depth);
    const base = path * span;
    for (let i = 0; i < span; i++) {
      const word = initialWords.get(base + i);
      if (word) words.set(base + i, word);
    }
  };
  const walk = (depth: number, path: number) => {
    skipSpace();
    if (source[pos] === "$") {
      const rest = source.slice(pos);
      const end = /[^\w$]/.exec(rest)?.index ?? rest.length;
      const name = rest.slice(0, end);
      pos += end;
      if (name === "$Zero") return;
      if (name === "$Absent" || name === "$InitialMemory") return fallback(depth, path);
      throw new Error(`unexpected alias ${name} in the state`);
    }
    if (source[pos] !== "[") throw new Error(`bad trie at ${pos}: ${source.slice(pos, pos + 60)}`);
    pos++;
    skipSpace();
    if (source[pos] === "'" || source[pos] === '"') {
      const quote = source[pos];
      const end = source.indexOf(quote, pos + 1);
      const text = source.slice(pos + 1, end);
      if (text === "u") fallback(depth, path);
      else fill(depth, path, parseInt(text, 2) >>> 0);
      pos = end + 1;
      skipSpace();
      if (source[pos] === "]") pos++;
      return;
    }
    for (let child = 0; child < fanout; child++) {
      walk(depth + 1, path * fanout + child);
      skipSpace();
      if (source[pos] === ",") pos++;
      skipSpace();
      if (source[pos] === "]") break;
    }
    skipSpace();
    if (source[pos] === "]") pos++;
  };
  walk(0, 0);
  return words;
};

export const byteAt = (words: Map<number, number>, addr: number) => {
  const word = words.get(addr >>> 2) ?? 0;
  return (word >>> ((addr & 3) * 8)) & 0xff;
};

export const render = (
  words: Map<number, number>,
  base: number,
  width: number,
  height: number,
) => {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const byte = byteAt(words, base + y * width + x);
      row += byte === 0 ? " " : String.fromCharCode(byte);
    }
    rows.push(row);
  }
  return rows;
};

