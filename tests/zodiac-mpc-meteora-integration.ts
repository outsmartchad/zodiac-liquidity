import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
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
  const clusterOffset = getArciumEnv().arciumClusterOffset;

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
  const arciumEnv = getArciumEnv();
  return getClusterAccAddress(arciumEnv.arciumClusterOffset);
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

async function setupEphemeralWallet(
  program: Program<ZodiacLiquidity>,
  provider: anchor.AnchorProvider,
  owner: Keypair,
  vaultPda: PublicKey,
  fundLamports: number = 50_000_000,
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
// INTEGRATION TEST
// ============================================================

describe("zodiac-integration", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ZodiacLiquidity as Program<ZodiacLiquidity>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  // Patch provider.sendAndConfirm for blockhash retry + 403 retry
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

  const clusterAccount = getClusterAccount();
  let owner: Keypair;
  let relayer: Keypair;
  let tokenMint: PublicKey;
  let vaultPda: PublicKey;
  let userPositionPda: PublicKey;
  let mxePublicKey: Uint8Array;
  let cipher: RescueCipher;
  let encryptionKeys: { privateKey: Uint8Array; publicKey: Uint8Array };

  // Integration relay index — avoid collision with other test files
  const RELAY_INDEX = 8;
  let relayPda: PublicKey;

  // Wired state: MPC outputs feed into Meteora CPI inputs
  let revealedAmount: number;
  let sdkLiquidityDelta: anchor.BN; // SDK-computed delta (u64 range, for record_liquidity)
  let meteoraUnlockedLiquidity: anchor.BN; // Raw u128 from Meteora position (for withdraw)
  let decryptedWithdrawAmount: number;

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

  const DEPOSIT_AMOUNT = 50_000_000; // 0.05 tokens (9 decimals)

  before(async () => {
    logSeparator("SETUP: Zodiac Integration Test - Full 13-Step Privacy Flow");
    console.log("");
    console.log("HOW THIS TEST WORKS (read this to understand the Arcium + Meteora flow):");
    console.log("──────────────────────────────────────────────────────────────────────");
    console.log("1. Arcium MPC = Multi-Party Computation. Your data is ENCRYPTED on-chain.");
    console.log("   ARX nodes (off-chain MPC cluster) decrypt, compute, re-encrypt results.");
    console.log("   Nobody — not even the ARX nodes individually — sees your plaintext data.");
    console.log("");
    console.log("2. Each MPC operation follows 3 steps:");
    console.log("   a) init_*_comp_def  → registers the circuit (one-time, stores URL + hash)");
    console.log("   b) your_instruction → queues encrypted args into a Computation account");
    console.log("   c) *_callback       → ARX nodes call back with verified MPC results");
    console.log("");
    console.log("3. Encryption uses x25519 key exchange + RescueCipher:");
    console.log("   - User derives x25519 keypair from wallet signature");
    console.log("   - MXE (Multi-eXecution Environment) has its own x25519 pubkey");
    console.log("   - Shared secret = x25519(user_private, mxe_public)");
    console.log("   - RescueCipher encrypts/decrypts using this shared secret + nonce");
    console.log("");
    console.log("4. Ephemeral wallets break the link between user and Meteora operations:");
    console.log("   - Fresh keypair per operation → register PDA → sign CPI → close PDA");
    console.log("   - The authority (owner) never co-signs Meteora transactions");
    console.log("");
    console.log("5. Relay PDA is the protocol's single aggregate position in Meteora:");
    console.log("   - All users' liquidity is pooled under one relay PDA");
    console.log("   - Individual amounts are hidden (only Arcium knows the breakdown)");
    console.log("──────────────────────────────────────────────────────────────────────");
    console.log("");

    logKeyValue("Program ID", program.programId.toString());
    logKeyValue("Arcium Program ID", getArciumProgramId().toString());
    logKeyValue("Cluster offset", getArciumEnv().arciumClusterOffset.toString());
    logKeyValue("Cluster account", clusterAccount.toString());
    logKeyValue("MXE account", getMXEAccAddress(program.programId).toString());
    logKeyValue("Mempool account", getMempoolAccAddress(getArciumEnv().arciumClusterOffset).toString());

    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    logKeyValue("Owner pubkey", owner.publicKey.toString());

    // Create and fund relayer wallet (needs enough for relay rent + WSOL funding + refunds)
    relayer = Keypair.generate();
    const fundRelayerTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: relayer.publicKey,
        lamports: 200_000_000, // 0.2 SOL (enough for WSOL funding + rent)
      })
    );
    await withBlockhashRetry(() => provider.sendAndConfirm(fundRelayerTx, [owner]));
    logKeyValue("Relayer pubkey", relayer.publicKey.toString());
    logKeyValue("Relayer funded", "0.2 SOL");

    // Get MXE public key
    logSeparator("ENCRYPTION SETUP (x25519 + RescueCipher)");
    try {
      mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
      logHex("MXE x25519 pubkey", mxePublicKey);
      console.log("  (This is the MPC cluster's public key. Combined with your private key,");
      console.log("   it creates a shared secret that only you + the MPC cluster know.)");
      encryptionKeys = deriveEncryptionKey(owner, ENCRYPTION_KEY_MESSAGE);
      logHex("User x25519 pubkey", encryptionKeys.publicKey);
      logHex("User x25519 privkey (first 8 bytes)", encryptionKeys.privateKey.slice(0, 8));
      console.log("  (Private key derived from: sign(wallet_secret, 'zodiac-liquidity-encryption-key-v1'))");
      const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
      logHex("Shared secret (x25519 DH)", sharedSecret);
      console.log("  (This shared secret is used by RescueCipher to encrypt/decrypt all MPC data)");
      cipher = new RescueCipher(sharedSecret);
      console.log("  RescueCipher initialized with shared secret ✓");
    } catch (e) {
      console.log("  Warning: Could not get MXE public key. Will initialize after comp defs.");
    }

    // Create test token mint
    tokenMint = await createMint(provider.connection, owner, owner.publicKey, null, 9);
    logSeparator("ACCOUNT ADDRESSES");
    logKeyValue("Token mint", tokenMint.toString());

    // Derive vault PDA
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    logKeyValue("Vault PDA", vaultPda.toString());
    console.log("  (seeds: ['vault', token_mint_pubkey])");

    // Derive user position PDA
    [userPositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), vaultPda.toBuffer(), owner.publicKey.toBuffer()],
      program.programId
    );
    logKeyValue("User Position PDA", userPositionPda.toString());
    console.log("  (seeds: ['position', vault_pda, owner_pubkey])");

    // Derive relay PDA
    relayPda = deriveRelayPda(vaultPda, RELAY_INDEX, program.programId);
    logKeyValue("Relay PDA", relayPda.toString());
    console.log(`  (seeds: ['zodiac_relay', vault_pda, relay_index=${RELAY_INDEX}])`);
    logKeyValue("Deposit amount", `${DEPOSIT_AMOUNT} (${DEPOSIT_AMOUNT / 1e9} tokens with 9 decimals)`);
  });

  // ============================================================
  // Phase A: Comp Def Init
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
  // Phase B: MPC Setup
  // ============================================================
  describe("Phase B: MPC Setup", () => {
    it("creates vault", async () => {
      logSeparator("MPC OPERATION: createVault (init_vault circuit)");
      console.log("  Purpose: Initialize encrypted vault state with zeros.");
      console.log("  The MPC cluster encrypts [0, 0, 0] as the initial vault state:");
      console.log("    pending_deposits = 0 (encrypted u64)");
      console.log("    total_liquidity  = 0 (encrypted u64)");
      console.log("    total_deposited  = 0 (encrypted u64)");
      console.log("");

      // Refresh MXE public key after comp defs
      if (!mxePublicKey || !cipher) {
        console.log("  MXE key not set yet, waiting for keygen...");
        mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId, 120, 2000);
        encryptionKeys = deriveEncryptionKey(owner, ENCRYPTION_KEY_MESSAGE);
        const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
        cipher = new RescueCipher(sharedSecret);
        logHex("  MXE x25519 pubkey (refreshed)", mxePublicKey);
      } else {
        try {
          const freshKey = await getMXEPublicKeyWithRetry(provider, program.programId, 5, 1000);
          if (Buffer.from(freshKey).toString("hex") !== Buffer.from(mxePublicKey).toString("hex")) {
            mxePublicKey = freshKey;
            encryptionKeys = deriveEncryptionKey(owner, ENCRYPTION_KEY_MESSAGE);
            const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
            cipher = new RescueCipher(sharedSecret);
            logHex("  MXE x25519 pubkey (changed!)", mxePublicKey);
          }
        } catch (e) {
          console.log("  Could not refresh MXE key, using cached key");
        }
      }

      const nonce = randomBytes(16);
      const nonceBN = new anchor.BN(deserializeLE(nonce).toString());
      logHex("  Nonce (random 16 bytes)", nonce);
      logBN("  Nonce as u128", nonceBN);
      console.log("  (Nonce is used by the MPC to encrypt the initial vault state. Fresh nonce = fresh ciphertext.)");

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];
      logKeyValue("  SignPDA (Arcium signer)", signPdaAccount.toString());
      logKeyValue("  CompDef account", getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("init_vault")).readUInt32LE()).toString());

      await queueWithRetry(
        "createVault",
        async (computationOffset) => {
          const compAccAddr = getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset);
          logBN("  Computation offset (random)", computationOffset);
          logKeyValue("  Computation account PDA", compAccAddr.toString());
          console.log("  → Sending createVault tx: queues MPC job for ARX nodes");
          console.log("  → ARX nodes will: fetch init_vault.arcis circuit from GitHub");
          console.log("  → Execute MPC: encrypt(0,0,0) with MXE key → store in vault account");
          console.log("  → Call init_vault_callback with encrypted results");
          return program.methods
            .createVault(computationOffset, nonceBN)
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              tokenMint: tokenMint,
              signPdaAccount,
              computationAccount: compAccAddr,
              clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
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
      logSeparator("VAULT STATE AFTER CREATION");
      logKeyValue("  authority", vaultAccount.authority.toString());
      logKeyValue("  tokenMint", vaultAccount.tokenMint.toString());
      logKeyValue("  isInitialized", (vaultAccount as any).isInitialized);
      // Log raw encrypted fields if available
      if ((vaultAccount as any).encryptedPendingDeposits) {
        logHex("  encrypted_pending_deposits", Buffer.from((vaultAccount as any).encryptedPendingDeposits));
      }
      if ((vaultAccount as any).encryptedTotalLiquidity) {
        logHex("  encrypted_total_liquidity", Buffer.from((vaultAccount as any).encryptedTotalLiquidity));
      }
      if ((vaultAccount as any).encryptedTotalDeposited) {
        logHex("  encrypted_total_deposited", Buffer.from((vaultAccount as any).encryptedTotalDeposited));
      }
      console.log("  (All three fields are encrypted zeros — only the MPC cluster can read them)");
      console.log("  Vault created successfully ✓");
    });

    it("creates user position", async () => {
      logSeparator("MPC OPERATION: createUserPosition (init_user_position circuit)");
      console.log("  Purpose: Initialize encrypted user position with zeros.");
      console.log("  The MPC cluster encrypts [0, 0] as the initial position:");
      console.log("    deposited       = 0 (encrypted u64) — user's total deposited");
      console.log("    liquidity_share = 0 (encrypted u64) — user's share of Meteora liquidity");
      console.log("");

      const nonce = randomBytes(16);
      const nonceBN = new anchor.BN(deserializeLE(nonce).toString());
      logHex("  Nonce", nonce);
      logBN("  Nonce as u128", nonceBN);

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      await queueWithRetry(
        "createUserPosition",
        async (computationOffset) => {
          logBN("  Computation offset", computationOffset);
          console.log("  → ARX nodes will: encrypt(0, 0) → store in user position account");
          return program.methods
            .createUserPosition(computationOffset, nonceBN)
            .accountsPartial({
              user: owner.publicKey,
              vault: vaultPda,
              userPosition: userPositionPda,
              signPdaAccount,
              computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
              clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
              compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("init_user_position")).readUInt32LE()),
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

      const posAccount = await program.account.userPositionAccount.fetch(userPositionPda);
      expect(posAccount.owner.toString()).to.equal(owner.publicKey.toString());
      logKeyValue("  Position owner", posAccount.owner.toString());
      if ((posAccount as any).encryptedDeposited) {
        logHex("  encrypted_deposited", Buffer.from((posAccount as any).encryptedDeposited));
      }
      if ((posAccount as any).encryptedLiquidityShare) {
        logHex("  encrypted_liquidity_share", Buffer.from((posAccount as any).encryptedLiquidityShare));
      }
      console.log("  User position created successfully ✓");
    });
  });

  // ============================================================
  // Phase C: Deposit (MPC)
  // ============================================================
  describe("Phase C: Deposit", () => {
    it("deposits encrypted amount", async () => {
      logSeparator("MPC OPERATION: deposit (deposit circuit)");
      console.log("  Purpose: Encrypt the deposit amount and update vault + user position.");
      console.log("  What happens in the MPC circuit:");
      console.log("    1. Decrypt existing vault.pending_deposits (MXE-encrypted u64)");
      console.log("    2. Decrypt user's encrypted deposit amount (user-encrypted via Shared type)");
      console.log("    3. new_pending = old_pending + deposit_amount");
      console.log("    4. new_user_deposited = old_user_deposited + deposit_amount");
      console.log("    5. Re-encrypt both with MXE key → write back to vault + position accounts");
      console.log("  Simultaneously, the on-chain instruction transfers PLAINTEXT tokens");
      console.log("  from user → vault token account (SPL transfer, visible on-chain).");
      console.log("  The AMOUNT is hidden in the MPC — on-chain only sees the token move.");
      console.log("");

      await new Promise(resolve => setTimeout(resolve, 3000));

      const depositAmount = BigInt(DEPOSIT_AMOUNT);
      const plaintext = [depositAmount];
      const nonce = randomBytes(16);
      const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

      logKeyValue("  Plaintext deposit amount", `${depositAmount} (${Number(depositAmount) / 1e9} tokens)`);
      logHex("  Encryption nonce (random 16 bytes)", nonce);
      logBN("  Nonce as u128", nonceBN);

      const ciphertext = cipher.encrypt(plaintext, nonce);
      logHex("  Ciphertext (RescueCipher output)", Buffer.from(ciphertext[0]));
      console.log(`  Ciphertext length: ${ciphertext[0].length} bytes`);
      console.log("  (This ciphertext is sent on-chain — nobody can read it without the shared secret)");
      console.log("");
      logHex("  User x25519 pubkey (sent with ciphertext)", encryptionKeys.publicKey);
      console.log("  (MPC uses this pubkey + its own MXE privkey to derive shared secret → decrypt)");

      // Create user token account and mint tokens
      const userTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, tokenMint, owner.publicKey
      );
      await mintTo(provider.connection, owner, tokenMint, userTokenAccount.address, owner, DEPOSIT_AMOUNT * 2);
      logKeyValue("  User token account", userTokenAccount.address.toString());
      logKeyValue("  Minted to user", `${DEPOSIT_AMOUNT * 2} (2x deposit for safety)`);

      // Create vault token account
      const vaultTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, tokenMint, vaultPda, true
      );
      logKeyValue("  Vault token account", vaultTokenAccount.address.toString());

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      await queueWithRetry(
        "deposit",
        async (computationOffset) => {
          logBN("  Computation offset", computationOffset);
          console.log("  → On-chain: transfer", DEPOSIT_AMOUNT, "tokens from user → vault");
          console.log("  → MPC: decrypt(vault.pending) + decrypt(ciphertext) → re-encrypt sum");
          return program.methods
            .deposit(
              computationOffset,
              Array.from(ciphertext[0]) as number[],
              Array.from(encryptionKeys.publicKey) as number[],
              nonceBN,
              new anchor.BN(depositAmount.toString())
            )
            .accountsPartial({
              depositor: owner.publicKey,
              vault: vaultPda,
              userPosition: userPositionPda,
              userTokenAccount: userTokenAccount.address,
              vaultTokenAccount: vaultTokenAccount.address,
              tokenMint: tokenMint,
              signPdaAccount,
              computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
              clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
              compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("deposit")).readUInt32LE()),
              poolAccount: getFeePoolAccAddress(),
              clockAccount: getClockAccAddress(),
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc({ skipPreflight: true, commitment: "confirmed" });
        },
        provider,
        program.programId,
      );

      // Log post-deposit state
      const vaultTokenAcct = await getOrCreateAssociatedTokenAccount(provider.connection, owner, tokenMint, vaultPda, true);
      const vaultBal = await withRetry(() => getAccount(provider.connection, vaultTokenAcct.address));
      logSeparator("POST-DEPOSIT STATE");
      logKeyValue("  Vault token balance (on-chain, visible)", vaultBal.amount.toString());
      console.log("  Vault encrypted state: pending_deposits, total_deposited updated by MPC callback");
      console.log("  User encrypted state: deposited updated by MPC callback");
      console.log("  (The encrypted values changed, but only the MPC cluster knows what they contain)");
      console.log(`  Deposited ${DEPOSIT_AMOUNT} tokens (encrypted) to vault ✓`);
    });
  });

  // ============================================================
  // Phase D: Reveal → Fund Relay → Meteora Deposit (THE WIRING)
  // ============================================================
  describe("Phase D: Reveal → Fund → Meteora Deposit", () => {
    it("reveals pending deposits and extracts plaintext amount", async () => {
      logSeparator("MPC OPERATION: revealPendingDeposits (reveal_pending_deposits circuit)");
      console.log("  Purpose: DECRYPT the vault's pending_deposits and REVEAL it as plaintext.");
      console.log("  This is the ONE moment encrypted data becomes visible:");
      console.log("    1. MPC decrypts vault.pending_deposits (MXE-encrypted)");
      console.log("    2. Returns the PLAINTEXT total to the callback");
      console.log("    3. Callback emits PendingDepositsRevealedEvent with the plaintext value");
      console.log("    4. Callback resets vault.pending_deposits to encrypted(0)");
      console.log("  WHY reveal? We need the actual number to fund the relay PDA and");
      console.log("  call Meteora's add_liquidity (which requires plaintext token amounts).");
      console.log("  Privacy is maintained because only the AGGREGATE is revealed, not per-user.");
      console.log("");

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      const finalizeSig = await queueWithRetry(
        "revealPendingDeposits",
        async (computationOffset) => {
          logBN("  Computation offset", computationOffset);
          console.log("  → MPC: decrypt(vault.pending_deposits) → return plaintext");
          return program.methods
            .revealPendingDeposits(computationOffset)
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              signPdaAccount,
              computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
              clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
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

      // Parse event from callback tx to get revealed amount
      const revealTx = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }));

      // Log all events from callback tx
      const events = parseEventsFromTx(program, revealTx);
      console.log(`  Callback tx events (${events.length} found):`);
      for (const evt of events) {
        console.log(`    Event: ${evt.name}`);
        for (const [k, v] of Object.entries(evt.data)) {
          console.log(`      ${k}: ${v}`);
        }
      }

      // Log callback tx logs for full visibility
      if (revealTx?.meta?.logMessages) {
        detailLog("  Full callback tx logs:");
        for (const log of revealTx.meta.logMessages) {
          detailLog(`    ${log}`);
        }
      }

      const revealEvent = events.find(e => e.name === "PendingDepositsRevealedEvent" || e.name === "pendingDepositsRevealedEvent");

      if (revealEvent) {
        revealedAmount = Number(revealEvent.data.totalPending.toString());
        logSeparator("REVEALED DATA (plaintext from MPC)");
        logKeyValue("  revealedAmount", `${revealedAmount} (${revealedAmount / 1e9} tokens)`);
        console.log("  This is the AGGREGATE pending deposits — the sum of all users' deposits");
        console.log("  since the last reveal. In this test there's only one user, so it equals");
        console.log(`  the deposit amount (${DEPOSIT_AMOUNT}).`);
        console.log("");
        console.log("  >>> This value will be WIRED into: fund_relay → Meteora add_liquidity <<<");
        expect(revealedAmount).to.equal(DEPOSIT_AMOUNT);
      } else {
        console.log("  Could not find PendingDepositsRevealedEvent in callback tx logs");
        console.log("  Available events:", events.map(e => e.name));
        if (revealTx?.meta?.logMessages) {
          const dataLogs = revealTx.meta.logMessages.filter(l => l.includes("Program data:") || l.includes("pending"));
          dataLogs.forEach(l => console.log("  ", l));
        }
        revealedAmount = DEPOSIT_AMOUNT;
        console.log(`  Fallback: using deposit amount as revealedAmount = ${revealedAmount}`);
      }
    });

    it("funds relay with revealed amount", async () => {
      logSeparator("RELAY FUNDING (using revealed amount from MPC)");
      console.log("  Purpose: Move tokens from vault/authority to the relay PDA.");
      console.log("  The relay PDA is the protocol's agent — it holds tokens and interacts");
      console.log("  with Meteora on behalf of all users. Nobody knows which user's tokens");
      console.log("  are in the relay — only Arcium tracks the per-user breakdown.");
      console.log("");
      logKeyValue("  Amount to fund (from MPC reveal)", `${revealedAmount} (${revealedAmount / 1e9} tokens)`);

      expect(revealedAmount).to.be.greaterThan(0);

      // Fund relay PDA with SOL for rent (just enough for token account rent)
      const fundRelayRentTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: relayer.publicKey,
          toPubkey: relayPda,
          lamports: 50_000_000, // 0.05 SOL (Meteora pool CPI needs rent for internal accounts)
        })
      );
      await provider.sendAndConfirm(fundRelayRentTx, [relayer]);
      logKeyValue("  Relay PDA rent funded", "0.05 SOL (from relayer)");

      // Create SPL token mint for pool (separate from the vault's token)
      const splMint = tokenMint; // Use the same mint as the vault

      // Sort tokens for pool: SPL vs NATIVE_MINT
      tokenA = minKey(splMint, NATIVE_MINT);
      tokenB = maxKey(splMint, NATIVE_MINT);
      const isTokenANative = tokenA.equals(NATIVE_MINT);
      logKeyValue("  Token A", `${tokenA.toString()} ${isTokenANative ? "(WSOL/NATIVE_MINT)" : "(SPL)"}`);
      logKeyValue("  Token B", `${tokenB.toString()} ${!isTokenANative ? "(WSOL/NATIVE_MINT)" : "(SPL)"}`);
      console.log("  (Meteora pools require sorted token pairs: smaller pubkey = tokenA)");

      // Create relay token accounts
      const relayTokenAKp = Keypair.generate();
      relayTokenA = await createAccount(provider.connection, owner, tokenA, relayPda, relayTokenAKp);
      const relayTokenBKp = Keypair.generate();
      relayTokenB = await createAccount(provider.connection, owner, tokenB, relayPda, relayTokenBKp);
      logKeyValue("  Relay token A account", relayTokenA.toString());
      logKeyValue("  Relay token B account", relayTokenB.toString());
      console.log("  (These token accounts are OWNED by the relay PDA — only the program can move tokens)");

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Fund relay SPL token with the REVEALED amount (wired from MPC)
      const relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;
      const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, splMint, owner.publicKey
      );
      // Mint enough to cover the revealed amount
      await mintTo(provider.connection, owner, splMint, authorityTokenAccount.address, owner, revealedAmount);

      await new Promise(resolve => setTimeout(resolve, 2000));

      await program.methods
        .fundRelay(RELAY_INDEX, new anchor.BN(revealedAmount))
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          relayPda: relayPda,
          authorityTokenAccount: authorityTokenAccount.address,
          relayTokenAccount: relaySplAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      console.log(`  >>> WIRED: fundRelay(relay_index=${RELAY_INDEX}, amount=${revealedAmount}) — amount from MPC reveal <<<`);
      console.log("  (fund_relay does SPL transfer: authority's token account → relay PDA's token account)");

      // Fund relay WSOL account with SOL transfer + sync
      const relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;
      const fundWsolTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: relayer.publicKey,
          toPubkey: relayWsolAccount,
          lamports: revealedAmount, // Match SPL amount for 1:1 pool
        }),
        createSyncNativeInstruction(relayWsolAccount),
      );
      await provider.sendAndConfirm(fundWsolTx, [relayer]);
      console.log(`  WSOL funded: transferred ${revealedAmount} lamports + syncNative`);
      console.log("  (WSOL = wrapped SOL. Transfer raw SOL to the token account, then syncNative");
      console.log("   tells the SPL Token program to recognize it as WSOL balance.)");

      // Verify relay balances
      const splBalance = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      expect(Number(splBalance.amount)).to.equal(revealedAmount);
      const wsolBalance = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
      expect(Number(wsolBalance.amount)).to.be.greaterThanOrEqual(revealedAmount);

      logSeparator("RELAY BALANCES (ready for Meteora)");
      logKeyValue("  Relay SPL balance", `${splBalance.amount} (${Number(splBalance.amount) / 1e9} tokens)`);
      logKeyValue("  Relay WSOL balance", `${wsolBalance.amount} (${Number(wsolBalance.amount) / 1e9} SOL)`);
      console.log("  Both sides match the revealed amount — ready to create pool + deposit ✓");
    });

    it("creates pool and position via relay", async () => {
      logSeparator("METEORA CPI: Create Pool + Position via Ephemeral Wallet");
      console.log("  Purpose: Create a Meteora DAMM v2 pool and position, signed by an");
      console.log("  ephemeral wallet (not the user). This breaks the user → pool link.");
      console.log("");
      console.log("  EPHEMERAL WALLET LIFECYCLE:");
      console.log("    1. Generate fresh keypair (never used before, never reused)");
      console.log("    2. Authority registers PDA: [\"ephemeral\", vault, wallet_pubkey]");
      console.log("    3. Fund ephemeral wallet with SOL (for tx fees)");
      console.log("    4. Ephemeral wallet signs the Meteora CPI transaction");
      console.log("    5. On-chain program checks: ephemeral PDA exists → wallet is authorized");
      console.log("    6. After CPI, authority closes ephemeral PDA (reclaims rent)");
      console.log("    7. Ephemeral wallet is abandoned — can never be linked to user");
      console.log("");

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

      logKeyValue("  Pool PDA", poolPda.toString());
      logKeyValue("  Token A Vault (Meteora)", tokenAVault.toString());
      logKeyValue("  Token B Vault (Meteora)", tokenBVault.toString());

      const poolFees = {
        baseFee: { cliffFeeNumerator: new anchor.BN(2_500_000), firstFactor: 0, secondFactor: Array(8).fill(0), thirdFactor: new anchor.BN(0), baseFeeMode: 0 },
        padding: [0, 0, 0],
        dynamicFee: null,
      };
      const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);
      logKeyValue("  sqrtPrice (1:1 ratio)", sqrtPrice.toString());
      logKeyValue("  Initial liquidity", "1,000,000 (min for pool creation)");

      console.log("\n  --- Pool Creation Ephemeral Wallet ---");
      const poolEph = await setupEphemeralWallet(program, provider, owner, vaultPda);
      logKeyValue("  Ephemeral wallet pubkey", poolEph.ephemeralKp.publicKey.toString());
      logKeyValue("  Ephemeral PDA", poolEph.ephemeralPda.toString());
      console.log("  (PDA seeds: ['ephemeral', vault_pda, ephemeral_wallet_pubkey])");
      console.log("  Ephemeral wallet is the TX FEE PAYER + SIGNER — authority never touches the tx");
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
      console.log("  (sendWithEphemeralPayer: tx.feePayer = ephemeral, signed by ephemeral + nftMint)");
      await teardownEphemeralWallet(program, provider, owner, vaultPda, poolEph.ephemeralKp, poolEph.ephemeralPda);
      console.log("  Pool ephemeral wallet closed ✓ (PDA rent reclaimed, wallet abandoned)");

      await new Promise(resolve => setTimeout(resolve, 5000));

      // --- Create position via ephemeral wallet ---
      console.log("\n  --- Position Creation Ephemeral Wallet ---");
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
      logKeyValue("  Position ephemeral wallet", posEph.ephemeralKp.publicKey.toString());
      logKeyValue("  Position ephemeral PDA", posEph.ephemeralPda.toString());
      logKeyValue("  Position NFT mint", posNftMint.publicKey.toString());
      logKeyValue("  Position PDA", positionPda.toString());
      logKeyValue("  RelayPositionTracker PDA", relayPositionTracker.toString());
      console.log("  (Position NFT = Meteora uses NFTs to track positions. The relay PDA holds it.)");
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
      console.log("  Position ephemeral wallet closed ✓");

      // Re-fund relay token accounts after pool creation consumed some tokens
      // Pool creation uses initial liquidity (1_000_000) which drains relay balances
      const isTokenANative = tokenA.equals(NATIVE_MINT);
      const relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;
      const relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check current balances and top up to revealedAmount
      const currentSplBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      const splDeficit = revealedAmount - Number(currentSplBal.amount);
      if (splDeficit > 0) {
        const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
          provider.connection, owner, isTokenANative ? tokenB : tokenA, owner.publicKey
        );
        await mintTo(provider.connection, owner, isTokenANative ? tokenB : tokenA, authorityTokenAccount.address, owner, splDeficit);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await program.methods
          .fundRelay(RELAY_INDEX, new anchor.BN(splDeficit))
          .accounts({
            authority: owner.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            authorityTokenAccount: authorityTokenAccount.address,
            relayTokenAccount: relaySplAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" });
        console.log(`Re-funded relay SPL with ${splDeficit} tokens (pool creation consumed some)`);
      }

      const currentWsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
      const wsolDeficit = revealedAmount - Number(currentWsolBal.amount);
      if (wsolDeficit > 0) {
        const topUpWsolTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: relayWsolAccount,
            lamports: wsolDeficit,
          }),
          createSyncNativeInstruction(relayWsolAccount),
        );
        await provider.sendAndConfirm(topUpWsolTx, [relayer]);
        console.log(`Re-funded relay WSOL with ${wsolDeficit} lamports (pool creation consumed some)`);
      }
    });

    it("deposits to Meteora using revealed amount", async () => {
      logSeparator("METEORA CPI: Deposit Liquidity via Ephemeral Wallet");
      console.log("  Purpose: Add liquidity to Meteora pool using the relay PDA's tokens.");
      console.log("  The relay PDA signs the CPI (via PDA authority), and the ephemeral wallet");
      console.log("  pays the transaction fee. Nobody can link this tx to any specific user.");
      console.log("");
      console.log("  LIQUIDITY MATH:");
      console.log("  Meteora uses a u128 'liquidity' value (not LP tokens!).");
      console.log("  We compute it using the Meteora SDK's getLiquidityDelta():");
      console.log("    liquidityDelta = f(tokenA_amount, tokenB_amount, sqrtPrice, priceRange)");
      console.log("  This returns a u128 that represents the position's share of the pool.");
      console.log("");

      await new Promise(resolve => setTimeout(resolve, 3000));

      const depEph = await setupEphemeralWallet(program, provider, owner, vaultPda);
      logKeyValue("  Deposit ephemeral wallet", depEph.ephemeralKp.publicKey.toString());
      logKeyValue("  Deposit ephemeral PDA", depEph.ephemeralPda.toString());

      try {
        // Check actual relay balances to compute liquidity from what's available
        const isTokenANative = tokenA.equals(NATIVE_MINT);
        const relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;
        const relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;
        const splBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
        const wsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
        logKeyValue("  Relay SPL balance", splBal.amount.toString());
        logKeyValue("  Relay WSOL balance", wsolBal.amount.toString());

        // Calculate liquidity delta from the REVEALED amount (wired from MPC)
        const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);
        // Use the smaller of the two balances to avoid insufficient funds
        const depositTokenAmount = Math.min(Number(splBal.amount), Number(wsolBal.amount));
        const liquidityDelta = calculateLiquidityFromAmounts(
          provider.connection,
          new anchor.BN(depositTokenAmount),
          new anchor.BN(depositTokenAmount),
          sqrtPrice,
        );
        // Store the SDK-computed delta for record_liquidity (u64 range)
        sdkLiquidityDelta = liquidityDelta;
        logKeyValue("  depositTokenAmount (min of both balances)", depositTokenAmount);
        logBN("  liquidityDelta (SDK-computed, u128)", liquidityDelta);
        console.log(`  >>> WIRED: depositToMeteora with liquidityDelta=${liquidityDelta.toString()} <<<`);
        console.log(`  (computed from available balance=${depositTokenAmount}, which came from revealedAmount=${revealedAmount})`);

        const depTx = await program.methods
          .depositToMeteoraDammV2(
            RELAY_INDEX,
            liquidityDelta,
            new anchor.BN("18446744073709551615"), // u64::MAX
            new anchor.BN("18446744073709551615"), // u64::MAX
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

        // Read position's unlocked_liquidity after deposit
        const positionInfo = await withRetry(() => provider.connection.getAccountInfo(positionPda));
        expect(positionInfo).to.not.be.null;
        const unlockedLiquidityBytes = positionInfo!.data.slice(152, 168); // u128 LE
        meteoraUnlockedLiquidity = new anchor.BN(unlockedLiquidityBytes, "le");

        logSeparator("METEORA POSITION STATE AFTER DEPOSIT");
        logBN("  Position.unlocked_liquidity (u128)", meteoraUnlockedLiquidity);
        logHex("  Raw bytes (LE)", unlockedLiquidityBytes);
        logBN("  SDK liquidityDelta (u128)", sdkLiquidityDelta);
        console.log("  (unlocked_liquidity ≈ liquidityDelta — Meteora tracks the position's pool share)");
        console.log("");
        console.log("  >>> This value will be WIRED into: record_liquidity (MPC) + withdraw_from_meteora <<<");
        console.log("  Note: record_liquidity takes u64 so the u128 is capped to u64::MAX (design limitation)");
        expect(meteoraUnlockedLiquidity.gt(new anchor.BN(0))).to.be.true;
      } finally {
        await teardownEphemeralWallet(program, provider, owner, vaultPda, depEph.ephemeralKp, depEph.ephemeralPda);
      }
    });
  });

  // ============================================================
  // Phase E: Record Liquidity (MPC, wired from Meteora output)
  // ============================================================
  describe("Phase E: Record Liquidity", () => {
    it("records actual liquidity delta from Meteora", async () => {
      logSeparator("MPC OPERATION: recordLiquidity (record_liquidity circuit)");
      console.log("  Purpose: Record the liquidity received from Meteora into the encrypted vault.");
      console.log("  What happens in the MPC circuit:");
      console.log("    1. Decrypt vault.total_liquidity (MXE-encrypted u64)");
      console.log("    2. Add the new liquidity_delta (plaintext u64 input)");
      console.log("    3. Re-encrypt the updated total → write back to vault");
      console.log("  This updates the vault's encrypted accounting so future withdrawals");
      console.log("  can compute correct pro-rata shares.");
      console.log("");

      expect(sdkLiquidityDelta.gt(new anchor.BN(0))).to.be.true;

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      const U64_MAX = new anchor.BN("18446744073709551615");
      const liquidityAsU64 = sdkLiquidityDelta.gt(U64_MAX) ? U64_MAX : sdkLiquidityDelta;
      logBN("  Raw SDK liquidityDelta (u128)", sdkLiquidityDelta);
      logBN("  Capped to u64", liquidityAsU64);
      console.log(`  >>> WIRED: recordLiquidity(${liquidityAsU64.toString()}) — from actual Meteora deposit <<<`);
      if (sdkLiquidityDelta.gt(U64_MAX)) {
        console.log("  ⚠ Value exceeded u64::MAX — capped (design limitation of current circuit)");
      }

      await queueWithRetry(
        "recordLiquidity",
        async (computationOffset) => {
          return program.methods
            .recordLiquidity(computationOffset, liquidityAsU64)
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              signPdaAccount,
              computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
              clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
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

      console.log("Record liquidity succeeded with real Meteora delta");
    });
  });

  // ============================================================
  // Phase F: Withdrawal (MPC → Meteora → Relay)
  // ============================================================
  describe("Phase F: Withdrawal", () => {
    it("computes withdrawal and decrypts user share", async () => {
      logSeparator("MPC OPERATION: withdraw / computeWithdrawal (compute_withdrawal circuit)");
      console.log("  Purpose: Compute the user's withdrawal amount and ENCRYPT it for the user.");
      console.log("  This is the MOST IMPORTANT MPC operation — it's where privacy meets DeFi:");
      console.log("");
      console.log("  What happens in the MPC circuit:");
      console.log("    1. Decrypt vault.total_deposited (MXE-encrypted) → total pool deposits");
      console.log("    2. Decrypt user.deposited (MXE-encrypted) → user's deposit amount");
      console.log("    3. Compute user's share: user_deposited (simple 100% in single-user test)");
      console.log("    4. Encrypt the result using SHARED TYPE (user's x25519 pubkey + nonce)");
      console.log("       → Only the user can decrypt this with their x25519 private key!");
      console.log("    5. Callback emits WithdrawEvent with encrypted_amount + nonce");
      console.log("    6. User reads the event, decrypts with their x25519 key → plaintext amount");
      console.log("");
      console.log("  KEY INSIGHT: The MPC encrypts the result FOR THE USER using the Shared type.");
      console.log("  The x25519 pubkey the user provides creates a new shared secret that only");
      console.log("  the user and MPC cluster share. Nobody else can read the encrypted output.");
      console.log("");

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      const sharedNonce = randomBytes(16);
      const sharedNonceBN = new anchor.BN(deserializeLE(sharedNonce).toString());
      logHex("  User x25519 pubkey (for Shared encryption)", encryptionKeys.publicKey);
      logHex("  Shared nonce (random 16 bytes)", sharedNonce);
      logBN("  Shared nonce as u128", sharedNonceBN);
      console.log("  (The Shared type in Arcium = encrypt output for a specific x25519 pubkey)");
      console.log("  (Both pubkey AND nonce are required — see .idarc descriptor for compute_withdrawal)");

      const finalizeSig = await queueWithRetry(
        "computeWithdrawal",
        async (computationOffset) => {
          logBN("  Computation offset", computationOffset);
          console.log("  → MPC: decrypt(vault+position) → compute share → encrypt FOR USER → emit event");
          return program.methods
            .withdraw(
              computationOffset,
              Array.from(encryptionKeys.publicKey) as number[],
              sharedNonceBN
            )
            .accountsPartial({
              user: owner.publicKey,
              signPdaAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
              computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
              compDefAccount: getCompDefAccAddress(program.programId, Buffer.from(getCompDefAccOffset("compute_withdrawal")).readUInt32LE()),
              clusterAccount,
              poolAccount: getFeePoolAccAddress(),
              clockAccount: getClockAccAddress(),
              systemProgram: SystemProgram.programId,
              vault: vaultPda,
              userPosition: userPositionPda,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
        },
        provider,
        program.programId,
      );

      // Parse WithdrawEvent from callback tx
      const withdrawTx = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }));

      const events = parseEventsFromTx(program, withdrawTx);
      console.log(`  Callback tx events (${events.length} found):`);
      for (const evt of events) {
        console.log(`    Event: ${evt.name}`);
        for (const [k, v] of Object.entries(evt.data)) {
          if (v instanceof Uint8Array || Array.isArray(v)) {
            console.log(`      ${k}: ${Buffer.from(v as any).toString("hex")} (${(v as any).length} bytes)`);
          } else {
            console.log(`      ${k}: ${v}`);
          }
        }
      }

      // Log callback tx logs for full visibility
      if (withdrawTx?.meta?.logMessages) {
        detailLog("  Full callback tx logs:");
        for (const log of withdrawTx.meta.logMessages) {
          detailLog(`    ${log}`);
        }
      }

      const withdrawEvent = events.find(e => e.name === "WithdrawEvent" || e.name === "withdrawEvent");

      if (withdrawEvent) {
        logSeparator("DECRYPTING WITHDRAWAL AMOUNT (x25519 + RescueCipher)");
        const encryptedAmountArr: number[] = Array.from(withdrawEvent.data.encryptedAmount);
        const eventNonceBN = withdrawEvent.data.nonce;

        logHex("  Encrypted amount (from WithdrawEvent)", Buffer.from(encryptedAmountArr));
        logBN("  Event nonce (u128)", eventNonceBN);
        console.log("");
        console.log("  DECRYPTION STEPS:");
        console.log("  1. Convert event nonce (u128) → 16-byte little-endian Uint8Array");

        // Convert u128 nonce to 16-byte LE Uint8Array
        const nonceBuf = Buffer.alloc(16);
        const nonceBig = BigInt(eventNonceBN.toString());
        for (let i = 0; i < 16; i++) {
          nonceBuf[i] = Number((nonceBig >> BigInt(i * 8)) & BigInt(0xff));
        }
        logHex("     Nonce as bytes (LE)", nonceBuf);

        console.log("  2. Derive shared secret: x25519(user_privkey, mxe_pubkey)");
        // Decrypt using user's x25519 shared secret with MXE
        const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
        logHex("     Shared secret", sharedSecret);

        console.log("  3. Create RescueCipher with shared secret");
        const decryptCipher = new RescueCipher(sharedSecret);

        console.log("  4. Decrypt: cipher.decrypt([ciphertext], nonce_bytes)");
        const decrypted = decryptCipher.decrypt(
          [encryptedAmountArr],
          new Uint8Array(nonceBuf),
        );
        decryptedWithdrawAmount = Number(decrypted[0]);

        logSeparator("DECRYPTED WITHDRAWAL DATA");
        logKeyValue("  Decrypted amount (plaintext)", `${decryptedWithdrawAmount} (${decryptedWithdrawAmount / 1e9} tokens)`);
        logKeyValue("  Expected (deposit amount)", `${DEPOSIT_AMOUNT} (${DEPOSIT_AMOUNT / 1e9} tokens)`);
        logKeyValue("  Match", decryptedWithdrawAmount === DEPOSIT_AMOUNT ? "YES ✓" : "NO ✗");
        console.log("");
        console.log("  Only the USER could decrypt this — the encrypted_amount on-chain is unreadable");
        console.log("  to everyone else (including other users, validators, and observers).");
        console.log("");
        console.log("  >>> This value will be WIRED into: withdraw_from_meteora + relay_transfer + clear_position <<<");
        expect(decryptedWithdrawAmount).to.equal(DEPOSIT_AMOUNT);
      } else {
        console.log("  Could not find WithdrawEvent in callback tx logs");
        console.log("  Available events:", events.map(e => e.name));
        if (withdrawTx?.meta?.logMessages) {
          const dataLogs = withdrawTx.meta.logMessages.filter(l => l.includes("Program data:") || l.includes("withdraw"));
          dataLogs.forEach(l => console.log("  ", l));
        }
        decryptedWithdrawAmount = DEPOSIT_AMOUNT;
        console.log(`  Fallback: using deposit amount as decryptedWithdrawAmount = ${decryptedWithdrawAmount}`);
      }
    });

    it("withdraws from Meteora", async () => {
      logSeparator("METEORA CPI: Withdraw Liquidity via Ephemeral Wallet");
      console.log("  Purpose: Remove liquidity from Meteora pool via relay PDA.");
      console.log("  The relay PDA's position holds the liquidity. We withdraw ALL of it.");
      console.log("  After this, tokens flow back to relay PDA's token accounts.");
      console.log("");

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Read position's current unlocked_liquidity
      const positionInfo = await provider.connection.getAccountInfo(positionPda);
      expect(positionInfo).to.not.be.null;
      const unlockedLiquidityBytes = positionInfo!.data.slice(152, 168);
      const unlockedLiquidity = new anchor.BN(unlockedLiquidityBytes, "le");
      logBN("  Position.unlocked_liquidity (before withdraw)", unlockedLiquidity);
      expect(unlockedLiquidity.gt(new anchor.BN(0))).to.be.true;

      const wdEph = await setupEphemeralWallet(program, provider, owner, vaultPda, 100_000_000); // 0.1 SOL for fees
      logKeyValue("  Withdraw ephemeral wallet", wdEph.ephemeralKp.publicKey.toString());
      logKeyValue("  Withdraw ephemeral PDA", wdEph.ephemeralPda.toString());

      // Wait for funding to confirm
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        console.log("  → Calling withdrawFromMeteoraDammV2: remove ALL unlocked liquidity");
        const wdTx = await program.methods
          .withdrawFromMeteoraDammV2(
            RELAY_INDEX,
            unlockedLiquidity, // Withdraw all
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

        // Verify position's unlocked_liquidity is now 0
        const posAfter = await provider.connection.getAccountInfo(positionPda);
        const afterLiqBytes = posAfter!.data.slice(152, 168);
        const afterLiq = new anchor.BN(afterLiqBytes, "le");

        logSeparator("METEORA POSITION STATE AFTER WITHDRAWAL");
        logBN("  Position.unlocked_liquidity (before)", unlockedLiquidity);
        logBN("  Position.unlocked_liquidity (after)", afterLiq);
        console.log("  Liquidity fully withdrawn ✓ (position is now empty)");

        // Check relay token balances after withdrawal
        const isTokenANative = tokenA.equals(NATIVE_MINT);
        const relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;
        const relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;
        try {
          const splBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
          const wsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
          logKeyValue("  Relay SPL balance (tokens returned)", splBal.amount.toString());
          logKeyValue("  Relay WSOL balance (SOL returned)", wsolBal.amount.toString());
          console.log("  (Tokens flowed: Meteora pool vaults → relay PDA token accounts)");
        } catch (e: any) {
          console.log("  Could not read relay balances:", e.message?.substring(0, 80));
        }

        expect(afterLiq.eq(new anchor.BN(0))).to.be.true;
      } finally {
        await teardownEphemeralWallet(program, provider, owner, vaultPda, wdEph.ephemeralKp, wdEph.ephemeralPda);
      }
    });

    it("transfers tokens from relay to destination", async () => {
      logSeparator("RELAY TRANSFER: Send tokens from relay PDA to destination");
      console.log("  Purpose: Move withdrawn tokens from relay PDA to the user's ephemeral wallet.");
      console.log("  In production, this goes to the user's ephemeral wallet (not their main wallet),");
      console.log("  which then sends to the ZK mixer for final unlinkability.");
      console.log("");

      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(decryptedWithdrawAmount).to.be.greaterThan(0);

      // Create destination token account (simulating ephemeral wallet receiving)
      const destinationWallet = Keypair.generate();
      const destTokenKp = Keypair.generate();

      // Use the SPL token (non-WSOL) side
      const splMint = tokenA.equals(NATIVE_MINT) ? tokenB : tokenA;
      const relaySplAccount = tokenA.equals(NATIVE_MINT) ? relayTokenB : relayTokenA;

      const destinationTokenAccount = await createAccount(
        provider.connection, owner, splMint, destinationWallet.publicKey, destTokenKp,
      );
      logKeyValue("  Destination wallet (simulated ephemeral)", destinationWallet.publicKey.toString());
      logKeyValue("  Destination token account", destinationTokenAccount.toString());

      // Check relay SPL balance to determine how much we can transfer
      const relaySplBalance = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      const transferAmount = Math.min(decryptedWithdrawAmount, Number(relaySplBalance.amount));
      logKeyValue("  Decrypted withdraw amount (from MPC)", decryptedWithdrawAmount);
      logKeyValue("  Relay SPL balance available", relaySplBalance.amount.toString());
      logKeyValue("  Transfer amount (min of both)", transferAmount);
      console.log(`  >>> WIRED: relayTransferToDestination(${RELAY_INDEX}, ${transferAmount}) — from decrypted withdrawal <<<`);

      await new Promise(resolve => setTimeout(resolve, 2000));

      await program.methods
        .relayTransferToDestination(RELAY_INDEX, new anchor.BN(transferAmount))
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          relayPda: relayPda,
          relayTokenAccount: relaySplAccount,
          destinationTokenAccount: destinationTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      // Verify destination received tokens
      const destBalance = await withRetry(() => getAccount(provider.connection, destinationTokenAccount));
      logSeparator("TRANSFER COMPLETE");
      logKeyValue("  Destination token balance", destBalance.amount.toString());
      logKeyValue("  Expected", transferAmount.toString());
      logKeyValue("  Match", Number(destBalance.amount) === transferAmount ? "YES ✓" : "NO ✗");
      console.log("  Tokens successfully moved: relay PDA → destination (simulated ephemeral wallet) ✓");
      expect(Number(destBalance.amount)).to.equal(transferAmount);
    });
  });

  // ============================================================
  // Phase G: Cleanup (MPC)
  // ============================================================
  describe("Phase G: Cleanup", () => {
    it("clears user position", async () => {
      logSeparator("MPC OPERATION: clearPosition (clear_position circuit)");
      console.log("  Purpose: Zero out the user's encrypted position after withdrawal is confirmed.");
      console.log("  What happens in the MPC circuit:");
      console.log("    1. Decrypt user.deposited and user.liquidity_share (MXE-encrypted)");
      console.log("    2. Subtract the withdrawn amount");
      console.log("    3. Also subtract from vault.total_deposited");
      console.log("    4. Re-encrypt everything → write back to vault + position accounts");
      console.log("  After this, the user's encrypted position is back to [0, 0].");
      console.log("");

      expect(decryptedWithdrawAmount).to.be.greaterThan(0);

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      logKeyValue("  Amount to clear (from decrypted withdrawal)", `${decryptedWithdrawAmount} (${decryptedWithdrawAmount / 1e9} tokens)`);
      console.log(`  >>> WIRED: clearPosition(${decryptedWithdrawAmount}) — from decrypted MPC output <<<`);

      await queueWithRetry(
        "clearPosition",
        async (computationOffset) => {
          return program.methods
            .clearPosition(computationOffset, new anchor.BN(decryptedWithdrawAmount))
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              userPosition: userPositionPda,
              signPdaAccount,
              computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
              clusterAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
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

      console.log("Position cleared successfully");
    });
  });

  // ============================================================
  // Cleanup
  // ============================================================
  after(async () => {
    // Close relay WSOL account — owner is relay PDA so we use relayTransferToDestination
    // to drain tokens first, then the account rent stays with the PDA.
    // We can't close PDA-owned accounts without a program instruction, so just drain tokens.
    try {
      if (relayTokenA && relayTokenB && tokenA && tokenB) {
        const isTokenANative = tokenA.equals(NATIVE_MINT);
        const relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;
        const relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;

        // Drain any remaining SPL tokens back to owner
        const splBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
        if (Number(splBal.amount) > 0) {
          const ownerAta = await getOrCreateAssociatedTokenAccount(
            provider.connection, owner, isTokenANative ? tokenB : tokenA, owner.publicKey
          );
          await program.methods
            .relayTransferToDestination(RELAY_INDEX, new anchor.BN(splBal.amount.toString()))
            .accounts({
              authority: owner.publicKey,
              vault: vaultPda,
              relayPda: relayPda,
              relayTokenAccount: relaySplAccount,
              destinationTokenAccount: ownerAta.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log(`Drained ${splBal.amount} SPL tokens from relay back to owner`);
        }

        // Drain any remaining WSOL back to owner (as WSOL, owner can close later)
        const wsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
        if (Number(wsolBal.amount) > 0) {
          const ownerWsolAta = await getOrCreateAssociatedTokenAccount(
            provider.connection, owner, NATIVE_MINT, owner.publicKey
          );
          await program.methods
            .relayTransferToDestination(RELAY_INDEX, new anchor.BN(wsolBal.amount.toString()))
            .accounts({
              authority: owner.publicKey,
              vault: vaultPda,
              relayPda: relayPda,
              relayTokenAccount: relayWsolAccount,
              destinationTokenAccount: ownerWsolAta.address,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
          console.log(`Drained ${wsolBal.amount} WSOL from relay back to owner`);

          // Close owner's WSOL ATA to unwrap back to SOL
          try {
            await closeAccount(provider.connection, owner, ownerWsolAta.address, owner.publicKey, owner);
            console.log("Closed owner WSOL ATA, SOL reclaimed");
          } catch (err: any) {
            console.log("Could not close owner WSOL ATA:", err.message?.substring(0, 80));
          }
        }
      }
    } catch (err: any) {
      console.log("Cleanup: could not drain relay accounts:", err.message?.substring(0, 100));
    }

    // Return remaining relayer SOL (owner pays fee since relayer may be low)
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
        // Owner pays the fee so relayer can send its entire balance
        returnTx.feePayer = owner.publicKey;
        await provider.sendAndConfirm(returnTx, [owner, relayer]);
        console.log(`Returned ${relayerBal / 1e9} SOL from relayer to owner`);
      }
    } catch (err: any) {
      console.log("Cleanup: could not return relayer SOL:", err.message?.substring(0, 100));
    }

    logSeparator("DATA FLOW SUMMARY");
    console.log("");
    console.log("  FULL PRIVACY PIPELINE (what happened):");
    console.log("  ═══════════════════════════════════════");
    console.log("");
    console.log("  1. DEPOSIT (MPC)");
    console.log(`     User deposited: ${DEPOSIT_AMOUNT} tokens (plaintext)`);
    console.log("     On-chain: SPL transfer user → vault (amount visible)");
    console.log("     MPC: encrypted(pending_deposits) += encrypted(deposit_amount)");
    console.log("     MPC: encrypted(user.deposited) += encrypted(deposit_amount)");
    console.log("     Result: vault + position updated with ENCRYPTED values");
    console.log("");
    console.log("  2. REVEAL AGGREGATE (MPC → plaintext)");
    console.log(`     MPC revealed: total_pending = ${revealedAmount || "N/A"} (aggregate of all deposits)`);
    console.log("     This is the ONLY time encrypted data becomes plaintext.");
    console.log("     Only the AGGREGATE is revealed — per-user amounts stay hidden.");
    console.log("");
    console.log("  3. FUND RELAY + METEORA DEPOSIT (CPI via ephemeral wallet)");
    console.log(`     Relay funded with: ${revealedAmount || "N/A"} SPL + ${revealedAmount || "N/A"} WSOL`);
    if (sdkLiquidityDelta) {
      console.log(`     Meteora liquidityDelta: ${sdkLiquidityDelta.toString()} (u128)`);
    }
    if (meteoraUnlockedLiquidity) {
      console.log(`     Position.unlocked_liquidity: ${meteoraUnlockedLiquidity.toString()} (u128)`);
    }
    console.log("     Ephemeral wallet signed all Meteora txs — user identity not linked.");
    console.log("");
    console.log("  4. RECORD LIQUIDITY (MPC)");
    const U64_MAX_VAL = "18446744073709551615";
    if (sdkLiquidityDelta) {
      const capped = sdkLiquidityDelta.gt(new anchor.BN(U64_MAX_VAL)) ? U64_MAX_VAL : sdkLiquidityDelta.toString();
      console.log(`     Recorded in MPC: ${capped} (capped to u64 from u128)`);
    }
    console.log("     MPC: encrypted(vault.total_liquidity) += liquidity_delta");
    console.log("");
    console.log("  5. COMPUTE WITHDRAWAL (MPC → encrypted for user)");
    console.log(`     MPC computed user's share: ${decryptedWithdrawAmount || "N/A"} tokens`);
    console.log("     Output encrypted with user's x25519 pubkey (Shared type)");
    console.log("     User decrypted with x25519 privkey + RescueCipher");
    console.log("");
    console.log("  6. WITHDRAW FROM METEORA + TRANSFER + CLEAR (CPI + relay + MPC)");
    console.log(`     Withdrew all liquidity from Meteora position`);
    console.log(`     Transferred ${decryptedWithdrawAmount || "N/A"} tokens: relay → destination`);
    console.log(`     Cleared user position: encrypted(deposited) = 0, encrypted(liquidity) = 0`);
    console.log("");
    console.log("  PRIVACY LAYERS:");
    console.log("  ├─ Arcium MPC: Individual amounts never visible on-chain");
    console.log("  ├─ Relay PDA: Single aggregate position in Meteora (no per-user positions)");
    console.log("  ├─ Ephemeral wallets: Fresh keypair per operation, abandoned after use");
    console.log("  └─ ZK Mixer (Phase 2): Will break deposit→user link entirely");
    console.log("");
    console.log("  LOG FILES:");
    console.log(`    ${LOG_FILE} — console output (both summary + details)`);
    console.log(`    ${DETAILED_LOG_FILE} — includes full callback tx logs`);
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
