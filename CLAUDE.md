# Zodiac Liquidity - Project Context

## Overview

Privacy-focused DeFi liquidity provision for Meteora DAMM v2 pools using Arcium's Cerberus MPC protocol and a ZK mixer for identity unlinkability.

**Goal:** Enable private LP deposits/withdrawals while aggregating liquidity publicly. Users' individual amounts and positions remain hidden. A ZK mixer breaks the user-to-deposit link, and a Protocol relay PDA deploys to Meteora, breaking the deposit-to-LP link.

## Project Status

**Phase:** Localnet 40/40 passing, Devnet 39/40 passing (1 transient RPC 403). Ephemeral wallet auth + SOL-paired pools.

**Current Program ID (devnet):** `5iaJJzwRVTT47WLArixF8YoNJFMfLi8PTTmPRi9bdRGu`
**Localnet Program ID:** `32AfHsKshTPETofiAcECgNXeSLKztwzVH1qXju3dpA3K`
**Closed Program IDs (do NOT reuse):** `FMMVCEygM2ewq4y4fmE5UDuyfhuoz4bXmEDDeg9iFPpL`, `DjZRUPKc6mafw8EL1zNufkkJLGmFjfxx9ujdp823dmmM`

**What's Done:**
- Project structure created
- Dependencies configured (Anchor 0.32.1, Arcium 0.6.3)
- Arcium documentation in `/docs/arcium/`
- Arcis circuits in `encrypted-ixs/src/lib.rs`
- Anchor program with Arcium integration complete
- Meteora DAMM v2 CPI integrated (pool creation, position creation, deposit, withdraw)
- Relay PDA management (fund_relay, relay_transfer_to_destination)
- Circuits uploaded to GitHub offchain storage (`outsmartchad/zodiac-circuits`)
- Computation definitions use `CircuitSource::OffChain`
- Meta-tx code removed (not needed for relay architecture)
- DAMM v2 `[[test.genesis]]` configured for localnet
- **Fixed:** `withdraw` and `get_user_position` ArgBuilder mismatch (missing `shared_nonce` for `Shared` type)
- **Renamed:** `record_lp_tokens` → `record_liquidity` (Meteora uses "liquidity" not "LP tokens")
- **Added:** `clear_position` instruction + callback + tests
- **Added:** `record_liquidity` tests
- **Added:** `fund_relay`, `relay_transfer_to_destination` instructions + tests
- **Added:** `create_pool_via_relay`, `create_customizable_pool_via_relay`, `create_meteora_position` instructions + tests
- **Added:** `deposit_to_meteora_damm_v2`, `withdraw_from_meteora_damm_v2` instructions + tests
- **Added:** `EphemeralWalletAccount` PDA + `register_ephemeral_wallet`, `close_ephemeral_wallet` instructions
- **Changed:** 5 Meteora CPI instructions now use per-operation ephemeral wallet PDA auth instead of authority signer
- **Changed:** All Meteora pool tests now use SOL-paired pools (SPL token + NATIVE_MINT/WSOL) instead of SPL/SPL pairs
- **Localnet (2026-01-30):** 40/40 tests passing (24 happy-path + 16 fail tests)
- **Devnet (2026-01-30):** 39/40 passing (1 transient Helius RPC 403 rate limit on create_meteora_position)

**Rename (2026-01-29): record_lp_tokens → record_liquidity**
Meteora DAMM v2 does not use "LP tokens". A user's pool share is tracked via `Position.unlocked_liquidity` (a `u128` in the Position account), not a minted token. Renamed the circuit, instruction, events, and all related code to use "liquidity" terminology.

**Bug Fix (2026-01-29): Shared type requires nonce**
The `.idarc` circuit descriptor shows `Shared` parameters require BOTH `arcis_x25519_pubkey` AND `u128` nonce.
- Added `shared_nonce: u128` parameter to `withdraw()` and `get_user_position()` instructions
- Added `.plaintext_u128(shared_nonce)` after `.x25519_pubkey()` in ArgBuilder chain
- Tests updated to generate and pass `sharedNonce`

## Phases Overview

| Phase | Description | Status |
|-------|-------------|--------|
| **Phase 1** | Zodiac Program (Arcium MPC + Meteora CPI + Relay PDA) | **COMPLETE** (29/29 tests) |
| **Phase 2** | ZK Mixer Program (scaffolded in `privacy-cash/`) | Not implemented |
| **Phase 3** | Client SDK (TypeScript library for frontend integration) | Not started |
| **Phase 4** | Relayer Service (off-chain service for mixer withdraw proofs) | Not started |

## Tech Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| Anchor | 0.32.1 | Solana program framework |
| Arcium | 0.6.3 | MPC privacy layer |
| Rust | 1.89.0 | Program language |
| @arcium-hq/client | 0.6.3 | TypeScript encryption |
| Meteora DAMM v2 | - | Liquidity pool CPI |
| ARX node Docker | v0.6.3 | Must match Arcium SDK version (pinned via `docker tag`) |

