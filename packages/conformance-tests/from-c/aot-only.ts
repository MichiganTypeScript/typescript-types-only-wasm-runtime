import type { entry } from './c-add.aot';

type R1 = entry<[5, 3]>;
type R2 = entry<[100, 200]>;

export type Results = [R1, R2];
