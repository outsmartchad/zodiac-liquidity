# Arcis Quick Reference Cheatsheet

## Limitations

**Control Flow:** `if`, `if/else`, `else if`, `for` loops supported. Not supported: `while`, `loop`, `break`, `continue`, `match`, `if let`, early `return`.

**Types:** Integers, floats, arrays, tuples, structs work. Unavailable: `Vec`, `String`, `HashMap`, enums.

**Functions:** Helpers, closures, generics, traits allowed. Recursion and async/await are not.

**Operations:** Arithmetic, comparisons, constant right shift work. Left shift and variable right shift don't.

---

## Basic Module Structure

```rust
use arcis::*;

#[encrypted]
mod my_circuit {
    use arcis::*;

    #[instruction]
    pub fn add(a: u8, b: u8) -> u16 {
        a as u16 + b as u16
    }
}
```

---

## Encrypted Data Handling

```rust
let value = input.to_arcis();           // Encrypted to shares
let result = value * 2 + 10;            // Compute on shares
input.owner.from_arcis(result)          // Shares to encrypted
```

**Ownership:** `Enc<Shared, T>` (client AND MXE decrypt) vs `Enc<Mxe, T>` (MXE only).

---

## Type Declarations

```rust
let x: u8 = 255;
let y: i64 = -1000;
let z: u128 = 10000;
let pi: f64 = 3.14159;
let arr: [u8; 10] = [0; 10];
let pair: (u8, u16) = (1, 2);

#[derive(Copy, Clone)]
struct Point { x: u16, y: u16 }
```

---

## Control Flow Patterns

```rust
let result = if condition { a } else { b };

if should_update {
    counter += 1;
}

let category = if value < 10 {
    0
} else if value < 100 {
    1
} else {
    2
};

for i in 0..10 {
    process(arr[i]);
}
```

---

## Functions & Closures

```rust
fn helper(a: u8, b: u8) -> u16 {
    a as u16 + b as u16
}

let double = |x: u8| x * 2;

fn set_zero<T: ArcisType + Copy>(a: &mut T) {
    *a = make_zero(*a);
}
```

---

## Array Operations

```rust
let arr: [u8; 10] = [0; 10];
let x = arr[5];              // Constant index: O(1)
let y = arr[secret_idx];     // Secret index: O(n)

arr.swap(0, 1);
arr.reverse();
arr.fill(42);
arr.sort();                  // O(n·log²(n)·bit_size)
```

---

## Iterators

```rust
for val in arr.iter() {
    sum += *val;
}

arr.iter().map(|x| *x * 2).sum()
```

(`.filter()` unsupported)

---

## Encryption Patterns

```rust
fn process(input: Enc<Shared, u64>) -> Enc<Shared, u64>
fn process_state(state: Enc<Mxe, GameState>) -> Enc<Mxe, GameState>

let plain = secret.reveal();
let mxe_data = Mxe::get().from_arcis(value);
```

---

## Randomness

```rust
let coin = ArcisRNG::bool();
let num = ArcisRNG::gen_integer_from_width(64);
let uniform = ArcisRNG::gen_uniform::<[u8; 32]>();
ArcisRNG::shuffle(&mut arr);
let (val, ok) = ArcisRNG::gen_integer_in_range(1, 100, 24);
```

---

## Cryptography

```rust
let hash = SHA3_256::new().digest(&data).reveal();
let valid = vk.verify(&message, &signature).reveal();
let sk = SecretKey::new_rand();
let vk = VerifyingKey::from_secret_key(&sk);
let sig = MXESigningKey::sign(&message).reveal();
```

---

## Data Packing

```rust
let packed = Pack::new(data);
let data: [u8; 64] = packed.unpack();
```

---

## Testing & Debugging

```rust
println!("value = {}", x);
debug_assert!(x > 0, "x must be positive");

#[cfg(test)]
mod tests {
    #[test]
    fn test_helper() {
        assert_eq!(helper(1, 2), 3);
    }
}
```
