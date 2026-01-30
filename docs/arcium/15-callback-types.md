# Callback Type Generation

## Core Purpose

Arcium automatically generates typed Rust structs for encrypted computation results, eliminating manual byte parsing.

## Generation Mechanism

The `#[instruction]` macro:
1. Parses the function's return type signature
2. Analyzes encryption structure and nested components
3. Generates struct definitions matching the return type
4. Injects types into module scope automatically

Types become available as soon as the macro runs during normal Rust compilation.

## Naming Conventions

### Output Structs
- Function name → PascalCase + "Output" suffix
- `add_together` → `AddTogetherOutput`

### Field Naming
- Single returns: `field_0`
- Multiple values: `field_0`, `field_1`, `field_2`, etc.
- Complex nested: `{Circuit}OutputStruct{index}`

## Encryption Type Structs

### SharedEncryptedStruct<LEN>
For `Enc<Shared, T>`:
```rust
pub struct SharedEncryptedStruct<const LEN: usize> {
    pub encryption_key: [u8; 32],
    pub nonce: u128,
    pub ciphertexts: [[u8; 32]; LEN],
}
```

### MXEEncryptedStruct<LEN>
For `Enc<Mxe, T>`:
```rust
pub struct MXEEncryptedStruct<const LEN: usize> {
    pub nonce: u128,
    pub ciphertexts: [[u8; 32]; LEN],
}
```

## LEN Parameter Calculation

| Return Type | LEN | Reason |
|---|---|---|
| `Enc<Shared, u32>` | 1 | Single scalar |
| `Enc<Shared, (u32, bool)>` | 2 | Two scalars |
| `Enc<Shared, [u32; 5]>` | 5 | Five array elements |
| Custom struct with 3 fields | 3 | All scalar fields count |

LEN counts *all* scalar values at any nesting depth.

## Real-World Example: Voting

```rust
#[instruction]
pub fn vote(
    poll_data: Enc<Mxe, PollData>,
    vote_choice: Enc<Shared, u8>
) -> (Enc<Mxe, PollData>, Enc<Shared, bool>) { }
```

Generates:
```rust
pub struct VoteOutput {
    pub field_0: VoteOutputStruct0,
}

pub struct VoteOutputStruct0 {
    pub field_0: MXEEncryptedStruct<3>,    // Poll data (3 fields)
    pub field_1: SharedEncryptedStruct<1>, // Vote confirmation
}
```

## Callback Usage Pattern

```rust
#[arcium_callback(encrypted_ix = "vote")]
pub fn vote_callback(
    ctx: Context<VoteCallback>,
    output: SignedComputationOutputs<VoteOutput>,
) -> Result<()> {
    let o = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account
    ) {
        Ok(VoteOutput { field_0 }) => field_0,
        Err(_) => return Err(ErrorCode::AbortedComputation.into()),
    };

    let poll_result = o.field_0;      // MXEEncryptedStruct<3>
    let confirmation = o.field_1;      // SharedEncryptedStruct<1>

    // Store updated encrypted state
    ctx.accounts.poll_acc.data = poll_result.ciphertexts;
    ctx.accounts.poll_acc.nonce = poll_result.nonce;
    Ok(())
}
```

## Supported Return Types

**Supported:**
- Primitives (`u8`, `u64`, `bool`, etc.)
- Fixed arrays (`[T; N]`)
- Tuples (`(A, B, C)`)
- Custom structs
- Nested combinations

**Not Supported:**
- `Vec<T>`, dynamic collections
- References (as returns)
- Generic lifetimes
- Recursive structs
- `Option<T>` or `Result<T, E>`
