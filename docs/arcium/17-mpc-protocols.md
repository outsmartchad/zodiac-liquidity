# MPC Protocols & Security

## Security Models

### Honest but Curious
All participants behave according to the protocol while trying to gather as much information as possible from exchanged data.

### Honest Majority
Requires at least N/2 honest participants to maintain privacy and integrity guarantees.

### Dishonest Majority
Protocols tolerating up to N-1 malicious actors while preserving correctness, provided at least one participant remains honest.

## Cryptographic Approaches

### Computationally Secure
- Depends on mathematical problem difficulty (factoring)
- Currently robust but potentially vulnerable to quantum computing

### Information-Theoretically Secure
- Achieves security through information theory principles
- No computational assumptions
- Greater robustness with reduced efficiency

## Implementation Model

State-of-the-art MPC uses **preprocessing models**:
- Expensive cryptographic operations conducted in advance (offline phase)
- Online phase executes computations efficiently using precomputed values

**Secret sharing** enables:
- Local addition operations
- Constant multiplication
- MAC-based verification preventing forgery

## Arcium's MPC Backends

### Cerberus (Primary Backend)

**Recommended for DeFi and sensitive applications.**

| Property | Description |
|----------|-------------|
| Security Model | Dishonest majority (N-1 malicious tolerated) |
| Guarantee | Requires only 1 honest node |
| Authentication | MAC on each share |
| Cheating Detection | Honest nodes detect and abort |
| Security Type | Computational + information-theoretic |

```rust
// Cerberus is default in Arcium.toml
backends = ["Cerberus"]
```

### Manticore (Secondary Backend)

**For trusted environments with aligned incentives (AI/ML workloads).**

| Property | Description |
|----------|-------------|
| Security Model | Honest but curious |
| Requirement | Trusted Dealer for preprocessing |
| Performance | Faster for compute-intensive tasks |
| Use Case | ML inference, trusted operators |

**Do NOT use Manticore for DeFi applications.**

## MXE Encryption

Arcium's encryption operates at the MXE level with configurable, per-MXE settings:

- **Lightweight encryption** for performance-focused applications
- **Stronger encryption** for sensitive data requiring enhanced protection

Each MXE operates in isolation without shared state.

### Side-Channel Attack Mitigation

The system addresses timing attacks through **constant-time operations**, eliminating vulnerabilities from processing time variations.

## Key Security Properties

1. **No single point of failure** - Distributed across multiple nodes
2. **Abort-on-cheat** - Malicious behavior detected via MAC verification
3. **Preprocessing model** - Expensive ops done offline for efficient online computation
4. **Constant-time** - Prevents timing-based information leakage
5. **No TEE dependency** - Pure cryptographic security (no hardware trust)
