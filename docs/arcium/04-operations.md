# Arcis MPC Operations

## Quick Reference

**Supported:** `if/else`, `for` loops, arithmetic, comparisons, iterators (excluding `.filter()`)

**Unsupported:** `while`, `loop`, `break`, `match`, `return`, `.filter()`

## Expression Categories

### Binary Operations
- Arithmetic: `+`, `-`, `*`, `/`, `%`
- Logical: `&&`, `||`, `^`, `&`, `|`
- Comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`
- Right-shift: requires compile-time known operands
- Left-shift: not supported

### Control Flow

**`if/else`**: Both branches execute; complexity equals sum of both block costs

**`for` loops**: Supported with compile-time known iteration counts

**Unsupported**: `while`, `loop`, `break`, `match`, early returns, `if let`

### Data Structures
- Array literals, tuple literals, struct literals
- Block expressions
- Field access, indexing (O(n) when index unknown)
- Dereferencing

### Casting
- Integer-to-integer
- Bool-to-integer
- Integer-to-bool
- Reference-to-reference

## Function Calls

**User-defined functions** work without recursion.

**Built-in functions:**
- `ArcisRNG::bool()` — random boolean
- `ArcisRNG::gen_uniform::<T>()` — uniform random value
- `ArcisRNG::gen_integer_from_width(width)` — random integer in [0, 2^width)
- `ArcisRNG::shuffle(slice)` — shuffle with O(n·log³(n)) complexity
- `ArcisMath::sigmoid(x)` — activation function
- `LinearRegression::new()`, `LogisticRegression::new()` — ML models

## Method Calls

### Slice/Array Methods
- `.len()`, `.is_empty()`
- `.reverse()`
- `.sort()` — O(n·log²(n)·bit_size)
- `.contains()`
- `.starts_with()`, `.ends_with()`

### Iterator Methods
- `.map()`, `.fold()`, `.sum()`, `.product()`
- `.enumerate()`, `.zip()`, `.chain()`
- `.rev()`, `.cloned()`, `.copied()`
- `.take(n)`, `.skip(n)`, `.step_by(n)` — n must be compile-time known

**Notable exclusion:** `.filter()` unsupported—produces variable output length

## Items

**Supported:** constants, structs, implementations, modules, type aliases, custom traits (with associated types/constants)

**Unsupported:** enums, static variables, macros, unsafe blocks, recursive functions

## Patterns

Function arguments and `let` bindings support:
- Identifiers, references, mutable variants
- Arrays, struct destructuring, tuples

The `..` pattern is not supported.

## Generics

Full generic support with compile-time resolution. No runtime polymorphism (`dyn Trait`). Generic functions, structs, and trait bounds work normally.
