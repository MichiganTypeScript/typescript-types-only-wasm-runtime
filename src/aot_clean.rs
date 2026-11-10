//! Clean AOT Compiler - WASM to TypeScript Types
//!
//! Design principles:
//! 1. Generate named intermediate types (like SSA form)
//! 2. Each state transition gets a unique type name
//! 3. No exponential expression growth
//! 4. Clean, readable output

use std::collections::HashMap;
use wasmparser::{FuncType, Parser, Payload, ValType};

/// Represents a value in the type system
#[derive(Debug, Clone)]
pub enum Value {
    /// Type parameter reference: $p0, $p1, etc.
    Param(String),
    /// Constant binary string: '00000000...'
    Const(String),
    /// Reference to an emitted named type, including its type arguments:
    /// `$v0_3<$S, $p0, $p1>`
    TypeRef(String),
    /// Binary operation: Wasm.I32Add<a, b>
    BinOp(&'static str, Box<Value>, Box<Value>),
    /// Unary operation: Wasm.I32Eqz<a>
    UnaryOp(&'static str, Box<Value>),
    /// Memory read: $ReadMem<state, addr> (aligned 32-bit read)
    MemRead { state: Box<State>, addr: Box<Value> },
    /// Unaligned I32 load: $LoadI32<state, addr> (handles unaligned addresses)
    LoadI32 { state: Box<State>, addr: Box<Value> },
    /// 16-bit load with cross-word support: $Load16<state, addr>
    Load16 { state: Box<State>, addr: Box<Value> },
    /// Conditional: cond extends '0..0' ? else_val : then_val
    Conditional {
        cond: Box<Value>,
        then_val: Box<Value>,
        else_val: Box<Value>,
    },
    /// Function call result: $GetValue<$func_N<state, args...>>
    CallResult { func_idx: u32, state: Box<State>, args: Vec<Value> },
    /// Indirect call result: $GetValue<$indirect_T<state, callee, args...>>
    IndirectCallResult { type_index: u32, callee: Box<Value>, state: Box<State>, args: Vec<Value> },
    /// Loop call result: $GetValue<$loop_F_N<state, args...>>
    LoopResult { name: String, state: Box<State>, args: Vec<Value> },
}

impl Value {
    fn to_ts(&self) -> String {
        match self {
            Value::Param(name) => name.clone(),
            Value::Const(bits) => format!("'{}'", bits),
            Value::TypeRef(name) => name.clone(),
            Value::BinOp(op, a, b) => format!("{}<{}, {}>", op, a.to_ts(), b.to_ts()),
            Value::UnaryOp(op, a) => format!("{}<{}>", op, a.to_ts()),
            Value::MemRead { state, addr } => format!("$ReadMem<{}, {}>", state.to_ts(), addr.to_ts()),
            Value::LoadI32 { state, addr } => format!("$LoadI32<{}, {}>", state.to_ts(), addr.to_ts()),
            Value::Load16 { state, addr } => format!("$Load16<{}, {}>", state.to_ts(), addr.to_ts()),
            Value::Conditional { cond, then_val, else_val } => format!(
                "({} extends '00000000000000000000000000000000' ? {} : {})",
                cond.to_ts(), else_val.to_ts(), then_val.to_ts()
            ),
            Value::CallResult { func_idx, state, args } => {
                let all_args: Vec<String> = std::iter::once(state.to_ts())
                    .chain(args.iter().map(|a| a.to_ts()))
                    .collect();
                format!("$GetValue<$func_{}_impl<{}>>", func_idx, all_args.join(", "))
            }
            Value::IndirectCallResult { type_index, callee, state, args } => {
                let all_args: Vec<String> = [state.to_ts(), callee.to_ts()]
                    .into_iter()
                    .chain(args.iter().map(|a| a.to_ts()))
                    .collect();
                format!("$GetValue<$indirect_{}<{}>>", type_index, all_args.join(", "))
            }
            Value::LoopResult { name, state, args } => {
                let all_args: Vec<String> = std::iter::once(state.to_ts())
                    .chain(args.iter().map(|a| a.to_ts()))
                    .collect();
                format!("$GetValue<{}<{}>>", name, all_args.join(", "))
            }
        }
    }

    fn complexity(&self) -> usize {
        match self {
            Value::Param(_) | Value::Const(_) | Value::TypeRef(_) => 1,
            Value::BinOp(_, a, b) => 1 + a.complexity() + b.complexity(),
            Value::UnaryOp(_, a) => 1 + a.complexity(),
            Value::MemRead { state, addr } | Value::LoadI32 { state, addr } | Value::Load16 { state, addr } => {
                1 + state.complexity() + addr.complexity()
            }
            Value::Conditional { cond, then_val, else_val } => {
                1 + cond.complexity() + then_val.complexity() + else_val.complexity()
            }
            Value::CallResult { args, .. } | Value::LoopResult { args, .. } => {
                1 + args.iter().map(|a| a.complexity()).sum::<usize>()
            }
            Value::IndirectCallResult { callee, args, .. } => {
                1 + callee.complexity() + args.iter().map(|a| a.complexity()).sum::<usize>()
            }
        }
    }
}

/// Represents a state in the type system
#[derive(Debug, Clone)]
pub enum State {
    /// Initial state parameter: $S
    Initial,
    /// Reference to an emitted named state type, including its type arguments:
    /// `$s0_3<$S, $p0, $p1>`
    Named(String),
    /// Memory write: $WriteMem<state, addr, value>
    MemWrite { state: Box<State>, addr: Value, value: Value },
    /// 8-bit store with read-modify-write: $Store8<state, addr, value>
    Store8 { state: Box<State>, addr: Value, value: Value },
    /// 16-bit store with read-modify-write: $Store16<state, addr, value>
    Store16 { state: Box<State>, addr: Value, value: Value },
    /// 32-bit store with cross-word support: $Store32<state, addr, value>
    Store32 { state: Box<State>, addr: Value, value: Value },
    /// 64-bit store (writes two 32-bit cells): $Store64<state, addr, value>
    Store64 { state: Box<State>, addr: Value, value: Value },
    /// State from function call: $GetState<$func_N<...>>
    CallState { func_idx: u32, prev_state: Box<State>, args: Vec<Value> },
    /// State from indirect call: $GetState<$indirect_T<...>>
    IndirectCallState { type_index: u32, callee: Value, prev_state: Box<State>, args: Vec<Value> },
    /// Conditional state: cond ? state1 : state2
    Conditional { cond: Value, then_state: Box<State>, else_state: Box<State> },
}

impl State {
    fn to_ts(&self) -> String {
        match self {
            State::Initial => "$S".to_string(),
            State::Named(name) => name.clone(),
            State::MemWrite { state, addr, value } => {
                format!("$WriteMem<{}, {}, {}>", state.to_ts(), addr.to_ts(), value.to_ts())
            }
            State::Store8 { state, addr, value } => {
                format!("$Store8<{}, {}, {}>", state.to_ts(), addr.to_ts(), value.to_ts())
            }
            State::Store16 { state, addr, value } => {
                format!("$Store16<{}, {}, {}>", state.to_ts(), addr.to_ts(), value.to_ts())
            }
            State::Store32 { state, addr, value } => {
                format!("$Store32<{}, {}, {}>", state.to_ts(), addr.to_ts(), value.to_ts())
            }
            State::Store64 { state, addr, value } => {
                format!("$Store64<{}, {}, {}>", state.to_ts(), addr.to_ts(), value.to_ts())
            }
            State::CallState { func_idx, prev_state, args } => {
                let all_args: Vec<String> = std::iter::once(prev_state.to_ts())
                    .chain(args.iter().map(|a| a.to_ts()))
                    .collect();
                format!("$GetState<$func_{}_impl<{}>>", func_idx, all_args.join(", "))
            }
            State::IndirectCallState { type_index, callee, prev_state, args } => {
                let all_args: Vec<String> = [prev_state.to_ts(), callee.to_ts()]
                    .into_iter()
                    .chain(args.iter().map(|a| a.to_ts()))
                    .collect();
                format!("$GetState<$indirect_{}<{}>>", type_index, all_args.join(", "))
            }
            State::Conditional { cond, then_state, else_state } => {
                format!(
                    "({} extends '00000000000000000000000000000000' ? {} : {})",
                    cond.to_ts(), else_state.to_ts(), then_state.to_ts()
                )
            }
        }
    }

    fn complexity(&self) -> usize {
        match self {
            State::Initial | State::Named(_) => 1,
            State::MemWrite { state, .. } | State::Store8 { state, .. } | State::Store16 { state, .. }
            | State::Store32 { state, .. } | State::Store64 { state, .. } => {
                1 + state.complexity()
            }
            State::CallState { prev_state, .. } => 1 + prev_state.complexity(),
            State::IndirectCallState { callee, prev_state, .. } => {
                1 + callee.complexity() + prev_state.complexity()
            }
            State::Conditional { then_state, else_state, .. } => {
                1 + then_state.complexity() + else_state.complexity()
            }
        }
    }
}

/// Emitted type definition
#[derive(Debug)]
pub struct TypeDef {
    pub name: String,
    pub params: Vec<String>,
    pub body: String,
}

/// Function compiler with SSA-style state management
pub struct FuncCompiler<'a> {
    function_index: u32,
    ops: Vec<wasmparser::Operator<'a>>,
    pos: usize,

    // Value stack (like WASM stack)
    stack: Vec<Value>,

    // Current state (threaded through operations)
    current_state: State,

    // Local variables (params + locals)
    locals: HashMap<u32, Value>,

    // Control flow
    label_stack: Vec<LabelInfo>,

    // Type generation
    type_counter: u32,
    emitted_types: Vec<TypeDef>,

    // Function info
    func_types: &'a [FuncType],
    func_type_indices: &'a [u32],
    num_params: usize,
    num_func_imports: u32,  // Number of imported functions (for call index adjustment)

    // Loop handling
    loop_counter: u32,

    // Instruction counter for complexity limits
    instruction_count: u32,

    // Type indices reached via call_indirect (dispatch types must be emitted for these)
    indirect_types: Vec<u32>,

    // Parameter names introduced by the loops we are currently inside, so that
    // types extracted from a loop body declare (and receive) them
    loop_scopes: Vec<Vec<String>>,
}

#[derive(Debug, Clone)]
struct LabelInfo {
    is_loop: bool,
    loop_id: Option<u32>,
    entry_state: State,
    entry_locals: HashMap<u32, Value>,
}

// Complexity threshold for creating named intermediate types
const STATE_COMPLEXITY_THRESHOLD: usize = 5;

// Max instructions per function before bailing out (prevents hangs on huge functions)
const MAX_INSTRUCTIONS_PER_FUNCTION: u32 = 10000;

impl<'a> FuncCompiler<'a> {
    pub fn new(
        function_index: u32,
        ops: Vec<wasmparser::Operator<'a>>,
        params: &[(String, ValType)],
        num_locals: u32,
        func_types: &'a [FuncType],
        func_type_indices: &'a [u32],
        num_func_imports: u32,
    ) -> Self {
        let mut locals = HashMap::new();
        let num_params = params.len();

        // Initialize parameters
        for (i, _) in params.iter().enumerate() {
            locals.insert(i as u32, Value::Param(format!("$p{}", i)));
        }

        // Initialize locals to zero
        for i in num_params as u32..num_locals {
            locals.insert(i, Value::Const("00000000000000000000000000000000".to_string()));
        }

        Self {
            function_index,
            ops,
            pos: 0,
            stack: Vec::new(),
            current_state: State::Initial,
            locals,
            label_stack: Vec::new(),
            type_counter: 0,
            emitted_types: Vec::new(),
            func_types,
            func_type_indices,
            num_params,
            num_func_imports,
            loop_counter: 0,
            instruction_count: 0,
            indirect_types: Vec::new(),
            loop_scopes: Vec::new(),
        }
    }

