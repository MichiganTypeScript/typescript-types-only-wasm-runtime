// doom's emitted module relies on default type params ($Enter<.., $V = never>).
type D<A, B = ['d']> = [A, B];
declare const x: D<'a'>;
const v: ['a', ['d']] = x;
