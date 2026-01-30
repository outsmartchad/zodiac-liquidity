# Zodiac Liquidity

Privacy-focused liquidity provision for [Meteora DAMM v2](https://docs.meteora.ag/) pools using [Arcium](https://arcium.com/)'s MPC protocol and zk mixer.

## The Problem

On-chain liquidity provision is fully transparent. When you deposit into a pool, everyone can see your wallet, your deposit amount, and your position size. This leaks your alpha and lp strategy.

## How Zodiac Solves It

Zodiac uses **multi-party computation (MPC)** to keep every user's deposit amount and LP position encrypted on-chain. No single party — not even the protocol operator — can read a user's position. Only the Arcium MPC network can decrypt values, and it only does so under program-defined rules.

### Encryption Architecture

All vault and user position state is encrypted by the Arcium MPC network. The decryption key is split across multiple MPC nodes — no single party can read the data, not even the protocol operator.

- **Protocol state** (vault totals, user positions) — encrypted under the MPC network's collective key. Only a quorum of MPC nodes executing a program-authorized circuit can decrypt, compute, and re-encrypt.

- **User-facing results** (withdrawal amount, position query) — the MPC network computes the answer, then re-encrypts it for the requesting user's public key. Only that user can decrypt the result.

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

1. **ZK Mixer** — Breaks the link between user wallet and deposit. Users deposit into the mixer from their real wallet, then withdraw to a fresh ephemeral wallet using a ZK proof. No one can connect the two.

2. **Ephemeral Wallets** — Each Meteora CPI operation uses a one-time ephemeral wallet PDA. The authority registers it, it executes one operation, then it's closed. No cross-operation linkability.

3. **Relay PDA** — The only entity that interacts with Meteora. It holds a single aggregated position across all users. Individual users never touch the pool directly, so their positions cannot be linked to specific pool operations.

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
│   ├── zodiac-liquidity.ts        # Liquidity integration tests
│   └── zodiac-mixer.ts            # Mixer tests
└── build/                         # Compiled circuits (.arcis, .hash)
```

## Program IDs

| Network | Program ID |
|---------|-----------|
| Devnet | `5iaJJzwRVTT47WLArixF8YoNJFMfLi8PTTmPRi9bdRGu` |
