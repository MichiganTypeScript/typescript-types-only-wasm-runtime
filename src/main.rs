use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    env,
    ffi::OsStr,
    fmt,
    fs::{self, DirEntry},
    path::{Path, PathBuf},
    process::Command,
    str::from_utf8,
    thread,
};

use indexmap::{IndexMap, IndexSet};

mod aot;
mod word4;
mod aot_cfg;
mod aot_clean;
mod aot_stateful;

use wast::{
    core::{
        DataVal, Elem, ElemKind, Func, FuncKind, Global, GlobalKind, Instruction, Memory, MemoryKind, MemoryType, Module, ModuleField, ModuleKind, Type,
        ValType,
    },
    parser,
    token::{Id, Index},
    Wat,
};

pub fn handle_instructions(func: &Func, instrs: &mut VecDeque<&Instruction>, indent: &mut usize, context: &mut Vec<&str>) -> Vec<(usize, String)> {
    let mut result: Vec<(usize, String)> = vec![];

    while let Some(instruction) = instrs.pop_front() {
        result.extend(handle_instruction(func, instrs, instruction, indent, context));
    }
    result
}

fn format_offset(offset: u64) -> String {
    if offset == 0 {
        return "".to_string();
    }
    format!("; offset: '{:032b}'", offset)
}

