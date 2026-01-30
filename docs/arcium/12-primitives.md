# Arcis Primitives

## Random Number Generation

Arcis provides `ArcisRNG` for cryptographically secure randomness within MPC circuits:

| Function | Description |
|----------|-------------|
| `bool()` | Random boolean (50/50) |
| `gen_integer_from_width(width)` | Random integer up to specified bit width |
| `gen_public_integer_from_width(width)` | Public randomness visible to ARX nodes |
| `gen_integer_in_range(min, max, n_attempts)` | Range-based with rejection sampling |
| `gen_uniform<T>()` | Uniformly random values of explicit types |
| `shuffle(&mut array)` | In-place cryptographic shuffling O(n·log³(n)) |

**Constraint**: Type parameters must be explicit at compile time; floats cannot be uniformly generated.

## Cryptographic Operations

### Hashing (SHA3)

Arcis uses SHA3 (Keccak) rather than SHA-2 because SHA3 has a more efficient circuit structure for MPC evaluation.

```rust
let hash = SHA3_256::new().digest(&data);
let hash512 = SHA3_512::new().digest(&data);
```

### Ed25519 Signatures

```rust
// Generate keypair (stays secret-shared)
let sk = SecretKey::new_rand();
let vk = VerifyingKey::from_secret_key(&sk);

// Verify signature
let is_valid = vk.verify(&message, &signature);
```

**Full-threshold security**: All ARX nodes must collude to compromise secrets.

### Cluster Signing (MXE Key)

```rust
// Sign with collective MXE cluster key
let signature = MXESigningKey::sign(&message);
signature.reveal()
```

### Public Key Operations (X25519)

```rust
// Parse from base58
let pk = ArcisX25519Pubkey::from_base58(base58_str);

// Create from bytes
let pk = ArcisX25519Pubkey::from_uint8(bytes);

// Extract/rebuild Montgomery X-coordinate
let x = pk.to_x();
let pk2 = ArcisX25519Pubkey::new_from_x(x);
```

## Data Packing

`Pack<T>` compresses multiple small values into fewer field elements:

```rust
// Compression ratio: [u8; 256] compresses ~26x (256 → 10 field elements)
let packed = Pack::new(data);
let unpacked: [u8; 256] = packed.unpack();
```

**Best for**: Large arrays of small integers approaching transaction size limits.

## Machine Learning

Basic privacy-preserving inference primitives:

### Logistic Regression
```rust
let model = LogisticRegression::new(coef, intercept);
let prediction = model.predict(x, threshold);
let probability = model.predict_proba(x);
```

### Linear Regression
```rust
let model = LinearRegression::new(coef, intercept);
let prediction = model.predict(x);
```

### Math Functions
```rust
let s = ArcisMath::sigmoid(x);
let l = ArcisMath::logit(x);
let e = ArcisMath::expit(x);
```

**Limitation**: Maximum 100 features per model.

All operations maintain secret-shared data internally; only explicitly revealed values become public.
