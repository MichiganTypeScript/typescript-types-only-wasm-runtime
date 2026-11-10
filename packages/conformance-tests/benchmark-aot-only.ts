/**
 * AOT-only benchmark
 */
import type { entry } from './from-wat/loop.aot'

type R1 = entry<[2]>   // 16
type R2 = entry<[3]>   // 24
type R3 = entry<[5]>   // 40

export type Results = [R1, R2, R3]
