use anchor_lang::prelude::*;
use light_hasher::Poseidon;
use anchor_lang::solana_program::sysvar::rent::Rent;
use ark_ff::PrimeField;
use ark_bn254::Fr;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer as SplTransfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb");

pub mod merkle_tree;
pub mod utils;
pub mod groth16;
pub mod errors;

use merkle_tree::MerkleTree;

const MERKLE_TREE_HEIGHT: u8 = 26;
const MAX_ENCRYPTED_OUTPUT_SIZE: usize = 256;

#[cfg(any(feature = "localnet", test))]
pub const ADMIN_PUBKEY: Option<Pubkey> = None;

#[cfg(all(feature = "devnet", not(any(feature = "localnet", test))))]
pub const ADMIN_PUBKEY: Option<Pubkey> = None; // Set to specific key for devnet

#[cfg(not(any(feature = "localnet", feature = "devnet", test)))]
pub const ADMIN_PUBKEY: Option<Pubkey> = None; // Set to specific key for mainnet

#[cfg(any(feature = "localnet", test))]
pub const ALLOW_ALL_SPL_TOKENS: bool = true;

#[cfg(not(any(feature = "localnet", test)))]
pub const ALLOW_ALL_SPL_TOKENS: bool = true; // Allow all for now

pub const ALLOWED_TOKENS: &[Pubkey] = &[];

#[program]
pub mod zodiac_mixer {
    use crate::utils::{verify_proof, VERIFYING_KEY};

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        if let Some(admin_key) = ADMIN_PUBKEY {
            require!(ctx.accounts.authority.key().eq(&admin_key), ErrorCode::Unauthorized);
        }

        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;
        tree_account.max_deposit_amount = 1_000_000_000_000; // 1000 SOL default limit
        tree_account.height = MERKLE_TREE_HEIGHT;
        tree_account.root_history_size = 100;

        MerkleTree::initialize::<Poseidon>(tree_account)?;

        let token_account = &mut ctx.accounts.tree_token_account;
        token_account.authority = ctx.accounts.authority.key();
        token_account.bump = ctx.bumps.tree_token_account;

        let global_config = &mut ctx.accounts.global_config;
        global_config.authority = ctx.accounts.authority.key();
        global_config.deposit_fee_rate = 0;     // 0% - Free deposits
        global_config.withdrawal_fee_rate = 25;  // 0.25% (25 basis points)
        global_config.fee_error_margin = 500;    // 5% (500 basis points)
        global_config.paused = false;
        global_config.bump = ctx.bumps.global_config;

