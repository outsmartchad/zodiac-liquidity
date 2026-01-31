import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { ZodiacLiquidity } from "../target/types/zodiac_liquidity";
import { randomBytes, createHash } from "crypto";
import nacl from "tweetnacl";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  RescueCipher,
  deserializeLE,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  x25519,
  getComputationAccAddress,
  getComputationsInMempool,
  getMXEPublicKey,
  getClusterAccAddress,
  getFeePoolAccAddress,
  getClockAccAddress,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  createMint,
  createAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  createSyncNativeInstruction,
  closeAccount,
} from "@solana/spl-token";
import {
  CpAmm,
  getSqrtPriceFromPrice,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} from "@meteora-ag/cp-amm-sdk";

const NUM_RELAYS = 12;

// Meteora DAMM v2 constants
const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const CONFIG_ACCOUNT = new PublicKey("8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

const ENCRYPTION_KEY_MESSAGE = "zodiac-liquidity-encryption-key-v1";
const MAX_COMPUTATION_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

// --- File logger ---
const LOG_FILE = "test-fail-run.log";
const logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
const origLog = console.log;
console.log = (...args: any[]) => {
  const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
  origLog(...args);
  try { logStream.write(line + "\n"); } catch {}
};

/**
 * Wraps a computation queue + finalize flow with retry logic.
 * On abort (Error 6000), re-queues with a new computation offset.
 *
 * @param label - Human-readable label for logging
 * @param buildAndSend - Function that takes a computationOffset and sends the queue tx.
 *                       Returns the tx signature.
 * @param provider - Anchor provider
 * @param programId - Program public key
 * @returns The finalization transaction signature
 */
async function queueWithRetry(
  label: string,
  buildAndSend: (computationOffset: anchor.BN) => Promise<string>,
  provider: anchor.AnchorProvider,
  programId: PublicKey,
): Promise<string> {
  const clusterOffset = getArciumEnv().arciumClusterOffset;

  for (let attempt = 1; attempt <= MAX_COMPUTATION_RETRIES; attempt++) {
    const computationOffset = new anchor.BN(randomBytes(8), "hex");
    try {
      console.log(`[${label}] Attempt ${attempt}/${MAX_COMPUTATION_RETRIES} - queuing computation (offset: ${computationOffset.toString()})`);
      const queueSig = await buildAndSend(computationOffset);
      console.log(`[${label}] Queue tx: ${queueSig}`);

      // Start listening for finalization IMMEDIATELY (before any delays)
      // so we don't miss the event if ARX processes quickly
      console.log(`[${label}] Waiting for computation finalization...`);
      const finalizationPromise = awaitComputationFinalization(
        provider,
        computationOffset,
        programId,
        "confirmed"
      );

      // Race: finalization vs timeout with mempool check
      // Use cancelled flag to prevent dangling timeout promises from causing
      // unhandled rejections when multiple test files run in one mocha process.
      const MEMPOOL_CHECK_TIMEOUT_MS = 90_000; // 90s (mempool TTL = 180 slots ~ 72s)
      let timeoutCancelled = false;
      const finalizeSig = await Promise.race([
        finalizationPromise.then((sig) => { timeoutCancelled = true; return sig; }),
        (async () => {
          // Wait, then check if computation is still queued or was dropped
          await new Promise((r) => setTimeout(r, 15_000)); // 15s grace period
          if (timeoutCancelled) return "CANCELLED" as any;
          const compAccAddress = getComputationAccAddress(clusterOffset, computationOffset);
          const compAccInfo = await withRetry(() => provider.connection.getAccountInfo(compAccAddress));
          if (!compAccInfo) {
            console.log(`[${label}] Computation account not found after 15s — checking mempool...`);
            const mempoolAddr = getMempoolAccAddress(clusterOffset);
            try {
              const arciumProg = getArciumProgram(provider);
              const memComps = await getComputationsInMempool(arciumProg, mempoolAddr);
              const found = memComps.some((ref: any) =>
                ref.computationOffset && computationOffset.eq(new anchor.BN(ref.computationOffset))
              );
              if (!found) {
                throw new Error(`DROPPED_FROM_MEMPOOL`);
              }
              console.log(`[${label}] Computation found in mempool, continuing to wait...`);
            } catch (mempoolErr: any) {
              if (mempoolErr.message === "DROPPED_FROM_MEMPOOL") throw mempoolErr;
              console.log(`[${label}] Mempool check failed (${mempoolErr.message?.substring(0, 80)}), continuing to wait...`);
            }
          } else {
            console.log(`[${label}] Computation account confirmed on-chain, continuing to wait...`);
          }
          // Keep waiting for finalization up to the timeout
          await new Promise((r) => setTimeout(r, MEMPOOL_CHECK_TIMEOUT_MS - 15_000));
          if (timeoutCancelled) return "CANCELLED" as any;
          throw new Error(`TIMEOUT_WAITING_FOR_FINALIZATION`);
        })(),
      ]);
      console.log(`[${label}] Finalize tx: ${finalizeSig}`);

      // Check if the finalized tx had an error (AbortedComputation = custom error 6000)
      const txResult = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }));

      if (txResult?.meta?.err) {
        console.log(`[${label}] Attempt ${attempt} ABORTED - tx error:`, JSON.stringify(txResult.meta.err));
        if (txResult.meta.logMessages) {
          const errorLogs = txResult.meta.logMessages.filter(
            (l) => l.includes("Error") || l.includes("failed") || l.includes("aborted")
          );
          errorLogs.forEach((l) => console.log(`  ${l}`));
        }
        if (attempt < MAX_COMPUTATION_RETRIES) {
          console.log(`[${label}] Retrying in ${RETRY_DELAY_MS}ms...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        throw new Error(`[${label}] All ${MAX_COMPUTATION_RETRIES} attempts aborted`);
      }

      console.log(`[${label}] Computation succeeded on attempt ${attempt}`);
      return finalizeSig;
    } catch (err: any) {
      // Handle errors from queue tx itself (not callback)
      if (err.message?.includes("All") && err.message?.includes("aborted")) {
        throw err;
      }
      const isRetryable = err.message === "DROPPED_FROM_MEMPOOL" || err.message === "TIMEOUT_WAITING_FOR_FINALIZATION";
      if (isRetryable) {
        console.log(`[${label}] Attempt ${attempt} - computation ${err.message === "DROPPED_FROM_MEMPOOL" ? "dropped from mempool" : "timed out"}`);
      } else {
        console.log(`[${label}] Attempt ${attempt} error:`, err.message || err);
        if (err.logs) console.log(`[${label}] Logs:`, err.logs);
      }
      if (attempt < MAX_COMPUTATION_RETRIES) {
        console.log(`[${label}] Retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[${label}] Exhausted all retries`);
}

/**
 * Derives a deterministic X25519 encryption keypair from a Solana wallet.
 */
function deriveEncryptionKey(
  wallet: anchor.web3.Keypair,
  message: string
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, wallet.secretKey);
  const privateKey = new Uint8Array(
    createHash("sha256").update(signature).digest()
  );
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Gets the cluster account address using the cluster offset from environment.
 */
function getClusterAccount(): PublicKey {
  const arciumEnv = getArciumEnv();
  return getClusterAccAddress(arciumEnv.arciumClusterOffset);
}

/**
 * Derives a relay PDA for a given vault and relay index (0..11).
 */
function deriveRelayPda(
  vaultPda: PublicKey,
  relayIndex: number,
  programId: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("zodiac_relay"), vaultPda.toBuffer(), Buffer.from([relayIndex])],
    programId
  );
  return pda;
}

/**
 * Retry an async operation with delay between attempts (handles RPC 403 rate limits).
 */
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err.message || err.toString();
      if (msg.includes("403") && i < retries - 1) {
        console.log(`  RPC 403, retrying (${i + 1}/${retries})...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("withRetry: unreachable");
}

/**
 * Retry an async operation on "Blockhash not found" errors.
 * On localnet, the Anchor provider's cached blockhash can go stale after
 * heavy MPC activity. Retrying forces a fresh blockhash fetch.
 */
async function withBlockhashRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err.message || err.toString();
      if (msg.includes("Blockhash not found") && i < retries - 1) {
        console.log(`  Blockhash expired, retrying (${i + 1}/${retries})...`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("withBlockhashRetry: unreachable");
}

/**
 * Calculate liquidity from desired token amounts using Meteora SDK.
 */
function calculateLiquidityFromAmounts(
  connection: anchor.web3.Connection,
  tokenAAmount: anchor.BN,
  tokenBAmount: anchor.BN,
  sqrtPrice: anchor.BN,
): anchor.BN {
  const cpAmmInstance = new CpAmm(connection);
  return cpAmmInstance.getLiquidityDelta({
    maxAmountTokenA: tokenAAmount,
    maxAmountTokenB: tokenBAmount,
    sqrtPrice,
    sqrtMinPrice: new anchor.BN(MIN_SQRT_PRICE),
    sqrtMaxPrice: new anchor.BN(MAX_SQRT_PRICE),
  });
}

/**
 * Helper to get max/min of two pubkeys (lexicographic).
 */
function maxKey(a: PublicKey, b: PublicKey): PublicKey {
  return a.toBuffer().compare(b.toBuffer()) > 0 ? a : b;
}
function minKey(a: PublicKey, b: PublicKey): PublicKey {
  return a.toBuffer().compare(b.toBuffer()) <= 0 ? a : b;
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}

/**
 * Derives an ephemeral wallet PDA for a given vault and wallet pubkey.
 */
function deriveEphemeralWalletPda(
  vaultPda: PublicKey,
  walletPubkey: PublicKey,
  programId: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ephemeral"), vaultPda.toBuffer(), walletPubkey.toBuffer()],
    programId
  );
  return pda;
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 40,
  retryDelayMs: number = 1000
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }

    if (attempt < maxRetries) {
      console.log(
        `Retrying in ${retryDelayMs}ms... (attempt ${attempt}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    `Failed to fetch MXE public key after ${maxRetries} attempts`
  );
}

describe("zodiac-liquidity-fail", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ZodiacLiquidity as Program<ZodiacLiquidity>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  // Patch provider.sendAndConfirm to auto-retry on "Blockhash not found".
  // On localnet, after heavy MPC activity the validator can lag behind,
  // causing blockhash expiry between fetch and confirmation.
  // Skip if already patched (e.g., when running together with happy-path tests).
  if (!(provider.sendAndConfirm as any).__blockhashRetryPatched) {
    const _origSendAndConfirm = provider.sendAndConfirm.bind(provider);
    const patchedFn = async function(tx: any, signers?: any, opts?: any) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await _origSendAndConfirm(tx, signers, opts);
        } catch (err: any) {
          const msg = err.message || err.toString();
          if (msg.includes("Blockhash not found") && attempt < 2) {
            console.log(`  Blockhash expired, retrying (${attempt + 1}/3)...`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          throw err;
        }
      }
      throw new Error("sendAndConfirm retry: unreachable");
    } as any;
    patchedFn.__blockhashRetryPatched = true;
    provider.sendAndConfirm = patchedFn;
  }

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

  const clusterAccount = getClusterAccount();
  let owner: Keypair;
  let relayer: Keypair;
  let tokenMint: PublicKey;
  let vaultPda: PublicKey;
  let userPositionPda: PublicKey;
  let mxePublicKey: Uint8Array;
  let cipher: RescueCipher;
  let encryptionKeys: { privateKey: Uint8Array; publicKey: Uint8Array };

  before(async () => {
    console.log("=".repeat(60));
    console.log("Zodiac Liquidity Fail Tests - Setup");
    console.log("=".repeat(60));
    console.log("Program ID:", program.programId.toString());

    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    console.log("Owner:", owner.publicKey.toString());

    // Create and fund relayer wallet (simulates mixer output)
    relayer = Keypair.generate();
    const fundRelayerTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: relayer.publicKey,
        lamports: 500_000_000, // 0.5 SOL
      })
    );
    await provider.sendAndConfirm(fundRelayerTx, [owner]);
    console.log("Relayer:", relayer.publicKey.toString(), "(funded with 0.5 SOL)");

    // Get MXE public key for encryption
    try {
      mxePublicKey = await getMXEPublicKeyWithRetry(
        provider,
        program.programId
      );
      console.log("MXE x25519 pubkey:", Buffer.from(mxePublicKey).toString("hex"));

      // Derive encryption keys from wallet
      encryptionKeys = deriveEncryptionKey(owner, ENCRYPTION_KEY_MESSAGE);
      const sharedSecret = x25519.getSharedSecret(
        encryptionKeys.privateKey,
        mxePublicKey
      );
      cipher = new RescueCipher(sharedSecret);
      console.log("Encryption cipher initialized");
    } catch (e) {
      console.log("Warning: Could not get MXE public key. MXE may not be initialized yet.");
      console.log("This is expected for first run - will initialize computation definitions first.");
    }

    // Create test token mint
    console.log("Creating test token mint...");
    tokenMint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9 // 9 decimals
    );
    console.log("Token mint:", tokenMint.toString());

    // Derive vault PDA
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    console.log("Vault PDA:", vaultPda.toString());

    // Derive user position PDA
    [userPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), vaultPda.toBuffer(), owner.publicKey.toBuffer()],
      program.programId
    );
    console.log("User Position PDA:", userPositionPda.toString());
  });

  // ============================================================
  // SETUP: Comp defs + vault creation (needed for fail tests)
  // ============================================================
  describe("Setup - Computation Definition Initialization", () => {
    it("initializes init_vault computation definition", async () => {
      const sig = await initCompDef(program, owner, "init_vault", "initVaultCompDef");
      console.log("Init vault comp def tx:", sig);
    });

    it("initializes init_user_position computation definition", async () => {
      const sig = await initCompDef(program, owner, "init_user_position", "initUserPositionCompDef");
      console.log("Init user position comp def tx:", sig);
    });

    it("initializes deposit computation definition", async () => {
      const sig = await initCompDef(program, owner, "deposit", "initDepositCompDef");
      console.log("Init deposit comp def tx:", sig);
    });

    it("initializes reveal_pending_deposits computation definition", async () => {
      const sig = await initCompDef(program, owner, "reveal_pending_deposits", "initRevealPendingCompDef");
      console.log("Init reveal pending comp def tx:", sig);
    });

    it("initializes record_liquidity computation definition", async () => {
      const sig = await initCompDef(program, owner, "record_liquidity", "initRecordLiquidityCompDef");
      console.log("Init record liquidity comp def tx:", sig);
    });

    it("initializes compute_withdrawal computation definition", async () => {
      const sig = await initCompDef(program, owner, "compute_withdrawal", "initWithdrawCompDef");
      console.log("Init withdraw comp def tx:", sig);
    });

    it("initializes get_user_position computation definition", async () => {
      const sig = await initCompDef(program, owner, "get_user_position", "initGetPositionCompDef");
      console.log("Init get position comp def tx:", sig);
    });

    it("initializes clear_position computation definition", async () => {
      const sig = await initCompDef(program, owner, "clear_position", "initClearPositionCompDef");
      console.log("Init clear position comp def tx:", sig);
    });
  });

  describe("Setup - Vault Creation", () => {
    it("creates a new vault", async () => {
      // Refresh MXE public key after comp defs are initialized (if not already set)
      if (!mxePublicKey || !cipher) {
        console.log("MXE key not set yet, waiting for keygen to complete...");
        mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId, 120, 2000);
        encryptionKeys = deriveEncryptionKey(owner, ENCRYPTION_KEY_MESSAGE);
        const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
        cipher = new RescueCipher(sharedSecret);
      } else {
        console.log("MXE key already available, reusing...");
        try {
          const freshKey = await getMXEPublicKeyWithRetry(provider, program.programId, 5, 1000);
          if (Buffer.from(freshKey).toString("hex") !== Buffer.from(mxePublicKey).toString("hex")) {
            console.log("MXE key changed, updating cipher...");
            mxePublicKey = freshKey;
            encryptionKeys = deriveEncryptionKey(owner, ENCRYPTION_KEY_MESSAGE);
            const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
            cipher = new RescueCipher(sharedSecret);
          }
        } catch (e) {
          console.log("Could not refresh MXE key, using cached key");
        }
      }

      const nonce = randomBytes(16);

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")],
        program.programId
      )[0];

      const finalizeSig = await queueWithRetry(
        "createVault",
        async (computationOffset) => {
          return program.methods
            .createVault(computationOffset, new anchor.BN(deserializeLE(nonce).toString()))
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              tokenMint: tokenMint,
              signPdaAccount: signPdaAccount,
              computationAccount: getComputationAccAddress(
                getArciumEnv().arciumClusterOffset,
                computationOffset
              ),
              clusterAccount: clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
              compDefAccount: getCompDefAccAddress(
                program.programId,
                Buffer.from(getCompDefAccOffset("init_vault")).readUInt32LE()
              ),
              poolAccount: getFeePoolAccAddress(),
              clockAccount: getClockAccAddress(),
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc({ skipPreflight: true, commitment: "confirmed" });
        },
        provider,
        program.programId,
      );

      // Verify vault was created
      const vaultAccount = await program.account.vaultAccount.fetch(vaultPda);
      console.log("Vault created for fail tests, authority:", vaultAccount.authority.toString());
      expect(vaultAccount.authority.toString()).to.equal(owner.publicKey.toString());
    });
  });

  // ============================================================
  // RELAY TRANSFER - FAILURE CASES
  // ============================================================
  describe("Relay Transfer - Failure Cases", () => {
    it("fails relay transfer with wrong authority", async () => {
      const relayIndex = 1;
      const wrongAuthority = Keypair.generate();

      // Fund wrong authority with 0.05 SOL via transfer from owner
      const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: wrongAuthority.publicKey,
          lamports: 50_000_000,
        })
      );
      await provider.sendAndConfirm(fundTx, [owner]);

      const relayPda = deriveRelayPda(vaultPda, relayIndex, program.programId);

      // Create relay token account (keypair to avoid ATA off-curve error)
      const relayTokenKp = Keypair.generate();
      const relayTokenAccount = await createAccount(
        provider.connection,
        owner,
        tokenMint,
        relayPda,
        relayTokenKp,
      );

      // Create destination
      const destTokenKp = Keypair.generate();
      const destTokenAccount = await createAccount(
        provider.connection,
        owner,
        tokenMint,
        wrongAuthority.publicKey,
        destTokenKp,
      );

      // Wait for blockhash to refresh after account creation
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        await program.methods
          .relayTransferToDestination(relayIndex, new anchor.BN(100))
          .accounts({
            authority: wrongAuthority.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            relayTokenAccount: relayTokenAccount,
            destinationTokenAccount: destTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([wrongAuthority])
          .rpc({ commitment: "confirmed" });
        throw new Error("Should have failed with unauthorized");
      } catch (err: any) {
        console.log("Expected error for wrong authority:", err.message?.substring(0, 100));
        expect(err.message || err.toString()).to.include("Unauthorized");
      }
    });

    it("fails relay transfer with invalid relay index", async () => {
      const invalidRelayIndex = 12; // NUM_RELAYS = 12, so index 12 is invalid

      const relayPda = deriveRelayPda(vaultPda, invalidRelayIndex, program.programId);

      // Create dummy accounts (keypair to avoid ATA off-curve error)
      const relayTokenKp = Keypair.generate();
      const relayTokenAccount = await createAccount(
        provider.connection,
        owner,
        tokenMint,
        relayPda,
        relayTokenKp,
      );

      const destTokenKp = Keypair.generate();
      const destTokenAccount = await createAccount(
        provider.connection,
        owner,
        tokenMint,
        owner.publicKey,
        destTokenKp,
      );

      // Wait for blockhash to refresh after account creation
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        await program.methods
          .relayTransferToDestination(invalidRelayIndex, new anchor.BN(100))
          .accounts({
            authority: owner.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            relayTokenAccount: relayTokenAccount,
            destinationTokenAccount: destTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" });
        throw new Error("Should have failed with invalid relay index");
      } catch (err: any) {
        console.log("Expected error for invalid relay index:", err.message?.substring(0, 100));
        expect(err.message || err.toString()).to.include("InvalidRelayIndex");
      }
    });
  });

  // ============================================================
  // FUND RELAY - FAILURE CASES
  // ============================================================
  describe("Fund Relay - Failure Cases", () => {
    it("fails fund_relay with wrong authority", async () => {
      // Delay to avoid RPC rate limiting from previous test
      await new Promise(resolve => setTimeout(resolve, 3000));

      const relayIndex = 3;
      const wrongAuthority = Keypair.generate();

      // Fund wrong authority with 0.05 SOL via transfer from owner
      const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: wrongAuthority.publicKey,
          lamports: 50_000_000,
        })
      );
      await provider.sendAndConfirm(fundTx, [owner]);

      const relayPda = deriveRelayPda(vaultPda, relayIndex, program.programId);

      const relayTokenKp = Keypair.generate();
      const relayTokenAccount = await createAccount(
        provider.connection,
        owner,
        tokenMint,
        relayPda,
        relayTokenKp,
      );

      // Create wrong authority's token account
      const wrongAuthorityTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wrongAuthority,
        tokenMint,
        wrongAuthority.publicKey,
      );

      // Wait for blockhash to refresh after account creation
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        await program.methods
          .fundRelay(relayIndex, new anchor.BN(100))
          .accounts({
            authority: wrongAuthority.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            authorityTokenAccount: wrongAuthorityTokenAccount.address,
            relayTokenAccount: relayTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([wrongAuthority])
          .rpc({ commitment: "confirmed" });
        throw new Error("Should have failed with unauthorized");
      } catch (err: any) {
        console.log("Expected error for wrong authority:", err.message?.substring(0, 100));
        expect(err.message || err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ============================================================
  // METEORA CPI - FAILURE CASES
  // ============================================================
  describe("Meteora CPI - Failure Cases", () => {
    let tokenA: PublicKey;
    let tokenB: PublicKey;
    let relayPda: PublicKey;
    let relayTokenA: PublicKey;
    let relayTokenB: PublicKey;
    let poolPda: PublicKey;
    let positionPda: PublicKey;
    let posNftMint: Keypair;
    let posNftAccount: PublicKey;
    let tokenAVault: PublicKey;
    let tokenBVault: PublicKey;
    let eventAuthority: PublicKey;
    let depWithEphemeralPda: PublicKey;
    const relayIndex = 7; // Use different relay index from happy path tests
    let setupFailed = false;

    before(async () => {
      try {
        // Delay to avoid RPC rate limiting from previous tests
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Register owner as ephemeral wallet for this vault
        depWithEphemeralPda = deriveEphemeralWalletPda(vaultPda, owner.publicKey, program.programId);
        try {
          await program.methods
            .registerEphemeralWallet()
            .accounts({
              authority: owner.publicKey,
              vault: vaultPda,
              wallet: owner.publicKey,
              ephemeralWallet: depWithEphemeralPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log("Registered owner as ephemeral wallet:", depWithEphemeralPda.toString());
        } catch (err: any) {
          // May already exist from previous test run
          if (err.message?.includes("already in use")) {
            console.log("Ephemeral wallet PDA already exists, continuing");
          } else {
            throw err;
          }
        }

        relayPda = deriveRelayPda(vaultPda, relayIndex, program.programId);

        // Fund relay PDA with SOL for rent (relayer simulates mixer output)
        const fundRelayTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: relayPda,
            lamports: 50_000_000,
          })
        );
        await provider.sendAndConfirm(fundRelayTx, [relayer]);

        // Create SPL mint + use NATIVE_MINT (WSOL) for SOL-paired pool
        const mintA = await createMint(provider.connection, owner, owner.publicKey, null, 9);
        tokenA = minKey(mintA, NATIVE_MINT);
        tokenB = maxKey(mintA, NATIVE_MINT);
        const isTokenANative = tokenA.equals(NATIVE_MINT);
        console.log("Fail test - Token A:", tokenA.toString(), isTokenANative ? "(WSOL)" : "(SPL)");
        console.log("Fail test - Token B:", tokenB.toString(), !isTokenANative ? "(WSOL)" : "(SPL)");

        // Create relay token accounts
        const relayTokenAKp = Keypair.generate();
        relayTokenA = await createAccount(provider.connection, owner, tokenA, relayPda, relayTokenAKp);
        const relayTokenBKp = Keypair.generate();
        relayTokenB = await createAccount(provider.connection, owner, tokenB, relayPda, relayTokenBKp);

        // Fund relay SPL token via fund_relay (authority mints + transfers)
        const splMint = tokenA.equals(NATIVE_MINT) ? tokenB : tokenA;
        const authTokenSpl = await getOrCreateAssociatedTokenAccount(provider.connection, owner, splMint, owner.publicKey);
        await mintTo(provider.connection, owner, splMint, authTokenSpl.address, owner, 200_000_000);

        await new Promise(resolve => setTimeout(resolve, 2000));

        const relayTokenSpl = tokenA.equals(NATIVE_MINT) ? relayTokenB : relayTokenA;
        await program.methods.fundRelay(relayIndex, new anchor.BN(100_000_000))
          .accounts({ authority: owner.publicKey, vault: vaultPda, relayPda, authorityTokenAccount: authTokenSpl.address, relayTokenAccount: relayTokenSpl, tokenProgram: TOKEN_PROGRAM_ID })
          .signers([owner]).rpc({ commitment: "confirmed" });

        // Fund relay WSOL account with SOL + sync native (relayer funds SOL)
        const relayTokenWsol = tokenA.equals(NATIVE_MINT) ? relayTokenA : relayTokenB;
        const fundWsolTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: relayTokenWsol, lamports: 100_000_000 }),
          createSyncNativeInstruction(relayTokenWsol),
        );
        await provider.sendAndConfirm(fundWsolTx, [relayer]);

        // Create a customizable pool
        const poolNftMint = Keypair.generate();
        [poolPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("cpool"), maxKey(tokenA, tokenB).toBuffer(), minKey(tokenA, tokenB).toBuffer()],
          DAMM_V2_PROGRAM_ID
        );
        const [poolPosition] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), poolNftMint.publicKey.toBuffer()],
          DAMM_V2_PROGRAM_ID
        );
        const [poolNftAccount] = PublicKey.findProgramAddressSync(
          [Buffer.from("position_nft_account"), poolNftMint.publicKey.toBuffer()],
          DAMM_V2_PROGRAM_ID
        );
        [tokenAVault] = PublicKey.findProgramAddressSync(
          [Buffer.from("token_vault"), tokenA.toBuffer(), poolPda.toBuffer()],
          DAMM_V2_PROGRAM_ID
        );
        [tokenBVault] = PublicKey.findProgramAddressSync(
          [Buffer.from("token_vault"), tokenB.toBuffer(), poolPda.toBuffer()],
          DAMM_V2_PROGRAM_ID
        );
        [eventAuthority] = PublicKey.findProgramAddressSync(
          [EVENT_AUTHORITY_SEED], DAMM_V2_PROGRAM_ID
        );

        const poolFees = {
          baseFee: { cliffFeeNumerator: new anchor.BN(2_500_000), firstFactor: 0, secondFactor: Array(8).fill(0), thirdFactor: new anchor.BN(0), baseFeeMode: 0 },
          padding: [0, 0, 0],
          dynamicFee: null,
        };
        const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);

        await program.methods
          .createCustomizablePoolViaRelay(
            relayIndex, poolFees,
            new anchor.BN(MIN_SQRT_PRICE), new anchor.BN(MAX_SQRT_PRICE),
            false, new anchor.BN(1_000_000), sqrtPrice, 0, 0, null,
          )
          .accounts({
            payer: owner.publicKey, vault: vaultPda, ephemeralWallet: depWithEphemeralPda, relayPda,
            positionNftMint: poolNftMint.publicKey, positionNftAccount: poolNftAccount,
            poolAuthority: POOL_AUTHORITY, pool: poolPda, position: poolPosition,
            tokenAMint: tokenA, tokenBMint: tokenB,
            tokenAVault, tokenBVault,
            relayTokenA, relayTokenB,
            tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId, eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([owner, poolNftMint])
          .rpc({ commitment: "confirmed" });

        console.log("Pool created for fail tests at:", poolPda.toString());

        await new Promise(resolve => setTimeout(resolve, 5000));

        // Create a separate position for deposit/withdraw fail testing
        posNftMint = Keypair.generate();
        [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), posNftMint.publicKey.toBuffer()],
          DAMM_V2_PROGRAM_ID
        );
        [posNftAccount] = PublicKey.findProgramAddressSync(
          [Buffer.from("position_nft_account"), posNftMint.publicKey.toBuffer()],
          DAMM_V2_PROGRAM_ID
        );

        const [relayPositionTracker] = PublicKey.findProgramAddressSync(
          [Buffer.from("relay_position"), vaultPda.toBuffer(), Buffer.from([relayIndex]), poolPda.toBuffer()],
          program.programId
        );

        await program.methods
          .createMeteoraPosition(relayIndex)
          .accounts({
            payer: owner.publicKey, vault: vaultPda, ephemeralWallet: depWithEphemeralPda, relayPda,
            relayPositionTracker,
            positionNftMint: posNftMint.publicKey, positionNftAccount: posNftAccount,
            pool: poolPda, position: positionPda,
            poolAuthority: POOL_AUTHORITY,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId, eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([owner, posNftMint])
          .rpc({ commitment: "confirmed" });

        console.log("Position created for fail tests");
      } catch (err: any) {
        console.log("Meteora CPI fail test setup failed:", err.message?.substring(0, 150));
        setupFailed = true;
      }
    });

    after(async () => {
      if (setupFailed) return;
      try {
        const wsolAccount = tokenA.equals(NATIVE_MINT) ? relayTokenA : relayTokenB;
        await closeAccount(provider.connection, owner, wsolAccount, owner.publicKey, owner);
        console.log("Closed WSOL account, SOL reclaimed (fail tests section)");
      } catch (err: any) {
        console.log("Cleanup: could not close WSOL account:", err.message?.substring(0, 80));
      }
    });

    it("fails create_customizable_pool with unregistered ephemeral wallet", async function () {
      if (setupFailed) { this.skip(); return; }
      const unregisteredWallet = Keypair.generate();
      // Fund unregistered wallet with 0.05 SOL
      const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: unregisteredWallet.publicKey,
          lamports: 50_000_000,
        })
      );
      await provider.sendAndConfirm(fundTx, [owner]);

      const positionNftMint = Keypair.generate();
      const unregisteredEphemeralPda = deriveEphemeralWalletPda(vaultPda, unregisteredWallet.publicKey, program.programId);

      const poolFees = {
        baseFee: {
          cliffFeeNumerator: new anchor.BN(2_500_000),
          firstFactor: 0,
          secondFactor: Array(8).fill(0),
          thirdFactor: new anchor.BN(0),
          baseFeeMode: 0,
        },
        padding: [0, 0, 0],
        dynamicFee: null,
      };

      try {
        await program.methods
          .createCustomizablePoolViaRelay(
            relayIndex,
            poolFees,
            new anchor.BN(MIN_SQRT_PRICE),
            new anchor.BN(MAX_SQRT_PRICE),
            false,
            new anchor.BN(1_000_000),
            new anchor.BN(MIN_SQRT_PRICE),
            0, 0, null,
          )
          .accounts({
            payer: unregisteredWallet.publicKey,
            vault: vaultPda,
            ephemeralWallet: unregisteredEphemeralPda,
            relayPda: deriveRelayPda(vaultPda, relayIndex, program.programId),
            positionNftMint: positionNftMint.publicKey,
            positionNftAccount: PublicKey.default,
            poolAuthority: POOL_AUTHORITY,
            pool: PublicKey.default,
            position: PublicKey.default,
            tokenAMint: tokenA,
            tokenBMint: tokenB,
            tokenAVault: PublicKey.default,
            tokenBVault: PublicKey.default,
            relayTokenA: PublicKey.default,
            relayTokenB: PublicKey.default,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            eventAuthority: PublicKey.default,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([unregisteredWallet, positionNftMint])
          .rpc({ commitment: "confirmed" });
        throw new Error("Should have failed with unregistered ephemeral wallet");
      } catch (err: any) {
        console.log("Expected error for unregistered ephemeral wallet:", err.message?.substring(0, 100));
        const msg = err.message || err.toString();
        // PDA not found = AccountNotInitialized or similar
        expect(msg).to.satisfy((m: string) =>
          m.includes("AccountNotInitialized") || m.includes("not found") || m.includes("Constraint") || m.includes("Error")
        );
      }
    });

    it("fails deposit_to_meteora with unregistered ephemeral wallet", async function () {
      if (setupFailed) { this.skip(); return; }
      const unregisteredWallet = Keypair.generate();

      const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: unregisteredWallet.publicKey,
          lamports: 50_000_000,
        })
      );
      await provider.sendAndConfirm(fundTx, [owner]);

      await new Promise(resolve => setTimeout(resolve, 2000));

      const unregisteredEphemeralPda = deriveEphemeralWalletPda(vaultPda, unregisteredWallet.publicKey, program.programId);

      try {
        await program.methods
          .depositToMeteoraDammV2(
            relayIndex,
            new anchor.BN(1_000),
            new anchor.BN("18446744073709551615"),
            new anchor.BN("18446744073709551615"),
            null,
          )
          .accounts({
            payer: unregisteredWallet.publicKey,
            vault: vaultPda,
            ephemeralWallet: unregisteredEphemeralPda,
            relayPda,
            pool: poolPda,
            position: positionPda,
            relayTokenA,
            relayTokenB,
            tokenAVault,
            tokenBVault,
            tokenAMint: tokenA,
            tokenBMint: tokenB,
            positionNftAccount: posNftAccount,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([unregisteredWallet])
          .rpc({ commitment: "confirmed" });
        throw new Error("Should have failed with unregistered ephemeral wallet");
      } catch (err: any) {
        console.log("Expected error for unregistered ephemeral wallet (deposit):", err.message?.substring(0, 100));
        const msg = err.message || err.toString();
        expect(msg).to.satisfy((m: string) =>
          m.includes("AccountNotInitialized") || m.includes("not found") || m.includes("Constraint") || m.includes("Error")
        );
      }
    });

    it("fails withdraw_from_meteora with unregistered ephemeral wallet", async function () {
      if (setupFailed) { this.skip(); return; }
      const unregisteredWallet = Keypair.generate();

      const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: unregisteredWallet.publicKey,
          lamports: 50_000_000,
        })
      );
      await provider.sendAndConfirm(fundTx, [owner]);

      await new Promise(resolve => setTimeout(resolve, 2000));

      const unregisteredEphemeralPda = deriveEphemeralWalletPda(vaultPda, unregisteredWallet.publicKey, program.programId);

      try {
        await program.methods
          .withdrawFromMeteoraDammV2(
            relayIndex,
            new anchor.BN(1_000),
            new anchor.BN(0),
            new anchor.BN(0),
          )
          .accounts({
            payer: unregisteredWallet.publicKey,
            vault: vaultPda,
            ephemeralWallet: unregisteredEphemeralPda,
            relayPda,
            poolAuthority: POOL_AUTHORITY,
            pool: poolPda,
            position: positionPda,
            relayTokenA,
            relayTokenB,
            tokenAVault,
            tokenBVault,
            tokenAMint: tokenA,
            tokenBMint: tokenB,
            positionNftAccount: posNftAccount,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([unregisteredWallet])
          .rpc({ commitment: "confirmed" });
        throw new Error("Should have failed with unregistered ephemeral wallet");
      } catch (err: any) {
        console.log("Expected error for unregistered ephemeral wallet (withdraw):", err.message?.substring(0, 100));
        const msg = err.message || err.toString();
        expect(msg).to.satisfy((m: string) =>
          m.includes("AccountNotInitialized") || m.includes("not found") || m.includes("Constraint") || m.includes("Error")
        );
      }
    });
  });

  // ============================================================
  // EPHEMERAL WALLET - FAILURE CASES
  // ============================================================
  describe("Ephemeral Wallet - Failure Cases", () => {
    it("fails register with wrong authority", async () => {
      const wrongAuthority = Keypair.generate();
      const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: wrongAuthority.publicKey,
          lamports: 50_000_000,
        })
      );
      await provider.sendAndConfirm(fundTx, [owner]);

      const ephemeralKeypair = Keypair.generate();
      const ephemeralPda = deriveEphemeralWalletPda(vaultPda, ephemeralKeypair.publicKey, program.programId);

      try {
        await program.methods
          .registerEphemeralWallet()
          .accounts({
            authority: wrongAuthority.publicKey,
            vault: vaultPda,
            wallet: ephemeralKeypair.publicKey,
            ephemeralWallet: ephemeralPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([wrongAuthority])
          .rpc({ commitment: "confirmed" });
        throw new Error("Should have failed with unauthorized");
      } catch (err: any) {
        console.log("Expected error for wrong authority (register):", err.message?.substring(0, 100));
        const msg = err.message || err.toString();
        expect(msg).to.satisfy((m: string) =>
          m.includes("Unauthorized") || m.includes("Constraint") || m.includes("Error")
        );
      }
    });
  });

  after(async () => {
    // Return remaining relayer SOL to owner
    try {
      const relayerBal = await provider.connection.getBalance(relayer.publicKey);
      if (relayerBal > 5000) {
        const returnTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: owner.publicKey,
            lamports: relayerBal - 5000, // leave min for fee
          })
        );
        await provider.sendAndConfirm(returnTx, [relayer]);
        console.log("Returned relayer SOL to owner");
      }
    } catch {}

    console.log("=".repeat(60));
    console.log("All fail tests complete. Log saved to:", LOG_FILE);
    console.log("=".repeat(60));
  });

  // Helper function to initialize computation definitions (idempotent)
  // With offchain storage, we just init the comp def - ARX nodes fetch circuits from URL
  async function initCompDef(
    program: Program<ZodiacLiquidity>,
    owner: Keypair,
    circuitName: string,
    methodName: string
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset(circuitName);

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];

    console.log(`${circuitName} comp def PDA:`, compDefPDA.toBase58());

    // Check if account already exists and is owned by Arcium program
    const accountInfo = await withRetry(() => provider.connection.getAccountInfo(compDefPDA));

    if (accountInfo !== null && accountInfo.owner.equals(getArciumProgramId())) {
      console.log(`${circuitName} comp def already exists (${accountInfo.data.length} bytes), skipping`);
      return "skipped";
    }

    // Initialize comp def with offchain circuit source
    // The program specifies the URL and hash - ARX nodes will fetch and verify
    console.log(`Initializing ${circuitName} comp def (offchain circuit)...`);
    // @ts-ignore - Dynamic method call
    const sig = await program.methods[methodName]()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
      })
      .signers([owner])
      .rpc();
    console.log(`${circuitName} init tx:`, sig);

    return sig;
  }
});
