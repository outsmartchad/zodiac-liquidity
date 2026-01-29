use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Vault state tracking aggregated deposits and liquidity.
    /// All values encrypted - only MPC can read/update.
    pub struct VaultState {
        /// Total deposits pending deployment (in lamports or token base units)
        pub pending_deposits: u64,
        /// Total liquidity received from Meteora (position.unlocked_liquidity)
        pub total_liquidity: u64,
        /// Total deposits ever made (for pro-rata calculation)
        pub total_deposited: u64,
    }

    /// Individual user's position in the vault.
    pub struct UserPosition {
        /// User's total deposited amount
        pub deposited: u64,
        /// User's share of liquidity (calculated on withdrawal)
        pub liquidity_share: u64,
    }

    /// Deposit input from user.
    pub struct DepositInput {
        pub amount: u64,
    }

    /// Initialize vault state with zero values.
    /// Called once when creating a new vault.
    #[instruction]
    pub fn init_vault(mxe: Mxe) -> Enc<Mxe, VaultState> {
        let state = VaultState {
            pending_deposits: 0,
            total_liquidity: 0,
            total_deposited: 0,
        };
        mxe.from_arcis(state)
    }

    /// Initialize a user position with zero values.
    /// Called when user first interacts with vault.
    #[instruction]
    pub fn init_user_position(mxe: Mxe) -> Enc<Mxe, UserPosition> {
        let position = UserPosition {
            deposited: 0,
            liquidity_share: 0,
        };
        mxe.from_arcis(position)
    }

    /// Process an encrypted deposit.
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
        vault.pending_deposits += input.amount;
        vault.total_deposited += input.amount;

        // Update user position
        position.deposited += input.amount;

        (
            vault_state.owner.from_arcis(vault),
            user_position.owner.from_arcis(position),
        )
    }

    /// Reveal total pending deposits for Meteora deployment.
    /// Only reveals the aggregate - individual deposits stay hidden.
    /// Called by protocol authority before deploying to Meteora.
    #[instruction]
    pub fn reveal_pending_deposits(vault_state: Enc<Mxe, VaultState>) -> u64 {
        let vault = vault_state.to_arcis();
        vault.pending_deposits.reveal()
    }

    /// Record liquidity received from Meteora deployment.
    /// Called after successful deployment to update vault state.
    /// - Resets pending deposits to 0
    /// - Adds received liquidity to total
    #[instruction]
    pub fn record_liquidity(
        liquidity_delta: u64,  // Plaintext - from Meteora add_liquidity
        vault_state: Enc<Mxe, VaultState>,
    ) -> Enc<Mxe, VaultState> {
        let mut vault = vault_state.to_arcis();

        // Record liquidity and reset pending
        vault.total_liquidity += liquidity_delta;
        vault.pending_deposits = 0;

        vault_state.owner.from_arcis(vault)
    }

    /// Reveal user's deposited amount for withdrawal (read-only).
    /// Returns the amount encrypted for the user.
    /// State updates happen in a separate clear_position call.
    #[instruction]
    pub fn compute_withdrawal(
        user_position: Enc<Mxe, UserPosition>,
        user_pubkey: Shared,  // To encrypt result for user
    ) -> Enc<Shared, u64> {
        let position = user_position.to_arcis();
        // Return user's deposited amount, encrypted for them
        user_pubkey.from_arcis(position.deposited)
    }

    /// Clear user position after withdrawal is verified off-chain.
    /// Called by the program after confirming the withdrawal.
    #[instruction]
    pub fn clear_position(
        user_position: Enc<Mxe, UserPosition>,
        withdraw_amount: u64,  // Plaintext amount to deduct
        vault_state: Enc<Mxe, VaultState>,
    ) -> (Enc<Mxe, UserPosition>, Enc<Mxe, VaultState>) {
        let mut position = user_position.to_arcis();
        let mut vault = vault_state.to_arcis();

        position.deposited -= withdraw_amount;
        vault.total_deposited -= withdraw_amount;

        (
            user_position.owner.from_arcis(position),
            vault_state.owner.from_arcis(vault),
        )
    }

    /// Get user's current position (encrypted for the user).
    /// Allows user to see their deposited balance without revealing to others.
    /// Note: LP share calculation moved off-chain to reduce circuit complexity.
    #[instruction]
    pub fn get_user_position(
        user_position: Enc<Mxe, UserPosition>,
        user_pubkey: Shared,
    ) -> Enc<Shared, UserPosition> {
        let position = user_position.to_arcis();

        // Return user's stored position directly
        // LP share calculation done off-chain using revealed totals
        user_pubkey.from_arcis(position)
    }
}
