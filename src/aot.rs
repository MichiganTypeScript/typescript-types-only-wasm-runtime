use std::collections::HashMap;
use wasmparser::{
    FuncType, Parser, Payload, ValType,
};

/// Expression tree node - represents a value on the virtual stack
#[derive(Debug, Clone)]
pub enum Expr {
    /// Local/parameter reference: $p0, $p1, etc.
    Param(String),
    /// Constant value as binary string: '00000000...'
    Const(String, ExprType),
    /// Binary operation: Wasm.I32Add<a, b>
    BinOp(&'static str, Box<Expr>, Box<Expr>),
    /// Unary operation: Wasm.I32Clz<a>
    UnaryOp(&'static str, Box<Expr>),
    /// Conditional: cond extends TrueVal ? then_expr : else_expr
    Conditional {
        condition: Box<Expr>,
        then_expr: Box<Expr>,
        else_expr: Box<Expr>,
    },
    /// Select instruction: cond ? a : b (ternary)
    Select {
        condition: Box<Expr>,
        if_true: Box<Expr>,
        if_false: Box<Expr>,
    },
    /// If/else block result
    IfElse {
        condition: Box<Expr>,
        then_result: Box<Expr>,
        else_result: Option<Box<Expr>>,
    },
    /// Function call - inline the result expression
    Call {
        func_name: String,
        args: Vec<Expr>,
    },
    /// Loop invocation - calls a separately-defined loop type
    LoopCall {
        /// Unique loop identifier
        loop_id: u32,
        /// Initial values for loop parameters
        initial_args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, Copy)]
pub enum ExprType {
    I32,
    I64,
}

impl Expr {
    /// Convert expression tree to TypeScript type string
    pub fn to_typescript(&self) -> String {
        match self {
            Expr::Param(name) => name.clone(),
            Expr::Const(value, _) => format!("'{}'", value),
            Expr::BinOp(op, a, b) => {
                format!("{}<{}, {}>", op, a.to_typescript(), b.to_typescript())
            }
            Expr::UnaryOp(op, a) => {
                // Use $Load for memory operations instead of Wasm.I32Load
                if *op == "Wasm.I32Load" || *op == "Wasm.I64Load" {
                    format!("$Load<{}>", a.to_typescript())
                } else {
                    format!("{}<{}>", op, a.to_typescript())
                }
            }
            Expr::Conditional { condition, then_expr, else_expr } => {
                // condition extends '00000000000000000000000000000000' ? else : then
                // (WASM: 0 = false, non-zero = true)
                format!(
                    "({} extends '00000000000000000000000000000000' ? {} : {})",
                    condition.to_typescript(),
                    else_expr.to_typescript(),
                    then_expr.to_typescript()
                )
            }
            Expr::Select { condition, if_true, if_false } => {
                // select: if condition != 0, return if_true, else if_false
                format!(
                    "({} extends '00000000000000000000000000000000' ? {} : {})",
                    condition.to_typescript(),
                    if_false.to_typescript(),
                    if_true.to_typescript()
                )
            }
            Expr::IfElse { condition, then_result, else_result } => {
                // if/else: like select but may not have else branch
                match else_result {
                    Some(else_expr) => format!(
                        "({} extends '00000000000000000000000000000000' ? {} : {})",
                        condition.to_typescript(),
                        else_expr.to_typescript(),
                        then_result.to_typescript()
                    ),
                    None => format!(
                        "({} extends '00000000000000000000000000000000' ? never : {})",
                        condition.to_typescript(),
                        then_result.to_typescript()
                    ),
                }
            }
            Expr::Call { func_name, args } => {
                let args_str: String = args.iter()
                    .map(|a| a.to_typescript())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{}_impl<{}>", func_name, args_str)
            }
            Expr::LoopCall { loop_id, initial_args } => {
                let args_str: String = initial_args.iter()
                    .map(|e| e.to_typescript())
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("$loop_{}<{}>", loop_id, args_str)
            }
        }
    }
}

/// Loop type definition
#[derive(Debug, Clone)]
pub struct LoopDefinition {
    /// Unique loop ID
    pub loop_id: u32,
    /// Parameters: (local_index, param_name)
    pub params: Vec<(u32, String)>,
    /// Exit value (returned when condition is false)
    pub exit_value: Expr,
    /// Continue condition
    pub continue_condition: Expr,
    /// Updated values for next iteration (in same order as params)
    pub updated_values: Vec<Expr>,
}

impl LoopDefinition {
    pub fn to_typescript(&self) -> String {
        let param_list: String = self.params.iter()
            .map(|(_, name)| format!("{} extends WasmValue", name))
            .collect::<Vec<_>>()
            .join(", ");

        let updated_args: String = self.updated_values.iter()
            .map(|e| e.to_typescript())
            .collect::<Vec<_>>()
            .join(", ");

        format!(
            "type $loop_{}<{}> =\n  ({} extends '00000000000000000000000000000000' ? {} : $loop_{}<{}>)\n",
            self.loop_id,
            param_list,
            self.continue_condition.to_typescript(),
            self.exit_value.to_typescript(),
            self.loop_id,
            updated_args
        )
    }
}

/// Compiled function information
#[derive(Debug)]
pub struct CompiledFunc {
    pub name: String,
    pub params: Vec<(String, ExprType)>,
    pub result_type: Option<ExprType>,
    pub body_expr: Option<Expr>,
    pub loop_definitions: Vec<LoopDefinition>,
}

/// Context for compiling a function with control flow
struct CompileContext<'a> {
    function_index: u32,
    num_func_imports: u32,
    ops: &'a [wasmparser::Operator<'a>],
    pos: usize,
    params: &'a [(String, ExprType)],
    func_types: &'a [FuncType],
    func_type_indices: &'a [u32],
    /// Local variable bindings (index -> expression)
    locals: HashMap<u32, Expr>,
    /// Counter for generating unique loop IDs
    loop_counter: u32,
    /// Stack of control flow labels (for br targeting)
    /// Each entry is (is_loop, label_depth)
    label_stack: Vec<bool>,
    /// Collected loop definitions to emit as separate types
    loop_definitions: Vec<LoopDefinition>,
    /// Whether we're inside a loop (for parameter handling)
    in_loop: bool,
    /// Mapping of function params to loop params when inside a loop
    loop_param_mapping: HashMap<String, String>,
}

impl<'a> CompileContext<'a> {
    /// Skip forward until we've closed `depth` levels of nesting
    /// Used after unconditional branches where following code is dead
    fn skip_to_end(&mut self, mut depth: usize) -> Result<(), String> {
        use wasmparser::Operator::*;

        while self.pos < self.ops.len() && depth > 0 {
            let op = &self.ops[self.pos];
            self.pos += 1;

            match op {
                Block { .. } | Loop { .. } | If { .. } => depth += 1,
                End => depth -= 1,
                _ => {}
            }
        }
        Ok(())
    }