## Meteora DAMM v2 Terminology

Meteora DAMM v2 does NOT use LP tokens. Key concepts:

| Concept | Description |
|---------|-------------|
| **Liquidity** | A `u128` integer representing a position's ownership share of the pool. NOT a token. |
| **Position** | An on-chain account (NFT-gated) that holds `unlocked_liquidity`, `vested_liquidity`, `permanent_locked_liquidity`. |
| **Pool.liquidity** | Sum of all positions' total liquidity (the denominator for share calculations). |
| **add_liquidity** | Increases `Position.unlocked_liquidity` and `Pool.liquidity` by `liquidity_delta`. |
| **remove_liquidity** | Decreases `Position.unlocked_liquidity` and `Pool.liquidity` by `liquidity_delta`. |

Reference: `/root/damm-v2/programs/cp-amm/src/state/position.rs` and `/root/anchor-learning/meteora-damm-v2-cpi/`

## IMPORTANT: Use `arcium` Commands Only

**Always use `arcium` CLI for build, deploy, and test. Never use `solana program deploy` or `anchor` directly.**

### Build
```bash
docker exec zodiac-dev bash -c "cd /app && arcium build"

# Skip key sync (when you manually set declare_id/Anchor.toml for devnet):
docker exec zodiac-dev bash -c "cd /app && arcium build --skip-keys-sync"
```

### Deploy (program + MXE init in one command)
```bash
docker exec zodiac-dev bash -c "cd /app && arcium deploy \
  --cluster-offset 456 \
  --recovery-set-size 4 \
  --keypair-path /root/.config/solana/id.json \
  --rpc-url devnet \
  --program-keypair /app/target/deploy/zodiac_liquidity-keypair.json \
  --program-name zodiac_liquidity"
```

### Test
```bash
# Localnet (starts validator + ARX nodes)
docker exec zodiac-dev bash -c "cd /app && arcium test"

# Devnet (uses existing cluster 456)
docker exec zodiac-dev bash -c "cd /app && arcium test --cluster devnet --skip-build"
```

### Fresh Devnet Deploy Procedure
```bash
# 1. Generate new keypair
solana-keygen new -o /root/anchor-building/target/deploy/zodiac_liquidity-keypair.json --force --no-bip39-passphrase
# Note the pubkey

# 2. Update declare_id! in programs/zodiac_liquidity/src/lib.rs
# 3. Update [programs.devnet] in Anchor.toml
# 4. Set cluster = "devnet" in Anchor.toml

# 5. Build + Deploy + Init MXE (all arcium)
docker exec zodiac-dev bash -c "cd /app && arcium build"
docker exec zodiac-dev bash -c "cd /app && arcium deploy \
  --cluster-offset 456 \
  --recovery-set-size 4 \
  --keypair-path /root/.config/solana/id.json \
  --rpc-url devnet \
  --program-keypair /app/target/deploy/zodiac_liquidity-keypair.json \
  --program-name zodiac_liquidity"

# 6. Test
docker exec zodiac-dev bash -c "cd /app && arcium test --cluster devnet --skip-build"
```

### Key Sync Gotcha

`arcium test` and `arcium build` run `anchor keys sync` which overwrites `declare_id!` and `Anchor.toml` from the keypair file. For devnet where the keypair matches the deployed program, this works fine. If the keypair doesn't match (e.g., old keypair), use `--skip-build` on test.

## Critical: Offchain Circuit Storage

**Circuits are uploaded to GitHub (`outsmartchad/zodiac-circuits`) - NO upload needed during testing!**

### How It Works

1. **Build circuits:** `arcium build` generates `.arcis` files and `.hash` files
2. **Upload once:** Circuits uploaded to GitHub repo `outsmartchad/zodiac-circuits`
3. **Program stores URLs:** Each `init_*_comp_def` uses `CircuitSource::OffChain`
4. **ARX nodes fetch:** When computation runs, ARX nodes download circuit from URL and verify hash
5. **Test just calls init:** Tests only call `program.methods.initVaultCompDef()` - no `uploadCircuit()`!

### Circuit URLs (Current - in program source)

The program uses GitHub raw URLs for circuit storage:
```
https://raw.githubusercontent.com/outsmartchad/zodiac-circuits/main/<circuit_name>.arcis
```

### Uploading New/Updated Circuits

```bash
# Clone the circuits repo
cd /tmp && git clone https://github.com/outsmartchad/zodiac-circuits.git

# Copy new .arcis files from build directory
cp /root/anchor-building/build/<circuit_name>.arcis /tmp/zodiac-circuits/

# Commit and push
cd /tmp/zodiac-circuits && git add . && git commit -m "Update circuits" && git push origin main
```

### Common Mistake to Avoid

**WRONG:** Test tries to upload circuits (causes 429 rate limits on devnet)
```typescript
// DON'T DO THIS with offchain circuits!
await uploadCircuit(program, circuitName, circuitData);
```

