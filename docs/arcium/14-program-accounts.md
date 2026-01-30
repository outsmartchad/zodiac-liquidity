# Arcium Program Accounts

## Computation Definition Accounts

### Purpose
Bridge between Solana programs and MPC network. Store circuit bytecode and metadata for encrypted instructions.

### Structure

**Interface Account** - Contains metadata:
- Expected input/output types
- Required accounts
- Execution details
- Seeds: `b"ComputationDefinitionAccount"`, MXE program ID, offset

**Bytecode Accounts** - Store raw MPC bytecode:
- Seeds: `b"ComputationDefinitionRaw"`, comp def address, sequential indices

### Offset Calculation
```rust
offset = sha256(<instruction_name>).slice(0,4) as u32 (little-endian)
```

Use `derive_comp_def_pda` macro or `comp_def_offset("instruction_name")`.

### Initialization

```rust
#[init_computation_definition_accounts("add_together", payer)]
#[derive(Accounts)]
pub struct InitAddTogetherCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: Initialized by arcium program
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

pub fn init_add_together_comp_def(ctx: Context<InitAddTogetherCompDef>) -> Result<()> {
    init_comp_def(ctx.accounts, None, None)?;
    Ok(())
}
```

## Callback Accounts

### Required Standard Accounts (6)

Every callback automatically includes:

1. `arcium_program` - Arcium program invoking callback
2. `comp_def_account` - Computation definition
3. `mxe_account` - MXE metadata/config
4. `computation_account` - The computation being processed
5. `cluster_account` - MPC cluster processing computation
6. `instructions_sysvar` - Solana instructions sysvar

### Custom Accounts

Add via `&[CallbackAccount]` parameter to `callback_ix()`:

```rust
vec![AddTogetherCallback::callback_ix(
    computation_offset,
    &ctx.accounts.mxe_account,
    &[CallbackAccount {
        pubkey: ctx.accounts.my_account.key(),
        is_signer: false,
        is_writable: true,
    }]
)?]
```

### Critical Requirements

**Ordering**: Custom accounts must appear after standard accounts in exact sequence.

**Writability**: Set `is_writable: true` AND use `#[account(mut)]`.

**Pre-creation**: Accounts must exist before callback executes. Initialize during queue computation.

**No resizing**: Allocate sufficient space when creating account.

## Queue Computation Accounts (~12)

```rust
#[queue_computation_accounts("add_together", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct AddTogether<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}
```
