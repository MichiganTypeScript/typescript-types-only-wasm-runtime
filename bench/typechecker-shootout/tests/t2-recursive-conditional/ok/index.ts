// The fuel loop: tail-recursive conditional with a tuple accumulator.
type Count<F extends string, Acc extends unknown[]> =
  F extends `1${infer R}` ? Count<R, [...Acc, 1]> : Acc['length'];
declare const x: Count<'111', []>;
const v: 3 = x;