#[allow(clippy::useless_format)]
fn handle_instruction(
    func: &Func,
    instrs: &mut VecDeque<&Instruction>,
    instruction: &Instruction,
    indent: &mut usize,
    context: &mut Vec<&str>,
) -> Vec<(usize, String)> {
    match instruction {
        /**************
         * Numeric Instructions
         **************/

        /* Constants Instructions */
        Instruction::I32Const(value) => {
            vec![(*indent, format!("{{ kind: 'Const'; value: '{:032b}' }},", value))]
        }
        Instruction::I64Const(value) => {
            vec![(*indent, format!("{{ kind: 'Const'; value: '{:064b}' }},", value))]
        }
        Instruction::F32Const(f32) => {
            vec![(*indent, format!("{{ kind: 'Const'; value: '{:032b}' }},", f32.bits))]
        }
        Instruction::F64Const(f64) => {
            vec![(*indent, format!("{{ kind: 'Const'; value: '{:064b}' }},", f64.bits))]
        }

        /* Comparison Instructions */
        Instruction::I32Eqz => {
            vec![(*indent, format!("{{ kind: 'EqualsZero', type: 'i32' }},"))]
        }
        Instruction::I64Eqz => {
            vec![(*indent, format!("{{ kind: 'EqualsZero', type: 'i64' }},"))]
        }
        Instruction::I32Eq => {
            vec![(*indent, format!("{{ kind: 'Equals', type: 'i32' }},"))]
        }
        Instruction::I64Eq => {
            vec![(*indent, format!("{{ kind: 'Equals', type: 'i64' }},"))]
        }
        Instruction::F32Eq => {
            vec![(*indent, format!("{{ kind: 'Equals', type: 'f32' }},"))]
        }
        Instruction::F64Eq => {
            vec![(*indent, format!("{{ kind: 'Equals', type: 'f64' }},"))]
        }
        Instruction::I32Ne => {
            vec![(*indent, format!("{{ kind: 'NotEqual', type: 'i32' }},"))]
        }
        Instruction::I64Ne => {
            vec![(*indent, format!("{{ kind: 'NotEqual', type: 'i64' }},"))]
        }
        Instruction::F32Ne => {
            vec![(*indent, format!("{{ kind: 'NotEqual', type: 'i32' }},"))]
        }
        Instruction::F64Ne => {
            vec![(*indent, format!("{{ kind: 'NotEqual', type: 'f64' }},"))]
        }

        Instruction::I32GtS => {
            vec![(*indent, format!("{{ kind: 'GreaterThan', signed: true, type: 'i32' }},"))]
        }
        Instruction::I64GtS => {
            vec![(*indent, format!("{{ kind: 'GreaterThan', signed: true, type: 'i64' }},"))]
        }
        Instruction::I32GtU => {
            vec![(*indent, format!("{{ kind: 'GreaterThan', signed: false, type: 'i32' }},"))]
        }
        Instruction::I64GtU => {
            vec![(*indent, format!("{{ kind: 'GreaterThan', signed: false, type: 'i64' }},"))]
        }
        Instruction::F32Gt => {
            vec![(*indent, format!("{{ kind: 'GreaterThan', signed: true, type: 'f32' }},"))]
        }
        Instruction::F64Gt => {
            vec![(*indent, format!("{{ kind: 'GreaterThan', signed: true, type: 'f64' }},"))]
        }

        Instruction::I32LtS => {
            vec![(*indent, format!("{{ kind: 'LessThan', signed: true, type: 'i32' }},"))]
        }
        Instruction::I64LtS => {
            vec![(*indent, format!("{{ kind: 'LessThan', signed: true, type: 'i64' }},"))]
        }
        Instruction::I32LtU => {
            vec![(*indent, format!("{{ kind: 'LessThan', signed: false, type: 'i32' }},"))]
        }
        Instruction::I64LtU => {
            vec![(*indent, format!("{{ kind: 'LessThan', signed: false, type: 'i64' }},"))]
        }
        Instruction::F32Lt => {
            vec![(*indent, format!("{{ kind: 'LessThan', signed: true, type: 'f32' }},"))]
        }
        Instruction::F64Lt => {
            vec![(*indent, format!("{{ kind: 'LessThan', signed: true, type: 'f64' }},"))]
        }

        Instruction::I32GeS => {
            vec![(*indent, format!("{{ kind: 'GreaterThanOrEqual', signed: true, type: 'i32' }},"))]
        }
        Instruction::I64GeS => {
            vec![(*indent, format!("{{ kind: 'GreaterThanOrEqual', signed: true, type: 'i64' }},"))]
        }
        Instruction::I32GeU => {
            vec![(*indent, format!("{{ kind: 'GreaterThanOrEqual', signed: false, type: 'i32' }},"))]
        }
        Instruction::I64GeU => {
            vec![(*indent, format!("{{ kind: 'GreaterThanOrEqual', signed: false, type: 'i64' }},"))]
        }
        Instruction::F32Ge => {
            vec![(*indent, format!("{{ kind: 'GreaterThanOrEqual', signed: true, type: 'f32' }},"))]
        }
        Instruction::F64Ge => {
            vec![(*indent, format!("{{ kind: 'GreaterThanOrEqual', signed: true, type: 'f64' }},"))]
        }

        Instruction::I32LeS => {
            vec![(*indent, format!("{{ kind: 'LessThanOrEqual', signed: true, type: 'i32' }},"))]
        }
        Instruction::I64LeS => {
            vec![(*indent, format!("{{ kind: 'LessThanOrEqual', signed: true, type: 'i64' }},"))]
        }
        Instruction::I32LeU => {
            vec![(*indent, format!("{{ kind: 'LessThanOrEqual', signed: false, type: 'i32' }},"))]
        }
        Instruction::I64LeU => {
            vec![(*indent, format!("{{ kind: 'LessThanOrEqual', signed: false, type: 'i64' }},"))]
        }
        Instruction::F32Le => {
            vec![(*indent, format!("{{ kind: 'LessThanOrEqual', signed: true, type: 'f32' }},"))]
        }
        Instruction::F64Le => {
            vec![(*indent, format!("{{ kind: 'LessThanOrEqual', signed: true, type: 'f64' }},"))]
        }

        /* Arithmetic Instructions */
        Instruction::I32Add => {
            vec![(*indent, format!("{{ kind: 'Add', type: 'i32' }},"))]
        }
        Instruction::I64Add => {
            vec![(*indent, format!("{{ kind: 'Add', type: 'i64' }},"))]
        }
        Instruction::F32Add => {
            vec![(*indent, format!("{{ kind: 'Add', type: 'f32' }},"))]
        }
        Instruction::F64Add => {
            vec![(*indent, format!("{{ kind: 'Add', type: 'f64' }},"))]
        }
        Instruction::I32Sub => {
            vec![(*indent, format!("{{ kind: 'Subtract', type: 'i32' }},"))]
        }
        Instruction::I64Sub => {
            vec![(*indent, format!("{{ kind: 'Subtract', type: 'i64' }},"))]
        }
        Instruction::F32Sub => {
            vec![(*indent, format!("{{ kind: 'Subtract', type: 'f32' }},"))]
        }
        Instruction::F64Sub => {
            vec![(*indent, format!("{{ kind: 'Subtract', type: 'f64' }},"))]
        }
        Instruction::I32Mul => {
            vec![(*indent, format!("{{ kind: 'Multiply', type: 'i32' }},"))]
        }
        Instruction::I64Mul => {
            vec![(*indent, format!("{{ kind: 'Multiply', type: 'i64' }},"))]
        }
        Instruction::F32Mul => {
            vec![(*indent, format!("{{ kind: 'Multiply', type: 'f32' }},"))]
        }
        Instruction::F64Mul => {
            vec![(*indent, format!("{{ kind: 'Multiply', type: 'f64' }},"))]
        }
        Instruction::F32Div => {
            vec![(*indent, format!("{{ kind: 'Divide', signed: true, type: 'f32' }},"))]
        }
        Instruction::F64Div => {
            vec![(*indent, format!("{{ kind: 'Divide', signed: true, type: 'f64' }},"))]
        }
        Instruction::I32DivS => {
            vec![(*indent, format!("{{ kind: 'Divide', signed: true, type: 'i32' }},"))]
        }
        Instruction::I64DivS => {
            vec![(*indent, format!("{{ kind: 'Divide', signed: true, type: 'i64' }},"))]
        }
        Instruction::I32DivU => {
            vec![(*indent, format!("{{ kind: 'Divide', signed: false, type: 'i32' }},"))]
        }
        Instruction::I64DivU => {
            vec![(*indent, format!("{{ kind: 'Divide', signed: false, type: 'i64' }},"))]
        }
        Instruction::I32RemS => {
            vec![(*indent, format!("{{ kind: 'Remainder', signed: true, type: 'i32' }},"))]
        }
        Instruction::I64RemS => {
            vec![(*indent, format!("{{ kind: 'Remainder', signed: true, type: 'i64' }},"))]
        }
        Instruction::I32RemU => {
            vec![(*indent, format!("{{ kind: 'Remainder', signed: false, type: 'i32' }},"))]
        }
        Instruction::I64RemU => {
            vec![(*indent, format!("{{ kind: 'Remainder', signed: false, type: 'i64' }},"))]
        }

        /* Conversion Instructions */
        Instruction::I32WrapI64 => {
            vec![(*indent, format!("{{ kind: 'Wrap' }},"))]
        }
        Instruction::I32Extend8S => {
            vec![(*indent, format!("{{ kind: 'Extend', signed: true, from: 8 }},"))]
        }
        Instruction::I32Extend16S => {
            vec![(*indent, format!("{{ kind: 'Extend', signed: true, from: 16 }},"))]
        }
        Instruction::I64ExtendI32S => {
            vec![(*indent, format!("{{ kind: 'Extend', signed: true, from: 32 }},"))]
        }
        Instruction::I64ExtendI32U => {
            vec![(*indent, format!("{{ kind: 'Extend', signed: false, from: 32 }},"))]
        }
        Instruction::I64Extend32S => {
            vec![(*indent, format!("{{ kind: 'ExtendSign', from: 32 }},"))]
        }
        Instruction::F32ReinterpretI32 | Instruction::I32ReinterpretF32 | Instruction::F64ReinterpretI64 | Instruction::I64ReinterpretF64 => {
            vec![(*indent, format!("{{ kind: 'Reinterpret' }},"))]
        }
        Instruction::F64PromoteF32 => {
            vec![(*indent, format!("{{ kind: 'Promote' }},"))]
        }
        Instruction::F32ConvertI32S => {
            vec![(*indent, format!("{{ kind: 'Convert', signed: true, from: 'f32', to: 'i32' }},"))]
        }
        Instruction::F32ConvertI32U => {
            vec![(*indent, format!("{{ kind: 'Convert', signed: false, from: 'f32', to: 'i32' }},"))]
        }
        Instruction::F32ConvertI64S => {
            vec![(*indent, format!("{{ kind: 'Convert', signed: true, from: 'f32', to: 'i64' }},"))]
        }
        Instruction::F32ConvertI64U => {
            vec![(*indent, format!("{{ kind: 'Convert', signed: false, from: 'f32', to: 'i64' }},"))]
        }
        Instruction::F64ConvertI32S => {
            vec![(*indent, format!("{{ kind: 'Convert', signed: true, from: 'f64', to: 'i32' }},"))]
        }
        Instruction::F64ConvertI32U => {
            vec![(*indent, format!("{{ kind: 'Convert', signed: false, from: 'f64', to: 'i32' }},"))]
        }
        Instruction::F64ConvertI64S => {
            vec![(*indent, format!("{{ kind: 'Convert', signed: true, from: 'f64', to: 'i64' }},"))]
        }
        Instruction::F64ConvertI64U => {
            vec![(*indent, format!("{{ kind: 'Convert', signed: false, from: 'f64', to: 'i64' }},"))]
        }
        Instruction::I32TruncF32S => {
            vec![(*indent, format!("{{ kind: 'Truncate', signed: true, from: 'i32', to: 'f32' }},"))]
        }
        Instruction::I32TruncF64U => {
            vec![(*indent, format!("{{ kind: 'Truncate', signed: false, from: 'i32', to: 'f64' }},"))]
        }
        Instruction::I32TruncF64S => {
            vec![(*indent, format!("{{ kind: 'Truncate', signed: true, from: 'i32', to: 'f64' }},"))]
        }
        Instruction::F32DemoteF64 => {
            vec![(*indent, format!("{{ kind: 'Demote' }},"))]
        }

        /* Floating Point Specific Instructions */
        // Min
        // Max
        // Nearest
        // Ceil
        // Floor
        // Truncate (float to float)
        Instruction::F32Abs | Instruction::F64Abs => {
            vec![(*indent, format!("{{ kind: 'AbsoluteValue' }},"))]
        }
        Instruction::F32Neg | Instruction::F64Neg => {
            vec![(*indent, format!("{{ kind: 'Negate' }},"))]
        }
        // SquareRoot
        // CopySign

        /* Bitwise Instructions */
        Instruction::I32And => {
            vec![(*indent, format!("{{ kind: 'And', type: 'i32' }},"))]
        }
        Instruction::I64And => {
            vec![(*indent, format!("{{ kind: 'And', type: 'i64' }},"))]
        }
        Instruction::I32Or => {
            vec![(*indent, format!("{{ kind: 'Or', type: 'i32' }},"))]
        }
        Instruction::I64Or => {
            vec![(*indent, format!("{{ kind: 'Or', type: 'i64' }},"))]
        }
        Instruction::I32Xor => {
            vec![(*indent, format!("{{ kind: 'Xor', type: 'i32' }},"))]
        }
        Instruction::I64Xor => {
            vec![(*indent, format!("{{ kind: 'Xor', type: 'i64' }},"))]
        }
        Instruction::I32Shl => {
            vec![(*indent, format!("{{ kind: 'ShiftLeft', type: 'i32' }},"))]
        }
        Instruction::I64Shl => {
            vec![(*indent, format!("{{ kind: 'ShiftLeft', type: 'i64' }},"))]
        }
        Instruction::I32ShrU => {
            vec![(*indent, format!("{{ kind: 'ShiftRight', signed: false, type: 'i32' }},"))]
        }
        Instruction::I64ShrU => {
            vec![(*indent, format!("{{ kind: 'ShiftRight', signed: false, type: 'i64' }},"))]
        }
        Instruction::I32ShrS => {
            vec![(*indent, format!("{{ kind: 'ShiftRight', signed: true, type: 'i32' }},"))]
        }
        Instruction::I64ShrS => {
            vec![(*indent, format!("{{ kind: 'ShiftRight', signed: true, type: 'i64' }},"))]
        }
        Instruction::I32Rotl => {
            vec![(*indent, format!("{{ kind: 'RotateLeft', type: 'i32' }},"))]
        }
        Instruction::I64Rotl => {
            vec![(*indent, format!("{{ kind: 'RotateLeft', type: 'i64' }},"))]
        }
        Instruction::I32Rotr => {
            vec![(*indent, format!("{{ kind: 'RotateRight', type: 'i32' }},"))]
        }
        Instruction::I64Rotr => {
            vec![(*indent, format!("{{ kind: 'RotateRight', type: 'i64' }},"))]
        }
        Instruction::I32Clz => {
            vec![(*indent, format!("{{ kind: 'CountLeadingZeros', type: 'i32' }},"))]
        }
        Instruction::I64Clz => {
            vec![(*indent, format!("{{ kind: 'CountLeadingZeros', type: 'i64' }},"))]
        }
        Instruction::I32Ctz => {
            vec![(*indent, format!("{{ kind: 'CountTrailingZeros', type: 'i32' }},"))]
        }
        Instruction::I64Ctz => {
            vec![(*indent, format!("{{ kind: 'CountTrailingZeros', type: 'i64' }},"))]
        }
        Instruction::I32Popcnt => {
            vec![(*indent, format!("{{ kind: 'PopulationCount', type: 'i32' }},"))]
        }
        Instruction::I64Popcnt => {
            vec![(*indent, format!("{{ kind: 'PopulationCount', type: 'i64' }},"))]
        }

        /**************
         * Variable Instructions
         **************/
        Instruction::LocalGet(index) => {
            let id = format_index(index);
            vec![(*indent, format!("{{ kind: 'LocalGet'; id: {id} }},"))]
        }
        Instruction::LocalSet(index) => {
            let id = format_index(index);
            vec![(*indent, format!("{{ kind: 'LocalSet'; id: {id} }},"))]
        }
        Instruction::LocalTee(index) => {
            let id = format_index(index);
            vec![(*indent, format!("{{ kind: 'LocalTee'; id: {id} }},"))]
        }
        Instruction::GlobalGet(index) => {
            let id = format_index(index);
            vec![(*indent, format!("{{ kind: 'GlobalGet'; id: {id} }},"))]
        }
        Instruction::GlobalSet(index) => {
            let id = format_index(index);
            vec![(*indent, format!("{{ kind: 'GlobalSet'; id: {id} }},"))]
        }

        /**************
         * Memory Instructions
         **************/
        Instruction::MemoryGrow(_) => {
            vec![(*indent, format!("{{ kind: 'MemoryGrow' }},"))]
        }
        Instruction::MemorySize(_) => {
            vec![(*indent, format!("{{ kind: 'MemorySize' }},"))]
        }

        Instruction::I32Load(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I32Load'{offset} }},"))]
        }
        Instruction::I32Load8s(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I32Load8s'{offset} }},"))]
        }
        Instruction::I32Load8u(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I32Load8u'{offset} }},"))]
        }
        Instruction::I32Load16s(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I32Load16s'{offset} }},"))]
        }
        Instruction::I32Load16u(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I32Load16u'{offset} }},"))]
        }

        Instruction::I64Load8s(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I64Load8s'{offset} }},"))]
        }
        Instruction::I64Load8u(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I64Load8u'{offset} }},"))]
        }
        Instruction::I64Load16s(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I64Load16s'{offset} }},"))]
        }
        Instruction::I64Load16u(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I64Load16u'{offset} }},"))]
        }
        Instruction::I64Load32s(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I64Load32s'{offset} }},"))]
        }
        Instruction::I64Load32u(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I64Load32u'{offset} }},"))]
        }

        Instruction::F32Load(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'F32Load'{offset} }},"))]
        }
        Instruction::F64Load(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'F64Load'{offset} }},"))]
        }
        Instruction::I64Load(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Load'; subkind: 'I64Load'{offset} }},"))]
        }

        Instruction::I32Store(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'I32Store'{offset} }},"))]
        }
        Instruction::I64Store(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'I64Store'{offset} }},"))]
        }
        Instruction::F32Store(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'F32Store'{offset} }},"))]
        }
        Instruction::F64Store(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'F64Store'{offset} }},"))]
        }
        Instruction::I32Store8(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'I32Store8'{offset} }},"))]
        }
        Instruction::I32Store16(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'I32Store16'{offset} }},"))]
        }
        Instruction::I64Store8(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'I64Store8'{offset} }},"))]
        }
        Instruction::I64Store16(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'I64Store16'{offset} }},"))]
        }
        Instruction::I64Store32(mem_arg) => {
            let offset = format_offset(mem_arg.offset);
            vec![(*indent, format!("{{ kind: 'Store'; subkind: 'I64Store32'{offset} }},"))]
        }

        /**************
         * Control Flow Instructions
         **************/
        Instruction::Block(block) => {
            let label = block.label.expect("blocks must have labels").name();

            context.push("Block");
            let nest = handle_instructions(func, instrs, &mut (*indent + 2), context);

            vec![
                (*indent, format!("{{ kind: 'Block';")),
                (*indent + 1, format!("id: '${label}';")),
                (*indent + 1, format!("instructions: [")),
            ]
            .into_iter()
            .chain(nest)
            .collect::<Vec<(usize, String)>>()
        }
        Instruction::Br(index) => {
            let id = format_index(index);
            vec![(*indent, format!("{{ kind: 'Branch'; id: {id} }},"))]
        }
        Instruction::BrIf(index) => {
            let id = format_index(index);
            vec![(*indent, format!("{{ kind: 'BranchIf'; id: {id} }},"))]
        }
        Instruction::BrTable(br_table) => {
            let branches = br_table
                .labels
                .iter()
                .enumerate()
                .map(|(index, label)| format!("'{:032b}': {}", index, format_index(label)))
                .collect::<Vec<String>>()
                .join(", ");

            let default_label = format_index(&br_table.default);

            vec![
                (*indent, format!("{{ kind: 'BranchTable';")),
                (*indent + 1, format!("branches: {{ {branches} }};")),
                (*indent + 1, format!("default: {default_label};")),
                (*indent, format!("}}")),
            ]
        }
        Instruction::Call(index) => {
            let id = format_index(index);
            vec![(*indent, format!("{{ kind: 'Call'; id: {id} }},"))]
        }
        Instruction::CallIndirect(call_indirect) => {
            let id = format_index(&call_indirect.table);
            vec![(*indent, format!("{{ kind: 'CallIndirect'; id: {id} }},"))]
        }
        // ReturnCall
        // ReturnCallIndirect
        Instruction::Drop => {
            vec![(*indent, format!("{{ kind: 'Drop' }},"))]
        }
        Instruction::End(_) => {
            let this_context = context.pop();

            let pop = if this_context == Some("If") || this_context == Some("Else") || this_context == Some("Block") || this_context == Some("Loop") {
                (*indent - 1, format!("];"))
            } else {
                panic!("unexpected context {:#?}", this_context);
            };

            let thing = vec![pop, (*indent - 2, format!("}},"))];
            *indent -= 2;
            thing
        }
        Instruction::If(_) => {
            context.push("If");

            let then_instrs = handle_instructions(func, instrs, &mut (*indent + 2), context);

            let thing = vec![(*indent, format!("{{ kind: 'If';")), (*indent + 1, format!("then: ["))]
                .into_iter()
                .chain(then_instrs)
                .collect::<Vec<(usize, String)>>();
            *indent -= 2;
            thing
        }
        Instruction::Else(_) => {
            context.pop(); // remove the "If" context that came before
            context.push("Else");

            let else_instrs = handle_instructions(func, instrs, &mut (indent.clone()), context);

            vec![
                (*indent - 1, format!("];")),      // end the "then" context
                (*indent - 1, format!("else: [")), // start the "else" context
            ]
            .into_iter()
            .chain(else_instrs)
            .collect::<Vec<(usize, String)>>()
        }
        Instruction::Loop(block_type) => {
            context.push("Loop");
            let nest = handle_instructions(func, instrs, &mut (*indent + 2), context);

            let thing = vec![
                (*indent, format!("{{ kind: 'Loop';")),
                (*indent + 1, format!("id: '${}';", block_type.label.expect("loops must have labels").name())),
                (*indent + 1, format!("instructions: [")),
            ]
            .into_iter()
            .chain(nest)
            .collect::<Vec<(usize, String)>>();
            *indent -= 2;
            thing
        }
        Instruction::Nop => {
            vec![(*indent, format!("{{ kind: 'Nop'; ziltoid: 'theOmniscient' }},"))]
        }
        Instruction::Return => {
            let maybe_inline = func.ty.inline.clone();
            let count = if let Some(ft) = maybe_inline { ft.results.len() } else { 0 };
            vec![(*indent, format!("{{ kind: 'Return'; count: {count} }},"))]
        }
        Instruction::Select(_) => {
            vec![(*indent, format!("{{ kind: 'Select' }},"))]
        }
        Instruction::Unreachable => {
            vec![(*indent, format!("{{ kind: 'Unreachable' }},"))]
        }

        _ => {
            panic!("not implemented instruction {:#?}", instruction);
        }
    }
}

