# Migration Guide: v0.5.x to v0.6.3

## Key Breaking Changes

### 1. Program ID Update

The Arcium program ID changed:
- **Old:** `BpaW2ZmCJnDwizWY8eM34JtVqp2kRgnmQcedSVc9USdP`
- **New:** `Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ`

**Requires program redeploy.**

### 2. Account Type Rename

`SignerAccount` → `ArciumSignerAccount`

Update throughout Rust code and PDA seed derivation:

```rust
// Old
pub sign_pda_account: Account<'info, SignerAccount>,

// New
pub sign_pda_account: Account<'info, ArciumSignerAccount>,
```

### 3. Crate Consolidation

The `arcis-imports` crate was removed. Migrate to `arcis` crate:

```toml
# Old
arcis-imports = "=0.5.x"

# New
arcis = "=0.6.3"
blake3 = "=1.8.2"  # Pin exact version
```

### 4. Clock Account Modification

Add `mut` attribute to `clock_account`:

```rust
// Old
#[account(address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
pub clock_account: Account<'info, ClockAccount>,

// New
#[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
pub clock_account: Account<'info, ClockAccount>,
```

## Dependency Updates

### Rust (Cargo.toml)

```toml
[dependencies]
arcium-client = { default-features = false, version = "=0.6.3" }
arcium-macros = "=0.6.3"
arcium-anchor = "=0.6.3"
```

### Rust (encrypted-ixs/Cargo.toml)

```toml
[dependencies]
arcis = "=0.6.3"
blake3 = "=1.8.2"
```

### TypeScript (package.json)

```json
{
  "dependencies": {
    "@arcium-hq/client": "0.6.3"
  }
}
```

## New Feature: Cluster Configuration

Version 0.6.3 introduces optional cluster configuration in `Arcium.toml`:

```toml
[localnet]
nodes = 2
backends = ["Cerberus"]

# Optional: Test against devnet/mainnet
[clusters.devnet]
offset = 456

[clusters.mainnet]
offset = 0
```

Run tests with `--cluster` flag:

```bash
arcium test --cluster devnet
```

Localnet remains the default.

## Verification Steps

After migration:

```bash
# 1. Build
arcium build

# 2. Check for errors
cargo check --all

# 3. Run tests
arcium test
```

## Cluster Offsets

| Version | Offset |
|---------|--------|
| v0.6.3 | 456 (recommended) |
| v0.5.4 | 123 |
