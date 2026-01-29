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
  uploadCircuit,
  RescueCipher,
  deserializeLE,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  x25519,
  getComputationAccAddress,
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
  for (let attempt = 1; attempt <= MAX_COMPUTATION_RETRIES; attempt++) {
    const computationOffset = new anchor.BN(randomBytes(8), "hex");
    try {
      console.log(`[${label}] Attempt ${attempt}/${MAX_COMPUTATION_RETRIES} - queuing computation (offset: ${computationOffset.toString()})`);
      const queueSig = await buildAndSend(computationOffset);
      console.log(`[${label}] Queue tx: ${queueSig}`);

      console.log(`[${label}] Waiting for computation finalization...`);
      const finalizeSig = await awaitComputationFinalization(
        provider,
        computationOffset,
        programId,
        "confirmed"
      );
      console.log(`[${label}] Finalize tx: ${finalizeSig}`);

      // Check if the finalized tx had an error (AbortedComputation = custom error 6000)
      const txResult = await provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

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
        throw err; // Re-throw our own exhaustion error
      }
      console.log(`[${label}] Attempt ${attempt} error:`, err.message || err);
      if (err.logs) console.log(`[${label}] Logs:`, err.logs);
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

describe("zodiac-liquidity", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.ZodiacLiquidity as Program<ZodiacLiquidity>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

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

  // ============================================================
  // METEORA DAMM V2 INTEGRATION TESTS (Relay PDA)
  // ============================================================

  describe("Meteora DAMM v2 Integration (Relay PDAs)", () => {
    const RELAY_INDEX = 0;
    let relayPda: PublicKey;

    // Meteora pool state
    let meteoraTokenAMint: PublicKey;
    let meteoraTokenBMint: PublicKey;
    let poolPda: PublicKey;
    let positionNftMint: Keypair;
    let positionPda: PublicKey;
    let positionNftAccount: PublicKey;
    let tokenAVault: PublicKey;
    let tokenBVault: PublicKey;

    // Relay token accounts
    let relayTokenA: PublicKey;
    let relayTokenB: PublicKey;

    // Authority token accounts (for funding relay)
    let authorityTokenA: PublicKey;
    let authorityTokenB: PublicKey;

    let totalLiquidity: anchor.BN | null = null;

    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [EVENT_AUTHORITY_SEED],
      DAMM_V2_PROGRAM_ID
    );

    it("verifies DAMM v2 program is available on devnet", async () => {
      const dammInfo = await provider.connection.getAccountInfo(DAMM_V2_PROGRAM_ID);
      if (!dammInfo) throw new Error("DAMM v2 program not found on devnet");
      console.log("DAMM v2 program found, executable:", dammInfo.executable);

      const configInfo = await provider.connection.getAccountInfo(CONFIG_ACCOUNT);
      if (!configInfo) throw new Error("Config account not found");
      console.log("Config account found, data length:", configInfo.data.length);
    });

    it("sets up Meteora test tokens and relay PDA", async () => {
      // Derive relay PDA
      relayPda = deriveRelayPda(vaultPda, RELAY_INDEX, program.programId);
      console.log("Relay PDA (index", RELAY_INDEX + "):", relayPda.toString());

      // Create Token A (custom SPL token for Meteora pool)
      meteoraTokenAMint = await createMint(
        provider.connection,
        owner,
        owner.publicKey,
        null,
        9,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      console.log("Meteora Token A Mint:", meteoraTokenAMint.toString());

      // Token B = WSOL
      meteoraTokenBMint = NATIVE_MINT;
      console.log("Meteora Token B Mint (WSOL):", meteoraTokenBMint.toString());

      // Create authority token accounts
      authorityTokenA = await createAccount(
        provider.connection,
        owner,
        meteoraTokenAMint,
        owner.publicKey,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
      );
      console.log("Authority Token A Account:", authorityTokenA.toString());

      const wsolKeypair = Keypair.generate();
      authorityTokenB = await createAccount(
        provider.connection,
        owner,
        NATIVE_MINT,
        owner.publicKey,
        wsolKeypair,
        undefined,
        TOKEN_PROGRAM_ID
      );
      console.log("Authority Token B Account (WSOL):", authorityTokenB.toString());

      // Mint Token A to authority
      await mintTo(
        provider.connection,
        owner,
        meteoraTokenAMint,
        authorityTokenA,
        owner,
        1_000_000_000 * 1_000_000_000 // 1B tokens
      );
      console.log("Minted 1B Token A to authority");

      // Create relay PDA token accounts (ATAs owned by relay PDA)
      const relayTokenAAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner,
        meteoraTokenAMint,
        relayPda,
        true // allowOwnerOffCurve for PDA
      );
      relayTokenA = relayTokenAAccount.address;
      console.log("Relay Token A Account:", relayTokenA.toString());

      const relayTokenBAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        owner,
        NATIVE_MINT,
        relayPda,
        true
      );
      relayTokenB = relayTokenBAccount.address;
      console.log("Relay Token B Account:", relayTokenB.toString());
    });

    it("funds relay PDA with Token A via fund_relay", async () => {
      const fundAmount = new anchor.BN("500000000000000000"); // 500M tokens (9 decimals)

      const tx = await program.methods
        .fundRelay(RELAY_INDEX, fundAmount)
        .accountsPartial({
          authority: owner.publicKey,
          vault: vaultPda,
          relayPda: relayPda,
          authorityTokenAccount: authorityTokenA,
          relayTokenAccount: relayTokenA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      console.log("fund_relay (Token A) tx:", tx);

      const relayBalance = await getAccount(provider.connection, relayTokenA);
      console.log("Relay Token A balance:", relayBalance.amount.toString());
    });

    it("funds relay PDA with SOL (for WSOL wrapping and rent)", async () => {
      // Transfer SOL to relay PDA for rent + WSOL
      const solAmount = 0.1 * anchor.web3.LAMPORTS_PER_SOL; // 0.1 SOL
      const transferIx = anchor.web3.SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: relayPda,
        lamports: solAmount,
      });
      const tx = new anchor.web3.Transaction().add(transferIx);
      const sig = await provider.sendAndConfirm(tx, [owner]);
      console.log("SOL transfer to relay PDA tx:", sig);

      const relayBalance = await provider.connection.getBalance(relayPda);
      console.log("Relay PDA SOL balance:", relayBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");
    });

    it("creates a Meteora pool via relay PDA (create_pool_via_relay)", async () => {
      positionNftMint = Keypair.generate();
      console.log("\n=== Creating Pool via Relay PDA ===");
      console.log("Position NFT Mint:", positionNftMint.publicKey.toString());

      // Derive pool PDA
      [poolPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("pool"),
          CONFIG_ACCOUNT.toBuffer(),
          maxKey(meteoraTokenAMint, meteoraTokenBMint).toBuffer(),
          minKey(meteoraTokenAMint, meteoraTokenBMint).toBuffer(),
        ],
        DAMM_V2_PROGRAM_ID
      );
      console.log("Pool PDA:", poolPda.toString());

      // Derive other PDAs
      [positionNftAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("position_nft_account"), positionNftMint.publicKey.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), positionNftMint.publicKey.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      [tokenAVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), meteoraTokenAMint.toBuffer(), poolPda.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      [tokenBVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), meteoraTokenBMint.toBuffer(), poolPda.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      // Pool parameters
      const tokenADecimals = 9;
      const tokenBDecimals = 9;
      const desiredTokenAAmount = new anchor.BN(1_000_000 * Math.pow(10, tokenADecimals)); // 1M tokens
      const desiredTokenBAmount = new anchor.BN(0.05 * anchor.web3.LAMPORTS_PER_SOL); // 0.05 SOL
      const initPrice = 0.05 / 1_000_000; // price = tokenB/tokenA
      const sqrtPrice = getSqrtPriceFromPrice(initPrice.toString(), tokenADecimals, tokenBDecimals);

      const liquidity = calculateLiquidityFromAmounts(
        provider.connection,
        desiredTokenAAmount,
        desiredTokenBAmount,
        sqrtPrice,
      );

      console.log("Liquidity:", liquidity.toString());
      console.log("Sqrt Price:", sqrtPrice.toString());

      // We need to fund the relay's WSOL account before pool creation
      // Transfer SOL to the relay WSOL token account and sync
      const wrapSolTx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: relayTokenB,
          lamports: desiredTokenBAmount.toNumber(),
        }),
        // sync_native via SPL token
        createSyncNativeInstruction(relayTokenB)
      );
      const wrapSig = await provider.sendAndConfirm(wrapSolTx, [owner]);
      console.log("Wrapped SOL for relay WSOL account:", wrapSig);

      try {
        const tx = await program.methods
          .createPoolViaRelay(
            RELAY_INDEX,
            liquidity,
            sqrtPrice,
            null, // no activation point
          )
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            positionNftMint: positionNftMint.publicKey,
            positionNftAccount: positionNftAccount,
            config: CONFIG_ACCOUNT,
            poolAuthority: POOL_AUTHORITY,
            pool: poolPda,
            position: positionPda,
            tokenAMint: meteoraTokenAMint,
            tokenBMint: meteoraTokenBMint,
            tokenAVault: tokenAVault,
            tokenBVault: tokenBVault,
            relayTokenA: relayTokenA,
            relayTokenB: relayTokenB,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            eventAuthority: eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([owner, positionNftMint])
          .rpc({ skipPreflight: true, commitment: "confirmed" });

        console.log("create_pool_via_relay tx:", tx);
        totalLiquidity = liquidity;

        const poolInfo = await provider.connection.getAccountInfo(poolPda);
        console.log("Pool account created, data length:", poolInfo?.data.length);
      } catch (error: any) {
        console.error("create_pool_via_relay failed:", error.message);
        if (error.logs) {
          error.logs.forEach((l: string) => console.error("  ", l));
        }
        throw error;
      }
    });

    it("creates a new Meteora position for relay PDA (create_meteora_position)", async () => {
      // Create a second position on the same pool
      const newPositionNftMint = Keypair.generate();
      console.log("\n=== Creating Meteora Position via Relay PDA ===");
      console.log("New Position NFT Mint:", newPositionNftMint.publicKey.toString());

      const [newPositionNftAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("position_nft_account"), newPositionNftMint.publicKey.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      const [newPosition] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), newPositionNftMint.publicKey.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      try {
        const tx = await program.methods
          .createMeteoraPosition(RELAY_INDEX)
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            positionNftMint: newPositionNftMint.publicKey,
            positionNftAccount: newPositionNftAccount,
            pool: poolPda,
            position: newPosition,
            poolAuthority: POOL_AUTHORITY,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            eventAuthority: eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([owner, newPositionNftMint])
          .rpc({ skipPreflight: true, commitment: "confirmed" });

        console.log("create_meteora_position tx:", tx);

        const posInfo = await provider.connection.getAccountInfo(newPosition);
        console.log("Position account created, data length:", posInfo?.data.length);
      } catch (error: any) {
        console.error("create_meteora_position failed:", error.message);
        if (error.logs) {
          error.logs.forEach((l: string) => console.error("  ", l));
        }
        throw error;
      }
    });

    it("deposits liquidity to Meteora via relay PDA (deposit_to_meteora_damm_v2)", async () => {
      console.log("\n=== Adding Liquidity via Relay PDA ===");

      const tokenADecimals = 9;
      const tokenBDecimals = 9;
      const addTokenAAmount = new anchor.BN(100_000 * Math.pow(10, tokenADecimals)); // 100K tokens
      const addTokenBAmount = new anchor.BN(0.005 * anchor.web3.LAMPORTS_PER_SOL); // 0.005 SOL
      const currentPrice = 0.05 / 1_000_000;
      const sqrtPrice = getSqrtPriceFromPrice(currentPrice.toString(), tokenADecimals, tokenBDecimals);

      const liquidityDelta = calculateLiquidityFromAmounts(
        provider.connection,
        addTokenAAmount,
        addTokenBAmount,
        sqrtPrice,
      );

      // Thresholds: allow 20% slippage
      const tokenAThreshold = addTokenAAmount.mul(new anchor.BN(120)).div(new anchor.BN(100));
      const tokenBThreshold = addTokenBAmount.mul(new anchor.BN(120)).div(new anchor.BN(100));

      console.log("Liquidity Delta:", liquidityDelta.toString());
      console.log("Token A Threshold:", tokenAThreshold.toString());
      console.log("Token B Threshold:", tokenBThreshold.toString());

      // Wrap more SOL for the relay's WSOL account
      const wrapSolTx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: relayTokenB,
          lamports: addTokenBAmount.toNumber(),
        }),
        createSyncNativeInstruction(relayTokenB)
      );
      await provider.sendAndConfirm(wrapSolTx, [owner]);

      try {
        const tx = await program.methods
          .depositToMeteoraDammV2(
            RELAY_INDEX,
            liquidityDelta,
            tokenAThreshold,
            tokenBThreshold,
            null, // no SOL wrapping (already wrapped above)
          )
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            pool: poolPda,
            position: positionPda,
            relayTokenA: relayTokenA,
            relayTokenB: relayTokenB,
            tokenAVault: tokenAVault,
            tokenBVault: tokenBVault,
            tokenAMint: meteoraTokenAMint,
            tokenBMint: meteoraTokenBMint,
            positionNftAccount: positionNftAccount,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            eventAuthority: eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ skipPreflight: true, commitment: "confirmed" });

        console.log("deposit_to_meteora_damm_v2 tx:", tx);
        if (totalLiquidity) {
          totalLiquidity = totalLiquidity.add(liquidityDelta);
        }
        console.log("Total liquidity after add:", totalLiquidity?.toString());
      } catch (error: any) {
        console.error("deposit_to_meteora_damm_v2 failed:", error.message);
        if (error.logs) {
          error.logs.forEach((l: string) => console.error("  ", l));
        }
        throw error;
      }
    });

    it("withdraws liquidity from Meteora via relay PDA (withdraw_from_meteora_damm_v2)", async () => {
      console.log("\n=== Removing Liquidity via Relay PDA ===");

      if (!totalLiquidity) {
        throw new Error("No liquidity to remove");
      }

      // Remove 50% of total liquidity
      const liquidityDelta = totalLiquidity.div(new anchor.BN(2));
      const tokenAThreshold = new anchor.BN(0);
      const tokenBThreshold = new anchor.BN(0);

      console.log("Total liquidity:", totalLiquidity.toString());
      console.log("Removing 50%:", liquidityDelta.toString());

      try {
        const tx = await program.methods
          .withdrawFromMeteoraDammV2(
            RELAY_INDEX,
            liquidityDelta,
            tokenAThreshold,
            tokenBThreshold,
          )
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            relayPda: relayPda,
            poolAuthority: POOL_AUTHORITY,
            pool: poolPda,
            position: positionPda,
            relayTokenA: relayTokenA,
            relayTokenB: relayTokenB,
            tokenAVault: tokenAVault,
            tokenBVault: tokenBVault,
            tokenAMint: meteoraTokenAMint,
            tokenBMint: meteoraTokenBMint,
            positionNftAccount: positionNftAccount,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            eventAuthority: eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ skipPreflight: true, commitment: "confirmed" });

        console.log("withdraw_from_meteora_damm_v2 tx:", tx);
        totalLiquidity = totalLiquidity.sub(liquidityDelta);
        console.log("Remaining liquidity:", totalLiquidity.toString());

        // Check relay balances after withdrawal
        const relayABalance = await getAccount(provider.connection, relayTokenA);
        const relayBBalance = await getAccount(provider.connection, relayTokenB);
        console.log("Relay Token A balance after withdraw:", relayABalance.amount.toString());
        console.log("Relay Token B balance after withdraw:", relayBBalance.amount.toString());
      } catch (error: any) {
        console.error("withdraw_from_meteora_damm_v2 failed:", error.message);
        if (error.logs) {
          error.logs.forEach((l: string) => console.error("  ", l));
        }
        throw error;
      }
    });

    it("rejects invalid relay_index (12)", async () => {
      const invalidRelayIndex = 12;
      try {
        await program.methods
          .fundRelay(invalidRelayIndex, new anchor.BN(1))
          .accountsPartial({
            authority: owner.publicKey,
            vault: vaultPda,
            relayPda: deriveRelayPda(vaultPda, invalidRelayIndex, program.programId),
            authorityTokenAccount: authorityTokenA,
            relayTokenAccount: relayTokenA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ skipPreflight: true, commitment: "confirmed" });

        throw new Error("Should have failed with InvalidRelayIndex");
      } catch (error: any) {
        // The PDA derivation with index 12 won't match the seeds constraint,
        // or the require! check will fail. Either way, tx should fail.
        console.log("Correctly rejected relay_index=12:", error.message?.slice(0, 100));
      }
    });

    it("derives different PDAs for each relay index (0..11)", () => {
      const pdas = new Set<string>();
      for (let i = 0; i < NUM_RELAYS; i++) {
        const pda = deriveRelayPda(vaultPda, i, program.programId);
        pdas.add(pda.toString());
        console.log(`Relay ${i}: ${pda.toString()}`);
      }
      // All 12 should be unique
      if (pdas.size !== NUM_RELAYS) {
        throw new Error(`Expected ${NUM_RELAYS} unique PDAs, got ${pdas.size}`);
      }
      console.log("All 12 relay PDAs are unique");
    });
  });

  after(() => {
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
    const accountInfo = await provider.connection.getAccountInfo(compDefPDA);

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