    /// Every value name an extracted type can refer to: the enclosing
    /// function's parameters plus the parameters of the loops we are inside
    fn scope_names(&self) -> Vec<String> {
        (0..self.num_params)
            .map(|i| format!("$p{}", i))
            .chain(self.loop_scopes.iter().flatten().cloned())
            .collect()
    }

    /// Type parameters every extracted type needs: the incoming state plus
    /// everything in scope, because extracted bodies refer to them
    fn scope_decls(&self) -> Vec<String> {
        std::iter::once("$S extends $State".to_string())
            .chain(
                self.scope_names()
                    .into_iter()
                    .map(|name| format!("{} extends WasmValue", name)),
            )
            .collect()
    }

    /// Type arguments matching `scope_decls`
    fn scope_args(&self) -> Vec<String> {
        std::iter::once("$S".to_string())
            .chain(self.scope_names())
            .collect()
    }

    /// If state is complex, emit a named type and return reference to it
    fn maybe_name_state(&mut self) -> State {
        if self.current_state.complexity() > STATE_COMPLEXITY_THRESHOLD {
            // Names must be unique across the whole module, not just this function
            let name = format!("$s{}_{}", self.function_index, self.type_counter);
            self.type_counter += 1;

            self.emitted_types.push(TypeDef {
                name: name.clone(),
                params: self.scope_decls(),
                body: self.current_state.to_ts(),
            });

            self.current_state = State::Named(format!("{}<{}>", name, self.scope_args().join(", ")));
        }
        self.current_state.clone()
    }

    /// If value is complex, emit a named type and return TypeRef
    fn maybe_name_value(&mut self, value: Value) -> Value {
        if value.complexity() > STATE_COMPLEXITY_THRESHOLD {
            let name = format!("$v{}_{}", self.function_index, self.type_counter);
            self.type_counter += 1;

            self.emitted_types.push(TypeDef {
                name: name.clone(),
                params: self.scope_decls(),
                body: value.to_ts(),
            });

            Value::TypeRef(format!("{}<{}>", name, self.scope_args().join(", ")))
        } else {
            value
        }
    }

    /// Push a value to the stack, naming it if complex
    fn push_value(&mut self, value: Value) {
        let named = self.maybe_name_value(value);
        self.stack.push(named);
    }

    /// Update current state with a new transformation
    fn update_state(&mut self, new_state: State) {
        self.current_state = new_state;
        self.maybe_name_state();
    }

    /// Process all operators and return (final_state, result_value, emitted_types, indirect_types)
    pub fn compile(mut self) -> Result<(State, Option<Value>, Vec<TypeDef>, Vec<u32>), String> {
        self.process_block(false)?;
        if std::env::var_os("AOT_DEBUG").is_some() {
            eprintln!(
                "[AOT] function {} finished at op {}/{} with {} value(s) on the stack",
                self.function_index,
                self.pos,
                self.ops.len(),
                self.stack.len()
            );
        }
        let result = self.stack.pop();
        Ok((
            self.current_state,
            result,
            self.emitted_types,
            self.indirect_types,
        ))
    }

