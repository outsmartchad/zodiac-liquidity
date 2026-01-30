# Arcium Documentation

Local copy of Arcium documentation for Zodiac Liquidity development.

**Source:** https://docs.arcium.com
**Version:** 0.6.3
**Full index:** https://docs.arcium.com/llms.txt

## Contents

### Core Development
| File | Topic |
|------|-------|
| [01-installation.md](./01-installation.md) | Installation & setup |
| [02-mental-model.md](./02-mental-model.md) | Core MPC concepts |
| [03-types.md](./03-types.md) | Supported types |
| [04-operations.md](./04-operations.md) | Supported operations |
| [05-hello-world.md](./05-hello-world.md) | Tutorial |
| [06-best-practices.md](./06-best-practices.md) | Optimization tips |
| [11-quick-reference.md](./11-quick-reference.md) | Cheatsheet |

### Encryption & I/O
| File | Topic |
|------|-------|
| [07-encryption.md](./07-encryption.md) | Encryption system, sealing |
| [13-input-output.md](./13-input-output.md) | Input/output patterns |
| [12-primitives.md](./12-primitives.md) | RNG, hashing, signing |

### Program Development
| File | Topic |
|------|-------|
| [14-program-accounts.md](./14-program-accounts.md) | Account structures |
| [15-callback-types.md](./15-callback-types.md) | Auto-generated types |
| [09-computation-lifecycle.md](./09-computation-lifecycle.md) | How computations flow |

### Client & Deployment
| File | Topic |
|------|-------|
| [16-js-client.md](./16-js-client.md) | TypeScript client library |
| [08-deployment.md](./08-deployment.md) | Devnet deployment |

### Architecture & Protocols
| File | Topic |
|------|-------|
| [17-mpc-protocols.md](./17-mpc-protocols.md) | Cerberus, security model |
| [18-architecture.md](./18-architecture.md) | Network architecture |
| [10-examples-overview.md](./10-examples-overview.md) | Example patterns |

### Reference
| File | Topic |
|------|-------|
| [19-migration-v0.6.md](./19-migration-v0.6.md) | v0.5 to v0.6 migration |
| [20-mcp-server.md](./20-mcp-server.md) | MCP server for AI docs search |

## Quick Reference

### Project Structure
```
project/
├── Anchor.toml
├── Arcium.toml           # MPC cluster config
├── Cargo.toml
├── programs/
│   └── your_program/
│       └── src/lib.rs    # Anchor + Arcium program
├── encrypted-ixs/
│   └── src/lib.rs        # Arcis MPC circuits
└── tests/
```

### Key Dependencies

**Rust (programs/*/Cargo.toml):**
```toml
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
arcium-client = { default-features = false, version = "=0.6.3" }
arcium-macros = "=0.6.3"
arcium-anchor = "=0.6.3"
```

**Rust (encrypted-ixs/Cargo.toml):**
```toml
arcis = "=0.6.3"
blake3 = "=1.8.2"
```

**TypeScript:**
```json
"@arcium-hq/client": "0.6.3"
```

### Commands
```bash
arcium init <name>              # Create project
arcium build                    # Build program + circuits
arcium test                     # Test locally
arcium test --cluster devnet    # Test on devnet
arcium deploy                   # Deploy to devnet
```

### Three-Instruction Pattern

Every MPC operation requires:

1. **init_*_comp_def** — One-time setup
2. **your_instruction** — Queue computation with encrypted args
3. **your_instruction_callback** — Receive and verify results

### Encryption Flow

```
Client                    MXE Program                 MPC Cluster
  │                           │                           │
  │─── Encrypt inputs ───────>│                           │
  │                           │─── Queue computation ────>│
  │                           │                           │
  │                           │<─── Callback + results ───│
  │<── Decrypt results ───────│                           │
```

### Key Patterns from Examples

| Pattern | Example | Use Case |
|---------|---------|----------|
| Stateless computation | Coinflip | RNG, single operations |
| Encrypted state accumulation | Voting | Counters, aggregation |
| Re-encryption (sealing) | Medical Records | Data sharing |
| Encrypted comparison | Sealed Auction | Private ordering |
| Bit-packing compression | Blackjack | Large arrays |
| Distributed signing | Ed25519 | Key management |

## Local Examples

See `/root/examples/` for complete implementations:
- `coinflip/` - Stateless randomness
- `voting/` - Encrypted state accumulation
- `sealed_bid_auction/` - Private comparisons
- `blackjack/` - Bit-packing compression
- `share_medical_records/` - Re-encryption
- `ed25519/` - Distributed signing