        msg!("Zodiac Mixer initialized: height={}, root_history=100, deposit_limit={}",
            MERKLE_TREE_HEIGHT, tree_account.max_deposit_amount);
        Ok(())
    }

    pub fn update_deposit_limit(ctx: Context<UpdateDepositLimit>, new_limit: u64) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        tree_account.max_deposit_amount = new_limit;
        msg!("Deposit limit updated to: {} lamports", new_limit);
        Ok(())
    }

    pub fn update_global_config(
        ctx: Context<UpdateGlobalConfig>,
        deposit_fee_rate: Option<u16>,
        withdrawal_fee_rate: Option<u16>,
        fee_error_margin: Option<u16>,
    ) -> Result<()> {
        let global_config = &mut ctx.accounts.global_config;

        if let Some(deposit_rate) = deposit_fee_rate {
            require!(deposit_rate <= 10000, ErrorCode::InvalidFeeRate);
            global_config.deposit_fee_rate = deposit_rate;
        }

        if let Some(withdrawal_rate) = withdrawal_fee_rate {
            require!(withdrawal_rate <= 10000, ErrorCode::InvalidFeeRate);
            global_config.withdrawal_fee_rate = withdrawal_rate;
        }

        if let Some(margin) = fee_error_margin {
            require!(margin <= 10000, ErrorCode::InvalidFeeRate);
            global_config.fee_error_margin = margin;
        }

        Ok(())
    }

    pub fn toggle_pause(ctx: Context<TogglePause>) -> Result<()> {
        let global_config = &mut ctx.accounts.global_config;
        global_config.paused = !global_config.paused;
        msg!("Mixer paused: {}", global_config.paused);
        Ok(())
    }

    pub fn initialize_tree_account_for_spl_token(
        ctx: Context<InitializeTreeAccountForSplToken>,
        max_deposit_amount: u64,
    ) -> Result<()> {
        if let Some(admin_key) = ADMIN_PUBKEY {
            require!(ctx.accounts.authority.key().eq(&admin_key), ErrorCode::Unauthorized);
        }

        require!(
            ALLOW_ALL_SPL_TOKENS || ALLOWED_TOKENS.contains(&ctx.accounts.mint.key()),
            ErrorCode::InvalidMintAddress
        );

        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;
        tree_account.max_deposit_amount = max_deposit_amount;
        tree_account.height = MERKLE_TREE_HEIGHT;
        tree_account.root_history_size = 100;

        MerkleTree::initialize::<Poseidon>(tree_account)?;

        msg!("SPL Token merkle tree initialized for mint: {}", ctx.accounts.mint.key());
        Ok(())
    }

    pub fn update_deposit_limit_for_spl_token(
        ctx: Context<UpdateDepositLimitForSplToken>,
        new_limit: u64,
    ) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        tree_account.max_deposit_amount = new_limit;
        msg!("SPL deposit limit updated to: {} for mint: {}", new_limit, ctx.accounts.mint.key());
        Ok(())
    }

    /// Main SOL deposit/withdrawal instruction with Groth16 ZK proof verification.
    ///
    /// Reentrant attacks are not possible because nullifier creation is checked
    /// by Anchor's `init` constraint before any lamport transfers occur.
    pub fn transact(
        ctx: Context<Transact>,
        proof: Proof,
        ext_data_minified: ExtDataMinified,
        encrypted_output1: Vec<u8>,
        encrypted_output2: Vec<u8>,
    ) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        let global_config = &ctx.accounts.global_config;

        require!(!global_config.paused, ErrorCode::MixerPaused);

        // Defense-in-depth: prevent same nullifier in both input positions within a single tx.
        // The cross-check (nullifier2/nullifier3 SystemAccount) already prevents swapped-position
        // double-spend across transactions, but this catches the degenerate case within one tx.
        require!(
            proof.input_nullifiers[0] != proof.input_nullifiers[1],
            ErrorCode::DuplicateNullifier
        );

        // Validate encrypted output sizes to prevent excessive on-chain data
        require!(
            encrypted_output1.len() <= MAX_ENCRYPTED_OUTPUT_SIZE,
            ErrorCode::EncryptedOutputTooLarge
        );
        require!(
            encrypted_output2.len() <= MAX_ENCRYPTED_OUTPUT_SIZE,
            ErrorCode::EncryptedOutputTooLarge
        );

        let ext_data = ExtData::from_minified(&ctx, ext_data_minified);

        require!(
            MerkleTree::is_known_root(&tree_account, proof.root),
            ErrorCode::UnknownRoot
        );

        let calculated_ext_data_hash = utils::calculate_complete_ext_data_hash(
            ext_data.recipient,
            ext_data.ext_amount,
            &encrypted_output1,
            &encrypted_output2,
            ext_data.fee,
            ext_data.fee_recipient,
            ext_data.mint_address,
        )?;

        // Endianness note: `calculated_ext_data_hash` is produced by SHA-256 on-chain (LE convention),
        // while `proof.ext_data_hash` comes from the ZK circuit which uses BE (circom's bits2num).
        // `from_le_bytes_mod_order` and `from_be_bytes_mod_order` normalize both to the same field element.
        require!(
            Fr::from_le_bytes_mod_order(&calculated_ext_data_hash) == Fr::from_be_bytes_mod_order(&proof.ext_data_hash),
            ErrorCode::ExtDataHashMismatch
        );

        require!(
            utils::check_public_amount(ext_data.ext_amount, ext_data.fee, proof.public_amount),
            ErrorCode::InvalidPublicAmountData
        );

        let ext_amount = ext_data.ext_amount;
        let fee = ext_data.fee;

        utils::validate_fee(
            ext_amount,
            fee,
            global_config.deposit_fee_rate,
            global_config.withdrawal_fee_rate,
            global_config.fee_error_margin,
        )?;

        require!(verify_proof(proof.clone(), VERIFYING_KEY), ErrorCode::InvalidProof);

        let tree_token_account_info = ctx.accounts.tree_token_account.to_account_info();
        let rent = Rent::get()?;
        let rent_exempt_minimum = rent.minimum_balance(tree_token_account_info.data_len());

        if ext_amount > 0 {
            let deposit_amount = ext_amount as u64;
            require!(
                deposit_amount <= tree_account.max_deposit_amount,
                ErrorCode::DepositLimitExceeded
            );

            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.signer.to_account_info(),
                        to: ctx.accounts.tree_token_account.to_account_info(),
                    },
                ),
                ext_amount as u64,
            )?;
        } else if ext_amount < 0 {
            let recipient_account_info = ctx.accounts.recipient.to_account_info();

            let ext_amount_abs: u64 = ext_amount.checked_neg()
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .try_into()
                .map_err(|_| ErrorCode::InvalidExtAmount)?;

            let total_required = ext_amount_abs
                .checked_add(fee)
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .checked_add(rent_exempt_minimum)
                .ok_or(ErrorCode::ArithmeticOverflow)?;

            require!(
                tree_token_account_info.lamports() >= total_required,
                ErrorCode::InsufficientFundsForWithdrawal
            );

            let tree_token_balance = tree_token_account_info.lamports();
            let recipient_balance = recipient_account_info.lamports();

            let new_tree_token_balance = tree_token_balance.checked_sub(ext_amount_abs)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            let new_recipient_balance = recipient_balance.checked_add(ext_amount_abs)
                .ok_or(ErrorCode::ArithmeticOverflow)?;

            **tree_token_account_info.try_borrow_mut_lamports()? = new_tree_token_balance;
            **recipient_account_info.try_borrow_mut_lamports()? = new_recipient_balance;
        }

        if fee > 0 {
            let fee_recipient_account_info = ctx.accounts.fee_recipient_account.to_account_info();

            if ext_amount >= 0 {
                let total_required = fee
                    .checked_add(rent_exempt_minimum)
                    .ok_or(ErrorCode::ArithmeticOverflow)?;

                require!(
                    tree_token_account_info.lamports() >= total_required,
                    ErrorCode::InsufficientFundsForFee
                );
            }

            let tree_token_balance = tree_token_account_info.lamports();
            let fee_recipient_balance = fee_recipient_account_info.lamports();

            let new_tree_token_balance = tree_token_balance.checked_sub(fee)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            let new_fee_recipient_balance = fee_recipient_balance.checked_add(fee)
                .ok_or(ErrorCode::ArithmeticOverflow)?;

            **tree_token_account_info.try_borrow_mut_lamports()? = new_tree_token_balance;
            **fee_recipient_account_info.try_borrow_mut_lamports()? = new_fee_recipient_balance;
        }

        let next_index_to_insert = tree_account.next_index;
        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account)?;
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account)?;

        let second_index = next_index_to_insert.checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(CommitmentData {
            index: next_index_to_insert,
            commitment: proof.output_commitments[0],
            encrypted_output: encrypted_output1.to_vec(),
        });

        emit!(CommitmentData {
            index: second_index,
            commitment: proof.output_commitments[1],
            encrypted_output: encrypted_output2.to_vec(),
        });

        Ok(())
    }

    /// SPL token deposit/withdrawal with Groth16 ZK proof verification.
    ///
    /// Reentrant attacks are not possible because nullifier creation is checked
    /// by Anchor's `init` constraint before any token transfers occur.
    pub fn transact_spl(
        ctx: Context<TransactSpl>,
        proof: Proof,
        ext_data_minified: ExtDataMinified,
        encrypted_output1: Vec<u8>,
        encrypted_output2: Vec<u8>,
    ) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        let global_config = &ctx.accounts.global_config;

        require!(!global_config.paused, ErrorCode::MixerPaused);

        require!(
            proof.input_nullifiers[0] != proof.input_nullifiers[1],
            ErrorCode::DuplicateNullifier
        );

        require!(
            encrypted_output1.len() <= MAX_ENCRYPTED_OUTPUT_SIZE,
            ErrorCode::EncryptedOutputTooLarge
        );
        require!(
            encrypted_output2.len() <= MAX_ENCRYPTED_OUTPUT_SIZE,
            ErrorCode::EncryptedOutputTooLarge
        );

        require!(
            ctx.accounts.signer_token_account.owner == ctx.accounts.signer.key(),
            ErrorCode::InvalidTokenAccount
        );
        require!(
            ctx.accounts.signer_token_account.mint == ctx.accounts.mint.key(),
            ErrorCode::InvalidTokenAccountMintAddress
        );

        let ext_data = ExtData::from_minified_spl(&ctx, ext_data_minified);

        require!(
            MerkleTree::is_known_root(&tree_account, proof.root),
            ErrorCode::UnknownRoot
        );

        require!(
            ALLOW_ALL_SPL_TOKENS || ALLOWED_TOKENS.contains(&ext_data.mint_address),
            ErrorCode::InvalidMintAddress
        );

        let calculated_ext_data_hash = utils::calculate_complete_ext_data_hash(
            ext_data.recipient,
            ext_data.ext_amount,
            &encrypted_output1,
            &encrypted_output2,
            ext_data.fee,
            ext_data.fee_recipient,
            ext_data.mint_address,
        )?;

        // Endianness note: see transact() for explanation of LE vs BE conversion.
        require!(
            Fr::from_le_bytes_mod_order(&calculated_ext_data_hash) == Fr::from_be_bytes_mod_order(&proof.ext_data_hash),
            ErrorCode::ExtDataHashMismatch
        );

        require!(
            utils::check_public_amount(ext_data.ext_amount, ext_data.fee, proof.public_amount),
            ErrorCode::InvalidPublicAmountData
        );

        let ext_amount = ext_data.ext_amount;
        let fee = ext_data.fee;

        utils::validate_fee(
            ext_amount,
            fee,
            global_config.deposit_fee_rate,
            global_config.withdrawal_fee_rate,
            global_config.fee_error_margin,
        )?;

        require!(verify_proof(proof.clone(), VERIFYING_KEY), ErrorCode::InvalidProof);

        if ext_amount > 0 {
            let deposit_amount = ext_amount as u64;
            require!(
                deposit_amount <= tree_account.max_deposit_amount,
                ErrorCode::DepositLimitExceeded
            );

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: ctx.accounts.signer_token_account.to_account_info(),
                        to: ctx.accounts.tree_ata.to_account_info(),
                        authority: ctx.accounts.signer.to_account_info(),
                    },
                ),
                ext_amount as u64,
            )?;
        } else if ext_amount < 0 {
            let ext_amount_abs: u64 = ext_amount.checked_neg()
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .try_into()
                .map_err(|_| ErrorCode::InvalidExtAmount)?;

            let bump = &[ctx.accounts.global_config.bump];
            let seeds: &[&[u8]] = &[b"global_config", bump];
            let signer_seeds = &[seeds];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: ctx.accounts.tree_ata.to_account_info(),
                        to: ctx.accounts.recipient_token_account.to_account_info(),
                        authority: ctx.accounts.global_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                ext_amount_abs,
            )?;
        }

        if fee > 0 {
            let bump = &[ctx.accounts.global_config.bump];
            let seeds: &[&[u8]] = &[b"global_config", bump];
            let signer_seeds = &[seeds];

            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: ctx.accounts.tree_ata.to_account_info(),
                        to: ctx.accounts.fee_recipient_ata.to_account_info(),
                        authority: ctx.accounts.global_config.to_account_info(),
                    },
                    signer_seeds,
                ),
                fee,
            )?;
        }

        let next_index_to_insert = tree_account.next_index;
        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account)?;
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account)?;

        let second_index = next_index_to_insert.checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(SplCommitmentData {
            index: next_index_to_insert,
            mint_address: ext_data.mint_address,
            commitment: proof.output_commitments[0],
            encrypted_output: encrypted_output1.to_vec(),
        });

        emit!(SplCommitmentData {
            index: second_index,
            mint_address: ext_data.mint_address,
            commitment: proof.output_commitments[1],
            encrypted_output: encrypted_output2.to_vec(),
        });

        Ok(())
    }
}

