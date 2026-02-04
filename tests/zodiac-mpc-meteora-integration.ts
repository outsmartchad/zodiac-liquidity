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
const LOG_FILE = "integration-test-run.log";
const DETAILED_LOG_FILE = "integration-test-detailed.log";
const logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
const detailedLogStream = fs.createWriteStream(DETAILED_LOG_FILE, { flags: "w" });
const origLog = console.log;
console.log = (...args: any[]) => {
  const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
  origLog(...args);
  try { logStream.write(line + "\n"); } catch {}
  try { detailedLogStream.write(line + "\n"); } catch {}
};
/** Write to detailed log only (doesn't clutter console) */
function detailLog(...args: any[]) {
  const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
  try { detailedLogStream.write(line + "\n"); } catch {}
}
function logSeparator(title: string) {
  const sep = "─".repeat(60);
  console.log("");
  console.log(sep);
  console.log(`  ${title}`);
  console.log(sep);
}
function logKeyValue(key: string, value: any) {
  console.log(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
}
function logHex(label: string, data: Uint8Array | Buffer | number[]) {
  const buf = Buffer.from(data as any);
  console.log(`  ${label}: ${buf.toString("hex")} (${buf.length} bytes)`);
}
function logBN(label: string, bn: anchor.BN | bigint) {
  console.log(`  ${label}: ${bn.toString()}`);
}

// ============================================================
// HELPER FUNCTIONS (copied from zodiac-liquidity.ts)
// ============================================================

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

      console.log(`[${label}] Waiting for computation finalization...`);
      const finalizationPromise = awaitComputationFinalization(
        provider,
        computationOffset,
        programId,
        "confirmed"
      );

      const MEMPOOL_CHECK_TIMEOUT_MS = 90_000;
      let timeoutCancelled = false;
      const finalizeSig = await Promise.race([
        finalizationPromise.then((sig) => { timeoutCancelled = true; return sig; }),
        (async () => {
          await new Promise((r) => setTimeout(r, 15_000));
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
          await new Promise((r) => setTimeout(r, MEMPOOL_CHECK_TIMEOUT_MS - 15_000));
          if (timeoutCancelled) return "CANCELLED" as any;
          throw new Error(`TIMEOUT_WAITING_FOR_FINALIZATION`);
        })(),
      ]);
      console.log(`[${label}] Finalize tx: ${finalizeSig}`);

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

function getClusterAccount(): PublicKey {
  return getClusterAccAddress(actualClusterOffset);
}

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
      if (msg.includes("Blockhash not found") && attempt < 2) {
        console.log(`  Blockhash expired (ephemeral payer), retrying (${attempt + 1}/3)...`);
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

async function setupEphemeralWallet(
  program: Program<ZodiacLiquidity>,
  provider: anchor.AnchorProvider,
  owner: Keypair,
  vaultPda: PublicKey,
  fundLamports: number = 200_000_000,
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

/**
 * Parse Anchor events from a transaction's log messages.
 * Returns all successfully decoded events.
 */
function parseEventsFromTx(
  program: Program<ZodiacLiquidity>,
  tx: anchor.web3.TransactionResponse | null,
): Array<{ name: string; data: any }> {
  const events: Array<{ name: string; data: any }> = [];
  if (!tx?.meta?.logMessages) return events;

  for (const log of tx.meta.logMessages) {
    if (!log.startsWith("Program data:")) continue;
    const base64Data = log.split("Program data: ")[1];
    if (!base64Data) continue;
    try {
      const decoded = program.coder.events.decode(base64Data);
      if (decoded) {
        events.push(decoded);
      }
    } catch {
      // Not a valid event for this program — skip
    }
  }
  return events;
}

// ============================================================
// INTEGRATION TEST — Sequential Multi-User Flow
// ============================================================

describe("zodiac-integration", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ZodiacLiquidity as Program<ZodiacLiquidity>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  // Patch provider.sendAndConfirm for blockhash retry + 403 retry
  if (!(provider.sendAndConfirm as any).__blockhashRetryPatched) {
    const _origSendAndConfirm = provider.sendAndConfirm.bind(provider);
    const patchedFn = async function(tx: any, signers?: any, opts?: any) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          return await _origSendAndConfirm(tx, signers, opts);
        } catch (err: any) {
          const msg = err.message || err.toString();
          if ((msg.includes("Blockhash not found") || msg.includes("403")) && attempt < 9) {
            console.log(`  RPC error (${msg.includes("403") ? "403" : "blockhash"}), retrying (${attempt + 1}/10)...`);
            await new Promise(r => setTimeout(r, 3000));
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

  let clusterAccount: PublicKey;
  let owner: Keypair;
  let relayer: Keypair;
  let tokenMint: PublicKey;
  let quoteMint: PublicKey; // WSOL (NATIVE_MINT)
  let vaultPda: PublicKey;
  let mxePublicKey: Uint8Array;

  // Integration relay index — avoid collision with other test files
  const RELAY_INDEX = 8;
  let relayPda: PublicKey;

  // === Multi-user setup ===
  interface UserContext {
    name: string;
    wallet: Keypair;
    encryptionKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
    cipher: RescueCipher;
    positionPda: PublicKey;
    baseDepositAmount: number;
    quoteDepositAmount: number;
    // Filled during withdrawal
    decryptedBaseWithdraw?: number;
    decryptedQuoteWithdraw?: number;
  }

  const USER_CONFIGS = [
    { name: "User1 (owner)", baseDeposit: 5_000_000, quoteDeposit: 5_000_000 },
    { name: "User2", baseDeposit: 3_000_000, quoteDeposit: 3_000_000 },
    { name: "User3", baseDeposit: 2_000_000, quoteDeposit: 2_000_000 },
  ];

  let users: UserContext[] = [];

  // Vault token accounts (shared across all deposits)
  let vaultTokenAccount: PublicKey;
  let vaultQuoteTokenAccount: PublicKey;

  // Meteora state
  let tokenA: PublicKey;
  let tokenB: PublicKey;
  let relayTokenA: PublicKey;
  let relayTokenB: PublicKey;
  let poolPda: PublicKey;
  let positionPda: PublicKey;
  let posNftMint: Keypair;
  let posNftAccount: PublicKey;
  let tokenAVault: PublicKey;
  let tokenBVault: PublicKey;
  let eventAuthority: PublicKey;

  // Cumulative tracking for partial withdrawal math
  // cumulativeMeteoraLiquidity: actual u128 from Meteora position (NOT u64-capped)
  let cumulativeMeteoraLiquidity = new anchor.BN(0);
  let cumulativeBaseDeposited = 0;
  let cumulativeQuoteDeposited = 0;

  // Helper references
  let signPdaAccount: PublicKey;
  let isTokenANative: boolean;
  let relaySplAccount: PublicKey;
  let relayWsolAccount: PublicKey;

  before(async () => {
    logSeparator("SETUP: Sequential Multi-User Integration Test");

    // Read the actual cluster offset from the on-chain MXE account (v0.7.0 fix)
    actualClusterOffset = await readMxeClusterOffset(provider.connection, program.programId);
    console.log("Cluster offset (from MXE account):", actualClusterOffset);
    clusterAccount = getClusterAccount();

    console.log("");
    console.log(`Testing with ${USER_CONFIGS.length} users (sequential deposit/withdrawal):`);
    for (const cfg of USER_CONFIGS) {
      console.log(`  ${cfg.name}: ${cfg.baseDeposit} base + ${cfg.quoteDeposit} quote`);
    }
    console.log("");

    logKeyValue("Program ID", program.programId.toString());
    logKeyValue("Arcium Program ID", getArciumProgramId().toString());
    logKeyValue("Cluster offset", actualClusterOffset.toString());
    logKeyValue("Cluster account", clusterAccount.toString());
    logKeyValue("MXE account", getMXEAccAddress(program.programId).toString());
    logKeyValue("Mempool account", getMempoolAccAddress(actualClusterOffset).toString());

    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    logKeyValue("Owner pubkey", owner.publicKey.toString());

    signPdaAccount = PublicKey.findProgramAddressSync(
      [Buffer.from("ArciumSignerAccount")], program.programId
    )[0];

    // Create and fund relayer wallet
    relayer = Keypair.generate();
    const kpVault = new KeypairVault("zodiac-mpc-meteora-integration");
    (globalThis as any).__kpVault_integration = kpVault;
    kpVault.save(relayer, "relayer", 5_000_000_000);
    const relayerFundLamports = 5_000_000_000; // 5 SOL for multiple relay funding cycles
    const fundRelayerTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: relayer.publicKey,
        lamports: relayerFundLamports,
      })
    );
    await withBlockhashRetry(() => provider.sendAndConfirm(fundRelayerTx, [owner]));
    logKeyValue("Relayer pubkey", relayer.publicKey.toString());
    logKeyValue("Relayer funded", `${relayerFundLamports / 1e9} SOL`);

    // Create test token mint
    tokenMint = await createMint(provider.connection, owner, owner.publicKey, null, 9);
    quoteMint = NATIVE_MINT;
    logKeyValue("Token mint (base)", tokenMint.toString());
    logKeyValue("Quote mint (WSOL)", quoteMint.toString());

    // Derive vault PDA
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    logKeyValue("Vault PDA", vaultPda.toString());

    // Derive relay PDA
    relayPda = deriveRelayPda(vaultPda, RELAY_INDEX, program.programId);
    logKeyValue("Relay PDA", relayPda.toString());

    // Get MXE public key
    logSeparator("ENCRYPTION SETUP (x25519 + RescueCipher)");
    try {
      mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
      logHex("MXE x25519 pubkey", mxePublicKey);
    } catch (e) {
      console.log("  Warning: Could not get MXE public key. Will initialize after comp defs.");
    }

    // Create user contexts — owner is User1, others are generated keypairs
    users = [];
    for (let i = 0; i < USER_CONFIGS.length; i++) {
      const cfg = USER_CONFIGS[i];
      const wallet = i === 0 ? owner : Keypair.generate();

      // Persist non-owner keypairs to disk for crash recovery
      if (i > 0) {
        const kpVault = (globalThis as any).__kpVault_integration;
        if (kpVault) kpVault.save(wallet, `user-${cfg.name}`, 100_000_000);
      }

      // Fund non-owner wallets with SOL for tx fees + rent
      if (i > 0) {
        const fundUserTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: wallet.publicKey,
            lamports: 100_000_000, // 0.1 SOL for tx fees + computation rent
          })
        );
        await withBlockhashRetry(() => provider.sendAndConfirm(fundUserTx, [owner]));
      }

      const encKeys = deriveEncryptionKey(wallet, ENCRYPTION_KEY_MESSAGE);
      let userCipher: RescueCipher;
      if (mxePublicKey) {
        const sharedSecret = x25519.getSharedSecret(encKeys.privateKey, mxePublicKey);
        userCipher = new RescueCipher(sharedSecret);
      } else {
        userCipher = null as any;
      }

      const [positionPdaAddr] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), vaultPda.toBuffer(), wallet.publicKey.toBuffer()],
        program.programId
      );

      users.push({
        name: cfg.name,
        wallet,
        encryptionKeys: encKeys,
        cipher: userCipher,
        positionPda: positionPdaAddr,
        baseDepositAmount: cfg.baseDeposit,
        quoteDepositAmount: cfg.quoteDeposit,
      });

      logKeyValue(`  ${cfg.name} wallet`, wallet.publicKey.toString());
      logKeyValue(`  ${cfg.name} position PDA`, positionPdaAddr.toString());
    }
  });

  // ============================================================
  // Phase A: Comp Def Init (8 tests)
  // ============================================================
  describe("Phase A: Computation Definition Initialization", () => {
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
      it(`initializes ${name} computation definition`, async () => {
        const sig = await initCompDef(program, owner, name, method);
        console.log(`${name} comp def: ${sig}`);
      });
    }
  });

  // ============================================================
  // Phase B: Setup — Vault + Pool + Position (2 tests)
  // ============================================================
  describe("Phase B: Setup", () => {
    it("creates vault", async () => {
      logSeparator("MPC OPERATION: createVault");

      // Refresh MXE public key after comp defs
      if (!mxePublicKey || !users[0]?.cipher) {
        console.log("  MXE key not set yet, waiting for keygen...");
        mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId, 5, 2000);
        logHex("  MXE x25519 pubkey (refreshed)", mxePublicKey);
      } else {
        try {
          const freshKey = await getMXEPublicKeyWithRetry(provider, program.programId, 5, 1000);
          if (Buffer.from(freshKey).toString("hex") !== Buffer.from(mxePublicKey).toString("hex")) {
            mxePublicKey = freshKey;
            logHex("  MXE x25519 pubkey (changed!)", mxePublicKey);
          }
        } catch (e) {
          console.log("  Could not refresh MXE key, using cached key");
        }
      }

      // Initialize/refresh ciphers for all users
      for (const user of users) {
        const sharedSecret = x25519.getSharedSecret(user.encryptionKeys.privateKey, mxePublicKey);
        user.cipher = new RescueCipher(sharedSecret);
      }
      console.log(`  Initialized RescueCipher for ${users.length} users`);

      const nonce = randomBytes(16);
      const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

      await queueWithRetry(
        "createVault",
        async (computationOffset) => {
          const compAccAddr = getComputationAccAddress(actualClusterOffset, computationOffset);
          return program.methods
            .createVault(computationOffset, nonceBN)
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              tokenMint: tokenMint,
              quoteMint: quoteMint,
              signPdaAccount,
              computationAccount: compAccAddr,
              clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(actualClusterOffset),
              executingPool: getExecutingPoolAccAddress(actualClusterOffset),
              compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("init_vault")).readUInt32LE()),
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

      const vaultAccount = await program.account.vaultAccount.fetch(vaultPda);
      expect(vaultAccount.authority.toString()).to.equal(owner.publicKey.toString());
      console.log("  Vault created successfully");

      // Create vault token accounts (shared across all deposits)
      const vaultBaseAcct = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, tokenMint, vaultPda, true
      );
      vaultTokenAccount = vaultBaseAcct.address;
      const vaultQuoteAcct = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, NATIVE_MINT, vaultPda, true
      );
      vaultQuoteTokenAccount = vaultQuoteAcct.address;
      logKeyValue("  Vault base token account", vaultTokenAccount.toString());
      logKeyValue("  Vault quote token account", vaultQuoteTokenAccount.toString());
    });

    it("creates pool and position via relay", async () => {
      logSeparator("METEORA: Create Pool + Position via Relay");

      // Fund relay PDA with SOL for rent
      const fundRelayRentTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: relayer.publicKey,
          toPubkey: relayPda,
          lamports: 1_000_000_000,
        })
      );
      await provider.sendAndConfirm(fundRelayRentTx, [relayer]);

      // Sort tokens
      const splMint = tokenMint;
      tokenA = minKey(splMint, NATIVE_MINT);
      tokenB = maxKey(splMint, NATIVE_MINT);
      isTokenANative = tokenA.equals(NATIVE_MINT);
      logKeyValue("  Token A", `${tokenA.toString()} ${isTokenANative ? "(WSOL)" : "(SPL)"}`);
      logKeyValue("  Token B", `${tokenB.toString()} ${!isTokenANative ? "(WSOL)" : "(SPL)"}`);

      // Create relay token accounts
      const relayTokenAKp = Keypair.generate();
      relayTokenA = await createAccount(provider.connection, owner, tokenA, relayPda, relayTokenAKp);
      const relayTokenBKp = Keypair.generate();
      relayTokenB = await createAccount(provider.connection, owner, tokenB, relayPda, relayTokenBKp);
      relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;
      relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;

      // Fund relay with minimal initial liquidity for pool creation
      const INITIAL_LIQ = 1_000_000;
      const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, splMint, owner.publicKey
      );
      await mintTo(provider.connection, owner, splMint, authorityTokenAccount.address, owner, INITIAL_LIQ);
      await new Promise(resolve => setTimeout(resolve, 2000));
      await program.methods
        .fundRelay(RELAY_INDEX, new anchor.BN(INITIAL_LIQ))
        .accounts({
          authority: owner.publicKey, vault: vaultPda, relayPda,
          authorityTokenAccount: authorityTokenAccount.address,
          relayTokenAccount: relaySplAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      const fundWsolTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: relayer.publicKey,
          toPubkey: relayWsolAccount,
          lamports: INITIAL_LIQ,
        }),
        createSyncNativeInstruction(relayWsolAccount),
      );
      await provider.sendAndConfirm(fundWsolTx, [relayer]);

      // Derive Meteora PDAs
      [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("cpool"), maxKey(tokenA, tokenB).toBuffer(), minKey(tokenA, tokenB).toBuffer()],
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

      // --- Create pool via ephemeral wallet ---
      const poolNftMint = Keypair.generate();
      const [poolPosition] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), poolNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
      );
      const [poolNftAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("position_nft_account"), poolNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
      );

      const poolFees = {
        baseFee: { cliffFeeNumerator: new anchor.BN(2_500_000), firstFactor: 0, secondFactor: Array(8).fill(0), thirdFactor: new anchor.BN(0), baseFeeMode: 0 },
        padding: [0, 0, 0],
        dynamicFee: null,
      };
      const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);

      const poolEph = await setupEphemeralWallet(program, provider, owner, vaultPda);
      const poolTx = await program.methods
        .createCustomizablePoolViaRelay(
          RELAY_INDEX, poolFees,
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
      await sendWithEphemeralPayer(provider, poolTx, [poolEph.ephemeralKp, poolNftMint]);
      console.log("  Pool created at:", poolPda.toString());
      await teardownEphemeralWallet(program, provider, owner, vaultPda, poolEph.ephemeralKp, poolEph.ephemeralPda);

      await new Promise(resolve => setTimeout(resolve, 10000));

      // --- Create position via ephemeral wallet ---
      posNftMint = Keypair.generate();
      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), posNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
      );
      [posNftAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("position_nft_account"), posNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
      );

      const [relayPositionTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("relay_position"), vaultPda.toBuffer(), Buffer.from([RELAY_INDEX]), poolPda.toBuffer()],
        program.programId
      );

      const posEph = await setupEphemeralWallet(program, provider, owner, vaultPda);
      const posTx = await program.methods
        .createMeteoraPosition(RELAY_INDEX)
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
      await sendWithEphemeralPayer(provider, posTx, [posEph.ephemeralKp, posNftMint]);
      console.log("  Position created at:", positionPda.toString());
      await teardownEphemeralWallet(program, provider, owner, vaultPda, posEph.ephemeralKp, posEph.ephemeralPda);
    });
  });

  // ============================================================
  // Helper: Run a full deposit cycle for one user
  // (create position, deposit, reveal, fund relay, Meteora deposit, record liquidity)
  // ============================================================

  async function depositUserMPC(u: UserContext): Promise<void> {
    logSeparator(`MPC: deposit for ${u.name} (${u.baseDepositAmount} base + ${u.quoteDepositAmount} quote)`);

    await new Promise(resolve => setTimeout(resolve, 3000));

    const baseDepositAmount = BigInt(u.baseDepositAmount);
    const quoteDepositAmount = BigInt(u.quoteDepositAmount);
    const plaintext = [baseDepositAmount, quoteDepositAmount];
    const nonce = randomBytes(16);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());
    const ciphertext = u.cipher.encrypt(plaintext, nonce);

    // Create user base token account and mint tokens
    const userTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection, owner, tokenMint, u.wallet.publicKey
    );
    await mintTo(provider.connection, owner, tokenMint, userTokenAccount.address, owner, u.baseDepositAmount);

    // Create user WSOL token account (wrap SOL)
    const userQuoteTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection, owner, NATIVE_MINT, u.wallet.publicKey
    );
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: userQuoteTokenAccount.address,
        lamports: u.quoteDepositAmount,
      }),
      createSyncNativeInstruction(userQuoteTokenAccount.address)
    );
    await provider.sendAndConfirm(wrapTx, [owner]);

    await queueWithRetry(
      `deposit(${u.name})`,
      async (computationOffset) => {
        return program.methods
          .deposit(
            computationOffset,
            Array.from(ciphertext[0]) as number[],
            Array.from(ciphertext[1]) as number[],
            Array.from(u.encryptionKeys.publicKey) as number[],
            nonceBN,
            new anchor.BN(baseDepositAmount.toString()),
            new anchor.BN(quoteDepositAmount.toString())
          )
          .accountsPartial({
            depositor: u.wallet.publicKey,
            vault: vaultPda,
            userPosition: u.positionPda,
            userTokenAccount: userTokenAccount.address,
            vaultTokenAccount: vaultTokenAccount,
            userQuoteTokenAccount: userQuoteTokenAccount.address,
            vaultQuoteTokenAccount: vaultQuoteTokenAccount,
            tokenMint: tokenMint,
            quoteMint: quoteMint,
            signPdaAccount,
            computationAccount: getComputationAccAddress(actualClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(actualClusterOffset),
            executingPool: getExecutingPoolAccAddress(actualClusterOffset),
            compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("deposit")).readUInt32LE()),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([u.wallet])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      },
      provider,
      program.programId,
    );
    console.log(`  ${u.name} deposited ${u.baseDepositAmount} base + ${u.quoteDepositAmount} quote`);
  }

  /** Reveal pending deposits, returns { base, quote } plaintext amounts */
  async function revealPending(): Promise<{ base: number; quote: number }> {
    const finalizeSig = await queueWithRetry(
      "revealPendingDeposits",
      async (computationOffset) => {
        return program.methods
          .revealPendingDeposits(computationOffset)
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            signPdaAccount,
            computationAccount: getComputationAccAddress(actualClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(actualClusterOffset),
            executingPool: getExecutingPoolAccAddress(actualClusterOffset),
            compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("reveal_pending_deposits")).readUInt32LE()),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
          })
          .signers([owner])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      },
      provider,
      program.programId,
    );

    const revealTx = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }));
    const events = parseEventsFromTx(program, revealTx);
    const revealEvent = events.find(e => e.name === "PendingDepositsRevealedEvent" || e.name === "pendingDepositsRevealedEvent");

    if (revealEvent) {
      const base = Number(revealEvent.data.totalPendingBase.toString());
      const quote = Number(revealEvent.data.totalPendingQuote.toString());
      return { base, quote };
    }
    throw new Error("PendingDepositsRevealedEvent not found in callback tx");
  }

  /** Fund relay with specified base (SPL) and quote (WSOL) amounts */
  async function fundRelayWithAmounts(baseAmount: number, quoteAmount: number): Promise<void> {
    // Fund relay SPL
    const splMint = isTokenANative ? tokenB : tokenA;
    const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection, owner, splMint, owner.publicKey
    );
    await mintTo(provider.connection, owner, splMint, authorityTokenAccount.address, owner, baseAmount);
    await new Promise(resolve => setTimeout(resolve, 2000));

    await program.methods
      .fundRelay(RELAY_INDEX, new anchor.BN(baseAmount))
      .accounts({
        authority: owner.publicKey, vault: vaultPda, relayPda,
        authorityTokenAccount: authorityTokenAccount.address,
        relayTokenAccount: relaySplAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    // Fund relay WSOL
    const fundWsolTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: relayer.publicKey,
        toPubkey: relayWsolAccount,
        lamports: quoteAmount,
      }),
      createSyncNativeInstruction(relayWsolAccount),
    );
    await provider.sendAndConfirm(fundWsolTx, [relayer]);
    console.log(`  Relay funded: ${baseAmount} SPL + ${quoteAmount} WSOL`);
  }

  /** Deposit to Meteora and return { u64Delta (capped for record_liquidity), meteoraDelta (actual u128) } */
  async function depositToMeteora(): Promise<{ u64Delta: anchor.BN; meteoraDelta: anchor.BN }> {
    await new Promise(resolve => setTimeout(resolve, 3000));

    const depEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

    try {
      const splBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      const wsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
      const depositTokenAmount = Math.min(Number(splBal.amount), Number(wsolBal.amount));

      const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);
      const liquidityDelta = calculateLiquidityFromAmounts(
        provider.connection,
        new anchor.BN(depositTokenAmount),
        new anchor.BN(depositTokenAmount),
        sqrtPrice,
      );
      logBN("  liquidityDelta (SDK)", liquidityDelta);

      const depTx = await program.methods
        .depositToMeteoraDammV2(
          RELAY_INDEX,
          liquidityDelta,
          new anchor.BN("18446744073709551615"),
          new anchor.BN("18446744073709551615"),
          null,
        )
        .accounts({
          payer: depEph.ephemeralKp.publicKey,
          vault: vaultPda,
          ephemeralWallet: depEph.ephemeralPda,
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
        .transaction();
      await sendWithEphemeralPayer(provider, depTx, [depEph.ephemeralKp]);

      // Read actual liquidity from position
      const positionInfo = await withRetry(() => provider.connection.getAccountInfo(positionPda));
      const unlockedLiquidityBytes = positionInfo!.data.slice(152, 168);
      const currentUnlockedLiquidity = new anchor.BN(unlockedLiquidityBytes, "le");
      logBN("  Position.unlocked_liquidity (total)", currentUnlockedLiquidity);

      // Compute the actual delta for this deposit by subtracting cumulative
      const actualDelta = currentUnlockedLiquidity.sub(cumulativeMeteoraLiquidity);
      logBN("  Actual liquidity delta for this deposit", actualDelta);

      // Cap to u64 for record_liquidity circuit
      const U64_MAX = new anchor.BN("18446744073709551615");
      const deltaAsU64 = actualDelta.gt(U64_MAX) ? U64_MAX : actualDelta;

      return { u64Delta: deltaAsU64, meteoraDelta: actualDelta };
    } finally {
      await teardownEphemeralWallet(program, provider, owner, vaultPda, depEph.ephemeralKp, depEph.ephemeralPda);
    }
  }

  /** Record liquidity delta in Arcium MPC */
  async function recordLiquidity(liquidityDelta: anchor.BN): Promise<void> {
    logBN("  Recording liquidity delta", liquidityDelta);
    await queueWithRetry(
      "recordLiquidity",
      async (computationOffset) => {
        return program.methods
          .recordLiquidity(computationOffset, liquidityDelta)
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            signPdaAccount,
            computationAccount: getComputationAccAddress(actualClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(actualClusterOffset),
            executingPool: getExecutingPoolAccAddress(actualClusterOffset),
            compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("record_liquidity")).readUInt32LE()),
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
  }

  /** Compute withdrawal for a user, decrypt, return { base, quote } */
  async function computeWithdrawal(u: UserContext): Promise<{ base: number; quote: number }> {
    const sharedNonce = randomBytes(16);
    const sharedNonceBN = new anchor.BN(deserializeLE(sharedNonce).toString());

    const finalizeSig = await queueWithRetry(
      `computeWithdrawal(${u.name})`,
      async (computationOffset) => {
        return program.methods
          .withdraw(
            computationOffset,
            Array.from(u.encryptionKeys.publicKey) as number[],
            sharedNonceBN
          )
          .accountsPartial({
            user: u.wallet.publicKey,
            signPdaAccount,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(actualClusterOffset),
            executingPool: getExecutingPoolAccAddress(actualClusterOffset),
            computationAccount: getComputationAccAddress(actualClusterOffset, computationOffset),
            compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("compute_withdrawal")).readUInt32LE()),
            clusterAccount,
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
            vault: vaultPda,
            userPosition: u.positionPda,
          })
          .signers([u.wallet])
          .rpc({ commitment: "confirmed" });
      },
      provider,
      program.programId,
    );

    const withdrawTx = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }));
    const events = parseEventsFromTx(program, withdrawTx);
    const withdrawEvent = events.find(e => e.name === "WithdrawEvent" || e.name === "withdrawEvent");

    if (withdrawEvent) {
      const encryptedBaseArr: number[] = Array.from(withdrawEvent.data.encryptedBaseAmount);
      const encryptedQuoteArr: number[] = Array.from(withdrawEvent.data.encryptedQuoteAmount);
      const eventNonceBN = withdrawEvent.data.nonce;

      const nonceBuf = Buffer.alloc(16);
      const nonceBig = BigInt(eventNonceBN.toString());
      for (let i = 0; i < 16; i++) {
        nonceBuf[i] = Number((nonceBig >> BigInt(i * 8)) & BigInt(0xff));
      }

      const sharedSecret = x25519.getSharedSecret(u.encryptionKeys.privateKey, mxePublicKey);
      const decryptCipher = new RescueCipher(sharedSecret);
      const decrypted = decryptCipher.decrypt(
        [encryptedBaseArr, encryptedQuoteArr],
        new Uint8Array(nonceBuf),
      );
      return { base: Number(decrypted[0]), quote: Number(decrypted[1]) };
    }
    throw new Error(`WithdrawEvent not found for ${u.name}`);
  }

  /** Clear a user's position */
  async function clearPosition(u: UserContext, baseAmount: number, quoteAmount: number): Promise<void> {
    await queueWithRetry(
      `clearPosition(${u.name})`,
      async (computationOffset) => {
        return program.methods
          .clearPosition(computationOffset, new anchor.BN(baseAmount), new anchor.BN(quoteAmount))
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            userPosition: u.positionPda,
            signPdaAccount,
            computationAccount: getComputationAccAddress(actualClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(actualClusterOffset),
            executingPool: getExecutingPoolAccAddress(actualClusterOffset),
            compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("clear_position")).readUInt32LE()),
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
    console.log(`  ${u.name} position cleared (base=${baseAmount}, quote=${quoteAmount})`);
  }

  /** Create user position via MPC */
  async function createUserPosition(u: UserContext): Promise<void> {
    const nonce = randomBytes(16);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    await queueWithRetry(
      `createUserPosition(${u.name})`,
      async (computationOffset) => {
        return program.methods
          .createUserPosition(computationOffset, nonceBN)
          .accountsPartial({
            user: u.wallet.publicKey,
            vault: vaultPda,
            userPosition: u.positionPda,
            signPdaAccount,
            computationAccount: getComputationAccAddress(actualClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(program.programId),
            mempoolAccount: getMempoolAccAddress(actualClusterOffset),
            executingPool: getExecutingPoolAccAddress(actualClusterOffset),
            compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("init_user_position")).readUInt32LE()),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
          })
          .signers([u.wallet])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      },
      provider,
      program.programId,
    );

    const posAccount = await program.account.userPositionAccount.fetch(u.positionPda);
    expect(posAccount.owner.toString()).to.equal(u.wallet.publicKey.toString());
    console.log(`  ${u.name} position created`);
  }

  // ============================================================
  // Phase C: User1 Cycle (6 tests)
  // ============================================================
  describe("Phase C: User1 Deposit Cycle", () => {
    const userIdx = 0;
    let revealedBase: number;
    let revealedQuote: number;
    let u64Delta: anchor.BN;

    it("creates user1 position", async () => {
      await createUserPosition(users[userIdx]);
    });

    it("user1 deposits 5M base + 5M quote", async () => {
      await depositUserMPC(users[userIdx]);
    });

    it("reveals pending deposits (expect 5M/5M)", async () => {
      logSeparator("MPC: revealPendingDeposits (User1 batch)");
      const revealed = await revealPending();
      revealedBase = revealed.base;
      revealedQuote = revealed.quote;
      logKeyValue("  Revealed base", revealedBase);
      logKeyValue("  Revealed quote", revealedQuote);
      expect(revealedBase).to.equal(users[userIdx].baseDepositAmount);
      expect(revealedQuote).to.equal(users[userIdx].quoteDepositAmount);
    });

    it("funds relay with revealed amount", async () => {
      logSeparator("RELAY FUNDING (User1 batch)");
      await fundRelayWithAmounts(revealedBase, revealedQuote);
    });

    it("deposits to Meteora and records liquidity delta", async () => {
      logSeparator("METEORA DEPOSIT (User1 batch)");
      const result = await depositToMeteora();
      u64Delta = result.u64Delta;
      logBN("  User1 u64 delta (for record_liquidity)", u64Delta);
      logBN("  User1 Meteora delta (actual u128)", result.meteoraDelta);
      expect(u64Delta.gt(new anchor.BN(0))).to.be.true;
      // Update cumulative tracking with actual Meteora values
      cumulativeMeteoraLiquidity = cumulativeMeteoraLiquidity.add(result.meteoraDelta);
      cumulativeBaseDeposited += users[userIdx].baseDepositAmount;
      cumulativeQuoteDeposited += users[userIdx].quoteDepositAmount;
    });

    it("records liquidity in Arcium", async () => {
      logSeparator("MPC: recordLiquidity (User1 batch)");
      await recordLiquidity(u64Delta);
    });
  });

  // ============================================================
  // Phase D: User2 Cycle (6 tests)
  // ============================================================
  describe("Phase D: User2 Deposit Cycle", () => {
    const userIdx = 1;
    let revealedBase: number;
    let revealedQuote: number;
    let u64Delta: anchor.BN;

    it("creates user2 position", async () => {
      await createUserPosition(users[userIdx]);
    });

    it("user2 deposits 3M base + 3M quote", async () => {
      await depositUserMPC(users[userIdx]);
    });

    it("reveals pending deposits (expect 3M/3M)", async () => {
      logSeparator("MPC: revealPendingDeposits (User2 batch)");
      const revealed = await revealPending();
      revealedBase = revealed.base;
      revealedQuote = revealed.quote;
      logKeyValue("  Revealed base", revealedBase);
      logKeyValue("  Revealed quote", revealedQuote);
      expect(revealedBase).to.equal(users[userIdx].baseDepositAmount);
      expect(revealedQuote).to.equal(users[userIdx].quoteDepositAmount);
    });

    it("funds relay with revealed amount", async () => {
      logSeparator("RELAY FUNDING (User2 batch)");
      await fundRelayWithAmounts(revealedBase, revealedQuote);
    });

    it("deposits to Meteora and records liquidity delta", async () => {
      logSeparator("METEORA DEPOSIT (User2 batch)");
      const result = await depositToMeteora();
      u64Delta = result.u64Delta;
      logBN("  User2 u64 delta (for record_liquidity)", u64Delta);
      logBN("  User2 Meteora delta (actual u128)", result.meteoraDelta);
      expect(u64Delta.gt(new anchor.BN(0))).to.be.true;
      cumulativeMeteoraLiquidity = cumulativeMeteoraLiquidity.add(result.meteoraDelta);
      cumulativeBaseDeposited += users[userIdx].baseDepositAmount;
      cumulativeQuoteDeposited += users[userIdx].quoteDepositAmount;
    });

    it("records liquidity in Arcium", async () => {
      logSeparator("MPC: recordLiquidity (User2 batch)");
      await recordLiquidity(u64Delta);
    });
  });

  // ============================================================
  // Phase E: Position Check (1 test)
  // ============================================================
  describe("Phase E: Position Check", () => {
    it("user1 gets their position (expect 5M/5M)", async () => {
      const u = users[0];
      logSeparator(`MPC: getUserPosition for ${u.name}`);

      const sharedNonce = randomBytes(16);
      const sharedNonceBN = new anchor.BN(deserializeLE(sharedNonce).toString());

      const finalizeSig = await queueWithRetry(
        `getUserPosition(${u.name})`,
        async (computationOffset) => {
          return program.methods
            .getUserPosition(
              computationOffset,
              Array.from(u.encryptionKeys.publicKey) as number[],
              sharedNonceBN
            )
            .accountsPartial({
              user: u.wallet.publicKey,
              vault: vaultPda,
              userPosition: u.positionPda,
              signPdaAccount,
              computationAccount: getComputationAccAddress(actualClusterOffset, computationOffset),
              clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(actualClusterOffset),
              executingPool: getExecutingPoolAccAddress(actualClusterOffset),
              compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("get_user_position")).readUInt32LE()),
              poolAccount: getFeePoolAccAddress(),
              clockAccount: getClockAccAddress(),
              systemProgram: SystemProgram.programId,
            })
            .signers([u.wallet])
            .rpc({ commitment: "confirmed" });
        },
        provider,
        program.programId,
      );

      // Parse UserPositionEvent from callback tx
      const posTx = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }));
      const events = parseEventsFromTx(program, posTx);
      const posEvent = events.find(e =>
        e.name === "UserPositionEvent" || e.name === "userPositionEvent"
      );

      if (posEvent) {
        const encBase: number[] = Array.from(posEvent.data.encryptedBaseDeposited);
        const encQuote: number[] = Array.from(posEvent.data.encryptedQuoteDeposited);
        const encLiq: number[] = Array.from(posEvent.data.encryptedLpShare);
        const eventNonceBN = posEvent.data.nonce;

        const nonceBuf = Buffer.alloc(16);
        const nonceBig = BigInt(eventNonceBN.toString());
        for (let i = 0; i < 16; i++) {
          nonceBuf[i] = Number((nonceBig >> BigInt(i * 8)) & BigInt(0xff));
        }

        const sharedSecret = x25519.getSharedSecret(u.encryptionKeys.privateKey, mxePublicKey);
        const decryptCipher = new RescueCipher(sharedSecret);
        const decrypted = decryptCipher.decrypt(
          [encBase, encQuote, encLiq],
          new Uint8Array(nonceBuf),
        );
        logKeyValue("  Decrypted base_deposited", Number(decrypted[0]));
        logKeyValue("  Decrypted quote_deposited", Number(decrypted[1]));
        logKeyValue("  Decrypted liquidity_share", Number(decrypted[2]));
        expect(Number(decrypted[0])).to.equal(u.baseDepositAmount);
        expect(Number(decrypted[1])).to.equal(u.quoteDepositAmount);
      } else {
        console.log("  UserPositionEvent not found, available:", events.map(e => e.name));
        throw new Error("UserPositionEvent not found");
      }
    });
  });

  // ============================================================
  // Phase F: User3 Cycle (6 tests)
  // ============================================================
  describe("Phase F: User3 Deposit Cycle", () => {
    const userIdx = 2;
    let revealedBase: number;
    let revealedQuote: number;
    let u64Delta: anchor.BN;

    it("creates user3 position", async () => {
      await createUserPosition(users[userIdx]);
    });

    it("user3 deposits 2M base + 2M quote", async () => {
      await depositUserMPC(users[userIdx]);
    });

    it("reveals pending deposits (expect 2M/2M)", async () => {
      logSeparator("MPC: revealPendingDeposits (User3 batch)");
      const revealed = await revealPending();
      revealedBase = revealed.base;
      revealedQuote = revealed.quote;
      logKeyValue("  Revealed base", revealedBase);
      logKeyValue("  Revealed quote", revealedQuote);
      expect(revealedBase).to.equal(users[userIdx].baseDepositAmount);
      expect(revealedQuote).to.equal(users[userIdx].quoteDepositAmount);
    });

    it("funds relay with revealed amount", async () => {
      logSeparator("RELAY FUNDING (User3 batch)");
      await fundRelayWithAmounts(revealedBase, revealedQuote);
    });

    it("deposits to Meteora and records liquidity delta", async () => {
      logSeparator("METEORA DEPOSIT (User3 batch)");
      const result = await depositToMeteora();
      u64Delta = result.u64Delta;
      logBN("  User3 u64 delta (for record_liquidity)", u64Delta);
      logBN("  User3 Meteora delta (actual u128)", result.meteoraDelta);
      expect(u64Delta.gt(new anchor.BN(0))).to.be.true;
      cumulativeMeteoraLiquidity = cumulativeMeteoraLiquidity.add(result.meteoraDelta);
      cumulativeBaseDeposited += users[userIdx].baseDepositAmount;
      cumulativeQuoteDeposited += users[userIdx].quoteDepositAmount;
    });

    it("records liquidity in Arcium", async () => {
      logSeparator("MPC: recordLiquidity (User3 batch)");
      await recordLiquidity(u64Delta);
    });
  });

  // ============================================================
  // Phase G: User2 Mid-Flow Withdrawal (4 tests)
  // ============================================================
  describe("Phase G: User2 Mid-Flow Withdrawal", () => {
    let user2Base: number;
    let user2Quote: number;
    let user2LiquidityShare: anchor.BN;

    it("computes withdrawal for User2 (expect 3M/3M)", async () => {
      const u = users[1];
      logSeparator(`MPC: computeWithdrawal for ${u.name}`);
      const result = await computeWithdrawal(u);
      user2Base = result.base;
      user2Quote = result.quote;
      u.decryptedBaseWithdraw = user2Base;
      u.decryptedQuoteWithdraw = user2Quote;
      logKeyValue("  Decrypted base", user2Base);
      logKeyValue("  Decrypted quote", user2Quote);
      expect(user2Base).to.equal(u.baseDepositAmount);
      expect(user2Quote).to.equal(u.quoteDepositAmount);

      // Read actual unlocked liquidity from Meteora position for pro-rata calculation
      const positionInfo = await provider.connection.getAccountInfo(positionPda);
      const unlockedLiquidityBytes = positionInfo!.data.slice(152, 168);
      const currentUnlocked = new anchor.BN(unlockedLiquidityBytes, "le");
      // Compute User2's share: current_unlocked * user2_base / total_base
      user2LiquidityShare = currentUnlocked.mul(new anchor.BN(user2Base)).div(new anchor.BN(cumulativeBaseDeposited));
      logBN("  Current unlocked liquidity (Meteora)", currentUnlocked);
      logBN("  User2 liquidity share (pro-rata)", user2LiquidityShare);
      logKeyValue("  Cumulative base deposited", cumulativeBaseDeposited);
    });

    it("withdraws User2's liquidity share from Meteora", async () => {
      logSeparator("METEORA: Partial Withdraw (User2's share)");

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Read current unlocked liquidity
      const positionInfo = await provider.connection.getAccountInfo(positionPda);
      const unlockedLiquidityBytes = positionInfo!.data.slice(152, 168);
      const currentUnlocked = new anchor.BN(unlockedLiquidityBytes, "le");
      logBN("  Position.unlocked_liquidity (before)", currentUnlocked);
      logBN("  Withdrawing (User2 share)", user2LiquidityShare);

      const wdEph = await setupEphemeralWallet(program, provider, owner, vaultPda, 100_000_000);
      try {
        const wdTx = await program.methods
          .withdrawFromMeteoraDammV2(
            RELAY_INDEX,
            user2LiquidityShare,
            new anchor.BN(0),
            new anchor.BN(0),
          )
          .accounts({
            payer: wdEph.ephemeralKp.publicKey,
            vault: vaultPda,
            ephemeralWallet: wdEph.ephemeralPda,
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
          .transaction();
        await sendWithEphemeralPayer(provider, wdTx, [wdEph.ephemeralKp]);

        // Verify partial withdrawal
        const posAfter = await provider.connection.getAccountInfo(positionPda);
        const afterLiqBytes = posAfter!.data.slice(152, 168);
        const afterLiq = new anchor.BN(afterLiqBytes, "le");
        logBN("  Position.unlocked_liquidity (after)", afterLiq);
        expect(afterLiq.lt(currentUnlocked)).to.be.true;
        console.log("  Partial withdrawal succeeded — User1+User3 liquidity remains");
      } finally {
        await teardownEphemeralWallet(program, provider, owner, vaultPda, wdEph.ephemeralKp, wdEph.ephemeralPda);
      }
    });

    it("transfers tokens from relay to User2 destination", async () => {
      logSeparator("RELAY TRANSFER: User2 withdrawal");
      await new Promise(resolve => setTimeout(resolve, 2000));

      const splMint = isTokenANative ? tokenB : tokenA;
      const destTokenKp = Keypair.generate();
      const destWsolKp = Keypair.generate();
      const destinationTokenAccount = await createAccount(
        provider.connection, owner, splMint, users[1].wallet.publicKey, destTokenKp,
      );
      const destinationWsolAccount = await createAccount(
        provider.connection, owner, NATIVE_MINT, users[1].wallet.publicKey, destWsolKp,
      );

      // Transfer whatever the relay received from the partial Meteora withdrawal
      const relSplBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      const relWsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
      const splTransfer = Math.min(user2Base, Number(relSplBal.amount));
      const wsolTransfer = Math.min(user2Quote, Number(relWsolBal.amount));

      logKeyValue("  SPL transfer", splTransfer);
      logKeyValue("  WSOL transfer", wsolTransfer);

      await program.methods
        .relayTransferToDestination(RELAY_INDEX, new anchor.BN(splTransfer))
        .accounts({
          authority: owner.publicKey, vault: vaultPda, relayPda,
          relayTokenAccount: relaySplAccount,
          destinationTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      await program.methods
        .relayTransferToDestination(RELAY_INDEX, new anchor.BN(wsolTransfer))
        .accounts({
          authority: owner.publicKey, vault: vaultPda, relayPda,
          relayTokenAccount: relayWsolAccount,
          destinationTokenAccount: destinationWsolAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      const destSplBal = await withRetry(() => getAccount(provider.connection, destinationTokenAccount));
      const destWsolBal = await withRetry(() => getAccount(provider.connection, destinationWsolAccount));
      expect(Number(destSplBal.amount)).to.equal(splTransfer);
      expect(Number(destWsolBal.amount)).to.equal(wsolTransfer);
      console.log(`  User2 received ${splTransfer} SPL + ${wsolTransfer} WSOL`);
    });

    it("clears User2 position", async () => {
      logSeparator("MPC: clearPosition for User2");
      await clearPosition(users[1], user2Base, user2Quote);
    });
  });

  // ============================================================
  // Phase H: Remaining Users Withdraw (4 tests)
  // ============================================================
  describe("Phase H: User1 + User3 Final Withdrawal", () => {
    it("computes withdrawal for User1 (expect 5M/5M)", async () => {
      const u = users[0];
      logSeparator(`MPC: computeWithdrawal for ${u.name}`);
      const result = await computeWithdrawal(u);
      u.decryptedBaseWithdraw = result.base;
      u.decryptedQuoteWithdraw = result.quote;
      logKeyValue("  Decrypted base", result.base);
      logKeyValue("  Decrypted quote", result.quote);
      expect(result.base).to.equal(u.baseDepositAmount);
      expect(result.quote).to.equal(u.quoteDepositAmount);
    });

    it("computes withdrawal for User3 (expect 2M/2M)", async () => {
      const u = users[2];
      logSeparator(`MPC: computeWithdrawal for ${u.name}`);
      const result = await computeWithdrawal(u);
      u.decryptedBaseWithdraw = result.base;
      u.decryptedQuoteWithdraw = result.quote;
      logKeyValue("  Decrypted base", result.base);
      logKeyValue("  Decrypted quote", result.quote);
      expect(result.base).to.equal(u.baseDepositAmount);
      expect(result.quote).to.equal(u.quoteDepositAmount);
    });

    it("withdraws remaining liquidity from Meteora (all of it)", async () => {
      logSeparator("METEORA: Full Withdraw (remaining User1+User3 liquidity)");

      await new Promise(resolve => setTimeout(resolve, 3000));

      const positionInfo = await provider.connection.getAccountInfo(positionPda);
      const unlockedLiquidityBytes = positionInfo!.data.slice(152, 168);
      const unlockedLiquidity = new anchor.BN(unlockedLiquidityBytes, "le");
      logBN("  Position.unlocked_liquidity (remaining)", unlockedLiquidity);
      expect(unlockedLiquidity.gt(new anchor.BN(0))).to.be.true;

      const wdEph = await setupEphemeralWallet(program, provider, owner, vaultPda, 100_000_000);
      try {
        const wdTx = await program.methods
          .withdrawFromMeteoraDammV2(
            RELAY_INDEX,
            unlockedLiquidity,
            new anchor.BN(0),
            new anchor.BN(0),
          )
          .accounts({
            payer: wdEph.ephemeralKp.publicKey,
            vault: vaultPda,
            ephemeralWallet: wdEph.ephemeralPda,
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
          .transaction();
        await sendWithEphemeralPayer(provider, wdTx, [wdEph.ephemeralKp]);

        const posAfter = await provider.connection.getAccountInfo(positionPda);
        const afterLiqBytes = posAfter!.data.slice(152, 168);
        const afterLiq = new anchor.BN(afterLiqBytes, "le");
        logBN("  Position.unlocked_liquidity (after)", afterLiq);
        expect(afterLiq.eq(new anchor.BN(0))).to.be.true;
        console.log("  All remaining liquidity withdrawn");
      } finally {
        await teardownEphemeralWallet(program, provider, owner, vaultPda, wdEph.ephemeralKp, wdEph.ephemeralPda);
      }
    });

    it("transfers tokens to User1 + User3 and clears positions", async () => {
      logSeparator("RELAY TRANSFER + CLEAR: User1 + User3");
      await new Promise(resolve => setTimeout(resolve, 2000));

      const splMint = isTokenANative ? tokenB : tokenA;
      const remainingUsers = [users[0], users[2]];

      for (let idx = 0; idx < remainingUsers.length; idx++) {
        const u = remainingUsers[idx];
        const isLastUser = idx === remainingUsers.length - 1;
        expect(u.decryptedBaseWithdraw).to.be.greaterThan(0);

        const destTokenKp = Keypair.generate();
        const destWsolKp = Keypair.generate();
        const destinationTokenAccount = await createAccount(
          provider.connection, owner, splMint, u.wallet.publicKey, destTokenKp,
        );
        const destinationWsolAccount = await createAccount(
          provider.connection, owner, NATIVE_MINT, u.wallet.publicKey, destWsolKp,
        );

        let splTransferAmount = u.decryptedBaseWithdraw!;
        let wsolTransferAmount = u.decryptedQuoteWithdraw!;
        if (isLastUser) {
          const remainingSpl = await withRetry(() => getAccount(provider.connection, relaySplAccount));
          const remainingWsol = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
          splTransferAmount = Math.min(splTransferAmount, Number(remainingSpl.amount));
          wsolTransferAmount = Math.min(wsolTransferAmount, Number(remainingWsol.amount));
          console.log(`  ${u.name} (last): capped to relay remainder — SPL=${splTransferAmount}, WSOL=${wsolTransferAmount}`);
        }

        logKeyValue(`  ${u.name} SPL transfer`, splTransferAmount);
        logKeyValue(`  ${u.name} WSOL transfer`, wsolTransferAmount);

        await program.methods
          .relayTransferToDestination(RELAY_INDEX, new anchor.BN(splTransferAmount))
          .accounts({
            authority: owner.publicKey, vault: vaultPda, relayPda,
            relayTokenAccount: relaySplAccount,
            destinationTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" });

        await program.methods
          .relayTransferToDestination(RELAY_INDEX, new anchor.BN(wsolTransferAmount))
          .accounts({
            authority: owner.publicKey, vault: vaultPda, relayPda,
            relayTokenAccount: relayWsolAccount,
            destinationTokenAccount: destinationWsolAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" });

        const destSplBal = await withRetry(() => getAccount(provider.connection, destinationTokenAccount));
        const destWsolBal = await withRetry(() => getAccount(provider.connection, destinationWsolAccount));
        expect(Number(destSplBal.amount)).to.equal(splTransferAmount);
        expect(Number(destWsolBal.amount)).to.equal(wsolTransferAmount);
        console.log(`  ${u.name}: transferred ${splTransferAmount} SPL + ${wsolTransferAmount} WSOL`);

        // Clear position
        await clearPosition(u, u.decryptedBaseWithdraw!, u.decryptedQuoteWithdraw!);
      }
      console.log("  All remaining users received tokens and positions cleared");
    });
  });

  // ============================================================
  // Cleanup
  // ============================================================
  after(async () => {
    // Drain relay token accounts, close them, then withdraw relay PDA SOL
    try {
      if (relayTokenA && relayTokenB && tokenA && tokenB) {
        // Drain any remaining SPL tokens back to owner
        const splBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
        if (Number(splBal.amount) > 0) {
          const ownerAta = await getOrCreateAssociatedTokenAccount(
            provider.connection, owner, isTokenANative ? tokenB : tokenA, owner.publicKey
          );
          await program.methods
            .relayTransferToDestination(RELAY_INDEX, new anchor.BN(splBal.amount.toString()))
            .accounts({
              authority: owner.publicKey, vault: vaultPda, relayPda,
              relayTokenAccount: relaySplAccount,
              destinationTokenAccount: ownerAta.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log(`Drained ${splBal.amount} SPL tokens from relay back to owner`);
        }

        // Drain any remaining WSOL back to owner
        const wsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
        if (Number(wsolBal.amount) > 0) {
          const ownerWsolAta = await getOrCreateAssociatedTokenAccount(
            provider.connection, owner, NATIVE_MINT, owner.publicKey
          );
          await program.methods
            .relayTransferToDestination(RELAY_INDEX, new anchor.BN(wsolBal.amount.toString()))
            .accounts({
              authority: owner.publicKey, vault: vaultPda, relayPda,
              relayTokenAccount: relayWsolAccount,
              destinationTokenAccount: ownerWsolAta.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log(`Drained ${wsolBal.amount} WSOL from relay back to owner`);

          try {
            await closeAccount(provider.connection, owner, ownerWsolAta.address, owner.publicKey, owner);
            console.log("Closed owner WSOL ATA, SOL reclaimed");
          } catch (err: any) {
            console.log("Could not close owner WSOL ATA:", err.message?.substring(0, 80));
          }
        }

        // Close relay token accounts
        try {
          await program.methods
            .closeRelayTokenAccount(RELAY_INDEX)
            .accounts({
              authority: owner.publicKey, vault: vaultPda, relayPda,
              relayTokenAccount: relaySplAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log("Closed relay SPL token account, rent reclaimed");
        } catch (err: any) {
          console.log("Could not close relay SPL account:", err.message?.substring(0, 80));
        }

        try {
          await program.methods
            .closeRelayTokenAccount(RELAY_INDEX)
            .accounts({
              authority: owner.publicKey, vault: vaultPda, relayPda,
              relayTokenAccount: relayWsolAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log("Closed relay WSOL token account, rent reclaimed");
        } catch (err: any) {
          console.log("Could not close relay WSOL account:", err.message?.substring(0, 80));
        }
      }
    } catch (err: any) {
      console.log("Cleanup: could not drain relay accounts:", err.message?.substring(0, 100));
    }

    // Withdraw remaining SOL from relay PDA back to authority
    try {
      if (relayPda) {
        const relayBal = await provider.connection.getBalance(relayPda);
        if (relayBal > 0) {
          await program.methods
            .withdrawRelaySol(RELAY_INDEX, new anchor.BN(relayBal))
            .accounts({
              authority: owner.publicKey, vault: vaultPda, relayPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log(`Withdrew ${relayBal / 1e9} SOL from relay PDA back to authority`);
        }
      }
    } catch (err: any) {
      console.log("Cleanup: could not withdraw relay SOL:", err.message?.substring(0, 100));
    }

    // Return remaining relayer SOL
    try {
      const relayerBal = await provider.connection.getBalance(relayer.publicKey);
      if (relayerBal > 0) {
        const returnTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: owner.publicKey,
            lamports: relayerBal,
          })
        );
        returnTx.feePayer = owner.publicKey;
        await provider.sendAndConfirm(returnTx, [owner, relayer]);
        console.log(`Returned ${relayerBal / 1e9} SOL from relayer to owner`);
      }
    } catch (err: any) {
      console.log("Cleanup: could not return relayer SOL:", err.message?.substring(0, 100));
    }

    // Return SOL from non-owner user wallets back to owner
    for (const u of users) {
      if (u.wallet.publicKey.equals(owner.publicKey)) continue;
      try {
        const userBal = await provider.connection.getBalance(u.wallet.publicKey);
        if (userBal > 5000) {
          const returnTx = new anchor.web3.Transaction().add(
            SystemProgram.transfer({
              fromPubkey: u.wallet.publicKey,
              toPubkey: owner.publicKey,
              lamports: userBal - 5000,
            })
          );
          returnTx.feePayer = owner.publicKey;
          await provider.sendAndConfirm(returnTx, [owner, u.wallet]);
          console.log(`Returned ${(userBal - 5000) / 1e9} SOL from ${u.name} to owner`);
        }
      } catch (err: any) {
        console.log(`Could not return SOL from ${u.name}:`, err.message?.substring(0, 80));
      }
    }

    logSeparator("SEQUENTIAL FLOW SUMMARY");
    console.log("");
    console.log(`  Multi-user sequential test with ${users.length} users:`);
    console.log("");
    console.log("  DEPOSIT ORDER:");
    for (const u of users) {
      console.log(`    ${u.name}: ${u.baseDepositAmount} base + ${u.quoteDepositAmount} quote`);
    }
    console.log("");
    console.log("  WITHDRAWAL ORDER:");
    console.log(`    User2 withdrew mid-flow (partial Meteora withdrawal)`);
    console.log(`    User1 + User3 withdrew remaining`);
    console.log("");
    for (const u of users) {
      console.log(`    ${u.name}: withdrew ${u.decryptedBaseWithdraw || "N/A"} base + ${u.decryptedQuoteWithdraw || "N/A"} quote`);
    }
    logBN("  Cumulative Meteora liquidity tracked", cumulativeMeteoraLiquidity);
    logKeyValue("  Cumulative base deposited", cumulativeBaseDeposited);
    logKeyValue("  Cumulative quote deposited", cumulativeQuoteDeposited);
    console.log("");
    console.log("  PRIVACY LAYERS:");
    console.log("  - Arcium MPC: Individual amounts never visible on-chain");
    console.log("  - Relay PDA: Single aggregate position in Meteora (no per-user positions)");
    console.log("  - Ephemeral wallets: Fresh keypair per operation, abandoned after use");
    console.log("  - Sequential batches: Each user's deposit processed independently");
    console.log("");
    // Clear vault file — all keypairs recovered successfully
    const kpVault = (globalThis as any).__kpVault_integration;
    if (kpVault) kpVault.clear();

    console.log("=".repeat(60));
    console.log("Integration test complete.");
    console.log("=".repeat(60));
  });

  // Helper: initialize computation definitions (idempotent)
  async function initCompDef(
    program: Program<ZodiacLiquidity>,
    owner: Keypair,
    circuitName: string,
    methodName: string
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
    const offset = getCompDefAccOffset(circuitName);

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];

    const accountInfo = await withRetry(() => provider.connection.getAccountInfo(compDefPDA));
    if (accountInfo !== null && accountInfo.owner.equals(getArciumProgramId())) {
      console.log(`${circuitName} comp def already exists, skipping`);
      return "skipped";
    }

    // v0.7.0: LUT address from MXE account's lut_offset_slot (see migration-v0.6.3-to-v0.7.0)
    const mxePda = getMXEAccAddress(program.programId);
    const arciumProgram = getArciumProgram(provider);
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