pub fn handle_func(func: &Func) -> String {
    match &func.kind {
        wast::core::FuncKind::Import(_) => {
            panic!("didn't implement FuncKind::Import")
        }
        wast::core::FuncKind::Inline { locals, expression } => {
            let locals = locals
                .iter()
                .map(|local| format!("'${}'", local.id.expect("local must have a name").name()))
                .collect::<Vec<String>>()
                .join(", ");

            let indent = &mut 2;

            let instructions = handle_instructions(func, &mut expression.instrs.iter().collect(), indent, &mut vec![])
                .iter()
                .map(|(indent, line)| format!("{}{}\n", "  ".repeat(*indent), line))
                .collect::<Vec<String>>()
                .join("");

            format!("  locals: [{locals}];\n  instructions: [\n{instructions}  ];")
        }
    }
}

fn handle_module_field_func(source: &SourceFile, func: &Func) {
    if let FuncKind::Import(_) = func.kind {
        // imports are not supported
        return;
    }

    source.add_import("wasm-to-typescript-types", "Func");
    source.add_import("wasm-to-typescript-types", "bootstrap");

    let name = "$".to_string()
        + &func
            .id
            .unwrap_or_else(|| panic!("need to implement no name funcs but it looks like I can skirt by without having to do any of it"))
            .name()
            .replace('.', "_");

    if name == "$entry" {
        source.set_args(String::from("[]"));
    }

    let params_and_result: String = if func.ty.inline.clone().is_some() {
        func.ty
            .inline
            .clone()
            .map(|function_type| {
                let params_and_types = function_type.params.iter().map(|(id, _, val_type)| {
                    let id = id.unwrap_or_else(|| panic!("params must have an id: {}", &name)).name();
                    (format!("'${id}'"), format_val_type(val_type))
                });

                let params = &params_and_types.clone().map(|(id, _)| id.clone()).collect::<Vec<String>>().join(", ");
                let params_types = &params_and_types.map(|(_, val_type)| val_type.clone()).collect::<Vec<String>>().join(", ");

                if name == "$entry" {
                    let internals = function_type
                        .params
                        .iter()
                        .map(|(_, _, val_type)| val_type_to_typescript_type(val_type))
                        .collect::<Vec<String>>()
                        .join(", ");
                    source.set_args(format!("[{internals}]"));
                }

                let results = function_type
                    .results
                    .iter()
                    .map(|val_type| format_val_type(val_type))
                    .collect::<Vec<String>>()
                    .join(", ")
                    .to_string();

                format!("  params: [{params}];\n  paramsTypes: [{params_types}];\n  resultTypes: [{results}];")
            })
            .expect("better have an inline type because we already checked")
    } else if func.ty.index.is_some() {
        let id = match func.ty.index {
            Some(Index::Id(id)) => format_id(&id),
            _ => panic!("only id indexes supported for type use"),
        };
        let ModuleType { params, result } = source.get_module_type(&id).expect("looking for a module type that doesn't exist");
        let p = params.join(", ");

        format!("  params: [];\n  paramsTypes: [{p}];\n  resultTypes: {result};")
    } else {
        String::from("  params: [];\n  paramsTypes: [];\n  resultTypes: [];")
    };

    let instructions_and_locals = handle_func(func);

    let output = format!(
        "type {name} = Satisfies<Func, {{
  kind: 'func';
{params_and_result}
{instructions_and_locals}
}}>
"
    );

    source.add_type(name, output);
}

