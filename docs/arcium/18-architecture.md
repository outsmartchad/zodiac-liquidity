# Arcium Network Architecture

## Core Components

### MPC eXecution Environments (MXEs)

Isolated computational spaces where operations are defined and executed securely.

**Features:**
- Parallel processing (clusters can concurrently compute for various MXEs)
- Flexible security requirement configuration
- Customizable encryption schemes
- Single-use or recurring configurations

**Single-Use MXEs:** Handle isolated computations executed once without state.

**Recurring MXEs:** Manage repeated computations with fresh input data across cycles.

### arxOS

The distributed encrypted operating system that:
- Manages Arx Nodes and Clusters
- Orchestrates computations across the network
- Provides computational resources

### Arcis Framework

Rust-based developer toolkit for building MPC applications:
- Circuit compiler for MPC deployment
- Type-safe encrypted computation
- Integration with Anchor/Solana

### Clusters of Arx Nodes

Groups offering customizable trust models:
- **Cerberus** - Dishonest majority protocol
- **Manticore** - Honest but curious protocol

## Solana Integration

The network leverages Solana as its consensus mechanism:
- All state management and orchestration handled onchain
- Task prioritization and sequencing
- Protocol violation detection
- Decentralized mempool

## Staking & Security

- Nodes provide collateral for network participation
- Slashing mechanisms penalize non-compliance
- Economic incentives align node behavior

## Execution Workflow

### Phase 1: Cluster Assessment
Nodes verify preprocessing capacity and autonomously generate new values if needed.

### Phase 2: Computation Processing
Tasks selected from decentralized mempool with concurrent gate handling across nodes.

### Phase 3: Result Verification & Submission
Collectively verified results signed and submitted to blockchain within epoch deadline.

## Interaction Flow

```
┌─────────────┐
│    MXEs     │  Define requirements, encryption schemes
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Clusters   │  Execute MPC computations
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Solana    │  Coordinate state, enforce rules
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Staking    │  Ensure node accountability
└─────────────┘
```

## Key Concepts

### Arx Nodes
Decentralized processors performing computations on protected data. Must stake collateral; violations result in slashing.

### Multi-Party Computation (MPC)
Cryptographic foundation enabling joint computation while maintaining input confidentiality.

### Secret Sharing
Data fragmentation across nodes - no single node accesses complete information.

### Threshold Encryption
Minimum node collaboration required for decryption during computations.

### Byzantine Fault Tolerance
Network resilience allowing continued secure operation despite malicious/failed nodes.

### Epochs
Fixed-duration intervals organizing computation scheduling, rewards, and token management.

## Stateless Design

The Arcium Network operates statelessly:
- Each computation must complete within a single epoch
- Cannot persist across multiple tasks at protocol level
- External persistence mechanisms can be implemented by customers
