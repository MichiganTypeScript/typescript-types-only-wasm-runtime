// Requirement 2: resolve a named type alias and return the RESOLVED type as text.
//
// This is how the driver gets results out of the type system: it never parses
// error messages, it asks the checker to print the type
// (packages/playground/evaluate/ts.ts -> getTypeFromTypeNode + typeToString
// with NodeBuilderFlags.NoTruncation). doom's memory comes back this way, ~4MB
// of it per chunk, so a truncating or diagnostics-only channel cannot be used.
//
// Usage: node print-type.mjs <file.ts> <AliasName>
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [file, alias] = process.argv.slice(2);
if (!file || !alias) { console.error('usage: node print-type.mjs <file.ts> <AliasName>'); process.exit(2); }
const ts = require('typescript-legacy'); // 5.6.3: the JS implementation
const program = ts.createProgram([file], { noEmit: true, strict: false });
const sf = program.getSourceFile(file);
const checker = program.getTypeChecker();
const decl = sf.statements.find(s => ts.isTypeAliasDeclaration(s) && s.name.text === alias);
if (!decl) { console.error(`no type alias ${alias} in ${file}`); process.exit(1); }
const type = checker.getTypeFromTypeNode(decl.type);
console.log(checker.typeToString(type, undefined,
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias));
