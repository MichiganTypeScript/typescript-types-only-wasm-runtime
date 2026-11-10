// Per-bit template-literal inference plus a keyed lookup table (the byte adder).
type Tbl = { '011': ['0','1']; '010': ['1','0'] };
type AddBit<A extends string, B extends string, C extends string> =
  `${A}${B}${C}` extends infer K extends keyof Tbl ? Tbl[K] : never;
declare const x: AddBit<'0','1','1'>;
const v: ['0', '1'] = x;
