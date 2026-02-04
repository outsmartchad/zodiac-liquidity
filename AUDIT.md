# Zodiac Protocol — Security Audit Report

## 1. Architecture Overview

Zodiac is a privacy-focused DeFi liquidity protocol on Solana composed of two on-chain programs:

### zodiac_liquidity (Program ID: `7qpT6gRLFm1F9kHLSkHpcMPM6sbdWRNokQaqae1Zz3j2`)

A privacy-preserving liquidity provision program that combines Arcium MPC (Multi-Party Computation) for encrypted state management with Meteora DAMM v2 CPI for actual liquidity pool interactions.

**Core flow:**
1. Users deposit base + quote tokens into an encrypted vault via Arcium MPC
2. An operator batches and reveals aggregate deposits (never individual amounts)
3. A protocol-owned Relay PDA deploys aggregated liquidity to Meteora pools
4. Withdrawal amounts are computed via MPC and returned encrypted to the user's x25519 key

### zodiac_mixer (Program ID: `AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb`)

A Groth16 ZK mixer for identity unlinkability. Users deposit SOL/SPL tokens with a commitment and later withdraw to a different address using a zero-knowledge proof, breaking the on-chain link between depositor and withdrawer.

**Core flow:**
1. User deposits tokens with a Poseidon hash commitment inserted into a Merkle tree
2. User (or relayer) submits a Groth16 proof to withdraw to any address
3. Nullifier accounts prevent double-spending

### Combined Protocol Flow (13 steps)

```
Deposit:
  User wallet --(ZK proof)--> Mixer --(ZK proof via relayer)--> Ephemeral wallet
  Ephemeral wallet --(encrypted amounts)--> Zodiac vault (Arcium MPC)
  Operator reveals aggregate --> Relay PDA --> Meteora add_liquidity

Withdrawal:
  User requests --> Arcium computes share (encrypted for user)
  Relay PDA removes liquidity from Meteora --> Ephemeral wallet
  Operator clears position (Arcium MPC zeroes state)
```

## 2. MPC Trust Model

### Arcium Cerberus Protocol

Zodiac uses Arcium's **Cerberus** MPC protocol (NOT Manticore). Key trust assumptions:

| Property | Description |
|----------|-------------|
| **Confidentiality** | Individual deposit/withdrawal amounts are never revealed on-chain. Only the MPC cluster nodes see plaintext values during computation. |
| **Integrity** | Computation outputs are signed by the MPC cluster. The `verify_output()` call in each callback validates the cluster's signature against the on-chain `ClusterAccount`. |
| **Liveness** | Requires a threshold of ARX nodes to be online. If the MPC cluster is unavailable, deposits/withdrawals are blocked but funds remain safe in the vault. |
| **Collusion threshold** | Cerberus provides security against up to `t-1` colluding nodes in a `t-of-n` threshold scheme. If `t` or more nodes collude, they can learn individual deposit amounts. |

### What the MPC cluster can see

- Individual base and quote deposit amounts (during `deposit` computation)
- Individual user position balances (during `compute_withdrawal` / `get_user_position`)
- Aggregate pending deposits (during `reveal_pending_deposits`)

### What the MPC cluster CANNOT do

- Steal funds (token transfers require program PDA signatures, not MPC output)
- Forge computation outputs (outputs are cryptographically signed and verified on-chain)
- Modify on-chain state outside of callbacks (callbacks are invoked by ARX nodes but validated by the Arcium program)

### Operator Trust

The operator (vault authority) is a trusted role:

- Can call `reveal_pending_deposits`, `record_liquidity`, `clear_position`, `fund_relay`, `relay_transfer_to_destination`
- Can register/close ephemeral wallets
- Cannot access encrypted user positions without the user's x25519 key
- Cannot drain vault tokens without going through the MPC flow
- **Risk**: A malicious operator could censor transactions (refuse to batch deposits or process withdrawals) but cannot steal funds

## 3. Known Limitations and Accepted Risks

### L-01: Operator centralization (Medium)

**Description:** The vault authority is a single keypair that controls batching, relay funding, and position clearing. If the authority key is compromised, the attacker could:
- Censor deposits/withdrawals
- Redirect relay transfers to attacker-controlled accounts
- Clear positions with incorrect amounts

**Mitigation:** Migration path to Squads multisig is planned (see operator config `signerMode`). Authority actions are logged via events for auditability.

### L-02: Meteora liquidity u128 truncation (Low)

**Description:** Meteora's `Position.unlocked_liquidity` is `u128`, but `record_liquidity` takes `u64`. Very large liquidity values are capped at `u64::MAX`.

