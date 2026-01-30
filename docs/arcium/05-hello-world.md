# Arcium Hello World Tutorial

## Project Initialization

Create a new MXE project:

```bash
arcium init <project-name>
```

This generates a project structure based on Anchor with:
- `Arcium.toml` configuration file
- `encrypted-ixs` directory for MPC code (Arcis framework)

## Writing Your First Encrypted Instruction

### encrypted-ixs/src/lib.rs

```rust
use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    pub struct InputValues {
        v1: u8,
        v2: u8,
    }

    #[instruction]
    pub fn add_together(input_ctxt: Enc<Shared, InputValues>) -> Enc<Shared, u16> {
        let input = input_ctxt.to_arcis();
        let sum = input.v1 as u16 + input.v2 as u16;
        input_ctxt.owner.from_arcis(sum)
    }
}
```

**Key Components:**
- `#[encrypted]` marks modules containing encrypted instructions
- `#[instruction]` designates functions compiled into callable circuits
- `Enc<Shared, InputValues>` represents encrypted data decryptable by both client and MXE
- `to_arcis()` converts encrypted input for MPC processing
- `from_arcis()` re-encrypts results for onchain storage

## Solana Program Integration

### Three-Instruction Pattern

1. **init_add_together_comp_def** — One-time setup of the computation definition
2. **add_together** — Invokes the confidential instruction with encrypted arguments
3. **add_together_callback** — Called by the MPC cluster upon completion

### programs/your_project/src/lib.rs

```rust
use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

const COMP_DEF_OFFSET_ADD_TOGETHER: u32 = comp_def_offset("add_together");

#[arcium_program]
pub mod hello_world {
    use super::*;

    pub fn init_add_together_comp_def(ctx: Context<InitAddTogetherCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn add_together(
        ctx: Context<AddTogether>,
        computation_offset: u64,
        ciphertext_0: [u8; 32],
        ciphertext_1: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        let args = ArgBuilder::new()
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u8(ciphertext_0)
            .encrypted_u8(ciphertext_1)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![AddTogetherCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[]
            )?],
            1,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "add_together")]
    pub fn add_together_callback(
        ctx: Context<AddTogetherCallback>,
        output: SignedComputationOutputs<AddTogetherOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account
        ) {
            Ok(AddTogetherOutput { field_0 }) => field_0,
            Err(e) => {
                msg!("Error: {}", e);
                return Err(ErrorCode::AbortedComputation.into())
            },
        };

        emit!(SumEvent {
            sum: o.ciphertexts[0],
            nonce: o.nonce.to_le_bytes(),
        });
        Ok(())
    }
}
```

## Building and Testing

```bash
# Build
arcium build

# Test locally
arcium test

# Test on devnet
arcium test --cluster devnet
```

## TypeScript Test Example

```typescript
import { x25519, RescueCipher, getMXEPublicKey } from "@arcium-hq/client";

// Generate x25519 keypair for encryption
const privateKey = x25519.utils.randomSecretKey();
const publicKey = x25519.getPublicKey(privateKey);

// Retrieve MXE public key
const mxePublicKey = await getMXEPublicKey(provider, program.programId);

// Establish shared secret
const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
const cipher = new RescueCipher(sharedSecret);

// Encrypt inputs
const val1 = BigInt(1);
const val2 = BigInt(2);
const nonce = randomBytes(16);
const ciphertext = cipher.encrypt([val1, val2], nonce);

// Queue computation
await program.methods.addTogether(
    computationOffset,
    Array.from(ciphertext[0]),
    Array.from(ciphertext[1]),
    Array.from(publicKey),
    new anchor.BN(deserializeLE(nonce).toString())
).rpc();

// Wait for finalization
await awaitComputationFinalization(provider, computationOffset, program.programId);

// Decrypt and verify result
const decrypted = cipher.decrypt([sumEvent.sum], sumEvent.nonce)[0];
expect(decrypted).to.equal(val1 + val2);
```
