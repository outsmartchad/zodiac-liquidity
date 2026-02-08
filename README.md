# Zodiac Liquidity

**One app that privately does everything on Meteora DAMM v2:** Swap, LP, Create Pools, Claim Fees — so nobody knows who's trading/LPing powered by Arcium MPC and a ZK mixer. Supports SPL token and DAMM v2 pools now. Token-2022, C-SPL token, and DLMM pools coming soon.

## Vision

Zodiac Liquidity is a **private super app** for Meteora DAMM v2. One interface: swap, add/remove liquidity, create pools, and claim fees — with identity and amounts hidden.

**Today:** Private LP and private swaps. Sign once, walk away. Your deposit/swap gets encrypted and deployed to Meteora automatically.

**Next:** Private pool creation, fee claiming.

## The Problem

On-chain DeFi is fully transparent. Swaps, liquidity provision, and pool creation all expose your wallet, amounts, and strategy. That leaks alpha and makes you a target.

## How Zodiac Liquidity Solves It

Zodiac Liquidity combines **MPC encryption** and a **ZK mixer** for full privacy across swap and LP.

- **Encrypted state** — Deposit amounts and positions are encrypted by Arcium's MPC network. No single party can decrypt, not even the protocol operator.
- **Identity unlinkability** — The ZK mixer breaks the link between user wallets and actions. Users are identified by `user_id_hash` (SHA-256 of userId), never by wallet address.
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
       ZK Mixer (breaks identity link) → Authority wallet
         ↓
       Operator/Authority (fund relay → execute on Meteora → return to user)
         ↓
       Meteora DAMM v2
```

**LP (current — single-sign flow):**

```
DEPOSIT:  User --sign--> Mixer --> Authority (MPC encrypt via deposit_by_authority) --> Meteora pool
WITHDRAW: User --intent--> Authority (MPC compute via compute_withdrawal_by_authority) --> Meteora pool --> Destination wallet
```

User signs 1-2 wallet txs to deposit into the mixer, then everything else happens automatically: ZK proof generation, mixer withdrawal, MPC encryption, and Meteora LP deployment.

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
│   ├── zodiac_liquidity/          # Anchor program (Arcium MPC + Meteora CPI + Swap)
│   └── zodiac_mixer/              # ZK Mixer program (Groth16, Merkle tree, SOL/SPL, pause)
├── encrypted-ixs/                 # Arcis MPC circuits (8 circuits)
├── tests/
│   ├── zodiac-liquidity.ts        # Happy-path unit tests (20 tests: 14 legacy + 6 authority-first)
│   ├── zodiac-liquidity-fail.ts   # Fail/auth unit tests (10 tests: 4 legacy + 6 authority-first)
│   ├── zodiac-mixer.ts            # Mixer tests — SOL + SPL (25 tests)
│   ├── zodiac-mpc-meteora-integration.ts  # 3-user end-to-end integration (37 tests, authority-first)
│   ├── zodiac-full-privacy-integration.ts # Full mixer->zodiac->meteora flow (39 tests, authority-first)
│   └── zodiac-swap.ts             # Swap tests — swap_via_relay (4 tests: bidirectional, slippage, auth)
├── scripts/                       # Utility scripts (cleanup, analysis)
└── build/                         # Compiled circuits (.arcis, .hash)
```

## Program IDs

See `Anchor.toml` and operator/relayer config for current IDs.

| Program | Network | Program ID |
|---------|---------|-----------|
| zodiac_liquidity | Devnet | `DxcbU1qqaGf35Wu6EBP3aj3AHYdVRZVyux6xZKRhCty` |
| zodiac_mixer | Devnet | `AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb` |

## Test Status

| Environment | Tests | Status |
|-------------|-------|--------|
| Devnet | 135/135 total | Passing (2026-02-06) |
| Devnet | 20/20 liquidity (14 legacy + 6 authority-first) | Passing |
| Devnet | 10/10 liquidity-fail (4 legacy + 6 authority-first) | Passing |
| Devnet | 37/37 integration (3-user sequential, authority-first) | Passing |
| Devnet | 25/25 mixer (17 SOL + 8 SPL) | Passing |
| Devnet | 39/39 full privacy (mixer + MPC + Meteora, authority-first) | Passing |
| Devnet | 4/4 swap (SOL→ZDC, ZDC→SOL, slippage, auth) | Passing |

## Roadmap

Implementation order is documented in `.claude/plans/idempotent-whistling-dawn.md`. Summary:

- **Phase 1 (on-chain):** ~~`swap_via_relay`~~(done), `claim_position_fee_via_relay`, `close_position_via_relay` — pure Meteora CPI, no ARX.
- **Phase 2 (operator):** ~~swap pipeline~~(done), PostgreSQL, fee-claim scheduler, tx landing (Helius/Nozomi), optional Geyser pool watcher.
- **Phase 3 (frontend):** ~~Swap tab~~(done), pool creation page, real pool data (TVL, volume, fees) from operator.
- **Phase 4 (polish):** Auto-fill quotes, fee display, real operation polling.

All of the above is testable on localnet without ARX nodes.

## Full Transaction Flow (Single-Sign LP)

```
DEPOSIT (user signs 1-2 txs, authority handles steps 4-13):
 1. [user]       mixer.transact(proof)                        -- deposit base SPL to mixer (wallet signs)
 2. [user]       mixer.transact(proof)                        -- deposit quote SOL to mixer (wallet signs)
 3. [app]        POST /deposit/private                         -- send commitment secrets to operator
 4. [operator]   -- waits for privacy delay --                 -- anonymity set growth
 5. [operator]   generates ZK proofs (snarkjs)                 -- server-side Groth16 proof generation
 6. [relayer]    mixer.transact(proof)                         -- withdraw base + quote to authority wallet
 7. [authority]  zodiac.create_user_position_by_authority()     -- create position (user_id_hash PDA)
 8. [authority]  zodiac.deposit_by_authority(encrypted_amt)     -- deposit from authority's token accounts
 9. [authority]  zodiac.reveal_pending_deposits()               -- Arcium reveals aggregate
10. [authority]  zodiac.fund_relay(idx, amount)                 -- vault -> relay PDA
11. [authority]  zodiac.deposit_to_meteora(...)                 -- authority signs Meteora add_liquidity
12. [authority]  zodiac.record_liquidity(delta)                 -- record in Arcium

WITHDRAWAL:
13. [authority]  zodiac.compute_withdrawal_by_authority()       -- Arcium computes share
14. [authority]  zodiac.withdraw_from_meteora(...)              -- authority signs Meteora remove_liquidity
15. [authority]  zodiac.relay_transfer_to_dest()                -- relay -> destination wallet
16. [authority]  zodiac.clear_position(base, quote)             -- zero Arcium state

SWAP (no MPC — stateless, privacy from mixer + relay PDA):
17. [user]       mixer.transact(proof)                          -- deposit input token to mixer (wallet signs)
18. [app]        POST /swap/request                              -- send commitment secret to operator
19. [operator]   -- waits for privacy delay --                   -- anonymity set growth
20. [relayer]    mixer.transact(proof)                           -- withdraw input from mixer to authority
21. [authority]  zodiac.fund_relay(idx, amount)                  -- vault -> relay PDA
22. [authority]  zodiac.swap_via_relay(amount, min_out)          -- relay PDA signs Meteora swap CPI
23. [authority]  zodiac.relay_transfer_to_dest()                 -- relay -> destination wallet
```
