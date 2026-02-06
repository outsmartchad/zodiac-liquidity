# Zodiac On-Chain Programs — Integration Reference

> For Claude Code agents integrating the on-chain programs into the app, operator, or relayer.
> Last updated: 2026-02-06

## Program IDs (Devnet)

| Program | Address |
|---------|---------|
| **zodiac_mixer** | `AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb` |
| **zodiac_liquidity** | `4xNVpFyVTdsFPJ1UoZy9922xh2tDs1URMuujkfYYhHv5` |
| **Meteora DAMM v2** | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |

## Test Status

135/135 devnet tests passing (2026-02-06):
- `zodiac-liquidity.ts` — 20 happy-path tests (14 legacy + 6 authority-first)
- `zodiac-liquidity-fail.ts` — 10 auth/fail tests (4 legacy + 6 authority-first)
- `zodiac-mpc-meteora-integration.ts` — 37 integration tests (3-user sequential, authority-first)
- `zodiac-mixer.ts` — 25 mixer tests (17 SOL + 8 SPL)
- `zodiac-full-privacy-integration.ts` — 39 full privacy tests (mixer + MPC + Meteora, authority-first)
- `zodiac-swap.ts` — 4 swap tests (SOL→ZDC, ZDC→SOL, slippage protection, unauthorized rejection)

## What Each Program Does

**zodiac_mixer** — ZK privacy mixer. Users deposit SOL/SPL tokens with a Groth16 ZK proof. Later, they (or a relayer) withdraw to a different wallet using another ZK proof. The mixer breaks the link between depositor and withdrawer. Uses a Merkle tree (height 26) and nullifiers for double-spend prevention.

**zodiac_liquidity** — Private liquidity vault. Takes funds from mixer withdrawals, encrypts amounts via Arcium MPC, deploys to Meteora DAMM v2 pools through a relay PDA. Individual deposit sizes stay hidden. Supports two flows: legacy (user signs, ephemeral wallets) and authority-first (authority signs on behalf of users identified by `user_id_hash`).

## The Single-Sign Privacy Flow

This is the full deposit-to-withdrawal lifecycle. The user signs 1-2 wallet txs, then the operator handles everything else.

```
WHO DOES WHAT:
  [app]       = User's browser (wallet signs)
  [operator]  = Operator service (:3001)
  [relayer]   = Relayer service (:3002) — called by operator, not app
  [mpc]       = Arcium ARX nodes (automatic callbacks)

DEPOSIT (Steps 1-13, authority-first flow):
  1. [app]       → mixer.transact(proof)                        Deposit base SPL to mixer (wallet signs)
  2. [app]       → mixer.transact(proof)                        Deposit quote SOL to mixer (wallet signs)
  3. [app]       → operator POST /deposit/private                Send commitment secrets to operator
  4. [operator]  — waits for privacy delay                       Anonymity set growth
  5. [operator]  → generates ZK proofs (snarkjs)                 Server-side Groth16 proof generation
  6. [operator]  → relayer POST /relay/withdraw                  Withdraw base + quote from mixer to authority
  7. [authority] → liquidity.create_user_position_by_authority()  Create position (user_id_hash PDA)
  8. [authority] → liquidity.deposit_by_authority(encrypted_amt)  Deposit from authority's token accounts
  9. [mpc]       → liquidity.deposit_callback()                  MPC updates vault + position
 10. [authority] → liquidity.reveal_pending()                    MPC reveals aggregate amounts
 11. [authority] → liquidity.fund_relay(amount)                  Move tokens to relay PDA
 12. [authority] → liquidity.deposit_to_meteora()                Authority signs Meteora add_liquidity
 13. [authority] → liquidity.record_liquidity(delta)             MPC records liquidity share

WITHDRAWAL (Steps 14-17, authority-first flow):
 14. [authority] → liquidity.compute_withdrawal_by_authority()   MPC computes user's share
 15. [authority] → liquidity.withdraw_from_meteora()             Authority signs Meteora remove_liquidity
 16. [authority] → liquidity.relay_transfer_to_dest()            Move tokens to destination wallet
 17. [authority] → liquidity.clear_position()                    Zero out MPC state

SWAP (Steps 18-23, privacy swap flow — no MPC needed):
 18. [app]       → mixer.transact(proof)                        Deposit input token to mixer (wallet signs)
 19. [app]       → operator POST /swap/request                  Send commitment secret to operator
 20. [operator]  — waits for privacy delay                       Anonymity set growth
 21. [operator]  → relayer POST /relay/withdraw                  Withdraw input from mixer to authority
 22. [authority] → liquidity.fund_relay(amount)                  Move input token to relay PDA
 23. [authority] → liquidity.swap_via_relay(amount, min_out)     Relay PDA signs Meteora swap CPI
 24. [authority] → liquidity.relay_transfer_to_dest()            Move output token to destination wallet
```

