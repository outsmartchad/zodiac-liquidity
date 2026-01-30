# Arcis Best Practices

## Performance Optimization

### Operation Cost Hierarchy

| Expense Level | Operations |
|---------------|------------|
| **Cheap** | Addition, subtraction, multiplication (with preprocessing) |
| **Expensive** | Comparisons (require bit decomposition), division/modulo |
| **Linear O(n)** | Dynamic indexing (checks all positions) |

### Key Optimization Strategies

**1. Batch encryption operations**

Rather than encrypting multiple values separately, combine them into tuple types:

```rust
// Instead of separate Enc<T> for each field
// Use a struct to encrypt together
pub struct BatchedInput {
    value1: u64,
    value2: u64,
    value3: u64,
}
```

Note: `Enc<T>` wraps the entire value, so destructuring patterns don't work on Enc types.

**2. Cache comparison results**

Computing expensive comparisons multiple times wastes resources:

```rust
// Bad: comparing twice
if a > b { ... }
if a > b { ... }  // Redundant computation

// Good: cache the result
let a_greater = a > b;
if a_greater { ... }
if a_greater { ... }
```

**3. Leverage public inputs**

Values known before execution should be passed as public inputs rather than computed during secure operations.

## Debugging Capabilities

Arcis supports familiar debugging macros during development:

```rust
println!("Debug value: {:?}", value);
print!("Inline: ");
eprint!("Error: ");
eprintln!("Error line");

debug_assert!(condition);
debug_assert_eq!(a, b);
debug_assert_ne!(a, b);
```

**Critical limitation:** Print macros do not change circuit behavior. They are for development only. Debug assertions don't enforce production constraints.

## Testing Architecture

### Testable Components
- Helper functions (non-decorated)
- Builtin circuits (`#[arcis_circuit]`)
- Pure logic extracted into separate units

### Non-Testable Components
`#[instruction]` functions require the full MPC runtime and cannot be unit tested in isolation.

**Solution:** Use the TypeScript SDK on test clusters for integration testing.

## Common Pitfalls

### 1. Conditional execution misconception

Both if/else branches execute in MPC circuits; the condition selects the output, not whether code runs.

```rust
// Both branches ALWAYS execute
if secret_condition {
    expensive_operation_a()  // Always runs
} else {
    expensive_operation_b()  // Always runs
}
// Cost = operation_a + operation_b
```

### 2. Reveal/encryption placement

`.reveal()` and `.from_arcis()` cannot appear inside conditional blocks:

```rust
// WRONG
if condition {
    value.reveal()  // Error!
}

// CORRECT
let result = if condition { value_a } else { value_b };
result.reveal()
```

### 3. Division safety

When divisors depend on secret inputs, explicitly validate against zero:

```rust
// Validate before division
let safe_divisor = if divisor == 0 { 1 } else { divisor };
let result = numerator / safe_divisor;
```

### 4. Dynamic indexing always checks all positions

```rust
// This is O(n), not O(1)
let value = array[secret_index];
```