**RIGHT:** Test just initializes comp def (program already has URL)
```typescript
// Correct - just call the init instruction
await program.methods.initVaultCompDef()
  .accounts({ compDefAccount, payer, mxeAccount })
  .rpc();
```

## Architecture

### Full Protocol Architecture (4 Layers)

```
DEPOSIT FLOW:
User wallet → ZK Mixer (breaks identity link) → Ephemeral wallet → Zodiac vault (Arcium encrypts amount)
                                                                          ↓
                                                                Relay PDA → Meteora pool (add_liquidity CPI)
                                                                (single aggregate position, PDA holds NFT)

WITHDRAWAL FLOW:
User requests → Arcium computes share → Relay PDA removes liquidity from Meteora
                                      → relay_transfer_to_destination → Ephemeral wallet
```

### Full Transaction Flow (13 Steps)

```
 1. [user]       mixer.transact(proof)              -- deposit SOL/SPL to mixer
 2. [relayer]    mixer.transact(proof)              -- withdraw to ephemeral wallet
 3. [authority]  zodiac.register_ephemeral_wallet() -- register ephemeral wallet PDA
 4. [ephemeral]  zodiac.deposit(encrypted_amt)      -- deposit to vault
 5. [authority]  zodiac.reveal_pending_deposits()    -- Arcium reveals aggregate
 6. [authority]  zodiac.fund_relay(idx, amount)      -- vault → relay PDA
 7. [ephemeral]  zodiac.deposit_to_meteora(...)      -- relay PDA → Meteora add_liquidity
 8. [authority]  zodiac.record_liquidity(delta)      -- record in Arcium
 --- withdrawal ---
 9. [ephemeral]  zodiac.withdraw(pubkey, nonce)      -- Arcium computes share
10. [ephemeral]  zodiac.withdraw_from_meteora(...)   -- relay removes liquidity
11. [authority]  zodiac.relay_transfer_to_dest()     -- relay → ephemeral wallet
12. [authority]  zodiac.clear_position(amount)       -- zero Arcium state
13. [authority]  zodiac.close_ephemeral_wallet()     -- close PDA, reclaim rent
```

**Per-operation ephemeral wallet pattern:** Each Meteora CPI operation (steps 7, 10) uses a fresh ephemeral wallet. The authority registers the wallet PDA (step 3), the ephemeral wallet executes one CPI, then the authority closes the PDA (step 13) to reclaim rent. Next operation gets a brand new wallet — no cross-operation linkability.

### What's Hidden vs Visible

**Hidden:**
- Individual deposit/withdrawal amounts
- User's liquidity position size
- User → Meteora position linkability (Protocol PDA deploys, not user)
- User → deposit linkability (via ZK mixer, ephemeral wallets)

**Visible:**
- That *someone* deposited to the mixer (but not who withdrew or how much)
- Total aggregated liquidity in Meteora pool

### All Program Instructions

**MPC Comp Def Inits (8):**
| Instruction | Circuit |
|------------|---------|
| `init_vault_comp_def` | `init_vault` |
| `init_user_position_comp_def` | `init_user_position` |
| `init_deposit_comp_def` | `deposit` |
| `init_reveal_pending_comp_def` | `reveal_pending_deposits` |
| `init_record_liquidity_comp_def` | `record_liquidity` |
| `init_withdraw_comp_def` | `compute_withdrawal` |
| `init_get_position_comp_def` | `get_user_position` |
| `init_clear_position_comp_def` | `clear_position` |

**MPC Operations (8 queue + 8 callbacks = 16):**
| Instruction | Purpose |
|------------|---------|
| `create_vault` / `init_vault_callback` | Initialize encrypted vault state |
| `create_user_position` / `init_user_position_callback` | Initialize encrypted user position |
| `deposit` / `deposit_callback` | Add encrypted deposit, update vault + position |
| `reveal_pending_deposits` / `reveal_pending_deposits_callback` | Reveal aggregate for Meteora deployment |
| `record_liquidity` / `record_liquidity_callback` | Record liquidity received from Meteora |
| `withdraw` / `compute_withdrawal_callback` | Compute user's share (encrypted for user) |
| `clear_position` / `clear_position_callback` | Zero position after withdrawal confirmed |
| `get_user_position` / `get_user_position_callback` | Let user see their own position |

**Relay Management (2):**
| Instruction | Purpose |
|------------|---------|
| `fund_relay` | Transfer tokens from authority to relay PDA's token account |
| `relay_transfer_to_destination` | Transfer tokens from relay PDA to destination (e.g., ephemeral wallet) |

**Ephemeral Wallet Management (2):**
| Instruction | Purpose |
|------------|---------|
| `register_ephemeral_wallet` | Register an ephemeral wallet PDA (authority only) |
| `close_ephemeral_wallet` | Close an ephemeral wallet PDA, return rent to authority |