**Mitigation:** For practical pool sizes (< 18.4 exatokens), u64 is sufficient. The operator must validate liquidity deltas before recording.

### L-03: MPC cluster availability (Medium)

**Description:** If the Arcium MPC cluster goes offline, no deposits, withdrawals, or position queries can be processed. Funds are locked until the cluster recovers.

**Mitigation:** Arcium provides cluster redundancy. The `recovery_set_size` parameter (currently 4) defines the number of ARX nodes. As long as the threshold is met, operations proceed.

### L-04: Ephemeral wallet linkability window (Low)

**Description:** Between `register_ephemeral_wallet` and `close_ephemeral_wallet`, the PDA exists on-chain. An observer could correlate the registration transaction with subsequent Meteora CPI transactions if they occur in a short time window.

**Mitigation:** Per-operation ephemeral wallets are created and destroyed for each Meteora CPI. The mixer breaks the user-to-deposit link, and the relay PDA breaks the deposit-to-LP link.

### L-05: Fee-on-transfer tokens not supported (Low)

**Description:** The `deposit` instruction uses `token::transfer` with exact amounts. Fee-on-transfer tokens would result in less tokens arriving than expected, but the encrypted state would record the full amount.

**Mitigation:** Only standard SPL tokens should be used as vault base/quote tokens. Token-2022 extensions with transfer hooks are not validated.

### L-06: Mixer encrypted output size limit (Informational)

**Description:** `MAX_ENCRYPTED_OUTPUT_SIZE = 256` bytes. Outputs exceeding this are rejected. This limits the metadata that can be stored with commitments.

**Mitigation:** 256 bytes is sufficient for standard UTXO encrypted notes.

### L-07: Mixer root history finite buffer (Low)

**Description:** The Merkle tree maintains a 100-root history buffer (`root_history_size = 100`). If more than 100 state transitions occur between a user creating a proof and submitting it, the proof's root will no longer be recognized.

**Mitigation:** 100 roots provides ample time for normal usage. Users/relayers should submit proofs promptly.

### L-08: `init_if_needed` on vault and position accounts (Low)

**Description:** `CreateVault` and `CreateUserPosition` use `init_if_needed` for the vault and position accounts. This means calling `create_vault` twice with the same mint will not fail — it will re-queue the MPC computation. The callback will overwrite the vault state.

**Mitigation:** The authority should track which vaults have been initialized. Re-initialization with `init_if_needed` does not cause fund loss since the vault state is re-encrypted.

## 4. Per-Instruction Security Analysis

### zodiac_liquidity

#### `create_vault`
- **Access control:** Any signer can create a vault (authority is set to the signer). In production, this should be restricted to the protocol deployer.
- **Invariants:** Vault PDA is derived from `[b"vault", token_mint]`, ensuring one vault per base token mint. The `init_if_needed` constraint means re-calling is non-destructive but triggers a new MPC computation.
- **Token safety:** No token transfers occur — only PDA initialization and MPC queue.

#### `init_vault_callback`
- **Access control:** Called only by ARX nodes. The `#[arcium_callback]` macro validates the caller via `instructions_sysvar` and cluster signature.
- **Invariants:** `verify_output()` checks the cluster signature. If verification fails, returns `AbortedComputation`.
- **State mutation:** Updates `vault.vault_state` (encrypted) and `vault.nonce`.

#### `create_user_position`
- **Access control:** Any signer can create a position. Position PDA is derived from `[b"position", vault, user]`.
- **Invariants:** One position per user per vault enforced by PDA derivation.
- **Token safety:** No token transfers.

#### `deposit`
- **Access control:** Depositor must own the user position (`user_position.owner == depositor.key()`). Position PDA seeds include the depositor's key.
- **Invariants:** `vault.has_one = token_mint` ensures the correct mint. Quote mint validated via `vault.quote_mint`. Token account authorities validated via `token::authority = depositor` and `token::authority = vault`.
- **Token safety:** Transfers base and quote tokens from user to vault token accounts before queuing MPC. If MPC fails, tokens are already in the vault — the operator must handle reconciliation.
- **Privacy:** Encrypted amounts (`encrypted_base_amount`, `encrypted_quote_amount`) are passed to MPC. Plaintext amounts (`base_amount`, `quote_amount`) are used only for the token transfer and are visible on-chain.
- **Security note:** The plaintext transfer amounts are visible. The MPC encryption adds privacy for the cumulative position, not for individual deposits. Individual deposit amounts are observable from the token transfer instruction.

