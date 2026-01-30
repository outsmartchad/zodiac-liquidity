# Arcis Mental Model

## Core Concept: Secret Sharing Foundation

Arcis enables encrypted computation through secret sharing—data splits across multiple nodes where "each node sees only random-looking data." The security model requires all ARX nodes to collude simultaneously to reconstruct secrets; if even one node refuses participation, confidentiality remains intact.

## Circuit Compilation Architecture

The framework operates on a fixed-structure principle: "your Arcis code compiles into a fixed circuit structure before any data flows through it." This compile-time lock prevents information leakage through runtime execution patterns.

**Flow:**
```
Rust Code → Fixed Circuit Structure → Secret Shares Runtime Flow
```

## Conditional Execution Model

When conditions aren't compile-time constants, "both branches execute" regardless of the actual condition value. This prevents observers from inferring secrets through branching behavior.

**Cost implication:** Total expense equals sum of both branches, not the maximum. Compile-time constants (literals, `const` declarations) do permit single-branch execution.

## Loop Constraints

"Loops must have iteration counts known at compile time." Variable-length iterations leak information through execution duration.

**Unsupported constructs:** `while`, `break`, `continue` - they create data-dependent control flow.

## Data Structure Requirements

"Variable-length types like `Vec`, `String`, and `HashMap` are not supported." The circuit compiler requires predetermined memory allocation and operation counts.

**Fixed-size alternatives:**
- `[T; N]` arrays instead of `Vec<T>`
- Byte arrays for text instead of `String`

## Reveal/Encryption Placement Rules

"The `.reveal()` and `.from_arcis()` methods cannot be called inside `if/else` blocks when the condition is not a compile-time constant."

These operations trigger global side effects that cannot be conditionally undone during branch merging. Selection must precede revelation.

## Dynamic Indexing Complexity

Array access with secret-derived indices becomes "O(n)" rather than O(1), as the circuit must evaluate all positions without revealing which matched. Compile-time indices maintain O(1) performance.

## Operation Cost Hierarchy

| Cost Level | Operations |
|------------|------------|
| Nearly-free | Addition, subtraction, constant multiplication |
| Moderate | General multiplication |
| Expensive | Comparisons (bit-level operations) |
| Very expensive | General division/modulo |

**Sorting complexity:** O(n·log²(n)·bit_size)

## Supported Rust Adaptations

Standard patterns requiring modification:
- Replace `Vec<T>` with `[T; N]`
- Replace `while` loops with bounded `for` iterations
- Avoid `match` expressions
- Avoid early returns
- Avoid `break`/`continue` statements
