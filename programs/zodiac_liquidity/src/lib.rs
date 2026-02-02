use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenInterface;
use anchor_spl::token;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::{CallbackAccount, CircuitSource, OffChainCircuitSource};
use arcium_macros::circuit_hash;
use std::str::FromStr;

// Declare the external DAMM v2 program from IDL
declare_program!(damm_v2);

/// WSOL (Wrapped SOL) mint address
fn native_mint() -> Pubkey {
    Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap()
}

/// Check if a mint is WSOL
fn is_native_mint(mint: &Pubkey) -> bool {
    mint == &native_mint()
}

/// DAMM v2 pool authority address (constant PDA)
fn damm_v2_pool_authority() -> Pubkey {
    Pubkey::from_str("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC").unwrap()
}

/// Token-2022 program ID
fn token_2022_program_id() -> Pubkey {
    Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap()
}

/// Number of zodiac relay PDAs per vault (0..11)
const NUM_RELAYS: u8 = 12;

// Computation definition offsets (derived from instruction names)
const COMP_DEF_OFFSET_INIT_VAULT: u32 = comp_def_offset("init_vault");
const COMP_DEF_OFFSET_INIT_USER_POSITION: u32 = comp_def_offset("init_user_position");
const COMP_DEF_OFFSET_DEPOSIT: u32 = comp_def_offset("deposit");
const COMP_DEF_OFFSET_REVEAL_PENDING: u32 = comp_def_offset("reveal_pending_deposits");
const COMP_DEF_OFFSET_RECORD_LIQUIDITY: u32 = comp_def_offset("record_liquidity");
const COMP_DEF_OFFSET_WITHDRAW: u32 = comp_def_offset("compute_withdrawal");
const COMP_DEF_OFFSET_CLEAR_POSITION: u32 = comp_def_offset("clear_position");
const COMP_DEF_OFFSET_GET_POSITION: u32 = comp_def_offset("get_user_position");

declare_id!("7qpT6gRLFm1F9kHLSkHpcMPM6sbdWRNokQaqae1Zz3j2");

#[arcium_program]
pub mod zodiac_liquidity {
    use super::*;

    // ============================================================
    // COMPUTATION DEFINITION INITIALIZERS (one-time setup per circuit)
    // ============================================================
    //
    // Each MPC circuit requires a one-time on-chain registration (computation definition)
    // that stores the circuit's offchain URL and content hash. ARX nodes fetch the circuit
    // from the URL and verify the hash before executing computations.
    //
    // Security: These are permissionless (any payer can call) because the circuit hash is
    // baked into the program binary via `circuit_hash!()`. A malicious actor cannot register
    // a different circuit — the hash would not match.

