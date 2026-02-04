# Zodiac Liquidity

**One app that privately does everything on Meteora DAMM v2:** Swap, LP, Create Pools, Claim Fees — so nobody knows who's trading/LPing.

Privacy protocol for **traders and LPers** powered by Arcium MPC and a ZK mixer. Supports SPL token and DAMM v2 pools now. Token-2022, C-SPL token, and DLMM pools coming soon.

## Vision

Zodiac is a **private super app** for Meteora DAMM v2. One interface: swap, add/remove liquidity, create pools, and claim fees — with identity and amounts hidden. The same three layers (ZK mixer → ephemeral wallets → relay PDA) apply to every action.

**Today:** Full privacy for LP (deposit/withdraw) with a **single-sign UX** — user signs 1-2 wallet transactions, sends commitment secrets to the operator, and walks away. The operator handles everything else: privacy delay, server-side ZK proof generation, mixer withdrawal, MPC encryption, and Meteora LP deployment.

**Next:** Private swap, private pool creation, and automated fee claiming — all without ARX nodes for swap/fee/close (pure Meteora CPI). Operator will add PostgreSQL, real pool data (Geyser), and multi-service tx landing; frontend will get Swap tab, pool creation page, and real TVL/volume.

## The Problem

On-chain DeFi is fully transparent. Swaps, liquidity provision, and pool creation all expose your wallet, amounts, and strategy. That leaks alpha and makes you a target.

## How Zodiac Solves It

Zodiac combines **MPC encryption** and a **ZK mixer** for full privacy across swap and LP.

- **Encrypted state** — Deposit amounts and positions are encrypted by Arcium's MPC network. No single party can decrypt, not even the protocol operator.
- **Identity unlinkability** — The ZK mixer breaks the link between user wallets and actions. Single-use ephemeral wallets prevent cross-operation tracing.
- **User-only results** — When a user queries their position or withdraws, the MPC network re-encrypts the result for that user's key. Only the user can read it.

### What's Hidden vs Visible

**Hidden (encrypted or unlinkable, never revealed on-chain):**
- Individual deposit, withdrawal, and swap amounts
- Each user's liquidity position size
- User-to-Meteora position link (a protocol relay PDA holds all pool positions, not individual users)

**Visible:**
- That the wallet interacted with the mixer
- Total aggregated liquidity in the Meteora pool (the pool itself is public)

## Architecture

```
User → App (swap / LP / create pool)
         ↓
       ZK Mixer (breaks identity link) → Ephemeral wallet
         ↓
       Operator (fund relay → execute on Meteora → return to user)
         ↓                    ↑
       Meteora DAMM v2    Geyser (real-time pool data, optional)
```

**LP (current — single-sign flow):**

```
DEPOSIT:  User --sign--> Mixer --> Operator --> Vault (MPC) --> Meteora pool
WITHDRAW: Operator --> Vault (MPC) --> Meteora pool --> Destination wallet
```

User signs 1-2 wallet txs to deposit into the mixer, then the operator handles everything: ZK proof generation, mixer withdrawal, MPC encryption, and Meteora LP deployment.

**Swap / Fee / Close (on-chain ready, operator + UI in progress):** Same relay PDA pattern — operator funds relay, calls `swap_via_relay` / `claim_position_fee_via_relay` / `close_position_via_relay`. No MPC needed for swap; no ARX nodes required.

**Three layers of unlinkability:**

1. **ZK Mixer** — Breaks the wallet-to-action link via zero-knowledge proofs.
2. **Ephemeral Wallets** — Single-use wallets per operation, closed after use.
3. **Relay PDA** — Single aggregated Meteora position across all users. No individual user touches the pool.

## Tech Stack

| Component | Purpose |
|-----------|---------|
| Anchor 0.32.x | Solana program framework |
| Arcium 0.7.x | MXE program (comp defs, LUT from `lut_offset_slot`) |
| Meteora DAMM v2 | Liquidity pool integration (swap, LP, create pool, claim fees) |
| Arcis circuits | MPC computation definitions for LP |

## Repositories