fn handle_module_field_global(source: &SourceFile, global: &Global) {
    let name = global.id.expect("global to have a name").name().to_string();

    let value = match &global.kind {
        GlobalKind::Import(_) => {
            panic!("imported globals are not supported");
        }
        GlobalKind::Inline(inline) => {
            let first = inline.instrs.first().expect("inline global to have at least one instruction");
            match first {
                Instruction::I32Const(value) => format!("'{:032b}'", value),
                _ => {
                    panic!("inline global to have a first instruction of i32.const");
                }
            }
        }
    };

    source.add_global(format!("${name}"), value);
}

fn handle_module_field_memory(source: &SourceFile, memory: &Memory) {
    match memory.kind {
        MemoryKind::Normal(memory_type) => match memory_type {
            MemoryType::B32 { limits, shared: _ } => {
                let size = limits.min;
                let max = limits.max.unwrap_or(size).into();
                source.set_memory(size.into(), max);
            }
            MemoryType::B64 { limits, shared: _ } => {
                let size = limits.min;
                let max = limits.max.unwrap_or(size);
                source.set_memory(size, max);
            }
        },
        MemoryKind::Import { ty, .. } => match ty {
            MemoryType::B32 { limits, shared: _ } => {
                let size = limits.min;
                let max = limits.max.unwrap_or(size).into();
                source.set_memory(size.into(), max);
            }
            MemoryType::B64 { limits, shared: _ } => {
                let size = limits.min;
                let max = limits.max.unwrap_or(size);
                source.set_memory(size, max);
            }
        },
        _ => {
            panic!("only Normal MemoryKind supported");
        }
    };
}