    /// Initializes the computation definition for the `init_vault` MPC circuit.
    /// @dev One-time setup. Stores the offchain circuit URL and hash for ARX node fetching.
    /// @dev Permissionless — the circuit hash is verified at computation time by ARX nodes.
    pub fn init_vault_comp_def(ctx: Context<InitVaultCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/init_vault.arcis".to_string(),
                hash: circuit_hash!("init_vault"),
            })),
            None,
        )?;
        Ok(())
    }

    /// Initializes the computation definition for the `init_user_position` MPC circuit.
    pub fn init_user_position_comp_def(ctx: Context<InitUserPositionCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/init_user_position.arcis".to_string(),
                hash: circuit_hash!("init_user_position"),
            })),
            None,
        )?;
        Ok(())
    }

    /// Initializes the computation definition for the `deposit` MPC circuit.
    pub fn init_deposit_comp_def(ctx: Context<InitDepositCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/deposit.arcis".to_string(),
                hash: circuit_hash!("deposit"),
            })),
            None,
        )?;
        Ok(())
    }

    /// Initializes the computation definition for the `reveal_pending_deposits` MPC circuit.
    pub fn init_reveal_pending_comp_def(ctx: Context<InitRevealPendingCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/reveal_pending_deposits.arcis".to_string(),
                hash: circuit_hash!("reveal_pending_deposits"),
                
            })),
            None,
        )?;
        Ok(())
    }

    /// Initializes the computation definition for the `record_liquidity` MPC circuit.
    pub fn init_record_liquidity_comp_def(ctx: Context<InitRecordLiquidityCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/record_liquidity.arcis".to_string(),
                hash: circuit_hash!("record_liquidity"),
            })),
            None,
        )?;
        Ok(())
    }

    /// Initializes the computation definition for the `compute_withdrawal` MPC circuit.
    pub fn init_withdraw_comp_def(ctx: Context<InitWithdrawCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/compute_withdrawal.arcis".to_string(),
                hash: circuit_hash!("compute_withdrawal"),
            })),
            None,
        )?;
        Ok(())
    }

    /// Initializes the computation definition for the `get_user_position` MPC circuit.
    pub fn init_get_position_comp_def(ctx: Context<InitGetPositionCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/get_user_position.arcis".to_string(),
                hash: circuit_hash!("get_user_position"),
            })),
            None,
        )?;
        Ok(())
    }

    /// Initializes the computation definition for the `clear_position` MPC circuit.
    pub fn init_clear_position_comp_def(ctx: Context<InitClearPositionCompDef>) -> Result<()> {
        init_comp_def(
            ctx.accounts,
            Some(CircuitSource::OffChain(OffChainCircuitSource {
                source: "https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/clear_position.arcis".to_string(),
                hash: circuit_hash!("clear_position"),
            })),
            None,
        )?;
        Ok(())
    }

    // ============================================================
    // CREATE VAULT (initializes encrypted vault state)
    // ============================================================

    /// Creates a new privacy vault for a specific base token mint.
    ///
    /// @dev Initializes the VaultAccount PDA (seeds: [b"vault", token_mint]) and queues
    ///      an MPC computation to encrypt the initial zero-state vault.
    /// @dev Uses `init_if_needed` — calling twice with the same mint re-queues MPC but
    ///      does not create a duplicate vault. The callback overwrites vault_state.
    ///
    /// Security invariants:
    /// - Vault PDA is unique per base token mint (enforced by seeds).
    /// - Authority is set to the signer — only one authority per vault.
    /// - No token transfers occur; this is purely state initialization.
    /// - The MPC callback will set the encrypted vault_state and nonce.
    ///
    /// @param computation_offset Random u64 used to derive a unique computation PDA.
    /// @param nonce Random u128 used as the initial encryption nonce.
    pub fn create_vault(
        ctx: Context<CreateVault>,
        computation_offset: u64,
        nonce: u128,
    ) -> Result<()> {
        msg!("Creating new privacy vault");

        // Initialize vault account
        ctx.accounts.vault.bump = ctx.bumps.vault;
        ctx.accounts.vault.authority = ctx.accounts.authority.key();
        ctx.accounts.vault.token_mint = ctx.accounts.token_mint.key();
        ctx.accounts.vault.quote_mint = ctx.accounts.quote_mint.key();
        ctx.accounts.vault.nonce = nonce;
        ctx.accounts.vault.vault_state = [[0; 32]; 5]; // 5 u64s: pending_base, pending_quote, liquidity, total_base, total_quote

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Queue MPC computation to initialize encrypted vault state
        let args = ArgBuilder::new().plaintext_u128(nonce).build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![InitVaultCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.vault.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_vault")]
    pub fn init_vault_callback(
        ctx: Context<InitVaultCallback>,
        output: SignedComputationOutputs<InitVaultOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitVaultOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        ctx.accounts.vault.vault_state = o.ciphertexts;
        ctx.accounts.vault.nonce = o.nonce;

        emit!(VaultCreatedEvent {
            vault: ctx.accounts.vault.key(),
            token_mint: ctx.accounts.vault.token_mint,
            quote_mint: ctx.accounts.vault.quote_mint,
        });

        Ok(())
    }

    // ============================================================
    // CREATE USER POSITION (initializes encrypted user position)
    // ============================================================

    /// Creates a new encrypted user position in the vault.
    ///
    /// @dev Initializes UserPositionAccount PDA (seeds: [b"position", vault, user]) and
    ///      queues an MPC computation to encrypt the initial zero-state position.
    /// @dev One position per user per vault (enforced by PDA seeds).
    ///
    /// Security invariants:
    /// - Position owner is set to the signer's key.
    /// - Position is linked to a specific vault.
    /// - `init_if_needed` allows re-initialization (same concern as create_vault).
    ///
    /// @param computation_offset Random u64 for computation PDA derivation.
    /// @param nonce Random u128 for initial encryption nonce.
    pub fn create_user_position(
        ctx: Context<CreateUserPosition>,
        computation_offset: u64,
        nonce: u128,
    ) -> Result<()> {
        msg!("Creating user position");

        ctx.accounts.user_position.bump = ctx.bumps.user_position;
        ctx.accounts.user_position.owner = ctx.accounts.user.key();
        ctx.accounts.user_position.vault = ctx.accounts.vault.key();
        ctx.accounts.user_position.nonce = nonce;
        ctx.accounts.user_position.position_state = [[0; 32]; 3]; // 3 u64s: base_deposited, quote_deposited, lp_share

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new().plaintext_u128(nonce).build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![InitUserPositionCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.user_position.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "init_user_position")]
    pub fn init_user_position_callback(
        ctx: Context<InitUserPositionCallback>,
        output: SignedComputationOutputs<InitUserPositionOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitUserPositionOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        ctx.accounts.user_position.position_state = o.ciphertexts;
        ctx.accounts.user_position.nonce = o.nonce;

        Ok(())
    }

    // ============================================================
    // DEPOSIT (adds encrypted amount to vault and user position)
    // ============================================================

    /// Deposits base and quote tokens into the vault with encrypted amount tracking.
    ///
    /// @dev Performs two token::transfer CPIs (base + quote) BEFORE queuing the MPC computation.
    ///      The MPC circuit updates both the vault's pending deposits and the user's position.
    /// @dev Plaintext amounts (base_amount, quote_amount) are visible on-chain in the transfer.
    ///      Encrypted amounts are used by MPC to update cumulative encrypted state.
    ///
    /// Security invariants:
    /// - Depositor must own the user position (constraint: user_position.owner == depositor).
    /// - Token accounts validated: user's accounts must match mint + authority, vault accounts
    ///   must match mint + vault PDA authority.
    /// - `vault.has_one = token_mint` ensures correct base mint.
    /// - `quote_mint` address checked against `vault.quote_mint`.
    /// - Token transfers happen atomically before MPC queue. If MPC fails, tokens are in the
    ///   vault but encrypted state is not updated — operator must reconcile.
    ///
    /// @param computation_offset Random u64 for computation PDA derivation.
    /// @param encrypted_base_amount User-encrypted base deposit amount (x25519).
    /// @param encrypted_quote_amount User-encrypted quote deposit amount (x25519).
    /// @param encryption_pubkey User's x25519 public key for shared encryption.
    /// @param amount_nonce Nonce used for the encrypted amounts.
    /// @param base_amount Plaintext base amount for the token transfer.
    /// @param quote_amount Plaintext quote amount for the token transfer.
    pub fn deposit(
        ctx: Context<Deposit>,
        computation_offset: u64,
        encrypted_base_amount: [u8; 32],   // Encrypted base deposit amount
        encrypted_quote_amount: [u8; 32],  // Encrypted quote deposit amount
        encryption_pubkey: [u8; 32],       // User's x25519 public key
        amount_nonce: u128,                // Nonce for encrypted amounts
        base_amount: u64,                  // Plaintext base amount for token transfer
        quote_amount: u64,                 // Plaintext quote amount for token transfer
    ) -> Result<()> {
        msg!("Processing shielded deposit of {} base + {} quote tokens", base_amount, quote_amount);

        // Transfer base tokens from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            base_amount,
        )?;

        // Transfer quote tokens from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_quote_token_account.to_account_info(),
                    to: ctx.accounts.vault_quote_token_account.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            quote_amount,
        )?;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Build arguments for MPC:
        // 1. User's encryption pubkey + nonce + encrypted DepositInput (base_amount, quote_amount)
        // 2. Vault state nonce + account data
        // 3. User position nonce + account data
        let args = ArgBuilder::new()
            // User input (Enc<Shared, DepositInput>) - struct has 2 fields
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(amount_nonce)
            .encrypted_u64(encrypted_base_amount)
            .encrypted_u64(encrypted_quote_amount)
            // Vault state (Enc<Mxe, VaultState>)
            .plaintext_u128(ctx.accounts.vault.nonce)
            .account(
                ctx.accounts.vault.key(),
                8 + 1 + 32 + 32 + 32, // discriminator + bump + authority + token_mint + quote_mint
                32 * 5,               // 5 encrypted u64s
            )
            // User position (Enc<Mxe, UserPosition>)
            .plaintext_u128(ctx.accounts.user_position.nonce)
            .account(
                ctx.accounts.user_position.key(),
                8 + 1 + 32 + 32, // discriminator + bump + owner + vault
                32 * 3,          // 3 encrypted u64s
            )
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![DepositCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: ctx.accounts.vault.key(),
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.user_position.key(),
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "deposit")]
    pub fn deposit_callback(
        ctx: Context<DepositCallback>,
        output: SignedComputationOutputs<DepositOutput>,
    ) -> Result<()> {
        // Tuple returns are wrapped: DepositOutput { field_0: DepositOutputStruct0 }
        // where DepositOutputStruct0 { field_0: vault, field_1: position }
        let tuple = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(DepositOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Update vault state (field_0 of the tuple)
        ctx.accounts.vault.vault_state = tuple.field_0.ciphertexts;
        ctx.accounts.vault.nonce = tuple.field_0.nonce;

        // Update user position (field_1 of the tuple)
        ctx.accounts.user_position.position_state = tuple.field_1.ciphertexts;
        ctx.accounts.user_position.nonce = tuple.field_1.nonce;

        emit!(DepositEvent {
            vault: ctx.accounts.vault.key(),
            user: ctx.accounts.user_position.owner,
        });

        Ok(())
    }

    // ============================================================
    // REVEAL PENDING DEPOSITS (for Meteora deployment)
    // ============================================================

    /// Reveals the total pending base and quote deposits for deployment to Meteora.
    ///
    /// @dev Authority-gated. Decrypts the vault's pending_base and pending_quote via MPC
    ///      and emits the plaintext aggregates in a PendingDepositsRevealedEvent.
    /// @dev The revealed amounts are intentionally public — they represent the aggregate
    ///      of all pending deposits, not individual user amounts.
    ///
    /// Security invariants:
    /// - Only vault authority can call (checked: authority.key() == vault.authority).
    /// - Vault account is read-only in the callback (is_writable: false).
    /// - Reveals aggregate only — individual user deposits remain encrypted.
    ///
    /// @param computation_offset Random u64 for computation PDA derivation.
    pub fn reveal_pending_deposits(
        ctx: Context<RevealPendingDeposits>,
        computation_offset: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault.authority,
            ErrorCode::Unauthorized
        );

        msg!("Revealing pending deposits for deployment");

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .plaintext_u128(ctx.accounts.vault.nonce)
            .account(
                ctx.accounts.vault.key(),
                8 + 1 + 32 + 32 + 32, // discriminator + bump + authority + token_mint + quote_mint
                32 * 5,               // 5 encrypted u64s
            )
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RevealPendingDepositsCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.vault.key(),
                    is_writable: false,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "reveal_pending_deposits")]
    pub fn reveal_pending_deposits_callback(
        ctx: Context<RevealPendingDepositsCallback>,
        output: SignedComputationOutputs<RevealPendingDepositsOutput>,
    ) -> Result<()> {
        // Output is a tuple (u64, u64) -> field_0 is a struct with field_0 (base) and field_1 (quote)
        let tuple = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealPendingDepositsOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(PendingDepositsRevealedEvent {
            vault: ctx.accounts.vault.key(),
            total_pending_base: tuple.field_0,
            total_pending_quote: tuple.field_1,
        });

        Ok(())
    }

    // ============================================================
    // RECORD LIQUIDITY (after Meteora deployment)
    // ============================================================

    /// Records the liquidity delta received from a Meteora add_liquidity CPI.
    ///
    /// @dev Authority-gated. Passes the plaintext liquidity_delta to MPC, which adds it
    ///      to the vault's encrypted total_liquidity field.
    /// @dev The operator must provide the correct liquidity_delta from the Meteora return value.
    ///      An incorrect value desynchronizes encrypted state from the actual Meteora position.
    ///
    /// Security invariants:
    /// - Only vault authority can call.
    /// - liquidity_delta is plaintext u64 — visible on-chain (acceptable since the Meteora
    ///   deposit itself is public).
    /// - Trust assumption: operator provides correct delta. Consider adding an on-chain
    ///   cross-check against Meteora position state in future versions.
    ///
    /// @param computation_offset Random u64 for computation PDA derivation.
    /// @param liquidity_delta The liquidity amount returned by Meteora's add_liquidity.
    pub fn record_liquidity(
        ctx: Context<RecordLiquidity>,
        computation_offset: u64,
        liquidity_delta: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault.authority,
            ErrorCode::Unauthorized
        );

        msg!("Recording {} liquidity from Meteora", liquidity_delta);

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .plaintext_u64(liquidity_delta)
            .plaintext_u128(ctx.accounts.vault.nonce)
            .account(
                ctx.accounts.vault.key(),
                8 + 1 + 32 + 32 + 32, // discriminator + bump + authority + token_mint + quote_mint
                32 * 5,               // 5 encrypted u64s
            )
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![RecordLiquidityCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: ctx.accounts.vault.key(),
                    is_writable: true,
                }],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "record_liquidity")]
    pub fn record_liquidity_callback(
        ctx: Context<RecordLiquidityCallback>,
        output: SignedComputationOutputs<RecordLiquidityOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RecordLiquidityOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        ctx.accounts.vault.vault_state = o.ciphertexts;
        ctx.accounts.vault.nonce = o.nonce;

        emit!(LiquidityRecordedEvent {
            vault: ctx.accounts.vault.key(),
        });

        Ok(())
    }

    // ============================================================
    // WITHDRAW (computes pro-rata share and withdraws)
    // ============================================================

    /// Computes the user's withdrawal amounts (base + quote) via MPC.
    ///
    /// @dev The MPC circuit reads the user's encrypted position and returns the amounts
    ///      encrypted for the user's x25519 key. No on-chain state is modified.
    /// @dev The callback emits a WithdrawEvent with encrypted_base_amount and
    ///      encrypted_quote_amount. Only the user can decrypt these with their x25519 key.
    /// @dev Actual token movements happen separately via withdraw_from_meteora_damm_v2
    ///      and relay_transfer_to_destination.
    ///
    /// Security invariants:
    /// - User must own the position (PDA seeds include user key).
    /// - Output is encrypted for the user's pubkey — MPC cluster cannot see the output
    ///   after encryption (only during computation).
    /// - No state mutation in callback — position/vault are read-only.
    /// - Shared type requires both x25519_pubkey AND shared_nonce (per circuit .idarc).
    ///
    /// @param computation_offset Random u64 for computation PDA derivation.
    /// @param encryption_pubkey User's x25519 public key for output encryption.
    /// @param shared_nonce Nonce for Shared type encryption.
    pub fn withdraw(
        ctx: Context<Withdraw>,
        computation_offset: u64,
        encryption_pubkey: [u8; 32],
        shared_nonce: u128,
    ) -> Result<()> {
        msg!("Processing withdrawal");

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Circuit: compute_withdrawal(user_position: Enc<Mxe, UserPosition>, user_pubkey: Shared) -> Enc<Shared, WithdrawAmounts>
        // Shared type requires x25519_pubkey + u128 nonce (per circuit .idarc)
        let args = ArgBuilder::new()
            // User position (Enc<Mxe, UserPosition>)
            .plaintext_u128(ctx.accounts.user_position.nonce)
            .account(
                ctx.accounts.user_position.key(),
                8 + 1 + 32 + 32,
                32 * 3,          // 3 encrypted u64s
            )
            // User pubkey (Shared) - requires both pubkey and nonce
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(shared_nonce)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ComputeWithdrawalCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: ctx.accounts.vault.key(),
                        is_writable: false,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.user_position.key(),
                        is_writable: false,
                    },
                ],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_withdrawal")]
    pub fn compute_withdrawal_callback(
        ctx: Context<ComputeWithdrawalCallback>,
        output: SignedComputationOutputs<ComputeWithdrawalOutput>,
    ) -> Result<()> {
        // Circuit returns Enc<Shared, WithdrawAmounts> with 2 ciphertexts (base_amount, quote_amount)
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ComputeWithdrawalOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Emit withdrawal amounts (encrypted for user)
        // State updates happen in separate clear_position call
        emit!(WithdrawEvent {
            vault: ctx.accounts.vault.key(),
            user: ctx.accounts.user_position.owner,
            encrypted_base_amount: o.ciphertexts[0],
            encrypted_quote_amount: o.ciphertexts[1],
            nonce: o.nonce,
        });

        Ok(())
    }

    // ============================================================
    // GET USER POSITION (lets user see their own balance)
    // ============================================================

    /// Gets the user's current position (base_deposited, quote_deposited, lp_share),
    /// encrypted for the user's x25519 key only.
    ///
    /// @dev Read-only MPC computation. Emits a UserPositionEvent with three encrypted u64s.
    /// @dev LP share calculation is off-chain to reduce circuit complexity (division is
    ///      extremely expensive in MPC — ~3+ billion ACUs).
    ///
    /// Security invariants:
    /// - User must own the position (PDA seeds include user key).
    /// - No state mutation. Callback has no writable accounts.
    /// - Output is encrypted for the user's pubkey.
    ///
    /// @param computation_offset Random u64 for computation PDA derivation.
    /// @param encryption_pubkey User's x25519 public key for output encryption.
    /// @param shared_nonce Nonce for Shared type encryption.
    pub fn get_user_position(
        ctx: Context<GetUserPosition>,
        computation_offset: u64,
        encryption_pubkey: [u8; 32],
        shared_nonce: u128,
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // Shared type requires x25519_pubkey + u128 nonce (per circuit .idarc)
        let args = ArgBuilder::new()
            // User position (Enc<Mxe, UserPosition>)
            .plaintext_u128(ctx.accounts.user_position.nonce)
            .account(
                ctx.accounts.user_position.key(),
                8 + 1 + 32 + 32,
                32 * 3,          // 3 encrypted u64s
            )
            // User pubkey (Shared) - requires both pubkey and nonce
            .x25519_pubkey(encryption_pubkey)
            .plaintext_u128(shared_nonce)
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![GetUserPositionCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "get_user_position")]
    pub fn get_user_position_callback(
        ctx: Context<GetUserPositionCallback>,
        output: SignedComputationOutputs<GetUserPositionOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(GetUserPositionOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        emit!(UserPositionEvent {
            encrypted_base_deposited: o.ciphertexts[0],
            encrypted_quote_deposited: o.ciphertexts[1],
            encrypted_lp_share: o.ciphertexts[2],
            nonce: o.nonce,
        });

        Ok(())
    }

    // ============================================================
    // CLEAR POSITION (zeros user position after withdrawal confirmed)
    // ============================================================

    /// Clears a user's position after withdrawal has been confirmed off-chain.
    ///
    /// @dev Authority-gated. Zeros the user's encrypted position and deducts the withdrawal
    ///      amounts from the vault's encrypted totals via MPC.
    /// @dev Called AFTER the operator has confirmed that tokens have been transferred to
    ///      the user via relay_transfer_to_destination.
    ///
    /// Security invariants:
    /// - Only vault authority can call (checked: authority.key() == vault.authority).
    /// - Trust assumption: operator provides correct base_withdraw_amount and
    ///   quote_withdraw_amount matching the decrypted compute_withdrawal output.
    /// - Both vault and user_position are writable in the callback (state mutation).
    /// - After clearing, the user's position_state should be all-zero (encrypted).
    ///
    /// @param computation_offset Random u64 for computation PDA derivation.
    /// @param base_withdraw_amount Plaintext base amount to deduct from vault totals.
    /// @param quote_withdraw_amount Plaintext quote amount to deduct from vault totals.
    pub fn clear_position(
        ctx: Context<ClearPosition>,
        computation_offset: u64,
        base_withdraw_amount: u64,
        quote_withdraw_amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault.authority,
            ErrorCode::Unauthorized
        );

        msg!("Clearing position with base={} quote={}", base_withdraw_amount, quote_withdraw_amount);

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            // User position (Enc<Mxe, UserPosition>)
            .plaintext_u128(ctx.accounts.user_position.nonce)
            .account(
                ctx.accounts.user_position.key(),
                8 + 1 + 32 + 32, // discriminator + bump + owner + vault
                32 * 3,          // 3 encrypted u64s
            )
            // Base withdraw amount (plaintext u64)
            .plaintext_u64(base_withdraw_amount)
            // Quote withdraw amount (plaintext u64)
            .plaintext_u64(quote_withdraw_amount)
            // Vault state (Enc<Mxe, VaultState>)
            .plaintext_u128(ctx.accounts.vault.nonce)
            .account(
                ctx.accounts.vault.key(),
                8 + 1 + 32 + 32 + 32, // discriminator + bump + authority + token_mint + quote_mint
                32 * 5,               // 5 encrypted u64s
            )
            .build();

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![ClearPositionCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[
                    CallbackAccount {
                        pubkey: ctx.accounts.vault.key(),
                        is_writable: true,
                    },
                    CallbackAccount {
                        pubkey: ctx.accounts.user_position.key(),
                        is_writable: true,
                    },
                ],
            )?],
            1,
            0,
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "clear_position")]
    pub fn clear_position_callback(
        ctx: Context<ClearPositionCallback>,
        output: SignedComputationOutputs<ClearPositionOutput>,
    ) -> Result<()> {
        let tuple = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(ClearPositionOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        // Update user position (field_0 of the tuple)
        ctx.accounts.user_position.position_state = tuple.field_0.ciphertexts;
        ctx.accounts.user_position.nonce = tuple.field_0.nonce;

        // Update vault state (field_1 of the tuple)
        ctx.accounts.vault.vault_state = tuple.field_1.ciphertexts;
        ctx.accounts.vault.nonce = tuple.field_1.nonce;

        emit!(PositionClearedEvent {
            vault: ctx.accounts.vault.key(),
            user: ctx.accounts.user_position.owner,
        });

        Ok(())
    }

    // ============================================================
    // METEORA DAMM V2 CPI (Relay PDA signs all interactions)
    // ============================================================

    /// Deploys aggregated liquidity to a Meteora DAMM v2 pool via relay PDA CPI.
    ///
    /// @dev The relay PDA (seeds: [b"zodiac_relay", vault, relay_index]) signs the CPI
    ///      to Meteora's add_liquidity instruction. This breaks the user-to-LP linkability
    ///      since the pool only sees the protocol's relay PDA, not individual users.
    /// @dev If the quote token is WSOL and sol_amount is provided, SOL is automatically
    ///      wrapped via system_program::transfer + sync_native before the CPI.
    ///
    /// Security invariants:
    /// - Requires a registered ephemeral wallet PDA (prevents unauthorized Meteora CPI).
    /// - relay_index must be < NUM_RELAYS (12).
    /// - Relay PDA signer seeds include vault key + relay_index — cannot forge.
    /// - Pool, position, and vault accounts are validated by the Meteora DAMM v2 program.
    /// - Emits DepositedToMeteoraEvent for off-chain tracking.
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    /// @param liquidity_delta Amount of liquidity to add (u128, Meteora native unit).
    /// @param token_a_amount_threshold Maximum token A slippage.
    /// @param token_b_amount_threshold Maximum token B slippage.
    /// @param sol_amount Optional SOL amount to wrap as WSOL for token B.
    pub fn deposit_to_meteora_damm_v2(
        ctx: Context<DepositToMeteoraDammV2>,
        relay_index: u8,
        liquidity_delta: u128,
        token_a_amount_threshold: u64,
        token_b_amount_threshold: u64,
        sol_amount: Option<u64>,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);

        msg!("Relay PDA {} deploying {} liquidity to Meteora", relay_index, liquidity_delta);

        // If token_b_mint is WSOL and sol_amount is provided, wrap SOL first
        if is_native_mint(&ctx.accounts.token_b_mint.key()) {
            if let Some(amount) = sol_amount {
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        anchor_lang::system_program::Transfer {
                            from: ctx.accounts.payer.to_account_info(),
                            to: ctx.accounts.relay_token_b.to_account_info(),
                        },
                    ),
                    amount,
                )?;

                token::sync_native(CpiContext::new(
                    ctx.accounts.token_b_program.to_account_info(),
                    token::SyncNative {
                        account: ctx.accounts.relay_token_b.to_account_info(),
                    },
                ))?;
            }
        }

        // Relay PDA signs the CPI to Meteora
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"zodiac_relay".as_ref(),
            vault_key.as_ref(),
            &[relay_index],
            &[ctx.bumps.relay_pda],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = damm_v2::cpi::accounts::AddLiquidity {
            pool: ctx.accounts.pool.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            token_a_account: ctx.accounts.relay_token_a.to_account_info(),
            token_b_account: ctx.accounts.relay_token_b.to_account_info(),
            token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
            token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
            token_a_mint: ctx.accounts.token_a_mint.to_account_info(),
            token_b_mint: ctx.accounts.token_b_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            owner: ctx.accounts.relay_pda.to_account_info(),
            token_a_program: ctx.accounts.token_a_program.to_account_info(),
            token_b_program: ctx.accounts.token_b_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.amm_program.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.amm_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        damm_v2::cpi::add_liquidity(
            cpi_ctx,
            damm_v2::types::AddLiquidityParameters {
                liquidity_delta,
                token_a_amount_threshold,
                token_b_amount_threshold,
            },
        )?;

        emit!(DepositedToMeteoraEvent {
            vault: ctx.accounts.vault.key(),
            relay_index,
            liquidity_delta,
        });

        Ok(())
    }

    /// Withdraws liquidity from a Meteora DAMM v2 pool via relay PDA CPI.
    ///
    /// @dev The relay PDA signs Meteora's remove_liquidity CPI. Tokens are returned to
    ///      the relay PDA's token accounts, NOT directly to users. The operator then
    ///      calls relay_transfer_to_destination to send tokens to the user's ephemeral wallet.
    ///
    /// Security invariants:
    /// - Requires a registered ephemeral wallet PDA.
    /// - relay_index must be < NUM_RELAYS (12).
    /// - Pool authority is validated against the hardcoded damm_v2_pool_authority() address.
    /// - Emits WithdrawnFromMeteoraEvent for off-chain tracking.
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    /// @param liquidity_delta Amount of liquidity to remove (u128).
    /// @param token_a_amount_threshold Minimum token A to receive (slippage protection).
    /// @param token_b_amount_threshold Minimum token B to receive (slippage protection).
    pub fn withdraw_from_meteora_damm_v2(
        ctx: Context<WithdrawFromMeteoraDammV2>,
        relay_index: u8,
        liquidity_delta: u128,
        token_a_amount_threshold: u64,
        token_b_amount_threshold: u64,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);

        msg!("Relay PDA {} withdrawing {} liquidity from Meteora", relay_index, liquidity_delta);

        // Relay PDA signs the CPI to Meteora
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"zodiac_relay".as_ref(),
            vault_key.as_ref(),
            &[relay_index],
            &[ctx.bumps.relay_pda],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = damm_v2::cpi::accounts::RemoveLiquidity {
            pool_authority: ctx.accounts.pool_authority.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            token_a_account: ctx.accounts.relay_token_a.to_account_info(),
            token_b_account: ctx.accounts.relay_token_b.to_account_info(),
            token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
            token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
            token_a_mint: ctx.accounts.token_a_mint.to_account_info(),
            token_b_mint: ctx.accounts.token_b_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            owner: ctx.accounts.relay_pda.to_account_info(),
            token_a_program: ctx.accounts.token_a_program.to_account_info(),
            token_b_program: ctx.accounts.token_b_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.amm_program.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.amm_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        damm_v2::cpi::remove_liquidity(
            cpi_ctx,
            damm_v2::types::RemoveLiquidityParameters {
                liquidity_delta,
                token_a_amount_threshold,
                token_b_amount_threshold,
            },
        )?;

        emit!(WithdrawnFromMeteoraEvent {
            vault: ctx.accounts.vault.key(),
            relay_index,
            liquidity_delta,
        });

        Ok(())
    }

    /// Creates a Meteora DAMM v2 position for a relay PDA.
    ///
    /// @dev Called once per relay per pool. The RelayPositionTracker PDA
    ///      (seeds: [b"relay_position", vault, relay_index, pool]) enforces uniqueness.
    /// @dev The relay PDA signs the CPI and pays rent for the Meteora position account.
    ///
    /// Security invariants:
    /// - Requires a registered ephemeral wallet PDA.
    /// - relay_index must be < NUM_RELAYS (12).
    /// - RelayPositionTracker init prevents duplicate positions (same relay + pool).
    /// - Position NFT mint is a new keypair (signer), preventing replay.
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    pub fn create_meteora_position(
        ctx: Context<CreateMeteoraPosition>,
        relay_index: u8,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);

        msg!("Creating Meteora position for relay PDA {}", relay_index);

        // Initialize position tracker (enforces one position per relay per pool)
        let tracker = &mut ctx.accounts.relay_position_tracker;
        tracker.vault = ctx.accounts.vault.key();
        tracker.relay_index = relay_index;
        tracker.pool = ctx.accounts.pool.key();
        tracker.position_nft_mint = ctx.accounts.position_nft_mint.key();
        tracker.bump = ctx.bumps.relay_position_tracker;

        // Relay PDA signs the CPI to Meteora
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"zodiac_relay".as_ref(),
            vault_key.as_ref(),
            &[relay_index],
            &[ctx.bumps.relay_pda],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = damm_v2::cpi::accounts::CreatePosition {
            owner: ctx.accounts.relay_pda.to_account_info(),
            position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            pool_authority: ctx.accounts.pool_authority.to_account_info(),
            payer: ctx.accounts.relay_pda.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.amm_program.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.amm_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        damm_v2::cpi::create_position(cpi_ctx)?;

        emit!(MeteoraPositionCreatedEvent {
            vault: ctx.accounts.vault.key(),
            relay_index,
            pool: ctx.accounts.pool.key(),
        });

        Ok(())
    }

    /// Creates a Meteora DAMM v2 pool via a relay PDA (config-based).
    ///
    /// @dev The relay PDA acts as both creator and payer for the Meteora initialize_pool CPI.
    ///      The pool is not linked to any user wallet — only to the protocol's relay PDA.
    /// @dev The relay PDA must be pre-funded with SOL (~0.5 SOL for rent) and tokens
    ///      (initial liquidity) via fund_relay before calling this.
    ///
    /// Security invariants:
    /// - Requires a registered ephemeral wallet PDA.
    /// - relay_index must be < NUM_RELAYS (12).
    /// - Pool config account is validated by the Meteora DAMM v2 program.
    /// - Initial liquidity comes from the relay PDA's token accounts.
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    /// @param liquidity Initial liquidity amount (u128).
    /// @param sqrt_price Initial sqrt price (u128).
    /// @param activation_point Optional activation slot/timestamp.
    pub fn create_pool_via_relay(
        ctx: Context<CreatePoolViaRelay>,
        relay_index: u8,
        liquidity: u128,
        sqrt_price: u128,
        activation_point: Option<u64>,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);

        msg!("Relay PDA {} creating Meteora pool", relay_index);

        // Relay PDA signs the CPI as payer
        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"zodiac_relay".as_ref(),
            vault_key.as_ref(),
            &[relay_index],
            &[ctx.bumps.relay_pda],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = damm_v2::cpi::accounts::InitializePool {
            creator: ctx.accounts.relay_pda.to_account_info(),
            position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            payer: ctx.accounts.relay_pda.to_account_info(),
            config: ctx.accounts.config.to_account_info(),
            pool_authority: ctx.accounts.pool_authority.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            token_a_mint: ctx.accounts.token_a_mint.to_account_info(),
            token_b_mint: ctx.accounts.token_b_mint.to_account_info(),
            token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
            token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
            payer_token_a: ctx.accounts.relay_token_a.to_account_info(),
            payer_token_b: ctx.accounts.relay_token_b.to_account_info(),
            token_a_program: ctx.accounts.token_a_program.to_account_info(),
            token_b_program: ctx.accounts.token_b_program.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.amm_program.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.amm_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        damm_v2::cpi::initialize_pool(
            cpi_ctx,
            damm_v2::types::InitializePoolParameters {
                liquidity,
                sqrt_price,
                activation_point,
            },
        )?;

        emit!(PoolCreatedViaRelayEvent {
            vault: ctx.accounts.vault.key(),
            relay_index,
            pool: ctx.accounts.pool.key(),
        });

        Ok(())
    }

    /// Creates a customizable Meteora DAMM v2 pool via a relay PDA.
    ///
    /// @dev Unlike create_pool_via_relay, this does not require a config account and
    ///      allows full control over pool parameters (fees, price range, activation).
    ///      Preferred for production deployments where fee control is important.
    ///
    /// Security invariants:
    /// - Same as create_pool_via_relay.
    /// - Fee parameters are validated by the Meteora DAMM v2 program.
    /// - sqrt_min_price and sqrt_max_price define the price range for the pool.
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    /// @param pool_fees Fee parameters (base_fee, dynamic_fee, protocol_fee, etc.).
    /// @param sqrt_min_price Minimum sqrt price for the pool range (u128).
    /// @param sqrt_max_price Maximum sqrt price for the pool range (u128).
    /// @param has_alpha_vault Whether to enable alpha vault.
    /// @param liquidity Initial liquidity amount (u128).
    /// @param sqrt_price Initial sqrt price (u128).
    /// @param activation_type Activation type (slot-based or time-based).
    /// @param collect_fee_mode Fee collection mode (0 = linear).
    /// @param activation_point Optional activation slot/timestamp.
    pub fn create_customizable_pool_via_relay(
        ctx: Context<CreateCustomizablePoolViaRelay>,
        relay_index: u8,
        pool_fees: damm_v2::types::PoolFeeParameters,
        sqrt_min_price: u128,
        sqrt_max_price: u128,
        has_alpha_vault: bool,
        liquidity: u128,
        sqrt_price: u128,
        activation_type: u8,
        collect_fee_mode: u8,
        activation_point: Option<u64>,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);

        msg!("Relay PDA {} creating customizable Meteora pool", relay_index);

        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"zodiac_relay".as_ref(),
            vault_key.as_ref(),
            &[relay_index],
            &[ctx.bumps.relay_pda],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = damm_v2::cpi::accounts::InitializeCustomizablePool {
            creator: ctx.accounts.relay_pda.to_account_info(),
            position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
            position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
            payer: ctx.accounts.relay_pda.to_account_info(),
            pool_authority: ctx.accounts.pool_authority.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            token_a_mint: ctx.accounts.token_a_mint.to_account_info(),
            token_b_mint: ctx.accounts.token_b_mint.to_account_info(),
            token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
            token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
            payer_token_a: ctx.accounts.relay_token_a.to_account_info(),
            payer_token_b: ctx.accounts.relay_token_b.to_account_info(),
            token_a_program: ctx.accounts.token_a_program.to_account_info(),
            token_b_program: ctx.accounts.token_b_program.to_account_info(),
            token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.amm_program.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.amm_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        damm_v2::cpi::initialize_customizable_pool(
            cpi_ctx,
            damm_v2::types::InitializeCustomizablePoolParameters {
                pool_fees,
                sqrt_min_price,
                sqrt_max_price,
                has_alpha_vault,
                liquidity,
                sqrt_price,
                activation_type,
                collect_fee_mode,
                activation_point,
            },
        )?;

        emit!(CustomizablePoolCreatedViaRelayEvent {
            vault: ctx.accounts.vault.key(),
            relay_index,
            pool: ctx.accounts.pool.key(),
        });

        Ok(())
    }

    /// Funds a relay PDA's token account from the authority's token account.
    ///
    /// @dev Authority-gated. Transfers SPL tokens from authority to the relay PDA's
    ///      associated token account. Must be called before create_pool_via_relay
    ///      or deposit_to_meteora_damm_v2 to ensure the relay has tokens to deploy.
    ///
    /// Security invariants:
    /// - Only vault authority can call.
    /// - relay_index must be < NUM_RELAYS (12).
    /// - Token transfer uses standard SPL token::transfer (not PDA-signed).
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    /// @param amount Number of tokens to transfer.
    pub fn fund_relay(
        ctx: Context<FundRelay>,
        relay_index: u8,
        amount: u64,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault.authority,
            ErrorCode::Unauthorized
        );

        msg!("Funding relay PDA {} with {} tokens", relay_index, amount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.authority_token_account.to_account_info(),
                    to: ctx.accounts.relay_token_account.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(RelayFundedEvent {
            vault: ctx.accounts.vault.key(),
            relay_index,
            amount,
        });

        Ok(())
    }

    // ============================================================
    // RELAY TRANSFER TO DESTINATION (withdrawal last mile)
    // ============================================================

    /// Transfers tokens from a relay PDA's token account to a destination.
    ///
    /// @dev Authority-gated. Relay PDA signs the token::transfer via PDA signer seeds.
    ///      Typically called after withdraw_from_meteora_damm_v2 to forward tokens
    ///      to the user's ephemeral wallet.
    ///
    /// Security invariants:
    /// - Only vault authority can call.
    /// - Relay PDA signs with seeds [b"zodiac_relay", vault, relay_index, bump].
    /// - Destination is an arbitrary token account — the authority controls routing.
    /// - Risk: compromised authority can redirect funds to any account.
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    /// @param amount Number of tokens to transfer.
    pub fn relay_transfer_to_destination(
        ctx: Context<RelayTransferToDestination>,
        relay_index: u8,
        amount: u64,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault.authority,
            ErrorCode::Unauthorized
        );

        msg!("Relay PDA {} transferring {} tokens to destination", relay_index, amount);

        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"zodiac_relay".as_ref(),
            vault_key.as_ref(),
            &[relay_index],
            &[ctx.bumps.relay_pda],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.relay_token_account.to_account_info(),
                    to: ctx.accounts.destination_token_account.to_account_info(),
                    authority: ctx.accounts.relay_pda.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        emit!(RelayTransferEvent {
            vault: ctx.accounts.vault.key(),
            relay_index,
            destination: ctx.accounts.destination_token_account.key(),
            amount,
        });

        Ok(())
    }

    // ============================================================
    // RELAY SOL WITHDRAWAL + TOKEN ACCOUNT CLOSE
    // ============================================================

    /// Withdraws SOL from a relay PDA back to the authority.
    ///
    /// @dev Authority-gated. Used to reclaim rent SOL from relay PDAs after Meteora
    ///      operations complete. Relay PDAs accumulate SOL from pool creation rent.
    ///
    /// Security invariants:
    /// - Only vault authority can call.
    /// - SOL goes to authority only (not an arbitrary destination).
    /// - Relay PDA signs via PDA signer seeds.
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    /// @param lamports Amount of SOL (in lamports) to withdraw.
    pub fn withdraw_relay_sol(
        ctx: Context<WithdrawRelaySol>,
        relay_index: u8,
        lamports: u64,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault.authority,
            ErrorCode::Unauthorized
        );

        msg!("Withdrawing {} lamports from relay PDA {}", lamports, relay_index);

        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"zodiac_relay".as_ref(),
            vault_key.as_ref(),
            &[relay_index],
            &[ctx.bumps.relay_pda],
        ];
        let signer_seeds = &[&seeds[..]];

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.relay_pda.to_account_info(),
                    to: ctx.accounts.authority.to_account_info(),
                },
                signer_seeds,
            ),
            lamports,
        )?;

        emit!(RelaySolWithdrawnEvent {
            vault: ctx.accounts.vault.key(),
            relay_index,
            lamports,
        });

        Ok(())
    }

    /// Closes a relay PDA's token account, returning rent SOL to the authority.
    ///
    /// @dev Authority-gated. The SPL Token program enforces zero balance before close.
    ///      Use relay_transfer_to_destination to drain tokens first.
    ///
    /// Security invariants:
    /// - Only vault authority can call.
    /// - Token account must have zero balance (enforced by SPL Token program).
    /// - Rent SOL goes to authority.
    ///
    /// @param relay_index Index of the relay PDA (0..11).
    pub fn close_relay_token_account(
        ctx: Context<CloseRelayTokenAccount>,
        relay_index: u8,
    ) -> Result<()> {
        require!(relay_index < NUM_RELAYS, ErrorCode::InvalidRelayIndex);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault.authority,
            ErrorCode::Unauthorized
        );

        msg!("Closing relay PDA {} token account", relay_index);

        let vault_key = ctx.accounts.vault.key();
        let seeds = &[
            b"zodiac_relay".as_ref(),
            vault_key.as_ref(),
            &[relay_index],
            &[ctx.bumps.relay_pda],
        ];
        let signer_seeds = &[&seeds[..]];

        token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::CloseAccount {
                    account: ctx.accounts.relay_token_account.to_account_info(),
                    destination: ctx.accounts.authority.to_account_info(),
                    authority: ctx.accounts.relay_pda.to_account_info(),
                },
                signer_seeds,
            ),
        )?;

        Ok(())
    }

    // ============================================================
    // EPHEMERAL WALLET MANAGEMENT
    // ============================================================

    /// Registers an ephemeral wallet PDA, authorizing it for Meteora CPI operations.
    ///
    /// @dev Authority-gated. Creates an EphemeralWalletAccount PDA
    ///      (seeds: [b"ephemeral", vault, wallet]) that serves as an authorization
    ///      check for Meteora CPI instructions (deposit, withdraw, create position/pool).
    /// @dev Per-operation pattern: a fresh ephemeral wallet is registered before each
    ///      Meteora CPI, used once, then closed via close_ephemeral_wallet.
    ///      This prevents cross-operation linkability.
    ///
    /// Security invariants:
    /// - PDA existence is the sole authorization check (no is_active flag).
    /// - One PDA per vault+wallet pair (enforced by seeds).
    /// - Wallet key is stored in the account for auditability.
    pub fn register_ephemeral_wallet(
        ctx: Context<RegisterEphemeralWallet>,
    ) -> Result<()> {
        let ephemeral = &mut ctx.accounts.ephemeral_wallet;
        ephemeral.bump = ctx.bumps.ephemeral_wallet;
        ephemeral.vault = ctx.accounts.vault.key();
        ephemeral.wallet = ctx.accounts.wallet.key();
        msg!("Registered ephemeral wallet: {}", ctx.accounts.wallet.key());

        emit!(EphemeralWalletRegisteredEvent {
            vault: ctx.accounts.vault.key(),
            wallet: ctx.accounts.wallet.key(),
        });

        Ok(())
    }

    /// Closes an ephemeral wallet PDA, returning rent SOL to the authority.
    ///
    /// @dev Authority-gated. Called after the Meteora CPI operation completes to
    ///      reclaim the ~0.001 SOL rent and revoke the wallet's authorization.
    ///
    /// Security invariants:
    /// - Only vault authority can close.
    /// - Anchor's `close` attribute transfers rent to authority and zeros the account.
    /// - Once closed, the ephemeral wallet can no longer sign Meteora CPIs
    ///   (the PDA no longer exists, so bump validation will fail).
    pub fn close_ephemeral_wallet(
        ctx: Context<CloseEphemeralWallet>,
    ) -> Result<()> {
        msg!("Closed ephemeral wallet: {}", ctx.accounts.ephemeral_wallet.wallet);

        emit!(EphemeralWalletClosedEvent {
            vault: ctx.accounts.vault.key(),
            wallet: ctx.accounts.ephemeral_wallet.wallet,
        });

        Ok(())
    }

}

