type Count<F extends string, Acc extends unknown[]> =
  F extends `1${infer R}` ? Count<R, [...Acc, 1]> : Acc['length'];
type Trie = [[['w0','w1'],['w2','w3']],[['w4','w5'],['w6','w7']]];
type Resolved = [Count<'11111', []>, Trie[1][0][1], [...['a'], 'b']];