/*
In WebAssembly, the index used to reference entities like functions, globals, or types is relative to the entire module, but it's specific to each kind of entity.

Each category (functions, globals, types, etc.) has its own separate index space.

This means that the first function in a module has index 0 in the function index space, the first global has index 0 in the global index space, and so on.

Additionally, you can call a function by its index even if it has a name, which means we need to keep track if this shit at all times.  Ugg.
*/
pub fn handle_module_fields(source: &SourceFile, fields: &Vec<ModuleField>) {
    let mut module_index: HashMap<&str, usize> = HashMap::new();

    for field in fields {
        match field {
            ModuleField::Func(func) => {
                let count = module_index.entry("Func").or_insert(0);
                *count += 1;
                handle_module_field_func(source, func);
            }

            ModuleField::Global(global) => {
                let count = module_index.entry("Global").or_insert(0);
                *count += 1;
                handle_module_field_global(source, global);
            }
            ModuleField::Memory(memory) => {
                let count = module_index.entry("Memory").or_insert(0);
                *count += 1;
                handle_module_field_memory(source, memory);
            }
            ModuleField::Table(_table) => {
                // handled by ModuleField::Elem
            }
            ModuleField::Elem(element) => {
                // it's assumed there's exactly one table and exactly one element
                source.add_element(element);
            }
            ModuleField::Data(data) => {
                let mut name = "$".to_string() + data.id.expect("data to have a name").name();
                name = name.replace('.', "_");

                let index = match &data.kind {
                    wast::core::DataKind::Active { memory: _, offset } => match offset.instrs.first().unwrap() {
                        Instruction::I32Const(index) => index,
                        _ => panic!("offset should only be i32.const"),
                    },
                    _ => panic!("only Active DataKind supported"),
                };

                let s: Vec<u8> = data
                    .data
                    .iter()
                    .flat_map(|x| match x {
                        DataVal::Integral(_) => panic!("data should only be strings"),
                        DataVal::String(x) => x.to_vec(),
                    })
                    .collect::<_>();

                source.add_data(*index, name, s);
            }
            ModuleField::Import(_) => {
                dbg!(field);
                panic!("you must be unwell.  handling imports is FAR beyond the scope of this project.");
            }
            ModuleField::Export(_) => {
                // handled by ModuleField::Func
                panic!("compile your wasm to use inline exports instead of module exports")
            }
            ModuleField::Tag(_) | ModuleField::Custom(_) | ModuleField::Start(_) | ModuleField::Rec(_) => {
                dbg!(field);
                panic!("intentionally not implemented module field");
            }
            ModuleField::Type(module_type) => {
                source.add_module_type(module_type);
                // intentionally ignored
            }
        }
    }
}

struct MemoryData {
    index: i32,
    name: String,

    /// here's a fun fact to wreck your weekend: the string contained within does not necessarily need to be utf-8
    data: Vec<u8>,
}

#[derive(Clone)]
pub struct ModuleType {
    pub params: Vec<String>,
    pub result: String,
}

/// This represents is a literal TypeScript file that is the final build output of the program
pub struct SourceFile {
    /// WASM module-level globals
    globals: RefCell<IndexMap<String, String>>,

    /// npm imports needed for this type to function (globally deduplicated for the whole file)
    imports: RefCell<IndexMap<String, IndexSet<String>>>,

    /// separate typescript type definitions for this type
    types: RefCell<IndexMap<String, String>>,

    /// the declared size of that memory segment and the maximum memory size
    memory: RefCell<(u64, u64)>,

    /// table ref elements
    indirect: RefCell<HashMap<i32, String>>,

    // MemoryData by id
    data: RefCell<IndexMap<String, MemoryData>>,

    /// Type of the `entry` export's argument tuple, e.g. `[number, number]`.
    ///
    /// Defaults to the empty tuple rather than the empty string: a module with no
    /// function named `entry` never calls `set_args`, and interpolating "" here
    /// emitted `arguments extends ,` - a syntax error that stops tsc parsing the
    /// file, and so stops it checking the whole project. `i64-arith.ts` shipped
    /// like that and `tsc --noEmit` reported only TS1110 for the entire repo.
    args: RefCell<String>,

    // module types.  rarely needed, but unfortunately not never needed
    module_types: RefCell<IndexMap<String, ModuleType>>,

    preview_bytes: bool,
}

impl fmt::Debug for SourceFile {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{{ {:?} {:?} }}", self.imports, self.types)
    }
}

#[allow(clippy::to_string_trait_impl)]
impl ToString for SourceFile {
    fn to_string(&self) -> String {
        let mut data_types = String::from("");

        let mut memory_data = vec![];

        self.data.borrow().iter().for_each(|(_name, MemoryData { data, name, index, .. })| {
            let mut current_index = *index;
            let mut contained_string = "byte preview disabled";
            if self.preview_bytes {
                contained_string = from_utf8(data).unwrap_or("<not valid uft-8.  sorry bro.>");
            }

            let expanded_data = data
                .iter()
                .map(|byte| {
                    let utf8_byte = [*byte];
                    let mut utf8 = String::from("");
                    if self.preview_bytes {
                        let res = from_utf8(&utf8_byte);
                        if let Ok(v) = res {
                            utf8 = format!(" // {v}")
                        }
                    }
                    let result = format!("  '{:032b}': '{:08b}';{}", current_index, byte, utf8);
                    current_index += 1;
                    result
                })
                .filter(|line| !line.contains(": '00000000'"))
                .collect::<Vec<String>>()
                .join("\n");

            data_types.push_str(&format!("\n/** {contained_string} */\ntype {name} = {{\n{expanded_data}\n}}\n"));

            memory_data.push(format!("      & {}", name));
        });

        let memory = if !memory_data.is_empty() {
            format!("\n{}\n    ", memory_data.join("\n"))
        } else {
            " {}".to_string()
        };

        let imports = self
            .imports
            .borrow()
            .iter()
            .map(|(package, imports)| {
                format!(
                    "import type {{ {} }} from '{}'\n",
                    imports.iter().cloned().collect::<Vec<String>>().join(", "),
                    package
                )
                .to_string()
            })
            .collect::<Vec<_>>()
            .join("");

        let types = self
            .types
            .borrow()
            .iter()
            .map(|(_name, contents)| contents.to_string())
            .collect::<Vec<_>>()
            .join("\n");

        let funcs_data = self
            .types
            .borrow()
            .iter()
            .map(|(name, _)| format!("  {name}: {name};"))
            .collect::<Vec<_>>()
            .join("\n");

        let funcs = format!("export type funcs = {{\n{funcs_data}\n}}\n");

        let mut globals = self
            .globals
            .borrow()
            .iter()
            .map(|(name, value)| format!("      {name}: {value};"))
            .collect::<Vec<_>>()
            .join("\n");
        if !globals.is_empty() {
            globals = format!("\n{globals}\n    ");
        }

        let (memory_size, _max_memory) = self.memory.borrow().to_owned();
        dbg!(&memory_size);
        let memory_size_binary = format!("{:032b}", memory_size);

        // return a TypeScript object formatting
        // this is god-awful rust.. but oh well.
        let indirect = self.indirect.borrow();
        let mut indirect: Vec<_> = indirect.iter().collect();
        indirect.sort_by_key(|(key, _)| *key);
        let indirect = indirect
            .into_iter()
            .map(|(key, value)| format!("'{key:032b}' : {value};"))
            .collect::<Vec<_>>()
            .join("\n      ");
        let indirect = if !indirect.is_empty() {
            format!("\n      {indirect}\n    ")
        } else {
            String::new()
        };

        // look for the `$entry` type and use the number of params it has to create a tuple like [number, number] for each
        let arguments = self.args.borrow();

        let entry = format!(
            "export type entry<
  arguments extends {arguments},
  debugMode extends boolean = false,
  stopAt extends number = number,
> = bootstrap<
  {{
    arguments: arguments;
    funcs: funcs;
    globals: {{{globals}}};
    memory:{memory};
    memorySize: '{memory_size_binary}';
    indirect: {{{indirect}}};
  }},
  debugMode,
  stopAt
>"
        );

        format!("{imports}\n{types}\n{funcs}\n{entry}\n{data_types}")
    }
}

impl Default for SourceFile {
    fn default() -> Self {
        Self::new(true)
    }
}

impl SourceFile {
    pub fn new(preview_bytes: bool) -> Self {
        SourceFile {
            args: RefCell::new(String::from("[]")),
            data: RefCell::new(IndexMap::new()),
            globals: RefCell::new(IndexMap::new()),
            imports: RefCell::new(IndexMap::new()),
            indirect: RefCell::new(HashMap::new()),
            memory: RefCell::new((0, 0)),
            types: RefCell::new(IndexMap::new()),
            module_types: RefCell::new(IndexMap::new()),
            preview_bytes,
        }
    }

