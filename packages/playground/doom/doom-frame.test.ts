import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialMemoryLiteral, frameFrom, screenOf } from "./render-frame";

const __dirname = dirname(fileURLToPath(import.meta.url));

/// `first-frame.json.gz` is a real completed `entry` call - 4153 chunks of type
/// evaluation, `done: true` - checked in so that the frame it produced can be
/// compared without spending an hour recomputing it.
///
/// The tests this replaces asserted
///
///     const checkType: Result extends number ? true : false = true
///     expect(checkType).toBe(true)
///
/// which is a JS-side constant: `checkType` is assigned `true` in the source
/// and compared to `true` at runtime, so it passed whether or not the type
/// resolved, and would have passed against `never` or against no compiler at
/// all. One of them was named "AOT vs Interpreter" and never mentioned the
/// interpreter. There was no check on doom's output anywhere in the suite.
///
/// This decodes the memory the checker actually returned and looks at the
/// screen, which is the artifact that matters.
const oraclePath = join(__dirname, "first-frame.json.gz");
const modulePath = join(__dirname, "doom.cfg.ts");

/// The module is 117MB and gitignored, so it is not always on disk. Skip rather
/// than fail when it is missing - but never skip silently when it is present.
const haveModule = existsSync(modulePath);
const haveOracle = existsSync(oraclePath);

describe.skipIf(!haveModule || !haveOracle)("doom's first frame", () => {
  const checkpoint = JSON.parse(
    execFileSync("gzcat", [oraclePath], { maxBuffer: 1 << 30 }).toString("utf8"),
  );

  it("is a completed call, not a suspended one", () => {
    expect(checkpoint.done).toBe(true);
    expect(checkpoint.result).toMatch(/^[01]{32}$/);
  });

  it("decodes to the title screen doom drew", () => {
    const initial = initialMemoryLiteral(modulePath);
    const screen = screenOf(checkpoint);
    // the address `entry` returned, not a hardcoded one
    expect(screen).toBe(Number.parseInt(checkpoint.result, 2));

    const { rgb, painted } = frameFrom(checkpoint.memory, initial, screen);

    // 320x200, three bytes a pixel
    expect(rgb.length).toBe(320 * 200 * 3);

    // A blank or garbage decode is the failure this is here to catch: a wrong
    // palette address, a wrong screen address, or a trie that lost its writes
    // all show up as a screen that is mostly one colour. The measured frame
    // paints 60589 of 64000 pixels with a nonzero palette index.
    expect(painted).toBe(60589);

    // The exact image. If codegen, the trie, or the driver changes what doom
    // computes, this is what notices.
    expect(createHash("sha256").update(rgb).digest("hex").slice(0, 16)).toBe(
      "c075be54af2b2101",
    );
  });

  it("is not a uniform screen", () => {
    const initial = initialMemoryLiteral(modulePath);
    const { rgb } = frameFrom(checkpoint.memory, initial, screenOf(checkpoint));
    // count distinct colours: a real DOOM title screen has many, a decode that
    // fell through to zeroes has one
    const seen = new Set<number>();
    for (let i = 0; i < rgb.length; i += 3) seen.add((rgb[i]! << 16) | (rgb[i + 1]! << 8) | rgb[i + 2]!);
    expect(seen.size).toBeGreaterThan(50);
  });
});