// ============================================================
// DATA STRUCTURES
// ============================================================

#[event]
pub struct CommitmentData {
    pub index: u64,
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
}

#[event]
pub struct SplCommitmentData {
    pub index: u64,
    pub mint_address: Pubkey,
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtData {
    pub recipient: Pubkey,
    pub ext_amount: i64,
    pub fee: u64,
    pub fee_recipient: Pubkey,
    pub mint_address: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtDataMinified {
    pub ext_amount: i64,
    pub fee: u64,
}

impl ExtData {
    fn from_minified(ctx: &Context<Transact>, minified: ExtDataMinified) -> Self {
        Self {
            recipient: ctx.accounts.recipient.key(),
            ext_amount: minified.ext_amount,
            fee: minified.fee,
            fee_recipient: ctx.accounts.fee_recipient_account.key(),
            mint_address: utils::SOL_ADDRESS,
        }
    }

    fn from_minified_spl(ctx: &Context<TransactSpl>, minified: ExtDataMinified) -> Self {
        Self {
            recipient: ctx.accounts.recipient_token_account.key(),
            ext_amount: minified.ext_amount,
            fee: minified.fee,
            fee_recipient: ctx.accounts.fee_recipient_ata.key(),
            mint_address: ctx.accounts.mint.key(),
        }
    }
}

// ============================================================
// ACCOUNT CONTEXTS
// ============================================================

#[derive(Accounts)]
#[instruction(proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>)]
pub struct Transact<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree"],
        bump = tree_account.load()?.bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    /// Nullifier account to mark the first input as spent.
    /// Using `init` (not `init_if_needed`) ensures the tx fails automatically with a
    /// system program error if this nullifier was already used (account already exists).
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<NullifierAccount>(),
        seeds = [b"nullifier0", proof.input_nullifiers[0].as_ref()],
        bump
    )]
    pub nullifier0: Account<'info, NullifierAccount>,

    /// Nullifier account to mark the second input as spent.
    /// Same `init` guarantee as nullifier0.
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<NullifierAccount>(),
        seeds = [b"nullifier1", proof.input_nullifiers[1].as_ref()],
        bump
    )]
    pub nullifier1: Account<'info, NullifierAccount>,

    /// Cross-check: seeds use nullifier0 prefix with input[1]'s value.
    /// If input[1] was previously spent in position 0, this PDA was already `init`'d as a
    /// NullifierAccount (owned by the mixer program). The `SystemAccount` constraint requires
    /// `owner == system_program::ID`, which fails → prevents swapped-position double-spend.
    #[account(
        seeds = [b"nullifier0", proof.input_nullifiers[1].as_ref()],
        bump
    )]
    pub nullifier2: SystemAccount<'info>,

    /// Cross-check: seeds use nullifier1 prefix with input[0]'s value.
    /// Mirror of nullifier2 — prevents the reverse swap.
    #[account(
        seeds = [b"nullifier1", proof.input_nullifiers[0].as_ref()],
        bump
    )]
    pub nullifier3: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"tree_token"],
        bump = tree_token_account.bump
    )]
    pub tree_token_account: Account<'info, TreeTokenAccount>,

    #[account(
        seeds = [b"global_config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// CHECK: user should be able to send funds to any types of accounts.
    /// The recipient is bound to the proof via ext_data_hash — changing it invalidates the proof.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: user should be able to send fees to any types of accounts.
    /// The fee recipient is bound to the proof via ext_data_hash.
    #[account(mut)]
    pub fee_recipient_account: UncheckedAccount<'info>,

    /// The account signing the transaction. Can be the user or a relayer.
    /// The signer is NOT bound to the proof — anyone can submit a valid proof on behalf of the user.
    #[account(mut)]
    pub signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>)]