    fn process_block(&mut self, stop_at_else: bool) -> Result<bool, String> {
        use wasmparser::Operator::*;

        while self.pos < self.ops.len() {
            let op = self.ops[self.pos].clone();
            self.pos += 1;
            self.instruction_count += 1;

            // Bail out if function is too complex
            if self.instruction_count > MAX_INSTRUCTIONS_PER_FUNCTION {
                return Err("Function too complex - exceeded instruction limit".to_string());
            }

            match op {
                End => return Ok(false),
                Else => return Ok(stop_at_else),

                // Constants
                I32Const { value } => {
                    self.push_value(Value::Const(format!("{:032b}", value)));
                }
                I64Const { value } => {
                    self.push_value(Value::Const(format!("{:064b}", value)));
                }

                // Local access
                LocalGet { local_index } => {
                    if let Some(val) = self.locals.get(&local_index) {
                        self.push_value(val.clone());
                    }
                }
                LocalSet { local_index } => {
                    if let Some(val) = self.stack.pop() {
                        let named = self.maybe_name_value(val);
                        self.locals.insert(local_index, named);
                    }
                }
                LocalTee { local_index } => {
                    if let Some(val) = self.stack.last() {
                        let named = self.maybe_name_value(val.clone());
                        self.locals.insert(local_index, named);
                    }
                }

                // Arithmetic
                I32Add => self.binary_op("Wasm.I32Add"),
                I32Sub => self.binary_op("Wasm.I32Sub"),
                I32Mul => self.binary_op("Wasm.I32Mul"),
                I32DivS => self.binary_op("Wasm.I32DivS"),
                I32DivU => self.binary_op("Wasm.I32DivU"),
                I32RemS => self.binary_op("Wasm.I32RemS"),
                I32RemU => self.binary_op("Wasm.I32RemU"),
                I32And => self.binary_op("Wasm.I32And"),
                I32Or => self.binary_op("Wasm.I32Or"),
                I32Xor => self.binary_op("Wasm.I32Xor"),
                I32Shl => self.binary_op("Wasm.I32Shl"),
                I32ShrU => self.binary_op("Wasm.I32ShrU"),
                I32ShrS => self.binary_op("Wasm.I32ShrS"),
                I32Rotl => self.binary_op("Wasm.I32Rotl"),
                I32Rotr => self.binary_op("Wasm.I32Rotr"),

                // Comparison
                I32Eq => self.binary_op("Wasm.I32Eq"),
                I32Ne => self.binary_op("Wasm.I32Neq"),
                I32LtS => self.binary_op("Wasm.I32LtS"),
                I32LtU => self.binary_op("Wasm.I32LtU"),
                I32GtS => self.binary_op("Wasm.I32GtS"),
                I32GtU => self.binary_op("Wasm.I32GtU"),
                I32LeS => self.binary_op("Wasm.I32LeS"),
                I32LeU => self.binary_op("Wasm.I32LeU"),
                I32GeS => self.binary_op("Wasm.I32GeS"),
                I32GeU => self.binary_op("Wasm.I32GeU"),
                I32Eqz => self.unary_op("Wasm.I32Eqz"),
                I32Clz => self.unary_op("Wasm.I32Clz"),
                I32Ctz => self.unary_op("Wasm.I32Ctz"),
                I32Popcnt => self.unary_op("Wasm.I32Popcnt"),

                // Memory
                I32Load { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr, memarg.offset);
                    let state = self.current_state.clone();
                    // Use LoadI32 which handles potentially unaligned addresses
                    self.push_value(Value::LoadI32 {
                        state: Box::new(state.clone()),
                        addr: Box::new(final_addr),
                    });
                }

                I32Store { memarg } => {
                    let value = self.stack.pop().unwrap_or(Value::Param("$val".to_string()));
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr, memarg.offset);
                    // Use Store32 which handles potentially unaligned addresses
                    let new_state = State::Store32 {
                        state: Box::new(self.current_state.clone()),
                        addr: final_addr,
                        value,
                    };
                    self.update_state(new_state);
                }

                I32Load8U { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    let raw = Value::MemRead {
                        state: Box::new(state),
                        addr: Box::new(final_addr.clone()),
                    };
                    // Compute byte offset: (addr & 3) * 8
                    let byte_offset = Value::BinOp(
                        "Wasm.I32And",
                        Box::new(final_addr),
                        Box::new(Value::Const("00000000000000000000000000000011".to_string())),  // 3
                    );
                    let shift_amount = Value::BinOp(
                        "Wasm.I32Shl",
                        Box::new(byte_offset),
                        Box::new(Value::Const("00000000000000000000000000000011".to_string())),  // 3 (multiply by 8)
                    );
                    // Shift right to extract correct byte
                    let shifted = Value::BinOp("Wasm.I32ShrU", Box::new(raw), Box::new(shift_amount));
                    // Mask to 8 bits: AND with 0xFF
                    self.push_value(Value::BinOp(
                        "Wasm.I32And",
                        Box::new(shifted),
                        Box::new(Value::Const("00000000000000000000000011111111".to_string())),
                    ));
                }

                I32Load8S { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    let raw = Value::MemRead {
                        state: Box::new(state),
                        addr: Box::new(final_addr.clone()),
                    };
                    // Compute byte offset: (addr & 3) * 8
                    let byte_offset = Value::BinOp(
                        "Wasm.I32And",
                        Box::new(final_addr),
                        Box::new(Value::Const("00000000000000000000000000000011".to_string())),  // 3
                    );
                    let shift_amount = Value::BinOp(
                        "Wasm.I32Shl",
                        Box::new(byte_offset),
                        Box::new(Value::Const("00000000000000000000000000000011".to_string())),  // 3 (multiply by 8)
                    );
                    // Shift right to extract correct byte
                    let shifted = Value::BinOp("Wasm.I32ShrU", Box::new(raw), Box::new(shift_amount));
                    // Sign extend from 8 bits: (value << 24) >> 24 (arithmetic)
                    let shifted_left = Value::BinOp(
                        "Wasm.I32Shl",
                        Box::new(shifted),
                        Box::new(Value::Const("00000000000000000000000000011000".to_string())), // 24
                    );
                    self.push_value(Value::BinOp(
                        "Wasm.I32ShrS",
                        Box::new(shifted_left),
                        Box::new(Value::Const("00000000000000000000000000011000".to_string())), // 24
                    ));
                }

                I32Load16U { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    // Use Load16 which handles cross-word case at byte offset 3
                    self.push_value(Value::Load16 {
                        state: Box::new(state),
                        addr: Box::new(final_addr),
                    });
                }

                I32Load16S { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    // Use Load16 which handles cross-word case, then sign extend
                    let raw = Value::Load16 {
                        state: Box::new(state),
                        addr: Box::new(final_addr),
                    };
                    // Sign extend from 16 bits: (value << 16) >> 16 (arithmetic)
                    let shifted_left = Value::BinOp(
                        "Wasm.I32Shl",
                        Box::new(raw),
                        Box::new(Value::Const("00000000000000000000000000010000".to_string())), // 16
                    );
                    self.push_value(Value::BinOp(
                        "Wasm.I32ShrS",
                        Box::new(shifted_left),
                        Box::new(Value::Const("00000000000000000000000000010000".to_string())), // 16
                    ));
                }

                I32Store8 { memarg } => {
                    let value = self.stack.pop().unwrap_or(Value::Param("$val".to_string()));
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr, memarg.offset);
                    // Use Store8 for read-modify-write to preserve other bytes
                    let new_state = State::Store8 {
                        state: Box::new(self.current_state.clone()),
                        addr: final_addr,
                        value,
                    };
                    self.update_state(new_state);
                }

                I32Store16 { memarg } => {
                    let value = self.stack.pop().unwrap_or(Value::Param("$val".to_string()));
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr, memarg.offset);
                    // Use Store16 for read-modify-write to preserve other bytes
                    let new_state = State::Store16 {
                        state: Box::new(self.current_state.clone()),
                        addr: final_addr,
                        value,
                    };
                    self.update_state(new_state);
                }

                // I64 Memory operations
                I64Load { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();

                    // Read low 32 bits using LoadI32 (handles unaligned addresses)
                    let low_read = Value::LoadI32 {
                        state: Box::new(state.clone()),
                        addr: Box::new(final_addr.clone()),
                    };
                    // Extend low to 64 bits (unsigned)
                    let low_64 = Value::UnaryOp("Wasm.I64ExtendI32U", Box::new(low_read));

                    // Read high 32 bits at addr+4 using LoadI32 (handles unaligned addresses)
                    let high_addr = Value::BinOp(
                        "Wasm.I32Add",
                        Box::new(final_addr),
                        Box::new(Value::Const("00000000000000000000000000000100".to_string())), // 4
                    );
                    let high_read = Value::LoadI32 {
                        state: Box::new(state),
                        addr: Box::new(high_addr),
                    };
                    // Extend high to 64 bits (unsigned)
                    let high_64 = Value::UnaryOp("Wasm.I64ExtendI32U", Box::new(high_read));
                    // Shift high left by 32
                    let high_shifted = Value::BinOp(
                        "Wasm.I64Shl",
                        Box::new(high_64),
                        Box::new(Value::Const("0000000000000000000000000000000000000000000000000000000000100000".to_string())), // 32
                    );
                    // Combine: low | (high << 32)
                    self.push_value(Value::BinOp(
                        "Wasm.I64Or",
                        Box::new(low_64),
                        Box::new(high_shifted),
                    ));
                }