| Repo | Description |
|------|-------------|
| [zodiac-liquidity](https://github.com/outsmartchad/zodiac-liquidity) (this repo) | On-chain programs, MPC circuits, and tests |
| [zodiac](https://github.com/outsmartchad/zodiac) | Monorepo: operator, app, relayer |

## Project Structure

```
zodiac-liquidity/
├── programs/
│   ├── zodiac_liquidity/          # Anchor program (Arcium MPC + Meteora CPI)
│   └── zodiac_mixer/              # ZK Mixer program (Groth16, Merkle tree, SOL/SPL, pause)
├── encrypted-ixs/                 # Arcis MPC circuits (8 circuits)
├── tests/
│   ├── zodiac-liquidity.ts        # Happy-path unit tests (14 tests)
│   ├── zodiac-liquidity-fail.ts   # Fail/auth unit tests (7 tests)
│   ├── zodiac-mixer.ts            # Mixer tests — SOL + SPL (25 tests)
│   ├── zodiac-mpc-meteora-integration.ts  # 3-user end-to-end integration (37 tests)
│   └── zodiac-full-privacy-integration.ts # Full mixer->zodiac->meteora flow (39 tests)
├── scripts/                       # Utility scripts (cleanup, analysis)
└── build/                         # Compiled circuits (.arcis, .hash)
```

## Program IDs

See `Anchor.toml` and operator/relayer config for current IDs.

| Program | Network | Program ID |
|---------|---------|-----------|
| zodiac_liquidity | Devnet | `4xNVpFyVTdsFPJ1UoZy9922xh2tDs1URMuujkfYYhHv5` |
| zodiac_mixer | Devnet | `AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb` |

## Test Status

| Environment | Tests | Status |
|-------------|-------|--------|
| Localnet | 39/39 full privacy integration (mixer + MPC + Meteora) | Passing |
| Localnet | 62/62 (25 mixer + 37 integration) | Passing |
| Devnet | 25/25 mixer (17 SOL + 8 SPL) | Passing |
| Devnet | 37/37 integration (3-user sequential) | Passing |

## Roadmap

Implementation order is documented in `.claude/plans/idempotent-whistling-dawn.md`. Summary:

- **Phase 1 (on-chain):** `swap_via_relay`, `claim_position_fee_via_relay`, `close_position_via_relay` — pure Meteora CPI, no ARX.
- **Phase 2 (operator):** PostgreSQL, swap pipeline (request → fund relay → swap → transfer), fee-claim scheduler, tx landing (Helius/Nozomi), optional Geyser pool watcher.
- **Phase 3 (frontend):** Swap tab, pool creation page, real pool data (TVL, volume, fees) from operator.
- **Phase 4 (polish):** Auto-fill quotes, fee display, real operation polling.

All of the above is testable on localnet without ARX nodes.

## Full Transaction Flow (Single-Sign LP)

```
DEPOSIT (user signs 1-2 txs, operator handles steps 4-13):
 1. [user]       mixer.transact(proof)              -- deposit base SPL to mixer (wallet signs)
 2. [user]       mixer.transact(proof)              -- deposit quote SOL to mixer (wallet signs)
 3. [app]        POST /deposit/private               -- send commitment secrets to operator
 4. [operator]   -- waits for privacy delay --       -- anonymity set growth
 5. [operator]   generates ZK proofs (snarkjs)       -- server-side Groth16 proof generation
 6. [relayer]    mixer.transact(proof)               -- withdraw base + quote to intermediate wallet
 7. [authority]  zodiac.register_ephemeral_wallet()  -- register ephemeral wallet PDA
 8. [ephemeral]  zodiac.deposit(encrypted_amt)       -- deposit to vault (Arcium encrypts)
 9. [authority]  zodiac.reveal_pending_deposits()     -- Arcium reveals aggregate
10. [authority]  zodiac.fund_relay(idx, amount)       -- vault -> relay PDA
11. [ephemeral]  zodiac.deposit_to_meteora(...)       -- relay PDA -> Meteora add_liquidity
12. [authority]  zodiac.record_liquidity(delta)       -- record in Arcium

WITHDRAWAL:
13. [ephemeral]  zodiac.withdraw(pubkey, nonce)       -- Arcium computes share
14. [ephemeral]  zodiac.withdraw_from_meteora(...)    -- relay removes liquidity
15. [authority]  zodiac.relay_transfer_to_dest()      -- relay -> destination wallet
16. [authority]  zodiac.clear_position(base, quote)    -- zero Arcium state
17. [authority]  zodiac.close_ephemeral_wallet()      -- close PDA, reclaim rent
```
