# Arcium Encryption

## Encryption Framework

Arcium uses a generic `Enc<Owner, T>` type for encrypted data:

| Owner | Description |
|-------|-------------|
| `Shared` | Data encrypted via shared secret between client and MXE |
| `Mxe` | Collective decryption by nodes under dishonest majority |

## Cryptographic Components

### Key Exchange
x25519 elliptic curve Diffie-Hellman key exchange between the client and the cluster to derive a shared secret.

### Symmetric Cipher
Rescue — an arithmetization-oriented symmetric encryption scheme.

Key derivation applies Rescue-Prime hash function to the shared secret per NIST SP 800-56C guidelines.

### Field Implementation
Rescue operates over F_{2^255-19} to align with x25519's native field.

## Operational Parameters

- **Security level:** 128 bits (cipher), 256 bits (hash function)
- **Mode:** Counter (CTR) mode with m=5 state dimension
- **Counter format:** `[nonce, i, 0, 0, 0]` using 16 random user-provided bytes
- **Rescue-Prime hash:** rate=7, capacity=5 (m=12) with output truncated to 5 field elements

## Core Operations

### Decryption (inside MPC)
```rust
let secret_shared = input_enc.to_arcis();
// Converts ciphertext to secret-shares without exposing plaintext to nodes
```

### Encryption (inside MPC)
```rust
let encrypted = owner.from_arcis(output);
// Encrypts secret-shared outputs via MPC
```

### Nonce Management
After decrypting user-provided inputs, the MXE increments the nonce by 1 for output encryption.

**Important:** Fresh nonces required for subsequent interactions.

## TypeScript Client Encryption

```typescript
import { x25519, RescueCipher, getMXEPublicKey } from "@arcium-hq/client";

// 1. Generate client keypair
const privateKey = x25519.utils.randomSecretKey();
const publicKey = x25519.getPublicKey(privateKey);

// 2. Get MXE public key
const mxePublicKey = await getMXEPublicKey(provider, programId);

// 3. Derive shared secret
const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);

// 4. Create cipher
const cipher = new RescueCipher(sharedSecret);

// 5. Encrypt values
const nonce = randomBytes(16);
const plaintext = [BigInt(value1), BigInt(value2)];
const ciphertext = cipher.encrypt(plaintext, nonce);

// 6. Decrypt results
const decrypted = cipher.decrypt([encryptedResult], resultNonce);
```

## Re-encryption Pattern

Transfer encrypted data from one key to another without intermediate plaintext exposure:

```rust
pub fn share_data(
    receiver: Shared,                    // Recipient's public key
    input_ctxt: Enc<Shared, Data>,       // Your encrypted data
) -> Enc<Shared, Data> {
    let input = input_ctxt.to_arcis();   // Decrypt inside MPC
    receiver.from_arcis(input)           // Re-encrypt for recipient
}
```

Data is "handed over" inside MPC — re-encrypted from one key to another.
