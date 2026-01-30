# Arcis Types Documentation

## Supported Types

### Integer Types
`u8`, `u16`, `u32`, `u64`, `u128`, `usize`, `i8`, `i16`, `i32`, `i64`, `i128`, `isize`

### Floating Point
`f64` and `f32` implemented as "fixed-point with 52 fractional bits" with range `[-2^75, 2^75)`. Values outside this range either trigger compile-time errors or are silently clamped.

### Composite Types
- Tuples (including empty tuples)
- Fixed-length arrays
- Compile-time known slices
- Mutable references
- User-defined structs
- Functions (not as encrypted I/O)

### Special Types
- `ArcisX25519Pubkey` — public key wrapper
- `BaseField` — native Curve25519 field element
- `Pack<T>` — bit-packing wrapper for storage efficiency

## Encryption Types

| Type | Purpose |
|------|---------|
| `Enc<Shared, T>` | Client and MXE can decrypt |
| `Enc<Mxe, T>` | MXE-only decryption |
| `EncData<T>` | Raw ciphertext without metadata |

The `Owner` parameter determines decryption permissions:
- `Shared` enables user verification of inputs/outputs
- `Mxe` protects internal protocol state

## Advanced: EncData<T>

This type eliminates redundant key-derivation circuits when "multiple inputs share the same public key."

Use `.to_arcis_with_pubkey_and_nonce()` to decrypt, but ensure "nonce uniqueness" since reuse compromises security.

## Unsupported Types

Variable-length containers (`HashMap`, `Vec`, `String`) are not supported due to requiring dynamic length handling.

## Type Conversion Examples

```rust
// Integer to encrypted
let value: u64 = 100;
let encrypted: Enc<Shared, u64> = owner.from_arcis(value);

// Encrypted to secret-shared (inside MPC)
let secret_shared = encrypted.to_arcis();

// Secret-shared back to encrypted
let re_encrypted = owner.from_arcis(secret_shared);
```
