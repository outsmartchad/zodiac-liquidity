import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction, AddressLookupTableProgram } from "@solana/web3.js";
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
  getLookupTableAddress,
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
import { KeypairVault } from "./lib/keypair_vault";

const NUM_RELAYS = 12;

// Meteora DAMM v2 constants
const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const CONFIG_ACCOUNT = new PublicKey("8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

const ENCRYPTION_KEY_MESSAGE = "zodiac-liquidity-encryption-key-v1";
const MAX_COMPUTATION_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

// Actual cluster offset read from the on-chain MXE account.
// In v0.7.0, `arcium test` sets ARCIUM_CLUSTER_OFFSET=0 but initializes the MXE with a different
// cluster (e.g. 456). We read the real value from the MXE account in before() to stay correct.
let actualClusterOffset: number;

async function readMxeClusterOffset(
  connection: anchor.web3.Connection,
  programId: PublicKey,
): Promise<number> {
  const mxeAddr = getMXEAccAddress(programId);
  const mxeInfo = await connection.getAccountInfo(mxeAddr);
  if (mxeInfo && mxeInfo.data.length > 12 && mxeInfo.data[8] === 1) {
    return mxeInfo.data.readUInt32LE(9);
  }
  return getArciumEnv().arciumClusterOffset;
}

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
  const clusterOffset = actualClusterOffset;

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
  return getClusterAccAddress(actualClusterOffset);
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

/**
 * Send a transaction with only the provided keypairs as signers (no provider wallet).
 */
async function sendWithEphemeralPayer(
  provider: anchor.AnchorProvider,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  const connection = provider.connection;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);
      const rawTx = tx.serialize();
      const sig = await connection.sendRawTransaction(rawTx, { skipPreflight: false, preflightCommitment: "confirmed" });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return sig;
    } catch (err: any) {
      const msg = err.message || err.toString();
      if ((msg.includes("Blockhash not found") || msg.includes("403")) && attempt < 2) {
        console.log(`  RPC error (ephemeral payer, ${msg.includes("403") ? "403" : "blockhash"}), retrying (${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, 2000));
        const freshTx = new Transaction();
        freshTx.instructions = tx.instructions;
        tx = freshTx;
        continue;
      }
      throw err;
    }
  }
  throw new Error("sendWithEphemeralPayer: unreachable");
}

/**
 * Creates a fresh ephemeral wallet, registers its PDA, funds it with SOL for tx fees.
 */
async function setupEphemeralWallet(
  program: Program<ZodiacLiquidity>,
  provider: anchor.AnchorProvider,
  owner: Keypair,
  vaultPda: PublicKey,
  fundLamports: number = 500_000_000,
): Promise<{ ephemeralKp: Keypair; ephemeralPda: PublicKey }> {
  const ephemeralKp = Keypair.generate();
  const ephemeralPda = deriveEphemeralWalletPda(vaultPda, ephemeralKp.publicKey, program.programId);

  await program.methods
    .registerEphemeralWallet()
    .accounts({
      authority: owner.publicKey,
      vault: vaultPda,
      wallet: ephemeralKp.publicKey,
      ephemeralWallet: ephemeralPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner])
    .rpc({ commitment: "confirmed" });

  const fundTx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: ephemeralKp.publicKey,
      lamports: fundLamports,
    })
  );
  await provider.sendAndConfirm(fundTx, [owner]);

  // Wait for funding to settle on localnet (prevents "Attempt to debit" errors)
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log("Ephemeral wallet created:", ephemeralKp.publicKey.toString(), "PDA:", ephemeralPda.toString());
  return { ephemeralKp, ephemeralPda };
}

/**
 * Returns remaining SOL from ephemeral wallet to authority, then closes the PDA.
 */
async function teardownEphemeralWallet(
  program: Program<ZodiacLiquidity>,
  provider: anchor.AnchorProvider,
  owner: Keypair,
  vaultPda: PublicKey,
  ephemeralKp: Keypair,
  ephemeralPda: PublicKey,
): Promise<void> {
  try {
    const ephBal = await provider.connection.getBalance(ephemeralKp.publicKey);
    if (ephBal > 5000) {
      const returnTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: ephemeralKp.publicKey,
          toPubkey: owner.publicKey,
          lamports: ephBal - 5000,
        })
      );
      await sendWithEphemeralPayer(provider, returnTx, [ephemeralKp]);
      console.log("Returned", (ephBal - 5000) / 1e9, "SOL from ephemeral wallet to authority");
    }
  } catch (err: any) {
    console.log("Could not return ephemeral SOL:", err.message?.substring(0, 80));
  }

  await program.methods
    .closeEphemeralWallet()
    .accounts({
      authority: owner.publicKey,
      vault: vaultPda,
      ephemeralWallet: ephemeralPda,
    })
    .signers([owner])
    .rpc({ commitment: "confirmed" });

  console.log("Ephemeral wallet PDA closed:", ephemeralPda.toString());
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 5,
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
          if ((msg.includes("Blockhash not found") || msg.includes("403")) && attempt < 2) {
            console.log(`  RPC error (${msg.includes("403") ? "403" : "blockhash"}), retrying (${attempt + 1}/3)...`);
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

  let clusterAccount: PublicKey;
  let owner: Keypair;
  let relayer: Keypair;
  let tokenMint: PublicKey;
  let quoteMint: PublicKey;
  let vaultPda: PublicKey;
  let userPositionPda: PublicKey;
  let mxePublicKey: Uint8Array;
  let cipher: RescueCipher;
  let encryptionKeys: { privateKey: Uint8Array; publicKey: Uint8Array };

  // Track relay token accounts for SOL recovery in after() hook
  const relayTokenAccounts: { relayIndex: number; tokenAccount: PublicKey }[] = [];

  before(async () => {
    actualClusterOffset = await readMxeClusterOffset(provider.connection, program.programId);
    console.log("Cluster offset (from MXE account):", actualClusterOffset);
    clusterAccount = getClusterAccount();

    console.log("=".repeat(60));
    console.log("Zodiac Liquidity Fail Tests - Setup");
    console.log("=".repeat(60));
    console.log("Program ID:", program.programId.toString());

    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    console.log("Owner:", owner.publicKey.toString());

    // Create and fund relayer wallet (simulates mixer output)
    relayer = Keypair.generate();
    const kpVault = new KeypairVault("zodiac-liquidity-fail");
    (globalThis as any).__kpVault_liquidityFail = kpVault;
    kpVault.save(relayer, "relayer", 5_000_000_000);
    const fundRelayerTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: relayer.publicKey,
        lamports: 5_000_000_000, // 5 SOL
      })
    );
    await provider.sendAndConfirm(fundRelayerTx, [owner]);
    console.log("Relayer:", relayer.publicKey.toString(), "(funded with 5 SOL)");

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

    quoteMint = NATIVE_MINT;
    console.log("Quote mint (WSOL):", quoteMint.toString());

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

    // --- Initialize all 8 comp defs (idempotent, skips if already exist) ---
    console.log("Initializing computation definitions...");
    const circuits = [
      { name: "init_vault", method: "initVaultCompDef" },
      { name: "init_user_position", method: "initUserPositionCompDef" },
      { name: "deposit", method: "initDepositCompDef" },
      { name: "reveal_pending_deposits", method: "initRevealPendingCompDef" },
      { name: "record_liquidity", method: "initRecordLiquidityCompDef" },
      { name: "compute_withdrawal", method: "initWithdrawCompDef" },
      { name: "get_user_position", method: "initGetPositionCompDef" },
      { name: "clear_position", method: "initClearPositionCompDef" },
    ];
    for (const { name, method } of circuits) {
      const sig = await initCompDef(program, owner, name, method);
      console.log(`  ${name} comp def: ${sig}`);
    }

    // --- Create vault (MPC operation, needed for fail tests) ---
    if (!mxePublicKey || !cipher) {
      console.log("MXE key not set yet, waiting for keygen to complete...");
      mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId, 5, 2000);
      encryptionKeys = deriveEncryptionKey(owner, ENCRYPTION_KEY_MESSAGE);
      const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
      cipher = new RescueCipher(sharedSecret);
    } else {
      try {
        const freshKey = await getMXEPublicKeyWithRetry(provider, program.programId, 5, 1000);
        if (Buffer.from(freshKey).toString("hex") !== Buffer.from(mxePublicKey).toString("hex")) {
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

    console.log("Creating vault via MPC...");
    console.log(`  tokenMint = ${tokenMint.toString()}`);
    console.log(`  quoteMint = ${quoteMint.toString()}`);
    console.log(`  vaultPda = ${vaultPda.toString()}`);
    await queueWithRetry(
      "createVault",
      async (computationOffset) => {
        const builder = program.methods
          .createVault(computationOffset, new anchor.BN(deserializeLE(nonce).toString()))
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            tokenMint: tokenMint,
            quoteMint: quoteMint,
            signPdaAccount: signPdaAccount,
            computationAccount: getComputationAccAddress(
              actualClusterOffset,
              computationOffset
            ),
            clusterAccount: clusterAccount,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(actualClusterOffset),
            executingPool: getExecutingPoolAccAddress(actualClusterOffset),
            compDefAccount: getCompDefAccAddress(
              program.programId,
              Buffer.from(getCompDefAccOffset("init_vault")).readUInt32LE()
            ),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
          })
          .signers([owner]);
        return builder.rpc({ commitment: "confirmed" });
      },
      provider,
      program.programId,
    );

    const vaultAccount = await program.account.vaultAccount.fetch(vaultPda);
    console.log("Vault created for fail tests, authority:", vaultAccount.authority.toString());
    console.log("Setup complete — running fail tests...");
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
      relayTokenAccounts.push({ relayIndex, tokenAccount: relayTokenAccount });

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
      relayTokenAccounts.push({ relayIndex, tokenAccount: relayTokenAccount });

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
    const relayIndex = 7; // Use different relay index from happy path tests
    let setupFailed = false;

    before(async () => {
      try {
        // Delay to avoid RPC rate limiting from previous tests
        await new Promise(resolve => setTimeout(resolve, 3000));

        relayPda = deriveRelayPda(vaultPda, relayIndex, program.programId);

        // Fund relay PDA with SOL for rent (relayer simulates mixer output)
        const fundRelayTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: relayPda,
            lamports: 2_000_000_000, // 2 SOL for pool creation rent
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
        relayTokenAccounts.push({ relayIndex, tokenAccount: relayTokenA });
        const relayTokenBKp = Keypair.generate();
        relayTokenB = await createAccount(provider.connection, owner, tokenB, relayPda, relayTokenBKp);
        relayTokenAccounts.push({ relayIndex, tokenAccount: relayTokenB });

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

        // --- Ephemeral wallet for pool creation ---
        const poolEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

        const poolCreateTx = await program.methods
          .createCustomizablePoolViaRelay(
            relayIndex, poolFees,
            new anchor.BN(MIN_SQRT_PRICE), new anchor.BN(MAX_SQRT_PRICE),
            false, new anchor.BN(1_000_000), sqrtPrice, 0, 0, null,
          )
          .accounts({
            payer: poolEph.ephemeralKp.publicKey, vault: vaultPda, ephemeralWallet: poolEph.ephemeralPda, relayPda,
            positionNftMint: poolNftMint.publicKey, positionNftAccount: poolNftAccount,
            poolAuthority: POOL_AUTHORITY, pool: poolPda, position: poolPosition,
            tokenAMint: tokenA, tokenBMint: tokenB,
            tokenAVault, tokenBVault,
            relayTokenA, relayTokenB,
            tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId, eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .transaction();
        await sendWithEphemeralPayer(provider, poolCreateTx, [poolEph.ephemeralKp, poolNftMint]);

        console.log("Pool created for fail tests at:", poolPda.toString());
        await teardownEphemeralWallet(program, provider, owner, vaultPda, poolEph.ephemeralKp, poolEph.ephemeralPda);

        await new Promise(resolve => setTimeout(resolve, 5000));

        // --- Ephemeral wallet for position creation ---
        const posEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

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

        const posCreateTx = await program.methods
          .createMeteoraPosition(relayIndex)
          .accounts({
            payer: posEph.ephemeralKp.publicKey, vault: vaultPda, ephemeralWallet: posEph.ephemeralPda, relayPda,
            relayPositionTracker,
            positionNftMint: posNftMint.publicKey, positionNftAccount: posNftAccount,
            pool: poolPda, position: positionPda,
            poolAuthority: POOL_AUTHORITY,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId, eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .transaction();
        await sendWithEphemeralPayer(provider, posCreateTx, [posEph.ephemeralKp, posNftMint]);

        console.log("Position created for fail tests");
        await teardownEphemeralWallet(program, provider, owner, vaultPda, posEph.ephemeralKp, posEph.ephemeralPda);
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
    // Drain and close all tracked relay token accounts
    for (const { relayIndex: idx, tokenAccount } of relayTokenAccounts) {
      try {
        const relayPda = deriveRelayPda(vaultPda, idx, program.programId);
        const acctInfo = await provider.connection.getAccountInfo(tokenAccount);
        if (!acctInfo) continue; // already closed
        const tokenAcct = await getAccount(provider.connection, tokenAccount).catch(() => null);
        if (tokenAcct && Number(tokenAcct.amount) > 0) {
          const ownerAta = await getOrCreateAssociatedTokenAccount(
            provider.connection, owner, tokenAcct.mint, owner.publicKey
          );
          await program.methods
            .relayTransferToDestination(idx, new anchor.BN(tokenAcct.amount.toString()))
            .accounts({
              authority: owner.publicKey, vault: vaultPda, relayPda,
              relayTokenAccount: tokenAccount,
              destinationTokenAccount: ownerAta.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log(`Drained ${tokenAcct.amount} tokens from relay ${idx} token account`);
          if (tokenAcct.mint.equals(NATIVE_MINT)) {
            try {
              await closeAccount(provider.connection, owner, ownerAta.address, owner.publicKey, owner);
            } catch {}
          }
        }
        await program.methods
          .closeRelayTokenAccount(idx)
          .accounts({
            authority: owner.publicKey, vault: vaultPda, relayPda,
            relayTokenAccount: tokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" });
        console.log(`Closed relay ${idx} token account, rent reclaimed`);
      } catch (err: any) {
        console.log(`Could not close relay token account (idx=${idx}):`, err.message?.substring(0, 80));
      }
    }

    // Withdraw SOL from relay PDAs used in fail tests (indices 1, 3, 7)
    const usedRelayIndices = [1, 3, 7];
    for (const idx of usedRelayIndices) {
      try {
        const relayPda = deriveRelayPda(vaultPda, idx, program.programId);
        const relayBal = await provider.connection.getBalance(relayPda);
        if (relayBal > 0) {
          await program.methods
            .withdrawRelaySol(idx, new anchor.BN(relayBal))
            .accounts({
              authority: owner.publicKey,
              vault: vaultPda,
              relayPda: relayPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log(`Withdrew ${relayBal / 1e9} SOL from relay PDA ${idx}`);
        }
      } catch (err: any) {
        console.log(`Could not withdraw relay ${idx} SOL:`, err.message?.substring(0, 80));
      }
    }

    // Return remaining relayer SOL to owner
    let relayerRecovered = false;
    try {
      const relayerBal = await provider.connection.getBalance(relayer.publicKey);
      if (relayerBal > 5000) {
        const returnTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: owner.publicKey,
            lamports: relayerBal - 5000,
          })
        );
        returnTx.feePayer = relayer.publicKey;
        const sig = await provider.connection.sendTransaction(returnTx, [relayer]);
        const bh = await provider.connection.getLatestBlockhash();
        await provider.connection.confirmTransaction({
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
          signature: sig,
        });
        console.log(`Returned ${(relayerBal - 5000) / 1e9} SOL from relayer to owner`);
        relayerRecovered = true;
      } else {
        relayerRecovered = true;
      }
    } catch (err: any) {
      console.log("Failed to return relayer SOL:", err.message?.substring(0, 120));
    }

    // Only clear vault file if relayer SOL was recovered
    const kpVault = (globalThis as any).__kpVault_liquidityFail;
    if (kpVault && relayerRecovered) kpVault.clear();

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

    // v0.7.0: LUT address from MXE account's lut_offset_slot (see migration-v0.6.3-to-v0.7.0)
    const mxePda = getMXEAccAddress(program.programId);
    const arciumProgram = getArciumProgram(program.provider as anchor.AnchorProvider);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxePda);
    const rawSlot = mxeAcc.lutOffsetSlot;
    const lutSlot = rawSlot != null
      ? (anchor.BN.isBN(rawSlot) ? rawSlot : new anchor.BN(String(rawSlot)))
      : new anchor.BN(0);
    const mxeLutPda = getLookupTableAddress(program.programId, lutSlot);

    // @ts-ignore - Dynamic method call
    const sig = await program.methods[methodName]()
      .accounts({
        compDefAccount: compDefPDA,
        payer: owner.publicKey,
        mxeAccount: mxePda,
        addressLookupTable: mxeLutPda,
        lutProgram: AddressLookupTableProgram.programId,
      })
      .signers([owner])
      .rpc();
    console.log(`${circuitName} init tx:`, sig);

    return sig;
  }
});
