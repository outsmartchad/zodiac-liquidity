# Zodiac Liquidity

Privacy protocol for LPers powered by Arcium MPC and zk mixer. Supports Meteora DAMM v2 pools (DLMM coming soon).

## The Problem

On-chain liquidity provision is fully transparent. When you deposit into a pool, everyone can see your wallet, your deposit amount, and your position size. This leaks your alpha and lp strategy.

## How Zodiac Solves It

Zodiac combines **MPC encryption** and a **ZK mixer** for full LP privacy.

- **Encrypted state** — All deposit amounts and positions are encrypted by Arcium's MPC network. No single party can decrypt, not even the protocol operator.
- **Identity unlinkability** — A ZK mixer breaks the link between user wallets and deposits. Single-use ephemeral wallets prevent cross-operation tracing.
- **User-only results** — When a user queries their position or withdraws, the MPC network re-encrypts the result for that user's key. Only they can read it.

### What's Hidden vs Visible

**Hidden (encrypted, never revealed on-chain):**
- Individual deposit and withdrawal amounts
- Each user's liquidity position size
- User-to-Meteora position link (a Protocol relay PDA holds all pool positions, not individual users)

**Visible:**
- That wallet deposited to the mixer
- Total aggregated liquidity in the Meteora pool (the pool itself is public)

## Architecture

```
DEPOSIT:
User wallet --> ZK Mixer (breaks identity link) --> Ephemeral wallet --> Zodiac vault
                                                                    (Arcium encrypts amount)
                                                                            |
                                                                            v
                                                                      Relay PDA --> Meteora pool
                                                                   (single aggregate position)

WITHDRAWAL:
Ephemeral wallet --> Zodiac vault (Arcium computes user's share)
                           |
                           v
                     Relay PDA --> Meteora pool (remove_liquidity CPI)
                           |
                           v
                     Relay PDA --> Ephemeral wallet (relay transfer)
                                        |
                                        v
                                  ZK Mixer --> User wallet
```

**Three layers of unlinkability:**

1. **ZK Mixer** — Breaks the wallet-to-deposit link via zero-knowledge proofs.
2. **Ephemeral Wallets** — Single-use wallets per operation, closed after one CPI.
3. **Relay PDA** — Single aggregated Meteora position across all users. No individual user touches the pool.

## Tech Stack

| Component | Purpose |
|-----------|---------|
| Anchor 0.32.1 | Solana program framework |
| Arcium 0.6.3 | Arcium mxe program framework |
| Meteora DAMM v2 | Liquidity pool integration |
| Arcis circuits | MPC computation definitions |

## Project Structure

```
zodiac-liquidity/
├── programs/
│   ├── zodiac_liquidity/          # Anchor program (Arcium MPC + Meteora CPI)
│   └── zodiac_mixer/              # ZK Mixer program (Phase 2, scaffolded)
├── encrypted-ixs/                 # Arcis MPC circuits (8 circuits)
├── tests/
│   ├── zodiac-liquidity.ts        # Happy-path unit tests (14 tests)
│   ├── zodiac-liquidity-fail.ts   # Fail/auth unit tests (7 tests)
│   └── zodiac-mpc-meteora-integration.ts  # 3-user end-to-end integration (37 tests)
├── scripts/                       # Utility scripts (cleanup, analysis)
└── build/                         # Compiled circuits (.arcis, .hash)
```

## Program IDs

| Network | Program ID |
|---------|-----------|
| Devnet | `7qpT6gRLFm1F9kHLSkHpcMPM6sbdWRNokQaqae1Zz3j2` |

## Test Status

| Environment | Tests | Status |
|-------------|-------|--------|
| Localnet | 41/41 (14 happy-path + 7 fail + 20 integration) | Passing |
| Devnet | 37/37 (3-user sequential integration) | Passing |

## Full Transaction Flow (13 Steps)

```
 1. [user]       mixer.transact(proof)              -- deposit SOL/SPL to mixer
 2. [relayer]    mixer.transact(proof)              -- withdraw to ephemeral wallet
 3. [authority]  zodiac.register_ephemeral_wallet() -- register ephemeral wallet PDA
 4. [ephemeral]  zodiac.deposit(encrypted_amt)      -- deposit to vault
 5. [authority]  zodiac.reveal_pending_deposits()    -- Arcium reveals aggregate
 6. [authority]  zodiac.fund_relay(idx, amount)      -- vault -> relay PDA
 7. [ephemeral]  zodiac.deposit_to_meteora(...)      -- relay PDA -> Meteora add_liquidity
 8. [authority]  zodiac.record_liquidity(delta)      -- record in Arcium
 --- withdrawal ---
 9. [ephemeral]  zodiac.withdraw(pubkey, nonce)      -- Arcium computes share
10. [ephemeral]  zodiac.withdraw_from_meteora(...)   -- relay removes liquidity
11. [authority]  zodiac.relay_transfer_to_dest()     -- relay -> ephemeral wallet
12. [authority]  zodiac.clear_position(base, quote)   -- zero Arcium state
13. [authority]  zodiac.close_ephemeral_wallet()     -- close PDA, reclaim rent
```