// ============================================================
// ACCOUNT STRUCTURES
// ============================================================

/// Vault account holding encrypted aggregate state.
#[account]
#[derive(InitSpace)]
pub struct VaultAccount {
    pub bump: u8,
    pub authority: Pubkey,
    pub token_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// Encrypted vault state: [pending_base, pending_quote, total_liquidity, total_base_deposited, total_quote_deposited]
    pub vault_state: [[u8; 32]; 5],
    pub nonce: u128,
}

/// User position in a vault.
#[account]
#[derive(InitSpace)]
pub struct UserPositionAccount {
    pub bump: u8,
    pub owner: Pubkey,
    pub vault: Pubkey,
    /// Encrypted position: [base_deposited, quote_deposited, lp_share]
    pub position_state: [[u8; 32]; 3],
    pub nonce: u128,
}

/// Tracks a relay PDA's Meteora position for a specific pool.
/// Enforces one aggregate position per relay per pool.
#[account]
#[derive(InitSpace)]
pub struct RelayPositionTracker {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub pool: Pubkey,
    pub position_nft_mint: Pubkey,
    pub bump: u8,
}

/// Ephemeral wallet authorization PDA.
/// Registered by vault authority, allows an ephemeral wallet to sign Meteora CPI instructions.
/// Seeds: [b"ephemeral", vault.key(), wallet.key()]
#[account]
#[derive(InitSpace)]
pub struct EphemeralWalletAccount {
    pub bump: u8,
    pub vault: Pubkey,
    pub wallet: Pubkey,
}

