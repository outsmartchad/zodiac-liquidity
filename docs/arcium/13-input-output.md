# Arcis Input/Output Patterns

## Core Concepts

Arcium handles inputs and outputs through encrypted `Enc<Owner, T>` generic types. The network itself doesn't mutate state—both inputs and outputs can be encrypted or plaintext.

## Data Visibility Levels

| Level | Type | Visibility |
|-------|------|------------|
| Plaintext | `u64`, `bool`, etc. | All ARX nodes see values - unsuitable for sensitive data |
| Shared | `Enc<Shared, T>` | Client AND MXE can decrypt - for user-sensitive info |
| MXE-only | `Enc<Mxe, T>` | Only MXE can decrypt - for protocol state |

## Return Value Requirements

### Encrypted outputs
Call `.from_arcis()` to produce `Enc<Owner, T>`:
```rust
let result = owner.from_arcis(computed_value);
// Ciphertext becomes public bytes, plaintext stays protected
```

### Revealed outputs
Call `.reveal()` to convert to plaintext:
```rust
let public_result = secret_value.reveal();
// Value visible to all participants
```

**Important**: Secret-shared intermediate values cannot be returned directly—they exist exclusively within MPC computation.

## Data Conversion Pattern

```rust
#[instruction]
pub fn process(input: Enc<Shared, u64>) -> Enc<Shared, u64> {
    // Convert encrypted to secret shares
    let value = input.to_arcis();

    // Compute on secret shares (nodes see nothing)
    let result = value * 2 + 10;

    // Convert back to encrypted
    input.owner.from_arcis(result)
}
```

## Sealing (Re-encryption)

Transfer encrypted data from one key to another:

```rust
pub fn share_data(
    receiver: Shared,                    // Recipient's public key
    input_ctxt: Enc<Shared, Data>,       // Your encrypted data
) -> Enc<Shared, Data> {
    let input = input_ctxt.to_arcis();   // Decrypt inside MPC
    receiver.from_arcis(input)           // Re-encrypt for recipient
}
```

**Use case**: Compliance, selective disclosure, data sharing without exposing to platform.

## Data Packing Optimization

For large arrays of small integers, `Pack<T>` provides ~26x compression:

```rust
// Instead of 256 encrypted u8 values (8192 bytes)
// Use packed representation (320 bytes)
let packed = Pack::new(large_array);
```

## Reading Encrypted Account Data

Specify exact byte offsets when passing encrypted account data to MPC:

```rust
Argument::Account(
    ctx.accounts.state_acc.key(),
    8 + 1,  // Skip: discriminator (8) + bump (1)
    64,     // Read: 2 ciphertexts × 32 bytes
)
```

**Memory layout example**:
```
Byte 0-7:   Anchor discriminator
Byte 8:     bump
Byte 9-40:  first ciphertext (Enc<Mxe, u64>)
Byte 41-72: second ciphertext (Enc<Mxe, u64>)
```
