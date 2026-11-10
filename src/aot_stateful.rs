use std::collections::HashMap;
use wasmparser::{
    FuncType, Parser, Payload, ValType,
};

/// Expression with state threading
/// Every expression tracks both the current state and the value
#[derive(Debug, Clone)]
pub enum Expr {
    /// Reference to current state: $S
    State,
    /// Local/parameter reference: $p0, $p1, etc.
    Param(String),
    /// Constant value as binary string: '00000000...'
    Const(String, ExprType),
    /// Binary operation: Wasm.I32Add<a, b>
    BinOp(&'static str, Box<Expr>, Box<Expr>),
    /// Unary operation: Wasm.I32Clz<a>
    UnaryOp(&'static str, Box<Expr>),
    /// Memory load - reads from state: $ReadMem<State, Addr>
    MemLoad {
        state: Box<Expr>,
        addr: Box<Expr>,
    },
    /// Unaligned I32 load - uses $LoadI32<State, Addr> helper
    LoadI32 {
        state: Box<Expr>,
        addr: Box<Expr>,
    },
    /// 16-bit load with cross-word support: $Load16<State, Addr>
    Load16 {
        state: Box<Expr>,
        addr: Box<Expr>,
    },
    /// Memory store - returns new state: $WriteMem<State, Addr, Value>
    MemStore {
        state: Box<Expr>,
        addr: Box<Expr>,
        value: Box<Expr>,
    },
    /// 8-bit store with read-modify-write: $Store8<State, Addr, Value>
    Store8 {
        state: Box<Expr>,
        addr: Box<Expr>,
        value: Box<Expr>,
    },
    /// 16-bit store with read-modify-write: $Store16<State, Addr, Value>
    Store16 {
        state: Box<Expr>,
        addr: Box<Expr>,
        value: Box<Expr>,
    },
    /// 32-bit store with cross-word support: $Store32<State, Addr, Value>
    Store32 {
        state: Box<Expr>,
        addr: Box<Expr>,
        value: Box<Expr>,
    },
    /// 64-bit store (writes two 32-bit cells): $Store64<State, Addr, Value>
    Store64 {
        state: Box<Expr>,
        addr: Box<Expr>,
        value: Box<Expr>,
    },
    /// Select instruction: cond ? a : b (ternary)
    Select {
        condition: Box<Expr>,
        if_true: Box<Expr>,
        if_false: Box<Expr>,
    },
    /// If/else block result with state
    IfElse {
        condition: Box<Expr>,
        then_state: Box<Expr>,
        then_result: Box<Expr>,
        else_state: Option<Box<Expr>>,
        else_result: Option<Box<Expr>>,
    },
    /// Function call with state - returns [NewState, Result] or just NewState for void
    Call {
        func_name: String,
        state: Box<Expr>,
        args: Vec<Expr>,
        returns_value: bool,
    },
    /// Indirect call through the function table: $indirect_T<state, callee, args...>
    CallIndirect {
        type_index: u32,
        state: Box<Expr>,
        callee: Box<Expr>,
        args: Vec<Expr>,
        returns_value: bool,
    },
    /// Get state from [State, Value] tuple: $GetState<T>
    GetState(Box<Expr>),
    /// Get value from [State, Value] tuple: $GetValue<T>
    GetValue(Box<Expr>),
    /// Loop invocation with state
    LoopCall {
        loop_id: u32,
        state: Box<Expr>,
        initial_args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExprType {
    I32,
    I64,
}

impl Expr {
    /// Convert expression tree to TypeScript type string
    pub fn to_typescript(&self) -> String {
        self.to_typescript_depth(0)
    }

    /// Convert with depth tracking to prevent exponential blowup
    fn to_typescript_depth(&self, depth: usize) -> String {
        // Limit recursion depth to prevent exponential blowup
        if depth > 50 {
            return "$S".to_string(); // Fallback to simple state reference
        }
        let depth = depth + 1;

        match self {
            Expr::State => "$S".to_string(),
            Expr::Param(name) => name.clone(),
            Expr::Const(value, _) => format!("'{}'", value),
            Expr::BinOp(op, a, b) => {
                format!("{}<{}, {}>", op, a.to_typescript_depth(depth), b.to_typescript_depth(depth))
            }
            Expr::UnaryOp(op, a) => {
                format!("{}<{}>", op, a.to_typescript_depth(depth))
            }
            Expr::MemLoad { state, addr } => {
                format!("$ReadMem<{}, {}>", state.to_typescript_depth(depth), addr.to_typescript_depth(depth))
            }
            Expr::LoadI32 { state, addr } => {
                format!("$LoadI32<{}, {}>", state.to_typescript_depth(depth), addr.to_typescript_depth(depth))
            }
            Expr::Load16 { state, addr } => {
                format!("$Load16<{}, {}>", state.to_typescript_depth(depth), addr.to_typescript_depth(depth))
            }
            Expr::MemStore { state, addr, value } => {
                format!("$WriteMem<{}, {}, {}>", state.to_typescript_depth(depth), addr.to_typescript_depth(depth), value.to_typescript_depth(depth))
            }
            Expr::Store8 { state, addr, value } => {
                format!("$Store8<{}, {}, {}>", state.to_typescript_depth(depth), addr.to_typescript_depth(depth), value.to_typescript_depth(depth))
            }
            Expr::Store16 { state, addr, value } => {
                format!("$Store16<{}, {}, {}>", state.to_typescript_depth(depth), addr.to_typescript_depth(depth), value.to_typescript_depth(depth))
            }
            Expr::Store32 { state, addr, value } => {
                format!("$Store32<{}, {}, {}>", state.to_typescript_depth(depth), addr.to_typescript_depth(depth), value.to_typescript_depth(depth))
            }
            Expr::Store64 { state, addr, value } => {
                format!("$Store64<{}, {}, {}>", state.to_typescript_depth(depth), addr.to_typescript_depth(depth), value.to_typescript_depth(depth))
            }
            Expr::Select { condition, if_true, if_false } => {
                format!(
                    "({} extends '00000000000000000000000000000000' ? {} : {})",
                    condition.to_typescript_depth(depth),
                    if_false.to_typescript_depth(depth),
                    if_true.to_typescript_depth(depth)
                )
            }
            Expr::IfElse { condition, then_state, then_result, else_state, else_result } => {
                match (else_state, else_result) {
                    (Some(es), Some(er)) => format!(
                        "({} extends '00000000000000000000000000000000' ? [{}, {}] : [{}, {}])",
                        condition.to_typescript_depth(depth),
                        es.to_typescript_depth(depth),
                        er.to_typescript_depth(depth),
                        then_state.to_typescript_depth(depth),
                        then_result.to_typescript_depth(depth)
                    ),
                    _ => format!(
                        "({} extends '00000000000000000000000000000000' ? [$S, never] : [{}, {}])",
                        condition.to_typescript_depth(depth),
                        then_state.to_typescript_depth(depth),
                        then_result.to_typescript_depth(depth)
                    ),
                }
            }
            Expr::Call { func_name, state, args, returns_value: _ } => {
                let mut all_args = vec![state.to_typescript_depth(depth)];
                all_args.extend(args.iter().map(|a| a.to_typescript_depth(depth)));
                format!("{}_impl<{}>", func_name, all_args.join(", "))
            }
            Expr::CallIndirect { type_index, state, callee, args, returns_value: _ } => {
                let mut all_args = vec![
                    state.to_typescript_depth(depth),
                    callee.to_typescript_depth(depth),
                ];
                all_args.extend(args.iter().map(|a| a.to_typescript_depth(depth)));
                format!("$indirect_{}<{}>", type_index, all_args.join(", "))
            }
            Expr::GetState(tuple) => {
                format!("$GetState<{}>", tuple.to_typescript_depth(depth))
            }
            Expr::GetValue(tuple) => {
                format!("$GetValue<{}>", tuple.to_typescript_depth(depth))
            }
            Expr::LoopCall { loop_id, state, initial_args } => {
                let mut all_args = vec![state.to_typescript_depth(depth)];
                all_args.extend(initial_args.iter().map(|e| e.to_typescript_depth(depth)));
                format!("$loop_{}<{}>", loop_id, all_args.join(", "))
            }
        }
    }
}

/// Memory segment from data section
#[derive(Debug, Clone)]
pub struct MemorySegment {
    pub offset: u32,
    pub data: Vec<u8>,
}

/// Compiled function with state threading
#[derive(Debug)]
pub struct CompiledFunc {
    pub name: String,
    pub params: Vec<(String, ExprType)>,
    pub result_type: Option<ExprType>,
    pub body_state: Option<Expr>,  // Final state
    pub body_result: Option<Expr>, // Final result (None for void)
    pub loop_defs: Vec<LoopTypeDef>, // Loop type definitions for this function
    pub indirect_types: Vec<u32>,    // call_indirect type indices used by this function
}

/// Block context for control flow
#[derive(Debug, Clone)]
struct BlockContext {
    is_loop: bool,
    loop_id: Option<u32>,
    result_type: Option<ExprType>,
    /// Snapshot of locals at loop entry for generating loop type
    locals_at_entry: Option<HashMap<u32, Expr>>,
}

/// Generated loop type definition
#[derive(Debug, Clone)]
pub struct LoopTypeDef {
    pub id: u32,
    pub param_locals: Vec<u32>,  // Which locals are loop parameters
    pub body_expr: String,       // The recursive body expression
}

/// Compilation context for a function
struct FuncCompiler<'a> {
    function_index: u32,
    ops: Vec<wasmparser::Operator<'a>>,
    pos: usize,
    stack: Vec<Expr>,
    current_state: Expr,
    locals: HashMap<u32, Expr>,
    label_stack: Vec<BlockContext>,
    loop_counter: u32,
    loop_defs: Vec<LoopTypeDef>, // Generated loop type definitions
    func_types: &'a [FuncType],
    func_type_indices: &'a [u32],
    num_func_imports: u32,
    state_depth: usize, // Track state nesting depth
    num_params: usize,  // Number of function parameters
    indirect_types: Vec<u32>, // Type indices reached via call_indirect
}

const MAX_STATE_DEPTH: usize = 20; // Limit state nesting to prevent exponential blowup

impl<'a> FuncCompiler<'a> {
    fn new(
        function_index: u32,
        ops: Vec<wasmparser::Operator<'a>>,
        params: &[(String, ExprType)],
        num_locals: u32,
        func_types: &'a [FuncType],
        func_type_indices: &'a [u32],
        num_func_imports: u32,
    ) -> Self {
        let mut locals = HashMap::new();
        let num_params = params.len();

        // Initialize parameters
        for i in 0..params.len() {
            locals.insert(i as u32, Expr::Param(format!("$p{}", i)));
        }

        // Initialize locals to zero
        for i in params.len() as u32..num_locals {
            locals.insert(i, Expr::Const("00000000000000000000000000000000".to_string(), ExprType::I32));
        }

        Self {
            function_index,
            ops,
            pos: 0,
            stack: Vec::new(),
            current_state: Expr::State,
            locals,
            label_stack: Vec::new(),
            loop_counter: 0,
            loop_defs: Vec::new(),
            func_types,
            func_type_indices,
            num_func_imports,
            state_depth: 0,
            num_params,
            indirect_types: Vec::new(),
        }
    }

    /// Update state with depth limiting
    fn update_state(&mut self, new_state: Expr) {
        self.state_depth += 1;
        if self.state_depth <= MAX_STATE_DEPTH {
            self.current_state = new_state;
        } else {
            // Reset to simple state reference to prevent tree explosion
            self.current_state = Expr::State;
        }
    }

    /// Get current state for use in expressions
    fn get_state_for_expr(&self) -> Expr {
        // Use simplified state to prevent exponential growth
        // For complex functions, we sacrifice state precision for compilability
        if self.state_depth > 10 {
            Expr::State
        } else {
            self.current_state.clone()
        }
    }

    /// Process operators until End or Else
    fn process_block(&mut self, stop_at_else: bool) -> Result<bool, String> {
        use wasmparser::Operator::*;

        while self.pos < self.ops.len() {
            let op = self.ops[self.pos].clone();
            self.pos += 1;

            match op {
                End => return Ok(false),
                Else => return Ok(stop_at_else),

                // If/else with state threading
                If { blockty: _ } => {
                    let condition = self.stack.pop().unwrap_or(Expr::Param("$cond".to_string()));
                    let state_before = self.get_state_for_expr();
                    let locals_before = self.locals.clone();

                    // Process then branch
                    self.label_stack.push(BlockContext {
                        is_loop: false,
                        loop_id: None,
                        result_type: None,
                        locals_at_entry: None,
                    });
                    let has_else = self.process_block(true)?;
                    let then_state = self.get_state_for_expr();
                    let then_result = self.stack.pop();
                    let then_locals = self.locals.clone();
                    self.label_stack.pop();

                    if has_else {
                        // Process else branch - reset state and locals
                        self.current_state = state_before.clone();
                        self.locals = locals_before.clone();
                        self.label_stack.push(BlockContext {
                            is_loop: false,
                            loop_id: None,
                            result_type: None,
                            locals_at_entry: None,
                        });
                        self.process_block(false)?;
                        let else_state = self.get_state_for_expr();
                        let else_result = self.stack.pop();
                        let else_locals = self.locals.clone();
                        self.label_stack.pop();

                        // Merge branches with conditional
                        if let (Some(tr), Some(er)) = (&then_result, &else_result) {
                            self.stack.push(Expr::Select {
                                condition: Box::new(condition.clone()),
                                if_true: Box::new(tr.clone()),
                                if_false: Box::new(er.clone()),
                            });
                        }

                        // Merge locals conditionally
                        for (idx, then_val) in &then_locals {
                            if let Some(else_val) = else_locals.get(idx) {
                                self.locals.insert(*idx, Expr::Select {
                                    condition: Box::new(condition.clone()),
                                    if_true: Box::new(then_val.clone()),
                                    if_false: Box::new(else_val.clone()),
                                });
                            }
                        }

                        // State is conditional on branch taken
                        self.update_state(Expr::IfElse {
                            condition: Box::new(condition),
                            then_state: Box::new(then_state),
                            then_result: Box::new(then_result.unwrap_or(Expr::State)),
                            else_state: Some(Box::new(else_state)),
                            else_result: Some(Box::new(else_result.unwrap_or(Expr::State))),
                        });
                    } else {
                        // No else branch - merge then_state with state_before
                        // If condition is true: use then_state with side effects
                        // If condition is false: use state_before (no changes)
                        self.update_state(Expr::IfElse {
                            condition: Box::new(condition.clone()),
                            then_state: Box::new(then_state),
                            then_result: Box::new(then_result.clone().unwrap_or(Expr::State)),
                            else_state: Some(Box::new(state_before)),
                            else_result: Some(Box::new(Expr::State)),
                        });

                        // Merge locals: if condition true use then_locals, else use locals_before
                        for (idx, then_val) in &then_locals {
                            if let Some(before_val) = locals_before.get(idx) {
                                self.locals.insert(*idx, Expr::Select {
                                    condition: Box::new(condition.clone()),
                                    if_true: Box::new(then_val.clone()),
                                    if_false: Box::new(before_val.clone()),
                                });
                            }
                        }

                        if let Some(tr) = then_result {
                            self.stack.push(tr);
                        }
                    }
                }

                Block { blockty: _ } => {
                    self.label_stack.push(BlockContext {
                        is_loop: false,
                        loop_id: None,
                        result_type: None,
                        locals_at_entry: None,
                    });
                    self.process_block(false)?;
                    self.label_stack.pop();
                }

                Loop { blockty: _ } => {
                    let loop_id = self.loop_counter;
                    self.loop_counter += 1;

                    // Snapshot locals at loop entry (initial values for loop call)
                    let locals_snapshot = self.locals.clone();
                    let loop_locals: Vec<u32> = (self.num_params as u32..self.locals.len() as u32).collect();

                    // Replace locals with loop parameter references for body processing
                    for &local_idx in &loop_locals {
                        self.locals.insert(local_idx, Expr::Param(format!("$loop{}_{}", loop_id, local_idx)));
                    }

                    self.label_stack.push(BlockContext {
                        is_loop: true,
                        loop_id: Some(loop_id),
                        result_type: None,
                        locals_at_entry: Some(locals_snapshot.clone()),
                    });

                    self.process_block(false)?;
                    self.label_stack.pop();

                    // Create loop call expression with initial values
                    let initial_args: Vec<Expr> = loop_locals.iter()
                        .filter_map(|idx| locals_snapshot.get(idx).cloned())
                        .collect();

                    let loop_call = Expr::LoopCall {
                        loop_id,
                        state: Box::new(Expr::State),
                        initial_args: initial_args.clone(),
                    };

                    // After loop: restore locals to their pre-loop values
                    // The loop result (if needed) will be accessed via GetValue
                    // This prevents loop parameter references from leaking
                    for (&local_idx, value) in &locals_snapshot {
                        if local_idx >= self.num_params as u32 {
                            self.locals.insert(local_idx, value.clone());
                        }
                    }

                    // If the loop has a result local (typically the last one),
                    // update it to extract from the loop call
                    if let Some(&result_local) = loop_locals.last() {
                        self.locals.insert(result_local, Expr::GetValue(Box::new(loop_call)));
                    }
                }

                Br { relative_depth } => {
                    // Branch to label - for now just skip to end of target block
                    self.skip_to_label_end(relative_depth)?;
                }

                BrIf { relative_depth } => {
                    let condition = self.stack.pop().unwrap_or(Expr::Param("$cond".to_string()));

                    // Check if we're branching to a loop (loop continuation)
                    let target_idx = self.label_stack.len().saturating_sub(1 + relative_depth as usize);
                    if let Some(target) = self.label_stack.get(target_idx) {
                        if target.is_loop {
                            if let Some(loop_id) = target.loop_id {
                                // Generate recursive loop call
                                // Collect current local values as arguments
                                let loop_locals: Vec<u32> = (self.num_params as u32..self.locals.len() as u32).collect();
                                let mut args = Vec::new();
                                for &local_idx in &loop_locals {
                                    if let Some(val) = self.locals.get(&local_idx) {
                                        args.push(val.clone());
                                    }
                                }

                                // Generate loop type definition
                                // The body is: if condition then recurse else fall through
                                let loop_params: String = loop_locals.iter()
                                    .map(|idx| format!("$loop{}_{} extends WasmValue", loop_id, idx))
                                    .collect::<Vec<_>>()
                                    .join(", ");

                                let state_param = "$S extends $State";
                                let all_params = if loop_params.is_empty() {
                                    state_param.to_string()
                                } else {
                                    format!("{}, {}", state_param, loop_params)
                                };

                                // Build recursive call args
                                let recurse_args: String = std::iter::once("$S".to_string())
                                    .chain(args.iter().map(|e| e.to_typescript()))
                                    .collect::<Vec<_>>()
                                    .join(", ");

                                // Get the result local for this loop
                                // Typically the last modified local before the br_if
                                let result_local = loop_locals.last().copied().unwrap_or(0);
                                let result_expr = self.locals.get(&result_local)
                                    .map(|e| e.to_typescript())
                                    .unwrap_or_else(|| "never".to_string());

                                // Generate: condition != 0 ? recurse : exit
                                let body_expr = format!(
                                    "{} extends '00000000000000000000000000000000' ? [$S, {}] : $loop_{}<{}>",
                                    condition.to_typescript(),
                                    result_expr,
                                    loop_id,
                                    recurse_args
                                );

                                self.loop_defs.push(LoopTypeDef {
                                    id: loop_id,
                                    param_locals: loop_locals.clone(),
                                    body_expr: format!("type $loop_{}<{}> =\n  {}\n", loop_id, all_params, body_expr),
                                });

                                // Push the loop call onto the stack as the result
                                self.stack.push(Expr::LoopCall {
                                    loop_id,
                                    state: Box::new(Expr::State),
                                    initial_args: if let Some(ctx) = self.label_stack.get(target_idx) {
                                        if let Some(entry_locals) = &ctx.locals_at_entry {
                                            loop_locals.iter()
                                                .filter_map(|idx| entry_locals.get(idx).cloned())
                                                .collect()
                                        } else {
                                            vec![]
                                        }
                                    } else {
                                        vec![]
                                    },
                                });
                            }
                        }
                    }
                }

                BrTable { targets } => {
                    let _index = self.stack.pop();
                    // Skip to default target
                    self.skip_to_label_end(targets.default())?;
                }

                Return => {
                    // Return ends function
                    return Ok(false);
                }

                Unreachable => {
                    // Trap - no result
                }

                // All other operators
                _ => self.process_operator(&op)?,
            }
        }
        Ok(false)
    }

    fn skip_to_label_end(&mut self, _depth: u32) -> Result<(), String> {
        // Skip operators until we reach the matching End
        let mut block_depth = 1u32;
        while self.pos < self.ops.len() && block_depth > 0 {
            let op = &self.ops[self.pos];
            self.pos += 1;
            use wasmparser::Operator::*;
            match op {
                If { .. } | Block { .. } | Loop { .. } => block_depth += 1,
                End => block_depth -= 1,
                _ => {}
            }
        }
        Ok(())
    }

    fn process_operator(&mut self, op: &wasmparser::Operator) -> Result<(), String> {
        use wasmparser::Operator::*;

        match op {
            LocalGet { local_index } => {
                if let Some(expr) = self.locals.get(local_index) {
                    self.stack.push(expr.clone());
                } else {
                    self.stack.push(Expr::Param(format!("$l{}", local_index)));
                }
            }

            LocalSet { local_index } => {
                if let Some(expr) = self.stack.pop() {
                    self.locals.insert(*local_index, expr);
                }
            }

            LocalTee { local_index } => {
                if let Some(expr) = self.stack.last() {
                    self.locals.insert(*local_index, expr.clone());
                }
            }

            I32Const { value } => {
                self.stack.push(Expr::Const(format!("{:032b}", value), ExprType::I32));
            }
            I64Const { value } => {
                self.stack.push(Expr::Const(format!("{:064b}", value), ExprType::I64));
            }

            // Arithmetic
            I32Add => binary_op(&mut self.stack, "Wasm.I32Add"),
            I32Sub => binary_op(&mut self.stack, "Wasm.I32Sub"),
            I32Mul => binary_op(&mut self.stack, "Wasm.I32Mul"),
            I32DivS => binary_op(&mut self.stack, "Wasm.I32DivS"),
            I32DivU => binary_op(&mut self.stack, "Wasm.I32DivU"),
            I32RemS => binary_op(&mut self.stack, "Wasm.I32RemS"),
            I32RemU => binary_op(&mut self.stack, "Wasm.I32RemU"),
            I32And => binary_op(&mut self.stack, "Wasm.I32And"),
            I32Or => binary_op(&mut self.stack, "Wasm.I32Or"),
            I32Xor => binary_op(&mut self.stack, "Wasm.I32Xor"),
            I32Shl => binary_op(&mut self.stack, "Wasm.I32Shl"),
            I32ShrU => binary_op(&mut self.stack, "Wasm.I32ShrU"),
            I32ShrS => binary_op(&mut self.stack, "Wasm.I32ShrS"),
            I32Rotl => binary_op(&mut self.stack, "Wasm.I32Rotl"),
            I32Rotr => binary_op(&mut self.stack, "Wasm.I32Rotr"),

            // Comparison
            I32Eq => binary_op(&mut self.stack, "Wasm.I32Eq"),
            I32Ne => binary_op(&mut self.stack, "Wasm.I32Neq"),
            I32LtS => binary_op(&mut self.stack, "Wasm.I32LtS"),
            I32LtU => binary_op(&mut self.stack, "Wasm.I32LtU"),
            I32GtS => binary_op(&mut self.stack, "Wasm.I32GtS"),
            I32GtU => binary_op(&mut self.stack, "Wasm.I32GtU"),
            I32LeS => binary_op(&mut self.stack, "Wasm.I32LeS"),
            I32LeU => binary_op(&mut self.stack, "Wasm.I32LeU"),
            I32GeS => binary_op(&mut self.stack, "Wasm.I32GeS"),
            I32GeU => binary_op(&mut self.stack, "Wasm.I32GeU"),
            I32Eqz => unary_op(&mut self.stack, "Wasm.I32Eqz"),
            I32Clz => unary_op(&mut self.stack, "Wasm.I32Clz"),
            I32Ctz => unary_op(&mut self.stack, "Wasm.I32Ctz"),
            I32Popcnt => unary_op(&mut self.stack, "Wasm.I32Popcnt"),

            // Memory load
            I32Load { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Use LoadI32 which handles potentially unaligned addresses
                self.stack.push(Expr::LoadI32 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                });
            }

            I32Load8U { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr.clone()),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr.clone()
                };
                let raw = Expr::MemLoad {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr.clone()),
                };
                // Compute byte offset: (addr & 3) * 8
                let byte_offset = Expr::BinOp("Wasm.I32And", Box::new(final_addr),
                    Box::new(Expr::Const("00000000000000000000000000000011".to_string(), ExprType::I32)));
                let shift_amount = Expr::BinOp("Wasm.I32Shl", Box::new(byte_offset),
                    Box::new(Expr::Const("00000000000000000000000000000011".to_string(), ExprType::I32))); // multiply by 8
                // Shift right to extract correct byte
                let shifted = Expr::BinOp("Wasm.I32ShrU", Box::new(raw), Box::new(shift_amount));
                // Mask to 8 bits
                self.stack.push(Expr::BinOp("Wasm.I32And", Box::new(shifted),
                    Box::new(Expr::Const("00000000000000000000000011111111".to_string(), ExprType::I32))));
            }

            I32Load8S { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr.clone()),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr.clone()
                };
                let raw = Expr::MemLoad {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr.clone()),
                };
                // Compute byte offset: (addr & 3) * 8
                let byte_offset = Expr::BinOp("Wasm.I32And", Box::new(final_addr),
                    Box::new(Expr::Const("00000000000000000000000000000011".to_string(), ExprType::I32)));
                let shift_amount = Expr::BinOp("Wasm.I32Shl", Box::new(byte_offset),
                    Box::new(Expr::Const("00000000000000000000000000000011".to_string(), ExprType::I32))); // multiply by 8
                // Shift right to extract correct byte
                let shifted = Expr::BinOp("Wasm.I32ShrU", Box::new(raw), Box::new(shift_amount));
                // Sign extend from 8 bits: (value << 24) >> 24 (arithmetic)
                let shifted_left = Expr::BinOp("Wasm.I32Shl", Box::new(shifted),
                    Box::new(Expr::Const("00000000000000000000000000011000".to_string(), ExprType::I32))); // 24
                self.stack.push(Expr::BinOp("Wasm.I32ShrS", Box::new(shifted_left),
                    Box::new(Expr::Const("00000000000000000000000000011000".to_string(), ExprType::I32)))); // 24
            }

            I32Load16U { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr.clone()),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr.clone()
                };
                // Use Load16 which handles cross-word case at byte offset 3
                self.stack.push(Expr::Load16 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                });
            }

            I32Load16S { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr.clone()),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr.clone()
                };
                // Use Load16 which handles cross-word case, then sign extend
                let raw = Expr::Load16 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                };
                // Sign extend from 16 bits: (value << 16) >> 16 (arithmetic)
                let shifted_left = Expr::BinOp("Wasm.I32Shl", Box::new(raw),
                    Box::new(Expr::Const("00000000000000000000000000010000".to_string(), ExprType::I32))); // 16
                self.stack.push(Expr::BinOp("Wasm.I32ShrS", Box::new(shifted_left),
                    Box::new(Expr::Const("00000000000000000000000000010000".to_string(), ExprType::I32)))); // 16
            }

            // Memory store
            I32Store { memarg } => {
                let value = self.stack.pop().unwrap_or(Expr::Param("$val".to_string()));
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Use Store32 which handles potentially unaligned addresses
                self.update_state(Expr::Store32 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                    value: Box::new(value),
                });
            }

            I32Store8 { memarg } => {
                let value = self.stack.pop().unwrap_or(Expr::Param("$val".to_string()));
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Use Store8 for read-modify-write to preserve other bytes
                self.update_state(Expr::Store8 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                    value: Box::new(value),
                });
            }

            I32Store16 { memarg } => {
                let value = self.stack.pop().unwrap_or(Expr::Param("$val".to_string()));
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Use Store16 for read-modify-write to preserve other bytes
                self.update_state(Expr::Store16 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                    value: Box::new(value),
                });
            }

            // I64 Memory operations
            I64Load { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                let state = self.get_state_for_expr();

                // Read low 32 bits using LoadI32 (handles unaligned addresses)
                let low_read = Expr::LoadI32 {
                    state: Box::new(state.clone()),
                    addr: Box::new(final_addr.clone()),
                };
                // Extend low to 64 bits (unsigned)
                let low_64 = Expr::UnaryOp("Wasm.I64ExtendI32U", Box::new(low_read));

                // Read high 32 bits at addr+4 using LoadI32 (handles unaligned addresses)
                let high_addr = Expr::BinOp("Wasm.I32Add", Box::new(final_addr),
                    Box::new(Expr::Const("00000000000000000000000000000100".to_string(), ExprType::I32))); // 4
                let high_read = Expr::LoadI32 {
                    state: Box::new(state),
                    addr: Box::new(high_addr),
                };
                // Extend high to 64 bits (unsigned)
                let high_64 = Expr::UnaryOp("Wasm.I64ExtendI32U", Box::new(high_read));
                // Shift high left by 32
                let high_shifted = Expr::BinOp("Wasm.I64Shl", Box::new(high_64),
                    Box::new(Expr::Const("0000000000000000000000000000000000000000000000000000000000100000".to_string(), ExprType::I64))); // 32
                // Combine: low | (high << 32)
                self.stack.push(Expr::BinOp("Wasm.I64Or", Box::new(low_64), Box::new(high_shifted)));
            }

            I64Store { memarg } => {
                let value = self.stack.pop().unwrap_or(Expr::Param("$val".to_string()));
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Use Store64 which writes two 32-bit cells (low at addr, high at addr+4)
                self.update_state(Expr::Store64 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                    value: Box::new(value),
                });
            }

            I64Load8U { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr.clone()),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr.clone()
                };
                let raw = Expr::MemLoad {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr.clone()),
                };
                // Compute byte offset: (addr & 3) * 8
                let byte_offset = Expr::BinOp("Wasm.I32And", Box::new(final_addr),
                    Box::new(Expr::Const("00000000000000000000000000000011".to_string(), ExprType::I32)));
                let shift_amount = Expr::BinOp("Wasm.I32Shl", Box::new(byte_offset),
                    Box::new(Expr::Const("00000000000000000000000000000011".to_string(), ExprType::I32))); // multiply by 8
                // Do byte extraction in 32-bit (memory is 32-bit)
                let shifted = Expr::BinOp("Wasm.I32ShrU", Box::new(raw), Box::new(shift_amount));
                // Mask to 8 bits
                let masked = Expr::BinOp("Wasm.I32And", Box::new(shifted),
                    Box::new(Expr::Const("00000000000000000000000011111111".to_string(), ExprType::I32)));
                // Extend to 64 bits (unsigned)
                self.stack.push(Expr::UnaryOp("Wasm.I64ExtendI32U", Box::new(masked)));
            }

            I64Load8S { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr.clone()),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr.clone()
                };
                let raw = Expr::MemLoad {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr.clone()),
                };
                // Compute byte offset: (addr & 3) * 8
                let byte_offset = Expr::BinOp("Wasm.I32And", Box::new(final_addr),
                    Box::new(Expr::Const("00000000000000000000000000000011".to_string(), ExprType::I32)));
                let shift_amount = Expr::BinOp("Wasm.I32Shl", Box::new(byte_offset),
                    Box::new(Expr::Const("00000000000000000000000000000011".to_string(), ExprType::I32)));
                // Do byte extraction in 32-bit (memory is 32-bit)
                let shifted = Expr::BinOp("Wasm.I32ShrU", Box::new(raw), Box::new(shift_amount));
                // Sign extend from 8 bits: (value << 24) >> 24
                let shifted_left = Expr::BinOp("Wasm.I32Shl", Box::new(shifted),
                    Box::new(Expr::Const("00000000000000000000000000011000".to_string(), ExprType::I32))); // 24
                let sign_extended = Expr::BinOp("Wasm.I32ShrS", Box::new(shifted_left),
                    Box::new(Expr::Const("00000000000000000000000000011000".to_string(), ExprType::I32))); // 24
                // Extend to 64 bits (signed)
                self.stack.push(Expr::UnaryOp("Wasm.I64ExtendI32S", Box::new(sign_extended)));
            }

            I64Load16U { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr.clone()),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr.clone()
                };
                // Use Load16 which handles cross-word case, then extend to 64 bits
                let raw = Expr::Load16 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                };
                // Extend to 64 bits (unsigned)
                self.stack.push(Expr::UnaryOp("Wasm.I64ExtendI32U", Box::new(raw)));
            }

            I64Load16S { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr.clone()),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr.clone()
                };
                // Use Load16 which handles cross-word case
                let raw = Expr::Load16 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                };
                // Sign extend from 16 bits to 32, then extend to 64
                let shifted_left = Expr::BinOp("Wasm.I32Shl", Box::new(raw),
                    Box::new(Expr::Const("00000000000000000000000000010000".to_string(), ExprType::I32))); // 16
                let sign_extended = Expr::BinOp("Wasm.I32ShrS", Box::new(shifted_left),
                    Box::new(Expr::Const("00000000000000000000000000010000".to_string(), ExprType::I32))); // 16
                // Extend to 64 bits (signed)
                self.stack.push(Expr::UnaryOp("Wasm.I64ExtendI32S", Box::new(sign_extended)));
            }

            I64Load32U { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Use LoadI32 for potentially unaligned 32-bit load
                let raw = Expr::LoadI32 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                };
                // Extend to 64 bits (unsigned)
                self.stack.push(Expr::UnaryOp("Wasm.I64ExtendI32U", Box::new(raw)));
            }

            I64Load32S { memarg } => {
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Use LoadI32 for potentially unaligned 32-bit load
                let raw = Expr::LoadI32 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                };
                // Sign extend to 64 bits
                self.stack.push(Expr::UnaryOp("Wasm.I64ExtendI32S", Box::new(raw)));
            }

            I64Store8 { memarg } => {
                let value = self.stack.pop().unwrap_or(Expr::Param("$val".to_string()));
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Wrap i64 value to i32 and use Store8 for read-modify-write
                let wrapped = Expr::UnaryOp("Wasm.I32WrapI64", Box::new(value));
                self.update_state(Expr::Store8 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                    value: Box::new(wrapped),
                });
            }

            I64Store16 { memarg } => {
                let value = self.stack.pop().unwrap_or(Expr::Param("$val".to_string()));
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Wrap i64 value to i32 and use Store16 for read-modify-write
                let wrapped = Expr::UnaryOp("Wasm.I32WrapI64", Box::new(value));
                self.update_state(Expr::Store16 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                    value: Box::new(wrapped),
                });
            }

            I64Store32 { memarg } => {
                let value = self.stack.pop().unwrap_or(Expr::Param("$val".to_string()));
                let addr = self.stack.pop().unwrap_or(Expr::Param("$addr".to_string()));
                let final_addr = if memarg.offset > 0 {
                    Expr::BinOp("Wasm.I32Add", Box::new(addr),
                        Box::new(Expr::Const(format!("{:032b}", memarg.offset), ExprType::I32)))
                } else {
                    addr
                };
                // Wrap i64 to i32 and use Store32 for unaligned support
                let wrapped = Expr::UnaryOp("Wasm.I32WrapI64", Box::new(value));
                self.update_state(Expr::Store32 {
                    state: Box::new(self.get_state_for_expr()),
                    addr: Box::new(final_addr),
                    value: Box::new(wrapped),
                });
            }

            // Function calls
            Call { function_index } => {
                if *function_index < self.num_func_imports {
                    return Err(format!(
                        "Unsupported imported function call {} in function {}",
                        function_index, self.function_index
                    ));
                }

                // Adjust index for imports: defined function 0 is at func_type_indices[0]
                let local_func_idx = *function_index - self.num_func_imports;
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
                    let call_expr = Expr::Call {
                        func_name: format!("$func_{}", local_func_idx),  // Use local index
                        state: Box::new(self.get_state_for_expr()),
                        args,
                        returns_value,
                    };

                    if returns_value {
                        self.update_state(Expr::GetState(Box::new(call_expr.clone())));
                        self.stack.push(Expr::GetValue(Box::new(call_expr)));
                    } else {
                        self.update_state(call_expr);
                    }
                }
            }

            // Select
            Select { .. } => {
                let cond = self.stack.pop().unwrap_or(Expr::Param("$c".to_string()));
                let if_false = self.stack.pop().unwrap_or(Expr::Param("$f".to_string()));
                let if_true = self.stack.pop().unwrap_or(Expr::Param("$t".to_string()));
                self.stack.push(Expr::Select {
                    condition: Box::new(cond),
                    if_true: Box::new(if_true),
                    if_false: Box::new(if_false),
                });
            }

            Drop => { self.stack.pop(); }
            Nop => {}

            // Conversions
            I32WrapI64 => unary_op(&mut self.stack, "Wasm.I32WrapI64"),
            I32Extend16S => unary_op(&mut self.stack, "Wasm.I32Extend16S"),
            I64ExtendI32S => unary_op(&mut self.stack, "Wasm.I64ExtendI32S"),
            I64ExtendI32U => unary_op(&mut self.stack, "Wasm.I64ExtendI32U"),

            // I64 ops
            I64Add => binary_op(&mut self.stack, "Wasm.I64Add"),
            I64Sub => binary_op(&mut self.stack, "Wasm.I64Sub"),
            I64Mul => binary_op(&mut self.stack, "Wasm.I64Mul"),
            I64DivS => binary_op(&mut self.stack, "Wasm.I64DivS"),
            I64DivU => binary_op(&mut self.stack, "Wasm.I64DivU"),
            I64And => binary_op(&mut self.stack, "Wasm.I64And"),
            I64Or => binary_op(&mut self.stack, "Wasm.I64Or"),
            I64Xor => binary_op(&mut self.stack, "Wasm.I64Xor"),
            I64ShrU => binary_op(&mut self.stack, "Wasm.I64ShrU"),
            I64ShrS => binary_op(&mut self.stack, "Wasm.I64ShrS"),
            I64Shl => binary_op(&mut self.stack, "Wasm.I64Shl"),
            I64Eq => binary_op(&mut self.stack, "Wasm.I64Eq"),
            I64Ne => binary_op(&mut self.stack, "Wasm.I64Neq"),
            I64LtS => binary_op(&mut self.stack, "Wasm.I64LtS"),
            I64LtU => binary_op(&mut self.stack, "Wasm.I64LtU"),
            I64GtS => binary_op(&mut self.stack, "Wasm.I64GtS"),
            I64GtU => binary_op(&mut self.stack, "Wasm.I64GtU"),
            I64LeS => binary_op(&mut self.stack, "Wasm.I64LeS"),
            I64LeU => binary_op(&mut self.stack, "Wasm.I64LeU"),
            I64GeS => binary_op(&mut self.stack, "Wasm.I64GeS"),
            I64GeU => binary_op(&mut self.stack, "Wasm.I64GeU"),
            I64Eqz => unary_op(&mut self.stack, "Wasm.I64Eqz"),

            // Global operations
            GlobalGet { global_index } => {
                self.stack.push(Expr::Param(format!("$g{}", global_index)));
            }
            GlobalSet { .. } => {
                self.stack.pop();
            }

            // Memory size/grow
            MemorySize { .. } => {
                self.stack.push(Expr::Param("$memsize".to_string()));
            }
            MemoryGrow { .. } => {
                self.stack.pop();
                self.stack.push(Expr::Param("$memgrow_result".to_string()));
            }

            // Indirect calls dispatch on the runtime table index
            CallIndirect { type_index, table_index, .. } => {
                if *table_index != 0 {
                    return Err(format!(
                        "Unsupported call_indirect on table {} in function {} (only table 0 is supported)",
                        table_index, self.function_index
                    ));
                }

                let func_type = self
                    .func_types
                    .get(*type_index as usize)
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
                    .unwrap_or(Expr::Param("$callee".to_string()));

                let mut args = Vec::new();
                for _ in 0..func_type.params().len() {
                    if let Some(arg) = self.stack.pop() {
                        args.push(arg);
                    }
                }
                args.reverse();

                if !self.indirect_types.contains(type_index) {
                    self.indirect_types.push(*type_index);
                }

                let returns_value = !func_type.results().is_empty();
                let call_expr = Expr::CallIndirect {
                    type_index: *type_index,
                    state: Box::new(self.get_state_for_expr()),
                    callee: Box::new(callee),
                    args,
                    returns_value,
                };

                if returns_value {
                    self.update_state(Expr::GetState(Box::new(call_expr.clone())));
                    self.stack.push(Expr::GetValue(Box::new(call_expr)));
                } else {
                    self.update_state(call_expr);
                }
            }
            op => {
                return Err(format!(
                    "Unsupported operator {:?} in function {}",
                    op, self.function_index
                ));
            }
        }
        Ok(())
    }

    fn compile(mut self) -> Result<(Expr, Option<Expr>, Vec<LoopTypeDef>, Vec<u32>), String> {
        self.process_block(false)?;
        let result = self.stack.pop();
        Ok((
            self.current_state,
            result,
            self.loop_defs,
            self.indirect_types,
        ))
    }
}

