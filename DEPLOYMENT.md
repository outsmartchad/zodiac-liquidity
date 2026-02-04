# Zodiac Protocol — Mainnet Deployment Guide

## Pre-Deployment Checklist

### Program Configuration

- [ ] Set `ADMIN_PUBKEY` in `zodiac_mixer/src/lib.rs` for `#[cfg(not(...))]` (mainnet) to a known, secured pubkey
- [ ] Set `ALLOW_ALL_SPL_TOKENS = false` for mainnet in `zodiac_mixer/src/lib.rs`
- [ ] Populate `ALLOWED_TOKENS` with the specific SPL token mints that the mixer should support
- [ ] Verify `declare_id!()` in both programs matches the intended mainnet program IDs
- [ ] Verify `[programs.mainnet]` in `Anchor.toml` matches the declared program IDs
- [ ] Verify circuit URLs in `zodiac_liquidity/src/lib.rs` point to the correct GitHub raw URLs
- [ ] Verify circuit hashes match the deployed `.arcis` files (`arcium build` regenerates `.hash` files)

### Key Management

- [ ] Generate a dedicated mainnet authority keypair (NOT the same as devnet)
- [ ] Store the authority keypair in a hardware wallet or Squads multisig vault
- [ ] Configure the operator service with `signerMode: "multisig"` and `multisigAddress`
- [ ] Fund the authority wallet with sufficient SOL for deployment (~10 SOL recommended)
- [ ] Fund the authority wallet with sufficient SOL for relay PDA operations (~5 SOL per relay)

### Infrastructure

- [ ] Set up a dedicated RPC endpoint (Helius or Triton recommended for mainnet)
- [ ] Configure the Arcium MPC cluster for mainnet (cluster offset, recovery set size)
- [ ] Verify ARX node Docker image version matches the Arcium SDK version (`v0.6.3`)
- [ ] Set up monitoring and alerting for the operator service
- [ ] Configure persistent rate limiting (SQLite) for the operator API

### Security

- [ ] Complete third-party audit of both programs
- [ ] Run the full test suite against a mainnet fork (`solana-test-validator --clone-upgradeable-program`)
- [ ] Verify all authority-gated instructions enforce the correct authority check
- [ ] Review all `UncheckedAccount` usages and their safety comments
- [ ] Verify fee configuration: deposit 0%, withdrawal 0.35%, error margin 5%

## Step-by-Step Deployment

### Step 1: Build Programs

```bash
# Inside the Docker container
docker exec zodiac-dev bash -c "cd /app && arcium build --skip-keys-sync"
```

Verify the build output:
- `target/deploy/zodiac_liquidity.so` exists
- `target/deploy/zodiac_mixer.so` exists
- `build/*.arcis` and `build/*.hash` files are up to date

### Step 2: Upload Circuits (if changed)

If circuits have been modified since the last upload:

```bash
# Clone the circuits repo
cd /tmp && git clone https://github.com/outsmartchad/zodiac-circuits.git

# Copy updated .arcis files
cp /root/zodiac/onchain/build/*.arcis /tmp/zodiac-circuits/

# Commit and push
cd /tmp/zodiac-circuits && git add . && git commit -m "Update circuits for mainnet" && git push origin main
```

### Step 3: Generate Mainnet Keypairs (if fresh deploy)

```bash
# Generate new program keypairs for mainnet
solana-keygen new -o target/deploy/zodiac_liquidity-keypair.json --force --no-bip39-passphrase
solana-keygen new -o target/deploy/zodiac_mixer-keypair.json --force --no-bip39-passphrase

# Note the resulting pubkeys and update:
# 1. declare_id!() in both lib.rs files
# 2. [programs.mainnet] in Anchor.toml
```

If redeploying to existing program IDs, use the existing keypairs.

### Step 4: Deploy zodiac_mixer

The mixer has no Arcium dependency, so it can be deployed with standard Anchor tooling:

```bash
# Set cluster to mainnet
solana config set --url https://api.mainnet-beta.solana.com

# Deploy the mixer program
anchor deploy --provider.cluster mainnet \
  --program-keypair target/deploy/zodiac_mixer-keypair.json \
  --program-name zodiac_mixer
```

### Step 5: Deploy zodiac_liquidity (via Arcium CLI)

The liquidity program requires Arcium MPC initialization:

```bash
docker exec zodiac-dev bash -c "cd /app && arcium deploy \
  --cluster-offset <MAINNET_CLUSTER_OFFSET> \
  --recovery-set-size 4 \
  --keypair-path /root/.config/solana/mainnet-authority.json \
  --rpc-url mainnet-beta \
  --program-keypair /app/target/deploy/zodiac_liquidity-keypair.json \
  --program-name zodiac_liquidity"
```

Replace `<MAINNET_CLUSTER_OFFSET>` with the Arcium cluster offset assigned for mainnet.

### Step 6: Initialize Computation Definitions

After deployment, initialize all 8 computation definitions:

```bash
# Run a minimal initialization script (or use the test suite with --cluster mainnet)
# Each comp def only needs to be initialized once per program deployment
```