**Meteora CPI (5) — require registered ephemeral wallet:**
| Instruction | Purpose |
|------------|---------|
| `create_pool_via_relay` | Create Meteora pool via relay PDA (config-based) |
| `create_customizable_pool_via_relay` | Create customizable Meteora pool via relay PDA |
| `create_meteora_position` | Create a Meteora position for relay PDA + track via RelayPositionTracker |
| `deposit_to_meteora_damm_v2` | Add liquidity to Meteora pool via relay PDA CPI |
| `withdraw_from_meteora_damm_v2` | Remove liquidity from Meteora pool via relay PDA CPI |

### Arcis Circuits (MPC Operations)

| Circuit | Purpose | Size | ACUs |
|---------|---------|------|------|
| `init_vault` | Initialize encrypted vault state | 86KB | 151M |
| `init_user_position` | Initialize user's encrypted position | 86KB | 151M |
| `deposit` | Add encrypted deposit, update vault + position | 1.2MB | 578M |
| `reveal_pending_deposits` | Reveal aggregate for Meteora deployment | 131KB | 153M |
| `record_liquidity` | Record liquidity received from Meteora | 249KB | 194M |
| `compute_withdrawal` | Reveal user's deposited amount (encrypted for user) | 785KB | 488M |
| `clear_position` | Clear position after withdrawal confirmed | 501KB | 241M |
| `get_user_position` | Let user see their own position | 844KB | 493M |

### Encrypted State Layout

**VaultState** (3 encrypted u64s):
- `pending_deposits` — deposits awaiting Meteora deployment
- `total_liquidity` — liquidity delta from Meteora add_liquidity
- `total_deposited` — cumulative deposits for pro-rata calculation

**UserPosition** (2 encrypted u64s):
- `deposited` — user's total deposited amount
- `liquidity_share` — user's share of liquidity

**EphemeralWalletAccount** (PDA: `[b"ephemeral", vault, wallet]`):
- `bump` — PDA bump seed
- `vault` — which vault this belongs to
- `wallet` — the ephemeral wallet pubkey
- **Per-operation pattern:** Each Meteora CPI gets a fresh ephemeral wallet. Authority registers the PDA before the CPI, ephemeral wallet signs the CPI, then authority closes the PDA to reclaim rent. No `is_active` flag — existence of the PDA is the only check. A new wallet keypair is generated for every operation, preventing cross-operation linkability.

### Three-Instruction Pattern (per MPC operation)

Every encrypted operation requires:
1. `init_*_comp_def` - One-time computation definition setup (stores URL + hash)
2. `your_instruction` - Queue computation with encrypted args
3. `your_instruction_callback` - Receive verified MPC results (called by ARX nodes)

### ArgBuilder Pattern for Arcium Types

From `.idarc` circuit descriptors:

| Arcis Type | ArgBuilder Pattern |
|------------|-------------------|
| `Enc<Mxe, T>` | `.plaintext_u128(nonce)` + `.account(key, offset, size)` |
| `Enc<Shared, T>` | `.x25519_pubkey(pubkey)` + `.plaintext_u128(nonce)` + `.encrypted_*()` |
| `Shared` (standalone) | `.x25519_pubkey(pubkey)` + `.plaintext_u128(nonce)` |
| `u64` (plaintext) | `.plaintext_u64(value)` |
| `u128` (plaintext) | `.plaintext_u128(value)` |

**Critical:** `Shared` as a standalone parameter requires BOTH pubkey AND nonce (learned the hard way).

### Callback Server (for large outputs)