/// Stateful AOT compiler
pub struct StatefulAotCompiler {
    func_types: Vec<FuncType>,
    func_type_indices: Vec<u32>,
    import_func_type_indices: Vec<u32>,  // Type indices for imported functions
    pub functions: Vec<CompiledFunc>,
    loop_counter: u32,
    memory_segments: Vec<MemorySegment>,
    globals: Vec<(u32, i64)>,
    num_func_imports: u32,
    exported_func_idx: Option<u32>,  // Index of exported function (relative to defined functions)
    table_funcs: HashMap<u32, u32>,  // Table slot -> function index (for call_indirect dispatch)
}

impl StatefulAotCompiler {
    pub fn new() -> Self {
        Self {
            func_types: Vec::new(),
            func_type_indices: Vec::new(),
            import_func_type_indices: Vec::new(),
            functions: Vec::new(),
            loop_counter: 0,
            memory_segments: Vec::new(),
            globals: Vec::new(),
            num_func_imports: 0,
            exported_func_idx: None,
            table_funcs: HashMap::new(),
        }
    }

    pub fn compile(&mut self, bytes: &[u8]) -> Result<String, String> {
        eprintln!("[AOT] Starting metadata collection...");
        self.collect_metadata(bytes)?;
        eprintln!("[AOT] Metadata done. Memory segments: {}, globals: {}", self.memory_segments.len(), self.globals.len());
        eprintln!("[AOT] Starting function compilation...");
        self.compile_functions(bytes)?;
        eprintln!("[AOT] Functions compiled: {}", self.functions.len());
        eprintln!("[AOT] Emitting TypeScript...");
        let result = self.emit_typescript();
        eprintln!("[AOT] Done! Output size: {} bytes", result.len());
        Ok(result)
    }