#### `reveal_pending_deposits`
- **Access control:** Authority-gated (`authority == vault.authority`).
- **Invariants:** Reads vault state via MPC. The callback emits plaintext aggregates (`total_pending_base`, `total_pending_quote`) via events — this is intentional, as the aggregate is deployed to Meteora publicly.
- **State mutation:** Vault account is passed as non-writable in the callback.

#### `record_liquidity`
- **Access control:** Authority-gated.
- **Invariants:** `liquidity_delta` is plaintext u64, passed to MPC to update the encrypted vault state.
- **Trust assumption:** The operator must provide the correct `liquidity_delta` from the Meteora `add_liquidity` return value. An incorrect value would desynchronize the encrypted state from the actual Meteora position.

#### `withdraw` (compute_withdrawal)
- **Access control:** Any user with a position can call. Position PDA seeds include the user's key.
- **Invariants:** The x25519 encryption pubkey and shared nonce are provided by the user. MPC encrypts the output for this key.
- **State mutation:** No on-chain state is modified. The callback emits encrypted withdrawal amounts via events.
- **Privacy:** Output is encrypted for the user's x25519 key. Only the user can decrypt.

#### `clear_position`
- **Access control:** Authority-gated.
- **Invariants:** Deducts `base_withdraw_amount` and `quote_withdraw_amount` from vault totals and zeros the user position.
- **Trust assumption:** The operator must provide correct withdrawal amounts. These should match the decrypted values from `compute_withdrawal`.

#### `get_user_position`
- **Access control:** Any user with a position.
- **Output:** Encrypted for the user's x25519 key. No state mutation.

#### `deposit_to_meteora_damm_v2`
- **Access control:** Requires a registered ephemeral wallet PDA (`ephemeral_wallet.bump` validation).
- **Invariants:** Relay PDA signs the Meteora CPI. `relay_index < NUM_RELAYS` (12).
- **SOL wrapping:** If token_b is WSOL and `sol_amount` is provided, SOL is wrapped via `sync_native`.
- **Delegated validation:** Pool, position, vault accounts are validated by the Meteora DAMM v2 program (not by Zodiac).

#### `withdraw_from_meteora_damm_v2`
- **Access control:** Requires registered ephemeral wallet.
- **Invariants:** Same relay PDA signing pattern. Pool authority is validated against a hardcoded address.

#### `fund_relay`
- **Access control:** Authority-gated.
- **Token safety:** Transfers from `authority_token_account` to `relay_token_account`.

#### `relay_transfer_to_destination`
- **Access control:** Authority-gated.
- **Token safety:** Relay PDA signs the transfer. Destination is an arbitrary token account.
- **Risk:** A compromised authority could direct funds to any destination.

#### `withdraw_relay_sol`
- **Access control:** Authority-gated.
- **Safety:** Transfers SOL from relay PDA to authority.

#### `close_relay_token_account`
- **Access control:** Authority-gated.
- **Safety:** Token account must have zero balance (enforced by SPL Token program).

#### `register_ephemeral_wallet`
- **Access control:** Authority-gated (implicit via `payer = authority` + vault authority check in calling context).
- **Invariants:** PDA derived from `[b"ephemeral", vault, wallet]`. Existence is the authorization check.

#### `close_ephemeral_wallet`
- **Access control:** Authority-gated.
- **Safety:** Returns rent to authority. PDA is closed via Anchor's `close` attribute.

### zodiac_mixer

#### `initialize`
- **Access control:** If `ADMIN_PUBKEY` is set, only that key can initialize. On localnet/devnet, `ADMIN_PUBKEY` is `None` (any signer can initialize).
- **Invariants:** Creates Merkle tree (height 26), tree token PDA, and global config. Default fees: 0% deposit, 0.35% withdrawal. Default deposit limit: 1000 SOL.
- **Production concern:** `ADMIN_PUBKEY` must be set for mainnet to prevent unauthorized initialization.

#### `transact` (SOL)
- **Access control:** Any signer can submit a proof. The signer does not need to be the depositor or withdrawer — this enables relayer-submitted proofs.
- **ZK verification:** Groth16 proof verified via `verify_proof()` with a hardcoded verifying key.
- **Double-spend prevention:**
  1. `nullifier0`/`nullifier1` use Anchor's `init` constraint — creating an already-existing PDA fails.
  2. `nullifier2`/`nullifier3` are `SystemAccount` — if the nullifier was used in the other position, the PDA is owned by the mixer program (not system program), causing the `SystemAccount` constraint to fail.
  3. `DuplicateNullifier` check: defense-in-depth for same nullifier in both positions within a single tx.