// ============================================================
// COMPUTATION DEFINITION ACCOUNT CONTEXTS
// ============================================================

#[init_computation_definition_accounts("init_vault", payer)]
#[derive(Accounts)]
pub struct InitVaultCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("init_user_position", payer)]
#[derive(Accounts)]
pub struct InitUserPositionCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("deposit", payer)]
#[derive(Accounts)]
pub struct InitDepositCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("reveal_pending_deposits", payer)]
#[derive(Accounts)]
pub struct InitRevealPendingCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("record_liquidity", payer)]
#[derive(Accounts)]
pub struct InitRecordLiquidityCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("compute_withdrawal", payer)]
#[derive(Accounts)]
pub struct InitWithdrawCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("get_user_position", payer)]
#[derive(Accounts)]
pub struct InitGetPositionCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("clear_position", payer)]
#[derive(Accounts)]
pub struct InitClearPositionCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: address_lookup_table
    pub address_lookup_table: UncheckedAccount<'info>,
    /// CHECK: lut_program
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ============================================================
// QUEUE COMPUTATION ACCOUNT CONTEXTS
// ============================================================

#[queue_computation_accounts("init_vault", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_VAULT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    /// Base token mint for this vault
    pub token_mint: Account<'info, anchor_spl::token::Mint>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + VaultAccount::INIT_SPACE,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// Quote token mint for this vault (typically WSOL)
    pub quote_mint: Account<'info, anchor_spl::token::Mint>,
}

