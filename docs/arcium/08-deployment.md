# Arcium Deployment Guide

## Prerequisites

Before deploying to Solana devnet:

- Successfully built MXE using `arcium build`
- Passing local tests via `arcium test`
- Solana keypair with 2-5 SOL
- Reliable RPC access (default Solana devnet endpoints frequently drop transactions)

**Recommended RPC providers:** Helius or QuickNode (free API keys available)

## Circuit Storage Strategy

For large circuits, store `.arcis` files offchain to reduce transaction costs:

1. Run `arcium build` to generate circuit files and hashes
2. Upload `.arcis` files to public storage (IPFS, S3, Supabase)
3. Update init functions with URLs and the `circuit_hash!` macro

**Critical:** Use the `circuit_hash!` macro (reads from `build/{circuit_name}.hash`) rather than placeholder values — nodes verify this hash.

## Basic Deployment Command

```bash
arcium deploy --cluster-offset <offset> --recovery-set-size <size> \
  --keypair-path <path> --rpc-url <url>
```

### Key Parameters

| Parameter | Description |
|-----------|-------------|
| `--cluster-offset` | `456` (v0.6.3, recommended) or `123` (v0.5.4) |
| `--recovery-set-size` | Use `4` for devnet |
| `--rpc-url` | Use dedicated provider's endpoint |

### Recommended Example

```bash
arcium deploy --cluster-offset 456 --recovery-set-size 4 \
  --keypair-path ~/.config/solana/id.json \
  --rpc-url https://devnet.helius-rpc.com/?api-key=<your-key>
```

## Advanced Options

### Adjust mempool capacity
```bash
--mempool-size Medium  # Options: Tiny, Small, Medium, Large
```

### Specify program address
```bash
--program-keypair ./program-keypair.json
```

### Partial deployments
```bash
--skip-deploy    # Initialize MXE only
--skip-init      # Deploy program only
```

## Post-Deployment Configuration

Update TypeScript client code with correct cluster offset:

```typescript
const clusterOffset = 456;  // Match your deployment
const clusterAccount = getClusterAccAddress(clusterOffset);
const mxeAccount = getMXEAccAddress(program.programId);
```

Initialize computation definitions after deployment completes.

## Verification

```bash
solana program show <program-id> --url <your-rpc-url>
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Dropped transactions | Switch to dedicated RPC provider |
| Insufficient SOL | `solana airdrop 2 <address> -u devnet` |
| Partial failures | Use `--skip-deploy` or `--skip-init` to complete remaining steps |