- **Ext data binding:** Recipient and fee recipient are bound to the proof via `ext_data_hash`. Changing them invalidates the proof.
- **Pause mechanism:** `global_config.paused` is checked at the top of the instruction.
- **Overflow protection:** `checked_add`, `checked_sub`, `checked_neg` used throughout. No silent `as u64` casts.
- **Rent protection:** Withdrawal checks that the tree token account retains rent-exempt minimum after transfer.

#### `transact_spl` (SPL tokens)
- **Same security model as `transact`** with additional SPL-specific checks:
  - `signer_token_account.owner == signer.key()`
  - `signer_token_account.mint == mint.key()`
  - `fee_recipient_ata` validated with `token::mint = mint` (boxed to avoid stack overflow)
  - `tree_ata` created via `init_if_needed` with `associated_token::authority = global_config` (PDA authority)
  - SPL withdrawals use PDA signer seeds from `global_config`

#### `toggle_pause`
- **Access control:** `has_one = authority` on `global_config`.
- **Effect:** Flips `paused` boolean. Checked by `transact` and `transact_spl`.

#### `update_global_config`
- **Access control:** `has_one = authority`.
- **Validation:** Fee rates must be <= 10000 (100%).

#### `update_deposit_limit` / `update_deposit_limit_for_spl_token`
- **Access control:** `has_one = authority` on tree account.

## 5. Account Size and PDA Summary

### zodiac_liquidity

| Account | Seeds | Size |
|---------|-------|------|
| `VaultAccount` | `[b"vault", token_mint]` | 8 + 1 + 32 + 32 + 32 + 160 + 16 = 281 bytes |
| `UserPositionAccount` | `[b"position", vault, user]` | 8 + 1 + 32 + 32 + 96 + 16 = 185 bytes |
| `RelayPositionTracker` | `[b"relay_position", vault, relay_index, pool]` | 8 + 32 + 1 + 32 + 32 + 1 = 106 bytes |
| `EphemeralWalletAccount` | `[b"ephemeral", vault, wallet]` | 8 + 1 + 32 + 32 = 73 bytes |
| Relay PDA | `[b"zodiac_relay", vault, relay_index]` | System account (no data) |

### zodiac_mixer

| Account | Seeds | Size |
|---------|-------|------|
| `MerkleTreeAccount` | `[b"merkle_tree"]` (SOL) or `[b"merkle_tree", mint]` (SPL) | 8 + 32 + 8 + 832 + 32 + 3200 + 8 + 8 + 1 + 1 + 1 + 5 = ~4136 bytes |
| `TreeTokenAccount` | `[b"tree_token"]` | 8 + 32 + 1 = 41 bytes |
| `GlobalConfig` | `[b"global_config"]` | 8 + 32 + 2 + 2 + 2 + 1 + 1 = 48 bytes |
| `NullifierAccount` | `[b"nullifier0/1", nullifier_bytes]` | 8 + 1 = 9 bytes |

## 6. External Dependencies

| Dependency | Version | Risk |
|------------|---------|------|
| `anchor-lang` | 0.32.1 | Widely audited Solana framework |
| `arcium-anchor` | 0.6.3 | Arcium MPC integration — not yet publicly audited |
| `light-hasher` (Poseidon) | - | Used for Merkle tree hashing |
| `ark-bn254` / `ark-ff` | - | Groth16 field arithmetic (well-audited arkworks library) |
| Meteora DAMM v2 | - | CPI target — validated by Meteora's own program logic |

## 7. Recommendations

1. **Set `ADMIN_PUBKEY` for mainnet** — Currently `None` for all feature flags. Must be a specific pubkey for mainnet deployment.
2. **Migrate authority to Squads multisig** — Reduces single-point-of-failure risk for the operator.
3. **Add re-initialization guard to `create_vault`** — Consider using `init` instead of `init_if_needed` to prevent accidental vault state reset.
4. **Rate-limit MPC computations** — The operator should enforce rate limits to prevent MPC cluster exhaustion.
5. **Validate `liquidity_delta` in `record_liquidity`** — Consider adding an on-chain check that the delta is non-zero and within reasonable bounds.
6. **Consider timelock on authority actions** — Critical operations like `relay_transfer_to_destination` and `clear_position` could benefit from a timelock.
7. **Audit Arcium SDK integration** — The `arcium-anchor` crate and callback verification should be reviewed by the Arcium team.
8. **SPL token allowlist for mainnet** — `ALLOW_ALL_SPL_TOKENS` is currently `true`. For mainnet, set to `false` and populate `ALLOWED_TOKENS`.