The callback server handles MPC outputs that exceed Solana's ~1KB transaction limit:
- NOT for circuit storage (that's offchain URLs)
- Used when computation results are too large
- See: https://docs.arcium.com/developers/callback-server

## Key Files

| File | Purpose |
|------|---------|
| `encrypted-ixs/src/lib.rs` | Arcis MPC circuits |
| `programs/zodiac_liquidity/src/lib.rs` | Anchor + Arcium program |
| `tests/zodiac-liquidity.ts` | Integration tests |
| `build/*.arcis` | Compiled circuit files |
| `build/*.hash` | Circuit hashes (used by `circuit_hash!` macro) |
| `build/*.idarc` | Circuit input/output descriptors (use to verify ArgBuilder) |

## Commands

**IMPORTANT: All builds/tests must run inside the Docker container! Always use `arcium` CLI.**

```bash
# Start the dev container (from host)
docker run -d \
    --name zodiac-dev \
    --ulimit nofile=1048576:1048576 \
    --ulimit nproc=65535:65535 \
    -v "$(pwd)":/app \
    -v "$HOME/.config/solana":/root/.config/solana \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -p 8899:8899 \
    -p 8900:8900 \
    zodiac-liquidity-dev \
    sleep infinity

# Or if container is already running, exec into it:
docker exec -it zodiac-dev bash

# Inside container - Build
arcium build

# Inside container - Test on localnet (spins up ARX nodes)
arcium test

# Inside container - Test on devnet
arcium test --cluster devnet

# Inside container - Deploy to devnet (program + MXE)
arcium deploy --cluster-offset 456 --recovery-set-size 4 \
  --keypair-path /root/.config/solana/id.json \
  --rpc-url devnet \
  --program-keypair /app/target/deploy/zodiac_liquidity-keypair.json \
  --program-name zodiac_liquidity
```

**Never run `cargo build` or `anchor build` or `solana program deploy` directly - always use `arcium` commands.**

## Testing Modes

1. **Localnet** (recommended for development): `arcium test`
   - Starts local Solana validator
   - Starts MPC nodes in Docker containers
   - ARX nodes fetch circuits from URLs
   - Full end-to-end testing

2. **Devnet**: `arcium test --cluster devnet`
   - Uses real devnet Solana + existing MPC cluster
   - Requires: Program deployed + MXE initialized (use `arcium deploy`)
   - Can use `--skip-build` to avoid key sync issues

3. **Manual nodes**: `arcium test --skip-local-arx-nodes`
   - You start MPC nodes yourself
   - Advanced use case

## Testing Flow (Correct)

```typescript
// 1. Initialize comp defs (one-time, just registers URLs)
await program.methods.initVaultCompDef().accounts({...}).rpc();

// 2. Queue computation
const computationOffset = new BN(randomBytes(8), "hex");
await program.methods.createVault(computationOffset, nonce)
  .accounts({...})
  .rpc();

// 3. Wait for MPC to process and call callback
const finalizeSig = await awaitComputationFinalization(
  provider,
  computationOffset,
  program.programId,
  "confirmed"
);

// 4. Callback has already updated on-chain state
// Read updated account or listen for events
```

## Circuit Cost Guidelines

Arcium has a maximum CU (compute units) limit per circuit. Keep circuits under ~500M ACUs:

| Circuit Type | Example ACUs | Notes |
|--------------|--------------|-------|
| Simple init | ~150M | Just encrypt zero values |
| State update | ~200-250M | Decrypt, modify, re-encrypt |
| Multi-input | ~500-600M | Multiple encrypted inputs/outputs |

**Expensive operations:**
- Division in MPC is very expensive (~3+ billion ACUs)
- Avoid divisions in circuits; compute ratios off-chain
- Use plaintext inputs where privacy allows

## Reference Projects

| Project | Location | Purpose |
|---------|----------|---------|
| Meteora DAMM v2 CPI | `/root/anchor-learning/meteora-damm-v2-cpi` | Working CPI example |
| Meteora DAMM v2 source | `/root/damm-v2/programs/cp-amm/src/` | Pool/Position structs, liquidity math |
| Arcium Voting | `/root/examples/voting/` | State accumulation pattern |
| Arcium Examples | `/root/examples/` | MPC patterns |

## Security Considerations

1. **Cerberus only** - Never use Manticore for DeFi
2. **Nonce management** - Fresh nonce for every encryption
3. **MXE state** - Use `Enc<Mxe, T>` for protocol state
4. **Protocol PDA** - Deploys to Meteora, not user wallets
5. **Viewing keys** - Support compliance/audit access (future)

## Lessons Learned

1. **Offchain circuits eliminate upload issues** - No 429 rate limits, no large tx problems
2. **`circuit_hash!` macro is critical** - Reads from `build/*.hash`, ARX nodes verify
3. **Localnet works** - ARX nodes come online after ~60s, fetch circuits from URLs
4. **Devnet upload is slow** - Use offchain storage to avoid rate limits
5. **Callback server != circuit storage** - Callback is for large MPC outputs only
6. **Docker network issues with external URLs** - ARX nodes in Docker can't reliably reach catbox.moe
7. **Local HTTP server for localnet** - Use `python3 -m http.server 8080` in build dir, serve at `http://172.20.0.2:8080/`
8. **`Shared` type needs nonce** - `.idarc` shows `Shared` requires both `arcis_x25519_pubkey` + `u128` nonce. Missing the nonce causes "ArgBuilder account size mismatch with circuit" error.
9. **Always use `arcium` CLI** - `arcium deploy` handles program deploy + MXE init. `arcium test` handles build + test. Don't use `solana program deploy` or `anchor build` directly.
10. **Key sync gotcha** - `arcium build`/`arcium test` run `anchor keys sync` which overwrites `declare_id!` from the keypair file. For devnet, make sure the keypair matches your deployed program ID.
11. **Meteora uses "liquidity" not "LP tokens"** - `Position.unlocked_liquidity` is a `u128` representing pool share, not a minted token. Always use "liquidity" terminology when interacting with DAMM v2.
12. **Circuit rename requires full rebuild** - Renaming a circuit function in `encrypted-ixs/src/lib.rs` requires `arcium build` to regenerate `.arcis`/`.hash` files, uploading the new `.arcis` to GitHub, and re-initializing the comp def on-chain (new PDA).
13. **Never use `--skip-build` after account struct changes** - If you add/remove fields from account structs (e.g., adding `meta_nonce` to `VaultAccount`), you MUST run `arcium test` (without `--skip-build`) so the IDL is regenerated. Using `--skip-build` with a stale IDL causes `Unknown action 'undefined'` errors and MXE keygen failure (120 retries exhausted). The fix is always a full `arcium test` (no flags).
14. **GitHub URLs work fine for localnet** - ARX Docker nodes CAN reach `raw.githubusercontent.com`. The Docker network issue was specific to catbox.moe, not external URLs in general. No need to switch to local HTTP server for localnet testing.
15. **Kill zombie processes before re-running tests** - If `arcium test` is interrupted or run multiple times, stale mocha/validator/arcium processes pile up as zombies. Fix: `docker restart zodiac-dev` then `rm -rf /app/.anchor/test-ledger` before the next run.
16. **Localnet test procedure** - Clean run: `docker restart zodiac-dev` → `docker exec zodiac-dev bash -c "rm -rf /app/.anchor/test-ledger && cd /app && arcium test"`. This ensures no zombie processes, fresh ledger, full build + IDL regen, and single test runner.
17. **Blockhash retry patch** - On localnet, after heavy MPC activity (8 comp defs + 8 computations), the validator lags and blockhashes expire between fetch and confirmation. The test file patches `provider.sendAndConfirm` to auto-retry up to 3 times on "Blockhash not found" errors with a 2s delay. This covers all `.rpc()` calls since Anchor routes them through `provider.sendAndConfirm`. Eliminated all transient blockhash failures.
18. **SOL-paired pools** - Meteora DAMM v2 pools should use NATIVE_MINT (WSOL) as one of the token pair. Fund relay WSOL accounts by transferring SOL + `createSyncNativeInstruction()` instead of `mintTo` + `fundRelay`. The on-chain `deposit_to_meteora_damm_v2` has built-in SOL wrapping via `sol_amount` parameter.
19. **ARX node Docker image version must match Arcium SDK** - See dedicated section below: "ARX Node Version Mismatch (AccountDidNotDeserialize)".
20. **Test file split** - Tests are split into `tests/zodiac-liquidity.ts` (happy-path, 24 tests) and `tests/zodiac-liquidity-fail.ts` (fail/auth tests, 7 tests). The Anchor.toml glob `tests/**/*.ts` runs both. To run only happy-path, temporarily change glob to `tests/zodiac-liquidity.ts`.

## ARX Node Version Mismatch (AccountDidNotDeserialize)

**This is the #1 cause of localnet tests hanging forever.** If `arcium test` hangs after MXE keygen succeeds but no computations complete, this is almost certainly the problem.

### The Problem

The Arcium SDK version used to build the on-chain program (`arcium_program_0.6.3.so` in `artifacts/`) must exactly match the ARX node Docker image version. The docker-compose file (`artifacts/docker-compose-arx-env.yml`) uses `arcium/arx-node:latest`. If Docker Hub pushes a new `:latest` tag (e.g., 0.6.6) while the on-chain program is still 0.6.3, the account struct layouts diverge and the ARX nodes can't deserialize computation accounts created by the program.

### Why It Happens

1. The Arcium on-chain program (`Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ`) creates computation accounts using **0.6.3 struct layouts** (because `artifacts/arcium_program_0.6.3.so` is loaded into the validator)
2. ARX nodes try to deserialize those computation accounts using their **own version's struct layouts** (e.g., 0.6.6)
3. If ANY field was added, removed, or reordered between versions, deserialization fails with `AccountDidNotDeserialize` (Anchor error code 3003)
4. The computation never completes, and the test hangs forever waiting for `awaitComputationFinalization()`

### Symptoms

1. `arcium test` starts normally — validator boots, ARX nodes come online, comp defs initialize
2. MXE keygen **succeeds** (this uses a built-in circuit, not the program's IDL)
3. First real computation (e.g., `createVault`) queues successfully on-chain
4. Test prints `[createVault] Computation account confirmed on-chain, continuing to wait...`
5. Test hangs forever — computation never finalizes
6. ARX node logs (`/usr/arx-node/logs/arx_log_*.log`) show repeated errors like:
   ```
   WARN arx::program: Attempt 1/5: error while calling async ...
   Failed to fetch account <PUBKEY>: AnchorError {
     error_name: "AccountDidNotDeserialize",
     error_code_number: 3003,
     error_msg: "Failed to deserialize the account"
   }
   ```
   ...repeating 5 times, then:
   ```
   ERROR arx::units::computation_unit: Failed to fetch computation for reference
   Computation offset: <OFFSET>: ... AccountDidNotDeserialize
   ```

### How to Diagnose

```bash
# 1. Check ARX node version (should match Arcium SDK version)
docker exec artifacts-arx-node-0-1 bash -c "head -1 /usr/arx-node/logs/arx_log_*.log" 2>/dev/null
# Look for: version=0.6.3 (GOOD) vs version=0.6.6 (BAD)

# 2. Check Arcium CLI version (this is the SDK version)
docker exec zodiac-dev bash -c "arcium --version"
# Should output: arcium-cli 0.6.3

# 3. Check which Docker image is tagged as :latest
docker inspect arcium/arx-node:latest --format '{{.Id}}'
docker inspect arcium/arx-node:v0.6.3 --format '{{.Id}}'
# If the IDs differ, :latest is pointing to the wrong version
```

### The Fix

You CANNOT edit `artifacts/docker-compose-arx-env.yml` because `arcium test` **regenerates it every run** with hardcoded `:latest` tags. Instead, retag the correct version as `:latest`:

```bash
# 1. Pull the correct version (if not already present)
docker pull arcium/arx-node:v0.6.3
docker pull arcium/trusted-dealer:v0.6.3

# 2. Retag as :latest (this overwrites the wrong :latest)
docker tag arcium/arx-node:v0.6.3 arcium/arx-node:latest
docker tag arcium/trusted-dealer:v0.6.3 arcium/trusted-dealer:latest

# 3. Verify both point to the same image
docker images | grep arcium
# Both :latest and :v0.6.3 should show the same IMAGE ID

# 4. Stop any running ARX containers from previous failed runs
docker stop artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arcium-trusted-dealer-1 2>/dev/null
docker rm artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arcium-trusted-dealer-1 2>/dev/null

# 5. Restart zodiac-dev and run clean test
docker restart zodiac-dev
docker exec zodiac-dev bash -c "rm -rf /app/.anchor/test-ledger && cd /app && arcium test"
```

### Version Mapping

The version tag must match the Arcium SDK in `Cargo.toml` and the `.so` artifact:

| Arcium SDK (`arcium-cli --version`) | Program artifact | ARX node Docker tag |
|--------------------------------------|------------------|---------------------|
| 0.6.3 | `arcium_program_0.6.3.so` | `arcium/arx-node:v0.6.3` |
| 0.6.6 | `arcium_program_0.6.6.so` (would need update) | `arcium/arx-node:v0.6.6` |

### Prevention

After `docker pull` or system updates, always verify the ARX node version before running tests:
```bash
docker inspect arcium/arx-node:latest --format '{{index .Config.Labels "version"}}' 2>/dev/null || \
  echo "Run a quick test and check: docker exec artifacts-arx-node-0-1 head -1 /usr/arx-node/logs/arx_log_*.log"
```

If upgrading Arcium SDK in the future, you must update ALL three together:
1. `Cargo.toml` Arcium dependency version
2. `artifacts/arcium_program_<VERSION>.so` (download matching .so)
3. `docker tag arcium/arx-node:v<VERSION> arcium/arx-node:latest`

## Localnet Circuit Hosting (NOT NEEDED — GitHub URLs work)

GitHub raw URLs work fine from ARX Docker nodes. The catbox.moe issue was host-specific.

**Only use local hosting if GitHub is unreachable:**

1. Start HTTP server in zodiac-dev container:
```bash
docker exec -d zodiac-dev bash -c "cd /app/build && python3 -m http.server 8080 --bind 0.0.0.0"
```

2. Use local URLs in program (172.20.0.2 is zodiac-dev IP on arx_network):
```rust
CircuitSource::OffChain(OffChainCircuitSource {
    source: "http://172.20.0.2:8080/init_vault.arcis".to_string(),
    hash: circuit_hash!("init_vault"),
})
```

3. Clean ledger before testing (comp defs cache old URLs):
```bash
docker exec zodiac-dev bash -c "rm -rf /app/.anchor/test-ledger /app/artifacts/*.json"
```

## Test Results (2026-01-31)

### Localnet (24/24 passing — happy-path file only)

**Program:** `5iaJJzwRVTT47WLArixF8YoNJFMfLi8PTTmPRi9bdRGu` (localnet, via `anchor keys sync`)
**ARX nodes:** `arcium/arx-node:v0.6.3` (pinned via `docker tag`)

**File: `tests/zodiac-liquidity.ts` (happy-path)**

| # | Test | Status |
|---|------|--------|
| 1 | init_vault comp def | PASS |
| 2 | init_user_position comp def | PASS |
| 3 | deposit comp def | PASS |
| 4 | reveal_pending_deposits comp def | PASS |
| 5 | record_liquidity comp def | PASS |
| 6 | compute_withdrawal comp def | PASS |
| 7 | get_user_position comp def | PASS |
| 8 | clear_position comp def | PASS |
| 9 | creates a new vault | PASS |
| 10 | creates a user position | PASS |
| 11 | deposits tokens (encrypted) | PASS |
| 12 | reveals pending deposits | PASS |
| 13 | records liquidity from Meteora | PASS |
| 14 | computes withdrawal for user | PASS |
| 15 | clears user position | PASS |
| 16 | gets user position | PASS |
| 17 | transfers tokens from relay PDA to destination | PASS |
| 18 | funds a relay PDA token account | PASS |
| 19 | creates a customizable pool via relay PDA (SOL-paired) | PASS |
| 20 | creates a Meteora position for relay PDA | PASS |
| 21 | deposits liquidity to Meteora via relay PDA (SOL-paired) | PASS |
| 22 | withdraws liquidity from Meteora via relay PDA (SOL-paired) | PASS |
| 23 | registers an ephemeral wallet | PASS |
| 24 | closes an ephemeral wallet | PASS |

**File: `tests/zodiac-liquidity-fail.ts` (16/16 passing — includes 8 comp def inits + 1 vault creation as setup)**

| # | Test | Status |
|---|------|--------|
| 1-8 | comp def inits (setup) | PASS |
| 9 | creates vault (MPC, setup) | PASS |
| 10 | fails relay transfer with wrong authority | PASS |
| 11 | fails relay transfer with invalid relay index | PASS |
| 12 | fails fund_relay with wrong authority | PASS |
| 13 | fails create_customizable_pool with unregistered ephemeral wallet | PASS |
| 14 | fails deposit_to_meteora with unregistered ephemeral wallet | PASS |
| 15 | fails withdraw_from_meteora with unregistered ephemeral wallet | PASS |
| 16 | fails register with wrong authority | PASS |

**Note:** Meteora CPI tests use ephemeral wallet signers (fresh keypair per operation: register PDA → fund → CPI → return funds → close PDA). "Could not return ephemeral SOL" warnings in logs are expected — handled gracefully in teardown.

### Devnet (39/40 passing — 1 transient RPC 403)

**Program:** `5iaJJzwRVTT47WLArixF8YoNJFMfLi8PTTmPRi9bdRGu` (cluster 456)
**RPC:** Helius devnet
**Date:** 2026-01-30

**File: `tests/zodiac-liquidity.ts` (happy-path)**

| # | Test | Status |
|---|------|--------|
| 1-8 | comp def inits (reused existing) | PASS |
| 9 | creates a new vault | PASS |
| 10 | creates a user position | PASS (retry 2/5, timeout on attempt 1) |
| 11 | deposits tokens (encrypted) | PASS |
| 12 | reveals pending deposits | PASS |
| 13 | records liquidity from Meteora | PASS |
| 14 | computes withdrawal for user | PASS |
| 15 | clears user position | PASS |
| 16 | gets user position | PASS |
| 17 | transfers tokens from relay PDA to destination | PASS |
| 18 | funds a relay PDA token account | PASS |
| 19 | creates a customizable pool via relay PDA (SOL-paired) | PASS |
| 20 | creates a Meteora position for relay PDA | **FAIL** (Helius 403 on getLatestBlockhash) |
| 21 | deposits liquidity to Meteora via relay PDA (SOL-paired) | PASS |
| 22 | withdraws liquidity from Meteora via relay PDA (SOL-paired) | PASS |
| 23 | registers an ephemeral wallet | PASS |
| 24 | closes an ephemeral wallet | PASS |

**File: `tests/zodiac-liquidity-fail.ts` (16/16 passing)**

| # | Test | Status |
|---|------|--------|
| 1-8 | comp def inits (reused existing) | PASS |
| 9 | creates vault (MPC, setup) | PASS |
| 10 | fails relay transfer with wrong authority | PASS |
| 11 | fails relay transfer with invalid relay index | PASS |
| 12 | fails fund_relay with wrong authority | PASS |
| 13 | fails create_customizable_pool with unregistered ephemeral wallet | PASS |
| 14 | fails deposit_to_meteora with unregistered ephemeral wallet | PASS |
| 15 | fails withdraw_from_meteora with unregistered ephemeral wallet | PASS |
| 16 | fails register with wrong authority | PASS |

**Note:** The single failure (test #20) is a transient Helius RPC 403 rate limit during `getLatestBlockhash`, not a code bug. All other Meteora CPI tests (create pool, deposit, withdraw) passed. A re-run would likely pass all 40.

## Arcium Diagnostic Commands

```bash
# Check mempool for pending computations
arcium mempool 456 --rpc-url devnet

# Check executing pool
arcium execpool 456 --rpc-url devnet

# Check computation details
arcium computation 456 <computation_offset>

# Check MXE info
arcium mxe-info --program-id <program_id> --rpc-url devnet
```

## Documentation

- **Arcium docs:** `/root/anchor-building/docs/arcium/`
- **Quick reference:** `/root/anchor-building/docs/arcium/11-quick-reference.md`
- **Deployment guide:** `/root/anchor-building/docs/arcium/08-deployment.md`
- **Skill:** `/root/.claude/skills/arcium-dev/`

## Invoke Skill

```
/arcium-dev
```

This loads the full Arcium development context.