                I64Store { memarg } => {
                    let value = self.stack.pop().unwrap_or(Value::Param("$val".to_string()));
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr, memarg.offset);
                    // Use Store64 which writes two 32-bit cells (low at addr, high at addr+4)
                    let new_state = State::Store64 {
                        state: Box::new(self.current_state.clone()),
                        addr: final_addr,
                        value,
                    };
                    self.update_state(new_state);
                }

                I64Load8U { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    let raw = Value::MemRead {
                        state: Box::new(state),
                        addr: Box::new(final_addr.clone()),
                    };
                    // Compute byte offset: (addr & 3) * 8
                    let byte_offset = Value::BinOp(
                        "Wasm.I32And",
                        Box::new(final_addr),
                        Box::new(Value::Const("00000000000000000000000000000011".to_string())),  // 3
                    );
                    let shift_amount = Value::BinOp(
                        "Wasm.I32Shl",
                        Box::new(byte_offset),
                        Box::new(Value::Const("00000000000000000000000000000011".to_string())),  // 3 (multiply by 8)
                    );
                    // Do byte extraction in 32-bit (memory is 32-bit)
                    let shifted = Value::BinOp("Wasm.I32ShrU", Box::new(raw), Box::new(shift_amount));
                    // Mask to 8 bits
                    let masked = Value::BinOp(
                        "Wasm.I32And",
                        Box::new(shifted),
                        Box::new(Value::Const("00000000000000000000000011111111".to_string())),
                    );
                    // Extend to 64 bits (unsigned)
                    self.push_value(Value::UnaryOp("Wasm.I64ExtendI32U", Box::new(masked)));
                }

                I64Load8S { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    let raw = Value::MemRead {
                        state: Box::new(state),
                        addr: Box::new(final_addr.clone()),
                    };
                    // Compute byte offset: (addr & 3) * 8
                    let byte_offset = Value::BinOp(
                        "Wasm.I32And",
                        Box::new(final_addr),
                        Box::new(Value::Const("00000000000000000000000000000011".to_string())),  // 3
                    );
                    let shift_amount = Value::BinOp(
                        "Wasm.I32Shl",
                        Box::new(byte_offset),
                        Box::new(Value::Const("00000000000000000000000000000011".to_string())),  // 3 (multiply by 8)
                    );
                    // Do byte extraction in 32-bit (memory is 32-bit)
                    let shifted = Value::BinOp("Wasm.I32ShrU", Box::new(raw), Box::new(shift_amount));
                    // Sign extend from 8 bits: (value << 24) >> 24 (arithmetic)
                    let shifted_left = Value::BinOp(
                        "Wasm.I32Shl",
                        Box::new(shifted),
                        Box::new(Value::Const("00000000000000000000000000011000".to_string())), // 24
                    );
                    let sign_extended = Value::BinOp(
                        "Wasm.I32ShrS",
                        Box::new(shifted_left),
                        Box::new(Value::Const("00000000000000000000000000011000".to_string())), // 24
                    );
                    // Extend to 64 bits (signed)
                    self.push_value(Value::UnaryOp("Wasm.I64ExtendI32S", Box::new(sign_extended)));
                }

                I64Load16U { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    // Use Load16 which handles cross-word case, then extend to 64 bits
                    let raw = Value::Load16 {
                        state: Box::new(state),
                        addr: Box::new(final_addr),
                    };
                    // Extend to 64 bits (unsigned)
                    self.push_value(Value::UnaryOp("Wasm.I64ExtendI32U", Box::new(raw)));
                }

                I64Load16S { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    // Use Load16 which handles cross-word case
                    let raw = Value::Load16 {
                        state: Box::new(state),
                        addr: Box::new(final_addr),
                    };
                    // Sign extend from 16 bits to 32, then extend to 64
                    let shifted_left = Value::BinOp(
                        "Wasm.I32Shl",
                        Box::new(raw),
                        Box::new(Value::Const("00000000000000000000000000010000".to_string())), // 16
                    );
                    let sign_extended = Value::BinOp(
                        "Wasm.I32ShrS",
                        Box::new(shifted_left),
                        Box::new(Value::Const("00000000000000000000000000010000".to_string())), // 16
                    );
                    // Extend to 64 bits (signed)
                    self.push_value(Value::UnaryOp("Wasm.I64ExtendI32S", Box::new(sign_extended)));
                }

                I64Load32U { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    // Use LoadI32 for potentially unaligned 32-bit load
                    let raw = Value::LoadI32 {
                        state: Box::new(state),
                        addr: Box::new(final_addr),
                    };
                    // Extend to 64 bits (unsigned)
                    self.push_value(Value::UnaryOp("Wasm.I64ExtendI32U", Box::new(raw)));
                }

                I64Load32S { memarg } => {
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr.clone(), memarg.offset);
                    let state = self.current_state.clone();
                    // Use LoadI32 for potentially unaligned 32-bit load
                    let raw = Value::LoadI32 {
                        state: Box::new(state),
                        addr: Box::new(final_addr),
                    };
                    // Sign extend to 64 bits
                    self.push_value(Value::UnaryOp("Wasm.I64ExtendI32S", Box::new(raw)));
                }

                I64Store8 { memarg } => {
                    let value = self.stack.pop().unwrap_or(Value::Param("$val".to_string()));
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr, memarg.offset);
                    // Truncate to i32 for Store8 (only low 8 bits matter)
                    let truncated = Value::UnaryOp("Wasm.I32WrapI64", Box::new(value));
                    let new_state = State::Store8 {
                        state: Box::new(self.current_state.clone()),
                        addr: final_addr,
                        value: truncated,
                    };
                    self.update_state(new_state);
                }

                I64Store16 { memarg } => {
                    let value = self.stack.pop().unwrap_or(Value::Param("$val".to_string()));
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr, memarg.offset);
                    // Truncate to i32 for Store16 (only low 16 bits matter)
                    let truncated = Value::UnaryOp("Wasm.I32WrapI64", Box::new(value));
                    let new_state = State::Store16 {
                        state: Box::new(self.current_state.clone()),
                        addr: final_addr,
                        value: truncated,
                    };
                    self.update_state(new_state);
                }

                I64Store32 { memarg } => {
                    let value = self.stack.pop().unwrap_or(Value::Param("$val".to_string()));
                    let addr = self.stack.pop().unwrap_or(Value::Param("$addr".to_string()));
                    let final_addr = self.add_offset(addr, memarg.offset);
                    // Truncate to i32 for 32-bit store, use Store32 for unaligned support
                    let truncated = Value::UnaryOp("Wasm.I32WrapI64", Box::new(value));
                    let new_state = State::Store32 {
                        state: Box::new(self.current_state.clone()),
                        addr: final_addr,
                        value: truncated,
                    };
                    self.update_state(new_state);
                }

                // Function calls
                Call { function_index } => {
                    if function_index < self.num_func_imports {
                        return Err(format!(
                            "Unsupported imported function call {} in function {}",
                            function_index, self.function_index
                        ));
                    }

                    // Adjust index for imports: defined function 0 is at func_type_indices[0]
                    let local_func_idx = function_index - self.num_func_imports;
                    let type_idx = self.func_type_indices.get(local_func_idx as usize);
                    let func_type = type_idx.and_then(|idx| self.func_types.get(*idx as usize));

                    if let Some(func_type) = func_type {
                        let num_params = func_type.params().len();
                        let mut args = Vec::new();
                        for _ in 0..num_params {
                            if let Some(arg) = self.stack.pop() {
                                args.push(arg);
                            }
                        }
                        args.reverse();

                        let returns_value = !func_type.results().is_empty();
                        let prev_state = self.current_state.clone();

                        // Update state to reflect the call (use local index for generated type names)
                        let new_state = State::CallState {
                            func_idx: local_func_idx,
                            prev_state: Box::new(prev_state.clone()),
                            args: args.clone(),
                        };
                        self.update_state(new_state);

                        // If function returns a value, push it
                        if returns_value {
                            self.push_value(Value::CallResult {
                                func_idx: local_func_idx,
                                state: Box::new(prev_state),
                                args,
                            });
                        }
                    }
                }

                // Control flow
                If { blockty: _ } => {
                    let cond = self.stack.pop().unwrap_or(Value::Param("$cond".to_string()));
                    let state_before = self.current_state.clone();
                    let locals_before = self.locals.clone();

                    // Process then branch
                    self.label_stack.push(LabelInfo {
                        is_loop: false,
                        loop_id: None,
                        entry_state: state_before.clone(),
                        entry_locals: locals_before.clone(),
                    });
                    let has_else = self.process_block(true)?;
                    let then_state = self.current_state.clone();
                    let then_result = self.stack.pop();
                    self.label_stack.pop();

                    if has_else {
                        // Save then_locals before resetting
                        let then_locals = self.locals.clone();

                        // Reset for else branch
                        self.current_state = state_before.clone();
                        self.locals = locals_before.clone();

                        self.label_stack.push(LabelInfo {
                            is_loop: false,
                            loop_id: None,
                            entry_state: state_before,
                            entry_locals: HashMap::new(),
                        });
                        self.process_block(false)?;
                        let else_state = self.current_state.clone();
                        let else_result = self.stack.pop();
                        let else_locals = self.locals.clone();
                        self.label_stack.pop();

                        // Merge states
                        let merged_state = State::Conditional {
                            cond: cond.clone(),
                            then_state: Box::new(then_state),
                            else_state: Box::new(else_state),
                        };
                        self.update_state(merged_state);

                        // Merge locals conditionally
                        for (idx, then_val) in &then_locals {
                            if let Some(else_val) = else_locals.get(idx) {
                                self.locals.insert(*idx, Value::Conditional {
                                    cond: Box::new(cond.clone()),
                                    then_val: Box::new(then_val.clone()),
                                    else_val: Box::new(else_val.clone()),
                                });
                            }
                        }

                        // Merge results if both branches have values
                        if let (Some(tv), Some(ev)) = (then_result, else_result) {
                            self.push_value(Value::Conditional {
                                cond: Box::new(cond),
                                then_val: Box::new(tv),
                                else_val: Box::new(ev),
                            });
                        }
                    } else {
                        // Save then_locals before merging
                        let then_locals = self.locals.clone();

                        // No else - merge then_state with state_before (fallthrough)
                        // If condition is true: use then_state with side effects
                        // If condition is false: use state_before (no changes)
                        let merged_state = State::Conditional {
                            cond: cond.clone(),
                            then_state: Box::new(then_state),
                            else_state: Box::new(state_before),
                        };
                        self.update_state(merged_state);

                        // Merge locals: if condition true use then_locals, else use locals_before
                        for (idx, then_val) in &then_locals {
                            if let Some(before_val) = locals_before.get(idx) {
                                self.locals.insert(*idx, Value::Conditional {
                                    cond: Box::new(cond.clone()),
                                    then_val: Box::new(then_val.clone()),
                                    else_val: Box::new(before_val.clone()),
                                });
                            }
                        }

                        // If then branch had a result, it should be conditional too
                        // but typically if-without-else doesn't produce values
                        if let Some(tr) = then_result {
                            self.push_value(tr);
                        }
                    }
                }

                Block { blockty: _ } => {
                    self.label_stack.push(LabelInfo {
                        is_loop: false,
                        loop_id: None,
                        entry_state: self.current_state.clone(),
                        entry_locals: self.locals.clone(),
                    });
                    self.process_block(false)?;
                    self.label_stack.pop();
                }

                Loop { blockty: _ } => {
                    let loop_id = self.loop_counter;
                    self.loop_counter += 1;

                    let entry = LabelInfo {
                        is_loop: true,
                        loop_id: Some(loop_id),
                        entry_state: self.current_state.clone(),
                        entry_locals: self.locals.clone(),
                    };
                    self.label_stack.push(entry.clone());

                    // Replace locals with loop parameters for body processing
                    let loop_locals = self.loop_locals();
                    let own_params = self.loop_param_names(loop_id, &loop_locals);
                    for (slot, &idx) in loop_locals.iter().enumerate() {
                        self.locals.insert(idx, Value::Param(own_params[slot].clone()));
                    }

                    // Types extracted from the body need these parameters too
                    self.loop_scopes.push(own_params.clone());
                    self.process_block(false)?;
                    self.loop_scopes.pop();
                    self.label_stack.pop();

                    // After loop: the result local comes from the loop call (set
                    // up by the br_if handler). Anything else still holding a
                    // loop parameter would escape its scope, so fall back to the
                    // value it had on entry.
                    let indices: Vec<u32> = self.locals.keys().copied().collect();
                    for idx in indices {
                        let escapes = self
                            .locals
                            .get(&idx)
                            .map(|value| {
                                let ts = value.to_ts();
                                own_params.iter().any(|name| Self::references(&ts, name))
                            })
                            .unwrap_or(false);
                        if escapes {
                            if let Some(entry_value) = entry.entry_locals.get(&idx).cloned() {
                                self.locals.insert(idx, entry_value);
                            }
                        }
                    }

                    // The same applies to the state itself
                    let state_ts = self.current_state.to_ts();
                    if own_params
                        .iter()
                        .any(|name| Self::references(&state_ts, name))
                    {
                        self.current_state = entry.entry_state.clone();
                    }
                }

                Br { relative_depth } => {
                    self.skip_to_end(relative_depth)?;
                }

                BrIf { relative_depth } => {
                    let cond = self.stack.pop().unwrap_or(Value::Param("$cond".to_string()));

                    // Check if branching to a loop
                    let target_idx = self.label_stack.len().saturating_sub(1 + relative_depth as usize);
                    if let Some(target) = self.label_stack.get(target_idx) {
                        if target.is_loop {
                            if let Some(loop_id) = target.loop_id {
                                // Generate loop type and set up loop call
                                self.generate_loop_type(loop_id, &cond);
                            }
                        }
                    }
                }

                BrTable { targets } => {
                    let _index = self.stack.pop();
                    self.skip_to_end(targets.default())?;
                }

                Return => return Ok(false),
                Unreachable => {}

                // Select
                Select { .. } => {
                    let cond = self.stack.pop().unwrap_or(Value::Param("$c".to_string()));
                    let else_val = self.stack.pop().unwrap_or(Value::Param("$f".to_string()));
                    let then_val = self.stack.pop().unwrap_or(Value::Param("$t".to_string()));
                    self.push_value(Value::Conditional {
                        cond: Box::new(cond),
                        then_val: Box::new(then_val),
                        else_val: Box::new(else_val),
                    });
                }

                Drop => { self.stack.pop(); }
                Nop => {}

                // Global operations (simplified)
                GlobalGet { global_index } => {
                    self.push_value(Value::Param(format!("$g{}", global_index)));
                }
                GlobalSet { .. } => {
                    self.stack.pop();
                }

                // Memory operations
                MemorySize { .. } => {
                    self.push_value(Value::Param("$memsize".to_string()));
                }
                MemoryGrow { .. } => {
                    self.stack.pop();
                    self.push_value(Value::Param("$memgrow".to_string()));
                }

                // I64 operations
                I64Add => self.binary_op("Wasm.I64Add"),
                I64Sub => self.binary_op("Wasm.I64Sub"),
                I64Mul => self.binary_op("Wasm.I64Mul"),
                I64And => self.binary_op("Wasm.I64And"),
                I64Or => self.binary_op("Wasm.I64Or"),
                I64Xor => self.binary_op("Wasm.I64Xor"),
                I64Shl => self.binary_op("Wasm.I64Shl"),
                I64ShrU => self.binary_op("Wasm.I64ShrU"),
                I64ShrS => self.binary_op("Wasm.I64ShrS"),
                I64Eq => self.binary_op("Wasm.I64Eq"),
                I64Ne => self.binary_op("Wasm.I64Neq"),
                I64LtS => self.binary_op("Wasm.I64LtS"),
                I64LtU => self.binary_op("Wasm.I64LtU"),
                I64GtS => self.binary_op("Wasm.I64GtS"),
                I64GtU => self.binary_op("Wasm.I64GtU"),
                I64Eqz => self.unary_op("Wasm.I64Eqz"),

                // Conversions
                I32WrapI64 => self.unary_op("Wasm.I32WrapI64"),
                I32Extend16S => self.unary_op("Wasm.I32Extend16S"),
                I64ExtendI32S => self.unary_op("Wasm.I64ExtendI32S"),
                I64ExtendI32U => self.unary_op("Wasm.I64ExtendI32U"),

                // Indirect function calls: dispatch on the runtime table index
                CallIndirect { type_index, table_index, .. } => {
                    if table_index != 0 {
                        return Err(format!(
                            "Unsupported call_indirect on table {} in function {} (only table 0 is supported)",
                            table_index, self.function_index
                        ));
                    }

                    let func_type = self
                        .func_types
                        .get(type_index as usize)
                        .ok_or_else(|| {
                            format!(
                                "No type at idx {} for call_indirect in function {}",
                                type_index, self.function_index
                            )
                        })?
                        .clone();

                    // Stack layout: [args..., callee_index]
                    let callee = self
                        .stack
                        .pop()
                        .unwrap_or(Value::Param("$callee".to_string()));

                    let mut args = Vec::new();
                    for _ in 0..func_type.params().len() {
                        if let Some(arg) = self.stack.pop() {
                            args.push(arg);
                        }
                    }
                    args.reverse();

                    if !self.indirect_types.contains(&type_index) {
                        self.indirect_types.push(type_index);
                    }

                    let returns_value = !func_type.results().is_empty();
                    let prev_state = self.current_state.clone();

                    self.update_state(State::IndirectCallState {
                        type_index,
                        callee: callee.clone(),
                        prev_state: Box::new(prev_state.clone()),
                        args: args.clone(),
                    });

                    if returns_value {
                        self.push_value(Value::IndirectCallResult {
                            type_index,
                            callee: Box::new(callee),
                            state: Box::new(prev_state),
                            args,
                        });
                    }
                }
                op => {
                    return Err(format!(
                        "Unsupported operator {:?} in function {}",
                        op, self.function_index
                    ));
                }
            }
        }
        Ok(false)
    }

    fn binary_op(&mut self, op: &'static str) {
        let b = self.stack.pop().unwrap_or(Value::Param("$b".to_string()));
        let a = self.stack.pop().unwrap_or(Value::Param("$a".to_string()));
        self.push_value(Value::BinOp(op, Box::new(a), Box::new(b)));
    }

    fn unary_op(&mut self, op: &'static str) {
        let a = self.stack.pop().unwrap_or(Value::Param("$a".to_string()));
        self.push_value(Value::UnaryOp(op, Box::new(a)));
    }

    fn add_offset(&self, addr: Value, offset: u64) -> Value {
        if offset > 0 {
            Value::BinOp(
                "Wasm.I32Add",
                Box::new(addr),
                Box::new(Value::Const(format!("{:032b}", offset))),
            )
        } else {
            addr
        }
    }

    fn skip_to_end(&mut self, depth: u32) -> Result<(), String> {
        // Skip 'depth + 1' levels of blocks (depth is 0-indexed from current block)
        // depth=0 means skip to the end of the current block
        // depth=1 means skip to the end of the parent block, etc.
        let mut levels_to_skip = depth + 1;
        let mut block_depth = 0u32;

        while self.pos < self.ops.len() && levels_to_skip > 0 {
            use wasmparser::Operator::*;
            match &self.ops[self.pos] {
                If { .. } | Block { .. } | Loop { .. } => {
                    block_depth += 1;
                }
                End => {
                    if block_depth == 0 {
                        // Exiting a block we're tracking
                        levels_to_skip -= 1;
                    } else {
                        block_depth -= 1;
                    }
                }
                _ => {}
            }
            self.pos += 1;
        }
        Ok(())
    }

    /// The parameter names a loop introduces for its loop-carried locals
    fn loop_param_names(&self, loop_id: u32, loop_locals: &[u32]) -> Vec<String> {
        loop_locals
            .iter()
            .map(|idx| format!("$l{}_{}", loop_id, idx))
            .collect()
    }

    /// Locals that a loop carries across iterations
    fn loop_locals(&self) -> Vec<u32> {
        (self.num_params as u32..self.locals.len() as u32).collect()
    }

    /// Does `ts` refer to the type parameter `name`?
    fn references(ts: &str, name: &str) -> bool {
        let mut rest = ts;
        while let Some(at) = rest.find(name) {
            let after = &rest[at + name.len()..];
            // `$l3_1` must not match `$l3_12`
            if !after.starts_with(|c: char| c.is_ascii_digit()) {
                return true;
            }
            rest = after;
        }
        false
    }

    fn generate_loop_type(&mut self, loop_id: u32, condition: &Value) {
        let loop_locals = self.loop_locals();
        let own_params = self.loop_param_names(loop_id, &loop_locals);

        // Loop names must be unique across the module, not just this function
        let loop_name = format!("$loop_{}_{}", self.function_index, loop_id);

        // The loop's own parameters are already part of the current scope (they
        // were introduced when the loop was entered), so the scope is the
        // complete parameter list: state, function params, enclosing loop
        // params, then this loop's params
        let params = self.scope_decls();

        // Recursive call: everything stays in scope, but this loop's parameters
        // advance to the values its locals hold after one iteration
        let recurse_args: Vec<String> = self
            .scope_args()
            .into_iter()
            .map(|arg| match own_params.iter().position(|name| *name == arg) {
                Some(slot) => self
                    .locals
                    .get(&loop_locals[slot])
                    .map(|v| v.to_ts())
                    .unwrap_or(arg),
                None => arg,
            })
            .collect();

        // Get result (last local is typically the result)
        let result = loop_locals.last()
            .and_then(|idx| self.locals.get(idx))
            .map(|v| v.to_ts())
            .unwrap_or_else(|| "never".to_string());

        // Generate: condition != 0 ? recurse : exit with result
        let body = format!(
            "{} extends '00000000000000000000000000000000' ? [$S, {}] : {}<{}>",
            condition.to_ts(),
            result,
            loop_name,
            recurse_args.join(", ")
        );

        // A loop with several `br_if`s back to its header reaches this more than
        // once - keep the first definition so the name stays unique
        if !self.emitted_types.iter().any(|t| t.name == loop_name) {
            self.emitted_types.push(TypeDef {
                name: loop_name.clone(),
                params,
                body,
            });
        }

        // Update locals to reference loop result for code after the loop
        if let Some(target) = self
            .label_stack
            .iter()
            .find(|l| l.loop_id == Some(loop_id))
            .cloned()
        {
            // The call arguments mirror the parameter list, with this loop's
            // parameters bound to the values the locals had on loop entry
            let args: Vec<Value> = self
                .scope_names()
                .into_iter()
                .map(|name| match own_params.iter().position(|own| *own == name) {
                    Some(slot) => target
                        .entry_locals
                        .get(&loop_locals[slot])
                        .cloned()
                        .unwrap_or(Value::Param(name)),
                    None => Value::Param(name),
                })
                .collect();

            // Set result local to GetValue of loop call
            if let Some(&result_idx) = loop_locals.last() {
                self.locals.insert(result_idx, Value::LoopResult {
                    name: loop_name,
                    state: Box::new(target.entry_state.clone()),
                    args,
                });
            }
        }
    }
}