## Mixer Instructions (zodiac_mixer)

The app calls deposit instructions directly (wallet signs). The operator generates ZK proofs and calls the relayer for withdrawals. The relayer calls `transact`/`transact_spl` for the actual on-chain withdrawal tx.

| Instruction | Who Calls | Purpose |
|-------------|-----------|---------|
| `initialize` | Authority (one-time) | Create SOL Merkle tree + global config |
| `initialize_tree_account_for_spl_token` | Anyone | Create SPL Merkle tree for a given mint |
| `transact` | App (deposit) / Relayer (withdraw) | SOL deposit or withdrawal with ZK proof |
| `transact_spl` | App (deposit) / Relayer (withdraw) | SPL deposit or withdrawal with ZK proof |
| `update_deposit_limit` | Authority | Set max SOL deposit amount |
| `update_deposit_limit_for_spl_token` | Authority | Set max SPL deposit amount |
| `update_global_config` | Authority | Update fee rates and error margin |
| `toggle_pause` | Authority | Pause/unpause the mixer |

### Mixer PDA Seeds

| Account | Seeds | Purpose |
|---------|-------|---------|
| `MerkleTreeAccount` | `["merkle_tree"]` (SOL) or `["merkle_tree", mint]` (SPL) | Merkle tree state |
| `TreeTokenAccount` | `["tree_token"]` | SOL pool PDA |
| `GlobalConfig` | `["global_config"]` | Fee config + pause state |
| `NullifierAccount` | `["nullifier0", hash]` or `["nullifier1", hash]` | Double-spend prevention |

### Mixer On-Chain Tree Layout

`MerkleTreeAccount` byte offsets (for reading subtrees/roots directly):
```
discriminator:  8 bytes  @ offset 0
authority:     32 bytes  @ offset 8
next_index:     8 bytes  @ offset 40
subtrees:     832 bytes  @ offset 48   (26 × 32-byte hashes)
root:          32 bytes  @ offset 880
root_history: 3200 bytes @ offset 912  (100 × 32-byte roots)
root_index:     8 bytes  @ offset 4112
```

### Mixer Fee Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `deposit_fee_rate` | 0 (0%) | Basis points on deposits |
| `withdrawal_fee_rate` | 25 (0.25%) | Basis points on withdrawals |
| `fee_error_margin` | 500 (5%) | Tolerance for fee amount |

## Liquidity Instructions (zodiac_liquidity)

The operator calls these. The app never calls these directly.

### MPC Operations (operator queues, ARX nodes call callbacks)