#[queue_computation_accounts("init_user_position", user)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CreateUserPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = user,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_USER_POSITION))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    pub vault: Account<'info, VaultAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPositionAccount::INIT_SPACE,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_position: Account<'info, UserPositionAccount>,
}

#[queue_computation_accounts("deposit", depositor)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = depositor,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    #[account(mut, has_one = token_mint)]
    pub vault: Box<Account<'info, VaultAccount>>,

    #[account(
        mut,
        seeds = [b"position", vault.key().as_ref(), depositor.key().as_ref()],
        bump = user_position.bump,
        constraint = user_position.owner == depositor.key() @ ErrorCode::Unauthorized,
    )]
    pub user_position: Box<Account<'info, UserPositionAccount>>,

    /// Base token mint for this vault
    pub token_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    /// Quote token mint for this vault (typically WSOL)
    #[account(address = vault.quote_mint)]
    pub quote_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    /// User's base token account (source)
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = depositor,
    )]
    pub user_token_account: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    /// Vault's base token account (destination)
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = vault,
    )]
    pub vault_token_account: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    /// User's quote token account (source)
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = depositor,
    )]
    pub user_quote_token_account: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    /// Vault's quote token account (destination)
    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = vault,
    )]
    pub vault_quote_token_account: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    pub token_program: Program<'info, anchor_spl::token::Token>,
}

