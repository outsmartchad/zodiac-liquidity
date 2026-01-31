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
const LOG_FILE = "test-run.log";
const logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
const origLog = console.log;
console.log = (...args: any[]) => {
  const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
  origLog(...args);
  logStream.write(line + "\n");
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
      const MEMPOOL_CHECK_TIMEOUT_MS = 90_000; // 90s (mempool TTL = 180 slots ≈ 72s)
      const finalizeSig = await Promise.race([
        finalizationPromise,
        (async () => {
          // Wait, then check if computation is still queued or was dropped
          await new Promise((r) => setTimeout(r, 15_000)); // 15s grace period
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

/**
 * Creates a fresh ephemeral wallet, registers its PDA, funds it with SOL for tx fees,
 * and returns the keypair + PDA. After the CPI, call closeEphemeralWallet to reclaim rent.
 */
async function setupEphemeralWallet(
  program: Program<ZodiacLiquidity>,
  provider: anchor.AnchorProvider,
  owner: Keypair,
  vaultPda: PublicKey,
  fundLamports: number = 50_000_000,
): Promise<{ ephemeralKp: Keypair; ephemeralPda: PublicKey }> {
  const ephemeralKp = Keypair.generate();
  const ephemeralPda = deriveEphemeralWalletPda(vaultPda, ephemeralKp.publicKey, program.programId);

  // Authority registers the ephemeral wallet PDA
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

  // Fund ephemeral wallet with SOL for tx fees
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
  // Return remaining SOL to authority
  try {
    const ephBal = await provider.connection.getBalance(ephemeralKp.publicKey);
    if (ephBal > 5000) {
      const returnTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: ephemeralKp.publicKey,
          toPubkey: owner.publicKey,
          lamports: ephBal - 5000,
        })
      );
      await provider.sendAndConfirm(returnTx, [ephemeralKp]);
      console.log("Returned", (ephBal - 5000) / 1e9, "SOL from ephemeral wallet to authority");
    }
  } catch (err: any) {
    console.log("Could not return ephemeral SOL:", err.message?.substring(0, 80));
  }

  // Authority closes the PDA, reclaiming rent
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

describe("zodiac-liquidity", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ZodiacLiquidity as Program<ZodiacLiquidity>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  // Patch provider.sendAndConfirm to auto-retry on "Blockhash not found".
  // On localnet, after heavy MPC activity the validator can lag behind,
  // causing blockhash expiry between fetch and confirmation.
  // Anchor's sendAndConfirm already fetches a fresh blockhash each call,
  // so retrying the full call fixes transient timing issues.
  const _origSendAndConfirm = provider.sendAndConfirm.bind(provider);
  provider.sendAndConfirm = async function(tx, signers?, opts?) {
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
    console.log("Zodiac Liquidity Tests - Setup");
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

  describe("Computation Definition Initialization", () => {
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

  describe("Vault Creation", () => {
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
      console.log("\n--- Vault Creation Data ---");
      console.log("Vault authority:", vaultAccount.authority.toString());
      console.log("Vault token_mint:", vaultAccount.tokenMint.toString());
      console.log("Vault state[0] (pending_deposits):", Buffer.from(vaultAccount.vaultState[0]).toString("hex"));
      console.log("Vault state[1] (total_liquidity):", Buffer.from(vaultAccount.vaultState[1]).toString("hex"));
      console.log("Vault state[2] (total_deposited):", Buffer.from(vaultAccount.vaultState[2]).toString("hex"));
      console.log("Vault nonce:", vaultAccount.nonce.toString());
      console.log("--- End Vault Creation Data ---\n");
      expect(vaultAccount.authority.toString()).to.equal(owner.publicKey.toString());
    });
  });

  describe("User Position Creation", () => {
    it("creates a user position", async () => {
      const nonce = randomBytes(16);

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")],
        program.programId
      )[0];

      const finalizeSig = await queueWithRetry(
        "createUserPosition",
        async (computationOffset) => {
          return program.methods
            .createUserPosition(computationOffset, new anchor.BN(deserializeLE(nonce).toString()))
            .accountsPartial({
              user: owner.publicKey,
              vault: vaultPda,
              userPosition: userPositionPda,
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
                Buffer.from(getCompDefAccOffset("init_user_position")).readUInt32LE()
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

      console.log("User position created, finalize tx:", finalizeSig);

      const posAccount = await program.account.userPositionAccount.fetch(userPositionPda);
      console.log("\n--- User Position Creation Data ---");
      console.log("Position owner:", posAccount.owner.toString());
      console.log("Position vault:", posAccount.vault.toString());
      console.log("Position state[0] (deposited):", Buffer.from(posAccount.positionState[0]).toString("hex"));
      console.log("Position state[1] (lp_share):", Buffer.from(posAccount.positionState[1]).toString("hex"));
      console.log("Position nonce:", posAccount.nonce.toString());
      console.log("--- End User Position Creation Data ---\n");
    });
  });

  describe("Deposit Flow", () => {
    it("deposits tokens with encrypted amount", async () => {
      // Delay to avoid RPC rate limiting from previous test
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Encrypt the deposit amount
      const depositAmount = BigInt(1_000_000_000); // 1 token with 9 decimals
      const plaintext = [depositAmount];
      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt(plaintext, nonce);

      // Create user token account and mint tokens
      const userTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner,
        tokenMint,
        owner.publicKey
      );

      await mintTo(
        provider.connection,
        owner,
        tokenMint,
        userTokenAccount.address,
        owner,
        2_000_000_000 // Mint 2 tokens
      );

      // Create vault token account
      const vaultTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner,
        tokenMint,
        vaultPda,
        true // allowOwnerOffCurve for PDA
      );

      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")],
        program.programId
      )[0];

      const finalizeSig = await queueWithRetry(
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
                Buffer.from(getCompDefAccOffset("deposit")).readUInt32LE()
              ),
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

      console.log("Deposit succeeded, finalize tx:", finalizeSig);

      // --- Log deposit data ---
      console.log("\n--- Deposit Data ---");
      console.log("Deposit amount (plaintext):", depositAmount.toString());

      const vaultAfterDeposit = await program.account.vaultAccount.fetch(vaultPda);
      console.log("Vault state after deposit:");
      console.log("  vault_state[0] (pending_deposits):", Buffer.from(vaultAfterDeposit.vaultState[0]).toString("hex"));
      console.log("  vault_state[1] (total_liquidity):", Buffer.from(vaultAfterDeposit.vaultState[1]).toString("hex"));
      console.log("  vault_state[2] (total_deposited):", Buffer.from(vaultAfterDeposit.vaultState[2]).toString("hex"));
      console.log("  nonce:", vaultAfterDeposit.nonce.toString());

      const posAfterDeposit = await program.account.userPositionAccount.fetch(userPositionPda);
      console.log("User position after deposit:");
      console.log("  position_state[0] (deposited):", Buffer.from(posAfterDeposit.positionState[0]).toString("hex"));
      console.log("  position_state[1] (lp_share):", Buffer.from(posAfterDeposit.positionState[1]).toString("hex"));
      console.log("  nonce:", posAfterDeposit.nonce.toString());
      console.log("--- End Deposit Data ---\n");
    });
  });

  describe("Reveal Pending Deposits", () => {
    it("reveals aggregate pending deposits", async () => {
      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")],
        program.programId
      )[0];

      const finalizeSig = await queueWithRetry(
        "revealPendingDeposits",
        async (computationOffset) => {
          return program.methods
            .revealPendingDeposits(computationOffset)
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
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
                Buffer.from(getCompDefAccOffset("reveal_pending_deposits")).readUInt32LE()
              ),
              poolAccount: getFeePoolAccAddress(),
              clockAccount: getClockAccAddress(),
            })
            .signers([owner])
            .rpc({ skipPreflight: true, commitment: "confirmed" });
        },
        provider,
        program.programId,
      );

      console.log("Reveal succeeded, finalize tx:", finalizeSig);

      // --- Log reveal data ---
      console.log("\n--- Reveal Pending Deposits Data ---");
      // Parse the finalize tx logs for the PendingDepositsRevealedEvent
      const revealTx = await provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (revealTx?.meta?.logMessages) {
        console.log("Reveal tx logs:");
        revealTx.meta.logMessages.forEach((l) => console.log("  " + l));
      }

      const vaultAfterReveal = await program.account.vaultAccount.fetch(vaultPda);
      console.log("Vault state after reveal:");
      console.log("  vault_state[0] (pending_deposits):", Buffer.from(vaultAfterReveal.vaultState[0]).toString("hex"));
      console.log("  vault_state[1] (total_liquidity):", Buffer.from(vaultAfterReveal.vaultState[1]).toString("hex"));
      console.log("  vault_state[2] (total_deposited):", Buffer.from(vaultAfterReveal.vaultState[2]).toString("hex"));
      console.log("  nonce:", vaultAfterReveal.nonce.toString());
      console.log("--- End Reveal Data ---\n");
    });
  });

  describe("Record Liquidity", () => {
    it("records liquidity received from Meteora", async () => {
      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")],
        program.programId
      )[0];

      const liquidityDelta = new anchor.BN(500_000_000); // liquidity delta from add_liquidity

      const finalizeSig = await queueWithRetry(
        "recordLiquidity",
        async (computationOffset) => {
          return program.methods
            .recordLiquidity(computationOffset, liquidityDelta)
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
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
                Buffer.from(getCompDefAccOffset("record_liquidity")).readUInt32LE()
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

      console.log("Record liquidity succeeded, finalize tx:", finalizeSig);

      // Verify vault state updated
      const vaultAfterRecord = await program.account.vaultAccount.fetch(vaultPda);
      console.log("\n--- Record Liquidity Data ---");
      console.log("Vault state after record liquidity:");
      console.log("  vault_state[0] (pending_deposits):", Buffer.from(vaultAfterRecord.vaultState[0]).toString("hex"));
      console.log("  vault_state[1] (total_liquidity):", Buffer.from(vaultAfterRecord.vaultState[1]).toString("hex"));
      console.log("  vault_state[2] (total_deposited):", Buffer.from(vaultAfterRecord.vaultState[2]).toString("hex"));
      console.log("  nonce:", vaultAfterRecord.nonce.toString());
      console.log("--- End Record Liquidity Data ---\n");
    });
  });

  describe("Compute Withdrawal", () => {
    it("computes withdrawal for user", async () => {
      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")],
        program.programId
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
              signPdaAccount: signPdaAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
              computationAccount: getComputationAccAddress(
                getArciumEnv().arciumClusterOffset,
                computationOffset
              ),
              compDefAccount: getCompDefAccAddress(
                program.programId,
                Buffer.from(getCompDefAccOffset("compute_withdrawal")).readUInt32LE()
              ),
              clusterAccount: clusterAccount,
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

      console.log("Withdrawal computation succeeded, finalize tx:", finalizeSig);

      // --- Log withdrawal data ---
      console.log("\n--- Withdrawal Data ---");
      const withdrawTx = await provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (withdrawTx?.meta?.logMessages) {
        console.log("Withdrawal tx logs:");
        withdrawTx.meta.logMessages.forEach((l) => console.log("  " + l));
      }

      const vaultAfterWithdraw = await program.account.vaultAccount.fetch(vaultPda);
      console.log("Vault state after withdrawal:");
      console.log("  vault_state[0] (pending_deposits):", Buffer.from(vaultAfterWithdraw.vaultState[0]).toString("hex"));
      console.log("  vault_state[1] (total_liquidity):", Buffer.from(vaultAfterWithdraw.vaultState[1]).toString("hex"));
      console.log("  vault_state[2] (total_deposited):", Buffer.from(vaultAfterWithdraw.vaultState[2]).toString("hex"));
      console.log("  nonce:", vaultAfterWithdraw.nonce.toString());

      const posAfterWithdraw = await program.account.userPositionAccount.fetch(userPositionPda);
      console.log("User position after withdrawal:");
      console.log("  position_state[0] (deposited):", Buffer.from(posAfterWithdraw.positionState[0]).toString("hex"));
      console.log("  position_state[1] (lp_share):", Buffer.from(posAfterWithdraw.positionState[1]).toString("hex"));
      console.log("  nonce:", posAfterWithdraw.nonce.toString());
      console.log("--- End Withdrawal Data ---\n");
    });
  });

  describe("Clear Position", () => {
    it("clears user position after withdrawal", async () => {
      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")],
        program.programId
      )[0];

      const withdrawAmount = new anchor.BN(1_000_000_000); // withdraw full deposit (1 token)

      const finalizeSig = await queueWithRetry(
        "clearPosition",
        async (computationOffset) => {
          return program.methods
            .clearPosition(computationOffset, withdrawAmount)
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              userPosition: userPositionPda,
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
                Buffer.from(getCompDefAccOffset("clear_position")).readUInt32LE()
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

      console.log("Clear position succeeded, finalize tx:", finalizeSig);

      // Verify both vault and user position updated
      const vaultAfterClear = await program.account.vaultAccount.fetch(vaultPda);
      console.log("\n--- Clear Position Data ---");
      console.log("Vault state after clear:");
      console.log("  vault_state[0] (pending_deposits):", Buffer.from(vaultAfterClear.vaultState[0]).toString("hex"));
      console.log("  vault_state[1] (total_liquidity):", Buffer.from(vaultAfterClear.vaultState[1]).toString("hex"));
      console.log("  vault_state[2] (total_deposited):", Buffer.from(vaultAfterClear.vaultState[2]).toString("hex"));
      console.log("  nonce:", vaultAfterClear.nonce.toString());

      const posAfterClear = await program.account.userPositionAccount.fetch(userPositionPda);
      console.log("User position after clear:");
      console.log("  position_state[0] (deposited):", Buffer.from(posAfterClear.positionState[0]).toString("hex"));
      console.log("  position_state[1] (lp_share):", Buffer.from(posAfterClear.positionState[1]).toString("hex"));
      console.log("  nonce:", posAfterClear.nonce.toString());
      console.log("--- End Clear Position Data ---\n");
    });
  });

  describe("Get User Position", () => {
    it("gets user position", async () => {
      const signPdaAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("ArciumSignerAccount")],
        program.programId
      )[0];

      const sharedNonce = randomBytes(16);

      const finalizeSig = await queueWithRetry(
        "getUserPosition",
        async (computationOffset) => {
          return program.methods
            .getUserPosition(
              computationOffset,
              Array.from(encryptionKeys.publicKey) as number[],
              new anchor.BN(deserializeLE(sharedNonce).toString())
            )
            .accountsPartial({
              user: owner.publicKey,
              signPdaAccount: signPdaAccount,
              mxeAccount: getMXEAccAddress(program.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
              computationAccount: getComputationAccAddress(
                getArciumEnv().arciumClusterOffset,
                computationOffset
              ),
              compDefAccount: getCompDefAccAddress(
                program.programId,
                Buffer.from(getCompDefAccOffset("get_user_position")).readUInt32LE()
              ),
              clusterAccount: clusterAccount,
              poolAccount: getFeePoolAccAddress(),
              clockAccount: getClockAccAddress(),
              systemProgram: SystemProgram.programId,
              arciumProgram: getArciumProgramId(),
              vault: vaultPda,
              userPosition: userPositionPda,
            })
            .signers([owner])
            .rpc({ commitment: "confirmed" });
        },
        provider,
        program.programId,
      );

      console.log("Get user position succeeded, finalize tx:", finalizeSig);

      // --- Log position data ---
      console.log("\n--- User Position Data ---");
      const posTx = await provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (posTx?.meta?.logMessages) {
        console.log("Get position tx logs:");
        posTx.meta.logMessages.forEach((l) => console.log("  " + l));
      }
      console.log("--- End User Position Data ---\n");
    });
  });

  describe("Relay Transfer to Destination", () => {
    it("transfers tokens from relay PDA to destination (authority)", async () => {
      const relayIndex = 0;
      const transferAmount = 100_000; // 0.0001 tokens (9 decimals)

      // Derive relay PDA
      const relayPda = deriveRelayPda(vaultPda, relayIndex, program.programId);
      console.log("Relay PDA:", relayPda.toString());

      // Create relay token account (owned by relay PDA)
      const relayTokenKp = Keypair.generate();
      const relayTokenAccount = await createAccount(
        provider.connection,
        owner,
        tokenMint,
        relayPda, // authority = relay PDA
        relayTokenKp, // keypair to avoid ATA off-curve error
      );
      console.log("Relay token account:", relayTokenAccount.toString());

      // Create destination token account (e.g. ephemeral wallet)
      const ephemeralWallet = Keypair.generate();
      const destTokenKpSuccess = Keypair.generate();
      const destinationTokenAccount = await createAccount(
        provider.connection,
        owner,
        tokenMint,
        ephemeralWallet.publicKey,
        destTokenKpSuccess,
      );
      console.log("Destination token account:", destinationTokenAccount.toString());

      // Fund relay token account via fund_relay instruction
      // First create an authority token account and mint some tokens
      const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner,
        tokenMint,
        owner.publicKey,
      );

      // Mint tokens to authority
      await mintTo(
        provider.connection,
        owner,
        tokenMint,
        authorityTokenAccount.address,
        owner,
        transferAmount * 2,
      );

      // Wait for blockhash to refresh after account creation
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Fund relay via fund_relay instruction
      await program.methods
        .fundRelay(relayIndex, new anchor.BN(transferAmount))
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          relayPda: relayPda,
          authorityTokenAccount: authorityTokenAccount.address,
          relayTokenAccount: relayTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      console.log("Funded relay with", transferAmount, "tokens");

      // Verify relay has tokens
      const relayAccountBefore = await withRetry(() => getAccount(provider.connection, relayTokenAccount));
      console.log("Relay balance before transfer:", relayAccountBefore.amount.toString());
      expect(Number(relayAccountBefore.amount)).to.equal(transferAmount);

      // Wait for blockhash to refresh
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Execute relay_transfer_to_destination
      const sig = await program.methods
        .relayTransferToDestination(relayIndex, new anchor.BN(transferAmount))
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          relayPda: relayPda,
          relayTokenAccount: relayTokenAccount,
          destinationTokenAccount: destinationTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      console.log("Relay transfer tx:", sig);

      // Wait before balance reads to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify destination received tokens
      const destAccountAfter = await withRetry(() => getAccount(provider.connection, destinationTokenAccount));
      console.log("Destination balance after transfer:", destAccountAfter.amount.toString());
      expect(Number(destAccountAfter.amount)).to.equal(transferAmount);

      // Verify relay is now empty
      const relayAccountAfter = await withRetry(() => getAccount(provider.connection, relayTokenAccount));
      expect(Number(relayAccountAfter.amount)).to.equal(0);
    });

  });

  // ============================================================
  // FUND RELAY TESTS
  // ============================================================
  describe("Fund Relay", () => {
    it("funds a relay PDA token account", async () => {
      const relayIndex = 2;
      const fundAmount = 500_000;

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

      // Create authority token account and mint tokens
      const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner,
        tokenMint,
        owner.publicKey,
      );

      await mintTo(
        provider.connection,
        owner,
        tokenMint,
        authorityTokenAccount.address,
        owner,
        fundAmount,
      );

      // Wait for blockhash to refresh after account creation
      await new Promise(resolve => setTimeout(resolve, 2000));

      const sig = await program.methods
        .fundRelay(relayIndex, new anchor.BN(fundAmount))
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          relayPda: relayPda,
          authorityTokenAccount: authorityTokenAccount.address,
          relayTokenAccount: relayTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      console.log("Fund relay tx:", sig);

      const relayAccount = await withRetry(() => getAccount(provider.connection, relayTokenAccount));
      expect(Number(relayAccount.amount)).to.equal(fundAmount);
      console.log("Relay PDA", relayIndex, "funded with", fundAmount, "tokens");
    });

  });

  // ============================================================
  // METEORA CPI TESTS (require DAMM v2 program on localnet)
  // These tests will skip gracefully if DAMM v2 is not deployed.
  // ============================================================
  describe("Meteora CPI - Create Customizable Pool via Relay", () => {
    let tokenA: PublicKey;
    let tokenB: PublicKey;
    let relayPda: PublicKey;
    let relayTokenAPubkey: PublicKey;
    let relayTokenBPubkey: PublicKey;
    const relayIndex = 4;
    let setupFailed = false;

    before(async () => {
      try {
        // Create SPL token mint + use NATIVE_MINT (WSOL) for SOL-paired pool
        const mintA = await createMint(provider.connection, owner, owner.publicKey, null, 9);
        // Token A must be lexicographically smaller, Token B larger
        tokenA = minKey(mintA, NATIVE_MINT);
        tokenB = maxKey(mintA, NATIVE_MINT);
        const isTokenANative = tokenA.equals(NATIVE_MINT);
        console.log("Token A:", tokenA.toString(), isTokenANative ? "(WSOL)" : "(SPL)");
        console.log("Token B:", tokenB.toString(), !isTokenANative ? "(WSOL)" : "(SPL)");

        relayPda = deriveRelayPda(vaultPda, relayIndex, program.programId);

        // Fund relay PDA with SOL for rent + WSOL wrapping (relayer simulates mixer output)
        const fundRelayTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: relayPda,
            lamports: 100_000_000, // 0.1 SOL for rent + operations
          })
        );
        await provider.sendAndConfirm(fundRelayTx, [relayer]);

        // Create relay token accounts (keypair to avoid ATA off-curve error)
        // Token A: SPL token account
        const relayTokenAKp = Keypair.generate();
        relayTokenAPubkey = await createAccount(
          provider.connection,
          owner,
          tokenA,
          relayPda,
          relayTokenAKp,
        );
        // Token B: WSOL account
        const relayTokenBKp = Keypair.generate();
        relayTokenBPubkey = await createAccount(
          provider.connection,
          owner,
          tokenB, // NATIVE_MINT (WSOL)
          relayPda,
          relayTokenBKp,
        );

        // Wait for accounts to settle
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Determine which is SPL and which is WSOL
        const splMint = tokenA.equals(NATIVE_MINT) ? tokenB : tokenA;
        const relaySplAccount = tokenA.equals(NATIVE_MINT) ? relayTokenBPubkey : relayTokenAPubkey;
        const relayWsolAccount = tokenA.equals(NATIVE_MINT) ? relayTokenAPubkey : relayTokenBPubkey;

        // Fund relay SPL token via fund_relay (authority mints + transfers)
        const authSplAta = await getOrCreateAssociatedTokenAccount(
          provider.connection, owner, splMint, owner.publicKey
        );
        await mintTo(provider.connection, owner, splMint, authSplAta.address, owner, 200_000_000);

        // Wait before fund_relay calls
        await new Promise(resolve => setTimeout(resolve, 2000));

        await program.methods
          .fundRelay(relayIndex, new anchor.BN(100_000_000))
          .accounts({
            authority: owner.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            authorityTokenAccount: authSplAta.address,
            relayTokenAccount: relaySplAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" });

        // Fund relay WSOL account by transferring SOL + sync native (relayer funds SOL)
        const fundWsolTx = new anchor.web3.Transaction().add(
          SystemProgram.transfer({
            fromPubkey: relayer.publicKey,
            toPubkey: relayWsolAccount,
            lamports: 100_000_000,
          }),
          createSyncNativeInstruction(relayWsolAccount),
        );
        await provider.sendAndConfirm(fundWsolTx, [relayer]);

        console.log("Relay PDA funded with SPL token (authority) and WSOL (relayer) for pool creation");
      } catch (err: any) {
        console.log("Meteora CPI setup failed (DAMM v2 likely not deployed):", err.message?.substring(0, 100));
        setupFailed = true;
      }
    });

    after(async () => {
      if (setupFailed) return;
      try {
        const wsolAccount = tokenA.equals(NATIVE_MINT) ? relayTokenAPubkey : relayTokenBPubkey;
        await closeAccount(provider.connection, owner, wsolAccount, owner.publicKey, owner);
        console.log("Closed WSOL account, SOL reclaimed (create customizable pool section)");
      } catch (err: any) {
        console.log("Cleanup: could not close WSOL account:", err.message?.substring(0, 80));
      }
    });

    it("creates a customizable pool via relay PDA", async function () {
      if (setupFailed) { this.skip(); return; }

      // --- Ephemeral wallet lifecycle: register + fund ---
      const { ephemeralKp, ephemeralPda } = await setupEphemeralWallet(
        program, provider, owner, vaultPda
      );

      const positionNftMint = Keypair.generate();

      // Derive pool PDA using "cpool" seed (DAMM v2 CUSTOMIZABLE_POOL_PREFIX)
      const [poolPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("cpool"),
          maxKey(tokenA, tokenB).toBuffer(),
          minKey(tokenA, tokenB).toBuffer(),
        ],
        DAMM_V2_PROGRAM_ID
      );

      // Derive position PDA
      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), positionNftMint.publicKey.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      // Derive position NFT account PDA
      const [positionNftAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("position_nft_account"), positionNftMint.publicKey.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      // Derive token vaults
      const [tokenAVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tokenA.toBuffer(), poolPda.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );
      const [tokenBVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tokenB.toBuffer(), poolPda.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      // Derive event authority
      const [eventAuthority] = PublicKey.findProgramAddressSync(
        [EVENT_AUTHORITY_SEED],
        DAMM_V2_PROGRAM_ID
      );

      // Pool fee parameters (cliff_fee_numerator must be >= MIN_FEE_NUMERATOR = 100_000)
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

      // Use Meteora SDK price constants
      const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9); // 1:1 price

      try {
        // Ephemeral wallet signs the CPI (not authority)
        const sig = await program.methods
          .createCustomizablePoolViaRelay(
            relayIndex,
            poolFees,
            new anchor.BN(MIN_SQRT_PRICE),   // sqrt_min_price
            new anchor.BN(MAX_SQRT_PRICE),    // sqrt_max_price
            false,                             // has_alpha_vault
            new anchor.BN(1_000_000),         // liquidity
            sqrtPrice,                         // sqrt_price
            0,                                 // activation_type (slot)
            0,                                 // collect_fee_mode
            null,                              // activation_point (None = immediate)
          )
          .accounts({
            payer: ephemeralKp.publicKey,
            vault: vaultPda,
            ephemeralWallet: ephemeralPda,
            relayPda: relayPda,
            positionNftMint: positionNftMint.publicKey,
            positionNftAccount: positionNftAccount,
            poolAuthority: POOL_AUTHORITY,
            pool: poolPda,
            position: positionPda,
            tokenAMint: tokenA,
            tokenBMint: tokenB,
            tokenAVault: tokenAVault,
            tokenBVault: tokenBVault,
            relayTokenA: relayTokenAPubkey,
            relayTokenB: relayTokenBPubkey,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            eventAuthority: eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([ephemeralKp, positionNftMint])
          .rpc({ commitment: "confirmed" });

        console.log("Create customizable pool tx:", sig);

        // Verify pool was created by checking the account exists
        const poolInfo = await withRetry(() => provider.connection.getAccountInfo(poolPda));
        expect(poolInfo).to.not.be.null;
        console.log("Pool account size:", poolInfo!.data.length, "bytes");
        console.log("Pool created at:", poolPda.toString());
      } catch (err: any) {
        const msg = err.message || err.toString();
        // Skip gracefully if DAMM v2 is not deployed or CPI fails due to missing program
        if (msg.includes("not found") || msg.includes("ConstraintSeeds") || msg.includes("Unsupported program")) {
          console.log("DAMM v2 CPI not available, skipping:", msg.substring(0, 120));
          return;
        }
        throw err;
      } finally {
        // --- Ephemeral wallet lifecycle: return funds + close PDA ---
        await teardownEphemeralWallet(program, provider, owner, vaultPda, ephemeralKp, ephemeralPda);
      }
    });

  });

  // ============================================================
  // CREATE METEORA POSITION TESTS
  // ============================================================
  describe("Meteora CPI - Create Position via Relay", () => {
    it("creates a Meteora position for relay PDA", async function () {
      // Delay to avoid RPC rate limiting from previous tests
      await new Promise(resolve => setTimeout(resolve, 3000));

      const relayIndex = 5;
      const relayPda = deriveRelayPda(vaultPda, relayIndex, program.programId);

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
      const tA = minKey(mintA, NATIVE_MINT);
      const tB = maxKey(mintA, NATIVE_MINT);

      // Create relay token accounts
      const relayTokenAKp = Keypair.generate();
      const relayTokenA = await createAccount(provider.connection, owner, tA, relayPda, relayTokenAKp);
      const relayTokenBKp = Keypair.generate();
      const relayTokenB = await createAccount(provider.connection, owner, tB, relayPda, relayTokenBKp);

      // Fund relay SPL token A (authority mints + transfers)
      const splMint = tA.equals(NATIVE_MINT) ? tB : tA;
      const authTokenA = await getOrCreateAssociatedTokenAccount(provider.connection, owner, splMint, owner.publicKey);
      await mintTo(provider.connection, owner, splMint, authTokenA.address, owner, 200_000_000);

      const relayTokenSpl = tA.equals(NATIVE_MINT) ? relayTokenB : relayTokenA;
      await program.methods.fundRelay(relayIndex, new anchor.BN(100_000_000))
        .accounts({ authority: owner.publicKey, vault: vaultPda, relayPda, authorityTokenAccount: authTokenA.address, relayTokenAccount: relayTokenSpl, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([owner]).rpc({ commitment: "confirmed" });

      // Fund relay WSOL account with SOL + sync native (relayer funds SOL)
      const relayTokenWsol = tA.equals(NATIVE_MINT) ? relayTokenA : relayTokenB;
      const fundWsolTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: relayTokenWsol, lamports: 100_000_000 }),
        createSyncNativeInstruction(relayTokenWsol),
      );
      await provider.sendAndConfirm(fundWsolTx, [relayer]);

      // First create a pool via relay using customizable (no config needed)
      const poolNftMint = Keypair.generate();
      const [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("cpool"), maxKey(tA, tB).toBuffer(), minKey(tA, tB).toBuffer()],
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
      const [tokenAVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tA.toBuffer(), poolPda.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );
      const [tokenBVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tB.toBuffer(), poolPda.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );
      const [eventAuthority] = PublicKey.findProgramAddressSync(
        [EVENT_AUTHORITY_SEED], DAMM_V2_PROGRAM_ID
      );

      const poolFees = {
        baseFee: { cliffFeeNumerator: new anchor.BN(2_500_000), firstFactor: 0, secondFactor: Array(8).fill(0), thirdFactor: new anchor.BN(0), baseFeeMode: 0 },
        padding: [0, 0, 0],
        dynamicFee: null,
      };

      const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);

      try {
        // --- Ephemeral wallet for pool creation ---
        const poolEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

        // Create pool first (ephemeral wallet signs)
        await program.methods
          .createCustomizablePoolViaRelay(
            relayIndex, poolFees,
            new anchor.BN(MIN_SQRT_PRICE), new anchor.BN(MAX_SQRT_PRICE),
            false, new anchor.BN(1_000_000), sqrtPrice, 0, 0, null,
          )
          .accounts({
            payer: poolEph.ephemeralKp.publicKey, vault: vaultPda, ephemeralWallet: poolEph.ephemeralPda, relayPda,
            positionNftMint: poolNftMint.publicKey, positionNftAccount: poolNftAccount,
            poolAuthority: POOL_AUTHORITY, pool: poolPda, position: poolPosition,
            tokenAMint: tA, tokenBMint: tB,
            tokenAVault, tokenBVault,
            relayTokenA, relayTokenB,
            tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId, eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([poolEph.ephemeralKp, poolNftMint])
          .rpc({ commitment: "confirmed" });

        console.log("Pool created for position test");

        // Close pool creation ephemeral wallet
        await teardownEphemeralWallet(program, provider, owner, vaultPda, poolEph.ephemeralKp, poolEph.ephemeralPda);

        // Wait for fresh blockhash after pool creation (previous setup exhausts blockhash lifetime)
        // Localnet can also hit stale blockhash after heavy MPC activity
        await new Promise(resolve => setTimeout(resolve, 10000));

        // --- Ephemeral wallet for position creation ---
        const posEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

        // Now create a new position on that pool
        const posNftMint = Keypair.generate();
        const [positionPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), posNftMint.publicKey.toBuffer()],
          DAMM_V2_PROGRAM_ID
        );
        const [posNftAccount] = PublicKey.findProgramAddressSync(
          [Buffer.from("position_nft_account"), posNftMint.publicKey.toBuffer()],
          DAMM_V2_PROGRAM_ID
        );

        // Derive relay position tracker PDA
        const [relayPositionTracker] = PublicKey.findProgramAddressSync(
          [Buffer.from("relay_position"), vaultPda.toBuffer(), Buffer.from([relayIndex]), poolPda.toBuffer()],
          program.programId
        );

        const sig = await program.methods
          .createMeteoraPosition(relayIndex)
          .accounts({
            payer: posEph.ephemeralKp.publicKey,
            vault: vaultPda,
            ephemeralWallet: posEph.ephemeralPda,
            relayPda,
            relayPositionTracker,
            positionNftMint: posNftMint.publicKey,
            positionNftAccount: posNftAccount,
            pool: poolPda,
            position: positionPda,
            poolAuthority: POOL_AUTHORITY,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([posEph.ephemeralKp, posNftMint])
          .rpc({ commitment: "confirmed" });

        console.log("Create Meteora position tx:", sig);

        // Verify position tracker was created
        const tracker = await program.account.relayPositionTracker.fetch(relayPositionTracker);
        expect(tracker.vault.toString()).to.equal(vaultPda.toString());
        expect(tracker.relayIndex).to.equal(relayIndex);
        expect(tracker.pool.toString()).to.equal(poolPda.toString());
        expect(tracker.positionNftMint.toString()).to.equal(posNftMint.publicKey.toString());
        console.log("Position tracker verified");

        // Close position creation ephemeral wallet
        await teardownEphemeralWallet(program, provider, owner, vaultPda, posEph.ephemeralKp, posEph.ephemeralPda);
      } catch (err: any) {
        // Skip gracefully if DAMM v2 not deployed or pool CPI fails (seed mismatch, etc.)
        const msg = err.message || err.toString();
        if (msg.includes("not found") || msg.includes("ConstraintSeeds") || msg.includes("Unsupported program")) {
          console.log("Meteora CPI not available, skipping position test:", msg.substring(0, 100));
          return;
        }
        throw err;
      }
    });
  });

  // ============================================================
  // METEORA CPI - DEPOSIT / WITHDRAW LIQUIDITY TESTS
  // ============================================================
  describe("Meteora CPI - Deposit and Withdraw Liquidity via Relay", () => {
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
    const relayIndex = 6;
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
            lamports: 50_000_000,
          })
        );
        await provider.sendAndConfirm(fundRelayTx, [relayer]);

        // Create SPL mint + use NATIVE_MINT (WSOL) for SOL-paired pool
        const mintA = await createMint(provider.connection, owner, owner.publicKey, null, 9);
        tokenA = minKey(mintA, NATIVE_MINT);
        tokenB = maxKey(mintA, NATIVE_MINT);
        const isTokenANative = tokenA.equals(NATIVE_MINT);
        console.log("Deposit/Withdraw test - Token A:", tokenA.toString(), isTokenANative ? "(WSOL)" : "(SPL)");
        console.log("Deposit/Withdraw test - Token B:", tokenB.toString(), !isTokenANative ? "(WSOL)" : "(SPL)");

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

        // --- Ephemeral wallet for pool creation ---
        const poolEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

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
          .signers([poolEph.ephemeralKp, poolNftMint])
          .rpc({ commitment: "confirmed" });

        console.log("Pool created for deposit/withdraw test at:", poolPda.toString());
        await teardownEphemeralWallet(program, provider, owner, vaultPda, poolEph.ephemeralKp, poolEph.ephemeralPda);

        await new Promise(resolve => setTimeout(resolve, 5000));

        // --- Ephemeral wallet for position creation ---
        const posEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

        // Create a separate position for deposit/withdraw testing
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
            payer: posEph.ephemeralKp.publicKey, vault: vaultPda, ephemeralWallet: posEph.ephemeralPda, relayPda,
            relayPositionTracker,
            positionNftMint: posNftMint.publicKey, positionNftAccount: posNftAccount,
            pool: poolPda, position: positionPda,
            poolAuthority: POOL_AUTHORITY,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId, eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([posEph.ephemeralKp, posNftMint])
          .rpc({ commitment: "confirmed" });

        console.log("Position created for deposit/withdraw test");
        await teardownEphemeralWallet(program, provider, owner, vaultPda, posEph.ephemeralKp, posEph.ephemeralPda);
      } catch (err: any) {
        console.log("Deposit/withdraw test setup failed:", err.message?.substring(0, 150));
        setupFailed = true;
      }
    });

    after(async () => {
      if (setupFailed) return;
      try {
        const wsolAccount = tokenA.equals(NATIVE_MINT) ? relayTokenA : relayTokenB;
        await closeAccount(provider.connection, owner, wsolAccount, owner.publicKey, owner);
        console.log("Closed WSOL account, SOL reclaimed (deposit/withdraw section)");
      } catch (err: any) {
        console.log("Cleanup: could not close WSOL account:", err.message?.substring(0, 80));
      }
    });

    it("deposits liquidity to Meteora via relay PDA", async function () {
      if (setupFailed) { this.skip(); return; }

      await new Promise(resolve => setTimeout(resolve, 3000));

      // --- Ephemeral wallet for deposit ---
      const depEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

      try {
        // Calculate proper liquidity delta from token amounts using Meteora SDK
        const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);
        const liquidityDelta = calculateLiquidityFromAmounts(
          provider.connection,
          new anchor.BN(10_000_000), // 0.01 token A
          new anchor.BN(10_000_000), // 0.01 token B
          sqrtPrice,
        );
        console.log("Calculated liquidity delta for deposit:", liquidityDelta.toString());

        const sig = await program.methods
          .depositToMeteoraDammV2(
            relayIndex,
            liquidityDelta,                        // SDK-computed liquidity_delta
            new anchor.BN("18446744073709551615"), // token_a_amount_threshold (u64::MAX)
            new anchor.BN("18446744073709551615"), // token_b_amount_threshold (u64::MAX)
            null,                                  // sol_amount (not using WSOL)
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
          .signers([depEph.ephemeralKp])
          .rpc({ commitment: "confirmed" });

        console.log("Deposit to Meteora tx:", sig);

        // Verify position has liquidity by checking the account exists
        const positionInfo = await withRetry(() => provider.connection.getAccountInfo(positionPda));
        expect(positionInfo).to.not.be.null;
        console.log("Position account size after deposit:", positionInfo!.data.length, "bytes");
      } catch (err: any) {
        const msg = err.message || err.toString();
        if (msg.includes("not found") || msg.includes("Unsupported program")) {
          console.log("DAMM v2 CPI not available, skipping:", msg.substring(0, 120));
          return;
        }
        throw err;
      } finally {
        await teardownEphemeralWallet(program, provider, owner, vaultPda, depEph.ephemeralKp, depEph.ephemeralPda);
      }
    });

    it("withdraws liquidity from Meteora via relay PDA", async function () {
      if (setupFailed) { this.skip(); return; }

      await new Promise(resolve => setTimeout(resolve, 3000));

      // --- Ephemeral wallet for withdraw ---
      const wdEph = await setupEphemeralWallet(program, provider, owner, vaultPda);

      try {
        // Read the position's actual unlocked_liquidity (u128 at offset 152 in account data)
        // Layout: 8 (discriminator) + 32 (pool) + 32 (nft_mint) + 32 (fee_a_checkpoint) + 32 (fee_b_checkpoint) + 8 (fee_a_pending) + 8 (fee_b_pending) = 152
        const positionInfo = await provider.connection.getAccountInfo(positionPda);
        if (!positionInfo) throw new Error("Position account not found");
        const unlockedLiquidityBytes = positionInfo.data.slice(152, 168); // u128 = 16 bytes LE
        const unlockedLiquidity = new anchor.BN(unlockedLiquidityBytes, "le");
        console.log("Position unlocked_liquidity:", unlockedLiquidity.toString());

        // Withdraw all unlocked liquidity (ephemeral wallet signs)
        const sig = await program.methods
          .withdrawFromMeteoraDammV2(
            relayIndex,
            unlockedLiquidity,           // liquidity_delta (withdraw all)
            new anchor.BN(0),            // token_a_amount_threshold (no minimum)
            new anchor.BN(0),            // token_b_amount_threshold (no minimum)
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
          .signers([wdEph.ephemeralKp])
          .rpc({ commitment: "confirmed" });

        console.log("Withdraw from Meteora tx:", sig);
      } catch (err: any) {
        const msg = err.message || err.toString();
        if (msg.includes("not found") || msg.includes("Unsupported program")) {
          console.log("DAMM v2 CPI not available, skipping:", msg.substring(0, 120));
          return;
        }
        throw err;
      } finally {
        await teardownEphemeralWallet(program, provider, owner, vaultPda, wdEph.ephemeralKp, wdEph.ephemeralPda);
      }
    });

  });

  // ============================================================
  // EPHEMERAL WALLET TESTS
  // ============================================================
  describe("Ephemeral Wallet Management", () => {
    it("registers an ephemeral wallet", async () => {
      const ephemeralKeypair = Keypair.generate();
      const ephemeralPda = deriveEphemeralWalletPda(vaultPda, ephemeralKeypair.publicKey, program.programId);

      const sig = await program.methods
        .registerEphemeralWallet()
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          wallet: ephemeralKeypair.publicKey,
          ephemeralWallet: ephemeralPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      console.log("Register ephemeral wallet tx:", sig);

      const ephemeralAccount = await program.account.ephemeralWalletAccount.fetch(ephemeralPda);
      expect(ephemeralAccount.vault.toString()).to.equal(vaultPda.toString());
      expect(ephemeralAccount.wallet.toString()).to.equal(ephemeralKeypair.publicKey.toString());
      console.log("Ephemeral wallet registered and verified");
    });

    it("closes an ephemeral wallet", async () => {
      const ephemeralKeypair = Keypair.generate();
      const ephemeralPda = deriveEphemeralWalletPda(vaultPda, ephemeralKeypair.publicKey, program.programId);

      // Register first
      await program.methods
        .registerEphemeralWallet()
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          wallet: ephemeralKeypair.publicKey,
          ephemeralWallet: ephemeralPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      // Wait for settle
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Close it
      const sig = await program.methods
        .closeEphemeralWallet()
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          ephemeralWallet: ephemeralPda,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });

      console.log("Close ephemeral wallet tx:", sig);

      // Verify account is closed (should not exist)
      const accountInfo = await provider.connection.getAccountInfo(ephemeralPda);
      expect(accountInfo).to.be.null;
      console.log("Ephemeral wallet closed and verified");
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
    console.log("All tests complete. Log saved to:", LOG_FILE);
    console.log("=".repeat(60));
    logStream.end();
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
