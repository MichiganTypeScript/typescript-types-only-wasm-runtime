// How many stores can one evaluation really do, and does the state survive?
//
// Two things are measured separately, because they fail separately:
//   * semantics: read every written byte back at type level and print one short
//     string, which the printer cannot elide
//   * printing: print the state itself, which is what the host has to paste
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createSession } from "./drive";
import { evaluateType } from "../evaluate/ts";
const here = dirname(fileURLToPath(import.meta.url));
const bin = (n: number) => (n >>> 0).toString(2).padStart(32, "0");
const moduleText = readFileSync(join(here, "store64.cfg.ts"), "utf8").replace(/^export type/gm, "type");
const { env, path } = createSession();

for (const stores of [32, 64, 128, 256, 384, 512, 768, 960]) {
  const fuel = stores * 2 + 4;
  const file = `${moduleText}
type $FUEL = '${"1".repeat(fuel)}'
type $Result = $run<$FUEL, $InitialMemory, '${bin(stores)}'>
type $Mem = $Result extends ['r', infer M, ...unknown[]] ? M : $Result extends ['s', unknown, infer M, ...unknown[]] ? M : never
// walk the written range and mark each byte: A if it holds 'A', . if it does not
type $Verify<M extends $Node, A extends number, N extends number, Acc extends string = ''> =
  A extends N ? Acc
  : $Verify<M, [...$Tuple<A>, unknown]['length'] & number, N,
      \`\${Acc}\${$Load8U<M, $FromNumber<A>> extends '${bin(65)}' ? 'A' : '.'}\`>
export type $Check = never
`;
  // simpler: generate the reads directly, no type-level counting
  const reads = Array.from({ length: stores }, (_, i) =>
    `$Load8U<$Mem, '${bin(200 + i)}'> extends '${bin(65)}' ? 'A' : '.'`).map((r) => `\${${r}}`).join("");
  const file2 = `${moduleText}
type $FUEL = '${"1".repeat(fuel)}'
type $Result = $run<$FUEL, $InitialMemory, '${bin(stores)}'>
export type $Mem = $Result extends ['r', infer M, ...unknown[]] ? M : $Result extends ['s', unknown, infer M, ...unknown[]] ? M : never
export type $Check = \`${reads}\`
export type $Tag = $Result extends [infer T, ...unknown[]] ? T : 'bad'
`;
  env.createFile(path, file2);
  const read = async (name: string) =>
    (await evaluateType(env, path, env.languageService.getProgram()!, undefined, name, true)).typeString.trim();
  const tag = await read("$Tag");
  const check = (await read("$Check")).replace(/"/g, "");
  const state = await read("$Mem");
  const written = (check.match(/A/g) ?? []).length;
  console.log(
    `${String(stores).padStart(3)} stores in one evaluation: tag ${tag.padEnd(5)} bytes correct ${String(written).padStart(3)}/${stores} ` +
      `| state print ${state.includes("any") ? "ELIDED" : "clean "} ${String(state.length).padStart(5)} chars`,
  );
  void file;
}
env.close();