#[queue_computation_accounts("reveal_pending_deposits", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RevealPendingDeposits<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_PENDING))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    #[account(has_one = authority @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, VaultAccount>,
}

#[queue_computation_accounts("record_liquidity", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RecordLiquidity<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RECORD_LIQUIDITY))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, VaultAccount>,
}

#[queue_computation_accounts("compute_withdrawal", user)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = user,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_WITHDRAW))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    #[account(mut)]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        mut,
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Account<'info, UserPositionAccount>,
}

#[queue_computation_accounts("get_user_position", user)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct GetUserPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = user,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_GET_POSITION))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    /// Vault account for verifying position
    pub vault: Account<'info, VaultAccount>,

    #[account(
        seeds = [b"position", vault.key().as_ref(), user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Account<'info, UserPositionAccount>,
}

#[queue_computation_accounts("clear_position", authority)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ClearPosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init_if_needed,
        space = 9,
        payer = authority,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,

    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: mempool_account
    pub mempool_account: UncheckedAccount<'info>,

    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: executing_pool
    pub executing_pool: UncheckedAccount<'info>,

    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,

    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CLEAR_POSITION))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,

    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,

    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,

    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,

    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, VaultAccount>,

    #[account(mut)]
    pub user_position: Account<'info, UserPositionAccount>,
}

