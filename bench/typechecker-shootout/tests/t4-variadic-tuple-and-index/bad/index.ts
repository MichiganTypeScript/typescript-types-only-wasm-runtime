// Block pipeline state threading + memory-trie indexed read.
type Step<S extends unknown[], V> = [...S, V];
type Trie = [[['w0','w1'],['w2','w3']],[['w4','w5'],['w6','w7']]];
declare const x: [Step<Step<['a'], 'b'>, 'c'>, Trie[1][0][1]];
const v: [['a','b','c'], 'w9'] = x;