/// Main AOT compiler
pub struct CleanAotCompiler {
    func_types: Vec<FuncType>,
    func_type_indices: Vec<u32>,
    import_func_type_indices: Vec<u32>,  // Type indices for imported functions
    memory_segments: Vec<(u32, Vec<u8>)>,
    globals: Vec<(u32, i64)>,
    num_func_imports: u32,  // Number of imported functions (affects call indexing)
    exported_func_idx: Option<u32>,  // Index of exported "entry" function (relative to defined functions)
    used_imports: std::collections::HashSet<u32>,  // Track which imports are called
    table_funcs: HashMap<u32, u32>,  // Table slot -> function index (for call_indirect dispatch)
}

impl CleanAotCompiler {
    pub fn new() -> Self {
        Self {
            func_types: Vec::new(),
            func_type_indices: Vec::new(),
            import_func_type_indices: Vec::new(),
            memory_segments: Vec::new(),
            globals: Vec::new(),
            num_func_imports: 0,
            exported_func_idx: None,
            used_imports: std::collections::HashSet::new(),
            table_funcs: HashMap::new(),
        }
    }

    pub fn compile(&mut self, bytes: &[u8]) -> Result<String, String> {
        self.collect_metadata(bytes)?;
        let functions = self.compile_functions(bytes)?;
        Ok(self.emit_typescript(&functions))
    }