pub struct TransactSpl<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree", mint.key().as_ref()],
        bump = tree_account.load()?.bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    /// See Transact::nullifier0 for documentation on the cross-check pattern.
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<NullifierAccount>(),
        seeds = [b"nullifier0", proof.input_nullifiers[0].as_ref()],
        bump
    )]
    pub nullifier0: Account<'info, NullifierAccount>,

    /// See Transact::nullifier1.
    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<NullifierAccount>(),
        seeds = [b"nullifier1", proof.input_nullifiers[1].as_ref()],
        bump
    )]
    pub nullifier1: Account<'info, NullifierAccount>,

    /// Cross-check: prevents swapped-position double-spend. See Transact::nullifier2.
    #[account(
        seeds = [b"nullifier0", proof.input_nullifiers[1].as_ref()],
        bump
    )]
    pub nullifier2: SystemAccount<'info>,

    /// Cross-check: mirror of nullifier2. See Transact::nullifier3.
    #[account(
        seeds = [b"nullifier1", proof.input_nullifiers[0].as_ref()],
        bump
    )]
    pub nullifier3: SystemAccount<'info>,

    #[account(
        seeds = [b"global_config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    /// The account signing the transaction. Can be the user or a relayer.
    #[account(mut)]
    pub signer: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub signer_token_account: Account<'info, TokenAccount>,

    /// CHECK: user should be able to send funds to any types of accounts.
    /// The recipient is bound to the proof via ext_data_hash.
    pub recipient: UncheckedAccount<'info>,

    /// Recipient's token account (destination for withdrawals).
    /// It's the relayer's job to account for the rent of this account to prevent
    /// rent griefing attacks. Relayer adds an instruction to init the account.
    #[account(
        mut,
        token::mint = mint,
        token::authority = recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// Tree's associated token account (destination for deposits, source for withdrawals).
    /// Created automatically if it doesn't exist via `init_if_needed`.
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = mint,
        associated_token::authority = global_config
    )]
    pub tree_ata: Account<'info, TokenAccount>,

    /// Fee recipient's token account. Validated to match the correct mint.
    /// Boxed to reduce stack frame size in `try_accounts`.
    #[account(
        mut,
        token::mint = mint
    )]
    pub fee_recipient_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<MerkleTreeAccount>(),
        seeds = [b"merkle_tree"],
        bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<TreeTokenAccount>(),
        seeds = [b"tree_token"],
        bump
    )]
    pub tree_token_account: Account<'info, TreeTokenAccount>,

    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<GlobalConfig>(),
        seeds = [b"global_config"],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateDepositLimit<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree"],
        bump = tree_account.load()?.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateGlobalConfig<'info> {
    #[account(
        mut,
        seeds = [b"global_config"],
        bump = global_config.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct TogglePause<'info> {
    #[account(
        mut,
        seeds = [b"global_config"],
        bump = global_config.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeTreeAccountForSplToken<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<MerkleTreeAccount>(),
        seeds = [b"merkle_tree", mint.key().as_ref()],
        bump
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"global_config"],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateDepositLimitForSplToken<'info> {
    #[account(
        mut,
        seeds = [b"merkle_tree", mint.key().as_ref()],
        bump = tree_account.load()?.bump,
        has_one = authority @ ErrorCode::Unauthorized
    )]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    pub mint: Account<'info, Mint>,

    pub authority: Signer<'info>,
}