    fn collect_metadata(&mut self, bytes: &[u8]) -> Result<(), String> {
        for payload in Parser::new(0).parse_all(bytes) {
            let payload = payload.map_err(|e| e.to_string())?;
            match payload {
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
                Payload::GlobalSection(reader) => {
                    let mut idx = 0u32;
                    for global in reader {
                        let global = global.map_err(|e| e.to_string())?;
                        let init_expr = global.init_expr.get_operators_reader();
                        for op in init_expr {
                            if let Ok(wasmparser::Operator::I32Const { value }) = op {
                                self.globals.push((idx, value as i64));
                            } else if let Ok(wasmparser::Operator::I64Const { value }) = op {
                                self.globals.push((idx, value));
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
                        if let wasmparser::DataKind::Active { memory_index: _, offset_expr } = data.kind {
                            let mut offset = 0u32;
                            let offset_reader = offset_expr.get_operators_reader();
                            for op in offset_reader {
                                if let Ok(wasmparser::Operator::I32Const { value }) = op {
                                    offset = value as u32;
                                }
                            }
                            self.memory_segments.push(MemorySegment {
                                offset,
                                data: data.data.to_vec(),
                            });
                        }
                    }
                }
                Payload::ImportSection(reader) => {
                    for import in reader {
                        let import = import.map_err(|e| e.to_string())?;
                        if let wasmparser::TypeRef::Func(type_idx) = import.ty {
                            self.import_func_type_indices.push(type_idx);
                            self.num_func_imports += 1;
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

        // Only active segments initialize the table before the program runs
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
    fn emit_indirect_dispatch(&self, output: &mut String, type_index: u32, entry_func_idx: usize) {
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
            // be reached; everything else traps at runtime
            if self.func_type_of(func_idx) != Some(func_type) {
                continue;
            }
            // Indirectly calling an import is not modelled - leave it as a trap
            if func_idx < self.num_func_imports {
                continue;
            }
            let local_idx = func_idx - self.num_func_imports;
            let name = if local_idx as usize == entry_func_idx {
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

        output.push_str(&format!(
            "// call_indirect dispatch for type {} ({} reachable target{})\ntype $indirect_{}<{}> =\n{}\n\n",
            type_index,
            targets,
            if targets == 1 { "" } else { "s" },
            type_index,
            params.join(", "),
            body
        ));
    }

    fn compile_functions(&mut self, bytes: &[u8]) -> Result<(), String> {
        // Collect function type indices
        for payload in Parser::new(0).parse_all(bytes) {
            let payload = payload.map_err(|e| e.to_string())?;
            if let Payload::FunctionSection(reader) = payload {
                for type_idx in reader {
                    let type_idx = type_idx.map_err(|e| e.to_string())?;
                    self.func_type_indices.push(type_idx);
                }
            }
        }

        // Compile code section
        let mut func_index: u32 = 0;
        let total_funcs = self.func_type_indices.len();
        for payload in Parser::new(0).parse_all(bytes) {
            let payload = payload.map_err(|e| e.to_string())?;
            if let Payload::CodeSectionEntry(body) = payload {
                eprintln!("[AOT] Compiling function {}/{}", func_index, total_funcs);
                let type_idx = self.func_type_indices.get(func_index as usize)
                    .ok_or_else(|| format!("No type index for function {}", func_index))?;
                let func_type = self.func_types.get(*type_idx as usize)
                    .ok_or_else(|| format!("No type for index {}", type_idx))?
                    .clone();

                let compiled = self.compile_function_body(func_index, &func_type, &body)
                    .map_err(|e| format!("Failed to compile function {}: {}", func_index, e))?;
                self.functions.push(compiled);
                func_index += 1;
            }
        }
        Ok(())
    }

    fn compile_function_body(
        &mut self,
        func_index: u32,
        func_type: &FuncType,
        body: &wasmparser::FunctionBody,
    ) -> Result<CompiledFunc, String> {
        let params: Vec<(String, ExprType)> = func_type.params()
            .iter()
            .enumerate()
            .map(|(i, vt)| (format!("$p{}", i), val_type_to_expr_type(vt)))
            .collect();

        let result_type = func_type.results().first().map(val_type_to_expr_type);
        let name = format!("$func_{}", func_index);

        // Get operators
        let ops_reader = body.get_operators_reader().map_err(|e| e.to_string())?;
        let ops: Vec<wasmparser::Operator> = ops_reader
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        // Count total locals
        let locals_reader = body.get_locals_reader().map_err(|e| e.to_string())?;
        let mut num_locals = params.len() as u32;
        for local in locals_reader {
            let (count, _) = local.map_err(|e| e.to_string())?;
            num_locals += count;
        }

        // Compile using FuncCompiler
        let compiler = FuncCompiler::new(
            func_index,
            ops,
            &params,
            num_locals,
            &self.func_types,
            &self.func_type_indices,
            self.num_func_imports,
        );

        let (final_state, body_result, loop_defs, indirect_types) = compiler.compile()?;

        Ok(CompiledFunc {
            name,
            params,
            result_type,
            body_state: Some(final_state),
            body_result,
            loop_defs,
            indirect_types,
        })
    }

    fn emit_typescript(&self) -> String {
        let mut output = String::new();

        // Imports
        output.push_str("import type { Wasm, WasmValue, Convert } from 'ts-type-math'\n\n");

        // State type
        output.push_str("// State type containing memory\n");
        output.push_str("type $State = { memory: Record<string, string> }\n\n");

        // Helper types for state operations
        // Memory is stored as 4-byte chunks at aligned addresses
        output.push_str("// Align address to 4-byte boundary\n");
        output.push_str("type $AlignAddr<Addr extends WasmValue> = Wasm.I32And<Addr, '11111111111111111111111111111100'>\n\n");

        output.push_str("// Get byte offset within aligned word\n");
        output.push_str("type $ByteOffset<Addr extends WasmValue> = Wasm.I32And<Addr, '00000000000000000000000000000011'>\n\n");

        output.push_str("// Read 4 bytes from memory at aligned address\n");
        output.push_str("type $ReadMem<S extends $State, Addr extends WasmValue> = \n");
        output.push_str("  $AlignAddr<Addr> extends infer AlignedAddr extends WasmValue\n");
        output.push_str("    ? AlignedAddr extends keyof S['memory'] \n");
        output.push_str("      ? S['memory'][AlignedAddr]\n");
        output.push_str("      : '00000000000000000000000000000000'\n");
        output.push_str("    : never\n\n");

        // Unaligned 32-bit load helper
        output.push_str("// Load 32 bits from potentially unaligned address\n");
        output.push_str("type $LoadI32<S extends $State, Addr extends WasmValue> =\n");
        output.push_str("  $ByteOffset<Addr> extends '00000000000000000000000000000000'\n");
        output.push_str("    ? $ReadMem<S, Addr>\n");
        output.push_str("    : Wasm.I32Or<\n");
        output.push_str("        Wasm.I32ShrU<$ReadMem<S, Addr>, Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>,\n");
        output.push_str("        Wasm.I32Shl<$ReadMem<S, Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>>, Wasm.I32Sub<'00000000000000000000000000100000', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>>\n");
        output.push_str("      >\n\n");

        // 16-bit load with cross-word support
        output.push_str("// Load 16 bits with cross-word support (handles byte offset 3)\n");
        output.push_str("type $Load16<S extends $State, A extends WasmValue> =\n");
        output.push_str("  $ByteOffset<A> extends '00000000000000000000000000000011'\n");
        output.push_str("    ? Wasm.I32Or<\n");
        output.push_str("        Wasm.I32ShrU<$ReadMem<S, A>, '00000000000000000000000000011000'>,\n");
        output.push_str("        Wasm.I32Shl<Wasm.I32And<$ReadMem<S, Wasm.I32Add<$AlignAddr<A>, '00000000000000000000000000000100'>>, '00000000000000000000000011111111'>, '00000000000000000000000000001000'>\n");
        output.push_str("      >\n");
        output.push_str("    : Wasm.I32And<\n");
        output.push_str("        Wasm.I32ShrU<$ReadMem<S, A>, Wasm.I32Shl<$ByteOffset<A>, '00000000000000000000000000000011'>>,\n");
        output.push_str("        '00000000000000001111111111111111'\n");
        output.push_str("      >\n\n");

        output.push_str("// Write 4 bytes to memory - returns new state\n");
        output.push_str("type $WriteMem<S extends $State, Addr extends WasmValue, Value extends WasmValue> = {\n");
        output.push_str("  memory: S['memory'] & Record<$AlignAddr<Addr>, Value>\n");
        output.push_str("}\n\n");

        // Sub-word store helpers: read-modify-write to preserve other bytes
        output.push_str("// 8-bit mask at byte offset position\n");
        output.push_str("type $Byte8Mask<Offset extends WasmValue> = Wasm.I32Shl<'00000000000000000000000011111111', Wasm.I32Shl<Offset, '00000000000000000000000000000011'>>\n");
        output.push_str("type $Not8Mask<Offset extends WasmValue> = Wasm.I32Xor<$Byte8Mask<Offset>, '11111111111111111111111111111111'>\n\n");

        output.push_str("// Store8: read-modify-write to preserve other bytes\n");
        output.push_str("type $Store8<S extends $State, Addr extends WasmValue, Val extends WasmValue> =\n");
        output.push_str("  $WriteMem<S, Addr, Wasm.I32Or<\n");
        output.push_str("    Wasm.I32And<$ReadMem<S, Addr>, $Not8Mask<$ByteOffset<Addr>>>,\n");
        output.push_str("    Wasm.I32Shl<Wasm.I32And<Val, '00000000000000000000000011111111'>, Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>\n");
        output.push_str("  >>\n\n");

        // Store16: read-modify-write with cross-word support
        output.push_str("// Store16: read-modify-write with cross-word support (handles byte offset 3)\n");
        output.push_str("type $Store16<S extends $State, Addr extends WasmValue, Val extends WasmValue> =\n");
        output.push_str("  $ByteOffset<Addr> extends '00000000000000000000000000000011'\n");
        output.push_str("    ? $WriteMem<\n");
        output.push_str("        $WriteMem<S, Addr, Wasm.I32Or<\n");
        output.push_str("          Wasm.I32And<$ReadMem<S, Addr>, '00000000111111111111111111111111'>,\n");
        output.push_str("          Wasm.I32Shl<Wasm.I32And<Val, '00000000000000000000000011111111'>, '00000000000000000000000000011000'>\n");
        output.push_str("        >>,\n");
        output.push_str("        Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>,\n");
        output.push_str("        Wasm.I32Or<\n");
        output.push_str("          Wasm.I32And<$ReadMem<S, Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>>, '11111111111111111111111100000000'>,\n");
        output.push_str("          Wasm.I32ShrU<Wasm.I32And<Val, '00000000000000001111111100000000'>, '00000000000000000000000000001000'>\n");
        output.push_str("        >\n");
        output.push_str("      >\n");
        output.push_str("    : $WriteMem<S, Addr, Wasm.I32Or<\n");
        output.push_str("        Wasm.I32And<$ReadMem<S, Addr>, Wasm.I32Xor<Wasm.I32Shl<'00000000000000001111111111111111', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>, '11111111111111111111111111111111'>>,\n");
        output.push_str("        Wasm.I32Shl<Wasm.I32And<Val, '00000000000000001111111111111111'>, Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>\n");
        output.push_str("      >>\n\n");

        // Store32: unaligned 32-bit store with cross-word support
        output.push_str("// Store32: unaligned 32-bit store with cross-word support\n");
        output.push_str("type $Store32<S extends $State, Addr extends WasmValue, Val extends WasmValue> =\n");
        output.push_str("  $ByteOffset<Addr> extends '00000000000000000000000000000000'\n");
        output.push_str("    ? $WriteMem<S, Addr, Val>\n");
        output.push_str("    : $WriteMem<\n");
        output.push_str("        $WriteMem<S, Addr, Wasm.I32Or<\n");
        output.push_str("          Wasm.I32And<$ReadMem<S, Addr>, Wasm.I32Sub<Wasm.I32Shl<'00000000000000000000000000000001', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>, '00000000000000000000000000000001'>>,\n");
        output.push_str("          Wasm.I32Shl<Val, Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>\n");
        output.push_str("        >>,\n");
        output.push_str("        Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>,\n");
        output.push_str("        Wasm.I32Or<\n");
        output.push_str("          Wasm.I32And<$ReadMem<S, Wasm.I32Add<$AlignAddr<Addr>, '00000000000000000000000000000100'>>, Wasm.I32Shl<'11111111111111111111111111111111', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>>,\n");
        output.push_str("          Wasm.I32ShrU<Val, Wasm.I32Sub<'00000000000000000000000000100000', Wasm.I32Shl<$ByteOffset<Addr>, '00000000000000000000000000000011'>>>\n");
        output.push_str("        >\n");
        output.push_str("      >\n\n");

        // Store64: 64-bit store writes two 32-bit cells
        output.push_str("// Store64: 64-bit store writes two 32-bit cells (low at addr, high at addr+4)\n");
        output.push_str("type $Store64<S extends $State, Addr extends WasmValue, Val extends WasmValue> =\n");
        output.push_str("  $Store32<\n");
        output.push_str("    $Store32<S, Addr, Wasm.I32WrapI64<Val>>,\n");
        output.push_str("    Wasm.I32Add<Addr, '00000000000000000000000000000100'>,\n");
        output.push_str("    Wasm.I32WrapI64<Wasm.I64ShrU<Val, '0000000000000000000000000000000000000000000000000000000000100000'>>\n");
        output.push_str("  >\n\n");

        output.push_str("// Extract state from [State, Value] tuple\n");
        output.push_str("type $GetState<T> = T extends [infer S, any] ? S : T\n\n");

        output.push_str("// Extract value from [State, Value] tuple\n");
        output.push_str("type $GetValue<T> = T extends [any, infer V] ? V : never\n\n");

        // Initial memory - stored as 4-byte chunks for efficiency
        // Memory is represented as i32 values at 4-byte aligned addresses
        output.push_str("// Initial memory from data section (4-byte chunks)\n");
        output.push_str("type $InitialMemory = {\n");

        eprintln!("[AOT] Building memory map...");
        // Build a byte-level map first
        let mut memory_bytes: std::collections::HashMap<u32, u8> = std::collections::HashMap::new();
        let mut max_addr: u32 = 0;
        for segment in &self.memory_segments {
            for (i, byte) in segment.data.iter().enumerate() {
                let addr = segment.offset + i as u32;
                memory_bytes.insert(addr, *byte);
                if addr > max_addr {
                    max_addr = addr;
                }
            }
        }

        eprintln!("[AOT] Memory map built: {} bytes, max_addr={}", memory_bytes.len(), max_addr);

        // Now output as 4-byte chunks (little-endian i32)
        let mut addr: u32 = 0;
        let mut chunk_count: u32 = 0;
        while addr <= max_addr {
            // Get 4 bytes at this address
            let b0 = memory_bytes.get(&addr).copied().unwrap_or(0);
            let b1 = memory_bytes.get(&(addr + 1)).copied().unwrap_or(0);
            let b2 = memory_bytes.get(&(addr + 2)).copied().unwrap_or(0);
            let b3 = memory_bytes.get(&(addr + 3)).copied().unwrap_or(0);

            // Skip all-zero chunks to save space
            if b0 != 0 || b1 != 0 || b2 != 0 || b3 != 0 {
                // Little-endian: compose i32 value
                let value: u32 = (b0 as u32) | ((b1 as u32) << 8) | ((b2 as u32) << 16) | ((b3 as u32) << 24);
                output.push_str(&format!(
                    "  '{}': '{}',\n",
                    format!("{:032b}", addr),
                    format!("{:032b}", value)
                ));
                chunk_count += 1;
            }
            addr += 4;
        }
        output.push_str("}\n\n");
        eprintln!("[AOT] Memory output done: {} chunks", chunk_count);

        output.push_str("type $InitialState = { memory: $InitialMemory }\n\n");

        // Globals
        for (idx, value) in &self.globals {
            output.push_str(&format!(
                "type $g{} = '{}'\n",
                idx,
                format!("{:032b}", *value as i32)
            ));
        }
        if !self.globals.is_empty() {
            output.push_str("\n");
        }

        // Import placeholders - generate for each imported function
        // These represent unknown state/results from import calls
        for import_idx in 0..self.num_func_imports {
            // State after calling import (unknown, but still a valid $State)
            output.push_str(&format!("type $import_{}_state = $State\n", import_idx));
            // Result from import (if it returns a value)
            if let Some(&type_idx) = self.import_func_type_indices.get(import_idx as usize) {
                if let Some(func_type) = self.func_types.get(type_idx as usize) {
                    if !func_type.results().is_empty() {
                        output.push_str(&format!("type $import_{}__result = WasmValue\n", import_idx));
                    }
                }
            }
        }
        if self.num_func_imports > 0 {
            output.push_str("\n");
        }

        // Loop type definitions (must come before functions that use them)
        for func in &self.functions {
            for loop_def in &func.loop_defs {
                output.push_str(&loop_def.body_expr);
                output.push_str("\n");
            }
        }

        // Functions
        // Use exported function if available, else last function
        let entry_func_idx = self.exported_func_idx
            .map(|idx| idx as usize)
            .unwrap_or_else(|| self.functions.len().saturating_sub(1));

        // call_indirect dispatch types (one per signature used by a call_indirect)
        let mut indirect_types: Vec<u32> = self
            .functions
            .iter()
            .flat_map(|func| func.indirect_types.iter().copied())
            .collect();
        indirect_types.sort_unstable();
        indirect_types.dedup();
        for type_index in indirect_types {
            self.emit_indirect_dispatch(&mut output, type_index, entry_func_idx);
        }

        for (idx, func) in self.functions.iter().enumerate() {
            let state_param = "$S extends $State";
            let value_params: String = func.params
                .iter()
                .map(|(name, _)| format!("{} extends WasmValue", name))
                .collect::<Vec<_>>()
                .join(", ");

            let all_params = if value_params.is_empty() {
                state_param.to_string()
            } else {
                format!("{}, {}", state_param, value_params)
            };

            let body = if func.result_type.is_some() {
                // Return [State, Result]
                let state_expr = func.body_state.as_ref()
                    .map(|e| e.to_typescript())
                    .unwrap_or_else(|| "$S".to_string());
                let result_expr = func.body_result.as_ref()
                    .map(|e| e.to_typescript())
                    .unwrap_or_else(|| "never".to_string());
                format!("[{}, {}]", state_expr, result_expr)
            } else {
                // Void - return just State
                func.body_state.as_ref()
                    .map(|e| e.to_typescript())
                    .unwrap_or_else(|| "$S".to_string())
            };

            if idx == entry_func_idx {
                output.push_str(&format!(
                    "type $entry_impl<{}> =\n  {}\n\n",
                    all_params,
                    body
                ));
            } else {
                output.push_str(&format!(
                    "type {}_impl<{}> =\n  {}\n\n",
                    func.name,
                    all_params,
                    body
                ));
            }
        }

        // Entry wrapper - use exported function
        if let Some(func) = self.functions.get(entry_func_idx) {
            let arg_types: String = func.params
                .iter()
                .map(|(_, t)| match t {
                    ExprType::I32 => "number",
                    ExprType::I64 => "bigint",
                })
                .collect::<Vec<_>>()
                .join(", ");

            let conversions: String = func.params
                .iter()
                .enumerate()
                .map(|(i, (_, t))| {
                    match t {
                        ExprType::I32 => format!("Convert.U32Decimal.ToU32Binary<Args[{}]>", i),
                        ExprType::I64 => format!("Convert.U64Decimal.ToU64Binary<Args[{}]>", i),
                    }
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
                    ExprType::I32 => "'i32'",
                    ExprType::I64 => "'i64'",
                };
                output.push_str(&format!(
                    "export type entry<Args extends [{}]> =\n  Convert.WasmValue.ToTSNumber<\n    $GetValue<$entry_impl<\n      {}\n    >>,\n    {}\n  >\n",
                    arg_types, call_args, type_str
                ));
            } else {
                // Void function - return state only
                output.push_str(&format!(
                    "export type entry<Args extends [{}]> =\n  $entry_impl<\n    {}\n  >\n",
                    arg_types, call_args
                ));
            }
        }

        output
    }
}

fn val_type_to_expr_type(vt: &ValType) -> ExprType {
    match vt {
        ValType::I32 => ExprType::I32,
        ValType::I64 => ExprType::I64,
        _ => ExprType::I32,
    }
}

fn binary_op(stack: &mut Vec<Expr>, op: &'static str) {
    let b = stack.pop().unwrap_or(Expr::Param("$b".to_string()));
    let a = stack.pop().unwrap_or(Expr::Param("$a".to_string()));
    stack.push(Expr::BinOp(op, Box::new(a), Box::new(b)));
}

fn unary_op(stack: &mut Vec<Expr>, op: &'static str) {
    let a = stack.pop().unwrap_or(Expr::Param("$a".to_string()));
    stack.push(Expr::UnaryOp(op, Box::new(a)));
}
