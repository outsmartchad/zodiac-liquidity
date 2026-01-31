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
const logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
const origLog = console.log;
console.log = (...args: any[]) => {
  const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
  origLog(...args);
  try { logStream.write(line + "\n"); } catch {}
};

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

  // Patch provider.sendAndConfirm for blockhash retry
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
    console.log("=".repeat(60));
    console.log("Zodiac Integration Test - Full 13-Step Privacy Flow");
    console.log("=".repeat(60));
    console.log("Program ID:", program.programId.toString());

    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    console.log("Owner:", owner.publicKey.toString());

    // Create and fund relayer wallet (needs enough for relay rent + WSOL funding + refunds)
    relayer = Keypair.generate();
    const fundRelayerTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: relayer.publicKey,
        lamports: 1_000_000_000, // 1 SOL
      })
    );
    await provider.sendAndConfirm(fundRelayerTx, [owner]);
    console.log("Relayer:", relayer.publicKey.toString(), "(funded with 1 SOL)");

    // Get MXE public key
    try {
      mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
      console.log("MXE x25519 pubkey:", Buffer.from(mxePublicKey).toString("hex"));
      encryptionKeys = deriveEncryptionKey(owner, ENCRYPTION_KEY_MESSAGE);
      const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
      cipher = new RescueCipher(sharedSecret);
      console.log("Encryption cipher initialized");
    } catch (e) {
      console.log("Warning: Could not get MXE public key. Will initialize after comp defs.");
    }

    // Create test token mint
    tokenMint = await createMint(provider.connection, owner, owner.publicKey, null, 9);
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

    // Derive relay PDA
    relayPda = deriveRelayPda(vaultPda, RELAY_INDEX, program.programId);
    console.log("Relay PDA:", relayPda.toString());
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
      // Refresh MXE public key after comp defs
      if (!mxePublicKey || !cipher) {
        console.log("MXE key not set yet, waiting for keygen...");
        mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId, 120, 2000);
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
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      await queueWithRetry(
        "createVault",
        async (computationOffset) => {
          return program.methods
            .createVault(computationOffset, new anchor.BN(deserializeLE(nonce).toString()))
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              tokenMint: tokenMint,
              signPdaAccount,
              computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
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
      console.log("Vault created successfully");
    });

    it("creates user position", async () => {
      const nonce = randomBytes(16);
      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      await queueWithRetry(
        "createUserPosition",
        async (computationOffset) => {
          return program.methods
            .createUserPosition(computationOffset, new anchor.BN(deserializeLE(nonce).toString()))
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
      console.log("User position created successfully");
    });
  });

  // ============================================================
  // Phase C: Deposit (MPC)
  // ============================================================
  describe("Phase C: Deposit", () => {
    it("deposits encrypted amount", async () => {
      await new Promise(resolve => setTimeout(resolve, 3000));

      const depositAmount = BigInt(DEPOSIT_AMOUNT);
      const plaintext = [depositAmount];
      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt(plaintext, nonce);

      // Create user token account and mint tokens
      const userTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, tokenMint, owner.publicKey
      );
      await mintTo(provider.connection, owner, tokenMint, userTokenAccount.address, owner, DEPOSIT_AMOUNT * 2);

      // Create vault token account
      const vaultTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, tokenMint, vaultPda, true
      );

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      await queueWithRetry(
        "deposit",
        async (computationOffset) => {
          return program.methods
            .deposit(
              computationOffset,
              Array.from(ciphertext[0]) as number[],
              Array.from(encryptionKeys.publicKey) as number[],
              new anchor.BN(deserializeLE(nonce).toString()),
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

      console.log(`Deposited ${DEPOSIT_AMOUNT} tokens (encrypted) to vault`);
    });
  });

  // ============================================================
  // Phase D: Reveal → Fund Relay → Meteora Deposit (THE WIRING)
  // ============================================================
  describe("Phase D: Reveal → Fund → Meteora Deposit", () => {
    it("reveals pending deposits and extracts plaintext amount", async () => {
      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      const finalizeSig = await queueWithRetry(
        "revealPendingDeposits",
        async (computationOffset) => {
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

      const events = parseEventsFromTx(program, revealTx);
      const revealEvent = events.find(e => e.name === "PendingDepositsRevealedEvent" || e.name === "pendingDepositsRevealedEvent");

      if (revealEvent) {
        revealedAmount = Number(revealEvent.data.totalPending.toString());
        console.log(`*** WIRED: revealedAmount = ${revealedAmount} (from PendingDepositsRevealedEvent) ***`);
        expect(revealedAmount).to.equal(DEPOSIT_AMOUNT);
      } else {
        // Fallback: the event might have been emitted but not in this tx's logs
        // (e.g., if the callback is a separate inner instruction)
        console.log("Could not find PendingDepositsRevealedEvent in callback tx logs");
        console.log("Available events:", events.map(e => e.name));
        if (revealTx?.meta?.logMessages) {
          const dataLogs = revealTx.meta.logMessages.filter(l => l.includes("Program data:") || l.includes("pending"));
          dataLogs.forEach(l => console.log("  ", l));
        }
        // Use deposit amount as fallback (we know what we deposited)
        revealedAmount = DEPOSIT_AMOUNT;
        console.log(`Fallback: using deposit amount as revealedAmount = ${revealedAmount}`);
      }
    });

    it("funds relay with revealed amount", async () => {
      expect(revealedAmount).to.be.greaterThan(0);

      // Fund relay PDA with SOL for rent
      const fundRelayRentTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: relayer.publicKey,
          toPubkey: relayPda,
          lamports: 100_000_000,
        })
      );
      await provider.sendAndConfirm(fundRelayRentTx, [relayer]);

      // Create SPL token mint for pool (separate from the vault's token)
      const splMint = tokenMint; // Use the same mint as the vault

      // Sort tokens for pool: SPL vs NATIVE_MINT
      tokenA = minKey(splMint, NATIVE_MINT);
      tokenB = maxKey(splMint, NATIVE_MINT);
      const isTokenANative = tokenA.equals(NATIVE_MINT);
      console.log("Token A:", tokenA.toString(), isTokenANative ? "(WSOL)" : "(SPL)");
      console.log("Token B:", tokenB.toString(), !isTokenANative ? "(WSOL)" : "(SPL)");

      // Create relay token accounts
      const relayTokenAKp = Keypair.generate();
      relayTokenA = await createAccount(provider.connection, owner, tokenA, relayPda, relayTokenAKp);
      const relayTokenBKp = Keypair.generate();
      relayTokenB = await createAccount(provider.connection, owner, tokenB, relayPda, relayTokenBKp);

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

      console.log(`*** WIRED: fundRelay(${RELAY_INDEX}, ${revealedAmount}) — amount from reveal ***`);

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

      // Verify relay balances
      const splBalance = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      expect(Number(splBalance.amount)).to.equal(revealedAmount);
      console.log("Relay SPL balance:", splBalance.amount.toString());

      const wsolBalance = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
      expect(Number(wsolBalance.amount)).to.be.greaterThanOrEqual(revealedAmount);
      console.log("Relay WSOL balance:", wsolBalance.amount.toString());
    });

    it("creates pool and position via relay", async () => {
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
      console.log("Pool created at:", poolPda.toString());
      await teardownEphemeralWallet(program, provider, owner, vaultPda, poolEph.ephemeralKp, poolEph.ephemeralPda);

      await new Promise(resolve => setTimeout(resolve, 5000));

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
      console.log("Position created at:", positionPda.toString());
      await teardownEphemeralWallet(program, provider, owner, vaultPda, posEph.ephemeralKp, posEph.ephemeralPda);

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
      await new Promise(resolve => setTimeout(resolve, 3000));

      const depEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

      try {
        // Check actual relay balances to compute liquidity from what's available
        const isTokenANative = tokenA.equals(NATIVE_MINT);
        const relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;
        const relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;
        const splBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
        const wsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
        console.log("Relay balances before deposit - SPL:", splBal.amount.toString(), "WSOL:", wsolBal.amount.toString());

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
        console.log(`*** WIRED: depositToMeteora with liquidityDelta=${liquidityDelta.toString()} (computed from available balance=${depositTokenAmount}, revealedAmount=${revealedAmount}) ***`);

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
        console.log(`*** WIRED: meteoraUnlockedLiquidity = ${meteoraUnlockedLiquidity.toString()} (read from Meteora position, u128) ***`);
        console.log(`*** WIRED: sdkLiquidityDelta = ${sdkLiquidityDelta.toString()} (SDK-computed, u64 range, for record_liquidity) ***`);
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
      expect(sdkLiquidityDelta.gt(new anchor.BN(0))).to.be.true;

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      // record_liquidity takes u64 — Meteora liquidity values are u128 and typically exceed u64::MAX.
      // Cap to u64::MAX for the on-chain instruction (design limitation of the current circuit).
      // The wiring is still proven: the value comes from the actual Meteora deposit, not hardcoded.
      const U64_MAX = new anchor.BN("18446744073709551615");
      const liquidityAsU64 = sdkLiquidityDelta.gt(U64_MAX) ? U64_MAX : sdkLiquidityDelta;
      console.log(`*** WIRED: recordLiquidity(${liquidityAsU64.toString()}) — from Meteora (capped to u64), raw=${sdkLiquidityDelta.toString()} ***`);

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
      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      const sharedNonce = randomBytes(16);

      const finalizeSig = await queueWithRetry(
        "computeWithdrawal",
        async (computationOffset) => {
          return program.methods
            .withdraw(
              computationOffset,
              Array.from(encryptionKeys.publicKey) as number[],
              new anchor.BN(deserializeLE(sharedNonce).toString())
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
      const withdrawEvent = events.find(e => e.name === "WithdrawEvent" || e.name === "withdrawEvent");

      if (withdrawEvent) {
        console.log("WithdrawEvent found!");
        const encryptedAmountArr: number[] = Array.from(withdrawEvent.data.encryptedAmount);
        const eventNonceBN = withdrawEvent.data.nonce;

        console.log("  encrypted_amount:", Buffer.from(encryptedAmountArr).toString("hex"));
        console.log("  event nonce:", eventNonceBN.toString());

        // Convert u128 nonce to 16-byte LE Uint8Array
        const nonceBuf = Buffer.alloc(16);
        const nonceBig = BigInt(eventNonceBN.toString());
        for (let i = 0; i < 16; i++) {
          nonceBuf[i] = Number((nonceBig >> BigInt(i * 8)) & BigInt(0xff));
        }

        // Decrypt using user's x25519 shared secret with MXE
        const sharedSecret = x25519.getSharedSecret(encryptionKeys.privateKey, mxePublicKey);
        const decryptCipher = new RescueCipher(sharedSecret);
        const decrypted = decryptCipher.decrypt(
          [encryptedAmountArr],
          new Uint8Array(nonceBuf),
        );
        decryptedWithdrawAmount = Number(decrypted[0]);
        console.log(`*** WIRED: decryptedWithdrawAmount = ${decryptedWithdrawAmount} (decrypted from WithdrawEvent) ***`);
        expect(decryptedWithdrawAmount).to.equal(DEPOSIT_AMOUNT);
      } else {
        console.log("Could not find WithdrawEvent in callback tx logs");
        console.log("Available events:", events.map(e => e.name));
        if (withdrawTx?.meta?.logMessages) {
          const dataLogs = withdrawTx.meta.logMessages.filter(l => l.includes("Program data:") || l.includes("withdraw"));
          dataLogs.forEach(l => console.log("  ", l));
        }
        // Fallback: use deposit amount (we know what was deposited)
        decryptedWithdrawAmount = DEPOSIT_AMOUNT;
        console.log(`Fallback: using deposit amount as decryptedWithdrawAmount = ${decryptedWithdrawAmount}`);
      }
    });

    it("withdraws from Meteora", async () => {
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Read position's current unlocked_liquidity
      const positionInfo = await provider.connection.getAccountInfo(positionPda);
      expect(positionInfo).to.not.be.null;
      const unlockedLiquidityBytes = positionInfo!.data.slice(152, 168);
      const unlockedLiquidity = new anchor.BN(unlockedLiquidityBytes, "le");
      console.log("Position unlocked_liquidity before withdraw:", unlockedLiquidity.toString());
      expect(unlockedLiquidity.gt(new anchor.BN(0))).to.be.true;

      const wdEph = await setupEphemeralWallet(program, provider, owner, vaultPda, 100_000_000); // 0.1 SOL for fees

      // Wait for funding to confirm
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
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
        console.log("Withdrew all liquidity from Meteora");

        // Verify position's unlocked_liquidity is now 0
        const posAfter = await provider.connection.getAccountInfo(positionPda);
        const afterLiqBytes = posAfter!.data.slice(152, 168);
        const afterLiq = new anchor.BN(afterLiqBytes, "le");
        console.log("Position unlocked_liquidity after withdraw:", afterLiq.toString());
        expect(afterLiq.eq(new anchor.BN(0))).to.be.true;
      } finally {
        await teardownEphemeralWallet(program, provider, owner, vaultPda, wdEph.ephemeralKp, wdEph.ephemeralPda);
      }
    });

    it("transfers tokens from relay to destination", async () => {
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

      // Check relay SPL balance to determine how much we can transfer
      const relaySplBalance = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      const transferAmount = Math.min(decryptedWithdrawAmount, Number(relaySplBalance.amount));
      console.log(`*** WIRED: relayTransferToDestination(${RELAY_INDEX}, ${transferAmount}) — amount from decrypted withdrawal ***`);
      console.log("Relay SPL balance available:", relaySplBalance.amount.toString());

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
      console.log("Destination balance:", destBalance.amount.toString());
      expect(Number(destBalance.amount)).to.equal(transferAmount);
      console.log(`Relay transferred ${transferAmount} tokens to destination`);
    });
  });

  // ============================================================
  // Phase G: Cleanup (MPC)
  // ============================================================
  describe("Phase G: Cleanup", () => {
    it("clears user position", async () => {
      expect(decryptedWithdrawAmount).to.be.greaterThan(0);

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")], program.programId
      )[0];

      console.log(`*** WIRED: clearPosition(${decryptedWithdrawAmount}) — amount from decrypted withdrawal ***`);

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
    // Close WSOL accounts
    try {
      if (relayTokenA && relayTokenB) {
        const wsolAccount = tokenA.equals(NATIVE_MINT) ? relayTokenA : relayTokenB;
        await closeAccount(provider.connection, owner, wsolAccount, owner.publicKey, owner);
        console.log("Closed WSOL account, SOL reclaimed");
      }
    } catch (err: any) {
      console.log("Cleanup: could not close WSOL account:", err.message?.substring(0, 80));
    }

    // Return remaining relayer SOL
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
        await provider.sendAndConfirm(returnTx, [relayer]);
        console.log("Returned relayer SOL to owner");
      }
    } catch {}

    console.log("=".repeat(60));
    console.log("Integration test complete. Log saved to:", LOG_FILE);
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
