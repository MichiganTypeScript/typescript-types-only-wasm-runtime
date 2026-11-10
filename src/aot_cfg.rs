//! CFG AOT compiler - WASM to TypeScript types, as fuel-bounded basic blocks.
//!
//! Two measured facts drive this design:
//!
//! 1. Memory cannot be `S['memory'] & Record<Addr, V>`. Intersecting two
//!    different literals for one key gives `never`, so the second write to a
//!    word poisons it - and an `i32.store8` is a read-modify-write, so four
//!    byte stores into one word are enough. Memory here is a sparse binary trie
//!    keyed by the address bits: correct, ~2*depth per write, and it prints as
//!    a nested tuple of string literals that the host can paste straight back.
//!
//! 2. One type evaluation can only thread ~100 state transitions before
//!    TS2589. That is independent of the memory representation (intersections,
//!    Omit, mapped rewrites and tries all die between 96 and 240 stores), so a
//!    frame cannot be one evaluation. Every block therefore carries a fuel
//!    tuple; when it runs out the block returns a suspend tuple naming the
//!    block and its live values, and the host re-enters with fresh fuel.
//!
//! Control flow is real: each WASM label becomes a named type, `br`/`br_if`/
//! loop back-edges become tail calls to those types, and `if`/`else` join
//! through a shared continuation. Nothing is "skipped forward N ends".

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::rc::Rc;
use wasmparser::{BlockType, FuncType, Operator, Parser, Payload, ValType};

/// How many stores a chunk may perform before suspending. Measured ceiling is
/// ~100 state transitions per evaluation; 80 leaves headroom for the reads and
/// arithmetic that share the same depth budget.
pub const DEFAULT_FUEL: usize = 80;

/// Every computed value gets a name. Nesting arithmetic - `I32Add<I32Add<..>,..>`
/// inside `$Store8` inside `$Put` - stacks each operator's ~32 levels of bit
/// recursion into one instantiation chain, and ts-type-math raises TS2589 well
/// before a block finishes. Naming each result turns the block into a flat
/// sequence of conditionals, so depth stays proportional to one operator rather
/// than to the whole expression tree. Measured: this is the difference between
/// a corrupted `any` in the state and a clean frame.
const SSA: bool = true;

fn bits32(value: i32) -> String {
    format!("{:032b}", value as u32)
}

fn bits64(value: i64) -> String {
    format!("{:064b}", value as u64)
}

/// `${infer c0}${infer c1}...${infer c31}${infer Rest}` - each `infer` before a
/// following pattern takes exactly one character, so this splits a 64-bit value
/// into its two words without any arithmetic.
fn split64_pattern() -> (String, String) {
    let head: String = (0..32).map(|i| format!("${{infer H{i}}}")).collect();
    let joined: String = (0..32).map(|i| format!("${{H{i}}}")).collect();
    (head, joined)
}

fn zero() -> String {
    bits32(0)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum LabelKind {
    Block,
    Loop,
}

/// A per-iteration pointer step in a fusable copy loop: a constant, or a
/// local the loop never writes (loop-invariant by construction).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Stride {
    Const(i32),
    Local(u32),
}

/// A recognized byte/halfword copy loop: `while (c) { *d = *s; d += ds;
/// s += ss; c += ±1 }`, collapsed to one `$Blit8`/`$Blit16` application.
#[derive(Debug, Clone, Copy)]
struct Blit {
    d: u32,
    s: u32,
    c: u32,
    width: u8,
    ds: Stride,
    ss: Stride,
    /// count steps +1 from a negative start instead of -1 toward zero
    up: bool,
}

/// A recognized backward record scan (W_CheckNumForName's lump-directory
/// walk): `while (i) { if (m[b+i-20]==hi && m[b+i-16]==lo) break; i -= 20 }`,
/// collapsed to one `$Scan` application that leaves `i` at the match offset
/// (or 0 on miss) so the loop's own next iteration takes the real exit branch.
#[derive(Debug, Clone, Copy)]
struct Scan {
    /// the counter local, also the byte offset scanned downward
    i: u32,
    /// loop-invariant base pointer local
    base: u32,
    /// name halves compared against the two loaded words
    hi: u32,
    lo: u32,
}