    pub fn add_import<P: Into<String>, I: Into<String>>(&self, package: P, import: I) {
        let mut imports = self.imports.borrow_mut();
        let entry = imports.entry(package.into()).or_default();
        entry.insert(import.into());
    }

    pub fn add_type(&self, name: String, contents: String) {
        self.types.borrow_mut().insert(name, contents);
    }

    pub fn add_global(&self, name: String, value: String) {
        self.globals.borrow_mut().insert(name, value);
    }

    pub fn set_memory(&self, size: u64, max: u64) {
        self.memory.borrow_mut().0 = size;
        self.memory.borrow_mut().1 = max;
    }

    pub fn add_element(&self, element: &Elem) {
        let start = if let ElemKind::Active { table: _, offset } = &element.kind {
            if let Some(Instruction::I32Const(num)) = offset.instrs.first() {
                num
            } else {
                panic!("element offset should only be i32.const")
            }
        } else {
            panic!("only Active ElemKind supported")
        };

        let strings: HashMap<i32, String> = match element.payload {
            wast::core::ElemPayload::Indices(ref indices) => {
                // map over the indices and convert them to strings as the value of the hashmap, while the key will be a binary 32 starting at `start`
                indices
                    .iter()
                    .enumerate()
                    .map(|(i, index)| {
                        let index = format_index(index);
                        (start + i as i32, index)
                    })
                    .collect()
            }
            _ => panic!("only Indices ElemPayload supported"),
        };

        self.indirect.borrow_mut().extend(strings);
    }

    pub fn add_data(&self, index: i32, name: String, data: Vec<u8>) {
        self.data.borrow_mut().insert(name.clone(), MemoryData { name, data, index });
    }

    pub fn set_args(&self, args: String) {
        self.args.replace(args);
    }

    pub fn add_module_type(&self, module_type: &Type) {
        let (params, result) = match module_type.def {
            wast::core::TypeDef::Func(ref function_type) => {
                let params = function_type.params.iter().map(|(_, _, val)| format_val_type(val)).collect();

                if function_type.results.len() > 1 {
                    panic!("multiple results not supported");
                }
                let result = if let Some(val) = function_type.results.first() {
                    format_val_type(val)
                } else {
                    "[]".to_string()
                };

                (params, result)
            }
            _ => panic!("only Func TypeDef supported"),
        };

        let name = format_id(&module_type.id.expect("module type to have a name"));

        self.module_types.borrow_mut().insert(name, ModuleType { params, result });
    }

    pub fn get_module_type(&self, name: &String) -> Option<ModuleType> {
        self.module_types.borrow().get(name).cloned()
    }
}

#[macro_export]
macro_rules! dbg_dump_file {
    ($expr:expr, $filename:expr) => {{
        let mut file_path = std::env::current_dir().unwrap();
        file_path.push($filename);

        let _ = std::fs::write(&file_path, $expr);
    }};
}

pub fn format_index(index: &Index) -> String {
    match index {
        Index::Id(id) => "'$".to_string() + &id.name().replace('.', "_") + "'",
        _ => panic!("numeric index not supported"),
    }
}

pub fn format_id(id: &Id) -> String {
    "$".to_string() + id.name()
}

pub fn val_type_to_typescript_type(val_type: &ValType) -> String {
    match val_type {
        ValType::I32 => "number".to_string(),
        ValType::I64 => "bigint".to_string(),
        ValType::F32 => "number".to_string(),
        ValType::F64 => "number".to_string(),
        _ => panic!("unsupported type"),
    }
}

pub fn format_val_type(val_type: &ValType) -> String {
    match val_type {
        ValType::I32 => "'i32'".to_string(),
        ValType::I64 => "'i64'".to_string(),
        ValType::F32 => "'f32'".to_string(),
        ValType::F64 => "'f64'".to_string(),
        _ => panic!("unsupported type"),
    }
}

