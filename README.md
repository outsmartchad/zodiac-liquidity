# Zodiac Liquidity

Privacy-focused DeFi liquidity provision for Meteora DAMM v2 pools using Arcium Cerberus MPC.

## Architecture

```
User A ──┐
User B ──┼── deposit(encrypted) ──> Zodiac Vault ──> Protocol PDA ──> Meteora DAMM v2
User C ──┘                          (Arcium MPC)     (deploys LP)
```

**Privacy achieved:**
- Individual deposit amounts hidden (Arcium MPC)
- User → Meteora LP position unlinkable (Protocol PDA deploys)
- User positions hidden from each other

## Tech Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| Anchor | 0.32.1 | Solana program framework |
| Arcium | 0.6.3 | MPC privacy layer (Cerberus) |
| Meteora DAMM v2 | - | Liquidity pool integration |

## Project Structure

```
zodiac-liquidity/
├── programs/
│   └── zodiac_liquidity/
│       └── src/lib.rs          # Anchor + Arcium program
├── encrypted-ixs/
│   └── src/lib.rs              # Arcis MPC circuits
├── tests/
│   └── zodiac-liquidity.ts     # Integration tests
├── Anchor.toml
├── Arcium.toml
└── CLAUDE.md                   # Project context
```

## Commands

```bash
# Build
arcium build

# Test locally
arcium test

# Test on devnet
arcium test --cluster devnet
```

## Reference

- **Meteora DAMM v2 CPI**: `/root/anchor-learning/meteora-damm-v2-cpi`
- **Arcium Examples**: `/root/examples/`
- **Arcium Skill**: `/root/.claude/skills/arcium-dev/`
