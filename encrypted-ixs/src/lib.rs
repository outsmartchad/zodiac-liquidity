use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Vault state tracking aggregated deposits and liquidity.
    /// All values encrypted - only MPC can read/update.
    pub struct VaultState {
        /// Total base token deposits pending deployment (in token base units)
        pub pending_base_deposits: u64,
        /// Total quote token deposits pending deployment (in lamports for SOL)
        pub pending_quote_deposits: u64,
        /// Total liquidity received from Meteora (position.unlocked_liquidity)
        pub total_liquidity: u64,
        /// Total base deposits ever made (for pro-rata calculation)
        pub total_base_deposited: u64,
        /// Total quote deposits ever made (for pro-rata calculation)
        pub total_quote_deposited: u64,
    }

    /// Individual user's position in the vault.
    pub struct UserPosition {
        /// User's total base token deposited amount
        pub base_deposited: u64,
        /// User's total quote token deposited amount
        pub quote_deposited: u64,
        /// User's share of liquidity (calculated on withdrawal)
        pub liquidity_share: u64,
    }

    /// Deposit input from user (both base and quote tokens).
    pub struct DepositInput {
        pub base_amount: u64,
        pub quote_amount: u64,
    }

    /// Withdrawal output amounts (both base and quote tokens).
    pub struct WithdrawAmounts {
        pub base_amount: u64,
        pub quote_amount: u64,
    }

    /// Initialize vault state with zero values.
    /// Called once when creating a new vault.
    #[instruction]
    pub fn init_vault(mxe: Mxe) -> Enc<Mxe, VaultState> {
        let state = VaultState {
            pending_base_deposits: 0,
            pending_quote_deposits: 0,
            total_liquidity: 0,
            total_base_deposited: 0,
            total_quote_deposited: 0,
        };
        mxe.from_arcis(state)
    }

    /// Initialize a user position with zero values.
    /// Called when user first interacts with vault.
    #[instruction]
    pub fn init_user_position(mxe: Mxe) -> Enc<Mxe, UserPosition> {
        let position = UserPosition {
            base_deposited: 0,
            quote_deposited: 0,
            liquidity_share: 0,
        };
        mxe.from_arcis(position)
    }

    /// Process an encrypted deposit (both base and quote tokens).
    /// - Adds to user's position
    /// - Adds to vault's pending deposits
    /// - Returns updated vault state and user position
    #[instruction]
    pub fn deposit(
        deposit_input: Enc<Shared, DepositInput>,
        vault_state: Enc<Mxe, VaultState>,
        user_position: Enc<Mxe, UserPosition>,
    ) -> (Enc<Mxe, VaultState>, Enc<Mxe, UserPosition>) {
        let input = deposit_input.to_arcis();
        let mut vault = vault_state.to_arcis();
        let mut position = user_position.to_arcis();

        // Update vault totals
        vault.pending_base_deposits += input.base_amount;
        vault.pending_quote_deposits += input.quote_amount;
        vault.total_base_deposited += input.base_amount;
        vault.total_quote_deposited += input.quote_amount;

        // Update user position
        position.base_deposited += input.base_amount;
        position.quote_deposited += input.quote_amount;

        (
            vault_state.owner.from_arcis(vault),
            user_position.owner.from_arcis(position),
        )
    }

    /// Reveal total pending deposits for Meteora deployment.
    /// Only reveals the aggregate - individual deposits stay hidden.
    /// Called by protocol authority before deploying to Meteora.
    /// Returns (pending_base, pending_quote).
    #[instruction]
    pub fn reveal_pending_deposits(vault_state: Enc<Mxe, VaultState>) -> (u64, u64) {
        let vault = vault_state.to_arcis();
        (vault.pending_base_deposits.reveal(), vault.pending_quote_deposits.reveal())
    }

    /// Record liquidity received from Meteora deployment.
    /// Called after successful deployment to update vault state.
    /// - Resets pending deposits (both base and quote) to 0
    /// - Adds received liquidity to total
    #[instruction]
    pub fn record_liquidity(
        liquidity_delta: u64,  // Plaintext - from Meteora add_liquidity
        vault_state: Enc<Mxe, VaultState>,
    ) -> Enc<Mxe, VaultState> {
        let mut vault = vault_state.to_arcis();

        // Record liquidity and reset both pending fields
        vault.total_liquidity += liquidity_delta;
        vault.pending_base_deposits = 0;
        vault.pending_quote_deposits = 0;

        vault_state.owner.from_arcis(vault)
    }

    /// Reveal user's deposited amounts for withdrawal (read-only).
    /// Returns both base and quote amounts encrypted for the user.
    /// State updates happen in a separate clear_position call.
    #[instruction]
    pub fn compute_withdrawal(
        user_position: Enc<Mxe, UserPosition>,
        user_pubkey: Shared,  // To encrypt result for user
    ) -> Enc<Shared, WithdrawAmounts> {
        let position = user_position.to_arcis();
        let amounts = WithdrawAmounts {
            base_amount: position.base_deposited,
            quote_amount: position.quote_deposited,
        };
        user_pubkey.from_arcis(amounts)
    }

    /// Clear user position after withdrawal is verified off-chain.
    /// Called by the program after confirming the withdrawal.
    #[instruction]
    pub fn clear_position(
        user_position: Enc<Mxe, UserPosition>,
        base_withdraw_amount: u64,   // Plaintext base amount to deduct
        quote_withdraw_amount: u64,  // Plaintext quote amount to deduct
        vault_state: Enc<Mxe, VaultState>,
    ) -> (Enc<Mxe, UserPosition>, Enc<Mxe, VaultState>) {
        let mut position = user_position.to_arcis();
        let mut vault = vault_state.to_arcis();

        position.base_deposited -= base_withdraw_amount;
        position.quote_deposited -= quote_withdraw_amount;
        vault.total_base_deposited -= base_withdraw_amount;
        vault.total_quote_deposited -= quote_withdraw_amount;

        (
            user_position.owner.from_arcis(position),
            vault_state.owner.from_arcis(vault),
        )
    }

    /// Get user's current position (encrypted for the user).
    /// Allows user to see their deposited balance without revealing to others.
    #[instruction]
    pub fn get_user_position(
        user_position: Enc<Mxe, UserPosition>,
        user_pubkey: Shared,
    ) -> Enc<Shared, UserPosition> {
        let position = user_position.to_arcis();
        user_pubkey.from_arcis(position)
    }
}
