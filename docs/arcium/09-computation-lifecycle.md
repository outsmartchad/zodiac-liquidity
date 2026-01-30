# Arcium Computation Lifecycle

## Overview

Arcium's computation process involves coordinated interactions between multiple actors. The system encrypts client parameters, submits them through an MXE program to an MPC cluster for processing, and returns verified results.

## Key Actors

### Client
The user initiating computation, integrated via the Arcium TypeScript Client Library.

### MXE Program
The application layer containing:
- A blockchain smart contract for formatting and submitting computations
- "Computation definitions" (confidential instructions) written in Arcis
- MXE metadata including the target MPC cluster

### Arcium Program
Manages assignment, scheduling, and verification of computations across MPC clusters.

### MPC Cluster
The parties performing actual computations using secure multi-party computation protocols.

### Callback Server
Optional infrastructure handling overflow data when computation results exceed single-transaction capacity.

## Lifecycle Flow

```
┌─────────┐    ┌─────────────┐    ┌───────────────┐    ┌─────────────┐
│ Client  │───>│ MXE Program │───>│Arcium Program │───>│ MPC Cluster │
└─────────┘    └─────────────┘    └───────────────┘    └─────────────┘
     │                                                        │
     │                                                        │
     │<──────────────────── Callback ────────────────────────│
```

### Phase 1: Encryption
Client encrypts parameters locally using shared secret with MXE

### Phase 2: Submission
Client invokes the MXE program with encrypted data

### Phase 3: Processing
MXE program queues the computation in the cluster's mempool

### Phase 4: Computation
MPC cluster fetches and processes the computation

### Phase 5: Callback & Verification
Results return to the Arcium program for verification

### Phase 6: Completion
MXE program notifies the client via event emission

## TypeScript Flow Example

```typescript
// 1. Encrypt inputs
const cipher = new RescueCipher(sharedSecret);
const ciphertext = cipher.encrypt(plaintext, nonce);

// 2. Submit computation
const queueSig = await program.methods
    .myInstruction(computationOffset, ...encryptedParams)
    .rpc({ commitment: "confirmed" });

// 3. Wait for MPC processing
const finalizeSig = await awaitComputationFinalization(
    provider,
    computationOffset,
    program.programId,
    "confirmed"
);

// 4. Receive results (via event)
const resultEvent = await eventPromise;

// 5. Decrypt results
const decrypted = cipher.decrypt([resultEvent.data], resultEvent.nonce);
```

## Callback Server

When output exceeds Solana's transaction size limits (~1KB):

1. MPC nodes pack as much data as possible into the normal callback transaction
2. Remaining data is sent to your callback server
3. Callback server verifies signatures and processes data
4. Server calls `finalize` transaction for hash verification

### Callback API Endpoint

**POST /callback** receives:
- `mempool_id` (u16)
- `comp_def_offset` (u32)
- `tx_sig` (64 bytes) - callback transaction signature
- `data_sig` (64 bytes) - data signature from MPC node
- `pub_key` (32 bytes) - signing node's public key
- `data` (variable length) - computation output

Returns 200 OK on successful processing.