// ============================================================
// CALLBACK ACCOUNT CONTEXTS
// ============================================================

#[callback_accounts("init_vault")]
#[derive(Accounts)]
pub struct InitVaultCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_VAULT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub vault: Account<'info, VaultAccount>,
}

#[callback_accounts("init_user_position")]
#[derive(Accounts)]
pub struct InitUserPositionCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_USER_POSITION))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub user_position: Account<'info, UserPositionAccount>,
}

#[callback_accounts("deposit")]
#[derive(Accounts)]
pub struct DepositCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_DEPOSIT))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut)]
    pub user_position: Account<'info, UserPositionAccount>,
}

#[callback_accounts("reveal_pending_deposits")]
#[derive(Accounts)]
pub struct RevealPendingDepositsCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_PENDING))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    pub vault: Account<'info, VaultAccount>,
}

#[callback_accounts("record_liquidity")]
#[derive(Accounts)]
pub struct RecordLiquidityCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_RECORD_LIQUIDITY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub vault: Account<'info, VaultAccount>,
}

#[callback_accounts("compute_withdrawal")]
#[derive(Accounts)]
pub struct ComputeWithdrawalCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_WITHDRAW))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    pub vault: Account<'info, VaultAccount>,
    pub user_position: Account<'info, UserPositionAccount>,
}

#[callback_accounts("get_user_position")]
#[derive(Accounts)]
pub struct GetUserPositionCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_GET_POSITION))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
}

#[callback_accounts("clear_position")]
#[derive(Accounts)]
pub struct ClearPositionCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_CLEAR_POSITION))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: computation_account
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut)]
    pub user_position: Account<'info, UserPositionAccount>,
}

// ============================================================
// METEORA CPI ACCOUNT STRUCTURES
// ============================================================

/// Accounts for depositing liquidity to Meteora via Relay PDA
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct DepositToMeteoraDammV2<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        seeds = [b"ephemeral", vault.key().as_ref(), payer.key().as_ref()],
        bump = ephemeral_wallet.bump,
    )]
    pub ephemeral_wallet: Account<'info, EphemeralWalletAccount>,

    /// Relay PDA that owns the Meteora position
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// Relay's token A account (source)
    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub relay_token_a: UncheckedAccount<'info>,

    /// Relay's token B account (source)
    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub relay_token_b: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    pub token_a_mint: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    pub token_b_mint: UncheckedAccount<'info>,

    /// Position NFT account (proves ownership)
    /// CHECK: Validated by DAMM v2 program
    pub position_nft_account: UncheckedAccount<'info>,

    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// CHECK: Derived from DAMM v2 program seeds
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: Validated by address constraint
    #[account(address = damm_v2::ID)]
    pub amm_program: UncheckedAccount<'info>,
}

/// Accounts for withdrawing liquidity from Meteora via Relay PDA
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct WithdrawFromMeteoraDammV2<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        seeds = [b"ephemeral", vault.key().as_ref(), payer.key().as_ref()],
        bump = ephemeral_wallet.bump,
    )]
    pub ephemeral_wallet: Account<'info, EphemeralWalletAccount>,

    /// Relay PDA that owns the Meteora position
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    /// CHECK: Must match DAMM v2 pool authority
    #[account(address = damm_v2_pool_authority())]
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// Relay's token A account (receives tokens)
    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub relay_token_a: UncheckedAccount<'info>,

    /// Relay's token B account (receives tokens)
    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub relay_token_b: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    pub token_a_mint: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    pub token_b_mint: UncheckedAccount<'info>,

    /// Position NFT account (proves ownership)
    /// CHECK: Validated by DAMM v2 program
    pub position_nft_account: UncheckedAccount<'info>,

    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,

    /// CHECK: Derived from DAMM v2 program seeds
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: Validated by address constraint
    #[account(address = damm_v2::ID)]
    pub amm_program: UncheckedAccount<'info>,
}

/// Accounts for creating a Meteora position for a Relay PDA
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct CreateMeteoraPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        seeds = [b"ephemeral", vault.key().as_ref(), payer.key().as_ref()],
        bump = ephemeral_wallet.bump,
    )]
    pub ephemeral_wallet: Account<'info, EphemeralWalletAccount>,

    /// Relay PDA that will own the Meteora position and pay rent
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        mut,
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    /// Tracks relay position for this pool (enforces one per relay per pool)
    #[account(
        init,
        payer = payer,
        space = 8 + RelayPositionTracker::INIT_SPACE,
        seeds = [b"relay_position", vault.key().as_ref(), &[relay_index], pool.key().as_ref()],
        bump,
    )]
    pub relay_position_tracker: Account<'info, RelayPositionTracker>,

    /// Position NFT mint (new keypair, signer)
    /// CHECK: Will be initialized by DAMM v2 program
    #[account(mut, signer)]
    pub position_nft_mint: UncheckedAccount<'info>,

    /// Position NFT account (PDA derived from mint)
    /// CHECK: Will be initialized by DAMM v2 program
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Will be initialized by DAMM v2 program
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: Must match DAMM v2 pool authority
    #[account(address = damm_v2_pool_authority())]
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Must be Token-2022 program
    #[account(address = token_2022_program_id())]
    pub token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Derived from DAMM v2 program seeds
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: Validated by address constraint
    #[account(address = damm_v2::ID)]
    pub amm_program: UncheckedAccount<'info>,
}