    pub(crate) fn collect_metadata(&mut self, bytes: &[u8]) -> Result<(), String> {
        for payload in Parser::new(0).parse_all(bytes) {
            let payload = payload.map_err(|e| e.to_string())?;
            match payload {
                Payload::ImportSection(reader) => {
                    for import in reader {
                        let import = import.map_err(|e| e.to_string())?;
                        if let wasmparser::TypeRef::Func(type_idx) = import.ty {
                            self.import_func_type_indices.push(type_idx);
                            self.num_func_imports += 1;
                        }
                    }
                }
                Payload::TypeSection(reader) => {
                    for rec_group in reader {
                        let rec_group = rec_group.map_err(|e| e.to_string())?;
                        for sub_type in rec_group.into_types() {
                            if let wasmparser::CompositeType::Func(func_type) = sub_type.composite_type {
                                self.func_types.push(func_type);
                            }
                        }
                    }
                }
                Payload::FunctionSection(reader) => {
                    for type_idx in reader {
                        self.func_type_indices.push(type_idx.map_err(|e| e.to_string())?);
                    }
                }
                Payload::GlobalSection(reader) => {
                    let mut idx = 0u32;
                    for global in reader {
                        let global = global.map_err(|e| e.to_string())?;
                        for op in global.init_expr.get_operators_reader() {
                            if let Ok(wasmparser::Operator::I32Const { value }) = op {
                                self.globals.push((idx, value as i64));
                            }
                        }
                        idx += 1;
                    }
                }
                Payload::ElementSection(reader) => {
                    for element in reader {
                        let element = element.map_err(|e| e.to_string())?;
                        self.collect_table_entries(element)?;
                    }
                }
                Payload::DataSection(reader) => {
                    for data in reader {
                        let data = data.map_err(|e| e.to_string())?;
                        if let wasmparser::DataKind::Active { offset_expr, .. } = data.kind {
                            let mut offset = 0u32;
                            for op in offset_expr.get_operators_reader() {
                                if let Ok(wasmparser::Operator::I32Const { value }) = op {
                                    offset = value as u32;
                                }
                            }
                            self.memory_segments.push((offset, data.data.to_vec()));
                        }
                    }
                }
                Payload::ExportSection(reader) => {
                    for export in reader {
                        let export = export.map_err(|e| e.to_string())?;
                        if let wasmparser::ExternalKind::Func = export.kind {
                            // Store the local function index (subtract imports)
                            let func_idx = export.index;
                            if func_idx >= self.num_func_imports {
                                self.exported_func_idx = Some(func_idx - self.num_func_imports);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Record the (statically known) contents of table 0 so call_indirect can
    /// be turned into a dispatch over the possible targets.
    fn collect_table_entries(&mut self, element: wasmparser::Element) -> Result<(), String> {
        let wasmparser::Element { kind, items, .. } = element;

        // Only active segments initialize the table before the program runs;
        // passive/declared segments are only reachable via table.init, which is
        // not supported here.
        let base = match kind {
            wasmparser::ElementKind::Active { table_index, offset_expr } => {
                if table_index.unwrap_or(0) != 0 {
                    return Ok(());
                }
                let mut base = 0u32;
                for op in offset_expr.get_operators_reader() {
                    if let Ok(wasmparser::Operator::I32Const { value }) = op {
                        base = value as u32;
                    }
                }
                base
            }
            _ => return Ok(()),
        };

        match items {
            wasmparser::ElementItems::Functions(funcs) => {
                for (slot, func_idx) in funcs.into_iter().enumerate() {
                    let func_idx = func_idx.map_err(|e| e.to_string())?;
                    self.table_funcs.insert(base + slot as u32, func_idx);
                }
            }
            wasmparser::ElementItems::Expressions(_, exprs) => {
                for (slot, expr) in exprs.into_iter().enumerate() {
                    let expr = expr.map_err(|e| e.to_string())?;
                    for op in expr.get_operators_reader() {
                        if let Ok(wasmparser::Operator::RefFunc { function_index }) = op {
                            self.table_funcs.insert(base + slot as u32, function_index);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Resolve the signature of a function index (imports included)
    fn func_type_of(&self, func_idx: u32) -> Option<&FuncType> {
        let type_idx = if func_idx < self.num_func_imports {
            *self.import_func_type_indices.get(func_idx as usize)?
        } else {
            *self
                .func_type_indices
                .get((func_idx - self.num_func_imports) as usize)?
        };
        self.func_types.get(type_idx as usize)
    }

    /// Emit a `$indirect_T` dispatch type: a chain of conditionals mapping the
    /// runtime table index to the matching function implementation.
    pub(crate) fn emit_indirect_dispatch(&self, out: &mut String, type_index: u32, entry_idx: usize) {
        let Some(func_type) = self.func_types.get(type_index as usize) else {
            return;
        };
        let num_params = func_type.params().len();

        let mut params = vec![
            "$S extends $State".to_string(),
            "$callee extends WasmValue".to_string(),
        ];
        for i in 0..num_params {
            params.push(format!("$a{} extends WasmValue", i));
        }

        let mut call_args = vec!["$S".to_string()];
        for i in 0..num_params {
            call_args.push(format!("$a{}", i));
        }

        let mut slots: Vec<(u32, u32)> = self
            .table_funcs
            .iter()
            .map(|(slot, func_idx)| (*slot, *func_idx))
            .collect();
        slots.sort_unstable();

        let mut body = String::new();
        let mut targets = 0;
        for (slot, func_idx) in slots {
            // Only functions whose signature matches the call_indirect type can
            // be reached; everything else traps at runtime.
            if self.func_type_of(func_idx) != Some(func_type) {
                continue;
            }
            // Calling an import indirectly would need an import implementation,
            // which this compiler does not model - leave it as a trap.
            if func_idx < self.num_func_imports {
                continue;
            }
            let local_idx = func_idx - self.num_func_imports;
            let name = if local_idx as usize == entry_idx {
                "$entry_impl".to_string()
            } else {
                format!("$func_{}_impl", local_idx)
            };
            body.push_str(&format!(
                "  $callee extends '{:032b}' ? {}<{}> :\n",
                slot,
                name,
                call_args.join(", ")
            ));
            targets += 1;
        }
        // No matching table entry: call_indirect traps
        body.push_str("  never");

        out.push_str(&format!(
            "// call_indirect dispatch for type {} ({} reachable target{})\ntype $indirect_{}<{}> =\n{}\n\n",
            type_index,
            targets,
            if targets == 1 { "" } else { "s" },
            type_index,
            params.join(", "),
            body
        ));
    }

    fn compile_functions(&self, bytes: &[u8]) -> Result<Vec<CompiledFunc>, String> {
        let mut functions = Vec::new();
        let mut func_index = 0u32;

        for payload in Parser::new(0).parse_all(bytes) {
            let payload = payload.map_err(|e| e.to_string())?;
            if let Payload::CodeSectionEntry(body) = payload {
                eprintln!("[AOT] Compiling function {}/{}", func_index, self.func_type_indices.len());

                let type_idx = self.func_type_indices.get(func_index as usize)
                    .ok_or_else(|| format!("No type for func {}", func_index))?;
                let func_type = self.func_types.get(*type_idx as usize)
                    .ok_or_else(|| format!("No type at idx {}", type_idx))?;

                let func = self.compile_function(func_index, func_type, &body)
                    .map_err(|e| format!("Failed to compile function {}: {}", func_index, e))?;
                functions.push(func);
                func_index += 1;
            }
        }
        Ok(functions)
    }

    fn compile_function(
        &self,
        func_index: u32,
        func_type: &FuncType,
        body: &wasmparser::FunctionBody,
    ) -> Result<CompiledFunc, String> {
        let params: Vec<(String, ValType)> = func_type.params()
            .iter()
            .enumerate()
            .map(|(i, vt)| (format!("$p{}", i), vt.clone()))
            .collect();

        let ops_reader = body.get_operators_reader().map_err(|e| e.to_string())?;
        let ops: Vec<wasmparser::Operator> = ops_reader
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        let locals_reader = body.get_locals_reader().map_err(|e| e.to_string())?;
        let mut num_locals = params.len() as u32;
        for local in locals_reader {
            let (count, _) = local.map_err(|e| e.to_string())?;
            num_locals += count;
        }

        let compiler = FuncCompiler::new(
            func_index,
            ops,
            &params,
            num_locals,
            &self.func_types,
            &self.func_type_indices,
            self.num_func_imports,
        );

        let (final_state, result, extra_types, indirect_types) = compiler.compile()?;

        Ok(CompiledFunc {
            index: func_index,
            params,
            result_type: func_type.results().first().cloned(),
            state_ts: final_state.to_ts(),
            result_ts: result.map(|r| r.to_ts()),
            extra_types,
            indirect_types,
        })
    }

    fn emit_typescript(&self, functions: &[CompiledFunc]) -> String {
        let mut out = String::new();

        // Header
        out.push_str("import type { Wasm, WasmValue, Convert } from 'ts-type-math'\n\n");

        // State helpers
        out.push_str("type $State = { memory: Record<string, string> }\n\n");
        out.push_str("type $AlignAddr<A extends WasmValue> = Wasm.I32And<A, '11111111111111111111111111111100'>\n\n");
        out.push_str("type $ByteOffset<A extends WasmValue> = Wasm.I32And<A, '00000000000000000000000000000011'>\n\n");
        out.push_str("type $ReadMem<S extends $State, A extends WasmValue> =\n");
        out.push_str("  $AlignAddr<A> extends infer AA extends WasmValue\n");
        out.push_str("    ? AA extends keyof S['memory'] ? S['memory'][AA] : '00000000000000000000000000000000'\n");
        out.push_str("    : never\n\n");
        // Unaligned 32-bit load: reads from potentially unaligned address
        // If aligned (offset=0), just read word0. Otherwise combine two words.
        out.push_str("type $LoadI32<S extends $State, A extends WasmValue> =\n");
        out.push_str("  $ByteOffset<A> extends '00000000000000000000000000000000'\n");
        out.push_str("    ? $ReadMem<S, A>\n");
        out.push_str("    : Wasm.I32Or<\n");
        out.push_str("        Wasm.I32ShrU<$ReadMem<S, A>, Wasm.I32Shl<$ByteOffset<A>, '00000000000000000000000000000011'>>,\n");
        out.push_str("        Wasm.I32Shl<$ReadMem<S, Wasm.I32Add<$AlignAddr<A>, '00000000000000000000000000000100'>>, Wasm.I32Sub<'00000000000000000000000000100000', Wasm.I32Shl<$ByteOffset<A>, '00000000000000000000000000000011'>>>\n");
        out.push_str("      >\n\n");

        // 16-bit load with cross-word support (handles byte offset 3)
        out.push_str("type $Load16<S extends $State, A extends WasmValue> =\n");
        out.push_str("  $ByteOffset<A> extends '00000000000000000000000000000011'\n");  // offset 3: cross-word
        out.push_str("    ? Wasm.I32Or<\n");
        out.push_str("        Wasm.I32ShrU<$ReadMem<S, A>, '00000000000000000000000000011000'>,\n");  // byte at offset 3 shifted right 24
        out.push_str("        Wasm.I32Shl<Wasm.I32And<$ReadMem<S, Wasm.I32Add<$AlignAddr<A>, '00000000000000000000000000000100'>>, '00000000000000000000000011111111'>, '00000000000000000000000000001000'>\n");  // byte at offset 0 of next word shifted left 8
        out.push_str("      >\n");
        out.push_str("    : Wasm.I32And<\n");  // normal case: shift and mask
        out.push_str("        Wasm.I32ShrU<$ReadMem<S, A>, Wasm.I32Shl<$ByteOffset<A>, '00000000000000000000000000000011'>>,\n");
        out.push_str("        '00000000000000001111111111111111'\n");
        out.push_str("      >\n\n");

        out.push_str("type $WriteMem<S extends $State, A extends WasmValue, V extends WasmValue> = {\n");
        out.push_str("  memory: S['memory'] & Record<$AlignAddr<A>, V>\n");
        out.push_str("}\n\n");

        // Sub-word store helpers: read-modify-write to preserve other bytes
        // 8-bit mask at byte offset position
        out.push_str("type $Byte8Mask<Offset extends WasmValue> = Wasm.I32Shl<'00000000000000000000000011111111', Wasm.I32Shl<Offset, '00000000000000000000000000000011'>>\n");
        // NOT of 8-bit mask
        out.push_str("type $Not8Mask<Offset extends WasmValue> = Wasm.I32Xor<$Byte8Mask<Offset>, '11111111111111111111111111111111'>\n\n");

        // Store8: read-modify-write to preserve other bytes in word
        out.push_str("type $Store8<S extends $State, Addr extends WasmValue, Val extends WasmValue> =\n");
        out.push_str("  $WriteMem<S, Addr, Wasm.I32Or<\n");
        out.push_str("    Wasm.I32And<$ReadMem<S, Addr>, $Not8Mask<$ByteOffset<Addr>>>,\n");
        out.push_str("    Wasm.I32Shl<Wasm.I32And<Val, '00000000000000000000000011111111'>, Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>\n");
        out.push_str("  >>\n\n");

        // Store16: read-modify-write with cross-word support (handles byte offset 3)
        out.push_str("type $Store16<S extends $State, Addr extends WasmValue, Val extends WasmValue> =\n");
        out.push_str("  $ByteOffset<Addr> extends '00000000000000000000000000000011'\n");  // offset 3: cross-word
        out.push_str("    ? $WriteMem<\n");
        out.push_str("        $WriteMem<S, Addr, Wasm.I32Or<\n");  // write low byte to word0 at offset 3
        out.push_str("          Wasm.I32And<$ReadMem<S, Addr>, '00000000111111111111111111111111'>,\n");  // keep bytes 0-2
        out.push_str("          Wasm.I32Shl<Wasm.I32And<Val, '00000000000000000000000011111111'>, '00000000000000000000000000011000'>\n");  // put low byte at offset 3
        out.push_str("        >>,\n");
        out.push_str("        Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>,\n");  // next word
        out.push_str("        Wasm.I32Or<\n");  // write high byte to word1 at offset 0
        out.push_str("          Wasm.I32And<$ReadMem<S, Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>>, '11111111111111111111111100000000'>,\n");  // keep bytes 1-3
        out.push_str("          Wasm.I32ShrU<Wasm.I32And<Val, '00000000000000001111111100000000'>, '00000000000000000000000000001000'>\n");  // put high byte at offset 0
        out.push_str("        >\n");
        out.push_str("      >\n");
        out.push_str("    : $WriteMem<S, Addr, Wasm.I32Or<\n");  // normal case: single word RMW
        out.push_str("        Wasm.I32And<$ReadMem<S, Addr>, Wasm.I32Xor<Wasm.I32Shl<'00000000000000001111111111111111', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>, '11111111111111111111111111111111'>>,\n");
        out.push_str("        Wasm.I32Shl<Wasm.I32And<Val, '00000000000000001111111111111111'>, Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>\n");
        out.push_str("      >>\n\n");

        // Store32: unaligned 32-bit store with cross-word support
        out.push_str("type $Store32<S extends $State, Addr extends WasmValue, Val extends WasmValue> =\n");
        out.push_str("  $ByteOffset<Addr> extends '00000000000000000000000000000000'\n");  // aligned: simple write
        out.push_str("    ? $WriteMem<S, Addr, Val>\n");
        out.push_str("    : $WriteMem<\n");  // unaligned: write to two words
        out.push_str("        $WriteMem<S, Addr, Wasm.I32Or<\n");  // word0: keep low bits, write high portion of value
        out.push_str("          Wasm.I32And<$ReadMem<S, Addr>, Wasm.I32Sub<Wasm.I32Shl<'00000000000000000000000000000001', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>, '00000000000000000000000000000001'>>,\n");
        out.push_str("          Wasm.I32Shl<Val, Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>\n");
        out.push_str("        >>,\n");
        out.push_str("        Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>,\n");  // word1
        out.push_str("        Wasm.I32Or<\n");  // word1: write low portion of value, keep high bits
        out.push_str("          Wasm.I32And<$ReadMem<S, Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>>, Wasm.I32Shl<'11111111111111111111111111111111', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>>,\n");
        out.push_str("          Wasm.I32ShrU<Val, Wasm.I32Sub<'00000000000000000000000000100000', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>>\n");
        out.push_str("        >\n");
        out.push_str("      >\n\n");

        // Store64: 64-bit store writes two 32-bit cells (low at addr, high at addr+4)
        out.push_str("type $Store64<S extends $State, Addr extends WasmValue, Val extends WasmValue> =\n");
        out.push_str("  $Store32<\n");
        out.push_str("    $Store32<S, Addr, Wasm.I32WrapI64<Val>>,\n");  // store low 32 bits
        out.push_str("    Wasm.I32Add<Addr, '00000000000000000000000000000100'>,\n");  // addr + 4
        out.push_str("    Wasm.I32WrapI64<Wasm.I64ShrU<Val, '0000000000000000000000000000000000000000000000000000000000100000'>>\n");  // store high 32 bits
        out.push_str("  >\n\n");

        out.push_str("type $GetState<T> = T extends [infer S, any] ? S : T\n");
        out.push_str("type $GetValue<T> = T extends [any, infer V] ? V : never\n\n");

        // Initial memory (4-byte chunks)
        out.push_str("type $InitialMemory = {\n");
        let mut mem_bytes: std::collections::HashMap<u32, u8> = std::collections::HashMap::new();
        let mut max_addr = 0u32;
        for (offset, data) in &self.memory_segments {
            for (i, byte) in data.iter().enumerate() {
                let addr = offset + i as u32;
                mem_bytes.insert(addr, *byte);
                max_addr = max_addr.max(addr);
            }
        }
        let mut addr = 0u32;
        while addr <= max_addr {
            let b0 = mem_bytes.get(&addr).copied().unwrap_or(0);
            let b1 = mem_bytes.get(&(addr + 1)).copied().unwrap_or(0);
            let b2 = mem_bytes.get(&(addr + 2)).copied().unwrap_or(0);
            let b3 = mem_bytes.get(&(addr + 3)).copied().unwrap_or(0);
            if b0 != 0 || b1 != 0 || b2 != 0 || b3 != 0 {
                let val = (b0 as u32) | ((b1 as u32) << 8) | ((b2 as u32) << 16) | ((b3 as u32) << 24);
                out.push_str(&format!("  '{:032b}': '{:032b}',\n", addr, val));
            }
            addr += 4;
        }
        out.push_str("}\n\n");
        out.push_str("type $InitialState = { memory: $InitialMemory }\n\n");

        // Globals
        for (idx, val) in &self.globals {
            out.push_str(&format!("type $g{} = '{:032b}'\n", idx, *val as i32));
        }
        if !self.globals.is_empty() {
            out.push_str("\n");
        }

        // Import placeholders - generate for each imported function
        // These represent unknown state/results from import calls
        for import_idx in 0..self.num_func_imports {
            // State after calling import (unknown, but still a valid $State)
            out.push_str(&format!("type $import_{}_state = $State\n", import_idx));
            // Result from import (if it returns a value)
            if let Some(&type_idx) = self.import_func_type_indices.get(import_idx as usize) {
                if let Some(func_type) = self.func_types.get(type_idx as usize) {
                    if !func_type.results().is_empty() {
                        out.push_str(&format!("type $import_{}__result = WasmValue\n", import_idx));
                    }
                }
            }
        }
        if self.num_func_imports > 0 {
            out.push_str("\n");
        }

        // Extra types (loops, intermediate states)
        for func in functions {
            for td in &func.extra_types {
                out.push_str(&format!("type {}<{}> =\n  {}\n\n", td.name, td.params.join(", "), td.body));
            }
        }

        // Functions
        // Determine entry function: use exported func if available, else last function
        let entry_idx = self.exported_func_idx
            .map(|idx| idx as usize)
            .unwrap_or_else(|| functions.len().saturating_sub(1));

        // call_indirect dispatch types (one per signature used by a call_indirect)
        let mut indirect_types: Vec<u32> = functions
            .iter()
            .flat_map(|func| func.indirect_types.iter().copied())
            .collect();
        indirect_types.sort_unstable();
        indirect_types.dedup();
        for type_index in indirect_types {
            self.emit_indirect_dispatch(&mut out, type_index, entry_idx);
        }

        for (i, func) in functions.iter().enumerate() {
            let state_param = "$S extends $State";
            let value_params: String = func.params.iter()
                .map(|(name, _)| format!("{} extends WasmValue", name))
                .collect::<Vec<_>>()
                .join(", ");
            let all_params = if value_params.is_empty() {
                state_param.to_string()
            } else {
                format!("{}, {}", state_param, value_params)
            };

            let body = if func.result_type.is_some() {
                let result = func.result_ts.as_deref().unwrap_or("never");
                format!("[{}, {}]", func.state_ts, result)
            } else {
                func.state_ts.clone()
            };

            let name = if i == entry_idx { "$entry_impl" } else { &format!("$func_{}_impl", func.index) };
            out.push_str(&format!("type {}<{}> =\n  {}\n\n", name, all_params, body));
        }

        // Entry wrapper - use exported function if available
        if let Some(func) = functions.get(entry_idx) {
            let arg_types: String = func.params.iter()
                .map(|(_, vt)| match vt {
                    ValType::I32 => "number",
                    ValType::I64 => "bigint",
                    _ => "number",
                })
                .collect::<Vec<_>>()
                .join(", ");

            let conversions: String = func.params.iter()
                .enumerate()
                .map(|(i, (_, vt))| match vt {
                    ValType::I32 => format!("Convert.U32Decimal.ToU32Binary<Args[{}]>", i),
                    ValType::I64 => format!("Convert.U64Decimal.ToU64Binary<Args[{}]>", i),
                    _ => format!("Convert.U32Decimal.ToU32Binary<Args[{}]>", i),
                })
                .collect::<Vec<_>>()
                .join(",\n      ");

            let call_args = if conversions.is_empty() {
                "$InitialState".to_string()
            } else {
                format!("$InitialState,\n      {}", conversions)
            };

            // Generate entry wrapper based on result type
            if let Some(result_type) = &func.result_type {
                let type_str = match result_type {
                    ValType::I32 => "'i32'",
                    ValType::I64 => "'i64'",
                    ValType::F32 => "'f32'",
                    ValType::F64 => "'f64'",
                    _ => "'i32'",
                };
                out.push_str(&format!(
                    "export type entry<Args extends [{}]> =\n  Convert.WasmValue.ToTSNumber<\n    $GetValue<$entry_impl<\n      {}\n    >>,\n    {}\n  >\n",
                    arg_types, call_args, type_str
                ));
            } else {
                // Void function - just return the state, no value conversion
                out.push_str(&format!(
                    "export type entry<Args extends [{}]> =\n  $entry_impl<\n    {}\n  >\n",
                    arg_types, call_args
                ));
            }
        }

        out
    }
}

struct CompiledFunc {
    index: u32,
    params: Vec<(String, ValType)>,
    result_type: Option<ValType>,  // None for void, Some(type) for returning functions
    state_ts: String,
    result_ts: Option<String>,
    extra_types: Vec<TypeDef>,
    indirect_types: Vec<u32>,  // call_indirect type indices used by this function
}
