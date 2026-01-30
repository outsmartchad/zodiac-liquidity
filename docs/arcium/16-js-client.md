# JavaScript Client Library

## Installation

```bash
npm install @arcium-hq/client
# or
yarn add @arcium-hq/client
# or
pnpm add @arcium-hq/client
```

## Core Encryption Workflow

```typescript
import {
  RescueCipher,
  x25519,
  getMXEPublicKey,
  getArciumEnv,
  deserializeLE,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";

// 1. Get environment and cluster info
const arciumEnv = getArciumEnv();
const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

// 2. Generate client keypair
const privateKey = x25519.utils.randomSecretKey();
const publicKey = x25519.getPublicKey(privateKey);

// 3. Get MXE public key from cluster
const mxePublicKey = await getMXEPublicKey(provider, program.programId);

// 4. Derive shared secret
const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);

// 5. Create cipher
const cipher = new RescueCipher(sharedSecret);

// 6. Encrypt values
const nonce = randomBytes(16);
const plaintext = [BigInt(value1), BigInt(value2)];
const ciphertext = cipher.encrypt(plaintext, nonce);

// 7. Submit to program
await program.methods
  .myInstruction(
    computationOffset,
    Array.from(ciphertext[0]),
    Array.from(ciphertext[1]),
    Array.from(publicKey),
    new anchor.BN(deserializeLE(nonce).toString())
  )
  .rpc();
```

## Decryption

```typescript
// After receiving callback event
const decrypted = cipher.decrypt([event.data], event.nonce);
```

## Awaiting Computation Results

```typescript
import { awaitComputationFinalization } from "@arcium-hq/client";

// Generate random computation offset
const computationOffset = new anchor.BN(randomBytes(8), "hex");

// Submit computation
const queueSig = await program.methods
  .myInstruction(computationOffset, ...params)
  .rpc({ commitment: "confirmed" });

// Wait for MPC completion
const finalizeSig = await awaitComputationFinalization(
  provider,
  computationOffset,
  program.programId,
  "confirmed"
);
```

## Account Address Helpers

```typescript
import {
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
} from "@arcium-hq/client";

// MXE account
const mxeAccount = getMXEAccAddress(program.programId);

// Cluster accounts
const clusterOffset = arciumEnv.arciumClusterOffset;
const clusterAccount = getClusterAccAddress(clusterOffset);
const mempoolAccount = getMempoolAccAddress(clusterOffset);
const executingPool = getExecutingPoolAccAddress(clusterOffset);

// Computation account (per-computation)
const computationAccount = getComputationAccAddress(
  clusterOffset,
  computationOffset
);

// Computation definition account
const compDefOffset = getCompDefAccOffset("my_instruction");
const compDefAccount = getCompDefAccAddress(
  program.programId,
  Buffer.from(compDefOffset).readUInt32LE()
);
```

## Event Handling

```typescript
type Event = anchor.IdlEvents<(typeof program)["idl"]>;

const awaitEvent = async <E extends keyof Event>(
  eventName: E
): Promise<Event[E]> => {
  let listenerId: number;
  const event = await new Promise<Event[E]>((res) => {
    listenerId = program.addEventListener(eventName, (event) => {
      res(event);
    });
  });
  await program.removeEventListener(listenerId);
  return event;
};

// Usage
const resultEventPromise = awaitEvent("myResultEvent");
// ... submit computation ...
const resultEvent = await resultEventPromise;
```

## Full API Reference

See https://ts.arcium.com/api for complete TypeScript SDK documentation.
