//! Word4 codegen: post-transform a generated CFG module from the 32-char-string
//! value representation to the byte-tuple `Word4 = [Byte,Byte,Byte,Byte]` one.
//! This is the recipe validated end-to-end on memory-offset (see
//! docs/word4-codegen-recipe.md). Gated by `--word4`.

use regex::Regex;

pub fn transform(src: &str) -> String {
    let mut s = src.to_string();

    // 1. import: alias WasmValue->Word4, Wasm->W4, bring in the Word4 helpers.
    s = s.replace(
        "import type { Wasm, WasmValue, Convert } from 'ts-type-math'",
        "import type { Convert } from 'ts-type-math'\n\
         import type { Word4, Word4 as WasmValue, W4 as Wasm, ToStr, FromStr, GetByte4, SetByte4, Off4, Zero4 } from 'ts-type-math/word4'",
    );

    // 2. every 32-char binary value literal -> Word4 tuple. Block markers/fuel
    //    strings are not 32 chars, so they are untouched.
    let lit = Regex::new(r"'([01]{32})'").unwrap();
    s = lit
        .replace_all(&s, |c: &regex::Captures| {
            let b = &c[1];
            format!("['{}', '{}', '{}', '{}']", &b[0..8], &b[8..16], &b[16..24], &b[24..32])
        })
        .into_owned();

    // 3. leaf word -> Word4
    let word = Regex::new(r"export type \$Word<T> = T extends \[infer W extends string\] \? W : \[[^\]]*\]").unwrap();
    s = word.replace(&s, "export type $$Word<T> = T extends [infer W] ? W : Zero4").into_owned();

    // 4. byte access + offset -> the validated Word4 primitives
    let getbyte = Regex::new(r"(?s)export type \$GetByte<[^=]*=.*?(\nexport type|\n///)").unwrap();
    s = getbyte.replace(&s, |c: &regex::Captures| format!("export type $GetByte<W, O extends string> = W extends Word4 ? GetByte4<W, O> : Zero4{}", &c[1])).into_owned();
    let setbyte = Regex::new(r"(?s)export type \$SetByte<[^=]*=.*?(\nexport type|\n///)").unwrap();
    s = setbyte.replace(&s, |c: &regex::Captures| format!("export type $SetByte<W, O extends string, V> = (W extends Word4 ? (V extends Word4 ? SetByte4<W, O, V> : Zero4) : Zero4){}", &c[1])).into_owned();
    let off = Regex::new(r"(?s)export type \$Off<A extends string>.*?(\nexport type|\n///)").unwrap();
    s = off.replace(&s, |c: &regex::Captures| format!("export type $Off<A> = A extends Word4 ? Off4<A> : never{}", &c[1])).into_owned();

    // 5. address helpers take Word4, ToStr internally
    s = s.replace("export type $Slice<A extends string> =", "export type $SliceS<A extends string> =");
    s = s.replace("export type $SliceWide<A extends string> =", "export type $SliceWideS<A extends string> =");
    s = s.replace("    ? B\n    : $SliceWide<A>", "    ? B\n    : $SliceWideS<A>");
    s.push_str("\nexport type $Slice<A> = A extends Word4 ? $SliceS<ToStr<A>> : $SliceS<A & string>\n");
    s = s.replace("export type $Split<A extends string> =", "export type $SplitS<A extends string> =");
    s = s.replace("export type $SplitWide<A extends string> =", "export type $SplitWideS<A extends string> =");
    s = s.replace("    : $SplitWide<A>", "    : $SplitWideS<A>");
    s.push_str("export type $Split<A> = A extends Word4 ? $SplitS<ToStr<A>> : $SplitS<A & string>\n");

    // 6. fetched word is Word4 | 'u' | 'x' — drop the string constraint
    s = s.replace("$Get<T, P> extends infer W extends string", "$Get<T, P> extends infer W");
    s = s.replace("$Get<T, B> extends infer W extends string", "$Get<T, B> extends infer W");

    // 7. aligned 32-bit check on the string form of the address
    s = s.replace(
        "export type $Load32<M extends $Node, A extends WasmValue> =\n  A extends `${string}00`",
        "export type $Load32<M extends $Node, A extends WasmValue> =\n  ToStr<A> extends `${string}00`",
    );
    s = s.replace(
        "export type $Store32<M extends $Node, A extends WasmValue, V extends WasmValue> =\n  A extends `${string}00`",
        "export type $Store32<M extends $Node, A extends WasmValue, V extends WasmValue> =\n  ToStr<A> extends `${string}00`",
    );

    // 8. $ToNumber via ToStr
    s = s.replace(
        "export type $ToNumber<V> = Convert.WasmValue.ToTSNumber<V & string, 'i32'>",
        "export type $ToNumber<V> = Convert.WasmValue.ToTSNumber<ToStr<V extends Word4 ? V : Zero4>, 'i32'>",
    );

    // 9. 64-bit helpers: stubbed (doom uses I64 rarely; port later)
    for name in ["$Hi32", "$Lo32", "$Load64", "$Store64"] {
        let re = Regex::new(&format!(r"(?s)export type {}<[^=]*=.*?(\nexport type|\n\{{fast|\z)", regex::escape(name))).unwrap();
        let nm = name.to_string();
        s = re.replace(&s, move |c: &regex::Captures| format!("export type {}<A = never, B = never, C = never> = never{}", nm, &c[1])).into_owned();
    }

    // 10. constrain the trampoline's return-value param to WasmValue
    let enterv = Regex::new(r"(export type \$Enter\w*<[^=]*extends WasmValue, \$V)>").unwrap();
    s = enterv.replace_all(&s, "$1 extends WasmValue = never>").into_owned();

    // synthetic value helpers: $Eq/$Ne/$Not1 bodies already emit Word4 tuples
    // (literals were converted), only their `extends string` param constraints
    // are wrong now that values are Word4.
    s = s.replace("export type $Eq<A extends string, B extends string>",
                  "export type $Eq<A extends WasmValue, B extends WasmValue>");
    s = s.replace("export type $Ne<A extends string, B extends string>",
                  "export type $Ne<A extends WasmValue, B extends WasmValue>");
    s = s.replace("export type $Not1<B extends string>",
                  "export type $Not1<B extends WasmValue>");

    // $LtSxxxx / $GtSxxxx etc: compare-with-constant helpers that string-match
    // the 32-char value. Wrap them to ToStr the Word4 argument (cheap concat);
    // their bodies already return Word4 tuples. Rename original to _NAME (string
    // body) and add a Word4 entry.
    let cmp = Regex::new(r"export type (\$(?:LtS|GtS|LtU|GtU|LeS|GeS|LeU|GeU|Eqz)[0-9A-Fa-f]*)<A extends string>").unwrap();
    let names: Vec<String> = cmp.captures_iter(&s).map(|c| c[1].to_string()).collect();
    for name in names {
        s = s.replace(&format!("export type {}<A extends string>", name),
                      &format!("export type _{}<A extends string>", &name[1..]));
        s.push_str(&format!("export type {}<A extends WasmValue> = _{}<ToStr<A>>
", name, &name[1..]));
    }

    // Const-arithmetic synthetic ops (pointer/counter inc-dec, shift-by-const,
    // clz/ctz, rotate, sign-extend, wrap): they string-match the 32-char value.
    // Wrap each to convert Word4->string (ToStr) in, string->Word4 (FromStr) out,
    // reusing the proven string body. Correct; the hot ones can be made native
    // W4 later. Match `export type $NAME<A extends string> =` for these names.
    let cop = Regex::new(r"export type (\$(?:Inc|Dec)(?:Top)?[0-9]*|\$Shl[0-9_]*|\$Shr[USs0-9]*|\$Clz|\$Ctz|\$Popcnt|\$Rotl|\$Rotr|\$Extend[0-9A-Za-z]*|\$Wrap[0-9A-Za-z]*|\$And[0-9A-Fa-f]+|\$Or[0-9A-Fa-f]+|\$Xor[0-9A-Fa-f]+|\$Hi[0-9]+|\$Lo[0-9]+|\$Tail[0-9]+|\$Zx[0-9]+)<A extends string>").unwrap();
    let cnames: Vec<String> = cop.captures_iter(&s).map(|c| c[1].to_string()).collect();
    for name in cnames {
        s = s.replace(&format!("export type {}<A extends string>", name),
                      &format!("export type _{}<A extends string>", &name[1..]));
        s.push_str(&format!("export type {}<A extends WasmValue> = FromStr<_{}<ToStr<A>>>
", name, &name[1..]));
    }

    s
}