/// Accounts for creating a Meteora pool via a Relay PDA
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct CreatePoolViaRelay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        seeds = [b"ephemeral", vault.key().as_ref(), payer.key().as_ref()],
        bump = ephemeral_wallet.bump,
    )]
    pub ephemeral_wallet: Account<'info, EphemeralWalletAccount>,

    /// Relay PDA that acts as payer + creator for pool initialization
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        mut,
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    /// Position NFT mint (new keypair, signer)
    /// CHECK: Will be initialized by DAMM v2 program
    #[account(mut, signer)]
    pub position_nft_mint: UncheckedAccount<'info>,

    /// Position NFT account (PDA derived from mint)
    /// CHECK: Will be initialized by DAMM v2 program
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: Pool config account validated by DAMM v2
    pub config: UncheckedAccount<'info>,

    /// CHECK: Must match DAMM v2 pool authority
    #[account(address = damm_v2_pool_authority())]
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Pool account to initialize, validated by DAMM v2
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Position account, validated by DAMM v2
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    pub token_a_mint: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    pub token_b_mint: UncheckedAccount<'info>,

    /// CHECK: Token A vault, initialized by DAMM v2
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: Token B vault, initialized by DAMM v2
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// Relay's token A account (source of initial liquidity)
    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub relay_token_a: UncheckedAccount<'info>,

    /// Relay's token B account (source of initial liquidity)
    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub relay_token_b: UncheckedAccount<'info>,

    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,

    /// CHECK: Token-2022 program
    #[account(address = token_2022_program_id())]
    pub token_2022_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Derived from DAMM v2 program seeds
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: Validated by address constraint
    #[account(address = damm_v2::ID)]
    pub amm_program: UncheckedAccount<'info>,
}

/// Accounts for creating a customizable Meteora pool via a Relay PDA.
/// Same as CreatePoolViaRelay but without `config` account — uses explicit fee parameters.
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct CreateCustomizablePoolViaRelay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        seeds = [b"ephemeral", vault.key().as_ref(), payer.key().as_ref()],
        bump = ephemeral_wallet.bump,
    )]
    pub ephemeral_wallet: Account<'info, EphemeralWalletAccount>,

    /// Relay PDA that acts as payer + creator for pool initialization
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        mut,
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    /// Position NFT mint (new keypair, signer)
    /// CHECK: Will be initialized by DAMM v2 program
    #[account(mut, signer)]
    pub position_nft_mint: UncheckedAccount<'info>,

    /// Position NFT account (PDA derived from mint)
    /// CHECK: Will be initialized by DAMM v2 program
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: Must match DAMM v2 pool authority
    #[account(address = damm_v2_pool_authority())]
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Pool account to initialize, validated by DAMM v2
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: Position account, validated by DAMM v2
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    pub token_a_mint: UncheckedAccount<'info>,

    /// CHECK: Validated by DAMM v2 program
    pub token_b_mint: UncheckedAccount<'info>,

    /// CHECK: Token A vault, initialized by DAMM v2
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: Token B vault, initialized by DAMM v2
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// Relay's token A account (source of initial liquidity)
    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub relay_token_a: UncheckedAccount<'info>,

    /// Relay's token B account (source of initial liquidity)
    /// CHECK: Validated by DAMM v2 program
    #[account(mut)]
    pub relay_token_b: UncheckedAccount<'info>,

    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,

    /// CHECK: Token-2022 program
    #[account(address = token_2022_program_id())]
    pub token_2022_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Derived from DAMM v2 program seeds
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: Validated by address constraint
    #[account(address = damm_v2::ID)]
    pub amm_program: UncheckedAccount<'info>,
}

/// Accounts for funding a relay PDA's token account
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct FundRelay<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// Relay PDA (for derivation verification only)
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    /// Authority's token account (source)
    #[account(
        mut,
        token::authority = authority,
    )]
    pub authority_token_account: Account<'info, anchor_spl::token::TokenAccount>,

    /// Relay PDA's token account (destination)
    #[account(
        mut,
        token::authority = relay_pda,
    )]
    pub relay_token_account: Account<'info, anchor_spl::token::TokenAccount>,

    pub token_program: Program<'info, anchor_spl::token::Token>,
}

/// Accounts for transferring tokens from a relay PDA to a destination
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct RelayTransferToDestination<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// Relay PDA that owns the source token account
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    /// Relay's token account (source)
    #[account(
        mut,
        token::authority = relay_pda,
    )]
    pub relay_token_account: Account<'info, anchor_spl::token::TokenAccount>,

    /// Destination token account (e.g. ephemeral wallet)
    #[account(mut)]
    pub destination_token_account: Account<'info, anchor_spl::token::TokenAccount>,

    pub token_program: Program<'info, anchor_spl::token::Token>,
}

/// Accounts for withdrawing SOL from a relay PDA back to the authority
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct WithdrawRelaySol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// Relay PDA to withdraw SOL from
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        mut,
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Accounts for closing a relay PDA's token account
#[derive(Accounts)]
#[instruction(relay_index: u8)]
pub struct CloseRelayTokenAccount<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// Relay PDA that owns the token account
    /// CHECK: Derived from vault + relay_index seeds
    #[account(
        seeds = [b"zodiac_relay", vault.key().as_ref(), &[relay_index]],
        bump,
    )]
    pub relay_pda: UncheckedAccount<'info>,

    /// Token account to close (must have zero balance)
    #[account(
        mut,
        token::authority = relay_pda,
    )]
    pub relay_token_account: Account<'info, anchor_spl::token::TokenAccount>,

    pub token_program: Program<'info, anchor_spl::token::Token>,
}


// ============================================================
// EPHEMERAL WALLET ACCOUNT CONTEXTS
// ============================================================

/// Accounts for registering an ephemeral wallet PDA
#[derive(Accounts)]
pub struct RegisterEphemeralWallet<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub vault: Account<'info, VaultAccount>,

    /// The ephemeral wallet pubkey to register
    /// CHECK: This is the wallet address being registered, not a program account
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + EphemeralWalletAccount::INIT_SPACE,
        seeds = [b"ephemeral", vault.key().as_ref(), wallet.key().as_ref()],
        bump,
    )]
    pub ephemeral_wallet: Account<'info, EphemeralWalletAccount>,

    pub system_program: Program<'info, System>,
}

/// Accounts for closing an ephemeral wallet PDA
#[derive(Accounts)]
pub struct CloseEphemeralWallet<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"vault", vault.token_mint.as_ref()],
        bump = vault.bump,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        mut,
        close = authority,
        seeds = [b"ephemeral", vault.key().as_ref(), ephemeral_wallet.wallet.as_ref()],
        bump = ephemeral_wallet.bump,
    )]
    pub ephemeral_wallet: Account<'info, EphemeralWalletAccount>,
}

// ============================================================
// EVENTS
// ============================================================

#[event]
pub struct VaultCreatedEvent {
    pub vault: Pubkey,
    pub token_mint: Pubkey,
    pub quote_mint: Pubkey,
}

#[event]
pub struct DepositEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
}

#[event]
pub struct PendingDepositsRevealedEvent {
    pub vault: Pubkey,
    pub total_pending_base: u64,
    pub total_pending_quote: u64,
}

#[event]
pub struct LiquidityRecordedEvent {
    pub vault: Pubkey,
}

#[event]
pub struct WithdrawEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub encrypted_base_amount: [u8; 32],
    pub encrypted_quote_amount: [u8; 32],
    pub nonce: u128,
}

#[event]
pub struct UserPositionEvent {
    pub encrypted_base_deposited: [u8; 32],
    pub encrypted_quote_deposited: [u8; 32],
    pub encrypted_lp_share: [u8; 32],
    pub nonce: u128,
}

#[event]
pub struct DepositedToMeteoraEvent {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub liquidity_delta: u128,
}

#[event]
pub struct WithdrawnFromMeteoraEvent {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub liquidity_delta: u128,
}

#[event]
pub struct MeteoraPositionCreatedEvent {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub pool: Pubkey,
}

#[event]
pub struct PoolCreatedViaRelayEvent {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub pool: Pubkey,
}

#[event]
pub struct CustomizablePoolCreatedViaRelayEvent {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub pool: Pubkey,
}

#[event]
pub struct RelayFundedEvent {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub amount: u64,
}

#[event]
pub struct PositionClearedEvent {
    pub vault: Pubkey,
    pub user: Pubkey,
}

#[event]
pub struct RelayTransferEvent {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RelaySolWithdrawnEvent {
    pub vault: Pubkey,
    pub relay_index: u8,
    pub lamports: u64,
}

#[event]
pub struct EphemeralWalletRegisteredEvent {
    pub vault: Pubkey,
    pub wallet: Pubkey,
}

#[event]
pub struct EphemeralWalletClosedEvent {
    pub vault: Pubkey,
    pub wallet: Pubkey,
}

// ============================================================
// ERRORS
// ============================================================

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid relay index (must be 0-11)")]
    InvalidRelayIndex,
    #[msg("Relay position already exists for this pool")]
    RelayPositionExists,
}