/// One term of a fused texture index: `(local >> shift) & mask`, where mask
/// is a contiguous run of `width` bits starting at bit `lo`. Two terms with
/// disjoint bit ranges add without carries, so the index is a string splice.
#[derive(Debug, Clone, Copy, PartialEq)]
struct TexTerm {
    local: u32,
    shift: u32,
    lo: u32,
    width: u32,
    /// per-iteration step: a loop-invariant local, or a C global in memory
    step: TexStep,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum TexStep {
    Local(u32),
    Mem(u64),
}

/// A recognized texture-mapping loop (R_DrawColumn / R_DrawSpan):
/// `do { m8[d] = m8[m32[CM] + m8[m32[SRC] + idx(a, b)]]; d += kd; a += da;
/// b += db } while (++c)`, collapsed to one `$Tex` application. The
/// colormap and source pointers are C globals the loop reloads every pixel;
/// the fused loop reads them once, which is only equal if the pixel stores
/// never land on those globals (they are screen buffers, they do not).
#[derive(Debug, Clone, Copy)]
struct Tex {
    d: u32,
    kd: i32,
    c: u32,
    cm: u64,
    src: u64,
    a: TexTerm,
    b: Option<TexTerm>,
    /// the low-detail variants write each pixel twice
    pair: TexPair,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum TexPair {
    None,
    /// second store at D + k (R_DrawSpanLow: the next byte)
    Offset(i32),
    /// second store through another pointer local with its own stride
    /// (R_DrawColumnLow: the neighbouring column)
    Local(u32, i32),
}

/// Doom's FixedDiv2: a hand-written 32-step restoring division of
/// `(|a| << 16) / |b|` (the port has no i64), whose loop returns the signed
/// quotient from inside. Collapsed to one `$FDivQ` application plus the sign
/// select the loop's exit path computes.
#[derive(Debug, Clone, Copy)]
struct FDiv {
    /// the two operands the exit path xors for the sign
    x: u32,
    y: u32,
    /// remainder, dividend bit source, |divisor|, quotient
    rem: u32,
    lo: u32,
    b: u32,
    q: u32,
}

/// A recognized forward record search (R_FindPlane's visplane walk): records
/// of `stride` bytes from `p` up to `end`, three words compared per record.
#[derive(Debug, Clone, Copy)]
struct Find {
    p: u32,
    end: u32,
    a: u32,
    b: u32,
    c: u32,
    off_b: i32,
    off_c: i32,
    stride: i32,
}

/// A WASM label, compiled to a named type we can tail-call.
///
/// `br` and falling off the end are different edges: for a `block` both go to
/// the code after `end`, but for a `loop` a `br` goes back to the header while
/// falling off the end leaves the loop. Keeping both means loops terminate.
#[derive(Debug, Clone)]
struct Label {
    kind: LabelKind,
    /// block id a `br` to this label jumps to
    target: usize,
    /// block id reached by falling off this label's `end`
    exit: usize,
    /// values the `br` target takes off the top of the stack
    arity: usize,
    /// values the `end` continuation takes off the top of the stack
    exit_arity: usize,
    /// stack depth below the label's own operands
    stack_floor: usize,
}

/// A block waiting to be compiled: entry point plus the symbolic environment
/// its parameters describe.
#[derive(Debug, Clone)]
struct Pending {
    id: usize,
    pos: usize,
    labels: Vec<Label>,
    /// stack values at entry, as parameter names
    stack: Vec<String>,
}

#[derive(Debug, Clone)]
struct EmittedBlock {
    id: usize,
    /// parameter list after fuel + memory: globals, locals, then stack
    stack_arity: usize,
    body: String,
    /// fuel this block charges on entry: one hop plus its own stores
    cost: usize,
    /// locals read before being written here
    reads: BTreeSet<u32>,
    /// locals written here
    writes: BTreeSet<u32>,
    /// blocks this one can jump to
    successors: Vec<usize>,
    /// locals live on entry, filled in once the whole function is compiled
    live: BTreeSet<u32>,
    /// (name, constraint, expression) per instruction, in order
    bindings: Vec<(String, String, String)>,
    /// what the block does once its instructions have run
    terminator: String,
    /// incoming stack slots, as parameter names
    stack: Vec<String>,
    /// a binding destructures a pattern, so this block cannot be a pipeline
    has_pattern: bool,
}

pub struct CfgCompiler {
    /// override for the trie's address-bit count (testing)
    pub bits_override: Option<usize>,
    /// address bits consumed per trie level: 3 means an 8-way trie
    pub digit_bits: usize,
    func_types: Vec<FuncType>,
    func_type_indices: Vec<u32>,
    /// defined-function index -> name, from the custom name section. Only used
    /// to recognise the libc block moves (see `fused_call`).
    func_names: HashMap<usize, String>,
    /// (offset, bytes) of each active data segment
    data: Vec<(u32, Vec<u8>)>,
    globals: Vec<i64>,
    memory_pages: u64,
    /// How many pages the trie can actually address, which is a whole number of
    /// digits and so usually more than the module asked for.
    capacity_pages: u64,
    /// Index of the synthetic global holding the current page count.
    pages_global: usize,
    /// Declared maximum pages, when the module states one. A memory with a
    /// maximum can never exceed it, so that is a real compile-time bound even
    /// for an imported memory the host sizes.
    memory_max_pages: Option<u64>,
    /// Whether the memory is imported. An imported memory's declared size is a
    /// *minimum* the host must satisfy, not a limit - the host may hand over a
    /// larger one, and doom's runner does - so `memory_pages` cannot be used to
    /// refuse an access.
    memory_imported: bool,
    /// Whether any function contains `memory.grow`. When nothing grows, the
    /// in-bounds limit is fixed at compile time, so a literal address is
    /// checked by the compiler and costs nothing at type level.
    grows_memory: bool,
    /// export name -> function index (into defined functions)
    exports: Vec<(String, u32)>,
    num_imports: u32,
    /// address bits the trie covers
    trie_bits: usize,
    /// specialised helpers emitted on demand: shifts and masks by a constant
    /// are character surgery on the 32-character word, not bit recursion
    helpers: Rc<RefCell<BTreeMap<String, String>>>,
    /// table slot -> defined function index, from the element section
    table_funcs: BTreeMap<u32, u32>,
    /// signatures actually reached through call_indirect, so a dispatch type is
    /// emitted only for the ones the program uses
    indirect: Rc<RefCell<BTreeSet<u32>>>,
}

/// Rewrite the fuel variable in a block body, leaving names that merely start
/// with `$F` (like `$Flush`) alone.
fn rename_fuel(text: &str) -> String {
    let bytes: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '$' && i + 1 < bytes.len() && bytes[i + 1] == 'F' {
            let next = bytes.get(i + 2).copied();
            let continues = next.map(|c| c.is_alphanumeric() || c == '_').unwrap_or(false);
            if !continues {
                out.push_str("$F1");
                i += 2;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

impl CfgCompiler {
    pub fn new() -> Self {
        Self {
            bits_override: None,
            // Address bits per trie level; TRIE_DIGIT_BITS sweeps it. 6 is a
            // 64-way trie, four levels deep for doom's 24-bit space. Levels cost
            // more than fanout does: a store instantiates one node type per
            // level, and past a budget the checker stops instantiating and hands
            // back `any` for a leaf word, which fails the state at every fuel.
            // Measured on doom, from a cold start to `entry` returning:
            //   8-way,  6 levels,   16 pages: frame 1, then frame 2 has no heap
            //   8-way,  7 levels,  128 pages: `any` at chunk 2607
            //   16-way, 6 levels, 1024 pages: `any` at chunk 2363
            //   64-way, 4 levels, 1024 pages: frame 1 in 2861 chunks, frame 2 runs
            digit_bits: std::env::var("TRIE_DIGIT_BITS")
                .ok()
                .and_then(|value| value.parse().ok())
                .filter(|bits| (1..=6).contains(bits))
                .unwrap_or(6),
            func_types: Vec::new(),
            func_type_indices: Vec::new(),
            func_names: HashMap::new(),
            data: Vec::new(),
            globals: Vec::new(),
            memory_pages: 1,
            capacity_pages: 1,
            pages_global: 0,
            memory_max_pages: None,
            memory_imported: false,
            grows_memory: false,
            exports: Vec::new(),
            num_imports: 0,
            trie_bits: 14,
            helpers: Rc::new(RefCell::new(BTreeMap::new())),
            table_funcs: BTreeMap::new(),
            indirect: Rc::new(RefCell::new(BTreeSet::new())),
        }
    }

    pub fn compile(&mut self, bytes: &[u8]) -> Result<String, String> {
        let mut bodies = Vec::new();
        for payload in Parser::new(0).parse_all(bytes) {
            match payload.map_err(|e| e.to_string())? {
                Payload::CustomSection(reader) if reader.name() == "name" => {
                    let names = wasmparser::NameSectionReader::new(reader.data(), reader.data_offset());
                    for subsection in names {
                        if let Ok(wasmparser::Name::Function(map)) = subsection {
                            for naming in map {
                                let naming = naming.map_err(|e| e.to_string())?;
                                if naming.index as usize >= self.num_imports as usize {
                                    self.func_names.insert(
                                        naming.index as usize - self.num_imports as usize,
                                        naming.name.to_string(),
                                    );
                                }
                            }
                        }
                    }
                }
                Payload::TypeSection(reader) => {
                    for rec_group in reader {
                        let rec_group = rec_group.map_err(|e| e.to_string())?;
                        for sub_type in rec_group.into_types() {
                            if let wasmparser::CompositeType::Func(func_type) =
                                sub_type.composite_type
                            {
                                self.func_types.push(func_type);
                            }
                        }
                    }
                }
                Payload::ImportSection(reader) => {
                    for import in reader {
                        let import = import.map_err(|e| e.to_string())?;
                        match import.ty {
                            wasmparser::TypeRef::Func(_) => self.num_imports += 1,
                            wasmparser::TypeRef::Memory(memory) => {
                                self.memory_pages = memory.initial.max(1);
                                self.memory_max_pages = memory.maximum;
                                self.memory_imported = true;
                            }
                            _ => {}
                        }
                    }
                }
                Payload::MemorySection(reader) => {
                    for memory in reader {
                        let memory = memory.map_err(|e| e.to_string())?;
                        self.memory_pages = memory.initial.max(1);
                        self.memory_max_pages = memory.maximum;
                    }
                }
                Payload::FunctionSection(reader) => {
                    for type_index in reader {
                        self.func_type_indices.push(type_index.map_err(|e| e.to_string())?);
                    }
                }
                Payload::GlobalSection(reader) => {
                    for global in reader {
                        let global = global.map_err(|e| e.to_string())?;
                        let mut ops = global.init_expr.get_operators_reader();
                        let value = match ops.read().map_err(|e| e.to_string())? {
                            Operator::I32Const { value } => value as i64,
                            Operator::I64Const { value } => value,
                            _ => 0,
                        };
                        self.globals.push(value);
                    }
                }
                Payload::ExportSection(reader) => {
                    for export in reader {
                        let export = export.map_err(|e| e.to_string())?;
                        if export.kind == wasmparser::ExternalKind::Func {
                            self.exports.push((export.name.to_string(), export.index));
                        }
                    }
                }
                Payload::DataSection(reader) => {
                    for data in reader {
                        let data = data.map_err(|e| e.to_string())?;
                        if let wasmparser::DataKind::Active { offset_expr, .. } = data.kind {
                            let mut ops = offset_expr.get_operators_reader();
                            if let Ok(Operator::I32Const { value }) = ops.read() {
                                self.data.push((value as u32, data.data.to_vec()));
                            }
                        }
                    }
                }
                Payload::ElementSection(reader) => {
                    // Only active segments on table 0 initialise the table before
                    // the program runs; passive ones need table.init, which this
                    // compiler does not model.
                    for element in reader {
                        let element = element.map_err(|e| e.to_string())?;
                        let base = match element.kind {
                            wasmparser::ElementKind::Active { table_index, offset_expr } => {
                                if table_index.unwrap_or(0) != 0 {
                                    continue;
                                }
                                let mut base = 0u32;
                                for op in offset_expr.get_operators_reader() {
                                    if let Ok(Operator::I32Const { value }) = op {
                                        base = value as u32;
                                    }
                                }
                                base
                            }
                            _ => continue,
                        };
                        if let wasmparser::ElementItems::Functions(funcs) = element.items {
                            for (slot, func) in funcs.into_iter().enumerate() {
                                let func = func.map_err(|e| e.to_string())?;
                                self.table_funcs.insert(base + slot as u32, func);
                            }
                        }
                    }
                }
                Payload::CodeSectionEntry(body) => {
                    // One scan for `memory.grow`: it decides whether the bounds
                    // check below can be a compile-time comparison or has to
                    // read the page count at type level.
                    if let Ok(reader) = body.get_operators_reader() {
                        for op in reader {
                            match op {
                                Ok(wasmparser::Operator::MemoryGrow { .. }) => {
                                    self.grows_memory = true;
                                }
                                Err(_) => break,
                                _ => {}
                            }
                        }
                    }
                    bodies.push(body)
                }
                _ => {}
            }
        }

        // words of memory -> trie depth, so no two in-bounds addresses alias
        let words = (self.memory_pages * 65536 / 4).max(1);
        let needed = self
            .bits_override
            .unwrap_or_else(|| (64 - (words - 1).leading_zeros()).max(1) as usize);
        // round up so the address splits into whole digits
        let mut levels = (needed + self.digit_bits - 1) / self.digit_bits;
        // A trie sized to the declared pages leaves no room for `memory.grow`,
        // and doom's allocator does not treat a refused grow as fatal: Z_ZoneBase
        // returns 0, Z_Init stores that as mainzone, and Z_Malloc then walks a
        // block list rooted at null forever - chunks tick, no store lands, the
        // screen freezes. Measured: doom declares 11 pages and reaches 14 by the
        // end of frame 1, so an 18-bit trie (16 pages) renders frame 1 and wedges
        // on frame 2's Z_Init. 8MB of headroom costs 22% a chunk (600 chunks in
        // 113.77s against 93.39s) and is the difference between one frame and a
        // running game.
        if self.bits_override.is_none() {
            const HEADROOM_PAGES: u64 = 128;
            while ((1u64 << (levels * self.digit_bits)) * 4) / 65536 < HEADROOM_PAGES {
                levels += 1;
            }
        }
        self.trie_bits = levels * self.digit_bits;
        // rounding the address up to whole digits usually buys extra pages; a
        // grow can use them, and one past them has to fail rather than wrap
        self.capacity_pages = ((1u64 << self.trie_bits) * 4) / 65536;

        // The page count has to be part of the state, because `memory.grow`
        // reports the size *before* it grew and a caller works out where its new
        // region starts from that. Reporting the initial count every time hands
        // out the same region twice, which is a corrupted heap and, in doom's
        // allocator, a loop that never ends. It rides along as one more global,
        // so it is already threaded through blocks, frames and suspends.
        self.pages_global = self.globals.len();
        // `memory.size` answers this, and doom's allocator grows the heap from
        // wherever memory currently ends, so this number decides where the zone
        // lands. It has to be the declared minimum, because that is what doom
        // links against: natively, from a 6-page import, sbrk grows 6 -> 11 and
        // the zone lands at 459016, just past the screen at 393480.
        //
        // Reporting 256 instead put the zone 250 pages up, and the allocation
        // that Z_Init makes from it never came back:
        //
        //   at the first call to func 13   pages   M[174552] (mainzone)
        //   native                            11             459016
        //   256-page report                  256                  0
        //
        // Z_Malloc then walks a block list rooted at null, which is the 13_7
        // livelock: 172821 chunks, locals `0 1 -4 0 24` never moving. An earlier
        // note here claimed 6 pages traps in frame 2, measured before
        // `memory.grow` worked - grow now has 1024 pages of capacity to give.
        let host_pages = self.memory_pages.min(self.capacity_pages);
        self.globals.push(host_pages as i64);

        let mut out = String::new();
        out.push_str(&self.emit_prelude());
        out.push_str(&self.emit_initial_memory());
        // The one place a result leaves the type level. Both tags carry a raw
        // overlay so `$Resume` can re-enter with the base intact; the host reads
        // the memory as text and pastes it into the next chunk, so what leaves
        // through here has to be a flushed trie. `$Flush` of an already-plain
        // trie is the trie, so double-wrapping is a no-op.
        out.push_str(
            "\n/// what the host reads: the run carried through every bounce and\n\
             /// every return into a re-entered frame, then the memory flushed back\n\
             /// to a plain trie\n\
             export type $Exit<$R> = $Flushed<$Run<$R>>\n\
             export type $Flushed<$R> =\n  \
             $R extends ['r', infer $F1 extends string, infer $K1 extends unknown[], infer $M1, ...infer $Rest]\n    \
             ? ['r', $F1, $K1, $Flush<$M1>, ...$Rest]\n    \
             : $R extends ['s', infer $K1 extends unknown[], infer $M1, ...infer $Rest]\n    \
             ? ['s', $K1, $Flush<$M1>, ...$Rest]\n    \
             : $R\n",
        );
        out.push_str(&self.emit_host_accessors());

        // Every function is compiled the same way: its blocks charge fuel and
        // can suspend, and each carries `$K`, the frames of the calls it was
        // reached through. That is what lets a call suspend.
        //
        // The previous split - exports metered, callees inlined and run to
        // completion - could not survive a loop in a callee. An unmetered block
        // has no fuel, so a back edge is a type that refers to itself with
        // nothing to stop it, and the checker rejects it as possibly infinite
        // rather than running it. Real code puts loops in callees constantly
        // (doom has 74 in one function), so the call had to become suspendable.
        let mut reachable: Vec<usize> = Vec::new();
        let mut wanted: Vec<usize> = Vec::new();
        let mut called: Vec<usize> = Vec::new();
        for (_, export_index) in self.exports.clone() {
            if export_index < self.num_imports {
                continue;
            }
            wanted.push((export_index - self.num_imports) as usize);
        }
        while let Some(next) = wanted.pop() {
            if reachable.contains(&next) {
                continue;
            }
            reachable.push(next);
            let (_, body) = self.function(next, &bodies)?;
            for callee in self.callees(body)? {
                if !called.contains(&callee) {
                    called.push(callee);
                }
                if !reachable.contains(&callee) {
                    wanted.push(callee);
                }
            }
        }
        reachable.sort_unstable();

        // one set of blocks per function, whether it is an export, a callee or
        // both, so a function that is called and exported is not emitted twice
        let mut entries = Vec::new();
        for defined in reachable {
            let (func_type, body) = self.function(defined, &bodies)?;
            let (blocks, num_locals) = self.compile_function(defined, body, &func_type)?;
            for block in &blocks {
                out.push_str(&block.body);
                out.push('\n');
            }
            if called.contains(&defined) {
                out.push_str(&self.emit_call_entry(defined, &func_type, num_locals, &blocks));
            }
            for (name, export_index) in self.exports.clone() {
                if export_index >= self.num_imports
                    && (export_index - self.num_imports) as usize == defined
                {
                    entries.push(self.emit_entry(&name, defined, &func_type, num_locals, &blocks));
                }
            }
        }

        for entry in entries {
            out.push_str(&entry);
        }
        // one dispatch per signature actually reached through the table
        let indirect: Vec<u32> = self.indirect.borrow().iter().copied().collect();
        for type_index in indirect {
            out.push_str(&self.indirect_dispatch(type_index));
        }
        // whatever specialised shifts and masks the program turned out to need
        let helpers = self.helpers.borrow();
        if !helpers.is_empty() {
            out.push_str("\n// Specialised for the constants this module uses: a shift by a known\n");
            out.push_str("// amount is a character move, and a mask by a known constant is a\n");
            out.push_str("// character-by-character choice. Neither needs an adder.\n");
            for definition in helpers.values() {
                out.push_str(definition);
                out.push('\n');
            }
        }
        // A chunk cannot run more than ~1000 instructions no matter how much
        // fuel it is given: every instruction is one link in a chain of tail
        // instantiations, and the checker's tail-recursion elision gives up at
        // 1000 iterations. Measured on a doom chunk: 940 and 980 land, 1000,
        // 1020 and 1060 all report TS2589. That cap, not cost, is what bounds a
        // chunk - the marginal cost is 275 instantiations per instruction, so
        // the 5M instantiation budget would allow ~18,000 of them.
        //
        // The counter resets when the recursive call sits in an argument
        // position instead of a tail position, because the inner chain is
        // resolved to a value before the outer one continues. Measured on a
        // synthetic chain: flat dies at 5,000 steps, a nested one runs 20,000.
        // A wrapper alias is not enough - `type Y<T> = T` around the
        // continuation still hit TS2589 at every segment size, since the
        // wrapped call is still the tail of the same chain.
        //
        // So the inner chain has to end by itself and be re-entered from
        // outside, which is exactly the suspend the host already resumes. Doing
        // that in types is the same reconstruction `enter()` does in the
        // driver: the innermost frame names the block and carries its locals,
        // the frames below it become the new `$K`, and the memory and globals
        // come off the suspend record.
        let tramp = self.emit_trampoline(&out);
        out.push_str(&tramp);
        Ok(out)
    }

    /// `$Enter` re-enters a frame at type level - the same call `enter()`
    /// builds in the host - and `$Run` is the trampoline that keeps a chunk
    /// going across segment bounces and across returns into re-entered frames.
    ///
    /// The table is read back out of the emitted text rather than the block
    /// structs so that it cannot disagree with the signatures it has to call:
    /// each block's saved values are whatever its parameter list has after
    /// fuel, frames, memory and the globals. A frame tagged '1' is a call site
    /// waiting for a value: its last parameter is that value, so the frame
    /// holds one value fewer and `$V` fills the slot.
    ///
    /// Dispatch is a trie on the characters of the block name ('526_91'), one
    /// alias per node, so a re-entry walks at most a dozen arms per character.
    /// A flat chain is slow twice over: each arm is a tuple match, and every
    /// branch the checker takes re-resolves its type node by walking the
    /// syntax up to the enclosing statement (getConditionalFlowTypeOfType),
    /// which in a chain is as deep as the arm's position. The function-then-
    /// block chains this replaces had ~700 and up to ~420 arms. Measured
    /// (TS7.1, six E1M1 gameplay chunks back to back, with the other changes in
    /// this pass): 58.5s -> 47.7s, identical tags, frames, globals and memory.
    fn emit_trampoline(&self, module: &str) -> String {
        let globals = self.globals.len();
        let gparams: String = (0..globals).map(|i| format!(", $g{i} extends WasmValue")).collect();
        let gargs: String = (0..globals).map(|i| format!(", $g{i}")).collect();
        // block name -> arms
        let mut per_block: BTreeMap<String, String> = BTreeMap::new();
        let mut blocks = 0usize;
        for line in module.lines() {
            let Some(rest) = line.strip_prefix("export type $b") else {
                continue;
            };
            let Some(open) = rest.find('<') else { continue };
            let name = &rest[..open];
            if !name.contains('_') {
                continue;
            }
            let Some(params) = top_level_params(&rest[open + 1..]) else {
                continue;
            };
            if params < 3 + globals {
                continue;
            }
            let saved = params - 3 - globals;
            let arms = per_block.entry(name.to_string()).or_default();
            // a suspend or bounce frame: every value in place
            let pattern: String = (0..saved)
                .map(|i| format!(", infer $s{i} extends WasmValue"))
                .collect();
            let args: String = (0..saved).map(|i| format!(", $s{i}")).collect();
            arms.push_str(&format!(
                "  $T extends ['{name}', '0'{pattern}] ? $b{name}<$F, $K, $M{gargs}{args}> :\n"
            ));
            // a call frame: the value the call produced goes last
            if saved >= 1 {
                let pattern: String = (0..saved - 1)
                    .map(|i| format!(", infer $s{i} extends WasmValue"))
                    .collect();
                let args: String = (0..saved - 1).map(|i| format!(", $s{i}")).collect();
                arms.push_str(&format!(
                    "  $T extends ['{name}', '1'{pattern}] ? $b{name}<$F, $K, $M{gargs}{args}, $V> :\n"
                ));
            }
            blocks += 1;
        }
        if blocks == 0 {
            return String::new();
        }
        // Not one indented line in here. The driver turns this module into a
        // global script by rewriting `export type` at the start of a line, so an
        // indented `export` survives, makes the file a module, and hides every
        // block from the chunk that calls it - which reads as the chunk's result
        // tag coming back unresolved.
        let mut text = String::new();
        text.push_str(&format!(
            "\n/// Re-enter a frame at type level: {blocks} blocks, by function then by block.\n"
        ));
        let keys: Vec<&str> = per_block.keys().map(|k| k.as_str()).collect();
        let mut defs = Vec::new();
        enter_node("", &keys, &per_block, &gparams, &gargs, &mut defs);
        for def in defs.iter().rev() {
            text.push_str(def);
        }
        let ginfer: String = (0..globals)
            .map(|i| format!(", infer $g{i} extends WasmValue"))
            .collect();
        text.push_str("\n/// The trampoline: a bounce ('b') is re-entered with the fuel past the\n");
        text.push_str("/// segment mark; a return ('r') with frames still pending is a call\n");
        text.push_str("/// coming back to a frame the host or a bounce re-entered, so it goes\n");
        text.push_str("/// straight into that frame. Both from the top, so nothing nests: the\n");
        text.push_str("/// depth and the tail count start over every segment.\n");
        text.push_str("export type $Run<$R> =\n");
        text.push_str(&format!(
            "  $R extends ['b', infer $Fx extends string, [infer $T, ...infer $B extends unknown[]], infer $MM{ginfer}]\n  ? $Run<$Enter<$T, $Fx, $B, $MM{gargs}, never>>\n"
        ));
        text.push_str(&format!(
            "  : $R extends ['r', infer $F1 extends string, [infer $T, ...infer $B extends unknown[]], infer $MM{ginfer}, infer $V extends WasmValue]\n  ? $Run<$Enter<$T, $F1, $B, $MM{gargs}, $V>>\n"
        ));
        text.push_str("  : $R\n");
        text
    }

    /// `call_indirect` becomes a match on the table slot. The table is fixed at
    /// compile time, so the only reachable targets are the entries whose
    /// signature matches; anything else is a trap, which is `never`.
    fn indirect_dispatch(&self, type_index: u32) -> String {
        let Some(func_type) = self.func_types.get(type_index as usize) else {
            return String::new();
        };
        let num_params = func_type.params().len();

        let mut params = vec![
            "$C extends WasmValue".to_string(),
            "$F extends string".to_string(),
            "$K extends unknown[]".to_string(),
            "$M extends $Node".to_string(),
        ];
        for i in 0..self.globals.len() {
            params.push(format!("$g{i} extends WasmValue"));
        }
        for i in 0..num_params {
            params.push(format!("$p{i} extends WasmValue"));
        }

        let mut call_args = vec!["$F".to_string(), "$K".to_string(), "$M".to_string()];
        for i in 0..self.globals.len() {
            call_args.push(format!("$g{i}"));
        }
        for i in 0..num_params {
            call_args.push(format!("$p{i}"));
        }

        let mut body = String::new();
        let mut targets = 0;
        for (slot, func_index) in &self.table_funcs {
            // `func_type_indices` comes from the function section, which lists
            // defined functions only - imports are not in it. Indexing it with
            // the raw table entry picks the wrong function's signature.
            if *func_index < self.num_imports {
                continue;
            }
            let defined = func_index - self.num_imports;
            if self.func_type_indices.get(defined as usize) != Some(&type_index) {
                continue;
            }
            body.push_str(&format!(
                "  $C extends '{}' ? $call{defined}<{}> :\n",
                bits32(*slot as i32),
                call_args.join(", ")
            ));
            targets += 1;
        }
        body.push_str("  never");

        format!(
            "\n// call_indirect on signature {type_index}: {targets} reachable target{}\nexport type $indirect{type_index}<{}> =\n{body}\n",
            if targets == 1 { "" } else { "s" },
            params.join(", "),
        )
    }

    /// The handful of operations that are genuinely cheaper by hand.
    ///
    /// Measured, per operation, in a 200-iteration loop: ts-type-math costs
    /// ~100µs for anything it has to walk bit by bit, and a hand-written 32-bit
    /// adder built from nibble lookup tables came out *slower* (130µs) - the cost
    /// in tsgo is the instantiation machinery, not the algorithm. What does win
    /// is anything that collapses into a single template-literal conditional:
    /// masks and constant shifts drop to ~10µs, and equality needs no pattern at
    /// all. Those are emitted here; everything else stays on ts-type-math.
    fn emit_fast_math() -> String {
        let mut out = String::new();
        out.push_str("export type $Flip = { '0': '1', '1': '0' }\n\n");
        out.push_str("/// logical not of a wasm boolean (0 or 1)\n");
        out.push_str("export type $Not1<B extends string> =\n");
        out.push_str("  B extends '00000000000000000000000000000000' ? '00000000000000000000000000000001' : '00000000000000000000000000000000'\n\n");
        out.push_str("/// equality is type identity: no bit walking, no pattern match\n");
        out.push_str("export type $Eq<A extends string, B extends string> =\n");
        out.push_str("  A extends B ? '00000000000000000000000000000001' : '00000000000000000000000000000000'\n");
        out.push_str("export type $Ne<A extends string, B extends string> =\n");
        out.push_str("  A extends B ? '00000000000000000000000000000000' : '00000000000000000000000000000001'\n");
        out
    }

    /// The entry point for a called function: takes memory, the caller's
    /// globals and the arguments, and zero-fills the rest of the locals.
    fn emit_call_entry(
        &self,
        func_index: usize,
        func_type: &FuncType,
        num_locals: usize,
        blocks: &[EmittedBlock],
    ) -> String {
        let (num_params, _) = self.func_signature(func_type);
        let entry = blocks.first().map(|b| b.id).unwrap_or(0);
        let mut params = vec![
            "$F extends string".to_string(),
            "$K extends unknown[]".to_string(),
            "$M extends $Node".to_string(),
        ];
        for i in 0..self.globals.len() {
            params.push(format!("$g{i} extends WasmValue"));
        }
        for i in 0..num_params {
            params.push(format!("$p{i} extends WasmValue"));
        }
        let mut args = vec!["$F".to_string(), "$K".to_string(), "$M".to_string()];
        for i in 0..self.globals.len() {
            args.push(format!("$g{i}"));
        }
        let live: Vec<u32> = blocks
            .first()
            .map(|block| block.live.iter().copied().collect())
            .unwrap_or_default();
        for index in live {
            let i = index as usize;
            args.push(if i < num_params {
                format!("$p{i}")
            } else {
                format!("'{}'", zero())
            });
        }
        let _ = num_locals;
        format!(
            "\nexport type $call{func_index}<{}> =\n  $b{func_index}_{entry}<{}>\n",
            params.join(", "),
            args.join(", ")
        )
    }

    /// One past the last addressable byte, when the module fixes it at compile
    /// time. `None` means the bound has to be read from the page-count global at
    /// type level instead.
    ///
    /// Three things can move the end of memory, and each has to be ruled out:
    /// `memory.grow`; an imported memory, whose declared size is the *minimum*
    /// the host must supply rather than a limit (doom declares 72 pages and its
    /// runner is free to hand over more, so believing 72 made every address
    /// above it trap); and a declared maximum, which does bound both of those.
    /// What is left is a module that defines its own memory and never grows it,
    /// where the declared size is exactly the size.
    fn fixed_mem_limit(&self) -> Option<u32> {
        // A module that grows moves its own end at runtime, so the bound has to
        // be read from the page-count global rather than fixed here - even
        // though `addressable_pages` would give a valid *upper* bound, using it
        // would accept an address in a page the program has not grown into yet.
        if self.grows_memory {
            return None;
        }
        Some((self.addressable_pages() * 65536).min(u32::MAX as u64) as u32)
    }

    /// Pages an access is allowed to touch.
    ///
    /// This is deliberately *not* what `memory.size` reports. That has to stay
    /// the declared minimum, because doom's allocator grows the heap from
    /// wherever memory currently ends and the zone address depends on it (see
    /// the note at `pages_global`). The bound an access is checked against is a
    /// different question: how much memory really exists.
    ///
    /// For a memory the module defines and never grows, the two coincide. For an
    /// imported one the host decides the size and the declaration is only a
    /// minimum - doom declares 72 pages and *needs* 128, since at 72 the real
    /// engine traps inside `entry` and at 128 it returns 4677984 - so believing
    /// the declaration here would refuse accesses the program legitimately
    /// makes. A declared maximum is a real ceiling; without one, what the trie
    /// can address is.
    fn addressable_pages(&self) -> u64 {
        let declared = if self.memory_imported || self.grows_memory {
            self.memory_max_pages.unwrap_or(self.capacity_pages)
        } else {
            self.memory_pages
        };
        declared.min(self.capacity_pages)
    }

    /// type and body of a defined function, by index into the defined functions
    fn function<'b>(
        &self,
        defined: usize,
        bodies: &'b [wasmparser::FunctionBody<'b>],
    ) -> Result<(FuncType, &'b wasmparser::FunctionBody<'b>), String> {
        let body = bodies
            .get(defined)
            .ok_or_else(|| format!("no body for function {defined}"))?;
        let type_index = *self
            .func_type_indices
            .get(defined)
            .ok_or_else(|| format!("no type for function {defined}"))?;
        let func_type = self
            .func_types
            .get(type_index as usize)
            .ok_or_else(|| format!("no type {type_index}"))?
            .clone();
        Ok((func_type, body))
    }

    /// which defined functions this body calls directly
    fn callees(&self, body: &wasmparser::FunctionBody) -> Result<Vec<usize>, String> {
        let mut found = Vec::new();
        for op in body.get_operators_reader().map_err(|e| e.to_string())? {
            match op.map_err(|e| e.to_string())? {
                Operator::Call { function_index } => {
                    if function_index < self.num_imports {
                        return Err(format!(
                            "calls to imported functions are not supported (function {function_index})"
                        ));
                    }
                    let defined = (function_index - self.num_imports) as usize;
                    if !found.contains(&defined) {
                        found.push(defined);
                    }
                }
                // A `call_indirect` can reach every table entry whose signature
                // matches, so those are reachable too. Missing them is why the
                // dispatch referenced `$call`s that were never emitted.
                Operator::CallIndirect { type_index, .. } => {
                    for (_, func_index) in &self.table_funcs {
                        if *func_index < self.num_imports {
                            continue;
                        }
                        let defined = (func_index - self.num_imports) as usize;
                        if self.func_type_indices.get(defined) != Some(&type_index) {
                            continue;
                        }
                        if !found.contains(&defined) {
                            found.push(defined);
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(found)
    }

    fn emit_prelude(&self) -> String {
        let bits = self.trie_bits;
        let digit = self.digit_bits;
        let fanout = 1usize << digit;
        let levels = bits / digit;
        let skip = 32 - 2 - bits;
        let z = zero();

        // $Slice: pull the addressing bits out of a 32-bit address
        let high: String = (0..skip).map(|i| format!("${{infer _h{i}}}")).collect();
        let mid: String = (0..bits).map(|i| format!("${{infer b{i}}}")).collect();
        let path: String = (0..bits).map(|i| format!("${{b{i}}}")).collect();
        // The bits $Slice throws away are constants for every address the
        // program actually forms: the high ones are zero because memory is
        // smaller than the address space, the low two because a word load is
        // aligned. Matching them as literals costs one infer instead of
        // {skip} + 2 of them, so the slow body stays behind as a fallback for
        // an address that is neither.
        let high_zeros: String = "0".repeat(skip);
        let low_zeros: String = "0".repeat(2);

        // one digit of the path, as a template pattern and as a value
        let digit_pattern: String = (0..digit).map(|i| format!("${{infer d{i}}}")).collect();
        let digit_value: String = (0..digit).map(|i| format!("${{d{i}}}")).collect();

        // $Sel / $Set: pick and replace one child of a branch node
        // $Sel indexes through a digit table instead of walking a chain of
        // {fanout} conditionals: two property lookups instead of ~fanout/2
        // conditional instantiations per trie level.
        let sel_arms: String = (0..fanout)
            .map(|i| format!("  '{:0width$b}': {i},\n", i, width = digit, i = i))
            .collect();
        let all_same: String = (0..fanout).map(|_| "T").collect::<Vec<_>>().join(", ");

        // the write buffer holds one bottom branch: the key is every digit above
        // it, so a store that stays inside the branch is a slot swap
        let key_bits = bits - digit;
        let buf_key: String = (0..key_bits).map(|i| format!("${{b{i}}}")).collect();
        let buf_digits: String = (0..levels - 1)
            .map(|l| {
                let group: String = (0..digit).map(|d| format!("${{b{}}}", l * digit + d)).collect();
                format!("`{group}`")
            })
            .collect::<Vec<_>>()
            .join(", ");
        let last_digit: String = (key_bits..bits).map(|i| format!("${{b{i}}}")).collect();
        // The write buffer is the {fanout} slots of one bottom branch, and every
        // store rebuilds it. Replacing one element of a tuple costs its length,
        // so the buffer is nested {rows} x {group}: a write touches {rows} + {group}
        // elements instead of {fanout}. Measured standalone, one $Set: 706
        // instantiations flat against 216 nested (and 185 at 4x4x4, whose extra
        // brackets cost more state text than the 31 instantiations save).
        // On a real doom gameplay chunk this is 28.7M instantiations -> 25.8M,
        // but only 16.26s -> 15.95s of check time: the chunk's cost is in what
        // the checker does per type, not in how many types it makes.
        let group_bits = digit / 2;
        let group = 1usize << group_bits;
        let rows = fanout / group;
        let hi_arms: String = (0..fanout)
            .map(|i| format!("  '{:0width$b}': {},\n", i, i / group, width = digit))
            .collect();
        let lo_arms: String = (0..fanout)
            .map(|i| format!("  '{:0width$b}': {},\n", i, i % group, width = digit))
            .collect();
        let empty_row: String = (0..group).map(|_| "'x'").collect::<Vec<_>>().join(", ");
        let empty_slots: String = (0..rows)
            .map(|_| format!("[{empty_row}]"))
            .collect::<Vec<_>>()
            .join(", ");
        let merge_slots: String = (0..fanout)
            .map(|i| {
                let (r, c) = (i / group, i % group);
                format!("S[{r}][{c}] extends 'x' ? N[{i}] : S[{r}][{c}]")
            })
            .collect::<Vec<_>>()
            .join(", ");
        // a key no real address can have, meaning "buffer empty"
        let buf_none = "e".repeat(key_bits.max(1));

        format!(
            r#"// Generated by the CFG AOT compiler. Do not edit.
//
// Memory is a sparse {fanout}-way trie over the address bits.
//
// Why a trie: `S['memory'] & Record<Addr, V>` cannot work, because
// intersecting two different literals for one key gives `never` - the second
// write to a word poisons it, and an `i32.store8` is a read-modify-write, so
// four byte stores into one word are enough to lose the word.
//
// Why {fanout}-way and not binary: the state has to come back to the host as text
// between chunks, and the type *printer* elides parts of deeply nested types
// (printing them as `any`) even when the type itself is perfectly correct.
// {levels} levels stays clear of that, and it also costs {levels} instantiations per
// read or write instead of {bits}.
import type {{ Wasm, WasmValue, Convert }} from 'ts-type-math'

export type $Zero = ['{z}']
/// A node is always a tuple: [word] is a leaf, a {fanout}-tuple is a branch.
/// Deliberately not a union - a union constraint makes `infer M extends $Node`
/// distribute, and a write against a distributed memory silently returns two
/// copies of the trie unioned together.
export type $Node = unknown[]

/// The state a block's instruction pipeline threads through: memory in slot 0,
/// then one slot per value. Typing it this way means a step can read `$S[3]` and
/// get a `WasmValue` back with no narrowing at the read.
export type $State = [$Node, ...WasmValue[]]

/// everything but the memory slot, so a store can put a new memory in its place
export type $Rest<$S extends $State> =
  $S extends [unknown, ...infer $R extends WasmValue[]] ? $R : never
/// Fuel is a string of '1's, one per unit of work. Decrementing takes a prefix
/// off a string, which costs nothing; the obvious `[any, ...infer Rest]` tuple
/// copies every remaining element on every hop instead, and at a few thousand
/// units that dominated the whole frame.
export type $Fuel = string

/// the addressing bits of an address: drop the two byte-offset bits, keep {bits}
export type $Slice<A extends string> =
  A extends `{high_zeros}${{infer B extends string}}{low_zeros}`
    ? B
    : $SliceWide<A>
export type $SliceWide<A extends string> =
  A extends `{high}{mid}${{infer _l0}}${{infer _l1}}`
    ? `{path}`
    : never

export type $Word<T> = T extends [infer W extends string] ? W : '{z}'

/// digit -> child index
export type $DIdx = {{
{sel_arms}}}

/// pick child D of a branch node
export type $Sel<T, D extends string> =
  D extends keyof $DIdx ? T[$DIdx[D] & keyof T] : never

/// replace child D of a branch node with X. A homomorphic mapped type over a
/// tuple rebuilds it in one instantiation; a {fanout}-arm conditional that
/// spelled the new tuple out per arm cost ~fanout/2 arm checks each write.
export type $Set<T, D extends string, X> =
  {{ [K in keyof T]: K extends `${{$DIdx[D & keyof $DIdx]}}` ? X : T[K] }}

/// A leaf is `[word]`; a branch has {fanout} slots. Reading `length` tells them
/// apart without matching T against a {fanout}-wide tuple pattern.
export type $Get<T, B extends string> =
  B extends `{digit_pattern}${{infer Rest}}`
    ? T['length' & keyof T] extends 1
      ? $Word<T>
      : $Get<$Sel<T, `{digit_value}`>, Rest>
    : $Word<T>

/// Writing into a leaf that stands for a whole subtree splits it, and every
/// child inherits the leaf: a leaf above the bottom means "every word below me
/// holds this", which is how all-zero subtrees stay shared and cheap.
export type $Put<T, B extends string, V extends string> =
  B extends `{digit_pattern}${{infer Rest}}`
    ? T['length' & keyof T] extends 1
      ? $Set<[{all_same}], `{digit_value}`, $Put<T, Rest, V>>
      : $Set<T, `{digit_value}`, $Put<$Sel<T, `{digit_value}`>, Rest, V>>
    : [V]

export type $AlignAddr<A extends WasmValue> = Wasm.I32And<A, '11111111111111111111111111111100'>

/// The two low bits of an address, as characters. A byte offset is the last two
/// characters of the address string - no arithmetic needed to find it.
export type $Off<A extends string> =
  A extends `${{string}}00` ? '00'
    : A extends `${{string}}01` ? '01'
    : A extends `${{string}}10` ? '10'
    : A extends `${{string}}11` ? '11'
    : never

/// Read one byte out of a word by slicing characters, not by shifting bits.
/// Words are little-endian, so byte 0 is the *last* eight characters.
export type $GetByte<W extends string, O extends string> =
  W extends `{word_pattern}`
    ? O extends '00' ? `{zeros24}{byte0}`
      : O extends '01' ? `{zeros24}{byte1}`
      : O extends '10' ? `{zeros24}{byte2}`
      : `{zeros24}{byte3}`
    : never

/// Replace one byte of a word with the low byte of V, again by slicing.
export type $SetByte<W extends string, O extends string, V extends string> =
  W extends `{word_pattern}`
    ? V extends `{value_pattern}`
      ? O extends '00' ? `{byte3}{byte2}{byte1}{vbyte0}`
        : O extends '01' ? `{byte3}{byte2}{vbyte0}{byte0}`
        : O extends '10' ? `{byte3}{vbyte0}{byte1}{byte0}`
        : `{vbyte0}{byte2}{byte1}{byte0}`
      : never
    : never

export type $ByteOffset<A extends WasmValue> = Wasm.I32And<A, '{three}'>

/// A branch node, expanding a shared leaf into {fanout} copies of itself.
export type $Node8<T> = T['length' & keyof T] extends 1
  ? [{all_same}] : T

/// The address split the way the write buffer wants it: the key of the bottom
/// branch (everything but the last digit), that key as digits, and the digit.
export type $Split<A extends string> =
  A extends `{high_zeros}{mid}{low_zeros}`
    ? [`{buf_key}`, [{buf_digits}], `{last_digit}`]
    : $SplitWide<A>
export type $SplitWide<A extends string> =
  A extends `{high}{mid}${{infer _l0}}${{infer _l1}}`
    ? [`{buf_key}`, [{buf_digits}], `{last_digit}`]
    : never

/// One slot per word of the bottom branch; 'x' means "not written yet", which
/// is what lets a flush leave untouched words alone without reading them first.
/// The slots are nested {rows} x {group} because replacing one element of a
/// tuple costs its length: a buffered store rebuilds one row and the row list,
/// {rows} + {group} elements, not all {fanout}.
export type $Empty = [{empty_slots}]

/// digit -> row of the buffer, and digit -> slot within that row
export type $DHi = {{
{hi_arms}}}
export type $DLo = {{
{lo_arms}}}

export type $BSel<S extends unknown[][], D extends string> =
  S[$DHi[D & keyof $DHi] & keyof S] extends infer R extends unknown[]
    ? R[$DLo[D & keyof $DLo] & keyof R]
    : never
export type $BRow<R, D extends string, X> =
  {{ [J in keyof R]: J extends `${{$DLo[D & keyof $DLo]}}` ? X : R[J] }}
export type $BSet<S, D extends string, X> =
  {{ [K in keyof S]: K extends `${{$DHi[D & keyof $DHi]}}` ? $BRow<S[K], D, X> : S[K] }}

/// Push the buffered slots into the trie: one walk down, one merge at the leaf.
export type $MergeAt<T, B extends unknown[], S extends unknown[][]> =
  B extends [infer D extends string, ...infer Rest]
    ? $Set<$Node8<T>, D, $MergeAt<$Sel<$Node8<T>, D>, Rest, S>>
    : $Node8<T> extends infer N extends unknown[]
      ? [{merge_slots}]
      : never

/// What the host reads back: the overlay alone, with its write buffer folded
/// in. The base trie never travels - the host already holds it, and pasting it
/// back is what used to make a store cost the size of the state.
export type $Flush<M> = M extends [infer T, infer K, infer B extends unknown[], infer S extends unknown[][], infer _Base]
  ? K extends '{buf_none}' ? T : $MergeAt<T, B, S>
  : M

/// Memory is an overlay over the trie the chunk started with, not the trie
/// itself. Measured on doom's real state (5.4MB) with 128 consecutive stores:
///
///     writing into the state trie   3661 instantiations per word
///     writing into a fresh overlay   385 instantiations per word
///
/// The cost of a write scales with the size of the trie it rebuilds, so a
/// chunk that writes into an empty overlay pays for what it wrote instead of
/// for what memory holds. Reads cost 238 against 216: one extra probe that
/// misses, then the same fetch as before. The host merges the overlay into its
/// own copy between chunks, where it is a native array write.
export type $Buf<T> = [$Absent, '{buf_none}', [], $Empty, T]

/// Stores go into a one-branch write buffer instead of straight into the trie.
/// Measured on a real frame: consecutive words - which is what pixel loops and
/// memsets write - then share a single walk down the trie instead of paying
/// {levels} rebuild levels each, and a scattered store costs what it did before.
/// A subtree nobody has written to. Splitting it hands every child the same
/// marker, exactly like a $Zero leaf standing for a whole subtree of zeros.
export type $Absent = ['u']

/// Reading a word the overlay has never been written to falls through to the
/// module's own initial memory, so the state travelling between chunks carries
/// only what the program has actually stored. Measured on doom at chunk 780:
/// 20048 words instead of 46975, 0.74MB of state text instead of 2.48MB. The
/// state is re-parsed and re-checked on every chunk, so its size is what
/// decides whether a chunk fits inside TypeScript's instantiation budget.
export type $Fetch<T, P extends string> =
  $Get<T, P> extends infer W extends string
    ? W extends 'u' ? $InitFetch<P> : W
    : never

/// A word the overlay does not have falls through to the base trie, and a word
/// the base trie does not have falls through to the module's initial memory.
export type $Under<T, Base, P extends string> =
  $Get<T, P> extends infer W extends string
    ? W extends 'u' ? $Fetch<Base, P> : W
    : never

/// Every slot is an `infer`, so the pattern instantiates back to M itself and
/// the match is an identity check. A literal `unknown[]` slot made it a
/// structural compare, whose relation key walks every type argument of M,
/// base trie included (isTypeReferenceWithGenericArguments): 22% of a
/// gameplay chunk's checker samples.
export type $Read<M extends $Node, A extends WasmValue> =
  M extends [infer T, infer MK extends string, infer _MB, infer S extends unknown[][], infer Base]
    ? $Slice<A> extends infer P extends string
      ? P extends `${{MK}}${{infer D}}`
        ? $BSel<S, D> extends infer H
          ? H extends 'x' ? $Under<T, Base, P> : $Word<H>
          : never
        : $Under<T, Base, P>
      : never
    : never
export type $Write<M extends $Node, A extends WasmValue, V extends WasmValue> =
  $Split<A> extends [infer K extends string, infer B extends unknown[], infer D extends string]
    ? M extends [infer T, infer MK, infer MB extends unknown[], infer S extends unknown[][], infer Base]
      ? K extends MK
        ? [T, MK, MB, $BSet<S, D, [V]>, Base]
        : [(MK extends '{buf_none}' ? T : $MergeAt<T, MB, S>), K, B, $BSet<$Empty, D, [V]>, Base]
      : never
    : never

/// 8-bit access: one trie walk plus one character splice, no arithmetic at all
export type $Load8U<M extends $Node, A extends WasmValue> = $GetByte<$Read<M, A>, $Off<A>>
export type $Load8S<M extends $Node, A extends WasmValue> =
  Wasm.I32ShrS<Wasm.I32Shl<$Load8U<M, A>, '{twentyfour}'>, '{twentyfour}'>
export type $Store8<M extends $Node, A extends WasmValue, V extends WasmValue> =
  $Write<M, A, $SetByte<$Read<M, A>, $Off<A>, V>>

/// 32-bit access: aligned is a plain trie read or write; unaligned falls back to
/// the bit arithmetic, which pong never needs
export type $Load32<M extends $Node, A extends WasmValue> =
  A extends `${{string}}00`
    ? $Read<M, A>
    : Wasm.I32Or<
        Wasm.I32ShrU<$Read<M, A>, Wasm.I32Shl<$ByteOffset<A>, '{three}'>>,
        Wasm.I32Shl<$Read<M, Wasm.I32Add<$AlignAddr<A>, '{four}'>>, Wasm.I32Sub<'{thirtytwo}', Wasm.I32Shl<$ByteOffset<A>, '{three}'>>>
      >
export type $Store32<M extends $Node, A extends WasmValue, V extends WasmValue> =
  A extends `${{string}}00`
    ? $Write<M, A, V>
    : $Store16<$Store16<M, A, V>, Wasm.I32Add<A, '{two}'>, Wasm.I32ShrU<V, '{sixteen}'>>

/// 16-bit access: two byte splices when it stays inside a word
export type $Load16U<M extends $Node, A extends WasmValue> =
  $Off<A> extends '11'
    ? Wasm.I32Or<
        Wasm.I32ShrU<$Read<M, A>, '{twentyfour}'>,
        Wasm.I32Shl<Wasm.I32And<$Read<M, Wasm.I32Add<$AlignAddr<A>, '{four}'>>, '{ff}'>, '{eight}'>
      >
    : Wasm.I32Or<$Load8U<M, A>, Wasm.I32Shl<$GetByte<$Read<M, A>, $Next<$Off<A>>>, '{eight}'>>
export type $Load16S<M extends $Node, A extends WasmValue> =
  Wasm.I32ShrS<Wasm.I32Shl<$Load16U<M, A>, '{sixteen}'>, '{sixteen}'>
export type $Next<O extends string> = O extends '00' ? '01' : O extends '01' ? '10' : O extends '10' ? '11' : '00'
export type $Store16<M extends $Node, A extends WasmValue, V extends WasmValue> =
  $Off<A> extends '11'
    ? $Store8<$Store8<M, A, V>, Wasm.I32Add<A, '{one}'>, Wasm.I32ShrU<V, '{eight}'>>
    : $Write<M, A, $SetByte<$SetByte<$Read<M, A>, $Off<A>, V>, $Next<$Off<A>>, Wasm.I32ShrU<V, '{eight}'>>>

export type $ToNumber<V> = Convert.WasmValue.ToTSNumber<V & string, 'i32'>

/// 64-bit access. A value is a binary string, so a 64-bit value is just its two
/// 32-bit words written end to end: joining them is a template literal and
/// splitting them is a single inference. Neither costs arithmetic. Memory is
/// little-endian, so the low word lives at A and the high word at A+4.
export type $Hi32<V extends string> = V extends `{word64_pattern}${{infer _Lo}}` ? `{word64_joined}` : never
export type $Lo32<V extends string> = V extends `{word64_pattern}${{infer Lo}}` ? Lo : never
export type $Load64<M extends $Node, A extends WasmValue> =
  `${{$Load32<M, Wasm.I32Add<A, '{four}'>>}}${{$Load32<M, A>}}`
export type $Store64<M extends $Node, A extends WasmValue, V extends WasmValue> =
  $Store32<$Store32<M, A, $Lo32<V>>, Wasm.I32Add<A, '{four}'>, $Hi32<V>>

{fast_math}
"#,
            fanout = fanout,
            levels = levels,
            bits = bits,
            z = z,
            one = bits32(1),
            two = bits32(2),
            three = bits32(3),
            four = bits32(4),
            eight = bits32(8),
            sixteen = bits32(16),
            twentyfour = bits32(24),
            thirtytwo = bits32(32),
            ff = bits32(0xff),
            high_zeros = high_zeros,
            low_zeros = low_zeros,
            high = high,
            mid = mid,
            path = path,
            word_pattern = (0..32)
                .map(|i| format!("${{infer w{i}}}"))
                .collect::<String>(),
            value_pattern = (0..32)
                .map(|i| format!("${{infer v{i}}}"))
                .collect::<String>(),
            word64_pattern = split64_pattern().0,
            word64_joined = split64_pattern().1,
            fast_math = Self::emit_fast_math(),
            zeros24 = "0".repeat(24),
            byte3 = (0..8).map(|i| format!("${{w{i}}}")).collect::<String>(),
            byte2 = (8..16).map(|i| format!("${{w{i}}}")).collect::<String>(),
            byte1 = (16..24).map(|i| format!("${{w{i}}}")).collect::<String>(),
            byte0 = (24..32).map(|i| format!("${{w{i}}}")).collect::<String>(),
            vbyte0 = (24..32).map(|i| format!("${{v{i}}}")).collect::<String>(),
            digit_pattern = digit_pattern,
            digit_value = digit_value,
            buf_key = buf_key,
            buf_digits = buf_digits,
            last_digit = last_digit,
            empty_slots = empty_slots,
            merge_slots = merge_slots,
            hi_arms = hi_arms,
            lo_arms = lo_arms,
            rows = rows,
            group = group,
            buf_none = buf_none,
            sel_arms = sel_arms,
            all_same = all_same,
        )
    }

    /// The data segments as a trie literal, so the first chunk starts from a
    /// concrete memory image instead of building one at type level.
    /// The four things the host wants out of a result, spelled with this
    /// module's own globals count so it can read each one by position instead of
    /// counting commas in printed text.
    ///
    /// Suspend is `['s', frames, memory, globals...]` and return is
    /// `['r', fuel, memory, globals..., value]`. The frames are innermost first;
    /// the host resumes frames[0] and keeps the rest as the new `$K`.
    fn emit_host_accessors(&self) -> String {
        let count = self.globals.len();
        let infers: Vec<String> = (0..count).map(|i| format!("infer $h{i}")).collect();
        let names = infers
            .iter()
            .map(|s| s.trim_start_matches("infer ").to_string())
            .collect::<Vec<_>>()
            .join(", ");
        // with no globals the patterns have nothing between the memory and the
        // value, so the separators have to disappear with them
        let suspend_globals = if count == 0 {
            "  $R extends never ? [] : []".to_string()
        } else {
            format!(
                "  $R extends ['s', unknown, unknown, {}] ? [{names}]\n  : $R extends ['r', unknown, unknown, unknown, {}, unknown] ? [{names}]\n  : []",
                infers.join(", "),
                infers.join(", ")
            )
        };
        let leading: String = (0..count).map(|_| "unknown, ".to_string()).collect();
        // One reader per trie branch, so a memory too big to print in one go can
        // be read a subtree at a time. The checker's printer stops at a million
        // characters even with noErrorTruncation, and past that it hands back
        // `any` for whatever it did not reach - which would be pasted into the
        // next chunk as a hole. A subtree that still does not fit gets split
        // again, so the depth this can recover from is not fixed.
        let fanout = 1usize << self.digit_bits;
        let mut kids = String::new();
        kids.push_str(
            "\n/// one trie branch at a time, for a memory too big for the printer\n",
        );
        for i in 0..fanout {
            let slots: Vec<String> = (0..fanout)
                .map(|j| if i == j { format!("infer $c{j}") } else { "unknown".to_string() })
                .collect();
            kids.push_str(&format!(
                // a leaf stands for every word below it, so its children are itself:
                // the host slices the memory two levels down to print it, and a
                // subtree nothing has written to is one $Absent leaf up top
                "export type $Kid{i}<$M> = $M extends [{}] ? $c{i} : $M\n",
                slots.join(", ")
            ));
        }
        format!(
            "\n/// the tag, and then each piece of the result the host has to paste on\n\
             export type $Tag<$R> = $R extends [infer $T, ...unknown[]] ? $T : 'bad'\n\
             export type $Frames<$R> = $R extends ['s', infer $Ks extends unknown[], ...unknown[]] ? $Ks : []\n\
             export type $MemOf<$R> =\n  \
             $R extends ['s', unknown, infer $M1, ...unknown[]] ? $M1\n  \
             : $R extends ['r', unknown, unknown, infer $M1, ...unknown[]] ? $M1\n  \
             : never\n\
             export type $GlobalsOf<$R> =\n{suspend_globals}\n\
             export type $ValueOf<$R> =\n  \
             $R extends ['r', unknown, unknown, unknown, {leading}infer $V] ? $V : 'void'\n\
             {kids}"
        )
    }

    fn emit_initial_memory(&self) -> String {
        let mut words: HashMap<u32, u32> = HashMap::new();
        for (offset, bytes) in &self.data {
            for (i, byte) in bytes.iter().enumerate() {
                let addr = offset + i as u32;
                let word_addr = addr & !3;
                let shift = (addr & 3) * 8;
                let entry = words.entry(word_addr).or_insert(0);
                *entry |= (*byte as u32) << shift;
            }
        }
        for (_, value) in self.globals.iter().enumerate() {
            let _ = value;
        }
        let mut sorted: Vec<(u32, u32)> = words.into_iter().filter(|(_, v)| *v != 0).collect();
        sorted.sort_by_key(|(addr, _)| *addr);
        let literal = self.trie_literal(&sorted);
        // A read of a word nothing has stored to falls through to initial
        // memory, and on a doom frame that is nearly every read: walking the
        // trie for it was 85% of a chunk's instantiations. Keyed by the same
        // path string $Get would have walked, the fallback is one property
        // lookup instead of {levels} nested $Sel instantiations over big tuples.
        // The trie literal stays because the host parses it to decode state.
        // $Slice keeps the low trie_bits bits of the word address, and the trie
        // buckets collisions to the lowest address of the bucket, so the map has
        // to alias and tie-break the same way or a read would disagree with the
        // literal the host decodes.
        let bits = self.trie_bits;
        let mask: u32 = if bits >= 32 { u32::MAX } else { (1u32 << bits) - 1 };
        // A flat map costs a whole key union to read from. `P extends keyof
        // $InitialMap` makes the checker materialise every key as a string
        // literal type before it can answer, so a single word read pays for
        // the entire map: 1035055 types a chunk on doom, of which 1.03M were
        // the union and only ~21K were the program actually running. Splitting
        // the key at the last `leaf_bits` gives an outer union of buckets and
        // an inner union per bucket, so a read touches `hi + leaf` keys rather
        // than all of them. Measured on doom: 21742 types a chunk, check 0.189s
        // instead of 1.392s, and all 4165 word readouts byte-identical.
        let leaf_bits = if bits > 8 { 8 } else { bits };
        let hi_bits = bits - leaf_bits;
        let zero = "0".repeat(32);
        let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
        let mut map = String::from("\nexport type $InitialMap = {\n");
        let helper;
        if hi_bits == 0 {
            // Too few bits to be worth splitting: the flat union is already small.
            for (addr, value) in &sorted {
                let path_bits = (addr >> 2) & mask;
                if !seen.insert(path_bits) {
                    continue;
                }
                let path = format!("{path_bits:0width$b}", width = bits);
                map.push_str(&format!("  '{path}': '{value:032b}',\n"));
            }
            map.push_str("}\n");
            helper = format!(
                "\nexport type $InitFetch<P extends string> =\n  P extends keyof $InitialMap ? $InitialMap[P] : '{zero}'\n"
            );
        } else {
            let leaf_mask: u32 = (1u32 << leaf_bits) - 1;
            let mut groups: Vec<(u32, Vec<(u32, u32)>)> = Vec::new();
            let mut slot_of: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
            for (addr, value) in &sorted {
                let path_bits = (addr >> 2) & mask;
                if !seen.insert(path_bits) {
                    continue;
                }
                let hi = path_bits >> leaf_bits;
                let lo = path_bits & leaf_mask;
                let slot = *slot_of.entry(hi).or_insert_with(|| {
                    groups.push((hi, Vec::new()));
                    groups.len() - 1
                });
                groups[slot].1.push((lo, *value));
            }
            for (hi, entries) in &groups {
                map.push_str(&format!("  '{hi:0hw$b}': {{\n", hw = hi_bits));
                for (lo, value) in entries {
                    map.push_str(&format!("    '{lo:0lw$b}': '{value:032b}',\n", lw = leaf_bits));
                }
                map.push_str("  },\n");
            }
            map.push_str("}\n");
            // One `infer` per high bit rather than a single greedy one: the
            // checker splits a fixed-width prefix without backtracking, and the
            // rest lands in R as the leaf key.
            let mut infers = String::new();
            let mut concat = String::new();
            for i in 0..hi_bits {
                infers.push_str(&format!("${{infer C{i}}}"));
                concat.push_str(&format!("${{C{i}}}"));
            }
            helper = format!(
                "\nexport type $InitFetch<P extends string> =\n  P extends `{infers}${{infer R}}`\n    ? `{concat}` extends infer H extends keyof $InitialMap\n      ? R extends keyof $InitialMap[H] ? $InitialMap[H][R] : '{zero}'\n      : '{zero}'\n    : '{zero}'\n"
            );
        }
        format!("\nexport type $InitialMemory = {literal}\n{map}{helper}")
    }

    /// Build the nested-tuple literal for a set of word writes, sharing the
    /// zero marker for every subtree nothing was written into.
    fn trie_literal(&self, words: &[(u32, u32)]) -> String {
        let digit = self.digit_bits;
        let fanout = 1usize << digit;
        let levels = self.trie_bits / digit;
        fn build(words: &[(u32, u32)], level: usize, levels: usize, digit: usize, fanout: usize) -> String {
            if words.is_empty() {
                return "$Zero".to_string();
            }
            if level == levels {
                return format!("['{:032b}']", words[0].1);
            }
            let shift = (levels - 1 - level) * digit;
            let mut buckets: Vec<Vec<(u32, u32)>> = vec![Vec::new(); fanout];
            for &(addr, value) in words {
                let index = ((addr >> 2) >> shift) as usize & (fanout - 1);
                buckets[index].push((addr, value));
            }
            let children: Vec<String> = buckets
                .iter()
                .map(|bucket| build(bucket, level + 1, levels, digit, fanout))
                .collect();
            format!("[{}]", children.join(", "))
        }
        build(words, 0, levels, digit, fanout)
    }

    fn func_signature(&self, func_type: &FuncType) -> (usize, usize) {
        (func_type.params().len(), func_type.results().len())
    }

    fn compile_function(
        &self,
        func_index: usize,
        body: &wasmparser::FunctionBody,
        func_type: &FuncType,
    ) -> Result<(Vec<EmittedBlock>, usize), String> {
        let (num_params, num_results) = self.func_signature(func_type);
        if num_results > 1 {
            return Err("multiple return values are not supported yet".to_string());
        }
        for param in func_type.params() {
            if *param != ValType::I32 {
                return Err(format!("only i32 params are supported, found {param:?}"));
            }
        }

        let mut num_locals = num_params;
        for local in body.get_locals_reader().map_err(|e| e.to_string())? {
            let (count, ty) = local.map_err(|e| e.to_string())?;
            if ty != ValType::I32 {
                return Err(format!("only i32 locals are supported, found {ty:?}"));
            }
            num_locals += count as usize;
        }

        let ops: Vec<Operator> = body
            .get_operators_reader()
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;

        let mut compiler = FunctionCfg {
            module: self,
            func_index,
            ops: &ops,
            num_locals,
            num_results,
            blocks: Vec::new(),
            sites: Vec::new(),
            successors: Vec::new(),
            pending: Vec::new(),
            next_id: 0,
            ends: end_map(&ops)?,
        };
        compiler.run()?;
        Ok((compiler.blocks, num_locals))
    }

    fn emit_entry(
        &self,
        name: &str,
        func_index: usize,
        func_type: &FuncType,
        num_locals: usize,
        blocks: &[EmittedBlock],
    ) -> String {
        let (num_params, _) = self.func_signature(func_type);
        let entry = blocks.first().map(|b| b.id).unwrap_or(0);
        let params: Vec<String> = (0..num_params).map(|i| format!("$p{i}")).collect();
        let decls: Vec<String> = params
            .iter()
            .map(|p| format!("{p} extends WasmValue"))
            .collect();
        let mut args: Vec<String> = vec!["$F".to_string(), "[]".to_string(), "$Buf<$M>".to_string()];
        for i in 0..self.globals.len() {
            args.push(format!("'{}'", bits32(self.globals[i] as i32)));
        }
        let live: Vec<u32> = blocks
            .first()
            .map(|block| block.live.iter().copied().collect())
            .unwrap_or_default();
        for index in live {
            let i = index as usize;
            args.push(if i < num_params {
                params[i].clone()
            } else {
                format!("'{}'", zero())
            });
        }
        let _ = num_locals;
        let decl_list = if decls.is_empty() {
            String::new()
        } else {
            format!(", {}", decls.join(", "))
        };
        format!(
            "\nexport type ${name}<$F extends string, $M extends $Node{decl_list}> =\n  $Exit<$b{func_index}_{entry}<{}>>\n",
            args.join(", ")
        )
    }
}

/// Map each structured-instruction position to the position of its `End`, and
/// each `If` to its `Else` when it has one.
fn end_map(ops: &[Operator]) -> Result<HashMap<usize, (usize, Option<usize>)>, String> {
    let mut map = HashMap::new();
    let mut stack: Vec<(usize, Option<usize>)> = Vec::new();
    for (pos, op) in ops.iter().enumerate() {
        match op {
            Operator::Block { .. } | Operator::Loop { .. } | Operator::If { .. } => {
                stack.push((pos, None));
            }
            Operator::Else => {
                if let Some(top) = stack.last_mut() {
                    top.1 = Some(pos);
                }
            }
            Operator::End => {
                if let Some((start, else_pos)) = stack.pop() {
                    map.insert(start, (pos, else_pos));
                }
            }
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err("unbalanced control flow".to_string());
    }
    Ok(map)
}

struct FunctionCfg<'a> {
    module: &'a CfgCompiler,
    func_index: usize,
    ops: &'a [Operator<'a>],
    num_locals: usize,
    num_results: usize,
    blocks: Vec<EmittedBlock>,
    /// (target block, the caller's local values) for every jump, in order
    sites: Vec<(usize, Vec<String>)>,
    /// successors of the block currently being compiled
    successors: Vec<usize>,
    pending: Vec<Pending>,
    next_id: usize,
    ends: HashMap<usize, (usize, Option<usize>)>,
}

impl<'a> FunctionCfg<'a> {
    fn fresh_id(&mut self) -> usize {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn block_name(&self, id: usize) -> String {
        format!("$b{}_{}", self.func_index, id)
    }

    fn run(&mut self) -> Result<(), String> {
        let entry = self.fresh_id();
        self.pending.push(Pending {
            id: entry,
            pos: 0,
            labels: vec![Label {
                kind: LabelKind::Block,
                target: usize::MAX, // function return
                exit: usize::MAX,
                arity: self.num_results,
                exit_arity: self.num_results,
                stack_floor: 0,
            }],
            stack: Vec::new(),
        });
        while let Some(pending) = self.pending.pop() {
            let block = self.compile_block(pending)?;
            self.blocks.push(block);
            if self.blocks.len() > 4000 {
                return Err("function produced too many blocks".to_string());
            }
        }
        self.blocks.sort_by_key(|b| b.id);
        self.compute_liveness();
        self.render_blocks();
        Ok(())
    }

    /// Backward dataflow: a local is live entering a block if the block reads it
    /// before writing it, or if any successor needs it and this block does not
    /// overwrite it first.
    ///
    /// Worth about 25% on a real frame, measured: pong-tiny goes from 3.8 to
    /// 4.6 frames per second and the pixel game from 0.33s to 0.245s a frame,
    /// with every pixel still identical to the wasm engine. Mean parameters per
    /// block drops from 17 to 8.5.
    ///
    /// A caution about why, since it is easy to get wrong: type arguments are
    /// not individually expensive. A hand-written loop carrying 20 string
    /// parameters costs the same per iteration as one carrying 2. What this
    /// saves is the size of the state threaded through every hop and rebuilt in
    /// every suspend payload, not a per-argument fee.
    fn compute_liveness(&mut self) {
        let index_of: HashMap<usize, usize> = self
            .blocks
            .iter()
            .enumerate()
            .map(|(index, block)| (block.id, index))
            .collect();
        for block in &mut self.blocks {
            block.live = block.reads.clone();
        }
        loop {
            let mut changed = false;
            for position in (0..self.blocks.len()).rev() {
                let mut live = self.blocks[position].reads.clone();
                for successor in self.blocks[position].successors.clone() {
                    let Some(&target) = index_of.get(&successor) else {
                        continue;
                    };
                    for local in self.blocks[target].live.clone() {
                        if !self.blocks[position].writes.contains(&local) {
                            live.insert(local);
                        }
                    }
                }
                if live != self.blocks[position].live {
                    self.blocks[position].live = live;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }

    /// Render every block now that liveness is settled: the markers left during
    /// compilation can be filled in, and a pipeline's slot indices are known.
    fn render_blocks(&mut self) {
        let live: HashMap<usize, Vec<u32>> = self
            .blocks
            .iter()
            .map(|block| (block.id, block.live.iter().copied().collect()))
            .collect();
        let sites = std::mem::take(&mut self.sites);
        let blocks = std::mem::take(&mut self.blocks);
        let mut rendered = Vec::with_capacity(blocks.len());
        for mut block in blocks {
            // the locals passed at each jump have to be filled in before the
            // block is rendered: a pipeline rewrites value names to slot reads,
            // and names that arrive later would be left dangling
            block.terminator = self.resolve_jumps(std::mem::take(&mut block.terminator), &live, &sites);
            // a pipeline needs at least a couple of instructions to be worth the
            // aliases, and cannot express a destructuring binding
            let destructures = block
                .bindings
                .iter()
                .any(|(name, _, _)| name.contains("infer") || name.starts_with('['));
            // Nested `infer`s are the cheaper rendering while a block is short:
            // measured on gfx, 16.8 frames a second nested against 10.4 as a
            // pipeline, because appending to the state tuple costs more per
            // instruction than one more `infer`. Past the crossover the nesting
            // is what costs - 16 deep is 10.4s in the worst shape, 20 is 13.7
            // minutes - so long blocks get the pipeline, whose cost is linear.
            let body = if block.has_pattern || destructures || block.bindings.len() <= nest_limit() {
                self.render_nested(&block)
            } else {
                self.render_pipeline(&block, &live)
            };
            block.body = self.resolve_markers(body, &block, &live);
            rendered.push(block);
        }
        self.blocks = rendered;
        self.sites = sites;
    }

    /// Fill in the locals passed at each jump: which of the values in scope the
    /// target block turned out to want.
    fn resolve_jumps(
        &self,
        mut body: String,
        live: &HashMap<usize, Vec<u32>>,
        sites: &[(usize, Vec<String>)],
    ) -> String {
        let empty = Vec::new();
        while let Some(start) = body.find("\u{1}L") {
            let end = body[start + 2..]
                .find('\u{1}')
                .map(|at| start + 2 + at)
                .unwrap_or(body.len());
            let site: usize = body[start + 2..end].parse().unwrap_or(0);
            let (target, values) = &sites[site];
            let selected: Vec<String> = live
                .get(target)
                .unwrap_or(&empty)
                .iter()
                .filter_map(|index| values.get(*index as usize).cloned())
                .collect();
            if selected.is_empty() {
                // drop a separator too, so no empty argument is left behind
                body.replace_range(start..end + 1, "");
                if body[start..].starts_with(", ") {
                    body.replace_range(start..start + 2, "");
                } else if body[..start].ends_with(", ") {
                    body.replace_range(start - 2..start, "");
                }
            } else {
                body.replace_range(start..end + 1, &selected.join(", "));
            }
        }
        body
    }

    /// Fill in this block's parameter list and its suspend payload.
    fn resolve_markers(
        &self,
        body: String,
        block: &EmittedBlock,
        live: &HashMap<usize, Vec<u32>>,
    ) -> String {
        let empty = Vec::new();
        let wanted = live.get(&block.id).unwrap_or(&empty);
        let params: Vec<String> = wanted
            .iter()
            .map(|index| format!("$l{index} extends WasmValue"))
            .collect();
        let payload: Vec<String> = wanted.iter().map(|index| format!("$l{index}")).collect();
        let mut body = fill_marker(body, &format!("\u{1}P{}\u{1}", block.id), &params);
        body = fill_marker(body, &format!("\u{1}S{}\u{1}", block.id), &payload);
        body
    }

    /// locals live entering the function's first block
    fn entry_live(&self) -> Vec<u32> {
        self.blocks
            .first()
            .map(|block| block.live.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Blocks up to this many instructions are rendered as nested `infer`s,
    /// longer ones as a pipeline. See `nest_limit()` for the live value.

    /// The same limit for a block rendered as a pipeline, where instructions are
    /// applications of one-step aliases rather than nested `infer`s and the
    /// checker's cost is linear instead of exponential. This is only here to
    /// keep the state tuple and the generated text a sane size.

    /// Memory operations inside a block chain: each store leaves the memory as
    /// an unevaluated `$Store32<...>` wrapped around the last one, and every
    /// later load has to walk through them. Long arithmetic runs stay cheap,
    /// long runs of loads and stores do not, so they get their own limit.

    /// Recognise the canonical byte-blit loop
    ///
    ///   loop
    ///     local.get $c  i32.eqz  br_if 1
    ///     local.get $d  local.get $s  i32.load8_u  i32.store8
    ///     local.get $d  i32.const KD  i32.add  local.set $d
    ///     local.get $s  i32.const KS  i32.add  local.set $s
    ///     local.get $c  i32.const -1  i32.add  local.set $c
    ///     br 0
    ///   end
    ///
    /// Doom's V_DrawPatch* inner column copy has this exact shape with
    /// KD = SCREENWIDTH = 320 and KS = 1.
    fn match_blit_loop(&self, pos: usize, end_pos: usize) -> Option<Blit> {
        use wasmparser::Operator as Op;
        if pos + 20 != end_pos {
            return None;
        }
        if std::env::var("BLIT_DEBUG").is_ok() {
            eprintln!("blit candidate at {pos}: {:?}", &self.ops[pos..end_pos]);
        }
        let ops = &self.ops[pos..end_pos];
        let c = match (&ops[0], &ops[1], &ops[2]) {
            (Op::LocalGet { local_index: c }, Op::I32Eqz, Op::BrIf { relative_depth: 1 }) => *c,
            _ => return None,
        };
        let (d, s, width) = match (&ops[3], &ops[4], &ops[5], &ops[6]) {
            (
                Op::LocalGet { local_index: d },
                Op::LocalGet { local_index: s },
                Op::I32Load8U { memarg: la },
                Op::I32Store8 { memarg: sa },
            ) if la.offset == 0 && sa.offset == 0 => (*d, *s, 8u8),
            (
                Op::LocalGet { local_index: d },
                Op::LocalGet { local_index: s },
                Op::I32Load16U { memarg: la },
                Op::I32Store16 { memarg: sa },
            ) if la.offset == 0 && sa.offset == 0 => (*d, *s, 16u8),
            _ => return None,
        };
        if d == s || d == c || s == c {
            return None;
        }
        if !matches!(&ops[19], Op::Br { relative_depth: 0 }) {
            return None;
        }
        // the three affine updates (d, s, c) appear in any order; strides are
        // either constants or loop-invariant locals (invariant because the
        // loop's only LocalSets are d/s/c themselves, checked here)
        let mut ds = None;
        let mut ss = None;
        let mut up = None;
        for t in 0..3 {
            let b = 7 + 4 * t;
            let (x, stride) = match (&ops[b], &ops[b + 1], &ops[b + 2], &ops[b + 3]) {
                (
                    Op::LocalGet { local_index: x },
                    Op::I32Const { value: k },
                    Op::I32Add,
                    Op::LocalSet { local_index: x2 },
                ) if x2 == x => (*x, Stride::Const(*k)),
                (
                    Op::LocalGet { local_index: x },
                    Op::LocalGet { local_index: l },
                    Op::I32Add,
                    Op::LocalSet { local_index: x2 },
                ) if x2 == x => (*x, Stride::Local(*l)),
                _ => return None,
            };
            if let Stride::Local(l) = stride {
                if l == d || l == s || l == c {
                    return None;
                }
            }
            if x == c {
                up = match stride {
                    Stride::Const(-1) => Some(false),
                    Stride::Const(1) => Some(true),
                    _ => return None,
                };
            } else if x == d {
                ds = Some(stride);
            } else if x == s {
                ss = Some(stride);
            } else {
                return None;
            }
        }
        match (ds, ss, up) {
            (Some(ds), Some(ss), Some(up)) => Some(Blit { d, s, c, width, ds, ss, up }),
            _ => None,
        }
    }

    /// Recognise the texture-mapping loops (see `Tex`): R_DrawColumn,
    /// R_DrawSpan and their low-detail twins. Anything off-shape falls back to
    /// the interpreted loop.
    fn match_tex_loop(&self, pos: usize, end_pos: usize) -> Option<Tex> {
        use wasmparser::Operator as Op;
        let ops = &self.ops[pos..end_pos];
        if ops.len() < 28 || ops.len() > 60 {
            return None;
        }
        if std::env::var("TEX_DEBUG").is_ok() {
            eprintln!("tex candidate at {pos}: {:?}", ops);
        }
        let mut i = 0usize;
        let at = |i: usize| ops.get(i);
        let d = match at(i)? {
            Op::LocalGet { local_index } => *local_index,
            _ => return None,
        };
        i += 1;
        let global_load = |i: usize| -> Option<u64> {
            match (at(i)?, at(i + 1)?) {
                (Op::I32Const { value: 0 }, Op::I32Load { memarg }) => Some(memarg.offset),
                _ => None,
            }
        };
        let cm = global_load(i)?;
        let src = global_load(i + 2)?;
        i += 4;
        // `(local >> s) & m`
        let term = |i: usize| -> Option<(u32, u32, u32, u32)> {
            match (at(i)?, at(i + 1)?, at(i + 2)?, at(i + 3)?, at(i + 4)?) {
                (
                    Op::LocalGet { local_index },
                    Op::I32Const { value: s },
                    Op::I32ShrU,
                    Op::I32Const { value: m },
                    Op::I32And,
                ) => {
                    let s = *s as u32;
                    let m = *m as u32;
                    if m == 0 || s >= 32 {
                        return None;
                    }
                    let lo = m.trailing_zeros();
                    let run = m >> lo;
                    if run & (run + 1) != 0 {
                        return None; // not one contiguous run of bits
                    }
                    let width = 32 - run.leading_zeros();
                    if lo + s + width > 32 {
                        return None;
                    }
                    Some((*local_index, s, lo, width))
                }
                _ => None,
            }
        };
        // index: `A add`, `A add B add`, or `A B or tee IDX add`
        let a_t = term(i)?;
        i += 5;
        let mut b_t = None;
        let mut idx_local = None;
        match at(i)? {
            Op::I32Add => {
                i += 1;
                if let Some(t) = term(i) {
                    if matches!(at(i + 5), Some(Op::I32Add)) {
                        b_t = Some(t);
                        i += 6;
                    }
                }
            }
            _ => {
                let t = term(i)?;
                i += 5;
                match (at(i)?, at(i + 1)?, at(i + 2)?) {
                    (Op::I32Or, Op::LocalTee { local_index }, Op::I32Add) => {
                        b_t = Some(t);
                        idx_local = Some(*local_index);
                        i += 3;
                    }
                    _ => return None,
                }
            }
        }
        if let Some((_, _, b_lo, b_w)) = b_t {
            // disjoint result bits, so `+`/`|` are the same splice
            let (_, _, a_lo, a_w) = a_t;
            if a_lo < b_lo + b_w && b_lo < a_lo + a_w {
                return None;
            }
        }
        // the pixel: m8[m32[CM] + m8[m32[SRC] + idx]] stored to d
        let byte0 = |i: usize| -> Option<()> {
            match (at(i)?, at(i + 1)?, at(i + 2)?) {
                (Op::I32Load8U { memarg: l1 }, Op::I32Add, Op::I32Load8U { memarg: l2 })
                    if l1.offset == 0 && l2.offset == 0 =>
                {
                    Some(())
                }
                _ => None,
            }
        };
        byte0(i)?;
        i += 3;
        let store8 = |i: usize| -> Option<()> {
            match at(i)? {
                Op::I32Store8 { memarg } if memarg.offset == 0 => Some(()),
                _ => None,
            }
        };
        let mut pair = TexPair::None;
        let mut d2 = None;
        match at(i)? {
            Op::I32Store8 { .. } => {
                store8(i)?;
                i += 1;
                // R_DrawSpanLow: d+1 gets the same texel, recomputed through IDX
                if let (Some(Op::LocalGet { local_index: dd }), Some(Op::I32Const { value: k }), Some(Op::I32Add)) =
                    (at(i), at(i + 1), at(i + 2))
                {
                    if *dd == d && idx_local.is_some() {
                        let j = i + 3;
                        if global_load(j) == Some(cm) && global_load(j + 2) == Some(src) {
                            match (at(j + 4)?, at(j + 5)?) {
                                (Op::LocalGet { local_index: x }, Op::I32Add) if Some(*x) == idx_local => {}
                                _ => return None,
                            }
                            byte0(j + 6)?;
                            store8(j + 9)?;
                            pair = TexPair::Offset(*k);
                            i = j + 10;
                        }
                    }
                }
            }
            Op::LocalTee { local_index: v } => {
                // R_DrawColumnLow: the texel is stored through d and d2
                let v = *v;
                store8(i + 1)?;
                match (at(i + 2)?, at(i + 3)?) {
                    (Op::LocalGet { local_index: dd2 }, Op::LocalGet { local_index: vv }) if *vv == v && *dd2 != d => {
                        d2 = Some(*dd2);
                    }
                    _ => return None,
                }
                store8(i + 4)?;
                i += 5;
            }
            _ => return None,
        }
        // affine updates in any order, then the counter
        let mut kd = None;
        let mut kd2 = None;
        let mut a_step = None;
        let mut b_step = None;
        let n_updates = 2 + b_t.is_some() as usize + d2.is_some() as usize;
        if std::env::var("TEX_DEBUG").is_ok() {
            eprintln!("tex: pixel parsed, updates start at {i}, n_updates {n_updates}, pair {pair:?}, d2 {d2:?}");
        }
        for _ in 0..n_updates {
            let (x, step, len) = match (at(i)?, at(i + 1)?, at(i + 2)?, at(i + 3)?) {
                (
                    Op::LocalGet { local_index: x },
                    Op::I32Const { value: k },
                    Op::I32Add,
                    Op::LocalSet { local_index: x2 },
                ) if x2 == x => (*x, Err(*k), 4),
                (
                    Op::LocalGet { local_index: x },
                    Op::LocalGet { local_index: l },
                    Op::I32Add,
                    Op::LocalSet { local_index: x2 },
                ) if x2 == x => (*x, Ok(TexStep::Local(*l)), 4),
                (Op::I32Const { value: 0 }, Op::I32Load { memarg }, Op::LocalGet { local_index: x }, Op::I32Add) => {
                    match at(i + 4)? {
                        Op::LocalSet { local_index: x2 } if x2 == x => (*x, Ok(TexStep::Mem(memarg.offset)), 5),
                        _ => return None,
                    }
                }
                _ => return None,
            };
            i += len;
            if x == d {
                kd = Some(step.err()?);
            } else if Some(x) == d2 {
                kd2 = Some(step.err()?);
            } else if x == a_t.0 {
                a_step = Some(step.ok()?);
            } else if b_t.map(|t| t.0) == Some(x) {
                b_step = Some(step.ok()?);
            } else {
                return None;
            }
        }
        let c = match (at(i)?, at(i + 1)?, at(i + 2)?, at(i + 3)?, at(i + 4)?) {
            (
                Op::LocalGet { local_index: c },
                Op::I32Const { value: 1 },
                Op::I32Add,
                Op::LocalTee { local_index: c2 },
                Op::BrIf { relative_depth: 0 },
            ) if c == c2 => *c,
            _ => return None,
        };
        if i + 5 != ops.len() {
            return None;
        }
        if let Some(dd2) = d2 {
            pair = TexPair::Local(dd2, kd2?);
        }
        // the texel/index temporaries are not written back: refuse if the rest
        // of the function reads them at all (conservative: no flow analysis)
        let mut temps = vec![];
        temps.extend(idx_local);
        if let Some(Op::LocalTee { local_index: v }) = ops.iter().find(|o| matches!(o, Op::LocalTee { local_index } if Some(*local_index) != idx_local && *local_index != c)) {
            temps.push(*v);
        }
        for op in &self.ops[end_pos + 1..] {
            if let Op::LocalGet { local_index } | Op::LocalTee { local_index } = op {
                if temps.contains(local_index) {
                    return None;
                }
            }
        }
        // the loop's only writes are d, d2, a, b, c (and the texel/index
        // temporaries, dead after the loop): any local step is invariant
        let mut written = vec![d, a_t.0, c];
        written.extend(d2);
        written.extend(b_t.map(|t| t.0));
        for s in [Some(a_step?), b_step].into_iter().flatten() {
            if let TexStep::Local(l) = s {
                if written.contains(&l) || Some(l) == idx_local {
                    return None;
                }
            }
        }
        let mut uniq = written.clone();
        uniq.sort_unstable();
        uniq.dedup();
        if uniq.len() != written.len() {
            return None;
        }
        let a = TexTerm { local: a_t.0, shift: a_t.1, lo: a_t.2, width: a_t.3, step: a_step? };
        let b = match b_t {
            Some((l, sft, lo, w)) => Some(TexTerm { local: l, shift: sft, lo, width: w, step: b_step? }),
            None => None,
        };
        Some(Tex { d, kd: kd?, c, cm, src, a, b, pair })
    }

    /// Recognise FixedDiv2's loop (see `FDiv`): the exact 54-op body, with the
    /// bit counter set to 31 at function entry and never written before the loop.
    fn match_fdiv_loop(&self, pos: usize, end_pos: usize) -> Option<FDiv> {
        use wasmparser::Operator as Op;
        let ops = &self.ops[pos..end_pos];
        if ops.len() != 54 {
            return None;
        }
        if std::env::var("FDIV_DEBUG").is_ok() {
            eprintln!("fdiv candidate at {pos}: {:?}", ops);
        }
        let lg = |i: usize| match &ops[i] {
            Op::LocalGet { local_index } => Some(*local_index),
            _ => None,
        };
        // exit test: i > -1 else return select(0 - q, q, (y ^ x) < 0)
        if !matches!(&ops[0], Op::Block { .. }) {
            return None;
        }
        let i_local = lg(1)?;
        if !matches!(
            (&ops[2], &ops[3], &ops[4], &ops[5]),
            (Op::I32Const { value: -1 }, Op::I32GtS, Op::BrIf { relative_depth: 0 }, Op::I32Const { value: 0 })
        ) {
            return None;
        }
        let q = lg(6)?;
        if !matches!(&ops[7], Op::I32Sub) || lg(8)? != q {
            return None;
        }
        let y = lg(9)?;
        let x = lg(10)?;
        if !matches!(
            (&ops[11], &ops[12], &ops[13], &ops[14], &ops[15], &ops[16]),
            (Op::I32Xor, Op::I32Const { value: 0 }, Op::I32LtS, Op::Select, Op::Return, Op::End)
        ) {
            return None;
        }
        // rem = (rem << 1) | ((lo >> i) & 1)
        let rem = lg(17)?;
        if !matches!((&ops[18], &ops[19]), (Op::I32Const { value: 1 }, Op::I32Shl)) {
            return None;
        }
        let lo = lg(20)?;
        if lg(21)? != i_local
            || !matches!(
                (&ops[22], &ops[23], &ops[24], &ops[25]),
                (Op::I32ShrU, Op::I32Const { value: 1 }, Op::I32And, Op::I32Or)
            )
        {
            return None;
        }
        let t = match &ops[26] {
            Op::LocalTee { local_index } => *local_index,
            _ => return None,
        };
        // rem -= select(0, b, rem > -1 && rem <u b); q |= select(0, 1 << i, keep)
        if !matches!(&ops[27], Op::I32Const { value: 0 }) {
            return None;
        }
        let b = lg(28)?;
        if lg(29)? != rem
            || !matches!((&ops[30], &ops[31]), (Op::I32Const { value: -1 }, Op::I32GtS))
            || lg(32)? != t
            || lg(33)? != b
            || !matches!((&ops[34], &ops[35]), (Op::I32LtU, Op::I32And))
            || !matches!(&ops[36], Op::LocalTee { local_index } if *local_index == t)
            || !matches!((&ops[37], &ops[38]), (Op::Select, Op::I32Sub))
            || !matches!(&ops[39], Op::LocalSet { local_index } if *local_index == rem)
            || !matches!((&ops[40], &ops[41]), (Op::I32Const { value: 0 }, Op::I32Const { value: 1 }))
            || lg(42)? != i_local
            || !matches!(&ops[43], Op::I32Shl)
            || lg(44)? != t
            || !matches!(&ops[45], Op::Select)
            || lg(46)? != q
            || !matches!(&ops[47], Op::I32Or)
            || !matches!(&ops[48], Op::LocalSet { local_index } if *local_index == q)
            || lg(49)? != i_local
            || !matches!((&ops[50], &ops[51]), (Op::I32Const { value: -1 }, Op::I32Add))
        {
            return None;
        }
        match (&ops[52], &ops[53]) {
            (Op::LocalSet { local_index }, Op::Br { relative_depth: 0 }) if *local_index == i_local => {}
            _ => return None,
        }
        // the counter starts at 31 and nothing before the loop rewrites it
        if !matches!((&self.ops[0], &self.ops[1]), (Op::I32Const { value: 31 }, Op::LocalSet { local_index }) if *local_index == i_local) {
            return None;
        }
        for op in &self.ops[2..pos] {
            if matches!(op, Op::LocalSet { local_index } | Op::LocalTee { local_index } if *local_index == i_local) {
                return None;
            }
        }
        let all = [x, y, rem, lo, b, q, t, i_local];
        let mut uniq = all.to_vec();
        uniq.sort_unstable();
        uniq.dedup();
        if uniq.len() != all.len() {
            return None;
        }
        Some(FDiv { x, y, rem, lo, b, q })
    }

    /// The loop's only exit is its `return`, so the fused form is a return:
    /// quotient from `$FDivQ`, negated when the operands' signs differ.
    fn emit_fdiv(&mut self, env: &mut BlockEnv, f: FDiv) -> Result<Step, String> {
        let helper = env.fdiv_helper();
        let rem = env.local(f.rem)?;
        let lo = env.local(f.lo)?;
        let b = env.local(f.b)?;
        let x = env.local(f.x)?;
        let y = env.local(f.y)?;
        let q = env.bind_always(&format!("{helper}<{rem}, {lo}, {b}>"), "WasmValue");
        let neg = env.bind_always(&format!("Wasm.I32Sub<'{}', {q}>", zero()), "WasmValue");
        let sign = env.bind_always(&format!("Wasm.I32LtS<Wasm.I32Xor<{y}, {x}>, '{}'>", zero()), "WasmValue");
        let value = format!("({sign} extends '{}' ? {q} : {neg})", zero());
        let value = env.bind(&value, "WasmValue");
        env.push(value);
        let _ = f.q;
        let text = self.emit_return(env)?;
        Ok(Step::Terminate(text))
    }

    /// `memcpy(d, s, n)` / `memset(d, c, n)` as one fused walk, plus the toll
    /// jump that charges a unit per byte. `memmove` only differs when the
    /// regions overlap forwards, which doom's callers do not do.
    fn emit_libc_move(
        &mut self,
        env: &mut BlockEnv,
        labels: &[Label],
        pos: usize,
        args: &[String],
        is_fill: bool,
    ) -> Result<Step, String> {
        let d = args[0].clone();
        let sv = args[1].clone();
        let n = args[2].clone();
        let next = if is_fill {
            let helper = env.fill_helper();
            format!("{helper}<{}, {d}, {sv}, {n}>", env.memory)
        } else {
            let helper = env.blit_helper(8);
            let one = format!("'{}'", bits32(1));
            format!("{helper}<{}, {d}, {sv}, {n}, {one}, {one}>", env.memory)
        };
        let name = format!("$m{}", env.next_temp);
        env.next_temp += 1;
        env.bindings.push((name.clone(), "$Node".to_string(), next));
        env.memory = name;
        env.mem_ops += 2;
        env.computed.retain(|expr, _| !expr.contains("$m"));
        // both return the destination
        env.push(d);
        let after = self.fresh_id();
        let floor = env.stack.len();
        self.push_join(after, pos, labels, floor, 0)?;
        let burn = env.burn_helper();
        let call = self.call_block(after, env, floor, 0);
        let call = call.replacen("$F,", &format!("{burn}<$F, {n}>,"), 1);
        Ok(Step::Terminate(call))
    }

    /// Recognise the forward three-word record search (see `Find`): doom's
    /// R_FindPlane walks the visplane array comparing height, picnum and
    /// lightlevel. 19% of an E1M1 frame by where chunks land.
    fn match_find_loop(&self, pos: usize, end_pos: usize) -> Option<Find> {
        use wasmparser::Operator as Op;
        let ops = &self.ops[pos..end_pos];
        if ops.len() != 30 {
            return None;
        }
        let lg = |i: usize| match &ops[i] {
            Op::LocalGet { local_index } => Some(*local_index),
            _ => None,
        };
        // p >= end -> leave the loop
        let p = lg(0)?;
        let end = lg(1)?;
        if !matches!((&ops[2], &ops[3], &ops[4]), (Op::I32GeU, Op::BrIf { relative_depth: 1 }, Op::Block { .. })) {
            return None;
        }
        // three compares against the record at p, the last one on equality
        let a = lg(5)?;
        if lg(6)? != p
            || !matches!(&ops[7], Op::I32Load { memarg } if memarg.offset == 0)
            || !matches!((&ops[8], &ops[9]), (Op::I32Ne, Op::BrIf { relative_depth: 0 }))
        {
            return None;
        }
        let b = lg(10)?;
        if lg(11)? != p {
            return None;
        }
        let off_b = match &ops[12] {
            Op::I32Const { value } => *value,
            _ => return None,
        };
        if !matches!(&ops[13], Op::I32Add)
            || !matches!(&ops[14], Op::I32Load { memarg } if memarg.offset == 0)
            || !matches!((&ops[15], &ops[16]), (Op::I32Ne, Op::BrIf { relative_depth: 0 }))
        {
            return None;
        }
        let c = lg(17)?;
        if lg(18)? != p {
            return None;
        }
        let off_c = match &ops[19] {
            Op::I32Const { value } => *value,
            _ => return None,
        };
        if !matches!(&ops[20], Op::I32Add)
            || !matches!(&ops[21], Op::I32Load { memarg } if memarg.offset == 0)
            || !matches!((&ops[22], &ops[23], &ops[24]), (Op::I32Eq, Op::BrIf { relative_depth: 3 }, Op::End))
        {
            return None;
        }
        // p += stride
        if lg(25)? != p {
            return None;
        }
        let stride = match &ops[26] {
            Op::I32Const { value } => *value,
            _ => return None,
        };
        if !matches!(&ops[27], Op::I32Add)
            || !matches!(&ops[28], Op::LocalSet { local_index } if *local_index == p)
            || !matches!(&ops[29], Op::Br { relative_depth: 0 })
        {
            return None;
        }
        if stride <= 0 {
            return None;
        }
        let mut written = vec![p, end, a, b, c];
        written.sort_unstable();
        written.dedup();
        if written.len() != 5 {
            return None;
        }
        Some(Find { p, end, a, b, c, off_b, off_c, stride })
    }

    /// Enter the loop with `p` already on the record the walk would stop at:
    /// the match, or the first address past the end. The interpreted iteration
    /// that follows then takes the loop's own exit branch, as `emit_scan` does.
    fn emit_find(&mut self, env: &mut BlockEnv, f: Find) -> Result<(), String> {
        let helper = env.find_helper(f.off_b, f.off_c, f.stride);
        let p = env.local(f.p)?;
        let end = env.local(f.end)?;
        let a = env.local(f.a)?;
        let b = env.local(f.b)?;
        let c = env.local(f.c)?;
        let next = format!("{helper}<{}, {p}, {end}, {a}, {b}, {c}>", env.memory);
        let named = env.bind_always(&next, "WasmValue");
        // flat premium for the whole walk, as $Blit and $Scan charge
        env.stores += 8;
        env.set_local(f.p, named)?;
        Ok(())
    }

    /// Emit the fused texture loop: colormap/source pointers and memory-
    /// resident steps read once, one memory binding, affine write-back.
    /// Bounds guards are skipped as for `emit_blit`.
    fn emit_tex(&mut self, env: &mut BlockEnv, t: Tex) -> Result<String, String> {
        let helper = env.tex_helper(&t);
        let dv = env.local(t.d)?;
        let cv = env.local(t.c)?;
        let av = env.local(t.a.local)?;
        let bv = match t.b {
            Some(b) => env.local(b.local)?,
            None => format!("'{}'", zero()),
        };
        let mem = env.memory.clone();
        let read32 = |env: &mut BlockEnv, addr: u64| -> String {
            let expr = format!("$Load32<{mem}, '{}'>", bits32(addr as i32));
            env.bind_always(&expr, "WasmValue")
        };
        let cm = read32(env, t.cm);
        let src = read32(env, t.src);
        let step_of = |env: &mut BlockEnv, s: TexStep| -> Result<String, String> {
            match s {
                TexStep::Local(l) => env.local(l),
                TexStep::Mem(off) => Ok(read32(env, off)),
            }
        };
        let da = step_of(env, t.a.step)?;
        let db = match t.b {
            Some(b) => step_of(env, b.step)?,
            None => format!("'{}'", zero()),
        };
        // the counter steps +1 from a negative start and exits at zero
        let trips = env.bind_always(&format!("Wasm.I32Sub<'{}', {cv}>", zero()), "WasmValue");
        let kd = format!("'{}'", bits32(t.kd));
        let (d2v, kd2) = match t.pair {
            TexPair::Local(l, k) => (env.local(l)?, format!("'{}'", bits32(k))),
            TexPair::Offset(k) => (format!("'{}'", bits32(k)), format!("'{}'", zero())),
            TexPair::None => (format!("'{}'", zero()), format!("'{}'", zero())),
        };
        let next = format!("{helper}<{}, {dv}, {kd}, {cm}, {src}, {av}, {da}, {bv}, {db}, {trips}, {d2v}, {kd2}>", env.memory);
        let name = format!("$m{}", env.next_temp);
        env.next_temp += 1;
        env.bindings.push((name.clone(), "$Node".to_string(), next));
        env.memory = name;
        env.mem_ops += 4;
        env.stores += 12;
        env.computed.retain(|expr, _| !expr.contains("$m"));
        env.set_local(t.d, format!("Wasm.I32Add<{dv}, Wasm.I32Mul<{trips}, {kd}>>"))?;
        env.set_local(t.a.local, format!("Wasm.I32Add<{av}, Wasm.I32Mul<{trips}, {da}>>"))?;
        if let Some(b) = t.b {
            env.set_local(b.local, format!("Wasm.I32Add<{bv}, Wasm.I32Mul<{trips}, {db}>>"))?;
        }
        if let TexPair::Local(l, _) = t.pair {
            env.set_local(l, format!("Wasm.I32Add<{d2v}, Wasm.I32Mul<{trips}, {kd2}>>"))?;
        }
        env.set_local(t.c, format!("'{}'", zero()))?;
        // fuel: one unit per pixel written, charged by the caller's toll jump.
        // A flat charge is what let a 96-pixel span slip into a chunk already
        // near the checker's instantiation limit (measured: "too deep" three
        // times on one chunk, fuel search backed off 27440 -> 1960).
        Ok(match t.pair {
            TexPair::None => trips,
            _ => format!("Wasm.I32Add<{trips}, {trips}>"),
        })
    }

    /// Emit the fused loop: one memory binding, affine local write-back, and
    /// execution continues after `end` in the same block.
    ///
    /// Bounds guards are skipped: the fused loop only exists for modules whose
    /// original per-byte loop was in bounds, and a wild count would fail loudly
    /// (checker depth), not silently.
    fn emit_blit(&mut self, env: &mut BlockEnv, b: Blit) -> Result<String, String> {
        let helper = env.blit_helper(b.width);
        let dv = env.local(b.d)?;
        let sv = env.local(b.s)?;
        let cv = env.local(b.c)?;
        // a count that steps +1 starts negative and exits at zero: the trip
        // count is its negation, and the exit value is still zero
        let trips = if b.up {
            format!("Wasm.I32Sub<'{}', {cv}>", zero())
        } else {
            cv.clone()
        };
        let ds = match b.ds {
            Stride::Const(k) => format!("'{}'", bits32(k)),
            Stride::Local(l) => env.local(l)?,
        };
        let ss = match b.ss {
            Stride::Const(k) => format!("'{}'", bits32(k)),
            Stride::Local(l) => env.local(l)?,
        };
        let next = format!("{helper}<{}, {dv}, {sv}, {trips}, {ds}, {ss}>", env.memory);
        // mirror `store`: every new memory is named, and the name is what
        // render_pipeline keys on to put it back in slot 0
        let name = format!("$m{}", env.next_temp);
        env.next_temp += 1;
        env.bindings.push((name.clone(), "$Node".to_string(), next));
        env.memory = name;
        env.mem_ops += 2;
        env.computed.retain(|expr, _| !expr.contains("$m"));
        // the loop exits with count = 0 and both pointers advanced trips strides
        env.set_local(
            b.d,
            format!("Wasm.I32Add<{dv}, Wasm.I32Mul<{trips}, {ds}>>"),
        )?;
        let adv_s = if matches!(b.ss, Stride::Const(1)) {
            trips.clone()
        } else {
            format!("Wasm.I32Mul<{trips}, {ss}>")
        };
        env.set_local(b.s, format!("Wasm.I32Add<{sv}, {adv_s}>"))?;
        env.set_local(b.c, format!("'{}'", zero()))?;
        // fuel: one unit per byte, taken off by the caller's toll jump. The
        // flat premium this used to charge let a title-screen chunk hold
        // 30k pixel stores at fuel 1265: 30-55s a chunk, "too deep" above,
        // and the fuel search pinned at ~1000 for the whole page draw.
        Ok(trips)
    }

    /// Recognize the canonical WAD lump scan (see `Scan`). The shape is the
    /// exact 33-op body emcc emits for W_CheckNumForName's loop; anything
    /// else falls back to the interpreted loop.
    fn match_scan_loop(&self, pos: usize, end_pos: usize) -> Option<Scan> {
        use wasmparser::Operator as Op;
        if pos + 33 != end_pos {
            return None;
        }
        let ops = &self.ops[pos..end_pos];
        if std::env::var("SCAN_DEBUG").is_ok() {
            eprintln!("scan candidate at {pos}: {ops:?}");
        }
        // exit check: block; local.get i; br_if 0; -1; local.set i; br 2; end
        let i = match (&ops[0], &ops[1], &ops[2], &ops[3], &ops[4], &ops[5], &ops[6]) {
            (
                Op::Block { .. },
                Op::LocalGet { local_index: i },
                Op::BrIf { relative_depth: 0 },
                Op::I32Const { value: -1 },
                Op::LocalSet { local_index: i2 },
                Op::Br { relative_depth: 2 },
                Op::End,
            ) if i2 == i => *i,
            _ => return None,
        };
        // first word: block; block; b+i; tee t; -20; load; != hi -> br_if 0
        #[allow(clippy::type_complexity)]
        let (base, t, hi) = match (
            &ops[7], &ops[8], &ops[9], &ops[10], &ops[11], &ops[12], &ops[13], &ops[14],
            &ops[15], &ops[16], &ops[17], &ops[18],
        ) {
            (
                Op::Block { .. },
                Op::Block { .. },
                Op::LocalGet { local_index: base },
                Op::LocalGet { local_index: i2 },
                Op::I32Add,
                Op::LocalTee { local_index: t },
                Op::I32Const { value: -20 },
                Op::I32Add,
                Op::I32Load { memarg },
                Op::LocalGet { local_index: hi },
                Op::I32Ne,
                Op::BrIf { relative_depth: 0 },
            ) if *i2 == i && memarg.offset == 0 => (*base, *t, *hi),
            _ => return None,
        };
        // second word: t; -16; load; == lo -> br_if 1 (match exit); end
        let lo = match (
            &ops[19], &ops[20], &ops[21], &ops[22], &ops[23], &ops[24], &ops[25], &ops[26],
        ) {
            (
                Op::LocalGet { local_index: t2 },
                Op::I32Const { value: -16 },
                Op::I32Add,
                Op::I32Load { memarg },
                Op::LocalGet { local_index: lo },
                Op::I32Eq,
                Op::BrIf { relative_depth: 1 },
                Op::End,
            ) if *t2 == t && memarg.offset == 0 => *lo,
            _ => return None,
        };
        // decrement: i; -20; add; local.set i; br 1 (continue); end
        match (&ops[27], &ops[28], &ops[29], &ops[30], &ops[31], &ops[32]) {
            (
                Op::LocalGet { local_index: i2 },
                Op::I32Const { value: -20 },
                Op::I32Add,
                Op::LocalSet { local_index: i3 },
                Op::Br { relative_depth: 1 },
                Op::End,
            ) if *i2 == i && *i3 == i => {}
            _ => return None,
        }
        if i == base || i == hi || i == lo || base == hi || base == lo {
            return None;
        }
        Some(Scan { i, base, hi, lo })
    }

    /// Emit the fused scan at loop entry and fall through to the normal loop
    /// compilation: `i` lands on the match offset (or 0), so the single
    /// interpreted iteration that follows takes the loop's real exit branch.
    /// One fused application replaces ~15 interpreted instructions per record.
    fn emit_scan(&mut self, env: &mut BlockEnv, s: Scan) -> Result<(), String> {
        let helper = env.scan_helper();
        let iv = env.local(s.i)?;
        let bv = env.local(s.base)?;
        let hiv = env.local(s.hi)?;
        let lov = env.local(s.lo)?;
        let n = format!("Wasm.I32DivU<{iv}, '{}'>", bits32(20));
        let n = env.bind(&n, "WasmValue");
        let next = format!("{helper}<{}, {bv}, {iv}, {hiv}, {lov}, {n}>", env.memory);
        let named = env.bind(&next, "WasmValue");
        // flat fuel premium for the whole scan, mirroring $Blit's accounting
        env.stores += 8;
        env.set_local(s.i, named)?;
        Ok(())
    }

    fn compile_block(&mut self, pending: Pending) -> Result<EmittedBlock, String> {
        let mut env = BlockEnv {
            helpers: Rc::clone(&self.module.helpers),
            indirect: Rc::clone(&self.module.indirect),
            memory: "$M".to_string(),
            globals: (0..self.module.globals.len())
                .map(|i| format!("$g{i}"))
                .collect(),
            locals: (0..self.num_locals).map(|i| format!("$l{i}")).collect(),
            stack: pending.stack.clone(),
            bindings: Vec::new(),
            has_pattern: false,
            mem_ops: 0,
            reads: BTreeSet::new(),
            writes: BTreeSet::new(),
            computed: HashMap::new(),
            shallow: HashSet::new(),
            next_temp: 0,
            stores: 0,
            // When the end of memory is fixed at compile time, most addresses
            // are a literal or a literal plus a static offset, so the check
            // folds away in `address` and nothing is emitted at all.
            mem_limit: self.module.fixed_mem_limit(),
            pages_global: match self.module.fixed_mem_limit() {
                Some(_) => None,
                None => Some(self.module.pages_global),
            },
        };
        let mut labels = pending.labels.clone();
        let mut pos = pending.pos;
        let terminator;

        loop {
            if pos >= self.ops.len() {
                terminator = self.emit_return(&mut env)?;
                break;
            }
            // cut the chain before it reaches the depth where the checker
            // falls off a cliff, handing the rest to a fresh block
            // A block that touches memory stays short: inside a block the
            // memory is an unevaluated `$Store32<$Store32<...>>` chain that
            // every later load walks, and that cost is not linear. A run of
            // pure arithmetic has no such chain, so it is allowed to grow and
            // is rendered as a pipeline instead of nested `infer`s.
            let cap = if env.has_pattern || env.mem_ops > 0 {
                depth_cap()
            } else {
                pipeline_cap()
            };
            if env.bindings.len() >= cap {
                let continuation = self.fresh_id();
                let stack_params: Vec<String> =
                    (0..env.stack.len()).map(|i| format!("$k{i}")).collect();
                let arity = env.stack.len();
                self.pending.push(Pending {
                    id: continuation,
                    pos,
                    labels: labels.clone(),
                    stack: stack_params,
                });
                terminator = self.call_block(continuation, &env, 0, arity);
                break;
            }
            let op = &self.ops[pos];
            pos += 1;
            match self.step(op, pos, &mut env, &mut labels)? {
                Step::Continue => {}
                Step::Jump(next_pos) => {
                    pos = next_pos;
                }
                Step::Terminate(text) => {
                    terminator = text;
                    break;
                }
            }
        }

        // a hop plus this block's own stores: both consume the checker's depth
        // budget, so both have to be paid for out of the same fuel
        let cost = 1 + env.stores;
        Ok(EmittedBlock {
            id: pending.id,
            stack_arity: pending.stack.len(),
            // rendered after liveness: the state layout depends on which locals
            // survive, and the step aliases index into it by position
            body: String::new(),
            cost,
            reads: env.reads.clone(),
            writes: env.writes.clone(),
            successors: std::mem::take(&mut self.successors),
            live: BTreeSet::new(),
            bindings: env.bindings.clone(),
            terminator,
            stack: pending.stack.clone(),
            has_pattern: env.has_pattern,
        })
    }

    /// Wrap the block's terminator in its bindings, fuel check and parameters.
    /// The parameters every block declares, before its own stack slots.
    fn block_params(&self, block: &EmittedBlock) -> Vec<String> {
        let mut params = vec![
            "$F extends string".to_string(),
            "$K extends unknown[]".to_string(),
            "$M extends $Node".to_string(),
        ];
        for i in 0..self.module.globals.len() {
            params.push(format!("$g{i} extends WasmValue"));
        }
        params.push(format!("\u{1}P{}\u{1}", block.id));
        for name in &block.stack {
            params.push(format!("{name} extends WasmValue"));
        }
        params
    }

    /// Wrap a block's work in its fuel check, or emit it bare when the function
    /// is only ever called from another one and runs to completion.
    fn wrap_block(&self, block: &EmittedBlock, inner: &str) -> String {
        let params = self.block_params(block);
        // Out of fuel: hand back the frames to resume, then the flushed memory
        // and the globals. This block's own frame goes on the front of the ones
        // it was called through, so the host gets the whole call stack innermost
        // first and can walk back out of it. Memory and globals live outside the
        // frames because there is only ever one of each: an inner frame returns
        // them to the frame below it. The suspend keeps the raw overlay so
        // `$Resume` can re-enter it with the base intact; `$Exit` flushes it at
        // the host boundary, so a snapshot still round-trips through text.
        let mut frame = vec![
            format!("'{}_{}'", self.func_index, block.id),
            // resumed exactly as it was: nothing to add to its stack
            "'0'".to_string(),
        ];
        frame.push(format!("\u{1}S{}\u{1}", block.id));
        frame.extend(block.stack.iter().cloned());
        let mut alive = vec![format!("[[{}], ...$K]", frame.join(", "))];
        alive.push("$M".to_string());
        for i in 0..self.module.globals.len() {
            alive.push(format!("$g{i}"));
        }
        // The fuel string is segmented: a run of '1's, an 'x', another run. A
        // block whose burn meets the 'x' hands back a bounce - the suspend
        // tuple under a 'b' tag, with the fuel past the mark - and `$Run` at
        // the chunk's top re-enters it from the frames. The checker gives up
        // on a chain of tail conditionals at 1000 iterations (measured: 900
        // hops land, 1200 report TS2589), so before this a chunk was one tail
        // chain and the fuel search sat at ~1000 in any loop-heavy phase (the
        // title page draw: fuel 992, 28 chunks a frame). Re-entering from the
        // top unwinds the nesting too, so the depth a segment leaves behind is
        // nothing: a chunk is as many segments as its fuel holds.
        let burn: String = std::iter::repeat('1').take(block.cost).collect();
        let body = format!(
            "  $F extends `{burn}${{infer $F1}}`\n  ? {}\n  : $F extends `${{string}}x${{infer $Fx}}`\n  ? ['b', $Fx, {}]\n  : ['s', {}]",
            indent(&rename_fuel(inner), 2),
            alive.join(", "),
            alive.join(", ")
        );
        format!(
            "\nexport type {}<{}> =\n{}\n",
            self.block_name(block.id),
            params.join(", "),
            body
        )
    }

    /// One `infer` per instruction, nested. Kept for blocks that destructure a
    /// call result, and for blocks too short to be worth a pipeline.
    fn render_nested(&self, block: &EmittedBlock) -> String {
        let mut inner = String::new();
        for (name, constraint, expr) in &block.bindings {
            // most bindings name one value; a call binds a whole result pattern
            if constraint.is_empty() {
                inner.push_str(&format!("{expr} extends {name}\n  ? "));
            } else {
                inner.push_str(&format!("{expr} extends infer {name} extends {constraint}\n  ? "));
            }
        }
        inner.push_str(&block.terminator);
        for _ in &block.bindings {
            inner.push_str("\n  : never");
        }
        self.wrap_block(block, &inner)
    }

    /// Instructions as a pipeline: each one is an alias that appends its result
    /// to a state tuple, and the block applies them in turn.
    ///
    ///   type $p0_3_0<$S extends unknown[]> = [...$S, Wasm.I32Add<$S[3] & WasmValue, '..'>]
    ///   $p0_3_1<$p0_3_0<[$M, $l0, $s0]>> extends infer $S extends unknown[] ? ...
    ///
    /// Nesting `infer`s costs the checker time exponential in the depth of the
    /// chain - 16 deep is 19ms, 24 is 3.2s, 32 does not finish. Applying aliases
    /// instead is linear: 128 in a row is 17ms. That is the whole reason this
    /// exists, and it is why a block no longer has to be short.
    fn render_pipeline(&self, block: &EmittedBlock, live: &HashMap<usize, Vec<u32>>) -> String {
        // memory lives in slot 0 for the whole block and a store replaces it in
        // place; every other value is appended as it is computed. Because the
        // state is typed `[$Node, ...WasmValue[]]`, a read is just `$S[3]`.
        let mut slots: HashMap<String, usize> = HashMap::new();
        let mut initial: Vec<String> = vec!["$M".to_string()];
        slots.insert("$M".to_string(), 0);
        for i in 0..self.module.globals.len() {
            slots.insert(format!("$g{i}"), initial.len());
            initial.push(format!("$g{i}"));
        }
        let empty = Vec::new();
        for index in live.get(&block.id).unwrap_or(&empty) {
            slots.insert(format!("$l{index}"), initial.len());
            initial.push(format!("$l{index}"));
        }
        for name in &block.stack {
            slots.insert(name.clone(), initial.len());
            initial.push(name.clone());
        }

        let mut steps = String::new();
        let mut applied = format!("[{}]", initial.join(", "));
        let mut width = initial.len();
        for (position, (name, constraint, expr)) in block.bindings.iter().enumerate() {
            let step = format!("$p{}_{}_{}", self.func_index, block.id, position);
            let rewritten = state_reads(expr, &slots);
            let body = if constraint == "$Node" {
                // a store: the new memory takes slot 0, the values are untouched
                slots.insert(name.clone(), 0);
                format!("[{rewritten}, ...$Rest<$S>]")
            } else {
                slots.insert(name.clone(), width);
                width += 1;
                format!("[...$S, {rewritten}]")
            };
            steps.push_str(&format!(
                "\nexport type {step}<$S extends $State> =\n  {body}\n"
            ));
            applied = format!("{step}<{applied}>");
        }

        let terminator = state_reads(&block.terminator, &slots);
        let inner = format!(
            "{applied} extends infer $S extends $State\n  ? {}\n  : never",
            indent(&terminator, 2)
        );
        format!("{steps}{}", self.wrap_block(block, &inner))
    }

    /// Return from the function: memory, then globals if a callee has to hand
    /// them back, then the result.
    fn emit_return(&self, env: &mut BlockEnv) -> Result<String, String> {
        // The fuel left over comes back with the result: a call must not mint
        // fuel, or the work in one evaluation stops being bounded and the
        // checker falls off its cliff somewhere unpredictable.
        // The memory keeps its write buffer: the caller carries straight on
        // with it. Flushing here would materialise the whole buffer into the
        // trie on every return. Only a result the *host* reads has to be
        // flushed, because only that one is printed and pasted back, and $Exit
        // does that at the one place it leaves the types.
        // The frames come back too: a return out of a block `$Run` re-entered
        // has no inline caller, and `$Run` carries on into the frame below.
        let mut parts = vec![
            "'r'".to_string(),
            "$F".to_string(),
            "$K".to_string(),
            env.memory.clone(),
        ];
        // a callee also hands its globals back, so writes to them are not lost
        parts.extend(env.globals.iter().cloned());
        // A void function still returns a slot, so every 'r' has the same shape
        // and the host can find the memory and the globals by counting.
        parts.push(if self.num_results > 0 {
            env.stack
                .last()
                .cloned()
                .unwrap_or_else(|| format!("'{}'", zero()))
        } else {
            format!("'{}'", zero())
        });
        Ok(format!("[{}]", parts.join(", ")))
    }

    /// A call, as a block terminator with somewhere to come back to.
    ///
    /// The rest of the block becomes a block of its own, and its name and live
    /// values become a *frame*. The frame goes on the front of `$K` and travels
    /// into the callee, so if anything inside the callee runs out of fuel - at
    /// any depth - the suspend it hands back already describes the whole stack,
    /// and the host can resume the innermost block and walk back out.
    ///
    /// The ordinary return is matched right here instead, so a call that fits in
    /// the evaluation carries straight on into the continuation and the host
    /// never hears about it. Only a suspend travels up, unchanged.
    fn call_terminator(
        &mut self,
        callee: &str,
        lead: Vec<String>,
        args: Vec<String>,
        num_results: usize,
        pos: usize,
        env: &mut BlockEnv,
        labels: &[Label],
    ) -> String {
        let continuation = self.fresh_id();
        let carried: Vec<String> = env.stack.clone();
        let mut cont_stack: Vec<String> = (0..carried.len()).map(|i| format!("$k{i}")).collect();
        if num_results > 0 {
            cont_stack.push(format!("$k{}", carried.len()));
        }
        self.pending.push(Pending {
            id: continuation,
            pos,
            labels: labels.to_vec(),
            stack: cont_stack,
        });

        // where to come back to, and what has to be there when we do. Memory and
        // globals are not in the frame: there is only one of each, and an inner
        // frame hands them back to the frame below it.
        let mut frame = vec![
            format!("'{}_{}'", self.func_index, continuation),
            // Whether the result belongs on this block's stack when the host
            // returns into it. Every return carries a value slot so the host can
            // find the memory by counting, but a void call must not leave one on
            // the stack - the blocks after it are compiled for a stack without.
            if num_results > 0 { "'1'" } else { "'0'" }.to_string(),
        ];
        frame.push(self.local_site(continuation, env));
        frame.extend(carried.iter().cloned());
        let frames = format!("[[{}], ...$K]", frame.join(", "));

        let mut call_args = lead;
        call_args.push("$F".to_string());
        call_args.push(frames);
        call_args.push(env.memory.clone());
        call_args.extend(env.globals.iter().cloned());
        call_args.extend(args);
        let call = format!("{callee}<{}>", call_args.join(", "));

        // `$Fr` and `$c` rather than `$F1`: a bare `$F` in a metered block is
        // rewritten to the fuel left after this block charges for itself, and a
        // name that collided with that would be silently rebound.
        let result = format!("$c{}", env.next_temp);
        env.next_temp += 1;
        let fuel = format!("$Fr{}", env.next_temp);
        env.next_temp += 1;
        let memory = format!("$m{}", env.next_temp);
        env.next_temp += 1;
        let mut pattern = vec![
            "'r'".to_string(),
            format!("infer {fuel} extends string"),
            // the callee's frames: this site pushed its own on top, so the
            // caller keeps its `$K` and ignores them
            "unknown".to_string(),
            format!("infer {memory} extends $Node"),
        ];
        let globals: Vec<String> = (0..env.globals.len())
            .map(|_| {
                let name = format!("$g_{}", env.next_temp);
                env.next_temp += 1;
                name
            })
            .collect();
        for name in &globals {
            pattern.push(format!("infer {name} extends WasmValue"));
        }
        let name = format!("$t{}", env.next_temp);
        env.next_temp += 1;
        pattern.push(format!("infer {name} extends WasmValue"));
        let value = if num_results > 0 { Some(name) } else { None };

        let mut resume = vec![fuel, "$K".to_string(), memory];
        resume.extend(globals.iter().cloned());
        resume.push(self.local_site(continuation, env));
        resume.extend(carried.iter().cloned());
        if let Some(value) = value {
            resume.push(value);
        }

        // the terminator destructures, so this block is rendered as nested
        // `infer`s rather than a pipeline
        env.has_pattern = true;
        format!(
            "{call} extends infer {result}\n  ? {result} extends [{}]\n    ? {}<{}>\n    : {result}\n  : never",
            pattern.join(", "),
            self.block_name(continuation),
            resume.join(", ")
        )
    }

    /// Tail-call a block, passing the stack it expects: everything below the
    /// label, then the operands it consumes off the top.
    fn call_block(&mut self, id: usize, env: &BlockEnv, floor: usize, arity: usize) -> String {
        let mut args = vec!["$F".to_string(), "$K".to_string(), env.memory.clone()];
        args.extend(env.globals.iter().cloned());
        // which locals this target actually needs is only known once the whole
        // function is compiled, so leave a marker and fill it in later
        args.push(self.local_site(id, env));
        let floor = floor.min(env.stack.len());
        args.extend(env.stack[..floor].iter().cloned());
        let take = arity.min(env.stack.len() - floor);
        args.extend(env.stack[env.stack.len() - take..].iter().cloned());
        format!("{}<{}>", self.block_name(id), args.join(", "))
    }

    /// leading arguments every block takes: fuel (when metered), memory, globals, locals
    fn entry_args(&mut self, id: usize, env: &BlockEnv) -> Vec<String> {
        let mut args = vec!["$F".to_string(), "$K".to_string(), env.memory.clone()];
        args.extend(env.globals.iter().cloned());
        args.push(self.local_site(id, env));
        args
    }

    /// Record a call site's local values and return the placeholder that will
    /// become the subset the target actually reads.
    fn local_site(&mut self, target: usize, env: &BlockEnv) -> String {
        self.sites.push((target, env.locals.clone()));
        self.successors.push(target);
        format!("\u{1}L{}\u{1}", self.sites.len() - 1)
    }

    /// `br depth`
    fn jump(&mut self, labels: &[Label], depth: u32, env: &BlockEnv) -> Result<String, String> {
        let index = labels
            .len()
            .checked_sub(1 + depth as usize)
            .ok_or_else(|| format!("br depth {depth} escapes the function"))?;
        let label = labels
            .get(index)
            .ok_or_else(|| format!("no label at depth {depth}"))?
            .clone();
        if label.target == usize::MAX {
            let mut env2 = env.clone();
            return self.emit_return(&mut env2);
        }
        Ok(self.call_block(label.target, env, label.stack_floor, label.arity))
    }

    /// falling off the innermost label's `end`
    fn jump_exit(&mut self, labels: &[Label], env: &BlockEnv) -> Result<String, String> {
        let label = labels
            .last()
            .ok_or_else(|| "end without a label".to_string())?
            .clone();
        if label.exit == usize::MAX {
            let mut env2 = env.clone();
            return self.emit_return(&mut env2);
        }
        Ok(self.call_block(label.exit, env, label.stack_floor, label.exit_arity))
    }

    fn step(
        &mut self,
        op: &Operator,
        pos: usize,
        env: &mut BlockEnv,
        labels: &mut Vec<Label>,
    ) -> Result<Step, String> {
        use Operator::*;
        match op {
            I32Const { value } => {
                env.push(format!("'{}'", bits32(*value)));
                Ok(Step::Continue)
            }
            LocalGet { local_index } => {
                let value = env.local(*local_index)?;
                env.push(value);
                Ok(Step::Continue)
            }
            LocalSet { local_index } => {
                let value = env.pop();
                env.set_local(*local_index, value)?;
                Ok(Step::Continue)
            }
            LocalTee { local_index } => {
                let value = env.peek();
                env.set_local(*local_index, value)?;
                Ok(Step::Continue)
            }
            GlobalGet { global_index } => {
                let value = env
                    .globals
                    .get(*global_index as usize)
                    .cloned()
                    .ok_or_else(|| format!("global {global_index} out of range"))?;
                env.push(value);
                Ok(Step::Continue)
            }
            GlobalSet { global_index } => {
                let value = env.pop();
                let index = *global_index as usize;
                if index >= env.globals.len() {
                    return Err(format!("global {index} out of range"));
                }
                let bound = env.bind(&value, "WasmValue");
                env.globals[index] = bound;
                Ok(Step::Continue)
            }
            Drop => {
                env.pop();
                Ok(Step::Continue)
            }
            Nop => Ok(Step::Continue),
            Select => {
                let cond = env.pop();
                let else_val = env.pop();
                let then_val = env.pop();
                let chosen = format!("({cond} extends '{z}' ? {else_val} : {then_val})", z = zero());
                let named = env.bind(&chosen, "WasmValue");
                env.push(named);
                Ok(Step::Continue)
            }

            // arithmetic and comparison
            I32Add => env.add_or_sub("Wasm.I32Add", false, Ok(Step::Continue)),
            I32Sub => env.add_or_sub("Wasm.I32Sub", true, Ok(Step::Continue)),
            I32Mul => env.multiply(Ok(Step::Continue)),
            I32DivS => env.binary("Wasm.I32DivS", Ok(Step::Continue)),
            I32DivU => env.binary("Wasm.I32DivU", Ok(Step::Continue)),
            I32RemS => env.binary("Wasm.I32RemS", Ok(Step::Continue)),
            I32RemU => env.binary("Wasm.I32RemU", Ok(Step::Continue)),
            I32And => env.bitwise("And", "Wasm.I32And", Ok(Step::Continue)),
            I32Or => env.bitwise("Or", "Wasm.I32Or", Ok(Step::Continue)),
            I32Xor => env.bitwise("Xor", "Wasm.I32Xor", Ok(Step::Continue)),
            I32Shl => env.shift("Wasm.I32Shl", ShiftKind::Left, Ok(Step::Continue)),
            I32ShrU => env.shift("Wasm.I32ShrU", ShiftKind::RightUnsigned, Ok(Step::Continue)),
            I32ShrS => env.shift("Wasm.I32ShrS", ShiftKind::RightSigned, Ok(Step::Continue)),
            I32Rotl => env.binary("Wasm.I32Rotl", Ok(Step::Continue)),
            I32Rotr => env.binary("Wasm.I32Rotr", Ok(Step::Continue)),
            I32Eq => env.binary("$Eq", Ok(Step::Continue)),
            I32Ne => env.binary("$Ne", Ok(Step::Continue)),
            I32LtS => env.compare("Wasm.I32LtS", Compare::Lt, true, Ok(Step::Continue)),
            I32LtU => env.compare("Wasm.I32LtU", Compare::Lt, false, Ok(Step::Continue)),
            I32GtS => env.compare("Wasm.I32GtS", Compare::Gt, true, Ok(Step::Continue)),
            I32GtU => env.compare("Wasm.I32GtU", Compare::Gt, false, Ok(Step::Continue)),
            I32LeS => env.compare("Wasm.I32LeS", Compare::Le, true, Ok(Step::Continue)),
            I32LeU => env.compare("Wasm.I32LeU", Compare::Le, false, Ok(Step::Continue)),
            I32GeS => env.compare("Wasm.I32GeS", Compare::Ge, true, Ok(Step::Continue)),
            I32GeU => env.compare("Wasm.I32GeU", Compare::Ge, false, Ok(Step::Continue)),
            I32Eqz => env.eqz(Ok(Step::Continue)),
            I32Clz => env.unary("Wasm.I32Clz", Ok(Step::Continue)),
            I32Ctz => env.unary("Wasm.I32Ctz", Ok(Step::Continue)),
            I32Popcnt => env.unary("Wasm.I32Popcnt", Ok(Step::Continue)),

            // memory
            I32Load { memarg } => env.load("$Load32", memarg.offset, Ok(Step::Continue)),
            I32Load8U { memarg } => env.load("$Load8U", memarg.offset, Ok(Step::Continue)),
            I32Load8S { memarg } => env.load("$Load8S", memarg.offset, Ok(Step::Continue)),
            I32Load16U { memarg } => env.load("$Load16U", memarg.offset, Ok(Step::Continue)),
            I32Load16S { memarg } => env.load("$Load16S", memarg.offset, Ok(Step::Continue)),
            I32Store { memarg } => env.store("$Store32", memarg.offset, Ok(Step::Continue)),
            I32Store8 { memarg } => env.store("$Store8", memarg.offset, Ok(Step::Continue)),
            I32Store16 { memarg } => env.store("$Store16", memarg.offset, Ok(Step::Continue)),
            MemorySize { .. } => {
                let pages = env.globals[self.module.pages_global].clone();
                env.push(pages);
                Ok(Step::Continue)
            }

            // The trie is sparse, but its *depth* is fixed when the module is
            // compiled, so it is not unbounded: an address past the last digit
            // wraps onto a low one. Growing past what the trie can address has to
            // report failure the way an engine out of memory does, or the two
            // regions alias and every write to one corrupts the other.
            MemoryGrow { .. } => {
                let delta = env.pop();
                let index = self.module.pages_global;
                let old = env.globals[index].clone();
                let capacity = bits32(self.module.capacity_pages as i32);
                let grown = env.bind(&format!("Wasm.I32Add<{old}, {delta}>"), "WasmValue");
                let fits = env.bind(
                    &format!("Wasm.I32LeU<{grown}, '{capacity}'>"),
                    "WasmValue",
                );
                let z = zero();
                let kept = format!("({fits} extends '{z}' ? {old} : {grown})");
                env.globals[index] = env.bind(&kept, "WasmValue");
                let answer = format!(
                    "({fits} extends '{z}' ? '{}' : {old})",
                    bits32(-1)
                );
                let named = env.bind(&answer, "WasmValue");
                env.push(named);
                Ok(Step::Continue)
            }

            I32Extend16S => env.unary("Wasm.I32Extend16S", Ok(Step::Continue)),

            // 64-bit. DOOM only needs these for its fixed-point pair - FixedMul
            // is `(a*b)>>16` and FixedDiv is `(a<<16)/b` - plus i64 loads and
            // stores used as wide data movers, which never touch the 64-bit ALU.
            I64Const { value } => {
                env.push(format!("'{}'", bits64(*value)));
                Ok(Step::Continue)
            }
            I64ExtendI32S => env.unary("Wasm.I64ExtendI32S", Ok(Step::Continue)),
            I64ExtendI32U => {
                env.i64_helpers();
                env.unary("$Zx64", Ok(Step::Continue))
            }
            I32WrapI64 => env.unary("Wasm.I32WrapI64", Ok(Step::Continue)),
            I64Mul => env.binary64("$Mul64", Ok(Step::Continue)),
            I64Add => env.binary64("$Add64", Ok(Step::Continue)),
            I64Sub => env.binary64("$Sub64", Ok(Step::Continue)),
            I64DivS => env.binary("Wasm.I64DivS", Ok(Step::Continue)),
            I64Shl => env.binary("Wasm.I64Shl", Ok(Step::Continue)),
            I64ShrU => env.binary("Wasm.I64ShrU", Ok(Step::Continue)),
            I64Load { memarg } => env.load("$Load64", memarg.offset, Ok(Step::Continue)),
            I64Store { memarg } => env.store("$Store64", memarg.offset, Ok(Step::Continue)),

            // control flow
            Block { blockty } => {
                let (end_pos, _) = *self
                    .ends
                    .get(&(pos - 1))
                    .ok_or_else(|| "block without end".to_string())?;
                let arity = block_arity(blockty)?;
                let join = self.fresh_id();
                let floor = env.stack.len();
                self.push_join(join, end_pos + 1, labels, floor, arity)?;
                labels.push(Label {
                    kind: LabelKind::Block,
                    target: join,
                    exit: join,
                    arity,
                    exit_arity: arity,
                    stack_floor: floor,
                });
                Ok(Step::Continue)
            }
            Loop { blockty } => {
                let (end_pos, _) = *self
                    .ends
                    .get(&(pos - 1))
                    .ok_or_else(|| "loop without end".to_string())?;
                let arity = block_arity(blockty)?;
                // the canonical byte-blit loop collapses to a single $Blit8
                // application: no header/exit blocks, no two hops per byte,
                // and the final locals are affine in the trip count
                if arity == 1 && std::env::var("NO_FDIV").is_err() {
                    if let Some(f) = self.match_fdiv_loop(pos, end_pos) {
                        return self.emit_fdiv(env, f);
                    }
                }
                if arity == 0 {
                    if std::env::var("FILL_DEBUG").is_ok() {
                        eprintln!("loop candidate at {pos}..{end_pos}: {:?}", &self.ops[pos..end_pos]);
                    }
                    let fused = if let Some(b) = self.match_blit_loop(pos, end_pos) {
                        Some(self.emit_blit(env, b)?)
                    } else if std::env::var("NO_TEX").is_err() {
                        match self.match_tex_loop(pos, end_pos) {
                            Some(t) => Some(self.emit_tex(env, t)?),
                            None => None,
                        }
                    } else {
                        None
                    };
                    if let Some(toll) = fused {
                        // continue after `end` in a fresh block, entered with
                        // the fuel the pixels cost taken off first
                        let after = self.fresh_id();
                        let floor = env.stack.len();
                        self.push_join(after, end_pos + 1, labels, floor, 0)?;
                        let burn = env.burn_helper();
                        let call = self.call_block(after, env, floor, 0);
                        let call = call.replacen("$F,", &format!("{burn}<$F, {toll}>,"), 1);
                        return Ok(Step::Terminate(call));
                    }
                    // the visplane search stays a loop, but enters it with `p`
                    // already on the record it would have stopped at
                    if std::env::var("NO_FIND").is_err() {
                        if let Some(f) = self.match_find_loop(pos, end_pos) {
                            self.emit_find(env, f)?;
                        }
                    }
                    // the WAD name scan stays a loop, but enters it with `i`
                    // already sitting on the fused scan's answer
                    if std::env::var("AOT_SCAN").is_ok() {
                        if let Some(s) = self.match_scan_loop(pos, end_pos) {
                            self.emit_scan(env, s)?;
                        }
                    }
                }
                let floor = env.stack.len();
                // where control lands when the loop finishes
                let exit = self.fresh_id();
                self.push_join(exit, end_pos + 1, labels, floor, arity)?;
                let header = self.fresh_id();
                // the loop header is a checkpoint: this is where a chunk stops
                let mut header_labels = labels.clone();
                header_labels.push(Label {
                    kind: LabelKind::Loop,
                    target: header,
                    exit,
                    arity: 0, // MVP loops take no parameters
                    exit_arity: arity,
                    stack_floor: floor,
                });
                self.pending.push(Pending {
                    id: header,
                    pos,
                    labels: header_labels,
                    stack: (0..floor).map(|i| format!("$k{i}")).collect(),
                });
                // entering the loop is a tail call to its header
                Ok(Step::Terminate(self.call_block(header, env, floor, 0)))
            }
            If { blockty } => {
                let (end_pos, else_pos) = *self
                    .ends
                    .get(&(pos - 1))
                    .ok_or_else(|| "if without end".to_string())?;
                let arity = block_arity(blockty)?;
                let cond = env.pop();
                let join = self.fresh_id();
                let floor = env.stack.len();
                self.push_join(join, end_pos + 1, labels, floor, arity)?;
                let mut inner_labels = labels.clone();
                inner_labels.push(Label {
                    kind: LabelKind::Block,
                    target: join,
                    exit: join,
                    arity,
                    exit_arity: arity,
                    stack_floor: floor,
                });
                // the branch bodies take fresh parameters; the values on the
                // stack right now travel as arguments. Naming them after the
                // expressions themselves collides as soon as two stack slots
                // hold the same value, which folded wat does constantly.
                let carried = fresh_stack(env.stack.len());
                let then_id = self.fresh_id();
                self.pending.push(Pending {
                    id: then_id,
                    pos,
                    labels: inner_labels.clone(),
                    stack: carried.clone(),
                });
                let else_id = self.fresh_id();
                self.pending.push(Pending {
                    id: else_id,
                    pos: else_pos.map(|p| p + 1).unwrap_or(end_pos),
                    labels: inner_labels,
                    stack: carried,
                });
                let mut then_args = self.entry_args(then_id, env);
                then_args.extend(env.stack.iter().cloned());
                let mut else_args = self.entry_args(else_id, env);
                else_args.extend(env.stack.iter().cloned());
                Ok(Step::Terminate(format!(
                    "{cond} extends '{z}'\n  ? {}<{}>\n  : {}<{}>",
                    self.block_name(else_id),
                    else_args.join(", "),
                    self.block_name(then_id),
                    then_args.join(", "),
                    z = zero()
                )))
            }
            Else => {
                // reached by falling out of a then-branch
                let text = self.jump_exit(labels, env)?;
                Ok(Step::Terminate(text))
            }
            End => {
                let text = self.jump_exit(labels, env)?;
                Ok(Step::Terminate(text))
            }
            Br { relative_depth } => {
                let text = self.jump(labels, *relative_depth, env)?;
                Ok(Step::Terminate(text))
            }
            BrIf { relative_depth } => {
                let cond = env.pop();
                let taken = self.jump(labels, *relative_depth, env)?;
                // the fall-through is its own block, so both sides are tail calls
                let fall_id = self.fresh_id();
                self.pending.push(Pending {
                    id: fall_id,
                    pos,
                    labels: labels.clone(),
                    stack: fresh_stack(env.stack.len()),
                });
                let mut args = self.entry_args(fall_id, env);
                args.extend(env.stack.iter().cloned());
                Ok(Step::Terminate(format!(
                    "{cond} extends '{z}'\n  ? {}<{}>\n  : {taken}",
                    self.block_name(fall_id),
                    args.join(", "),
                    z = zero()
                )))
            }
            BrTable { targets } => {
                let index = env.pop();
                let bound = env.bind(&index, "WasmValue");
                let mut arms = Vec::new();
                for (case, depth) in targets.targets().enumerate() {
                    let depth = depth.map_err(|e| e.to_string())?;
                    let target = self.jump(labels, depth, env)?;
                    arms.push(format!(
                        "{bound} extends '{}' ? {target}",
                        bits32(case as i32)
                    ));
                }
                let default = self.jump(labels, targets.default(), env)?;
                let mut text = String::new();
                for arm in &arms {
                    text.push_str(&format!("{arm}\n  : "));
                }
                text.push_str(&default);
                Ok(Step::Terminate(text))
            }
            Return => {
                let text = self.emit_return(env)?;
                Ok(Step::Terminate(text))
            }
            Call { function_index } => {
                if *function_index < self.module.num_imports {
                    return Err(format!(
                        "calls to imported functions are not supported (function {function_index})"
                    ));
                }
                let defined = (function_index - self.module.num_imports) as usize;
                let type_index = *self
                    .module
                    .func_type_indices
                    .get(defined)
                    .ok_or_else(|| format!("no type for function {defined}"))?;
                let callee = self
                    .module
                    .func_types
                    .get(type_index as usize)
                    .ok_or_else(|| format!("no type {type_index}"))?;
                let num_params = callee.params().len();
                let num_results = callee.results().len();
                if num_results > 1 {
                    return Err("calls returning multiple values are not supported".to_string());
                }
                for param in callee.params() {
                    if *param != ValType::I32 {
                        return Err(format!("call takes a {param:?}, only i32 is supported"));
                    }
                }
                // arguments come off the stack in order
                let mut args = Vec::new();
                for _ in 0..num_params {
                    args.push(env.pop());
                }
                args.reverse();
                // libc's block moves are a page of alignment prologues, an
                // unrolled body and a byte tail - 15% of an E1M1 frame between
                // them, measured by where chunks land. The type runtime does
                // not care about alignment, so the whole call collapses to the
                // fused byte walk the pixel loops already use.
                if std::env::var("NO_LIBC").is_err() && num_params == 3 && num_results == 1 {
                    if let Some(kind) = self.module.func_names.get(&defined).map(|n| n.as_str()) {
                        let fused = match kind {
                            // not memmove: a forward byte walk is only the same
                            // thing when the regions do not overlap, and doom
                            // never calls it anyway
                            "memcpy" | "ts_memcpy" => Some(false),
                            "memset" => Some(true),
                            _ => None,
                        };
                        if let Some(is_fill) = fused {
                            return self.emit_libc_move(env, labels, pos, &args, is_fill);
                        }
                    }
                }
                // the callee is the unmetered flavour: it runs to completion and
                // hands back ['r', memory, globals..., value?]
                let callee_name = format!("$call{defined}");
                Ok(Step::Terminate(self.call_terminator(
                    &callee_name,
                    Vec::new(),
                    args,
                    num_results,
                    pos,
                    env,
                    labels,
                )))
            }

            CallIndirect { type_index, table_index, .. } => {
                if *table_index != 0 {
                    return Err(format!("call_indirect on table {table_index}, only table 0 is supported"));
                }
                let func_type = self
                    .module
                    .func_types
                    .get(*type_index as usize)
                    .cloned()
                    .ok_or_else(|| format!("call_indirect on unknown signature {type_index}"))?;
                let num_params = func_type.params().len();
                let num_results = func_type.results().len();
                if num_results > 1 {
                    return Err("calls returning multiple values are not supported".to_string());
                }
                for param in func_type.params() {
                    if *param != ValType::I32 {
                        return Err(format!("call_indirect takes a {param:?}, only i32 is supported"));
                    }
                }
                // the table index is on top, arguments underneath
                let callee = env.pop();
                let mut args = Vec::new();
                for _ in 0..num_params {
                    args.push(env.pop());
                }
                args.reverse();

                env.indirect.borrow_mut().insert(*type_index);

                let dispatch = format!("$indirect{type_index}");
                Ok(Step::Terminate(self.call_terminator(
                    &dispatch,
                    vec![callee],
                    args,
                    num_results,
                    pos,
                    env,
                    labels,
                )))
            }

            Unreachable => Ok(Step::Terminate("never".to_string())),

            other => Err(format!("unsupported operator: {other:?}")),
        }
    }

    /// Register the continuation that runs after a block/if ends.
    fn push_join(
        &mut self,
        join: usize,
        pos: usize,
        labels: &[Label],
        floor: usize,
        arity: usize,
    ) -> Result<(), String> {
        // the join takes the stack below the label plus the label's results
        let stack_params: Vec<String> = (0..floor + arity).map(|i| format!("$k{i}")).collect();
        self.pending.push(Pending {
            id: join,
            pos,
            labels: labels.to_vec(),
            stack: stack_params,
        });
        Ok(())
    }

    /// Upper bound on stores executed per iteration of the loop starting at `pos`.
    fn stores_until_end(&self, pos: usize) -> usize {
        let end = self.ends.get(&pos).map(|(e, _)| *e).unwrap_or(self.ops.len());
        let mut stores = 0;
        for op in &self.ops[pos..end.min(self.ops.len())] {
            if matches!(
                op,
                Operator::I32Store { .. }
                    | Operator::I32Store8 { .. }
                    | Operator::I32Store16 { .. }
                    | Operator::I64Store { .. }
            ) {
                stores += 1;
            }
        }
        stores
    }
}

enum Step {
    Continue,
    #[allow(dead_code)]
    Jump(usize),
    Terminate(String),
}

#[derive(Clone)]
struct BlockEnv {
    helpers: Rc<RefCell<BTreeMap<String, String>>>,
    indirect: Rc<RefCell<BTreeSet<u32>>>,
    memory: String,
    globals: Vec<String>,
    locals: Vec<String>,
    stack: Vec<String>,
    /// (name, constraint, expression) bindings, in order
    bindings: Vec<(String, String, String)>,
    /// loads and stores so far: memory operations chain, so a block that does
    /// too many of them is split even when it is short
    mem_ops: usize,
    /// set when a binding destructures a pattern rather than naming one value;
    /// those blocks keep the older nested rendering
    has_pattern: bool,
    /// locals read before this block writes them: what it needs passed in
    reads: BTreeSet<u32>,
    /// locals this block assigns
    writes: BTreeSet<u32>,
    /// expression text -> the name already bound to it, so a value computed
    /// twice in one block is computed once. Pong recomputes screen addresses
    /// constantly: erase and draw hit the same cells.
    computed: HashMap<String, String>,
    /// Expressions built only from the specialised helpers: a pattern match or
    /// two deep, so they can be nested into whatever consumes them instead of
    /// taking a pipeline slot of their own. SSA exists to keep ts-type-math's
    /// ~32-level operators off one another, and these are not that.
    shallow: HashSet<String>,
    next_temp: usize,
    stores: usize,
    /// One past the last addressable byte, when that is known at compile time:
    /// `Some` for a module that never grows. Every load and store has to refuse
    /// an address at or past it, the way an engine traps, instead of reading a
    /// word the program never allocated.
    mem_limit: Option<u32>,
    /// Index of the page-count global to bound against when the limit is not
    /// fixed, i.e. the module can grow. It has to be an index rather than a
    /// name: `memory.grow` rebinds the global to a fresh temp, and a guard
    /// holding the name the block was entered with would keep checking the
    /// page count from before the grow.
    pages_global: Option<usize>,
}

impl BlockEnv {
    fn push(&mut self, value: String) {
        self.stack.push(value);
    }

    fn pop(&mut self) -> String {
        self.stack.pop().unwrap_or_else(|| format!("'{}'", zero()))
    }

    fn peek(&self) -> String {
        self.stack
            .last()
            .cloned()
            .unwrap_or_else(|| format!("'{}'", zero()))
    }

    fn local(&mut self, index: u32) -> Result<String, String> {
        if !self.writes.contains(&index) {
            self.reads.insert(index);
        }
        self.locals
            .get(index as usize)
            .cloned()
            .ok_or_else(|| format!("local {index} out of range"))
    }

    fn set_local(&mut self, index: u32, value: String) -> Result<(), String> {
        let index = index as usize;
        if index >= self.locals.len() {
            return Err(format!("local {index} out of range"));
        }
        let bound = self.bind(&value, "WasmValue");
        self.writes.insert(index as u32);
        self.locals[index] = bound;
        Ok(())
    }

    /// Name a value that is about to become an argument to a general helper.
    ///
    /// A helper application is left inline while it *is* the value on the stack,
    /// because resolving it costs less than the pipeline step that would hold
    /// it. That stops being true the moment it becomes an argument: the
    /// argument's depth then adds to the depth of whatever walks it, and the
    /// general helpers walk a string a character at a time. Nested two or three
    /// deep that is past what the checker will compare, and it reports the
    /// declaration as excessively deep rather than resolving it. So an operand
    /// gets its own name even when inline would have been cheaper standalone.
    fn operand(&mut self, expr: &str) -> String {
        if self.shallow.contains(expr) {
            let name = self.bind_always(expr, "WasmValue");
            return name;
        }
        expr.to_string()
    }

    /// Name a computed value, so it is evaluated once, at its own depth, and
    /// referred to by name afterwards.
    fn bind(&mut self, expr: &str, constraint: &str) -> String {
        // literals, parameters and already-named values need no binding
        if !expr.contains('<') && !expr.contains(" extends ") {
            return expr.to_string();
        }
        // a shallow helper chain costs less inline than the pipeline step that
        // would hold it; the length cap keeps a block's text from exploding
        if self.shallow.contains(expr) && expr.len() < 400 {
            return expr.to_string();
        }
        if !SSA && expr.len() < 600 {
            return expr.to_string();
        }
        self.bind_always(expr, constraint)
    }

    /// `bind` past the shortcuts: this value gets a name whatever it looks like.
    fn bind_always(&mut self, expr: &str, constraint: &str) -> String {
        if !expr.contains('<') && !expr.contains(" extends ") {
            return expr.to_string();
        }
        if let Some(existing) = self.computed.get(expr) {
            return existing.clone();
        }
        let name = format!("$t{}", self.next_temp);
        self.next_temp += 1;
        if constraint.is_empty() {
            self.has_pattern = true;
        }
        self.bindings
            .push((name.clone(), constraint.to_string(), expr.to_string()));
        self.computed.insert(expr.to_string(), name.clone());
        name
    }

    /// Bind a callee's `['r', memory, value?]` result: the caller's memory
    /// becomes the callee's, and the value (if any) lands on the stack.
    fn bind_result(&mut self, call: &str, has_value: bool) -> Option<String> {
        let memory_name = format!("$m{}", self.next_temp);
        self.next_temp += 1;
        let mut pattern = vec![
            "'r'".to_string(),
            format!("infer {memory_name} extends $Node"),
        ];
        let global_names: Vec<String> = (0..self.globals.len())
            .map(|_| {
                let name = format!("$g_{}", self.next_temp);
                self.next_temp += 1;
                name
            })
            .collect();
        for name in &global_names {
            pattern.push(format!("infer {name} extends WasmValue"));
        }
        let value_name = if has_value {
            let name = format!("$t{}", self.next_temp);
            self.next_temp += 1;
            pattern.push(format!("infer {name} extends WasmValue"));
            Some(name)
        } else {
            None
        };
        self.bindings
            .push((format!("[{}]", pattern.join(", ")), String::new(), call.to_string()));
        self.memory = memory_name;
        self.globals = global_names;
        value_name
    }


    /// 64-bit add, subtract and multiply, built out of the 32-bit ones.
    ///
    /// ts-type-math's own 64-bit add, subtract and multiply all come back as a
    /// template with `any` in it - the checker gives up part way along the
    /// string and hands back the leading segments as an error type, which turns
    /// into `never` the moment anything downstream tries to use it. Only the
    /// shifts, the extends and the wrap survive 64 characters. Nothing noticed
    /// because every i64 conformance module is skipped for taking i64
    /// *parameters*, so the whole 64-bit path was unverified.
    ///
    /// doom needs it: a fixed-point multiply is `(i64)a * (i64)b >> 16`, and
    /// that is on the path of every scaled column its renderer draws.
    ///
    /// So a 64-bit value is treated as two 32-bit halves and the arithmetic is
    /// done with the 32-bit operations that *are* verified against the engine.
    /// Splitting and joining are character moves, which cost nothing.
    fn i64_helpers(&mut self) {
        let z32 = "0".repeat(32);
        let c: Vec<String> = (0..64).map(|i| format!("${{infer c{i}}}")).collect();
        let join = |range: std::ops::Range<usize>| -> String {
            range.map(|i| format!("${{c{i}}}")).collect::<String>()
        };
        let pattern64: String = c.concat();

        // the two halves of a 64-bit value, and the way back
        self.register(
            "$Hi64",
            format!(
                "export type $Hi64<A extends string> =\n  A extends `{pattern64}` ? `{}` : never\n",
                join(0..32)
            ),
        );
        self.register(
            "$Lo64",
            format!(
                "export type $Lo64<A extends string> =\n  A extends `{pattern64}` ? `{}` : never\n",
                join(32..64)
            ),
        );
        // a 32-bit value as a 64-bit one, unsigned
        self.register(
            "$Zx64",
            format!("export type $Zx64<A extends string> = `{z32}${{A}}`\n"),
        );
        // the halves of a 32-bit value, each widened back to 32 bits, so a
        // 16x16 product is exact in 32 bits and needs no carry
        let c32: Vec<String> = (0..32).map(|i| format!("${{infer c{i}}}")).collect();
        let pattern32: String = c32.concat();
        let z16 = "0".repeat(16);
        self.register(
            "$Hi16",
            format!(
                "export type $Hi16<A extends string> =\n  A extends `{pattern32}` ? `{z16}{}` : never\n",
                join(0..16)
            ),
        );
        self.register(
            "$Lo16",
            format!(
                "export type $Lo16<A extends string> =\n  A extends `{pattern32}` ? `{z16}{}` : never\n",
                join(16..32)
            ),
        );

        // doom's FixedMul sign-extends an i32, and the general 32x32 multiply is
        // 32 reversed-string adds deep - deep enough that the product came back
        // never once a chain of blocks had already spent the depth budget
        // getting there. Every operand $Mul3264 hands a multiply is a 16 bit
        // half, so walking just those 16 bits is the same product, half the
        // steps, and a plain tail call the checker does not charge for nesting.
        let shl1 = self.shl_helper(1);
        self.register(
            "$Tail16",
            format!(
                "export type $Tail16<A extends string> =\n  A extends `{p16}${{infer rest}}` ? rest : never\n",
                p16 = (0..16).map(|i| format!("${{infer c{i}}}")).collect::<String>()
            ),
        );
        self.register(
            "$Mul16Loop",
            format!(
                concat!(
                    "export type $Mul16Loop<A extends string, B extends string, Acc extends string> =\n",
                    "  B extends `${{infer bit}}${{infer rest}}`\n",
                    "    ? $Mul16Loop<A, rest, bit extends '1' ? Wasm.I32Add<{shl1}<Acc>, A> : {shl1}<Acc>>\n",
                    "    : Acc\n"
                ),
                shl1 = shl1
            ),
        );

        // Two multiplier bits per step instead of one. A step costs a shift plus,
        // for a one bit, an add; taking the bits in pairs against precomputed 2A
        // and 3A halves the shifts and turns the two adds a `11` pair used to
        // cost into one. 2A and 3A cost a shift and an add to build, which the
        // second step already pays back.
        let shl2 = self.shl_helper(2);
        self.register(
            "$Mul16R4",
            format!(
                concat!(
                    "export type $Mul16R4<A extends string, B extends string, Acc extends string, A2 extends string, A3 extends string> =\n",
                    "  B extends `${{infer d0}}${{infer d1}}${{infer rest}}`\n",
                    "    ? $Mul16R4<A, rest, d0 extends '0'\n",
                    "        ? (d1 extends '0' ? {shl2}<Acc> : Wasm.I32Add<{shl2}<Acc>, A>)\n",
                    "        : (d1 extends '0' ? Wasm.I32Add<{shl2}<Acc>, A2> : Wasm.I32Add<{shl2}<Acc>, A3>), A2, A3>\n",
                    "    : Acc\n"
                ),
                shl2 = shl2
            ),
        );

        // A zero multiplier still walked all sixteen bits, shifting a zero
        // accumulator sixteen times. doom's fixed point makes that common: an
        // integral value has a zero low half and a pure fraction a zero high
        // one, and $Mul3264 hands both halves to a multiply. Checking for zero,
        // and for a multiplier that fits in a byte, costs one pattern match.
        self.register(
            "$Mul16",
            format!(
                concat!(
                    "export type $Mul16<A extends string, B extends string> =\n",
                    "  A extends '{z32}' ? '{z32}'\n",
                    "  : $Tail16<B> extends '{z16}' ? '{z32}'\n",
                    "  : {shl1}<A> extends infer $a2 extends string\n",
                    "  ? Wasm.I32Add<$a2, A> extends infer $a3 extends string\n",
                    "  ? $Tail16<B> extends `{z8}${{infer lo8}}`\n",
                    "    ? $Mul16R4<A, lo8, '{z32}', $a2, $a3>\n",
                    "    : $Mul16R4<A, $Tail16<B>, '{z32}', $a2, $a3>\n",
                    "  : never\n",
                    "  : never\n"
                ),
                z32 = z32,
                z16 = "0".repeat(16),
                z8 = "0".repeat(8),
                shl1 = shl1
            ),
        );

        // add: the low halves carry into the high ones. The carry is exactly
        // "the sum came out below what we started with", which is one unsigned
        // compare - no bit walking.
        self.register(
            "$Add64",
            concat!(
                "export type $Add64<A extends string, B extends string> =\n",
                "  Wasm.I32Add<$Lo64<A>, $Lo64<B>> extends infer $lo extends WasmValue\n",
                "  ? Wasm.I32Add<Wasm.I32Add<$Hi64<A>, $Hi64<B>>, Wasm.I32LtU<$lo, $Lo64<A>>> extends infer $hi extends WasmValue\n",
                "  ? `${$hi}${$lo}`\n",
                "  : never\n",
                "  : never\n"
            )
            .to_string(),
        );
        self.register(
            "$Sub64",
            concat!(
                "export type $Sub64<A extends string, B extends string> =\n",
                "  Wasm.I32Sub<$Lo64<A>, $Lo64<B>> extends infer $lo extends WasmValue\n",
                "  ? Wasm.I32Sub<Wasm.I32Sub<$Hi64<A>, $Hi64<B>>, Wasm.I32LtU<$Lo64<A>, $Lo64<B>>> extends infer $hi extends WasmValue\n",
                "  ? `${$hi}${$lo}`\n",
                "  : never\n",
                "  : never\n"
            )
            .to_string(),
        );

        // A full 32x32 product needs 64 bits, so it is built from four 16x16
        // ones, each of which is exact in 32 bits: a*b = p11<<32 + (p01+p10)<<16
        // + p00. The middle sum can carry out of 32 bits, so it is added as a
        // 64-bit value rather than a 32-bit one.
        self.register(
            "$Mul3264",
            concat!(
                // Every part is bound with `infer` rather than nested inline:
                // the checker charges nesting against one instantiation depth
                // budget, and doom multiplies a sign-extended i32, which arrives
                // already several levels deep and used to tip the whole
                // expression over into never.
                "export type $Mul3264<A extends string, B extends string> =\n",
                "  $Mul16<$Lo16<A>, $Lo16<B>> extends infer $p00 extends string\n",
                "  ? $Mul16<$Hi16<A>, $Hi16<B>> extends infer $p11 extends string\n",
                "  ? $Mul16<$Lo16<A>, $Hi16<B>> extends infer $p01 extends string\n",
                "  ? $Mul16<$Hi16<A>, $Lo16<B>> extends infer $p10 extends string\n",
                "  ? $Add64<$Zx64<$p01>, $Zx64<$p10>> extends infer $mid extends string\n",
                "  ? $Shl64_16<$mid> extends infer $mids extends string\n",
                "  ? $Shl64_32<$Zx64<$p11>> extends infer $high extends string\n",
                "  ? $Add64<$Zx64<$p00>, $high> extends infer $ends extends string\n",
                "  ? $Add64<$ends, $mids>\n",
                "  : never\n  : never\n  : never\n  : never\n  : never\n  : never\n  : never\n  : never\n"
            )
            .to_string(),
        );

        // A cross term multiplies a *high* half, and doom reaches $Mul64 through
        // FixedMul, which sign-extends an i32: the high half is all zeros or all
        // ones, never anything else. All ones is 2^32-1, which is -1 mod 2^32, so
        // the product is just the negation - and all zeros makes it zero. Left as
        // a general multiply those two cases are the *worst* input the multiplier
        // has: 32 one bits is 32 adds over the accumulator, which measured 33k
        // instantiations and tipped a negative FixedMul into TS2589 (`never`).
        let o32 = "1".repeat(32);
        self.register(
            "$MulCross",
            format!(
                concat!(
                    "export type $MulCross<H extends string, L extends string> =\n",
                    "  H extends '{z32}' ? '{z32}'\n",
                    "  : H extends '{o32}' ? Wasm.I32Sub<'{z32}', L>\n",
                    "  : Wasm.I32Mul<H, L>\n"
                ),
                z32 = z32,
                o32 = o32
            ),
        );

        // only the low 64 bits survive, so the high halves only ever reach the
        // top: a*b = lo*lo + ((ah*bl + al*bh) << 32)
        self.register(
            "$Mul64",
            concat!(
                "export type $Mul64<A extends string, B extends string> =\n",
                "  $Mul3264<$Lo64<A>, $Lo64<B>> extends infer $m extends string\n",
                "  ? $MulCross<$Hi64<A>, $Lo64<B>> extends infer $ahbl extends WasmValue\n",
                "  ? $MulCross<$Hi64<B>, $Lo64<A>> extends infer $albh extends WasmValue\n",
                "  ? Wasm.I32Add<$ahbl, $albh> extends infer $cross extends WasmValue\n",
                "  ? Wasm.I32Add<$Hi64<$m>, $cross> extends infer $hi extends WasmValue\n",
                "  ? `${$hi}${$Lo64<$m>}`\n",
                "  : never\n  : never\n  : never\n  : never\n",
                "  : never\n"
            )
            .to_string(),
        );

        // Shifts by a constant are character moves on the 64-character string.
        // Left means the *high* characters fall off the front and zeros arrive
        // at the back, so what is kept starts at `amount` - keeping the front
        // instead quietly computes `(a >> amount) << amount`, which is only
        // wrong once a term is big enough to reach the part that gets dropped.
        for amount in [16usize, 32] {
            let kept: String = join(amount..64);
            let zeros = "0".repeat(amount);
            self.register(
                &format!("$Shl64_{amount}"),
                format!(
                    "export type $Shl64_{amount}<A extends string> =\n  A extends `{pattern64}` ? `{kept}{zeros}` : never\n"
                ),
            );
        }
    }

    /// A 64-bit operation that goes through the helpers above instead of
    /// ts-type-math, whose own 64-bit add, subtract and multiply are broken.
    fn binary64(&mut self, helper: &str, ret: Result<Step, String>) -> Result<Step, String> {
        self.i64_helpers();
        let b = self.pop();
        let a = self.pop();
        let (a, b) = (self.operand(&a), self.operand(&b));
        let value = format!("{helper}<{a}, {b}>");
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    fn binary(&mut self, op: &str, ret: Result<Step, String>) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        // both sides known: do it here rather than making the checker do it
        if let (Some(x), Some(y)) = (Self::literal(&a), Self::literal(&b)) {
            if let Some(folded) = fold(op, x, y) {
                self.push(format!("'{}'", bits32(folded as i32)));
                return ret;
            }
        }
        let (a, b) = (self.operand(&a), self.operand(&b));
        let value = format!("{op}<{a}, {b}>");
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    /// Is this value a literal we know at compile time?
    fn literal(value: &str) -> Option<u32> {
        let trimmed = value.trim();
        if trimmed.len() == 34 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
            u32::from_str_radix(&trimmed[1..33], 2).ok()
        } else {
            None
        }
    }

    fn register(&mut self, name: &str, definition: String) -> String {
        self.helpers
            .borrow_mut()
            .entry(name.to_string())
            .or_insert(definition);
        name.to_string()
    }

    /// Fused strided byte copy: while (count--) { mem8[d] = mem8[s]; d += DS; s += SS }
    ///
    /// Returns the new memory; the caller writes the affine finals back to the
    /// locals. Divide-and-conquer on the trip count: the checker's
    /// tail-recursion elimination caps out near 1000 iterations, so a linear
    /// per-byte recursion stalls on any blit past that (a 320x200 screen copy
    /// is 64000 bytes). Splitting halves bounds evaluation depth at the tree
    /// height, ~log2(count), with the low half forced through `infer` before
    /// the high half runs against its memory.
    ///
    /// The C == 1 base case is load-bearing: half of 1 is 0, and without it
    /// the split recurses forever.
    fn blit_helper(&mut self, width: u8) -> String {
        let pattern: String = (0..32).map(|i| format!("${{infer c{i}}}")).collect();
        let kept: String = (0..31).map(|i| format!("${{c{i}}}")).collect();
        let shr1 = format!(
            "export type $BlitH<C extends WasmValue> =\n\
             \x20 C extends `{pattern}` ? `0{kept}` : never\n"
        );
        self.register("$BlitH", shr1);
        let name = format!("$Blit{width}");
        let (load, store) = match width {
            16 => ("$Load16U", "$Store16"),
            _ => ("$Load8U", "$Store8"),
        };
        let definition = format!(
            "export type {name}<M extends $Node, D extends WasmValue, S extends WasmValue, C extends WasmValue, DS extends WasmValue, SS extends WasmValue> =\n\
             \x20 C extends '{z}'\n\
             \x20 ? M\n\
             \x20 : C extends `{small}${{string}}`\n\
             \x20 ? ({store}<M, D, {load}<M, S>> extends infer M2 extends $Node\n\
             \x20   ? {name}<M2, Wasm.I32Add<D, DS>, Wasm.I32Add<S, SS>, Wasm.I32Sub<C, '{one}'>, DS, SS>\n\
             \x20   : never)\n\
             \x20 : $BlitH<C> extends infer H extends WasmValue\n\
             \x20   ? {name}<M, D, S, H, DS, SS> extends infer M2 extends $Node\n\
             \x20     ? {name}<M2, Wasm.I32Add<D, Wasm.I32Mul<H, DS>>, Wasm.I32Add<S, Wasm.I32Mul<H, SS>>, Wasm.I32Sub<C, H>, DS, SS>\n\
             \x20     : never\n\
             \x20   : never\n",
            z = zero(),
            one = format!("{}1", "0".repeat(31)),
            // below 512 the column walks linearly (tail call, no muls); the
            // checker's tail-recursion cap is ~1000
            small = "0".repeat(23),
        );
        self.register(&name, definition)
    }

    /// Fused texture loop (see `Tex`): per pixel `m8[D] = m8[CM + m8[SRC +
    /// idx(A, B)]]`, then D += KD, A += DA, B += DB. The index is a splice of
    /// A's and B's characters into a zero string, so shift+mask+add cost one
    /// template match. Same divide-and-conquer as `$Blit8`.
    fn tex_helper(&mut self, t: &Tex) -> String {
        let pattern: String = (0..32).map(|i| format!("${{infer c{i}}}")).collect();
        let kept: String = (0..31).map(|i| format!("${{c{i}}}")).collect();
        let shr1 = format!(
            "export type $BlitH<C extends WasmValue> =\n\
             \x20 C extends `{pattern}` ? `0{kept}` : never\n"
        );
        self.register("$BlitH", shr1);
        // result char (31 - j) is A's char (31 - (j + shift)) for j in [lo, lo+width)
        let mut chars: Vec<String> = (0..32).map(|_| "0".to_string()).collect();
        let mut key = String::new();
        let mut place = |name: &str, term: &TexTerm| {
            for j in term.lo..term.lo + term.width {
                chars[(31 - j) as usize] = format!("${{{name}{}}}", 31 - (j + term.shift));
            }
            key.push_str(&format!("_{}_{}_{}", term.shift, term.lo, term.width));
        };
        place("a", &t.a);
        if let Some(b) = &t.b {
            place("b", b);
        }
        let apat: String = (0..32).map(|i| format!("${{infer a{i}}}")).collect();
        let bpat: String = (0..32).map(|i| format!("${{infer b{i}}}")).collect();
        let spliced: String = chars.concat();
        let idx_name = format!("$TexIdx{key}");
        let idx = if t.b.is_some() {
            format!(
                "export type {idx_name}<A extends WasmValue, B extends WasmValue> =\n\
                 \x20 A extends `{apat}` ? B extends `{bpat}` ? `{spliced}` : never : never\n"
            )
        } else {
            format!(
                "export type {idx_name}<A extends WasmValue, B extends WasmValue> =\n\
                 \x20 A extends `{apat}` ? `{spliced}` : never\n"
            )
        };
        self.register(&idx_name, idx);
        // the pixel write: one store, or two of the same texel. D2 is the
        // second pointer (own stride KD2) or the constant offset from D.
        //
        // Adjacent-byte pairs (R_DrawSpanLow: d, d+1) used to be two $Store8s,
        // each a full read+write trie walk - 4 walks per pixel on the hottest
        // block in a gameplay frame. Both bytes land in one word unless the
        // first sits at offset '11', so $StorePair8 splices both bytes in a
        // single read+write walk and only falls back at the word seam.
        let (suffix, write) = match t.pair {
            TexPair::None => ("", "$Store8<M, D, V>".to_string()),
            TexPair::Offset(1) => {
                let one = format!("{}1", "0".repeat(31));
                self.register(
                    "$StorePair8",
                    format!(
                        "export type $StorePair8<M extends $Node, A extends WasmValue, V extends WasmValue> =\n\
                         \x20 $Off<A> extends '11'\n\
                         \x20 ? $Store8<$Store8<M, A, V>, Wasm.I32Add<A, '{one}'>, V>\n\
                         \x20 : $Write<M, A, $SetByte<$SetByte<$Read<M, A>, $Off<A>, V>, $Next<$Off<A>>, V>>\n"
                    ),
                );
                ("_o1", "$StorePair8<M, D, V>".to_string())
            }
            TexPair::Offset(_) => ("_o", "$Store8<$Store8<M, D, V>, Wasm.I32Add<D, D2>, V>".to_string()),
            TexPair::Local(..) => ("_l", "$Store8<$Store8<M, D, V>, D2, V>".to_string()),
        };
        let name = format!("$Tex{key}{suffix}");
        // The per-pixel loop below 512 trips. Measured on a 450-pixel span
        // (TS7.1 microbench): the binary `C - 1` and the `D + KD` adder were
        // 0.18 of the 0.77ms each pixel cost. So the count runs as a string of
        // ones (one prefix match per pixel) and the strides, all constants,
        // step through the bit-step helpers. A and B keep the adder: their
        // steps are memory values.
        let kd2 = match t.pair {
            TexPair::Local(_, k) => Some(k),
            _ => None,
        };
        let tag = |k: i32| if k < 0 { format!("m{}", k.unsigned_abs()) } else { k.to_string() };
        let inner = match kd2 {
            Some(k) => format!("{name}_u{}_{}", tag(t.kd), tag(k)),
            None => format!("{name}_u{}", tag(t.kd)),
        };
        let d_step = self.const_add("D", t.kd as u32);
        let d2_step = match kd2 {
            Some(k) => self.const_add("D2", k as u32),
            None => "D2".to_string(),
        };
        let b_step = if t.b.is_some() { "Wasm.I32Add<B, DB>" } else { "B" };
        let ones = self.ones_helper();
        let inner_definition = format!(
            "export type {inner}<M extends $Node, D extends WasmValue, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, B extends WasmValue, DB extends WasmValue, U extends string, D2 extends WasmValue> =\n\
             \x20 U extends `1${{infer R}}`\n\
             \x20 ? ($Load8U<M, Wasm.I32Add<CM, $Load8U<M, Wasm.I32Add<SRC, {idx_name}<A, B>>>>> extends infer V extends WasmValue\n\
             \x20   ? {write} extends infer M2 extends $Node\n\
             \x20     ? {inner}<M2, {d_step}, CM, SRC, Wasm.I32Add<A, DA>, DA, {b_step}, DB, R, {d2_step}>\n\
             \x20     : never\n\
             \x20   : never)\n\
             \x20 : M\n"
        );
        self.register(&inner, inner_definition);
        let d2_jump = match t.pair {
            TexPair::Local(..) => "Wasm.I32Add<D2, Wasm.I32Mul<H, KD2>>",
            _ => "D2",
        };
        let definition = format!(
            "export type {name}<M extends $Node, D extends WasmValue, KD extends WasmValue, CM extends WasmValue, SRC extends WasmValue, A extends WasmValue, DA extends WasmValue, B extends WasmValue, DB extends WasmValue, C extends WasmValue, D2 extends WasmValue, KD2 extends WasmValue> =\n\
             \x20 C extends '{z}'\n\
             \x20 ? M\n\
             \x20 : C extends `{small}${{string}}`\n\
             \x20 ? {inner}<M, D, CM, SRC, A, DA, B, DB, {ones}<C>, D2>\n\
             \x20 : $BlitH<C> extends infer H extends WasmValue\n\
             \x20   ? {name}<M, D, KD, CM, SRC, A, DA, B, DB, H, D2, KD2> extends infer M2 extends $Node\n\
             \x20     ? {name}<M2, Wasm.I32Add<D, Wasm.I32Mul<H, KD>>, KD, CM, SRC, Wasm.I32Add<A, Wasm.I32Mul<H, DA>>, DA, Wasm.I32Add<B, Wasm.I32Mul<H, DB>>, DB, Wasm.I32Sub<C, H>, {d2_jump}, KD2>\n\
             \x20     : never\n\
             \x20   : never\n",
            z = zero(),
            small = "0".repeat(23),
        );
        self.register(&name, definition)
    }

    /// Take N units off the fuel string, N a 32-bit value: powers of two from
    /// the low nine bits, largest first, and anything above 511 empties it.
    /// Characters are dropped whatever they are, so a segment mark inside the
    /// run costs one unit and leaves the next block to bounce on the mark
    /// after it (see wrap_block).
    fn burn_helper(&mut self) -> String {
        // N as a 32-char string: chars 0..23 must be zero, chars 23..32 are the bits
        let pattern: String = (0..9).map(|i| format!("${{infer b{i}}}")).collect();
        let mut chain = String::from("F");
        for i in 0..9 {
            // b{i} is bit (8 - i)
            chain = format!("$BurnBit<{chain}, b{i}, '{}'>", 1 << (8 - i));
        }
        // one alias per power of two, dropping that many characters whatever
        // they are: the fuel string has segment marks in it (see wrap_block)
        let mut definition = String::new();
        for bit in 0..9 {
            let n = 1usize << bit;
            let cs: String = (0..n).map(|i| format!("${{infer c{i}}}")).collect();
            definition.push_str(&format!(
                "export type $Drop{n}<F extends string> = F extends `{cs}${{infer R}}` ? R : ''\n"
            ));
        }
        definition.push_str(&format!(
            "export type $BurnBit<F extends string, Bit extends string, N extends string> =\n\
             \x20 Bit extends '1' ? (N extends '256' ? $Drop256<F> : N extends '128' ? $Drop128<F> : N extends '64' ? $Drop64<F> : N extends '32' ? $Drop32<F> : N extends '16' ? $Drop16<F> : N extends '8' ? $Drop8<F> : N extends '4' ? $Drop4<F> : N extends '2' ? $Drop2<F> : $Drop1<F>) : F\n\
             export type $Burn<F extends string, N extends string> =\n\
             \x20 N extends `{zeros}{pattern}` ? {chain} : ''\n",
            zeros = "0".repeat(23),
        ));
        self.register("$Burn", definition)
    }

    /// Restoring division for FixedDiv2: R is the running remainder (< B on
    /// entry, so `R << 1 | bit` never overflows 32 bits), LO the 32 dividend
    /// bits still to shift in, most significant first. One `I32GeU` and at most
    /// one `I32Sub` per bit; the quotient string grows a character per bit.
    fn fdiv_helper(&mut self) -> String {
        let definition = format!(
            "export type $FDivQ<R extends WasmValue, LO extends WasmValue, B extends WasmValue> = $FDivL<R, B, LO, ''>\n\
             export type $FDivL<R extends WasmValue, B extends WasmValue, D extends string, Q extends string> =\n\
             \x20 D extends `${{infer Bit}}${{infer Rest}}`\n\
             \x20 ? R extends `${{infer _Top}}${{infer Tail}}`\n\
             \x20   ? `${{Tail}}${{Bit}}` extends infer R2 extends WasmValue\n\
             \x20     ? Wasm.I32GeU<R2, B> extends '{z}'\n\
             \x20       ? $FDivL<R2, B, Rest, `${{Q}}0`>\n\
             \x20       : $FDivL<Wasm.I32Sub<R2, B>, B, Rest, `${{Q}}1`>\n\
             \x20     : never\n\
             \x20   : never\n\
             \x20 : Q\n",
            z = zero(),
        );
        self.register("$FDivQ", definition)
    }

    /// Fused byte fill: while (count--) { mem8[d] = V; d += 1 }. Same
    /// divide-and-conquer as `$Blit8`, and the same reason: a linear
    /// per-byte recursion stalls past ~1000 iterations and a memset can be
    /// the whole screen.
    fn fill_helper(&mut self) -> String {
        let pattern: String = (0..32).map(|i| format!("${{infer c{i}}}")).collect();
        let kept: String = (0..31).map(|i| format!("${{c{i}}}")).collect();
        let shr1 = format!(
            "export type $BlitH<C extends WasmValue> =\n\
             \x20 C extends `{pattern}` ? `0{kept}` : never\n"
        );
        self.register("$BlitH", shr1);
        let definition = format!(
            "export type $Fill8<M extends $Node, D extends WasmValue, V extends WasmValue, C extends WasmValue> =\n\
             \x20 C extends '{z}'\n\
             \x20 ? M\n\
             \x20 : C extends `{small}${{string}}`\n\
             \x20 ? ($Store8<M, D, V> extends infer M2 extends $Node\n\
             \x20   ? $Fill8<M2, Wasm.I32Add<D, '{one}'>, V, Wasm.I32Sub<C, '{one}'>>\n\
             \x20   : never)\n\
             \x20 : $BlitH<C> extends infer H extends WasmValue\n\
             \x20   ? $Fill8<M, D, V, H> extends infer M2 extends $Node\n\
             \x20     ? $Fill8<M2, Wasm.I32Add<D, H>, V, Wasm.I32Sub<C, H>>\n\
             \x20     : never\n\
             \x20   : never\n",
            z = zero(),
            one = format!("{}1", "0".repeat(31)),
            small = "0".repeat(23),
        );
        self.register("$Fill8", definition)
    }

    /// Forward search for the first record whose three words match, or the
    /// first address at or past the end. Linear: doom caps visplanes at 128,
    /// and the budget string bounds it anyway - if it runs out the walk hands
    /// back where it got to and the interpreted loop carries on, which is
    /// slower but still correct.
    fn find_helper(&mut self, off_b: i32, off_c: i32, stride: i32) -> String {
        let name = format!("$Find_{}_{}_{}", off_b, off_c, stride);
        let definition = format!(
            "export type {name}<M extends $Node, P extends WasmValue, E extends WasmValue, A extends WasmValue, B extends WasmValue, C extends WasmValue, Budget extends string = '{budget}'> =\n\
             \x20 Budget extends `1${{infer Left}}`\n\
             \x20 ? Wasm.I32GeU<P, E> extends '{one}'\n\
             \x20   ? P\n\
             \x20   : $Load32<M, P> extends A\n\
             \x20     ? $Load32<M, Wasm.I32Add<P, '{ob}'>> extends B\n\
             \x20       ? $Load32<M, Wasm.I32Add<P, '{oc}'>> extends C\n\
             \x20         ? P\n\
             \x20         : {name}<M, Wasm.I32Add<P, '{k}'>, E, A, B, C, Left>\n\
             \x20       : {name}<M, Wasm.I32Add<P, '{k}'>, E, A, B, C, Left>\n\
             \x20     : {name}<M, Wasm.I32Add<P, '{k}'>, E, A, B, C, Left>\n\
             \x20 : P\n",
            one = format!("{}1", "0".repeat(31)),
            ob = bits32(off_b),
            oc = bits32(off_c),
            k = bits32(stride),
            budget = "1".repeat(256),
        );
        self.register(&name, definition)
    }

    /// Backward record scan for the fused W_CheckNumForName loop: N records
    /// of 20 bytes ending at B+I, compared as two i32 words at -20/-16.
    /// Returns the byte offset of the first match walking downward, or zero.
    ///
    /// Same divide-and-conquer as $Blit: the checker's tail-recursion
    /// elimination caps near 1000 iterations and the lump directory is ~1200
    /// records, so the upper half is forced through `infer` and the lower
    /// half only runs on a miss. Depth is ~log2(N).
    fn scan_helper(&mut self) -> String {
        let pattern: String = (0..32).map(|i| format!("${{infer c{i}}}")).collect();
        let kept: String = (0..31).map(|i| format!("${{c{i}}}")).collect();
        let shr1 = format!(
            "export type $BlitH<C extends WasmValue> =\n\
             \x20 C extends `{pattern}` ? `0{kept}` : never\n"
        );
        self.register("$BlitH", shr1);
        let definition = format!(
            "export type $Scan<M extends $Node, B extends WasmValue, I extends WasmValue, HI extends WasmValue, LO extends WasmValue, N extends WasmValue> =\n\
             \x20 N extends '{z}'\n\
             \x20 ? '{z}'\n\
             \x20 : N extends '{one}'\n\
             \x20 ? ($Load32<M, Wasm.I32Add<B, Wasm.I32Add<I, '{neg20}'>>> extends HI\n\
             \x20    ? ($Load32<M, Wasm.I32Add<B, Wasm.I32Add<I, '{neg16}'>>> extends LO ? I : '{z}')\n\
             \x20    : '{z}')\n\
             \x20 : $BlitH<N> extends infer H extends WasmValue\n\
             \x20   ? $Scan<M, B, I, HI, LO, Wasm.I32Sub<N, H>> extends infer R extends WasmValue\n\
             \x20     ? R extends '{z}'\n\
             \x20       ? $Scan<M, B, Wasm.I32Sub<I, Wasm.I32Mul<Wasm.I32Sub<N, H>, '{twenty}'>>, HI, LO, H>\n\
             \x20       : R\n\
             \x20     : never\n\
             \x20   : never\n",
            z = zero(),
            one = format!("{}1", "0".repeat(31)),
            neg20 = bits32(-20),
            neg16 = bits32(-16),
            twenty = bits32(20),
        );
        self.register("$Scan", definition)
    }

    /// shift left by a known amount: drop the top characters, append zeros
    fn shl_helper(&mut self, amount: u32) -> String {
        let name = format!("$Shl{amount}");
        let pattern: String = (0..32).map(|i| format!("${{infer c{i}}}")).collect();
        let kept: String = (amount..32).map(|i| format!("${{c{i}}}")).collect();
        let definition = format!(
            "export type {name}<A extends string> =\n  A extends `{pattern}`\n    ? `{kept}{zeros}`\n    : never\n",
            zeros = "0".repeat(amount as usize)
        );
        self.register(&name, definition)
    }

    /// shift right by a known amount, filling with zeros or with the sign
    fn shr_helper(&mut self, amount: u32, signed: bool) -> String {
        let name = format!("$Shr{}{}", if signed { "S" } else { "U" }, amount);
        let pattern: String = (0..32).map(|i| format!("${{infer c{i}}}")).collect();
        let fill: String = if signed {
            (0..amount).map(|_| "${c0}".to_string()).collect()
        } else {
            "0".repeat(amount as usize)
        };
        let kept: String = (0..32 - amount).map(|i| format!("${{c{i}}}")).collect();
        let definition = format!(
            "export type {name}<A extends string> =\n  A extends `{pattern}`\n    ? `{fill}{kept}`\n    : never\n"
        );
        self.register(&name, definition)
    }

    /// bitwise op against a known constant: one character choice per bit
    fn mask_helper(&mut self, op: &str, constant: u32) -> String {
        let name = format!("${op}{constant:08X}");
        let pattern: String = (0..32).map(|i| format!("${{infer c{i}}}")).collect();
        let result: String = (0..32)
            .map(|i| {
                let bit = (constant >> (31 - i)) & 1;
                match (op, bit) {
                    ("And", 0) => "0".to_string(),
                    ("And", _) => format!("${{c{i}}}"),
                    ("Or", 1) => "1".to_string(),
                    ("Or", _) => format!("${{c{i}}}"),
                    ("Xor", 1) => format!("${{$Flip[c{i}]}}"),
                    ("Xor", _) => format!("${{c{i}}}"),
                    _ => format!("${{c{i}}}"),
                }
            })
            .collect();
        let definition = format!(
            "export type {name}<A extends string> =\n  A extends `{pattern}`\n    ? `{result}`\n    : never\n"
        );
        self.register(&name, definition)
    }

    /// `X + k` for a constant k as a type expression over the name `x`:
    /// the bit-step helpers when k is a few powers of two, else the adder.
    /// Two steps are chained through `infer` in a named helper so the
    /// expression stays one application deep at the use site.
    fn const_add(&mut self, x: &str, k: u32) -> String {
        if k == 0 {
            return x.to_string();
        }
        let Some(steps) = Self::steps_for(k, 4) else {
            return format!("Wasm.I32Add<{x}, '{}'>", bits32(k as i32));
        };
        let helpers: Vec<String> = steps.iter().map(|&(bit, down)| self.step_helper(bit, down)).collect();
        if helpers.len() == 1 {
            return format!("{}<{x}>", helpers[0]);
        }
        let name = format!("$AddK{k}");
        // A -> h0<A> as X0 -> h1<X0> as X1 -> ... -> h_last<X_{n-2}>
        let mut body = format!("{}<X{}>", helpers[helpers.len() - 1], helpers.len() - 2);
        for i in (0..helpers.len() - 1).rev() {
            let src = if i == 0 { "A".to_string() } else { format!("X{}", i - 1) };
            body = format!("{}<{src}> extends infer X{i} extends string ? {body} : never", helpers[i]);
        }
        let definition = format!("export type {name}<A extends string> =\n  {body}\n");
        self.register(&name, definition);
        format!("{name}<{x}>")
    }

    /// A count below 512 as a string of that many ones, so a loop can take
    /// one off with a prefix match instead of a subtract. Characters inferred
    /// from a template cannot be tested, so each bit is peeled off as a
    /// literal prefix.
    fn ones_helper(&mut self) -> String {
        for w in 1..=9usize {
            let run = "1".repeat(1 << (w - 1));
            let rest = if w == 1 { "''".to_string() } else { format!("$Ones{}<T>", w - 1) };
            let rest_ = if w == 1 { String::new() } else { format!("${{$Ones{}<T>}}", w - 1) };
            let definition = format!(
                "export type $Ones{w}<A extends string> =\n  A extends `1${{infer T}}` ? `{run}{rest_}` : A extends `0${{infer T}}` ? {rest} : ''\n"
            );
            self.register(&format!("$Ones{w}"), definition);
        }
        let definition = format!(
            "export type $Ones<C extends string> = C extends `{}${{infer T}}` ? $Ones9<T> : never\n",
            "0".repeat(23)
        );
        self.register("$Ones", definition)
    }

    /// Add or subtract 2^k without an adder.
    ///
    /// Incrementing a binary string is "flip the run of 1s at the bottom and
    /// the 0 that stops it", which template patterns can do directly:
    /// `${infer H}011` -> `${H}100`. The arms are mutually exclusive because
    /// each anchors a different suffix, and the first one matches for half of
    /// all values.
    ///
    /// Two things this must not do. The carry cannot be found with a pattern
    /// like `${infer H}0${infer l0}${infer l1}` that leaves the low bits as
    /// trailing placeholders - inference binds H at the *first* '0' in the
    /// string, not the one the bit position asks for. And the run cannot be
    /// walked by testing characters, because a character inferred from a
    /// template is typed `string`, so `c extends '1'` is never true. So the low
    /// bits are split off by width first, and the rest is incremented as a
    /// shorter string of its own.
    fn carry_helper(&mut self, width: usize, down: bool) -> String {
        let name = format!("${}Top{width}", if down { "Dec" } else { "Inc" });
        let (stop, run, new_stop, new_run) = if down { ('1', '0', '0', '1') } else { ('0', '1', '1', '0') };
        let mut arms = Vec::new();
        for m in 0..width {
            let run_chars: String = std::iter::repeat(run).take(m).collect();
            let new_run_chars: String = std::iter::repeat(new_run).take(m).collect();
            arms.push(format!(
                "  A extends `${{infer H}}{stop}{run_chars}` ? `${{H}}{new_stop}{new_run_chars}`"
            ));
        }
        // every character was part of the run: the value wrapped
        let wrapped: String = std::iter::repeat(new_run).take(width).collect();
        let definition = format!(
            "export type {name}<A extends string> =\n{}\n  : '{wrapped}'\n",
            arms.join(" :\n")
        );
        self.register(&name, definition)
    }

    fn step_helper(&mut self, bit: u32, down: bool) -> String {
        let name = format!("${}{bit}", if down { "Dec" } else { "Inc" });
        let width = 32 - bit as usize;
        if bit == 0 {
            let top = self.carry_helper(width, down);
            let definition = format!("export type {name}<A extends string> = {top}<A>\n");
            return self.register(&name, definition);
        }
        // Spelling the low bits out as literal arms costs `width * 2^bit` of
        // them - 120 for a +4 - and a conditional chain that long is also a
        // type that deep, which puts it past the depth the checker will compare
        // and makes every use of the helper an error. So the low bits always
        // come off by width instead, and the carry runs on the shorter string:
        // one destructure, then a chain no longer than 32. An aligned address
        // still matches the carry chain's first arm, so the common case stays
        // one step either way.
        let top = self.carry_helper(width, down);
        let pattern: String = (0..width).map(|i| format!("${{infer c{i}}}")).collect();
        let high: String = (0..width).map(|i| format!("${{c{i}}}")).collect();
        let definition = format!(
            "export type {name}<A extends string> =\n  A extends `{pattern}${{infer L}}`\n    ? `${{{top}<`{high}`>}}${{L}}`\n    : never\n"
        );
        self.register(&name, definition)
    }

    /// A constant addend as a short list of +/- powers of two (non-adjacent
    /// form), so `+31` is one step up and one step down rather than five
    /// carries. Returns None when the constant would need too many steps to be
    /// worth it and the general adder is cheaper.
    fn steps_for(constant: u32, limit: u32) -> Option<Vec<(u32, bool)>> {
        let mut steps = Vec::new();
        let mut value = constant;
        let mut bit = 0u32;
        while value != 0 {
            if bit >= 32 {
                // the carry ran off the top: it wrapped, which costs nothing
                break;
            }
            if value & 1 == 1 {
                let down = value & 2 == 2;
                if down {
                    value = value.wrapping_add(1);
                    steps.push((bit, true));
                } else {
                    steps.push((bit, false));
                    value &= !1;
                }
            }
            value >>= 1;
            bit += 1;
            if steps.len() as u32 > limit {
                return None;
            }
        }
        if steps.is_empty() { None } else { Some(steps) }
    }

    /// `x + c` for a known c: a few bit steps instead of a 32-bit adder.
    /// Measured on gfx's own values: 13 instantiations against 245.
    fn add_or_sub(&mut self, op: &str, negate: bool, ret: Result<Step, String>) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        if let (Some(x), Some(y)) = (Self::literal(&a), Self::literal(&b)) {
            if let Some(folded) = fold(op, x, y) {
                self.push(format!("'{}'", bits32(folded as i32)));
                return ret;
            }
        }
        // only the right side can be constant-folded this way for a subtract:
        // `c - x` is not `x - c`
        let constant = Self::literal(&b).map(|k| if negate { 0u32.wrapping_sub(k) } else { k });
        let variable = a.clone();
        let plain = Self::literal(&a)
            .filter(|_| !negate)
            .map(|k| (k, b.clone()));
        let (constant, variable) = match (constant, plain) {
            (Some(k), _) => (Some(k), variable),
            (None, Some((k, other))) => (Some(k), other),
            _ => (None, variable),
        };
        if let Some(constant) = constant {
            if let Some(steps) = Self::steps_for(constant, 4) {
                // Each carry step is a chain up to 32 long, so stacking two
                // of them inline is a type deeper than the checker compares.
                // Every step but the last gets a name.
                let mut value = variable;
                for (index, (bit, down)) in steps.into_iter().enumerate() {
                    if index > 0 {
                        value = self.bind_always(&value, "WasmValue");
                    }
                    let helper = self.step_helper(bit, down);
                    value = format!("{helper}<{value}>");
                    self.shallow.insert(value.clone());
                }
                self.push(value);
                return ret;
            }
        }
        let (a, b) = (self.operand(&a), self.operand(&b));
        let value = format!("{op}<{a}, {b}>");
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    /// `x < C` for a known C: the answer is decided by a prefix. Wherever C has
    /// a 1 and x has a 0 with the bits above matching, x is smaller - so the
    /// test is a handful of anchored patterns, one per set bit, instead of a
    /// bit-by-bit comparison. Measured: 16 instantiations against 491.
    ///
    /// Signed compares are the same question about `x ^ 0x80000000`, which only
    /// changes the first character of every pattern.
    fn less_helper(&mut self, constant: u32, signed: bool) -> String {
        let mapped = if signed { constant ^ 0x8000_0000 } else { constant };
        let name = format!("$Lt{}{:08X}", if signed { "S" } else { "U" }, constant);
        let bits: Vec<char> = format!("{mapped:032b}").chars().collect();
        let mut arms = Vec::new();
        for i in 0..32 {
            if bits[i] != '1' {
                continue;
            }
            let mut prefix: String = bits[..i].iter().collect();
            prefix.push('0');
            if signed {
                // the pattern is about x ^ 0x80000000, so the sign character flips
                let mut chars: Vec<char> = prefix.chars().collect();
                chars[0] = if chars[0] == '0' { '1' } else { '0' };
                prefix = chars.into_iter().collect();
            }
            arms.push(format!("  A extends `{prefix}${{infer _r}}` ? '{}'", bits32(1)));
        }
        let definition = if arms.is_empty() {
            // nothing is below the smallest value
            format!("export type {name}<A extends string> = '{}'\n", zero())
        } else {
            format!(
                "export type {name}<A extends string> =\n{}\n  : '{}'\n",
                arms.join(" :\n"),
                zero()
            )
        };
        self.register(&name, definition)
    }

    /// A comparison against a constant, in whichever form the program wrote it.
    fn compare(
        &mut self,
        fallback: &str,
        kind: Compare,
        signed: bool,
        ret: Result<Step, String>,
    ) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        if let (Some(x), Some(y)) = (Self::literal(&a), Self::literal(&b)) {
            if let Some(folded) = fold(fallback, x, y) {
                self.push(format!("'{}'", bits32(folded as i32)));
                return ret;
            }
        }
        // `a OP b` with one side constant becomes `variable < constant`,
        // possibly negated: x > c is not (x < c+1), x >= c is not (x < c)
        let plan = match (Self::literal(&b), Self::literal(&a)) {
            (Some(c), _) => Some((a.clone(), c, kind)),
            (None, Some(c)) => Some((b.clone(), c, kind.flipped())),
            _ => None,
        };
        if let Some((variable, constant, kind)) = plan {
            if let Some((bound, negate)) = kind.as_less_than(constant, signed) {
                let helper = self.less_helper(bound, signed);
                let value = format!("{helper}<{variable}>");
                let value = if negate { format!("$Not1<{value}>") } else { value };
                self.shallow.insert(value.clone());
                self.push(value);
                return ret;
            }
            // the bound ran off the end of the range: the answer is a constant
            if let Some(answer) = kind.saturated(constant, signed) {
                self.push(format!("'{}'", if answer { bits32(1) } else { zero() }));
                return ret;
            }
        }
        let (a, b) = (self.operand(&a), self.operand(&b));
        let value = format!("{fallback}<{a}, {b}>");
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    /// `a > b` is `b < a`
    fn binary_swapped(&mut self, op: &str, ret: Result<Step, String>) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        let value = format!("{op}<{b}, {a}>");
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    /// `a >= b` is `!(a < b)`
    fn binary_not(&mut self, op: &str, ret: Result<Step, String>) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        let value = format!("$Not1<{op}<{a}, {b}>>");
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    /// `a <= b` is `!(b < a)`
    fn binary_not_swapped(&mut self, op: &str, ret: Result<Step, String>) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        let value = format!("$Not1<{op}<{b}, {a}>>");
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    fn eqz(&mut self, ret: Result<Step, String>) -> Result<Step, String> {
        let a = self.pop();
        let value = format!("$Eq<{a}, '{}'>", zero());
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    /// A shift by a constant is a character move; only a variable amount needs
    /// the bit-recursive version.
    fn shift(&mut self, fallback: &str, kind: ShiftKind, ret: Result<Step, String>) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        let value = match Self::literal(&b).map(|amount| amount & 31) {
            Some(0) => a.clone(),
            Some(amount) => {
                let helper = match kind {
                    ShiftKind::Left => self.shl_helper(amount),
                    ShiftKind::RightUnsigned => self.shr_helper(amount, false),
                    ShiftKind::RightSigned => self.shr_helper(amount, true),
                };
                // cheap enough to leave inline: one conditional, no adder
                let value = format!("{helper}<{a}>");
                self.shallow.insert(value.clone());
                self.push(value);
                return ret;
            }
            None => {
                let (a, b) = (self.operand(&a), self.operand(&b));
                format!("{fallback}<{a}, {b}>")
            }
        };
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    /// And/Or/Xor against a constant is one character choice per bit.
    ///
    /// Except for the bits an xor has to flip. A character inferred from a
    /// template pattern is typed `string`, which cannot index the flip table,
    /// and inferring it as `'0' | '1'` instead makes every position a union -
    /// 32 of those in one template literal is 2^32 combinations, which the
    /// checker refuses outright. ts-type-math walks the string one character at
    /// a time to stay clear of that, so xors with bits set go there.
    fn bitwise(&mut self, op: &str, fallback: &str, ret: Result<Step, String>) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        let flips = |constant: u32| op == "Xor" && constant != 0;
        let value = if let Some(constant) = Self::literal(&b).filter(|k| !flips(*k)) {
            let helper = self.mask_helper(op, constant);
            let value = format!("{helper}<{a}>");
            self.shallow.insert(value.clone());
            self.push(value);
            return ret;
        } else if let Some(constant) = Self::literal(&a).filter(|k| !flips(*k)) {
            let helper = self.mask_helper(op, constant);
            let value = format!("{helper}<{b}>");
            self.shallow.insert(value.clone());
            self.push(value);
            return ret;
        } else {
            let (a, b) = (self.operand(&a), self.operand(&b));
            format!("{fallback}<{a}, {b}>")
        };
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    /// Multiplying by a constant is a few shifts and adds; ts-type-math's long
    /// multiplication is only needed when both operands are unknown.
    fn multiply(&mut self, ret: Result<Step, String>) -> Result<Step, String> {
        let b = self.pop();
        let a = self.pop();
        let (value, constant) = match (Self::literal(&a), Self::literal(&b)) {
            (Some(k), _) => (b.clone(), Some(k)),
            (_, Some(k)) => (a.clone(), Some(k)),
            _ => (String::new(), None),
        };
        let expression = match constant {
            Some(0) => format!("'{}'", zero()),
            Some(1) => value,
            Some(k) if k.count_ones() <= 2 && k < 0x8000_0000 => {
                // sum of shifted copies, low bits first
                let mut terms = Vec::new();
                for bit in 0..31 {
                    if (k >> bit) & 1 == 1 {
                        if bit == 0 {
                            terms.push(value.clone());
                        } else {
                            let helper = self.shl_helper(bit);
                            terms.push(format!("{helper}<{value}>"));
                        }
                    }
                }
                let mut sum = terms[0].clone();
                for term in &terms[1..] {
                    sum = format!("Wasm.I32Add<{sum}, {term}>");
                }
                sum
            }
            _ => format!("Wasm.I32Mul<{a}, {b}>"),
        };
        let named = self.bind(&expression, "WasmValue");
        self.push(named);
        ret
    }

    fn unary(&mut self, op: &str, ret: Result<Step, String>) -> Result<Step, String> {
        let a = self.pop();
        let value = format!("{op}<{a}>");
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    fn stores_ret(&self, ret: Result<Step, String>) -> Result<Step, String> {
        ret
    }

    /// `base + static offset` is the most common add in any compiled program -
    /// every load and store has one - so it takes the same bit-step helpers as
    /// an ordinary constant add rather than a full adder.
    fn address(&mut self, offset: u64) -> String {
        let base = self.pop();
        if offset == 0 {
            return base;
        }
        let constant = offset as u32;
        if let Some(folded) = Self::literal(&base).map(|k| k.wrapping_add(constant)) {
            return format!("'{}'", bits32(folded as i32));
        }
        if let Some(steps) = Self::steps_for(constant, 4) {
            let mut value = base;
            for (index, (bit, down)) in steps.into_iter().enumerate() {
                if index > 0 {
                    value = self.bind_always(&value, "WasmValue");
                }
                let helper = self.step_helper(bit, down);
                value = format!("{helper}<{value}>");
                self.shallow.insert(value.clone());
            }
            return value;
        }
        let sum = format!("Wasm.I32Add<{base}, '{}'>", bits32(offset as i32));
        self.bind(&sum, "WasmValue")
    }

    /// Width in bytes touched by an access, so the check catches the tail of a
    /// word that starts in bounds and ends past the end.
    fn access_width(helper: &str) -> u32 {
        match helper {
            "$Load8U" | "$Load8S" | "$Store8" => 1,
            "$Load16U" | "$Load16S" | "$Store16" => 2,
            "$Load64" | "$Store64" => 8,
            _ => 4,
        }
    }

    /// Refuse an access that runs past the end of memory.
    ///
    /// wasm traps, and a trap is `never` here, so an out-of-bounds access has to
    /// make the whole result `never` rather than read or write a word the
    /// program never allocated. Without this a store past the end silently
    /// succeeded and a load past the end returned zero: `storechain8` strides
    /// 512 bytes from 4096 and leaves its declared page at n=124, where the
    /// engine traps and the type level happily kept going.
    ///
    /// Returns a prefix that reads as `<condition> extends true ?`, to be
    /// spliced in front of the access with `: never` after it. `None` means the
    /// access is provably in bounds and nothing is emitted at all.
    ///
    /// Nothing here is `bind`ed. A binding becomes a pipeline step that the
    /// block evaluates whether or not the guard needs it, and that is the whole
    /// cost: binding the comparisons cost storechain 7x (1188 -> 8305 us/iter).
    /// Inlined instead, they sit inside conditional branches, and a conditional
    /// type only instantiates the branch it takes.
    fn bounds_guard(&mut self, addr: &str, width: u32) -> Option<String> {
        // Nothing to name for an address the compiler can already decide.
        if let (Some(base), Some(limit)) = (Self::literal(addr), self.mem_limit) {
            return if u64::from(base) + u64::from(width) > u64::from(limit) {
                Some("never extends never ?".to_string())
            } else {
                None
            };
        }
        // The guard mentions the address two or three more times. Naming it
        // first measured the same either way (storechain32 3799 vs 3883 us/iter,
        // inside noise), so leave it inline rather than spend a pipeline slot.
        let one = bits32(1);
        let last = u64::from(width) - 1;
        // `addr + (width - 1)`, the last byte touched. Inlined, and so possibly
        // written twice below; both copies are inside lazy branches.
        let end = if last == 0 {
            addr.to_string()
        } else {
            format!("Wasm.I32Add<{addr}, '{}'>", bits32(last as i32))
        };
        // An access that wraps the top of the address space always traps.
        let wrapped = format!("Wasm.I32LtU<{end}, {addr}>");

        let limit = match self.mem_limit {
            Some(limit) => limit,
            None => {
                // The module can grow, so the bound is the live page count.
                // Read it here rather than at block entry: `memory.grow` rebinds
                // the global, and a guard holding the old name would keep
                // checking the size from before the grow.
                let pages = self.globals[self.pages_global?].clone();
                let bytes = format!("Wasm.I32Shl<{pages}, '{}'>", bits32(16));
                let over = format!("Wasm.I32LtU<{end}, {bytes}>");
                return Some(format!(
                    "({wrapped} extends '{one}' ? '{}' : {over}) extends '{one}' ?",
                    zero()
                ));
            }
        };

        // Decide it by looking at the characters, not by doing arithmetic.
        //
        // `I32Add` + `I32LtU` per access is what a bounds check naively costs,
        // and it is expensive: 4-6x on the storechain fixtures. But an address is
        // a 32-character binary string, and "is this below N" is a question
        // about its leading characters.
        //
        // Hiding the arithmetic in a conditional's untaken branch does not work -
        // tsc instantiates it anyway, measured at 660576 instantiations for
        // `A extends ... ? '1' : <8 adds>` against the same 660576 for the adds
        // alone. A pattern match is free: 658537, exactly the cost of mentioning
        // the address. So the test has to *be* the pattern match.
        //
        // The largest in-bounds address is `limit - width`. When that is one
        // below a power of two, every in-bounds address is exactly one whose top
        // bits are all zero, and a single template literal decides it - no
        // arithmetic, no wrap check (a wrapped address has a high bit set and
        // fails the same test). Memory limits are whole pages, so this covers
        // every power-of-two page count: 1, 2, 16, and each capacity the trie
        // rounds up to.
        if u64::from(limit).is_power_of_two() {
            let low = u64::from(limit).trailing_zeros() as usize;
            let zeros = "0".repeat(32 - low);
            // Below the limit exactly when the top bits are clear. A wrapped
            // address has a high bit set and fails this too, so the wrap check
            // comes for free.
            let inside = format!("{addr} extends `{zeros}${{string}}`");
            if width == 1 {
                // The pattern match is the test: routing it through
                // `? '1' : '0'` and then comparing that to '1' is a second
                // conditional per access, and the checker's own profile is
                // ~31% walking the conditionals a node sits inside.
                return Some(format!("{inside} ?"));
            }
            // A `width`-byte access also has to not run off the end, and only
            // the last `width - 1` addresses can. Those are exactly the ones
            // whose low `low` bits exceed `limit - width`, i.e. whose bottom
            // bits are all ones apart from the final few - still a pattern.
            // Enumerate them: `width - 1` templates, 1, 3 or 7 of them.
            let overhang: Vec<String> = ((u64::from(limit) - u64::from(width) + 1)
                ..u64::from(limit))
                .map(|value| {
                    let bits = format!("{value:032b}");
                    format!("`${{string}}{}`", &bits[32 - low..])
                })
                .collect();
            let over = overhang.join(" | ");
            // in bounds when the top bits are clear and it is not one of the
            // last `width - 1` addresses; both are pattern matches, so the
            // guard is two conditionals rather than four
            return Some(format!(
                "{inside} ? {addr} extends {over} ? never :"
            ));
        }
        // Otherwise fall back to comparing. doom declares 11 pages, which is not
        // a power of two, but its capacity is - the trie rounds up - so this is
        // the rare path.
        let over = format!("Wasm.I32LtU<{end}, '{}'>", bits32(limit as i32));
        Some(format!(
            "({wrapped} extends '{one}' ? '{}' : {over}) extends '{one}' ?",
            zero()
        ))
    }

    fn load(&mut self, helper: &str, offset: u64, ret: Result<Step, String>) -> Result<Step, String> {
        self.mem_ops += 1;
        let addr = self.address(offset);
        let addr = self.bind(&addr, "WasmValue");
        let guard = self.bounds_guard(&addr, Self::access_width(helper));
        let value = format!("{helper}<{}, {addr}>", self.memory);
        let value = match guard {
            Some(guard) => format!("({guard} {value} : never)"),
            None => value,
        };
        let named = self.bind(&value, "WasmValue");
        self.push(named);
        ret
    }

    fn store(&mut self, helper: &str, offset: u64, ret: Result<Step, String>) -> Result<Step, String> {
        let value = self.pop();
        let addr = self.address(offset);
        let addr = self.bind(&addr, "WasmValue");
        let value = self.bind(&value, "WasmValue");
        let guard = self.bounds_guard(&addr, Self::access_width(helper));
        let next = format!("{helper}<{}, {addr}, {value}>", self.memory);
        // A refused store poisons memory itself, so the trap cannot be
        // discarded by a later block that ignores the stored value.
        let next = match guard {
            Some(guard) => format!("({guard} {next} : never)"),
            None => next,
        };
        // every store is named: keeps the emitted text flat and gives the fuel
        // accounting something to count
        let name = format!("$m{}", self.next_temp);
        self.next_temp += 1;
        self.bindings
            .push((name.clone(), "$Node".to_string(), next));
        self.memory = name;
        self.stores += 1;
        self.mem_ops += 1;
        // loads read `self.memory`, so their text changes after a store anyway;
        // drop the cache entries that mention memory to be safe
        self.computed.retain(|expr, _| !expr.contains("$m"));
        self.stores_ret(ret)
    }
}

/// Constant folding for the operators the compiler emits. Same semantics as
/// wasm: wrapping arithmetic, comparisons yield 0 or 1.
fn fold(op: &str, a: u32, b: u32) -> Option<u32> {
    let sa = a as i32;
    let sb = b as i32;
    let value = match op {
        "Wasm.I32Add" => sa.wrapping_add(sb) as u32,
        "Wasm.I32Sub" => sa.wrapping_sub(sb) as u32,
        "Wasm.I32Mul" => sa.wrapping_mul(sb) as u32,
        "Wasm.I32And" => a & b,
        "Wasm.I32Or" => a | b,
        "Wasm.I32Xor" => a ^ b,
        "Wasm.I32Shl" => a.wrapping_shl(b & 31),
        "Wasm.I32ShrU" => a.wrapping_shr(b & 31),
        "Wasm.I32ShrS" => sa.wrapping_shr(b & 31) as u32,
        "Wasm.I32LtS" => (sa < sb) as u32,
        "Wasm.I32LtU" => (a < b) as u32,
        "Wasm.I32GtS" => (sa > sb) as u32,
        "Wasm.I32GtU" => (a > b) as u32,
        "Wasm.I32LeS" => (sa <= sb) as u32,
        "Wasm.I32LeU" => (a <= b) as u32,
        "Wasm.I32GeS" => (sa >= sb) as u32,
        "Wasm.I32GeU" => (a >= b) as u32,
        "$Eq" => (a == b) as u32,
        "$Ne" => (a != b) as u32,
        _ => return None,
    };
    Some(value)
}

enum ShiftKind {
    Left,
    RightUnsigned,
    RightSigned,
}

/// Replace every occurrence of a marker with a list, taking one of the
/// surrounding separators with it when the list is empty.
fn fill_marker(body: String, marker: &str, parts: &[String]) -> String {
    if !parts.is_empty() {
        return body.replace(marker, &parts.join(", "));
    }
    body.replace(&format!("{marker}, "), "")
        .replace(&format!(", {marker}"), "")
        .replace(marker, "")
}

/// Rewrite value names to reads of the state tuple: `$t7` becomes `$S[5]`.
///
/// Names not in the map - the fuel `$F`, helper aliases like `$Store32`, the
/// block's own `$S` - are left exactly as they are.
fn state_reads(text: &str, slots: &HashMap<String, usize>) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes: Vec<char> = text.chars().collect();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != '$' {
            out.push(bytes[at]);
            at += 1;
            continue;
        }
        let mut end = at + 1;
        while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == '_') {
            end += 1;
        }
        let name: String = bytes[at..end].iter().collect();
        match slots.get(&name) {
            Some(slot) => out.push_str(&format!("$S[{slot}]")),
            None => out.push_str(&name),
        }
        at = end;
    }
    out
}

/// tunable while the two limits are being measured
/// How many instructions a pipelined block may hold. Only a sanity bound on the
/// size of the generated text: the checker's cost in the length of a pipeline is
/// linear, measured flat out to 128 steps.
/// How many bindings a block that touches memory may hold. Sweepable, because
/// the right answer is a measurement: a longer block is fewer hops for the same
/// work, but inside a block the memory is an unevaluated store chain that every
/// later load walks.
///
/// There is a hard ceiling regardless. A block is a chain of nested `infer`s,
/// one per instruction, and tsgo resolves that shape in time exponential in its
/// depth: on a chain of i32 adds, 16 deep takes 19ms, 18 takes 57ms, 20 takes
/// 213ms, 22 takes 798ms, 24 takes 3.2s, and 32 had not finished after 17
/// minutes. So a long basic block is not slow, it is fatal, and nothing stops a
/// program from having one. 16 sits just under that onset.
///
/// This was 6, from a pixel-game sweep that read 6 and 8 and concluded shorter
/// is better. 8 is a local maximum, so those two points describe a slope that
/// does not exist. `cfg/bench/storechain.wat` - N sequential stores in one
/// basic block, then a load, which is the store-chain walk this cap exists to
/// bound - measured across the whole range, µs/iteration:
///
///                    d4    d6    d8   d12   d16   d24   d32   d48
///     8 stores     1155  1127  1190   861   894   878   882   904
///     16 stores    1473  1558  1657  1039   986  1131   985   970
///     32 stores    3405  3565  3752  2023  1989  2117  2074  2034
///
/// The chain itself is not the cost: 32 stores nested in one block (cap 48) is
/// the fastest shape measured. The hops bought to avoid it are, at ~130µs each.
///
/// Confirmed on doom, 200 chunks cold from `entry`, units/s:
///
///     cap 6: 1691 (fuel 1023)   cap 12: 1914   cap 16: 1975   cap 24: 1961
///
/// Fuel settles at 1260 rather than 1023 above 6, i.e. fewer TS2589 backoffs,
/// so the win is not just fewer hops. Past 16 it is flat.
///
/// Confirmed again end-to-end, not on a prefix: doom `entry` run to
/// termination, both caps reaching the same result 4677984.
///
///     cap  6: 4645 chunks, 2828.51s, 0.61 s/chunk
///     cap 16: 4053 chunks, 2534.99s, 0.63 s/chunk
///
/// A short cap makes each chunk slightly cheaper and buys 592 more of them,
/// losing 10.4% overall. Chunk count, not chunk cost, is what this cap sets.
///
/// Re-measured after `nest_limit()` became 0, since the two-cap split below was
/// justified by a store-chain cliff measured when memory blocks still rendered
/// as nested `infer`s. The cliff is softer under pipelining but has not gone
/// away, so the split stays. 200 iterations, 3 reps, µs/iter:
///
///                    d6    d16    d32    d48    d64
///     8 stores     1014   1125   1329   1305   1311
///     16 stores    1149   1107   1132   1075   1146
///     32 stores    2392   2164   2635   2677   2709
///
/// 16 is the floor for the long chain and 32+ is 20-25% worse, i.e. letting
/// memory blocks run to `pipeline_cap()` would cost real time. Doom block
/// counts flatten out just past this point too -- 11008 blocks at cap 8, 10282
/// at 16, 10169 at 24, 10129 at 64 -- so raising the cap buys progressively
/// fewer hops while making the chain each load walks longer.
fn depth_cap() -> usize {
    std::env::var("DEPTH_CAP")
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(16)
}

/// Blocks up to this many bindings are rendered as nested `infer`s, longer ones
/// as a pipeline. Coupled to `depth_cap()`: the cap decides how long a block
/// gets to be, this decides how a block of that length is rendered, so raising
/// one moves work across this boundary.
///
/// 0 means always pipeline. The old default of 10 meant that at `depth_cap()`
/// of 16 almost every doom block rendered nested -- only 5 blocks out of 11694
/// were pipelined, so the pipeline renderer was dead code and this boundary was
/// never actually measured.
///
/// A/B on doom `entry`, 200 chunks cold, same 379860 fuel units consumed and a
/// bit-identical saved state afterwards (466776 chars of memory, 4 frames, 2
/// globals, same call string, sha256 3c0767bb...):
///
///     NEST_LIMIT=100000 (all nested):   280.95s wall, 214.0s eval, 1352 units/s
///     NEST_LIMIT=0      (all pipeline): 213.03s wall, 155.3s eval, 1783 units/s
///
/// The pipeline form is 27% cheaper to check at identical output. Nesting an
/// `infer` chain makes the checker re-walk the prefix at each new binding; a
/// pipeline hands each step a name that is already resolved.
fn nest_limit() -> usize {
    std::env::var("NEST_LIMIT")
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(0)
}

/// Longest pure-arithmetic run rendered as one pipelined block.
///
/// 64 was chosen from a nested-vs-pipelined timing crossover, but never
/// checked against the checker's instantiation budget. It is over the cliff:
/// at cap 35 and above `bench/arith120` type-checks to `any` (TS2589 under a
/// bare `tsc`), and the driver reports that as "live value is not a word: any"
/// while halving fuel from 20000 down to 4 chasing a fuel bug that isn't
/// there. The last cap that resolves is 34.
///
/// The cliff is also the only thing this knob does. Verified against V8 on
/// arith120, caps 6/8/12/16/20/24/28/32/34 all land within noise of each
/// other - 2465-2707 us/iter - while the block count falls 15 -> 6. Longer
/// pipelines buy no time, so take the margin instead of the cliff edge.
fn pipeline_cap() -> usize {
    std::env::var("PIPELINE_CAP")
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(24)
}

/// fresh names for a block's incoming stack slots
fn fresh_stack(depth: usize) -> Vec<String> {
    (0..depth).map(|i| format!("$k{i}")).collect()
}

fn block_arity(blockty: &BlockType) -> Result<usize, String> {
    match blockty {
        BlockType::Empty => Ok(0),
        BlockType::Type(ValType::I32) => Ok(1),
        BlockType::Type(other) => Err(format!("block result type {other:?} is not supported")),
        BlockType::FuncType(_) => Err("multi-value block types are not supported".to_string()),
    }
}

fn indent(text: &str, spaces: usize) -> String {
    let pad = " ".repeat(spaces);
    text.replace('\n', &format!("\n{pad}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile(path: &str) -> String {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("could not read {path}: {e}"));
        CfgCompiler::new()
            .compile(&bytes)
            .unwrap_or_else(|e| panic!("{path} failed to compile: {e}"))
    }

    /// Every block must be able to stop. If any block lacks a fuel check, a long
    /// enough run has no way to hand control back and the evaluation dies with
    /// TS2589 instead of suspending.
    #[test]
    fn every_block_can_suspend() {
        let output = compile("packages/fixtures/pong-tiny.wasm");
        let mut blocks = 0;
        for declaration in output.split("\nexport type $b").skip(1) {
            blocks += 1;
            let name = declaration.split('<').next().unwrap_or("?");
            assert!(
                declaration.contains("$F extends `1"),
                "block {name} never checks fuel"
            );
            assert!(
                // frames-first suspend tuple: ['s', [['0_0', ...], ...$K], $M, ...]
                declaration.contains("['s', [["),
                "block {name} has no suspend path"
            );
        }
        assert!(blocks > 50, "expected pong to compile to many blocks, got {blocks}");
    }

    /// A loop must be entered through its header and left through a *separate*
    /// exit block: sharing them makes `end` jump backwards and the loop never
    /// terminates.
    #[test]
    fn loops_have_a_distinct_exit() {
        let output = compile("packages/playground/cfg/store64.wasm");
        let entry = output
            .split("export type $run<")
            .nth(1)
            .expect("no entry type for the export");
        let header = entry
            .split("$b0_")
            .nth(1)
            .and_then(|rest| rest.split('<').next())
            .expect("entry does not tail-call a block");
        // the header branches to itself (back-edge) and to something else (exit)
        let body = output
            .split(&format!("export type $b0_{header}<"))
            .nth(1)
            .expect("header block missing");
        let targets: Vec<&str> = body
            .split("$b0_")
            .skip(1)
            .filter_map(|rest| rest.split('<').next())
            .collect();
        assert!(
            targets.iter().any(|t| *t != header),
            "loop header only ever jumps to itself: {targets:?}"
        );
    }

    /// Exported functions become entry types that take fuel and memory.
    #[test]
    fn exports_become_entry_types() {
        let output = compile("packages/fixtures/pong-tiny.wasm");
        for export in ["frame", "score1", "score2"] {
            assert!(
                output.contains(&format!("export type ${export}<$F extends string, $M extends $Node")),
                "missing entry type for {export}"
            );
        }
    }

    /// Data segments are emitted as a concrete trie literal, sharing $Zero for
    /// everything untouched, so the first chunk starts from real memory.
    #[test]
    fn data_segments_become_a_trie_literal() {
        let output = compile("packages/fixtures/pong-tiny.wasm");
        let literal = output
            .split("export type $InitialMemory = ")
            .nth(1)
            .and_then(|rest| rest.split('\n').next())
            .expect("no initial memory");
        assert!(literal.starts_with('['), "initial memory is not a tuple");
        assert!(literal.contains("$Zero"), "initial memory does not share zero subtrees");
        // pong's state block starts with initialised=0, ball_x=20, ball_y=12
        assert!(
            literal.contains(&format!("['{}']", format!("{:032b}", 20))),
            "expected ball_x=20 in the data segment"
        );
    }

    /// i64 and floats are not supported yet; the compiler must say so rather
    /// than emit something that quietly disagrees with the engine.
    #[test]
    fn unsupported_types_are_rejected() {
        let bytes = std::fs::read("packages/conformance-tests/from-wat/single-i64add.wasm");
        if let Ok(bytes) = bytes {
            let error = CfgCompiler::new().compile(&bytes).unwrap_err();
            assert!(
                error.contains("i64") || error.contains("I64"),
                "expected an i64 complaint, got {error}"
            );
        }
    }
}

/// Which way a comparison points, so a constant operand can be turned into the
/// one form there is a helper for: `variable < bound`.
#[derive(Clone, Copy, PartialEq)]
enum Compare {
    Lt,
    Le,
    Gt,
    Ge,
}

impl Compare {
    /// the same question asked from the other side, for `constant OP variable`
    fn flipped(self) -> Self {
        match self {
            Compare::Lt => Compare::Gt,
            Compare::Gt => Compare::Lt,
            Compare::Le => Compare::Ge,
            Compare::Ge => Compare::Le,
        }
    }

    /// `(bound, negated)` for `variable < bound`, or None when the bound would
    /// have to be one past the end of the range
    fn as_less_than(self, constant: u32, signed: bool) -> Option<(u32, bool)> {
        let highest = if signed { 0x7fff_ffffu32 } else { 0xffff_ffff };
        match self {
            Compare::Lt => Some((constant, false)),
            Compare::Ge => Some((constant, true)),
            Compare::Le | Compare::Gt => {
                if constant == highest {
                    None
                } else {
                    Some((constant.wrapping_add(1), self == Compare::Gt))
                }
            }
        }
    }

    /// the answer when the bound is out of range: nothing is above the largest
    /// value, and everything is at or below it
    fn saturated(self, constant: u32, signed: bool) -> Option<bool> {
        let highest = if signed { 0x7fff_ffffu32 } else { 0xffff_ffff };
        if constant != highest {
            return None;
        }
        match self {
            Compare::Gt => Some(false),
            Compare::Le => Some(true),
            _ => None,
        }
    }
}

/// How many type parameters a generic list declares, stopping at the `>` that
/// closes it. Nested `<...>` and `[...]` do not end it and their commas do not
/// count.
fn top_level_params(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut count = 1usize;
    for ch in text.chars() {
        match ch {
            '<' | '[' | '(' => depth += 1,
            ']' | ')' => depth -= 1,
            '>' if depth == 0 => return Some(count),
            '>' => depth -= 1,
            ',' if depth == 0 => count += 1,
            _ => {}
        }
    }
    None
}

/// One node of the `$Enter` trie (see `emit_trampoline`): the arms of the block
/// named exactly `prefix`, then one arm per next character. A run of single
/// children is skipped, and a child holding one block is inlined, so the trie
/// is no deeper than the names need. Pushes the node's alias after its
/// children's.
fn enter_node(
    prefix: &str,
    keys: &[&str],
    arms: &BTreeMap<String, String>,
    gparams: &str,
    gargs: &str,
    defs: &mut Vec<String>,
) {
    let alias = |p: &str| if p.is_empty() { "$Enter".to_string() } else { format!("$E_{p}") };
    let mut body = String::new();
    if let Some(own) = arms.get(prefix) {
        body.push_str(own);
    }
    let mut children: BTreeMap<char, Vec<&str>> = BTreeMap::new();
    for &k in keys {
        if let Some(c) = k[prefix.len()..].chars().next() {
            children.entry(c).or_default().push(k);
        }
    }
    for (c, group) in children {
        let mut next = format!("{prefix}{c}");
        while !arms.contains_key(&next) {
            let mut after = group.iter().filter_map(|k| k[next.len()..].chars().next());
            let Some(first) = after.next() else { break };
            if after.any(|x| x != first) {
                break;
            }
            next.push(first);
        }
        if group.len() == 1 && group[0] == next {
            body.push_str(&arms[&next]);
            continue;
        }
        body.push_str(&format!(
            "  $T extends [`{next}${{string}}`, ...unknown[]] ? {}<$T, $F, $K, $M{gargs}, $V> :\n",
            alias(&next)
        ));
        enter_node(&next, &group, arms, gparams, gargs, defs);
    }
    defs.push(format!(
        "export type {}<$T, $F extends string, $K extends unknown[], $M extends $Node{gparams}, $V> =\n{body}  never\n",
        alias(prefix)
    ));
}