// ============================================================
// ACCOUNT TYPES
// ============================================================

#[account]
pub struct TreeTokenAccount {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
pub struct GlobalConfig {
    pub authority: Pubkey,
    pub deposit_fee_rate: u16,
    pub withdrawal_fee_rate: u16,
    pub fee_error_margin: u16,
    pub paused: bool,
    pub bump: u8,
}

/// This account's existence indicates that the nullifier has been used.
/// No data fields needed other than bump for PDA verification.
/// The `init` constraint in Transact/TransactSpl prevents re-creation.
#[account]
pub struct NullifierAccount {
    pub bump: u8,
}

#[account(zero_copy)]
pub struct MerkleTreeAccount {
    pub authority: Pubkey,
    pub next_index: u64,
    pub subtrees: [[u8; 32]; MERKLE_TREE_HEIGHT as usize],
    pub root: [u8; 32],
    pub root_history: [[u8; 32]; 100],
    pub root_index: u64,
    pub max_deposit_amount: u64,
    pub height: u8,
    pub root_history_size: u8,
    pub bump: u8,
    /// Padding required by `#[account(zero_copy)]` for 8-byte alignment.
    pub _padding: [u8; 5],
}

// ============================================================
// ERRORS
// ============================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Not authorized to perform this action")]
    Unauthorized,
    #[msg("External data hash does not match the one in the proof")]
    ExtDataHashMismatch,
    #[msg("Root is not known in the tree")]
    UnknownRoot,
    #[msg("Public amount is invalid")]
    InvalidPublicAmountData,
    #[msg("Insufficient funds for withdrawal")]
    InsufficientFundsForWithdrawal,
    #[msg("Insufficient funds for fee")]
    InsufficientFundsForFee,
    #[msg("Proof is invalid")]
    InvalidProof,
    #[msg("Invalid fee")]
    InvalidFee,
    #[msg("Invalid ext amount")]
    InvalidExtAmount,
    #[msg("Public amount calculation overflow/underflow")]
    PublicAmountCalculationError,
    #[msg("Arithmetic overflow/underflow")]
    ArithmeticOverflow,
    #[msg("Deposit limit exceeded")]
    DepositLimitExceeded,
    #[msg("Invalid fee rate: must be 0-10000 basis points")]
    InvalidFeeRate,
    #[msg("Invalid fee recipient")]
    InvalidFeeRecipient,
    #[msg("Fee amount below minimum required")]
    InvalidFeeAmount,
    #[msg("Recipient mismatch")]
    RecipientMismatch,
    #[msg("Merkle tree is full")]
    MerkleTreeFull,
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    #[msg("Invalid mint address")]
    InvalidMintAddress,
    #[msg("Invalid token account mint address")]
    InvalidTokenAccountMintAddress,
    #[msg("Duplicate nullifier in both input positions")]
    DuplicateNullifier,
    #[msg("Encrypted output exceeds maximum allowed size")]
    EncryptedOutputTooLarge,
    #[msg("Mixer is paused")]
    MixerPaused,
}
