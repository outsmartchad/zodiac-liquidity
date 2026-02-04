# Zodiac Liquidity - Setup Guide

## Prerequisites

1. **Arcium CLI** (0.6.3)
   ```bash
   # Install arcium CLI
   # See: https://docs.arcium.com/developers/installation
   ```

2. **Anchor CLI** (0.32.1)
   ```bash
   anchor --version
   ```

3. **Solana CLI**
   ```bash
   solana --version
   ```

4. **Node.js & Yarn**
   ```bash
   node --version  # v24+
   yarn --version
   ```

## Project Setup

```bash
cd /root/zodiac/onchain

# Install dependencies
yarn install

# Build with Arcium
arcium build

# Run tests
arcium test
```

## Dependencies

### Rust (Cargo.toml)
```toml
[workspace.dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
anchor-spl = "0.32.1"

# Program
arcium-client = { default-features = false, version = "=0.6.3" }
arcium-macros = "=0.6.3"
arcium-anchor = "=0.6.3"

# Arcis circuits
arcis = "=0.6.3"
```

### TypeScript (package.json)
```json
{
  "dependencies": {
    "@arcium-hq/client": "0.6.3",
    "@coral-xyz/anchor": "^0.32.0",
    "@solana/web3.js": "^1.98.0"
  }
}
```

## Testing

```bash
# Local test (spins up local MPC cluster)
arcium test

# Devnet test
arcium test --cluster devnet
```

## Deployment

```bash
# Deploy to devnet
arcium deploy --cluster-offset 456 --recovery-set-size 4 --cluster devnet
```

## Reference

- **Meteora DAMM v2 CPI**: `/root/anchor-learning/meteora-damm-v2-cpi`
- **Arcium Examples**: `/root/examples/`