pub fn count_instructions(module: &Module) -> IndexMap<String, u32> {
    let mut counts = IndexMap::new();

    if let ModuleKind::Text(fields) = &module.kind {
        for field in fields {
            if let ModuleField::Func(func) = field {
                if let wast::core::FuncKind::Inline { locals: _, expression } = &func.kind {
                    for instr in expression.instrs.iter() {
                        let variant_name = format!("{:?}", instr);

                        // remove everything including and after the first open parens of the variant name
                        let variant_name = variant_name.split('(').next().unwrap().to_string();

                        *counts.entry(variant_name).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    counts.sort_by(|_k1, v1, _k2, v2| v2.cmp(v1));
    counts
}

/// Parse a `.wat` and write its `.dump` debug artifact. This is the half of
/// `wat_to_dts` that works for every fixture, including the ones the legacy
/// TypeScript generator cannot model.
pub fn wat_to_dump(wat: &str, dump_path: &str) {
    let buf = parser::ParseBuffer::new(wat).unwrap();
    let parsed_wat = &parser::parse::<Wat>(&buf).unwrap();

    if let wast::Wat::Module(ref module) = parsed_wat {
        let counter = count_instructions(module);

        let dump = format!("{:#?}\n\n\n\n\n{:#?}", module, counter);
        dbg_dump_file!(dump, dump_path);
    }
}

pub fn wat_to_dts(wat: String, dump_path: &str, preview_bytes: bool) -> SourceFile {
    wat_to_dump(&wat, dump_path);

    let buf = parser::ParseBuffer::new(&wat).unwrap();
    let parsed_wat = &parser::parse::<Wat>(&buf).unwrap();

    let source = SourceFile::new(preview_bytes);

    if let wast::Wat::Module(ref module) = parsed_wat {
        match &module.kind {
            ModuleKind::Binary(_) => {
                panic!("WebAssembly Binary is not supported.  Only WebAssembly Text.");
            }
            ModuleKind::Text(fields) => {
                handle_module_fields(&source, fields);
            }
        }
    }

    source
}

pub fn skip_list() -> Vec<&'static str> {
    vec![
        // "conway", //
    ]
}

/// Fixtures that are still compiled from `.wat` to `.wasm` (so the checked-in binary
/// can never drift from its source) but that are deliberately not fed to the legacy
/// TypeScript generator in this file. They exist to exercise the Rust-side compilers
/// directly and use features the legacy generator has never modelled -- currently
/// imported functions, which it panics on.
pub fn codegen_skip_list() -> Vec<&'static str> {
    vec![
        "call-indirect-import", // imports a function; only the AOT dispatch tests read this
    ]
}

/// the file is only compiled to wasm, never handed to the legacy TS generator
pub fn should_skip_codegen(dir_entry: &DirEntry) -> bool {
    let path = dir_entry.path().with_extension("");
    let Some(file_name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    codegen_skip_list().iter().any(|&skip| file_name == skip)
}

pub fn focus_list() -> Vec<&'static str> {
    vec![
        // "add-middle", //
                      // "if-else-nested",
                      // "if-else",
    ]
}

/// skip the file if anything in the skip list matches the given file name
pub fn should_skip(file_name: &str) -> bool {
    skip_list().iter().any(|&skip| file_name == skip)
}

/// the file is focused if anything in the focus list matches the given file name
pub fn is_focused(file_name: &str) -> bool {
    focus_list().iter().any(|&focus| file_name == focus)
}

/// this function consults skip_list and focus_list to determine if a test should be run
pub fn should_run(dir_entry: &DirEntry) -> bool {
    let path = dir_entry.path().with_extension("");
    let file_name = path.file_name().and_then(OsStr::to_str).expect("invalid file name");

    // focusing takes precedence over skipping
    if is_focused(file_name) {
        return true;
    }

    if !focus_list().is_empty() {
        return false;
    }

    if should_skip(file_name) {
        return false;
    }

    true
}

pub fn ensure_version(cmd: &str, arg: &str, expected: &str) {
    let output = Command::new(cmd)
        .arg(arg)
        .output()
        .unwrap_or_else(|_| panic!("failed to execute version command for {}", &cmd));
    // log output should be on stderr
    let mut actual = std::str::from_utf8(&output.stderr).unwrap_or_else(|_| panic!("Error decoding stderr"));
    if actual.is_empty() {
        // however some tools write to stdout instead, usually by web developers that don't know better
        actual = std::str::from_utf8(&output.stdout).unwrap_or_else(|_| panic!("Error decoding stdout"));
    }
    let minimum = parse_version(expected).expect("minimum version must be x.y.z");
    let found = parse_version(actual)
        .unwrap_or_else(|| panic!("could not find an x.y.z version in {} output: {}", cmd, actual));

    let error = format!("expected {} to be version {} or newer, got {}", cmd, expected, actual);
    assert!(found >= minimum, "{error}");
}

/// Returns the first `x.y.z` triple in `text`, so that a version can be compared
/// numerically rather than by substring. A substring match rejects every version
/// except the pinned one: "1.0.41".contains("1.0.39") is false.
pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    text.split(|c: char| !c.is_ascii_digit() && c != '.').find_map(|token| {
        let mut parts = token.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some((major, minor, patch))
    })
}

pub fn generate_wasm2wat(dir_entry: &DirEntry) {
    let wasm_input = dir_entry.path().with_extension("wasm");

    let cmd = "wasm2wat";
    ensure_version(cmd, "--version", "1.0.39");

    // convert the .wat file to a .wasm file (also validates the .wat)
    let output = Command::new(cmd)
        .arg(&wasm_input)
        .arg("--enable-code-metadata")
        .arg("--inline-exports")
        .arg("--inline-imports")
        .arg("--disable-reference-types")
        .arg("--generate-names")
        .arg("--fold-exprs")
        .args(["--output", &wasm_input.with_extension("wat").to_string_lossy()]) // output target
        .output()
        .unwrap_or_else(|_| panic!("failed to execute {}", cmd));

    if !output.status.success() {
        // Print the standard error output
        let stderr = std::str::from_utf8(&output.stderr).unwrap_or("Error decoding stderr");
        println!("{cmd} failed for {:?}: {}", wasm_input.file_name(), stderr);
        panic!("{cmd} failed");
    }
}

pub fn get_wat_files() -> Vec<DirEntry> {
    let from_wat = fs::read_dir("./packages/conformance-tests/from-wat/").unwrap().flatten();
    let single_wat = fs::read_dir("./packages/conformance-tests/from-wat-single/").unwrap().flatten();

    let files = from_wat.chain(single_wat);

    files
        .filter_map(|dir_entry| {
            let path = dir_entry.path();

            if !path.is_file() {
                return None;
            }

            if path.extension().and_then(OsStr::to_str) != Some("wat") {
                return None;
            }

            if !should_run(&dir_entry) {
                return None;
            }

            Some(dir_entry)
        })
        .collect()
}

pub fn get_c_files() -> Vec<DirEntry> {
    fs::read_dir("./packages/conformance-tests/from-c/")
        .unwrap()
        .flatten()
        .filter_map(|dir_entry| {
            let path = dir_entry.path();

            if !path.is_file() {
                return None;
            }

            if path.extension().and_then(OsStr::to_str) != Some("c") {
                return None;
            }

            if path.file_name().unwrap().to_str().unwrap().contains(".test.c") {
                return None;
            }

            if !should_run(&dir_entry) {
                return None;
            }

            Some(dir_entry)
        })
        .collect()
}

pub fn generate_wat2wasm(wat_input: &DirEntry) {
    let cmd = "wat2wasm";
    ensure_version(cmd, "--version", "1.0.39");

    // convert the .wat file to a .wasm file (also validates the .wat)
    let output = Command::new(cmd)
        .arg(wat_input.path())
        .args(["--output", &wat_input.path().with_extension("wasm").to_string_lossy()])
        .output()
        .unwrap_or_else(|_| panic!("failed to execute {}", cmd));

    if !output.status.success() {
        // Print the standard error output
        let stderr = std::str::from_utf8(&output.stderr).unwrap_or("Error decoding stderr");
        println!("{cmd} failed for {:?}: {}", wat_input.path().file_name(), stderr);
        panic!("{cmd} failed");
    }
}

pub fn parse_wat_and_dump(dir_entry: &DirEntry) -> SourceFile {
    let wat_file = dir_entry.path().with_extension("wat");

    let wat = fs::read_to_string(wat_file).unwrap();
    let dump_path = dir_entry.path().with_extension("dump").to_str().unwrap().to_owned();

    wat_to_dts(wat, &dump_path, true)
}

pub fn create_ts(source_file: &SourceFile, dir_entry: &DirEntry) {
    let path = dir_entry.path().with_extension("ts");
    fs::write(path, source_file.to_string()).unwrap();
}

/// True when `cmd` can be spawned at all. Used to skip regeneration steps whose
/// output is checked in, so the suite still runs on a machine without the full
/// wasm toolchain installed.
pub fn tool_available(cmd: &str) -> bool {
    Command::new(cmd).arg("--version").output().is_ok()
}

pub fn generate_c2wasm(c_input: &DirEntry) {
    let cmd = "clang-18";
    if !tool_available(cmd) {
        // The .wasm is checked in next to the .c, so an absent compiler only means
        // we cannot notice an edit to the .c file. Fail if there is nothing to fall
        // back to, otherwise carry on with the committed artifact.
        let wasm = c_input.path().with_extension("wasm");
        assert!(
            wasm.exists(),
            "{cmd} is not installed and there is no committed {} to fall back to",
            wasm.display()
        );
        return;
    }
    ensure_version(cmd, "-v", "18.1.8");

    // convert the .wat file to a .wasm file (also validates the .wat)
    let output = Command::new(cmd)
        .arg(c_input.path()) // input
        .args(["-o", &c_input.path().with_extension("wasm").to_string_lossy()]) // output target
        .args(["-target", "wasm32"]) // target wasm32
        .arg("-nostdlib") // no standard library
        .arg("-ffreestanding") // compliation takes place in a freestanding environment
        .arg("-nostdinc") // no standard library
        .arg("-m32")
        .arg("-Os")
        .arg("-Wall")
        .arg("-Wl,--no-entry,--export-all") // no entry point, export all functions
        .arg("-Wl,--error-limit=0") // no error limit
        .arg("-ggdb3") // debug information
        .output()
        .unwrap_or_else(|_| panic!("failed to execute {}", cmd));

    if !output.status.success() {
        // Print the standard error output
        let stderr = std::str::from_utf8(&output.stderr).unwrap_or("Error decoding stderr");
        println!("{cmd} failed for {:?}: {}", c_input.path().file_name(), stderr);
        panic!("{cmd} failed");
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    // CFG AOT mode: cargo run -- --aot-cfg path/to/file.wasm
    if args.len() >= 3 && args[1] == "--aot-cfg" {
        let wasm_path = &args[2];
        let bytes = std::fs::read(wasm_path).expect("could not read the wasm file");
        let mut compiler = aot_cfg::CfgCompiler::new();
        if let Some(index) = args.iter().position(|a| a == "--bits") {
            compiler.bits_override = args.get(index + 1).and_then(|b| b.parse().ok());
        }
        match compiler.compile(&bytes) {
            Ok(output) => {
                // `-o dest` writes somewhere else. A sweep that varies a cap and
                // compares outputs needs this; without it every run of the sweep
                // overwrites the one checked-in path and the comparison is
                // between a file and itself.
                let out_path = match args.iter().position(|a| a == "-o" || a == "--output") {
                    Some(index) => match args.get(index + 1) {
                        Some(dest) => std::path::PathBuf::from(dest),
                        None => {
                            eprintln!("{} needs a path after it", args[index]);
                            std::process::exit(1);
                        }
                    },
                    None => std::path::Path::new(wasm_path).with_extension("cfg.ts"),
                };
                let output = if args.iter().any(|a| a == "--word4") { word4::transform(&output) } else { output };
                std::fs::write(&out_path, output).expect("could not write the output");
                println!("wrote {}", out_path.display());
            }
            Err(error) => {
                eprintln!("aot-cfg failed: {error}");
                std::process::exit(1);
            }
        }
        return;
    }

    // Clean AOT mode: cargo run -- --aot-clean path/to/file.wasm
    if args.len() >= 3 && args[1] == "--aot-clean" {
        let wasm_path = &args[2];
        let wasm_bytes = fs::read(wasm_path).expect(&format!("Failed to read {}", wasm_path));

        let mut compiler = aot_clean::CleanAotCompiler::new();
        match compiler.compile(&wasm_bytes) {
            Ok(output) => {
                let output_path = wasm_path.replace(".wasm", ".aot.ts");
                fs::write(&output_path, &output).expect("Failed to write output");
                eprintln!("Generated clean AOT output: {}", output_path);
            }
            Err(e) => {
                eprintln!("Clean AOT compilation failed: {}", e);
                std::process::exit(1);
            }
        }
        return;
    }

    // Stateful AOT mode: cargo run -- --aot-stateful path/to/file.wasm
    if args.len() >= 3 && args[1] == "--aot-stateful" {
        let wasm_path = &args[2];
        let wasm_bytes = fs::read(wasm_path).expect(&format!("Failed to read {}", wasm_path));

        let mut compiler = aot_stateful::StatefulAotCompiler::new();
        match compiler.compile(&wasm_bytes) {
            Ok(output) => {
                let output_path = wasm_path.replace(".wasm", ".aot.ts");
                fs::write(&output_path, &output).expect("Failed to write output");
                eprintln!("Generated stateful AOT output: {}", output_path);
            }
            Err(e) => {
                eprintln!("Stateful AOT compilation failed: {}", e);
                std::process::exit(1);
            }
        }
        return;
    }

    // AOT mode (legacy): cargo run -- --aot path/to/file.wasm
    if args.len() >= 3 && args[1] == "--aot" {
        let wasm_path = &args[2];
        let wasm_bytes = fs::read(wasm_path).expect(&format!("Failed to read {}", wasm_path));

        let mut compiler = aot::AotCompiler::new();
        match compiler.compile(&wasm_bytes) {
            Ok(output) => {
                // Write to .aot.ts file
                let output_path = wasm_path.replace(".wasm", ".aot.ts");
                fs::write(&output_path, &output).expect("Failed to write output");
                eprintln!("Generated AOT output: {}", output_path);
            }
            Err(e) => {
                eprintln!("AOT compilation failed: {}", e);
                std::process::exit(1);
            }
        }
        return;
    }

    if "this whole thing was such a dumb idea yet somehow a stroke of genius at the same time".len() == 85 {
        // LOL we have to raise the stack size in Rust to compile this shit.
        let stack_size = 16 * 1024 * 1024; // 16 MB stack
        let builder = thread::Builder::new().stack_size(stack_size);

        let handle = builder
            .spawn(|| {
                let file = "pong";
                let current_dir = std::env::current_dir().unwrap();
                let dir = format!("packages/playground/{file}/");
                // let d = read_dir(dir).unwrap().flatten().next().unwrap();
                // generate_wat_from_wasm(&d);
                let wat_file = Path::new(&dir).join(format!("{file}.wat"));
                let wat_path = current_dir.join(wat_file);
                let wat = fs::read_to_string(wat_path).unwrap();

                let output = wat_to_dts(wat, PathBuf::from(&dir).join(format!("{file}.dump")).to_str().unwrap(), false).to_string();
                fs::write(PathBuf::from(dir).join(format!("{file}.ts")), output).unwrap();
                println!("I did the needful, boss.");
            })
            .expect("Thread creation failed");
        handle.join().expect("Thread join failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Here's how this works.
    ///
    /// We can take two inputs:
    /// - one is a .wat file from the `test/from-wat` directory
    /// - the other is a .c file from the `test/from-c` directory.
    ///
    /// If it starts as a C file, we generate a .wat from that.
    ///
    /// In both cases we generate `.wasm` files.
    ///
    /// The `.dump` file is a debug representation of the `.wat` file's parsed contents.
    ///
    /// We then generate a `.ts` file from our program.
    ///
    /// #### from-wat
    /// 1. read .wat
    /// 2. generate and write .wasm from .wat with `wat2wasm`
    ///
    /// #### from-c
    /// 1. read .c files
    /// 2. generate and write .wasm from the .c files with `emcc` (which uses `clang`)
    /// 3. generate and write .wat with `wasm2wat`
    ///
    /// #### point of convergence
    /// 1. parse .wat and write .dump
    /// 2. generate and write .ts file
    ///
    /// #### runtime tests
    /// runtime tests are done from JavaScript, so they need to be run with `pnpm test` in a separate step
    #[test]
    fn run_conformance_tests() {
        let from_wat = get_wat_files();
        from_wat.iter().for_each(generate_wat2wasm);

        let from_c = get_c_files();
        from_c.iter().for_each(generate_c2wasm);
        from_c.iter().for_each(generate_wasm2wat);

        let all_files: Vec<_> = from_wat.iter().chain(from_c.iter()).collect();

        for dir_entry in all_files {
            if should_skip_codegen(dir_entry) {
                // Still refresh the .dump so the debug artifact cannot drift from
                // the .wat; only the legacy TypeScript emission is skipped.
                let wat = fs::read_to_string(dir_entry.path().with_extension("wat")).unwrap();
                let dump_path = dir_entry.path().with_extension("dump");
                wat_to_dump(&wat, dump_path.to_str().unwrap());
                continue;
            }
            let source_file = parse_wat_and_dump(dir_entry);
            create_ts(&source_file, dir_entry);
        }
    }

    /// Every generated `.ts` has to be syntactically valid TypeScript.
    ///
    /// A parse error in one generated file is not a local problem: `tsc` stops at
    /// the first one, so the project's build gate (`pnpm test` ends in `tsc`)
    /// reports that single error and checks nothing else. `i64-arith.ts` shipped
    /// with `arguments extends ,` - the entry-args string is only set for a
    /// function named `entry`, and this module has none - and for as long as it
    /// was there `tsc --noEmit` finished in 3 seconds having type-checked none of
    /// the repo. It hid 156 failing type assertions in ts-type-math.
    ///
    /// This checks the shape rather than running tsc, so it stays a fast unit
    /// test: an unsatisfied `extends` is exactly what an empty interpolation
    /// leaves behind, and it is the failure mode that actually happened.
    #[test]
    fn generated_typescript_has_no_empty_constraints() {
        let dirs = [
            "./packages/conformance-tests/from-wat/",
            "./packages/conformance-tests/from-wat-single/",
            "./packages/conformance-tests/from-c/",
        ];
        let mut bad = Vec::new();
        for dir in dirs {
            let Ok(entries) = fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(OsStr::to_str) != Some("ts") {
                    continue;
                }
                // .cfg.ts comes from the CFG backend, which is covered elsewhere
                if path.to_string_lossy().ends_with(".cfg.ts") {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else { continue };
                for (number, line) in text.lines().enumerate() {
                    let trimmed = line.trim_end();
                    if trimmed.ends_with("extends ,")
                        || trimmed.ends_with("extends ")
                        || trimmed.ends_with("extends >")
                    {
                        bad.push(format!("{}:{}: {}", path.display(), number + 1, trimmed.trim()));
                    }
                }
            }
        }
        assert!(
            bad.is_empty(),
            "generated TypeScript has an empty `extends` constraint, which stops \
             tsc parsing the file and so stops it checking the whole project:\n  {}",
            bad.join("\n  ")
        );
    }
}