The initialization calls:
1. `initVaultCompDef`
2. `initUserPositionCompDef`
3. `initDepositCompDef`
4. `initRevealPendingCompDef`
5. `initRecordLiquidityCompDef`
6. `initWithdrawCompDef`
7. `initGetPositionCompDef`
8. `initClearPositionCompDef`

### Step 7: Initialize Mixer

```bash
# Call the initialize instruction to create the SOL Merkle tree + global config
# This sets:
#   - deposit_fee_rate: 0 (0%)
#   - withdrawal_fee_rate: 35 (0.35%)
#   - fee_error_margin: 500 (5%)
#   - max_deposit_amount: 1_000_000_000_000 (1000 SOL)
#   - paused: false
```

For SPL tokens, also call `initialize_tree_account_for_spl_token` for each supported mint.

### Step 8: Create Vault and Pool

```bash
# 1. Create vault for the base token mint
#    create_vault(computation_offset, nonce)

# 2. Wait for MPC callback to finalize vault state

# 3. Fund relay PDA with SOL (for pool creation rent)
#    fund_relay(relay_index=0, amount=500_000_000) // 0.5 SOL

# 4. Register ephemeral wallet for pool creation
#    register_ephemeral_wallet()

# 5. Create Meteora pool via relay PDA
#    create_customizable_pool_via_relay(relay_index=0, pool_fees, ...)

# 6. Create Meteora position for relay PDA
#    create_meteora_position(relay_index=0)

# 7. Close ephemeral wallet
#    close_ephemeral_wallet()
```

## Post-Deployment Verification

### Program Verification

- [ ] Verify both program IDs on Solana Explorer (mainnet)
- [ ] Verify the program authority is the correct mainnet authority keypair
- [ ] Verify the program is NOT upgradeable (or upgradeable with a known authority)
- [ ] Verify IDL is published (`anchor idl init`)

### State Verification

- [ ] Verify vault account exists and vault_state is initialized (encrypted, non-zero)
- [ ] Verify global config has correct fee rates
- [ ] Verify Merkle tree account is initialized with correct height (26) and root history (100)
- [ ] Verify comp def accounts exist for all 8 circuits
- [ ] Verify Meteora pool is created and position is initialized

### Operational Verification

- [ ] Test a deposit → reveal → fund_relay → deposit_to_meteora → record_liquidity flow
- [ ] Test a withdraw → remove_liquidity → relay_transfer → clear_position flow
- [ ] Test the mixer: deposit SOL → withdraw to different address
- [ ] Verify operator API health endpoint returns correct program IDs
- [ ] Verify relayer API health endpoint returns correct fee schedule

### Monitoring

- [ ] Set up transaction monitoring for authority wallet activity
- [ ] Set up alerts for failed MPC computations (no callback within timeout)
- [ ] Monitor relay PDA SOL balances (should not be drained unexpectedly)
- [ ] Monitor vault token account balances (should match encrypted state within error margin)

## Fee Configuration for Production

### Mixer Fees

| Parameter | Value | Description |
|-----------|-------|-------------|
| `deposit_fee_rate` | 0 | Free deposits to maximize adoption |
| `withdrawal_fee_rate` | 35 | 0.35% withdrawal fee (35 basis points) |
| `fee_error_margin` | 500 | 5% tolerance for fee amounts |

### Meteora Pool Fees (set during `create_customizable_pool_via_relay`)

| Parameter | Recommended Value | Description |
|-----------|-------------------|-------------|
| `base_fee_numerator` | 2500 | 0.25% base fee |
| `protocol_fee_numerator` | 500 | 0.05% protocol fee |
| `dynamic_fee` | 0 | No dynamic fee initially |
| `collect_fee_mode` | 0 | Linear fee collection |

### Deposit Limits

| Asset | Limit | Description |
|-------|-------|-------------|
| SOL | 1000 SOL (1e12 lamports) | Per-transaction deposit limit |
| SPL tokens | Set per-mint via `initialize_tree_account_for_spl_token` | Configurable per token |

## Rollback Plan

If critical issues are discovered post-deployment:

1. **Pause the mixer:** Call `toggle_pause` to halt all mixer deposits/withdrawals
2. **Stop the operator:** Shut down the operator service to prevent new vault operations
3. **Do NOT upgrade the program** without a full audit of the upgrade path
4. **Drain relay PDAs:** Use `withdraw_relay_sol` and `close_relay_token_account` to recover relay funds
5. **User fund recovery:** Users can still withdraw from the mixer using ZK proofs (if not paused). Vault funds require the operator to process withdrawals.

## Program Upgrade Path

If upgradeable programs are used:

1. Build the new program binary
2. Test against mainnet fork with `solana-test-validator --clone-upgradeable-program`
3. Deploy via `anchor upgrade` with the program authority
4. Re-initialize any changed comp defs (if circuit logic changed)
5. Verify all existing state is still deserializable (no account struct changes without migration)

**Warning:** Changing account struct layouts (adding/removing/reordering fields) will break deserialization of existing accounts. Use explicit migration instructions if struct changes are required.