| Queue Instruction | Callback | Purpose |
|-------------------|----------|---------|
| `create_vault` | `init_vault_callback` | Initialize encrypted vault state |
| `create_user_position` | `init_user_position_callback` | Initialize user's encrypted position (user signs, PDA from user pubkey) |
| `create_user_position_by_authority` | `init_user_position_callback` | Initialize position (authority signs, PDA from `user_id_hash`) |
| `deposit` | `deposit_callback` | Encrypt dual-token deposit (user signs) |
| `deposit_by_authority` | `deposit_callback` | Encrypt dual-token deposit (authority signs, authority's token accounts) |
| `reveal_pending_deposits` | `reveal_pending_deposits_callback` | Reveal aggregate for Meteora deployment |
| `record_liquidity` | `record_liquidity_callback` | Record Meteora liquidity in MPC state |
| `withdraw` | `compute_withdrawal_callback` | Compute user's withdrawal share (user signs) |
| `compute_withdrawal_by_authority` | `compute_withdrawal_callback` | Compute withdrawal share (authority signs, PDA from `user_id_hash`) |
| `clear_position` | `clear_position_callback` | Zero position after withdrawal |
| `get_user_position` | `get_user_position_callback` | Let user see their own position (user signs, PDA from user pubkey) |

### Authority-First vs Legacy Position PDA

| Flow | Position PDA Seeds | Who Signs | Position `owner` Field |
|------|--------------------|-----------|------------------------|
| Legacy | `[b"position", vault, user_pubkey]` | User wallet | User's pubkey |
| Authority-first | `[b"position", vault, sha256(userId)]` | Authority | `Pubkey::new_from_array(user_id_hash)` |

**Note:** `get_user_position` only works with legacy positions (requires signer whose pubkey matches PDA seed). For authority-first positions, read the account directly via `program.account.userPositionAccount.fetch(positionPda)`.

### Relay Management (operator calls)

| Instruction | Purpose |
|-------------|---------|
| `fund_relay` | Transfer tokens to relay PDA's token account |
| `relay_transfer_to_destination` | Transfer from relay to destination wallet |
| `withdraw_relay_sol` | Reclaim SOL from relay PDA |
| `close_relay_token_account` | Close relay token account, reclaim rent |

### Ephemeral Wallet Management (operator calls)

| Instruction | Purpose |
|-------------|---------|
| `register_ephemeral_wallet` | Register ephemeral wallet PDA (authority only) |
| `close_ephemeral_wallet` | Close PDA, return rent to authority |

### Meteora CPI (authority signs directly, enforces `vault.authority == payer`)

| Instruction | Purpose |
|-------------|---------|
| `create_pool_via_relay` | Create Meteora pool via relay PDA |
| `create_customizable_pool_via_relay` | Create customizable Meteora pool |
| `create_meteora_position` | Create Meteora position for relay PDA |
| `deposit_to_meteora_damm_v2` | Add liquidity to Meteora pool |
| `withdraw_from_meteora_damm_v2` | Remove liquidity from Meteora pool |
| `swap_via_relay` | Swap tokens via Meteora pool (relay PDA signs CPI) |

**Note:** Meteora CPI instructions no longer require ephemeral wallet registration. The `payer` must be the vault authority. Old ephemeral wallet instructions (`register_ephemeral_wallet`, `close_ephemeral_wallet`) still exist for backward compatibility.

### swap_via_relay Details

Executes a token swap through Meteora DAMM v2 using the relay PDA as the signer. No MPC needed — swap is stateless (no encrypted balance to maintain). Privacy comes from the mixer + relay PDA pattern.

**Parameters:**
- `relay_index: u8` — Which relay PDA to use (typically 0)
- `amount_in: u64` — Amount of input token to swap
- `minimum_amount_out: u64` — Minimum output (slippage protection, Meteora reverts if not met)

**Accounts (SwapViaRelay):**
- `payer` — Authority (must match `vault.authority`)
- `vault` — VaultAccount PDA
- `relay_pda` — Relay PDA (signs the Meteora swap CPI)
- `pool_authority` — Meteora pool authority
- `pool` — Meteora pool account
- `input_token_account` — Relay's input token account
- `output_token_account` — Relay's output token account
- `token_a_vault`, `token_b_vault` — Meteora pool token vaults
- `token_a_mint`, `token_b_mint` — Token mints
- `token_a_program`, `token_b_program` — Token programs
- `event_authority` — Meteora event authority PDA
- `amm_program` — Meteora DAMM v2 program ID

**Swap direction** is determined by which relay token account is passed as `input_token_account` vs `output_token_account`. To swap SOL→ZDC, pass WSOL account as input and ZDC account as output. To swap ZDC→SOL, reverse them.

## Encrypted State (what Arcium MPC stores)

**VaultState** (5 encrypted u64 values):
| Field | Meaning |
|-------|---------|
| `pending_base_deposits` | Base tokens awaiting Meteora deployment |
| `pending_quote_deposits` | Quote tokens (WSOL) awaiting deployment |
| `total_liquidity` | Liquidity delta from Meteora |
| `total_base_deposited` | Cumulative base deposits (for pro-rata) |
| `total_quote_deposited` | Cumulative quote deposits (for pro-rata) |

**UserPosition** (3 encrypted u64 values):
| Field | Meaning |
|-------|---------|
| `base_deposited` | User's total base token deposit |
| `quote_deposited` | User's total quote token deposit |
| `liquidity_share` | User's share of Meteora liquidity |

## Critical Crypto Rules (for app development)

These are the rules that caused bugs. Follow them exactly.

1. **ExtDataHash is LE.** On-chain uses `Fr::from_le_bytes_mod_order` for SHA-256 hash. Pass raw bytes (not BN strings) to the circuit. snarkjs interprets `Uint8Array` as LE.

2. **PublicAmount formula.** `extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE)` — the `add(FIELD_SIZE)` handles negative values for withdrawals.

3. **Withdrawal extAmount.** Must be `fee - amount` (NOT just `-amount`). Circuit constraint: `sumIns + publicAmount === sumOuts`.

4. **Merkle pair insertion.** On-chain `transact` inserts BOTH output commitments per tx. When computing withdrawal paths, simulate `insertPair` (insert both outputs), not single insert. The root is recorded after both leaves.

5. **SPL tree init is permissionless.** Anyone can call `initialize_tree_account_for_spl_token` if the tree doesn't exist yet. The app should auto-init if needed.

## How to Build and Test

All builds and tests run inside the Docker container. Always use `arcium` CLI.

```bash
# Build
docker exec zodiac-dev bash -c "cd /app && arcium build"

# Test on devnet
docker exec zodiac-dev bash -c "cd /app && arcium test --cluster devnet --skip-build"

# Test on localnet (starts validator + ARX nodes)
docker exec zodiac-dev bash -c "cd /app && arcium test"

# Deploy to devnet (program + MXE init)
docker exec zodiac-dev bash -c "cd /app && arcium deploy \
  --cluster-offset 456 --recovery-set-size 4 \
  --keypair-path /root/.config/solana/id.json \
  --rpc-url devnet \
  --program-keypair /app/target/deploy/zodiac_liquidity-keypair.json \
  --program-name zodiac_liquidity"
```

Never use `anchor build`, `cargo build`, or `solana program deploy` directly.

## Key Files

| File | What It Contains |
|------|------------------|
| `programs/zodiac_liquidity/src/lib.rs` | Liquidity program (Arcium MPC + Meteora CPI) |
| `programs/zodiac_mixer/src/lib.rs` | Mixer program (Groth16 + Merkle tree) |
| `programs/zodiac_mixer/src/utils.rs` | Proof verification, fee validation, ext_data_hash |
| `encrypted-ixs/src/lib.rs` | Arcis MPC circuits (8 circuits) |
| `target/idl/zodiac_mixer.json` | Mixer IDL (copy to app as needed) |
| `target/idl/zodiac_liquidity.json` | Liquidity IDL (used by operator) |
| `tests/zodiac-mixer.ts` | 25 mixer tests — reference for how to call mixer instructions |
| `tests/zodiac-mpc-meteora-integration.ts` | 37 integration tests — reference for full privacy flow |
| `tests/zodiac-full-privacy-integration.ts` | 39 tests — mixer + MPC + Meteora combined |
| `tests/zodiac-swap.ts` | 4 swap tests — swap_via_relay against existing devnet infrastructure |

## Arcium v0.7.0 Upgrade History

We upgraded from Arcium SDK 0.6.3 → 0.6.6 → 0.7.0. Each version had breaking changes. This section documents what changed and how we fixed it, so future upgrades don't repeat the same mistakes.

### v0.6.3 → v0.6.6 Breaking Changes

1. **`queue_computation` dropped the 4th argument.** Was `queue_computation(program, offset, args, None)` — remove the `None`.
2. **Comp def account structs need 2 new fields.** The `init_computation_definition_accounts` macro now requires:
   - `address_lookup_table: UncheckedAccount` (must be `#[account(mut)]`)
   - `lut_program: UncheckedAccount` (set to `AddressLookupTableProgram.programId`)
3. **LUT address derivation.** The `address_lookup_table` is the MXE's LUT PDA: `findProgramAddressSync([mxePda, u64_le(0)], AddressLookupTableProgram.programId)`.

### v0.6.6 → v0.7.0 Breaking Changes

1. **LUT address comes from MXE account's `lutOffsetSlot`.** In v0.7.0, you can't derive it from slot 0 anymore. You must:
   ```typescript
   const mxeAcc = await getArciumProgram(provider).account.mxeAccount.fetch(mxePda);
   const lutAddress = getLookupTableAddress(programId, mxeAcc.lutOffsetSlot);
   ```
2. **ARX node Docker images must match SDK version.** If `arcium test` hangs after MXE keygen succeeds but no computations complete, the ARX node image version doesn't match the SDK. Fix: `docker tag arcium/arx-node:v0.7.0 arcium/arx-node:latest`.
3. **`Anchor.toml` cluster must match test target.** `arcium test` reads `[provider] cluster` during MXE init. If set to `"devnet"` while running localnet, MXE gets a devnet slot for `lutOffsetSlot` and `Authority` becomes `None`. Set `cluster = "localnet"` before `arcium test`, `cluster = "devnet"` before `arcium test --cluster devnet`.

### v0.7.0 MXE Keygen Failure (the big one)

**Problem:** After `arcium deploy` on devnet, MXE keygen can silently fail. `Authority` stays `None`. All comp def inits fail.

**How to diagnose:**
```bash
arcium mxe-info <program-id> --rpc-url devnet
# If "Authority: None" → keygen never completed
```

**Fix sequence:**
1. Try `arcium finalize-mxe-keys <program-id> --cluster-offset 456 --keypair-path <key> --rpc-url devnet`
2. Check `mxe-info` again. If authority is still `None`, the ARX nodes never processed the keygen.
3. **Deploy to a fresh program ID.** Generate new keypair, update `declare_id!` + `Anchor.toml`, `arcium build --skip-keys-sync`, `arcium deploy`. The deploy+MXE bundle sometimes works when slot timing aligns.

**Root cause:** `arcium deploy` bundles program deploy + MXE init. `InitMxePart2` creates a LUT using a recent slot, but the slot goes stale during the long program deploy. When the LUT creation fails, keygen never starts, and `Authority` stays `None` forever.

**This is how we got the current program ID** (`4xNVpFyVTdsFPJ1UoZy9922xh2tDs1URMuujkfYYhHv5`). The previous ID (`77AR99icdjFkosQJkaDePemGKDATPJjy4ZS4AKw5pbN6`) had a stuck MXE. We deployed fresh and it worked on the first shot.

### Closed Program IDs (do NOT reuse)

These were all previous deploys that were closed to reclaim SOL:
`5iaJJzwRVTT47WLArixF8YoNJFMfLi8PTTmPRi9bdRGu`, `FMMVCEygM2ewq4y4fmE5UDuyfhuoz4bXmEDDeg9iFPpL`, `DjZRUPKc6mafw8EL1zNufkkJLGmFjfxx9ujdp823dmmM`, `7qpT6gRLFm1F9kHLSkHpcMPM6sbdWRNokQaqae1Zz3j2`, `Cwrhs9ch9kQBzcDXr1qajxwap5oZXrZBuZADK8vzS46U`, `77AR99icdjFkosQJkaDePemGKDATPJjy4ZS4AKw5pbN6`

## Tech Stack

| Component | Version |
|-----------|---------|
| Anchor | 0.32.1 |
| Arcium SDK | 0.7.0 |
| Rust | 1.89.0 |
| ARX cluster | 456 (devnet) |