    /// Process a block of operators until End/Else
    fn process_block(&mut self, stack: &mut Vec<Expr>, stop_at_else: bool) -> Result<bool, String> {
        use wasmparser::Operator::*;

        while self.pos < self.ops.len() {
            let op = &self.ops[self.pos];
            self.pos += 1;

            match op {
                // End of block
                End => return Ok(false),

                // Else: return true to signal we hit else
                Else => {
                    if stop_at_else {
                        return Ok(true);
                    }
                    // Otherwise treat as end
                    return Ok(false);
                }

                // If/else: pop condition, process then/else branches
                If { blockty: _ } => {
                    let condition = stack.pop().ok_or("Stack underflow for If condition")?;

                    // Process then branch
                    let mut then_stack = stack.clone();
                    let has_else = self.process_block(&mut then_stack, true)?;
                    let then_result = then_stack.pop();

                    // Process else branch if present
                    let else_result = if has_else {
                        let mut else_stack = stack.clone();
                        self.process_block(&mut else_stack, false)?;
                        else_stack.pop()
                    } else {
                        None
                    };

                    // Push the if/else expression result if either branch has a result
                    if let Some(then_expr) = then_result {
                        stack.push(Expr::IfElse {
                            condition: Box::new(condition),
                            then_result: Box::new(then_expr),
                            else_result: else_result.map(Box::new),
                        });
                    }
                }

                // Block: process contents with label tracking
                Block { blockty: _ } => {
                    self.label_stack.push(false); // not a loop
                    self.process_block(stack, false)?;
                    self.label_stack.pop();
                }

                // Loop: process with recursive type generation
                Loop { blockty: _ } => {
                    let loop_id = self.loop_counter;
                    self.loop_counter += 1;

                    // Save initial state of all locals at loop entry
                    let initial_locals = self.locals.clone();
                    let was_in_loop = self.in_loop;
                    let old_param_mapping = self.loop_param_mapping.clone();

                    // Sort local indices for consistent ordering
                    let mut initial_local_indices: Vec<u32> = self.locals.keys().cloned().collect();
                    initial_local_indices.sort();

                    // Create symbolic parameter names for each local in the loop
                    let mut loop_params: Vec<(u32, String)> = initial_local_indices.iter()
                        .map(|idx| (*idx, format!("$loop_{}_l{}", loop_id, idx)))
                        .collect();

                    // Also add function parameters to loop params (they're immutable but need to be in scope)
                    let func_param_loop_names: Vec<(String, String)> = self.params.iter()
                        .enumerate()
                        .map(|(i, (name, _))| (name.clone(), format!("$loop_{}_p{}", loop_id, i)))
                        .collect();

                    // Set up loop param mapping for function parameters
                    self.in_loop = true;
                    self.loop_param_mapping.clear();
                    for (orig_name, loop_name) in &func_param_loop_names {
                        self.loop_param_mapping.insert(orig_name.clone(), loop_name.clone());
                    }

                    // Replace locals with symbolic loop parameters
                    for (idx, param_name) in &loop_params {
                        self.locals.insert(*idx, Expr::Param(param_name.clone()));
                    }

                    // Push loop label
                    self.label_stack.push(true);

                    // Process loop body with symbolic parameters
                    let mut loop_stack = stack.clone();
                    let continue_condition = self.process_loop_body(&mut loop_stack)?;

                    self.label_stack.pop();

                    // Restore loop state
                    self.in_loop = was_in_loop;
                    self.loop_param_mapping = old_param_mapping;

                    // Capture updated values after loop body (in terms of loop params)
                    // First, function params (unchanged - they pass through)
                    let mut updated_values: Vec<Expr> = func_param_loop_names.iter()
                        .map(|(_, loop_name)| Expr::Param(loop_name.clone()))
                        .collect();
                    // Then, local values
                    for (idx, _) in &loop_params {
                        let expr = self.locals.get(idx).cloned()
                            .unwrap_or_else(|| Expr::Param(format!("$l{}", idx)));
                        updated_values.push(expr);
                    }

                    // Prepend function params to loop_params for the type definition
                    let mut all_loop_params: Vec<(u32, String)> = func_param_loop_names.iter()
                        .enumerate()
                        .map(|(i, (_, loop_name))| (i as u32, loop_name.clone()))
                        .collect();
                    all_loop_params.extend(loop_params.iter().map(|(idx, name)| (*idx + self.params.len() as u32, name.clone())));

                    // Determine the exit value - this should be the "result" local
                    let exit_value = if let Some((_, param_name)) = loop_params.last() {
                        self.locals.get(&loop_params.last().unwrap().0).cloned()
                            .unwrap_or_else(|| Expr::Param(param_name.clone()))
                    } else {
                        Expr::Param("$loop_result".to_string())
                    };

                    if let Some(cond) = continue_condition {
                        // Create a loop definition with all params (func + locals)
                        let loop_def = LoopDefinition {
                            loop_id,
                            params: all_loop_params.clone(),
                            exit_value,
                            continue_condition: cond,
                            updated_values,
                        };
                        self.loop_definitions.push(loop_def);

                        // Get initial values from the saved state
                        // First, function params
                        let mut initial_args: Vec<Expr> = self.params.iter()
                            .map(|(name, _)| Expr::Param(name.clone()))
                            .collect();
                        // Then, local values
                        for (idx, _) in &loop_params {
                            let expr = initial_locals.get(idx).cloned()
                                .unwrap_or_else(|| Expr::Param(format!("$l{}", idx)));
                            initial_args.push(expr);
                        }

                        // Create the loop call expression
                        let loop_call = Expr::LoopCall {
                            loop_id,
                            initial_args,
                        };

                        // IMPORTANT: Restore ALL locals to pre-loop state first
                        // This prevents loop parameter names from leaking into code after the loop
                        self.locals = initial_locals;

                        // Then set the result local to the LoopCall
                        // The result is typically the last local modified in the loop
                        if let Some((local_idx, _)) = loop_params.last() {
                            self.locals.insert(*local_idx, loop_call);
                        }
                    } else {
                        // No br_if found - restore locals and treat as simple block
                        self.locals = initial_locals;
                    }
                }

                // Branch if (conditional)
                BrIf { relative_depth } => {
                    let depth = *relative_depth as usize;
                    // Pop the condition
                    if let Some(_condition) = stack.pop() {
                        // Check if branching to a loop
                        if depth < self.label_stack.len() {
                            let target_idx = self.label_stack.len() - 1 - depth;
                            if self.label_stack[target_idx] {
                                // Branching back to a loop - this continues the loop
                                // For proper handling, we'd need to restructure the code
                                // For now, we just note that a branch occurred
                            }
                        }
                    }
                }

                // Unconditional branch - skip to end of target block (dead code follows)
                Br { relative_depth } => {
                    // br N means jump to label at depth N
                    // depth 0 = current block, depth 1 = parent, etc.
                    // We need to skip N+1 levels to get past all intervening blocks
                    let depth = *relative_depth as usize + 1;
                    self.skip_to_end(depth)?;
                    return Ok(false);
                }

                // Branch table - always branches, so following code is dead
                BrTable { targets: _ } => {
                    stack.pop(); // pop the index
                    self.skip_to_end(1)?;
                    return Ok(false);
                }

                // Return: remaining stack is result, following code is dead
                Return => {
                    self.skip_to_end(1)?;
                    return Ok(false);
                }

                // Local/parameter access
                LocalGet { local_index } => {
                    let idx = *local_index as usize;
                    if idx < self.params.len() {
                        // Parameter - check if we need to use loop param mapping
                        let param_name = &self.params[idx].0;
                        if self.in_loop {
                            if let Some(loop_name) = self.loop_param_mapping.get(param_name) {
                                stack.push(Expr::Param(loop_name.clone()));
                            } else {
                                stack.push(Expr::Param(param_name.clone()));
                            }
                        } else {
                            stack.push(Expr::Param(param_name.clone()));
                        }
                    } else if let Some(expr) = self.locals.get(local_index) {
                        // Local variable - use stored expression
                        stack.push(expr.clone());
                    } else {
                        // Uninitialized local - use placeholder
                        stack.push(Expr::Param(format!("$l{}", idx)));
                    }
                }

                LocalSet { local_index } => {
                    // Pop value and store to local
                    if let Some(expr) = stack.pop() {
                        self.locals.insert(*local_index, expr);
                    }
                }

                LocalTee { local_index } => {
                    // Store to local but keep value on stack
                    if let Some(expr) = stack.last() {
                        self.locals.insert(*local_index, expr.clone());
                    }
                }

                // Constants
                I32Const { value } => {
                    stack.push(Expr::Const(format!("{:032b}", value), ExprType::I32));
                }
                I64Const { value } => {
                    stack.push(Expr::Const(format!("{:064b}", value), ExprType::I64));
                }

                // Function calls
                Call { function_index } => {
                    if *function_index < self.num_func_imports {
                        return Err(format!(
                            "Unsupported imported function call {} in function {}",
                            function_index, self.function_index
                        ));
                    }

                    let local_func_idx = *function_index - self.num_func_imports;
                    // Look up function's type index, then get the type
                    let type_idx = self.func_type_indices.get(local_func_idx as usize);
                    let func_type = type_idx.and_then(|idx| self.func_types.get(*idx as usize));

                    if let Some(func_type) = func_type {
                        let num_params = func_type.params().len();
                        let mut args = Vec::new();
                        for _ in 0..num_params {
                            if let Some(arg) = stack.pop() {
                                args.push(arg);
                            }
                        }
                        args.reverse();

                        // Push call expression if function returns a value
                        if !func_type.results().is_empty() {
                            stack.push(Expr::Call {
                                func_name: format!("$func_{}", local_func_idx),
                                args,
                            });
                        }
                    }
                }

                // i32 arithmetic
                I32Add => binary_op(stack, "Wasm.I32Add")?,
                I32Sub => binary_op(stack, "Wasm.I32Sub")?,
                I32Mul => binary_op(stack, "Wasm.I32Mul")?,
                I32DivS => binary_op(stack, "Wasm.I32DivS")?,
                I32DivU => binary_op(stack, "Wasm.I32DivU")?,
                I32RemS => binary_op(stack, "Wasm.I32RemS")?,
                I32RemU => binary_op(stack, "Wasm.I32RemU")?,

                // i32 bitwise
                I32And => binary_op(stack, "Wasm.I32And")?,
                I32Or => binary_op(stack, "Wasm.I32Or")?,
                I32Xor => binary_op(stack, "Wasm.I32Xor")?,
                I32Shl => binary_op(stack, "Wasm.I32Shl")?,
                I32ShrU => binary_op(stack, "Wasm.I32ShrU")?,
                I32ShrS => binary_op(stack, "Wasm.I32ShrS")?,
                I32Rotl => binary_op(stack, "Wasm.I32Rotl")?,
                I32Rotr => binary_op(stack, "Wasm.I32Rotr")?,
                I32Clz => unary_op(stack, "Wasm.I32Clz")?,
                I32Ctz => unary_op(stack, "Wasm.I32Ctz")?,
                I32Popcnt => unary_op(stack, "Wasm.I32Popcnt")?,

                // i32 comparison
                I32Eq => binary_op(stack, "Wasm.I32Eq")?,
                I32Ne => binary_op(stack, "Wasm.I32Neq")?,
                I32LtS => binary_op(stack, "Wasm.I32LtS")?,
                I32LtU => binary_op(stack, "Wasm.I32LtU")?,
                I32GtS => binary_op(stack, "Wasm.I32GtS")?,
                I32GtU => binary_op(stack, "Wasm.I32GtU")?,
                I32LeS => binary_op(stack, "Wasm.I32LeS")?,
                I32LeU => binary_op(stack, "Wasm.I32LeU")?,
                I32GeS => binary_op(stack, "Wasm.I32GeS")?,
                I32GeU => binary_op(stack, "Wasm.I32GeU")?,
                I32Eqz => unary_op(stack, "Wasm.I32Eqz")?,

                // i64 arithmetic
                I64Add => binary_op(stack, "Wasm.I64Add")?,
                I64Sub => binary_op(stack, "Wasm.I64Sub")?,
                I64Mul => binary_op(stack, "Wasm.I64Mul")?,
                I64DivS => binary_op(stack, "Wasm.I64DivS")?,
                I64DivU => binary_op(stack, "Wasm.I64DivU")?,
                I64RemS => binary_op(stack, "Wasm.I64RemS")?,
                I64RemU => binary_op(stack, "Wasm.I64RemU")?,

                // i64 bitwise
                I64And => binary_op(stack, "Wasm.I64And")?,
                I64Or => binary_op(stack, "Wasm.I64Or")?,
                I64Xor => binary_op(stack, "Wasm.I64Xor")?,
                I64Shl => binary_op(stack, "Wasm.I64Shl")?,
                I64ShrU => binary_op(stack, "Wasm.I64ShrU")?,
                I64ShrS => binary_op(stack, "Wasm.I64ShrS")?,

                // i64 comparison
                I64Eq => binary_op(stack, "Wasm.I64Eq")?,
                I64Ne => binary_op(stack, "Wasm.I64Neq")?,
                I64LtS => binary_op(stack, "Wasm.I64LtS")?,
                I64LtU => binary_op(stack, "Wasm.I64LtU")?,
                I64GtS => binary_op(stack, "Wasm.I64GtS")?,
                I64GtU => binary_op(stack, "Wasm.I64GtU")?,
                I64LeS => binary_op(stack, "Wasm.I64LeS")?,
                I64LeU => binary_op(stack, "Wasm.I64LeU")?,
                I64GeS => binary_op(stack, "Wasm.I64GeS")?,
                I64GeU => binary_op(stack, "Wasm.I64GeU")?,
                I64Eqz => unary_op(stack, "Wasm.I64Eqz")?,

                // Select: pop condition, pop if_false, pop if_true, push result
                Select { .. } => {
                    let condition = stack.pop().ok_or("Stack underflow for Select condition")?;
                    let if_false = stack.pop().ok_or("Stack underflow for Select if_false")?;
                    let if_true = stack.pop().ok_or("Stack underflow for Select if_true")?;
                    stack.push(Expr::Select {
                        condition: Box::new(condition),
                        if_true: Box::new(if_true),
                        if_false: Box::new(if_false),
                    });
                }

                // Drop: pop and discard top of stack
                Drop => {
                    stack.pop();
                }

                // Nop is ignored
                Nop => {}

                // Global operations
                GlobalGet { global_index } => {
                    stack.push(Expr::Param(format!("$g{}", global_index)));
                }
                GlobalSet { global_index: _ } => {
                    stack.pop();
                }

                // Memory load operations (pop address, push result)
                I32Load { memarg } | I32Load8S { memarg } | I32Load8U { memarg } |
                I32Load16S { memarg } | I32Load16U { memarg } => {
                    let addr = stack.pop().ok_or("Stack underflow for memory load")?;
                    // Add offset if non-zero
                    let final_addr = if memarg.offset > 0 {
                        Expr::BinOp("Wasm.I32Add",
                            Box::new(addr),
                            Box::new(Expr::Const(format!("{:032b}", memarg.offset as u32), ExprType::I32)))
                    } else {
                        addr
                    };
                    stack.push(Expr::UnaryOp("Wasm.I32Load", Box::new(final_addr)));
                }
                I64Load { memarg } | I64Load8S { memarg } | I64Load8U { memarg } |
                I64Load16S { memarg } | I64Load16U { memarg } | I64Load32S { memarg } | I64Load32U { memarg } => {
                    let addr = stack.pop().ok_or("Stack underflow for memory load")?;
                    // Add offset if non-zero
                    let final_addr = if memarg.offset > 0 {
                        Expr::BinOp("Wasm.I32Add",
                            Box::new(addr),
                            Box::new(Expr::Const(format!("{:032b}", memarg.offset as u32), ExprType::I32)))
                    } else {
                        addr
                    };
                    stack.push(Expr::UnaryOp("Wasm.I64Load", Box::new(final_addr)));
                }

                // Memory store operations (pop value and address)
                I32Store { .. } | I32Store8 { .. } | I32Store16 { .. } => {
                    stack.pop(); // value
                    stack.pop(); // address
                }
                I64Store { .. } | I64Store8 { .. } | I64Store16 { .. } | I64Store32 { .. } => {
                    stack.pop(); // value
                    stack.pop(); // address
                }

                // Memory size/grow
                MemorySize { .. } => {
                    stack.push(Expr::Param("$mem_size".to_string()));
                }
                MemoryGrow { .. } => {
                    let _ = stack.pop(); // pages to grow
                    stack.push(Expr::Param("$mem_grow_result".to_string()));
                }

                // Conversion operations (i32 <-> i64)
                I32WrapI64 => {
                    let val = stack.pop().ok_or("Stack underflow for I32WrapI64")?;
                    stack.push(Expr::UnaryOp("Wasm.I32WrapI64", Box::new(val)));
                }
                I64ExtendI32S => {
                    let val = stack.pop().ok_or("Stack underflow for I64ExtendI32S")?;
                    stack.push(Expr::UnaryOp("Wasm.I64ExtendI32S", Box::new(val)));
                }
                I64ExtendI32U => {
                    let val = stack.pop().ok_or("Stack underflow for I64ExtendI32U")?;
                    stack.push(Expr::UnaryOp("Wasm.I64ExtendI32U", Box::new(val)));
                }
                I32Extend8S | I32Extend16S => {
                    // Unary operation on i32, stack unchanged conceptually
                    let val = stack.pop().ok_or("Stack underflow for I32Extend")?;
                    stack.push(Expr::UnaryOp("Wasm.I32Extend", Box::new(val)));
                }

                // Unreachable - this path should never execute, following code is dead
                Unreachable => {
                    stack.push(Expr::Param("$unreachable".to_string()));
                    self.skip_to_end(1)?;
                    return Ok(false);
                }

                // CallIndirect - like Call but via table
                CallIndirect { .. } => {
                    return Err(format!(
                        "Unsupported operator CallIndirect in function {}",
                        self.function_index
                    ));
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

    /// Process a loop body and return the br_if condition if targeting this loop
    fn process_loop_body(&mut self, stack: &mut Vec<Expr>) -> Result<Option<Expr>, String> {
        use wasmparser::Operator::*;

        let mut continue_condition: Option<Expr> = None;

        while self.pos < self.ops.len() {
            let op = &self.ops[self.pos];
            self.pos += 1;

            match op {
                // End of loop
                End => {
                    return Ok(continue_condition);
                }

                // Branch if - check if it targets this loop (depth 0)
                BrIf { relative_depth } => {
                    if *relative_depth == 0 {
                        // This br_if targets our loop - capture the condition
                        if let Some(cond) = stack.pop() {
                            continue_condition = Some(cond);
                        }
                    } else {
                        // Targeting outer scope
                        stack.pop();
                    }
                }

                // Process other operators normally
                // Local/parameter access
                LocalGet { local_index } => {
                    let idx = *local_index as usize;
                    if idx < self.params.len() {
                        // Parameter - use loop param mapping if inside loop
                        let param_name = &self.params[idx].0;
                        if let Some(loop_name) = self.loop_param_mapping.get(param_name) {
                            stack.push(Expr::Param(loop_name.clone()));
                        } else {
                            stack.push(Expr::Param(param_name.clone()));
                        }
                    } else if let Some(expr) = self.locals.get(local_index) {
                        stack.push(expr.clone());
                    } else {
                        stack.push(Expr::Param(format!("$l{}", idx)));
                    }
                }

                LocalSet { local_index } => {
                    if let Some(expr) = stack.pop() {
                        self.locals.insert(*local_index, expr);
                    }
                }

                LocalTee { local_index } => {
                    if let Some(expr) = stack.last() {
                        self.locals.insert(*local_index, expr.clone());
                    }
                }

                // Constants
                I32Const { value } => {
                    stack.push(Expr::Const(format!("{:032b}", value), ExprType::I32));
                }
                I64Const { value } => {
                    stack.push(Expr::Const(format!("{:064b}", value), ExprType::I64));
                }

                // Arithmetic and comparison ops
                I32Add => binary_op(stack, "Wasm.I32Add")?,
                I32Sub => binary_op(stack, "Wasm.I32Sub")?,
                I32Mul => binary_op(stack, "Wasm.I32Mul")?,
                I32DivS => binary_op(stack, "Wasm.I32DivS")?,
                I32DivU => binary_op(stack, "Wasm.I32DivU")?,
                I32RemS => binary_op(stack, "Wasm.I32RemS")?,
                I32RemU => binary_op(stack, "Wasm.I32RemU")?,
                I32LtS => binary_op(stack, "Wasm.I32LtS")?,
                I32LtU => binary_op(stack, "Wasm.I32LtU")?,
                I32GtS => binary_op(stack, "Wasm.I32GtS")?,
                I32GtU => binary_op(stack, "Wasm.I32GtU")?,
                I32GeS => binary_op(stack, "Wasm.I32GeS")?,
                I32GeU => binary_op(stack, "Wasm.I32GeU")?,
                I32LeS => binary_op(stack, "Wasm.I32LeS")?,
                I32LeU => binary_op(stack, "Wasm.I32LeU")?,
                I32Eq => binary_op(stack, "Wasm.I32Eq")?,
                I32Ne => binary_op(stack, "Wasm.I32Neq")?,
                I32Eqz => unary_op(stack, "Wasm.I32Eqz")?,
                I32And => binary_op(stack, "Wasm.I32And")?,
                I32Or => binary_op(stack, "Wasm.I32Or")?,
                I32Xor => binary_op(stack, "Wasm.I32Xor")?,
                I32Shl => binary_op(stack, "Wasm.I32Shl")?,
                I32ShrS => binary_op(stack, "Wasm.I32ShrS")?,
                I32ShrU => binary_op(stack, "Wasm.I32ShrU")?,

                // Memory operations
                I32Load { .. } | I32Load8S { .. } | I32Load8U { .. } |
                I32Load16S { .. } | I32Load16U { .. } => {
                    let addr = stack.pop().ok_or("Stack underflow for memory load in loop")?;
                    stack.push(Expr::UnaryOp("Wasm.I32Load", Box::new(addr)));
                }
                I32Store { .. } | I32Store8 { .. } | I32Store16 { .. } => {
                    stack.pop(); // value
                    stack.pop(); // address
                }

                // Control flow inside loop
                If { blockty: _ } => {
                    // Pop condition and process if body
                    let _condition = stack.pop();
                    // Skip if body until End or Else
                    let mut depth = 1;
                    while self.pos < self.ops.len() && depth > 0 {
                        let inner_op = &self.ops[self.pos];
                        self.pos += 1;
                        match inner_op {
                            If { .. } | Block { .. } | Loop { .. } => depth += 1,
                            End => depth -= 1,
                            Else => if depth == 1 { /* continue processing else */ },
                            _ => {}
                        }
                    }
                }

                Block { blockty: _ } => {
                    // Process block body
                    let mut depth = 1;
                    while self.pos < self.ops.len() && depth > 0 {
                        let inner_op = &self.ops[self.pos];
                        self.pos += 1;
                        match inner_op {
                            If { .. } | Block { .. } | Loop { .. } => depth += 1,
                            End => depth -= 1,
                            _ => {}
                        }
                    }
                }

                // Unconditional branch - skip
                Br { .. } => {}

                // Select
                Select { .. } => {
                    let condition = stack.pop().ok_or("Stack underflow for Select condition in loop")?;
                    let if_false = stack.pop().ok_or("Stack underflow for Select if_false in loop")?;
                    let if_true = stack.pop().ok_or("Stack underflow for Select if_true in loop")?;
                    stack.push(Expr::Select {
                        condition: Box::new(condition),
                        if_true: Box::new(if_true),
                        if_false: Box::new(if_false),
                    });
                }

                // Drop
                Drop => { stack.pop(); }

                // Global operations
                GlobalGet { global_index } => {
                    stack.push(Expr::Param(format!("$g{}", global_index)));
                }
                GlobalSet { global_index: _ } => {
                    stack.pop();
                }

                // Function calls
                Call { function_index } => {
                    if *function_index < self.num_func_imports {
                        return Err(format!(
                            "Unsupported imported function call {} in function {}",
                            function_index, self.function_index
                        ));
                    }

                    let local_func_idx = *function_index - self.num_func_imports;
                    let type_idx = self.func_type_indices.get(local_func_idx as usize);
                    let func_type = type_idx.and_then(|idx| self.func_types.get(*idx as usize));
                    if let Some(func_type) = func_type {
                        let num_params = func_type.params().len();
                        let mut args = Vec::new();
                        for _ in 0..num_params {
                            if let Some(arg) = stack.pop() {
                                args.push(arg);
                            }
                        }
                        args.reverse();
                        if !func_type.results().is_empty() {
                            stack.push(Expr::Call {
                                func_name: format!("$func_{}", local_func_idx),
                                args,
                            });
                        }
                    }
                }

                CallIndirect { .. } => {
                    return Err(format!(
                        "Unsupported operator CallIndirect in function {}",
                        self.function_index
                    ));
                }
                op => {
                    return Err(format!(
                        "Unsupported operator {:?} in function {}",
                        op, self.function_index
                    ));
                }
            }
        }

        Ok(continue_condition)
    }
}

/// Memory segment from data section
#[derive(Debug, Clone)]
pub struct MemorySegment {
    pub offset: u32,
    pub data: Vec<u8>,
}

/// AOT compiler state
pub struct AotCompiler {
    /// Function type signatures (from type section)
    func_types: Vec<FuncType>,
    /// Mapping from function index to type index
    func_type_indices: Vec<u32>,
    num_func_imports: u32,
    /// Function names (from name section or generated)
    func_names: HashMap<u32, String>,
    /// Compiled functions
    pub functions: Vec<CompiledFunc>,
    /// Global loop counter for unique loop IDs across all functions
    loop_counter: u32,
    /// Memory segments from data section
    memory_segments: Vec<MemorySegment>,
    /// Initial memory size in pages
    memory_size: u32,
    /// Globals
    globals: Vec<(u32, i64)>, // (index, initial_value)
}

impl AotCompiler {
    pub fn new() -> Self {
        Self {
            func_types: Vec::new(),
            func_type_indices: Vec::new(),
            num_func_imports: 0,
            func_names: HashMap::new(),
            functions: Vec::new(),
            loop_counter: 0,
            memory_segments: Vec::new(),
            memory_size: 0,
            globals: Vec::new(),
        }
    }

    /// Compile WASM bytes to AOT TypeScript types
    pub fn compile(&mut self, bytes: &[u8]) -> Result<String, String> {
        // First pass: collect types and function info
        self.collect_metadata(bytes)?;

        // Second pass: compile function bodies
        self.compile_functions(bytes)?;

        // Generate TypeScript output
        Ok(self.emit_typescript())
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
                Payload::MemorySection(reader) => {
                    for memory in reader {
                        let memory = memory.map_err(|e| e.to_string())?;
                        self.memory_size = memory.initial as u32;
                    }
                }
                Payload::ImportSection(reader) => {
                    for import in reader {
                        let import = import.map_err(|e| e.to_string())?;
                        if let wasmparser::TypeRef::Func(_) = import.ty {
                            self.num_func_imports += 1;
                        }
                    }
                }
                Payload::GlobalSection(reader) => {
                    let mut idx = 0u32;
                    for global in reader {
                        let global = global.map_err(|e| e.to_string())?;
                        // Try to extract the initial value from the init expression
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
                Payload::DataSection(reader) => {
                    for data in reader {
                        let data = data.map_err(|e| e.to_string())?;
                        match data.kind {
                            wasmparser::DataKind::Active { memory_index: _, offset_expr } => {
                                // Parse offset expression to get constant offset
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
                            wasmparser::DataKind::Passive => {
                                // Passive segments are stored but not automatically loaded
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn compile_functions(&mut self, bytes: &[u8]) -> Result<(), String> {
        let mut func_index: u32 = 0;

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
        for payload in Parser::new(0).parse_all(bytes) {
            let payload = payload.map_err(|e| e.to_string())?;
            if let Payload::CodeSectionEntry(body) = payload {
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
        // Build parameter list
        let params: Vec<(String, ExprType)> = func_type.params()
            .iter()
            .enumerate()
            .map(|(i, vt)| {
                let name = format!("$p{}", i);
                let expr_type = val_type_to_expr_type(vt);
                (name, expr_type)
            })
            .collect();

        let result_type = func_type.results().first().map(val_type_to_expr_type);

        // Get function name (always use consistent $func_N naming for internal functions)
        let name = self.func_names
            .get(&func_index)
            .cloned()
            .unwrap_or_else(|| format!("$func_{}", func_index));

        // Collect operators into a vector for indexed access
        let ops_reader = body.get_operators_reader().map_err(|e| e.to_string())?;
        let ops: Vec<wasmparser::Operator> = ops_reader
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        // Initialize locals with symbolic names
        // First, parameters are locals 0..num_params
        // Then, declared locals follow
        let mut initial_locals: HashMap<u32, Expr> = HashMap::new();
        let num_params = params.len() as u32;

        // Parameters are initialized from function params
        for i in 0..num_params {
            initial_locals.insert(i, Expr::Param(format!("$p{}", i)));
        }

        // Parse local declarations and initialize with zero values
        // WASM locals are initialized to 0 by default
        let locals_reader = body.get_locals_reader().map_err(|e| e.to_string())?;
        let mut local_idx = num_params;
        for local in locals_reader {
            let (count, val_type) = local.map_err(|e| e.to_string())?;
            for _ in 0..count {
                // Initialize to zero - WASM default for locals
                let zero_value = match val_type {
                    ValType::I32 => Expr::Const("00000000000000000000000000000000".to_string(), ExprType::I32),
                    ValType::I64 => Expr::Const("0000000000000000000000000000000000000000000000000000000000000000".to_string(), ExprType::I64),
                    _ => Expr::Const("00000000000000000000000000000000".to_string(), ExprType::I32),
                };
                initial_locals.insert(local_idx, zero_value);
                local_idx += 1;
            }
        }

        // Process operators with control flow context
        // Use global loop counter for unique IDs across all functions
        let start_loop_counter = self.loop_counter;
        let loop_definitions;
        let body_expr;
        {
            let mut ctx = CompileContext {
                function_index: func_index,
                num_func_imports: self.num_func_imports,
                ops: &ops,
                pos: 0,
                params: &params,
                func_types: &self.func_types,
                func_type_indices: &self.func_type_indices,
                locals: initial_locals,
                loop_counter: start_loop_counter,
                label_stack: Vec::new(),
                loop_definitions: Vec::new(),
                in_loop: false,
                loop_param_mapping: HashMap::new(),
            };

            let mut stack: Vec<Expr> = Vec::new();
            ctx.process_block(&mut stack, false)?;

            // The final value on the stack is the result
            body_expr = stack.pop();

            // Debug: report if function has no body
            if body_expr.is_none() && result_type.is_some() {
                eprintln!("Warning: Function {} has result type but no body expression (stack was empty)", name);
            }

            loop_definitions = ctx.loop_definitions;
            // Update global loop counter
            self.loop_counter = ctx.loop_counter;
        }

        Ok(CompiledFunc {
            name,
            params,
            result_type,
            body_expr,
            loop_definitions,
        })
    }

    fn emit_typescript(&self) -> String {
        let mut output = String::new();

        // Imports - include Load for memory operations
        output.push_str("import type { Wasm, WasmValue, Convert, Load } from 'ts-type-math'\n\n");

        // Define $unreachable type for unreachable code paths
        output.push_str("type $unreachable = never\n\n");

        // Emit memory if we have data segments
        if !self.memory_segments.is_empty() {
            output.push_str("// Initial memory from data section\n");
            output.push_str("type $memory = {\n");
            for segment in &self.memory_segments {
                for (i, byte) in segment.data.iter().enumerate() {
                    let addr = segment.offset + i as u32;
                    output.push_str(&format!(
                        "  '{}': '{}',\n",
                        format!("{:032b}", addr),
                        format!("{:08b}", byte)
                    ));
                }
            }
            output.push_str("}\n\n");
        } else {
            output.push_str("type $memory = {}\n\n");
        }

        // Emit globals
        if !self.globals.is_empty() {
            for (idx, value) in &self.globals {
                output.push_str(&format!(
                    "type $g{} = '{}'\n",
                    idx,
                    format!("{:032b}", *value as i32)
                ));
            }
            output.push_str("\n");
        }

        // Helper type for memory loads - reads from $memory
        output.push_str("type $Load<Addr extends WasmValue> = Load.Read4Bytes<{}, $memory, Addr>\n\n");

        // Find the entry function (usually the last one or named $entry)
        let entry_func_idx = self.functions.iter()
            .position(|f| f.name == "$entry" || f.name.contains("entry"))
            .or_else(|| {
                if !self.functions.is_empty() {
                    Some(self.functions.len() - 1)
                } else {
                    None
                }
            });

        // Emit loop type definitions first (they may be referenced by functions)
        for func in &self.functions {
            for loop_def in &func.loop_definitions {
                output.push_str(&loop_def.to_typescript());
                output.push('\n');
            }
        }

        // Emit all non-entry functions as helper types
        for (idx, func) in self.functions.iter().enumerate() {
            if Some(idx) == entry_func_idx {
                continue; // Skip entry, we'll emit it last with wrapper
            }

            let type_params: String = func.params
                .iter()
                .map(|(name, _)| format!("{} extends WasmValue", name))
                .collect::<Vec<_>>()
                .join(", ");

            // Void functions return 'void', functions with no body return 'never'
            let body = if func.result_type.is_none() {
                // Void function - return void type
                "void".to_string()
            } else if func.body_expr.is_none() {
                // Has result type but no body expression
                "never".to_string()
            } else {
                func.body_expr.as_ref().unwrap().to_typescript()
            };

            output.push_str(&format!(
                "type {}_impl<{}> =\n  {}\n\n",
                func.name,
                type_params,
                body
            ));
        }

        // Emit entry function
        if let Some(idx) = entry_func_idx {
            let func = &self.functions[idx];

            // Emit the implementation type
            let type_params: String = func.params
                .iter()
                .map(|(name, _)| format!("{} extends WasmValue", name))
                .collect::<Vec<_>>()
                .join(", ");

            let body = func.body_expr
                .as_ref()
                .map(|e| e.to_typescript())
                .unwrap_or_else(|| "never".to_string());

            output.push_str(&format!(
                "type $entry_impl<{}> =\n  {}\n\n",
                type_params,
                body
            ));

            // Emit the entry wrapper with argument conversion
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

            let result_type = match func.result_type {
                Some(ExprType::I32) => "'i32'",
                Some(ExprType::I64) => "'i64'",
                None => "'i32'", // default
            };

            output.push_str(&format!(
                "export type entry<Args extends [{}]> =\n  Convert.WasmValue.ToTSNumber<\n    $entry_impl<\n      {}\n    >,\n    {}\n  >\n",
                arg_types,
                conversions,
                result_type
            ));
        }

        output
    }
}

fn val_type_to_expr_type(vt: &ValType) -> ExprType {
    match vt {
        ValType::I32 => ExprType::I32,
        ValType::I64 => ExprType::I64,
        _ => ExprType::I32, // Default for unsupported types
    }
}

fn binary_op(stack: &mut Vec<Expr>, op: &'static str) -> Result<(), String> {
    let b = stack.pop().unwrap_or_else(|| Expr::Param("$stack_underflow".to_string()));
    let a = stack.pop().unwrap_or_else(|| Expr::Param("$stack_underflow".to_string()));
    stack.push(Expr::BinOp(op, Box::new(a), Box::new(b)));
    Ok(())
}

fn unary_op(stack: &mut Vec<Expr>, op: &'static str) -> Result<(), String> {
    let a = stack.pop().unwrap_or_else(|| Expr::Param("$stack_underflow".to_string()));
    stack.push(Expr::UnaryOp(op, Box::new(a)));
    Ok(())
}

fn binary_op_lenient(stack: &mut Vec<Expr>, op: &'static str) {
    let b = stack.pop().unwrap_or_else(|| Expr::Param("$stack_underflow".to_string()));
    let a = stack.pop().unwrap_or_else(|| Expr::Param("$stack_underflow".to_string()));
    stack.push(Expr::BinOp(op, Box::new(a), Box::new(b)));
}

fn unary_op_lenient(stack: &mut Vec<Expr>, op: &'static str) {
    let a = stack.pop().unwrap_or_else(|| Expr::Param("$stack_underflow".to_string()));
    stack.push(Expr::UnaryOp(op, Box::new(a)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aot_clean::CleanAotCompiler;
    use crate::aot_stateful::StatefulAotCompiler;
    use std::fs;

    #[test]
    fn test_compile_c_add() {
        let wasm_bytes = fs::read("./packages/conformance-tests/from-c/c-add.wasm")
            .expect("Failed to read c-add.wasm");

        let mut compiler = AotCompiler::new();
        let output = compiler.compile(&wasm_bytes).expect("Failed to compile");

        println!("Generated TypeScript:\n{}", output);

        // Should contain the Add operation
        assert!(output.contains("Wasm.I32Add"));
    }

    #[test]
    fn rejects_unsupported_operator_in_all_aot_compilers() {
        let wasm_bytes = fs::read("./packages/conformance-tests/from-wat/negate.wasm")
            .expect("Failed to read negate.wasm");

        let legacy_error = AotCompiler::new().compile(&wasm_bytes).unwrap_err();
        let clean_error = CleanAotCompiler::new().compile(&wasm_bytes).unwrap_err();
        let stateful_error = StatefulAotCompiler::new().compile(&wasm_bytes).unwrap_err();

        for error in [legacy_error, clean_error, stateful_error] {
            assert!(error.contains("Unsupported operator F64Neg"), "{error}");
            assert!(error.contains("function 0"), "{error}");
        }
    }

    #[test]
    fn legacy_aot_compiler_rejects_call_indirect() {
        let wasm_bytes = fs::read("./packages/conformance-tests/from-wat/call-indirect.wasm")
            .expect("Failed to read call-indirect.wasm");

        let legacy_error = AotCompiler::new().compile(&wasm_bytes).unwrap_err();
        assert!(
            legacy_error.contains("Unsupported operator CallIndirect"),
            "{legacy_error}"
        );
        assert!(legacy_error.contains("function 1"), "{legacy_error}");
    }

    #[test]
    fn compiles_call_indirect_to_a_dispatch_type() {
        let wasm_bytes = fs::read("./packages/conformance-tests/from-wat/call-indirect.wasm")
            .expect("Failed to read call-indirect.wasm");

        for output in [
            CleanAotCompiler::new().compile(&wasm_bytes).unwrap(),
            StatefulAotCompiler::new().compile(&wasm_bytes).unwrap(),
        ] {
            // The single table entry at index 0 is $add, so the dispatch has to
            // route index 0 to it and trap (never) for anything else
            assert!(
                output.contains("type $indirect_0<$S extends $State, $callee extends WasmValue, $a0 extends WasmValue, $a1 extends WasmValue>"),
                "{output}"
            );
            assert!(
                output.contains("$callee extends '00000000000000000000000000000000' ? $func_0_impl<$S, $a0, $a1>"),
                "{output}"
            );
            assert!(output.contains("never"), "{output}");
        }
    }

    #[test]
    fn call_indirect_dispatch_respects_the_element_offset() {
        // The table is initialized at offset 1, so index 1 is $add and index 2
        // is $multiply - index 0 stays empty and must trap
        let wasm_bytes = fs::read("./packages/conformance-tests/from-wat/call-indirect-offset.wasm")
            .expect("Failed to read call-indirect-offset.wasm");

        for output in [
            CleanAotCompiler::new().compile(&wasm_bytes).unwrap(),
            StatefulAotCompiler::new().compile(&wasm_bytes).unwrap(),
        ] {
            assert!(
                output.contains("$callee extends '00000000000000000000000000000001' ? $func_0_impl<$S, $a0, $a1>"),
                "{output}"
            );
            assert!(
                output.contains("$callee extends '00000000000000000000000000000010' ? $func_1_impl<$S, $a0, $a1>"),
                "{output}"
            );
            assert!(
                !output.contains("$callee extends '00000000000000000000000000000000'"),
                "{output}"
            );
        }
    }

    /// Independently parse a module's table, function signatures and imports so
    /// the dispatch assertions below do not depend on hardcoded counts that go
    /// stale whenever the checked-in wasm is regenerated.
    struct TableOracle {
        num_func_imports: u32,
        /// type index per *defined* function (imports excluded)
        defined_func_types: Vec<u32>,
        /// import index -> type index
        import_func_types: Vec<u32>,
        /// table slot -> function index
        table: std::collections::BTreeMap<u32, u32>,
        /// distinct type indices, so we can exercise every dispatch type
        num_types: u32,
    }

    impl TableOracle {
        fn parse(wasm_bytes: &[u8]) -> Self {
            use wasmparser::{Element, ElementItems, ElementKind, ExternalKind, Operator, TypeRef};

            let mut oracle = TableOracle {
                num_func_imports: 0,
                defined_func_types: Vec::new(),
                import_func_types: Vec::new(),
                table: std::collections::BTreeMap::new(),
                num_types: 0,
            };

            for payload in Parser::new(0).parse_all(wasm_bytes) {
                match payload.unwrap() {
                    Payload::TypeSection(reader) => {
                        oracle.num_types = reader.count();
                    }
                    Payload::ImportSection(reader) => {
                        for import in reader {
                            let import = import.unwrap();
                            if let TypeRef::Func(type_idx) = import.ty {
                                oracle.import_func_types.push(type_idx);
                                oracle.num_func_imports += 1;
                            }
                        }
                    }
                    Payload::FunctionSection(reader) => {
                        for type_idx in reader {
                            oracle.defined_func_types.push(type_idx.unwrap());
                        }
                    }
                    Payload::ElementSection(reader) => {
                        for element in reader {
                            let Element { kind, items, .. } = element.unwrap();
                            let ElementKind::Active {
                                table_index,
                                offset_expr,
                            } = kind
                            else {
                                continue;
                            };
                            if table_index.unwrap_or(0) != 0 {
                                continue;
                            }
                            let mut base = 0u32;
                            for op in offset_expr.get_operators_reader() {
                                if let Ok(Operator::I32Const { value }) = op {
                                    base = value as u32;
                                }
                            }
                            match items {
                                ElementItems::Functions(funcs) => {
                                    for (slot, func_idx) in funcs.into_iter().enumerate() {
                                        oracle.table.insert(base + slot as u32, func_idx.unwrap());
                                    }
                                }
                                ElementItems::Expressions(_, exprs) => {
                                    for (slot, expr) in exprs.into_iter().enumerate() {
                                        for op in expr.unwrap().get_operators_reader() {
                                            if let Ok(Operator::RefFunc { function_index }) = op {
                                                oracle
                                                    .table
                                                    .insert(base + slot as u32, function_index);
                                            }
                                        }
                                    }
                                }
                            }
                            let _ = ExternalKind::Func;
                        }
                    }
                    _ => {}
                }
            }
            oracle
        }

        fn type_of(&self, func_idx: u32) -> Option<u32> {
            if func_idx < self.num_func_imports {
                self.import_func_types.get(func_idx as usize).copied()
            } else {
                self.defined_func_types
                    .get((func_idx - self.num_func_imports) as usize)
                    .copied()
            }
        }

        /// Slots that a `call_indirect` of `type_index` can actually reach:
        /// signature must match exactly and imports are left as traps.
        fn reachable(&self, type_index: u32) -> Vec<(u32, u32)> {
            self.table
                .iter()
                .filter(|(_, &func_idx)| {
                    func_idx >= self.num_func_imports && self.type_of(func_idx) == Some(type_index)
                })
                .map(|(&slot, &func_idx)| (slot, func_idx - self.num_func_imports))
                .collect()
        }
    }

    #[test]
    fn call_indirect_only_dispatches_to_matching_signatures() {
        // Every dispatch type must list exactly the table slots whose function
        // signature matches that call_indirect type - never a slot of another
        // signature, which would let a mistyped call through instead of trapping.
        let wasm_bytes =
            fs::read("./packages/playground/doom/doom.wasm").expect("Failed to read doom.wasm");
        let oracle = TableOracle::parse(&wasm_bytes);

        let mut compiler = CleanAotCompiler::new();
        compiler.collect_metadata(&wasm_bytes).unwrap();

        assert!(
            !oracle.table.is_empty(),
            "doom.wasm has no active table entries, so this test proves nothing"
        );

        let mut types_with_targets = 0;
        for type_index in 0..oracle.num_types {
            let expected = oracle.reachable(type_index);

            let mut out = String::new();
            compiler.emit_indirect_dispatch(&mut out, type_index, usize::MAX);

            assert!(
                out.contains(&format!(
                    "({} reachable target{})",
                    expected.len(),
                    if expected.len() == 1 { "" } else { "s" }
                )),
                "type {type_index} should reach {} slots\n{out}",
                expected.len()
            );

            for (slot, local_idx) in &expected {
                assert!(
                    out.contains(&format!(
                        "$callee extends '{slot:032b}' ? $func_{local_idx}_impl<"
                    )),
                    "type {type_index} must route slot {slot} to $func_{local_idx}_impl\n{out}"
                );
            }

            // Nothing outside the matching set may appear, and a miss must trap.
            let emitted_slots = out.matches("$callee extends '").count();
            assert_eq!(
                emitted_slots,
                expected.len(),
                "type {type_index} emitted extra dispatch arms\n{out}"
            );
            assert!(out.trim_end().ends_with("never"), "{out}");

            if !expected.is_empty() {
                types_with_targets += 1;
            }
        }

        assert!(
            types_with_targets > 0,
            "no dispatch type reached any table slot, so signature filtering was never exercised"
        );
    }
}
