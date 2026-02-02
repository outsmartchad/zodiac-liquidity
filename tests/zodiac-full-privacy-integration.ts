import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL, AddressLookupTableProgram } from "@solana/web3.js";
import { ZodiacLiquidity } from "../target/types/zodiac_liquidity";
import { ZodiacMixer } from "../target/types/zodiac_mixer";
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
import * as path from "path";
import { expect } from "chai";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  createMint,
  createAccount,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent,
  createAssociatedTokenAccountIdempotentInstruction,
  mintTo,
  getAccount,
  createSyncNativeInstruction,
  closeAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  CpAmm,
  getSqrtPriceFromPrice,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} from "@meteora-ag/cp-amm-sdk";
import { BN } from "bn.js";
import { LightWasm, WasmFactory } from "@lightprotocol/hasher.rs";
import { Utxo } from "./lib/utxo";
import { parseProofToBytesArray, parseToBytesArray, prove } from "./lib/prover";
import { utils } from "ffjavascript";
import { getExtDataHash, getMintAddressField } from "./lib/utils";
import { DEFAULT_HEIGHT, FIELD_SIZE, ROOT_HISTORY_SIZE, DEPOSIT_FEE_RATE, WITHDRAW_FEE_RATE } from "./lib/constants";
import {
  createGlobalTestALT,
  getTestProtocolAddresses,
  getTestProtocolAddressesWithMint,
  createVersionedTransactionWithALT,
  sendAndConfirmVersionedTransaction,
  resetGlobalTestALT,
} from "./lib/test_alt";

// ============================================================
// CONSTANTS
// ============================================================

const NUM_RELAYS = 12;
const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

const ENCRYPTION_KEY_MESSAGE = "zodiac-liquidity-encryption-key-v1";
const MAX_COMPUTATION_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

const SOL_MINT = new PublicKey("11111111111111111111111111111112");
const keyBasePath = path.resolve(__dirname, "../artifacts/circuits/transaction2");

// Mixer amounts
const MIXER_SOL_DEPOSIT = 5_000_000; // 5M lamports SOL per user into mixer
const MIXER_SPL_DEPOSIT = 5_000_000; // 5M token units SPL per user into mixer
const SPL_MAX_DEPOSIT = 1_000_000_000_000;

// ============================================================
// LOGGING
// ============================================================

const LOG_FILE = "full-privacy-integration.log";
const logStream = fs.createWriteStream(LOG_FILE, { flags: "w" });
const origLog = console.log;
console.log = (...args: any[]) => {
  const line = args.map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : String(a))).join(" ");
  origLog(...args);
  try { logStream.write(line + "\n"); } catch {}
};

function logSeparator(title: string) {
  console.log("");
  console.log("─".repeat(60));
  console.log(`  ${title}`);
  console.log("─".repeat(60));
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
// MIXER HELPERS (adapted from zodiac-mixer.ts)
// ============================================================

function onChainBytesToField(bytes: number[]): string {
  const hex = bytes.map(b => b.toString(16).padStart(2, "0")).join("");
  return BigInt("0x" + hex).toString();
}

class SubtreesMerkleTree {
  subtrees: string[];
  zeros: string[];
  nextIndex: number;
  height: number;
  levels: number;
  _lightWasm: LightWasm;
  private _root: string;
  private leafPaths: Map<number, string[]> = new Map();
  private leafHashes: Map<number, string> = new Map();

  constructor(
    onChainSubtrees: number[][],
    onChainRoot: number[],
    nextIndex: number,
    height: number,
    lightWasm: LightWasm,
  ) {
    this.height = height;
    this.levels = height;
    this._lightWasm = lightWasm;
    this.nextIndex = nextIndex;

    this.zeros = [];
    this.zeros[0] = "0";
    for (let i = 1; i <= height; i++) {
      this.zeros[i] = lightWasm.poseidonHashString([this.zeros[i - 1], this.zeros[i - 1]]);
    }

    this.subtrees = onChainSubtrees.map(bytes => onChainBytesToField(bytes));
    this._root = onChainBytesToField(onChainRoot);
  }

  root(): string { return this._root; }

  insert(leaf: string): void {
    const pathElements: string[] = [];
    let currentIndex = this.nextIndex;
    let currentHash = leaf;

    for (let level = 0; level < this.height; level++) {
      if (currentIndex % 2 === 0) {
        pathElements.push(this.zeros[level]);
        this.subtrees[level] = currentHash;
        currentHash = this._lightWasm.poseidonHashString([currentHash, this.zeros[level]]);
      } else {
        pathElements.push(this.subtrees[level]);
        currentHash = this._lightWasm.poseidonHashString([this.subtrees[level], currentHash]);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }

    this.leafPaths.set(this.nextIndex, pathElements);
    this.leafHashes.set(this.nextIndex, leaf);
    this._root = currentHash;
    this.nextIndex++;
  }

  insertPair(leaf0: string, leaf1: string): void {
    const firstIndex = this.nextIndex;
    this.insert(leaf0);
    this.insert(leaf1);
    if (firstIndex % 2 === 0) {
      const path0 = this.leafPaths.get(firstIndex)!;
      path0[0] = leaf1;
    }
  }

  path(index: number): { pathElements: string[] } {
    const pathElements = this.leafPaths.get(index);
    if (!pathElements) throw new Error(`No path stored for leaf at index ${index}`);
    return { pathElements };
  }

  indexOf(leaf: string): number {
    for (const [idx, hash] of this.leafHashes) {
      if (hash === leaf) return idx;
    }
    return -1;
  }
}

function calculateFee(amount: number, feeRate: number): number {
  return Math.floor((amount * feeRate) / 10000);
}
function calculateDepositFee(amount: number): number { return calculateFee(amount, DEPOSIT_FEE_RATE); }
function calculateWithdrawalFee(amount: number): number { return calculateFee(amount, WITHDRAW_FEE_RATE); }

function findNullifierPDAs(program: anchor.Program<any>, proof: any) {
  const [nullifier0PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier0"), Buffer.from(proof.inputNullifiers[0])], program.programId
  );
  const [nullifier1PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier1"), Buffer.from(proof.inputNullifiers[1])], program.programId
  );
  return { nullifier0PDA, nullifier1PDA };
}

function findCrossCheckNullifierPDAs(program: anchor.Program<any>, proof: any) {
  const [nullifier2PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier0"), Buffer.from(proof.inputNullifiers[1])], program.programId
  );
  const [nullifier3PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier1"), Buffer.from(proof.inputNullifiers[0])], program.programId
  );
  return { nullifier2PDA, nullifier3PDA };
}

function createExtDataMinified(extData: any) {
  return { extAmount: extData.extAmount, fee: extData.fee };
}

async function generateProofAndFormat(
  inputs: Utxo[],
  outputs: Utxo[],
  tree: any,
  extData: any,
  _lightWasm: LightWasm,
  _keyBasePath: string,
) {
  const inputMerklePathIndices = [];
  const inputMerklePathElements = [];

  for (const input of inputs) {
    if (input.amount.gt(new BN(0))) {
      const commitment = await input.getCommitment();
      input.index = tree.indexOf(commitment);
      inputMerklePathIndices.push(input.index);
      inputMerklePathElements.push(tree.path(input.index).pathElements);
    } else {
      inputMerklePathIndices.push(0);
      inputMerklePathElements.push(new Array(tree.levels).fill(0));
    }
  }

  const inputNullifiers = await Promise.all(inputs.map(x => x.getNullifier()));
  const outputCommitments = await Promise.all(outputs.map(x => x.getCommitment()));
  const root = tree.root();
  const extDataHash = getExtDataHash(extData);

  const extAmount = new BN(extData.extAmount.toString());
  const fee = new BN(extData.fee.toString());
  const publicAmount = extAmount.sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE);

  const circuitInput = {
    root,
    inputNullifier: inputNullifiers,
    outputCommitment: outputCommitments,
    publicAmount: publicAmount.toString(),
    extDataHash,
    inAmount: inputs.map(x => x.amount.toString(10)),
    inPrivateKey: inputs.map(x => x.keypair.privkey),
    inBlinding: inputs.map(x => x.blinding.toString(10)),
    mintAddress: getMintAddressField(new PublicKey(inputs[0].mintAddress)),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,
    outAmount: outputs.map(x => x.amount.toString(10)),
    outBlinding: outputs.map(x => x.blinding.toString(10)),
    outPubkey: outputs.map(x => x.keypair.pubkey),
  };

  const proofResult = await prove(circuitInput, _keyBasePath);
  const proofInBytes = parseProofToBytesArray(proofResult.proof);
  const inputsInBytes = parseToBytesArray(proofResult.publicSignals);

  const proofToSubmit = {
    proofA: proofInBytes.proofA,
    proofB: proofInBytes.proofB.flat(),
    proofC: proofInBytes.proofC,
    root: inputsInBytes[0],
    publicAmount: inputsInBytes[1],
    extDataHash: inputsInBytes[2],
    inputNullifiers: [inputsInBytes[3], inputsInBytes[4]],
    outputCommitments: [inputsInBytes[5], inputsInBytes[6]],
  };

  return { proofToSubmit, outputCommitments, inputNullifiers };
}

// ============================================================
// MPC / ARCIUM HELPERS (adapted from integration test)
// ============================================================

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err: any) {
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
    try { return await fn(); } catch (err: any) {
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
      console.log(`[${label}] Attempt ${attempt}/${MAX_COMPUTATION_RETRIES} - queuing (offset: ${computationOffset.toString()})`);
      const queueSig = await buildAndSend(computationOffset);
      console.log(`[${label}] Queue tx: ${queueSig}`);

      console.log(`[${label}] Waiting for computation finalization...`);
      const finalizationPromise = awaitComputationFinalization(provider, computationOffset, programId, "confirmed");

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
              if (!found) throw new Error("DROPPED_FROM_MEMPOOL");
              console.log(`[${label}] Computation found in mempool, continuing to wait...`);
            } catch (mempoolErr: any) {
              if (mempoolErr.message === "DROPPED_FROM_MEMPOOL") throw mempoolErr;
              console.log(`[${label}] Mempool check failed, continuing to wait...`);
            }
          } else {
            console.log(`[${label}] Computation account confirmed on-chain, continuing to wait...`);
          }
          await new Promise((r) => setTimeout(r, MEMPOOL_CHECK_TIMEOUT_MS - 15_000));
          if (timeoutCancelled) return "CANCELLED" as any;
          throw new Error("TIMEOUT_WAITING_FOR_FINALIZATION");
        })(),
      ]);
      console.log(`[${label}] Finalize tx: ${finalizeSig}`);

      const txResult = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }));

      if (txResult?.meta?.err) {
        console.log(`[${label}] Attempt ${attempt} ABORTED - tx error:`, JSON.stringify(txResult.meta.err));
        if (attempt < MAX_COMPUTATION_RETRIES) {
          console.log(`[${label}] Retrying in ${RETRY_DELAY_MS}ms...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        throw new Error(`[${label}] All ${MAX_COMPUTATION_RETRIES} attempts aborted`);
      }

      console.log(`[${label}] Computation succeeded on attempt ${attempt}`);
      return finalizeSig;
    } catch (err: any) {
      if (err.message?.includes("All") && err.message?.includes("aborted")) throw err;
      const isRetryable = err.message === "DROPPED_FROM_MEMPOOL" || err.message === "TIMEOUT_WAITING_FOR_FINALIZATION";
      if (isRetryable) {
        console.log(`[${label}] Attempt ${attempt} - ${err.message === "DROPPED_FROM_MEMPOOL" ? "dropped from mempool" : "timed out"}`);
      } else {
        console.log(`[${label}] Attempt ${attempt} error:`, err.message || err);
      }
      if (attempt < MAX_COMPUTATION_RETRIES) {
        console.log(`[${label}] Retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[${label}] Exhausted all retries`);
}

function deriveEncryptionKey(wallet: Keypair, message: string): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, wallet.secretKey);
  const privateKey = new Uint8Array(createHash("sha256").update(signature).digest());
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

function getClusterAccount(): PublicKey {
  return getClusterAccAddress(getArciumEnv().arciumClusterOffset);
}

function deriveRelayPda(vaultPda: PublicKey, relayIndex: number, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("zodiac_relay"), vaultPda.toBuffer(), Buffer.from([relayIndex])], programId
  );
  return pda;
}

function deriveEphemeralWalletPda(vaultPda: PublicKey, walletPubkey: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ephemeral"), vaultPda.toBuffer(), walletPubkey.toBuffer()], programId
  );
  return pda;
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider, programId: PublicKey, maxRetries = 40, retryDelayMs = 1000,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) return mxePublicKey;
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }
    if (attempt < maxRetries) {
      console.log(`Retrying in ${retryDelayMs}ms... (attempt ${attempt}/${maxRetries})`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
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

  const fundTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: ephemeralKp.publicKey, lamports: fundLamports })
  );
  await provider.sendAndConfirm(fundTx, [owner]);
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log("Ephemeral wallet created:", ephemeralKp.publicKey.toString());
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
        SystemProgram.transfer({ fromPubkey: ephemeralKp.publicKey, toPubkey: owner.publicKey, lamports: ephBal - 5000 })
      );
      await sendWithEphemeralPayer(provider, returnTx, [ephemeralKp]);
    }
  } catch (err: any) {
    console.log("Could not return ephemeral SOL:", err.message?.substring(0, 80));
  }

  await program.methods
    .closeEphemeralWallet()
    .accounts({ authority: owner.publicKey, vault: vaultPda, ephemeralWallet: ephemeralPda })
    .signers([owner])
    .rpc({ commitment: "confirmed" });
}

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
      if (decoded) events.push(decoded);
    } catch {}
  }
  return events;
}

function readKpJson(filePath: string): Keypair {
  const file = fs.readFileSync(filePath);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}

function maxKey(a: PublicKey, b: PublicKey): PublicKey {
  return a.toBuffer().compare(b.toBuffer()) > 0 ? a : b;
}
function minKey(a: PublicKey, b: PublicKey): PublicKey {
  return a.toBuffer().compare(b.toBuffer()) <= 0 ? a : b;
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

async function fundKeypair(provider: anchor.AnchorProvider, target: PublicKey, lamports: number) {
  const providerWallet = (provider.wallet as any).payer as Keypair;
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: providerWallet.publicKey, toPubkey: target, lamports })
  );
  const sig = await provider.connection.sendTransaction(tx, [providerWallet]);
  const bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, signature: sig });
}

// ============================================================
// MIXER TRANSACTION HELPERS
// ============================================================

async function executeTransactSol(
  program: anchor.Program<any>,
  provider: anchor.AnchorProvider,
  proofToSubmit: any,
  extData: any,
  accounts: {
    treeAccountPDA: PublicKey;
    treeTokenAccountPDA: PublicKey;
    globalConfigPDA: PublicKey;
    recipient: PublicKey;
    feeRecipient: PublicKey;
  },
  signer: Keypair,
  altAddress: PublicKey,
) {
  const nullifiers = findNullifierPDAs(program, proofToSubmit);
  const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

  const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  const tx = await (program.methods
    .transact(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2) as any)
    .accounts({
      treeAccount: accounts.treeAccountPDA,
      nullifier0: nullifiers.nullifier0PDA,
      nullifier1: nullifiers.nullifier1PDA,
      nullifier2: crossCheckNullifiers.nullifier2PDA,
      nullifier3: crossCheckNullifiers.nullifier3PDA,
      recipient: accounts.recipient,
      feeRecipientAccount: accounts.feeRecipient,
      treeTokenAccount: accounts.treeTokenAccountPDA,
      globalConfig: accounts.globalConfigPDA,
      signer: signer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([signer])
    .preInstructions([modifyComputeUnits])
    .transaction();

  const versionedTx = await createVersionedTransactionWithALT(provider.connection, signer.publicKey, tx.instructions, altAddress);
  return await sendAndConfirmVersionedTransaction(provider.connection, versionedTx, [signer]);
}

async function executeTransactSpl(
  program: anchor.Program<any>,
  provider: anchor.AnchorProvider,
  proofToSubmit: any,
  extData: any,
  accounts: {
    splTreeAccountPDA: PublicKey;
    globalConfigPDA: PublicKey;
    splMint: PublicKey;
    signerAta: PublicKey;
    recipientWallet: PublicKey;
    recipientAta: PublicKey;
    treeAta: PublicKey;
    feeRecipientAta: PublicKey;
  },
  signer: Keypair,
  altAddress: PublicKey,
) {
  const nullifiers = findNullifierPDAs(program, proofToSubmit);
  const crossCheckNullifiers = findCrossCheckNullifierPDAs(program, proofToSubmit);

  const modifyComputeUnits = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });

  const tx = await (program.methods
    .transactSpl(proofToSubmit, createExtDataMinified(extData), extData.encryptedOutput1, extData.encryptedOutput2) as any)
    .accounts({
      treeAccount: accounts.splTreeAccountPDA,
      nullifier0: nullifiers.nullifier0PDA,
      nullifier1: nullifiers.nullifier1PDA,
      nullifier2: crossCheckNullifiers.nullifier2PDA,
      nullifier3: crossCheckNullifiers.nullifier3PDA,
      globalConfig: accounts.globalConfigPDA,
      signer: signer.publicKey,
      mint: accounts.splMint,
      signerTokenAccount: accounts.signerAta,
      recipient: accounts.recipientWallet,
      recipientTokenAccount: accounts.recipientAta,
      treeAta: accounts.treeAta,
      feeRecipientAta: accounts.feeRecipientAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([signer])
    .preInstructions([modifyComputeUnits])
    .transaction();

  const versionedTx = await createVersionedTransactionWithALT(provider.connection, signer.publicKey, tx.instructions, altAddress);
  return await sendAndConfirmVersionedTransaction(provider.connection, versionedTx, [signer]);
}

// ============================================================
// FULL PRIVACY INTEGRATION TEST
// ============================================================

describe("Full Privacy Integration: Mixer -> Zodiac -> Meteora", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const zodiacProgram = anchor.workspace.ZodiacLiquidity as Program<ZodiacLiquidity>;
  const mixerProgram = anchor.workspace.ZodiacMixer as Program<ZodiacMixer>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  // Patch provider.sendAndConfirm for blockhash retry
  if (!(provider.sendAndConfirm as any).__blockhashRetryPatched) {
    const _origSendAndConfirm = provider.sendAndConfirm.bind(provider);
    const patchedFn = async function(tx: any, signers?: any, opts?: any) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try { return await _origSendAndConfirm(tx, signers, opts); } catch (err: any) {
          const msg = err.message || err.toString();
          if ((msg.includes("Blockhash not found") || msg.includes("403")) && attempt < 4) {
            console.log(`  RPC error (${msg.includes("403") ? "403" : "blockhash"}), retrying (${attempt + 1}/5)...`);
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

  let lightWasm: LightWasm;
  const clusterAccount = getClusterAccount();

  // Authority / owner
  let owner: Keypair;
  let relayer: Keypair;

  // Token mints
  let baseMint: PublicKey; // SPL token (base)
  let quoteMint: PublicKey; // WSOL

  // Zodiac state
  let vaultPda: PublicKey;
  let mxePublicKey: Uint8Array;
  let signPdaAccount: PublicKey;
  let vaultTokenAccount: PublicKey;
  let vaultQuoteTokenAccount: PublicKey;

  // Relay
  const RELAY_INDEX = 9; // Avoid collision with other test files
  let relayPda: PublicKey;
  let tokenA: PublicKey;
  let tokenB: PublicKey;
  let relayTokenA: PublicKey;
  let relayTokenB: PublicKey;
  let isTokenANative: boolean;
  let relaySplAccount: PublicKey;
  let relayWsolAccount: PublicKey;

  // Meteora
  let poolPda: PublicKey;
  let positionPda: PublicKey;
  let posNftMint: Keypair;
  let posNftAccount: PublicKey;
  let tokenAVault: PublicKey;
  let tokenBVault: PublicKey;
  let eventAuthority: PublicKey;

  // Cumulative tracking
  let cumulativeMeteoraLiquidity = new anchor.BN(0);
  let cumulativeBaseDeposited = 0;
  let cumulativeQuoteDeposited = 0;

  // Mixer state
  let solTreeAccountPDA: PublicKey;
  let solTreeTokenAccountPDA: PublicKey;
  let globalConfigPDA: PublicKey;
  let splTreeAccountPDA: PublicKey;
  let splTreeAta: PublicKey;
  let solSyncTree: SubtreesMerkleTree;
  let splSyncTree: SubtreesMerkleTree;
  let solAltAddress: PublicKey;
  let splAltAddress: PublicKey;
  let feeRecipient: Keypair;
  let feeRecipientAta: PublicKey;

  // User contexts
  interface PrivacyUserContext {
    name: string;
    realWallet: Keypair;
    intermediateWallet: Keypair;
    // Zodiac encryption
    encryptionKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
    cipher: RescueCipher;
    positionPda: PublicKey;
    // Amounts (after mixer fee)
    baseDepositAmount: number;
    quoteDepositAmount: number;
    // Mixer UTXOs
    solDepositOutputs?: Utxo[];
    splDepositOutputs?: Utxo[];
    // Withdrawal amounts
    decryptedBaseWithdraw?: number;
    decryptedQuoteWithdraw?: number;
  }

  let users: PrivacyUserContext[] = [];
  const fundedKeypairs: Keypair[] = [];

  before(async () => {
    logSeparator("SETUP: Full Privacy Integration Test");
    lightWasm = await WasmFactory.getInstance();

    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    logKeyValue("Owner", owner.publicKey.toString());
    logKeyValue("Zodiac Program", zodiacProgram.programId.toString());
    logKeyValue("Mixer Program", mixerProgram.programId.toString());

    signPdaAccount = PublicKey.findProgramAddressSync(
      [Buffer.from("ArciumSignerAccount")], zodiacProgram.programId
    )[0];

    // Create and fund relayer
    relayer = Keypair.generate();
    fundedKeypairs.push(relayer);
    await fundKeypair(provider, relayer.publicKey, 5 * LAMPORTS_PER_SOL);
    logKeyValue("Relayer", relayer.publicKey.toString());

    // Fee recipient for mixer
    feeRecipient = Keypair.generate();
    fundedKeypairs.push(feeRecipient);
    await fundKeypair(provider, feeRecipient.publicKey, 0.01 * LAMPORTS_PER_SOL);

    // Create base token mint
    baseMint = await createMint(provider.connection, owner, owner.publicKey, null, 9);
    quoteMint = NATIVE_MINT;
    logKeyValue("Base mint", baseMint.toString());

    // Derive vault PDA
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), baseMint.toBuffer()], zodiacProgram.programId
    );
    relayPda = deriveRelayPda(vaultPda, RELAY_INDEX, zodiacProgram.programId);
    logKeyValue("Vault PDA", vaultPda.toString());
    logKeyValue("Relay PDA", relayPda.toString());

    // Get MXE public key
    try {
      mxePublicKey = await getMXEPublicKeyWithRetry(provider, zodiacProgram.programId);
      logHex("MXE pubkey", mxePublicKey);
    } catch (e) {
      console.log("  MXE key not available yet, will refresh after comp defs");
    }

    // === Initialize Mixer ===
    logSeparator("MIXER INITIALIZATION");

    // SOL tree PDAs
    [solTreeAccountPDA] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], mixerProgram.programId);
    [solTreeTokenAccountPDA] = PublicKey.findProgramAddressSync([Buffer.from("tree_token")], mixerProgram.programId);
    [globalConfigPDA] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], mixerProgram.programId);

    // Initialize SOL mixer tree (skip if already exists)
    const existingSolTree = await provider.connection.getAccountInfo(solTreeAccountPDA);
    if (!existingSolTree) {
      await (mixerProgram.methods.initialize() as any)
        .accounts({
          treeAccount: solTreeAccountPDA,
          treeTokenAccount: solTreeTokenAccountPDA,
          globalConfig: globalConfigPDA,
          authority: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      console.log("  SOL mixer tree initialized");

      // Fund SOL tree with liquidity for withdrawals
      const fundTreeTx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: solTreeTokenAccountPDA, lamports: 0.1 * LAMPORTS_PER_SOL })
      );
      await provider.sendAndConfirm(fundTreeTx, [owner]);
    } else {
      console.log("  SOL mixer tree already exists");
    }

    // SPL tree
    [splTreeAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("merkle_tree"), baseMint.toBuffer()], mixerProgram.programId
    );

    // Tree ATA owned by globalConfig PDA
    splTreeAta = getAssociatedTokenAddressSync(baseMint, globalConfigPDA, true);
    const treeAtaInfo = await provider.connection.getAccountInfo(splTreeAta);
    if (!treeAtaInfo) {
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey, splTreeAta, globalConfigPDA, baseMint,
      );
      const createAtaTx = new Transaction().add(createAtaIx);
      await provider.sendAndConfirm(createAtaTx, [owner]);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Initialize SPL tree
    const existingSplTree = await provider.connection.getAccountInfo(splTreeAccountPDA);
    if (!existingSplTree) {
      await (mixerProgram.methods.initializeTreeAccountForSplToken(new anchor.BN(SPL_MAX_DEPOSIT)) as any)
        .accounts({
          treeAccount: splTreeAccountPDA,
          mint: baseMint,
          globalConfig: globalConfigPDA,
          authority: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      console.log("  SPL mixer tree initialized for baseMint");
    }

    // Fund tree ATA with SPL tokens for withdrawal liquidity
    await mintTo(provider.connection, owner, baseMint, splTreeAta, owner, 50_000_000);
    console.log("  Funded SPL tree ATA with 50M tokens");

    // Fee recipient ATA
    feeRecipientAta = await createAssociatedTokenAccountIdempotent(
      provider.connection, owner, baseMint, feeRecipient.publicKey,
    );

    // Relayer SPL ATA (needed for mixer SPL withdrawals — signer_token_account must exist)
    await createAssociatedTokenAccountIdempotent(provider.connection, owner, baseMint, relayer.publicKey);

    // Ensure mixer is not paused and has default config
    const currentConfig = await mixerProgram.account.globalConfig.fetch(globalConfigPDA);
    if (currentConfig.paused) {
      await mixerProgram.methods.togglePause()
        .accounts({ globalConfig: globalConfigPDA, authority: owner.publicKey })
        .signers([owner]).rpc();
    }
    if (currentConfig.withdrawalFeeRate !== 25 || currentConfig.depositFeeRate !== 0) {
      await mixerProgram.methods.updateGlobalConfig(0, 25, 500)
        .accounts({ globalConfig: globalConfigPDA, authority: owner.publicKey })
        .signers([owner]).rpc();
    }
    await mixerProgram.methods.updateDepositLimit(new anchor.BN(SPL_MAX_DEPOSIT))
      .accounts({ treeAccount: solTreeAccountPDA, authority: owner.publicKey })
      .signers([owner]).rpc();

    // Sync SOL tree
    const onChainSolTree = await mixerProgram.account.merkleTreeAccount.fetch(solTreeAccountPDA);
    solSyncTree = new SubtreesMerkleTree(
      onChainSolTree.subtrees as number[][],
      onChainSolTree.root as number[],
      (onChainSolTree.nextIndex as any).toNumber(),
      DEFAULT_HEIGHT,
      lightWasm,
    );
    console.log(`  SOL tree synced: nextIndex=${solSyncTree.nextIndex}`);

    // Sync SPL tree
    const onChainSplTree = await mixerProgram.account.merkleTreeAccount.fetch(splTreeAccountPDA);
    splSyncTree = new SubtreesMerkleTree(
      onChainSplTree.subtrees as number[][],
      onChainSplTree.root as number[],
      (onChainSplTree.nextIndex as any).toNumber(),
      DEFAULT_HEIGHT,
      lightWasm,
    );
    console.log(`  SPL tree synced: nextIndex=${splSyncTree.nextIndex}`);

    // Create SOL ALT
    const solProtocolAddresses = getTestProtocolAddresses(
      mixerProgram.programId, owner.publicKey, feeRecipient.publicKey,
    );
    solAltAddress = await createGlobalTestALT(provider.connection, owner, solProtocolAddresses);
    console.log("  SOL ALT created:", solAltAddress.toString());

    // Create SPL ALT
    resetGlobalTestALT();
    const splProtocolAddresses = getTestProtocolAddressesWithMint(
      mixerProgram.programId, owner.publicKey,
      splTreeAta, feeRecipient.publicKey, feeRecipientAta,
      splTreeAccountPDA, baseMint,
    );
    splAltAddress = await createGlobalTestALT(provider.connection, owner, splProtocolAddresses);
    console.log("  SPL ALT created:", splAltAddress.toString());
    resetGlobalTestALT();

    // === Create 2 user contexts ===
    logSeparator("USER CONTEXT CREATION");
    const userConfigs = [
      { name: "User1", splDeposit: MIXER_SPL_DEPOSIT, solDeposit: MIXER_SOL_DEPOSIT },
      { name: "User2", splDeposit: MIXER_SPL_DEPOSIT, solDeposit: MIXER_SOL_DEPOSIT },
    ];

    for (const cfg of userConfigs) {
      const realWallet = Keypair.generate();
      const intermediateWallet = Keypair.generate();
      fundedKeypairs.push(realWallet, intermediateWallet);

      // Fund realWallet with SOL (for mixer deposits + tx fees)
      await fundKeypair(provider, realWallet.publicKey, 0.5 * LAMPORTS_PER_SOL);

      // Fund intermediateWallet with SOL for tx fees
      await fundKeypair(provider, intermediateWallet.publicKey, 0.2 * LAMPORTS_PER_SOL);

      // Mint SPL tokens to realWallet for mixer deposit
      const realWalletAta = await createAssociatedTokenAccountIdempotent(
        provider.connection, owner, baseMint, realWallet.publicKey,
      );
      await mintTo(provider.connection, owner, baseMint, realWalletAta, owner, cfg.splDeposit * 2);

      // Create intermediateWallet ATAs
      await createAssociatedTokenAccountIdempotent(provider.connection, owner, baseMint, intermediateWallet.publicKey);
      await createAssociatedTokenAccountIdempotent(provider.connection, owner, NATIVE_MINT, intermediateWallet.publicKey);

      // Encryption keys (derived from intermediateWallet since that's the zodiac depositor)
      const encKeys = deriveEncryptionKey(intermediateWallet, ENCRYPTION_KEY_MESSAGE);
      let cipher: RescueCipher = null as any;
      if (mxePublicKey) {
        const sharedSecret = x25519.getSharedSecret(encKeys.privateKey, mxePublicKey);
        cipher = new RescueCipher(sharedSecret);
      }

      const [positionPdaAddr] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), vaultPda.toBuffer(), intermediateWallet.publicKey.toBuffer()],
        zodiacProgram.programId
      );

      // Fee-adjusted amounts (withdrawal fee deducted by mixer)
      const splAfterFee = cfg.splDeposit - calculateWithdrawalFee(cfg.splDeposit);
      const solAfterFee = cfg.solDeposit - calculateWithdrawalFee(cfg.solDeposit);

      users.push({
        name: cfg.name,
        realWallet,
        intermediateWallet,
        encryptionKeys: encKeys,
        cipher,
        positionPda: positionPdaAddr,
        baseDepositAmount: splAfterFee,
        quoteDepositAmount: solAfterFee,
      });

      logKeyValue(`${cfg.name} realWallet`, realWallet.publicKey.toString());
      logKeyValue(`${cfg.name} intermediateWallet`, intermediateWallet.publicKey.toString());
      logKeyValue(`${cfg.name} base after fee`, splAfterFee);
      logKeyValue(`${cfg.name} quote after fee`, solAfterFee);
    }
  });

  // ============================================================
  // Phase A: Comp Def Initialization (8 tests)
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
        const sig = await initCompDef(zodiacProgram, owner, name, method);
        console.log(`${name} comp def: ${sig}`);
      });
    }
  });

  // ============================================================
  // Phase B: Setup — Vault + Mixer Trees + Pool (3 tests)
  // ============================================================
  describe("Phase B: Setup", () => {
    it("creates vault (MPC)", async () => {
      logSeparator("MPC OPERATION: createVault");

      if (!mxePublicKey || !users[0]?.cipher) {
        console.log("  MXE key not set yet, waiting for keygen...");
        mxePublicKey = await getMXEPublicKeyWithRetry(provider, zodiacProgram.programId, 120, 2000);
        logHex("  MXE pubkey (refreshed)", mxePublicKey);
      } else {
        try {
          const freshKey = await getMXEPublicKeyWithRetry(provider, zodiacProgram.programId, 5, 1000);
          if (Buffer.from(freshKey).toString("hex") !== Buffer.from(mxePublicKey).toString("hex")) {
            mxePublicKey = freshKey;
          }
        } catch (e) { /* keep cached */ }
      }

      // Initialize ciphers for all users
      for (const u of users) {
        const sharedSecret = x25519.getSharedSecret(u.encryptionKeys.privateKey, mxePublicKey);
        u.cipher = new RescueCipher(sharedSecret);
      }

      const nonce = randomBytes(16);
      const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

      await queueWithRetry(
        "createVault",
        async (computationOffset) => {
          const compAccAddr = getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset);
          return zodiacProgram.methods
            .createVault(computationOffset, nonceBN)
            .accountsPartial({
              authority: owner.publicKey,
              vault: vaultPda,
              tokenMint: baseMint,
              quoteMint: quoteMint,
              signPdaAccount,
              computationAccount: compAccAddr,
              clusterAccount,
              mxeAccount: getMXEAccAddress(zodiacProgram.programId),
              mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
              executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
              compDefAccount: getCompDefAccAddress(zodiacProgram.programId, Buffer.from(getCompDefAccOffset("init_vault")).readUInt32LE()),
              poolAccount: getFeePoolAccAddress(),
              clockAccount: getClockAccAddress(),
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc({ skipPreflight: true, commitment: "confirmed" });
        },
        provider,
        zodiacProgram.programId,
      );

      const vaultAccount = await zodiacProgram.account.vaultAccount.fetch(vaultPda);
      expect(vaultAccount.authority.toString()).to.equal(owner.publicKey.toString());
      console.log("  Vault created");

      // Create vault token accounts
      const vaultBaseAcct = await getOrCreateAssociatedTokenAccount(provider.connection, owner, baseMint, vaultPda, true);
      vaultTokenAccount = vaultBaseAcct.address;
      const vaultQuoteAcct = await getOrCreateAssociatedTokenAccount(provider.connection, owner, NATIVE_MINT, vaultPda, true);
      vaultQuoteTokenAccount = vaultQuoteAcct.address;
    });

    it("verifies mixer trees are initialized (SOL + SPL)", async () => {
      const solTree = await mixerProgram.account.merkleTreeAccount.fetch(solTreeAccountPDA);
      expect(solTree.authority.equals(owner.publicKey)).to.be.true;
      expect(solTree.height).to.equal(DEFAULT_HEIGHT);

      const splTree = await mixerProgram.account.merkleTreeAccount.fetch(splTreeAccountPDA);
      expect(splTree.height).to.equal(DEFAULT_HEIGHT);

      console.log("  SOL tree nextIndex:", solTree.nextIndex.toString());
      console.log("  SPL tree nextIndex:", splTree.nextIndex.toString());
    });

    it("creates pool and position via relay", async () => {
      logSeparator("METEORA: Create Pool + Position via Relay");

      // Fund relay PDA
      const fundRelayTx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: relayPda, lamports: 1_000_000_000 })
      );
      await provider.sendAndConfirm(fundRelayTx, [relayer]);

      // Sort tokens
      tokenA = minKey(baseMint, NATIVE_MINT);
      tokenB = maxKey(baseMint, NATIVE_MINT);
      isTokenANative = tokenA.equals(NATIVE_MINT);

      // Create relay token accounts
      const relayTokenAKp = Keypair.generate();
      relayTokenA = await createAccount(provider.connection, owner, tokenA, relayPda, relayTokenAKp);
      const relayTokenBKp = Keypair.generate();
      relayTokenB = await createAccount(provider.connection, owner, tokenB, relayPda, relayTokenBKp);
      relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;
      relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;

      // Fund relay with initial liquidity for pool creation
      const INITIAL_LIQ = 1_000_000;
      const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(provider.connection, owner, baseMint, owner.publicKey);
      await mintTo(provider.connection, owner, baseMint, authorityTokenAccount.address, owner, INITIAL_LIQ);
      await new Promise(r => setTimeout(r, 2000));

      await zodiacProgram.methods
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
        SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: relayWsolAccount, lamports: INITIAL_LIQ }),
        createSyncNativeInstruction(relayWsolAccount),
      );
      await provider.sendAndConfirm(fundWsolTx, [relayer]);

      // Derive Meteora PDAs
      [poolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("cpool"), maxKey(tokenA, tokenB).toBuffer(), minKey(tokenA, tokenB).toBuffer()], DAMM_V2_PROGRAM_ID
      );
      [tokenAVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tokenA.toBuffer(), poolPda.toBuffer()], DAMM_V2_PROGRAM_ID
      );
      [tokenBVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tokenB.toBuffer(), poolPda.toBuffer()], DAMM_V2_PROGRAM_ID
      );
      [eventAuthority] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], DAMM_V2_PROGRAM_ID);

      // Create pool via ephemeral wallet
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

      const poolEph = await setupEphemeralWallet(zodiacProgram, provider, owner, vaultPda);
      const poolTx = await zodiacProgram.methods
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
      console.log("  Pool created:", poolPda.toString());
      await teardownEphemeralWallet(zodiacProgram, provider, owner, vaultPda, poolEph.ephemeralKp, poolEph.ephemeralPda);

      await new Promise(r => setTimeout(r, 10000));

      // Create position via ephemeral wallet
      posNftMint = Keypair.generate();
      [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), posNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
      );
      [posNftAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("position_nft_account"), posNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
      );

      const [relayPositionTracker] = PublicKey.findProgramAddressSync(
        [Buffer.from("relay_position"), vaultPda.toBuffer(), Buffer.from([RELAY_INDEX]), poolPda.toBuffer()],
        zodiacProgram.programId
      );

      const posEph = await setupEphemeralWallet(zodiacProgram, provider, owner, vaultPda);
      const posTx = await zodiacProgram.methods
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
      console.log("  Position created:", positionPda.toString());
      await teardownEphemeralWallet(zodiacProgram, provider, owner, vaultPda, posEph.ephemeralKp, posEph.ephemeralPda);
    });
  });

  // ============================================================
  // MPC HELPERS (scoped to describe)
  // ============================================================

  async function createUserPosition(u: PrivacyUserContext): Promise<void> {
    const nonce = randomBytes(16);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());

    await queueWithRetry(
      `createUserPosition(${u.name})`,
      async (computationOffset) => {
        return zodiacProgram.methods
          .createUserPosition(computationOffset, nonceBN)
          .accountsPartial({
            user: u.intermediateWallet.publicKey,
            vault: vaultPda,
            userPosition: u.positionPda,
            signPdaAccount,
            computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(zodiacProgram.programId),
            mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
            executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
            compDefAccount: getCompDefAccAddress(zodiacProgram.programId, Buffer.from(getCompDefAccOffset("init_user_position")).readUInt32LE()),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
          })
          .signers([u.intermediateWallet])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      },
      provider,
      zodiacProgram.programId,
    );

    const posAccount = await zodiacProgram.account.userPositionAccount.fetch(u.positionPda);
    expect(posAccount.owner.toString()).to.equal(u.intermediateWallet.publicKey.toString());
    console.log(`  ${u.name} position created`);
  }

  async function depositUserMPC(u: PrivacyUserContext): Promise<void> {
    logSeparator(`MPC: deposit for ${u.name} (${u.baseDepositAmount} base + ${u.quoteDepositAmount} quote)`);
    await new Promise(r => setTimeout(r, 3000));

    const baseDepositAmount = BigInt(u.baseDepositAmount);
    const quoteDepositAmount = BigInt(u.quoteDepositAmount);
    const nonce = randomBytes(16);
    const nonceBN = new anchor.BN(deserializeLE(nonce).toString());
    const ciphertext = u.cipher.encrypt([baseDepositAmount, quoteDepositAmount], nonce);

    // intermediateWallet already has the SPL tokens (from mixer withdrawal)
    const userTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection, owner, baseMint, u.intermediateWallet.publicKey
    );
    const userQuoteTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection, owner, NATIVE_MINT, u.intermediateWallet.publicKey
    );

    await queueWithRetry(
      `deposit(${u.name})`,
      async (computationOffset) => {
        return zodiacProgram.methods
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
            depositor: u.intermediateWallet.publicKey,
            vault: vaultPda,
            userPosition: u.positionPda,
            userTokenAccount: userTokenAccount.address,
            vaultTokenAccount: vaultTokenAccount,
            userQuoteTokenAccount: userQuoteTokenAccount.address,
            vaultQuoteTokenAccount: vaultQuoteTokenAccount,
            tokenMint: baseMint,
            quoteMint: quoteMint,
            signPdaAccount,
            computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(zodiacProgram.programId),
            mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
            executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
            compDefAccount: getCompDefAccAddress(zodiacProgram.programId, Buffer.from(getCompDefAccOffset("deposit")).readUInt32LE()),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([u.intermediateWallet])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      },
      provider,
      zodiacProgram.programId,
    );
    console.log(`  ${u.name} deposited ${u.baseDepositAmount} base + ${u.quoteDepositAmount} quote to Zodiac`);
  }

  async function revealPending(): Promise<{ base: number; quote: number }> {
    const finalizeSig = await queueWithRetry(
      "revealPendingDeposits",
      async (computationOffset) => {
        return zodiacProgram.methods
          .revealPendingDeposits(computationOffset)
          .accountsPartial({
            authority: owner.publicKey, vault: vaultPda, signPdaAccount,
            computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(zodiacProgram.programId),
            mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
            executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
            compDefAccount: getCompDefAccAddress(zodiacProgram.programId, Buffer.from(getCompDefAccOffset("reveal_pending_deposits")).readUInt32LE()),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
          })
          .signers([owner])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      },
      provider, zodiacProgram.programId,
    );

    const revealTx = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
    }));
    const events = parseEventsFromTx(zodiacProgram, revealTx);
    const revealEvent = events.find(e => e.name === "PendingDepositsRevealedEvent" || e.name === "pendingDepositsRevealedEvent");
    if (revealEvent) {
      return {
        base: Number(revealEvent.data.totalPendingBase.toString()),
        quote: Number(revealEvent.data.totalPendingQuote.toString()),
      };
    }
    throw new Error("PendingDepositsRevealedEvent not found");
  }

  async function fundRelayWithAmounts(baseAmount: number, quoteAmount: number): Promise<void> {
    const splMint = isTokenANative ? tokenB : tokenA;
    const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(provider.connection, owner, splMint, owner.publicKey);
    await mintTo(provider.connection, owner, splMint, authorityTokenAccount.address, owner, baseAmount);
    await new Promise(r => setTimeout(r, 2000));

    await zodiacProgram.methods
      .fundRelay(RELAY_INDEX, new anchor.BN(baseAmount))
      .accounts({
        authority: owner.publicKey, vault: vaultPda, relayPda,
        authorityTokenAccount: authorityTokenAccount.address,
        relayTokenAccount: relaySplAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    const fundWsolTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: relayWsolAccount, lamports: quoteAmount }),
      createSyncNativeInstruction(relayWsolAccount),
    );
    await provider.sendAndConfirm(fundWsolTx, [relayer]);
    console.log(`  Relay funded: ${baseAmount} SPL + ${quoteAmount} WSOL`);
  }

  async function depositToMeteora(): Promise<{ u64Delta: anchor.BN; meteoraDelta: anchor.BN }> {
    await new Promise(r => setTimeout(r, 3000));
    const depEph = await setupEphemeralWallet(zodiacProgram, provider, owner, vaultPda);

    try {
      const splBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      const wsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
      const depositTokenAmount = Math.min(Number(splBal.amount), Number(wsolBal.amount));

      const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);
      const liquidityDelta = calculateLiquidityFromAmounts(
        provider.connection,
        new anchor.BN(depositTokenAmount), new anchor.BN(depositTokenAmount), sqrtPrice,
      );

      const depTx = await zodiacProgram.methods
        .depositToMeteoraDammV2(RELAY_INDEX, liquidityDelta, new anchor.BN("18446744073709551615"), new anchor.BN("18446744073709551615"), null)
        .accounts({
          payer: depEph.ephemeralKp.publicKey, vault: vaultPda, ephemeralWallet: depEph.ephemeralPda, relayPda,
          pool: poolPda, position: positionPda,
          relayTokenA, relayTokenB, tokenAVault, tokenBVault,
          tokenAMint: tokenA, tokenBMint: tokenB,
          positionNftAccount: posNftAccount,
          tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId, eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
        })
        .transaction();
      await sendWithEphemeralPayer(provider, depTx, [depEph.ephemeralKp]);

      const positionInfo = await withRetry(() => provider.connection.getAccountInfo(positionPda));
      const currentUnlockedLiquidity = new anchor.BN(positionInfo!.data.slice(152, 168), "le");
      const actualDelta = currentUnlockedLiquidity.sub(cumulativeMeteoraLiquidity);
      const U64_MAX = new anchor.BN("18446744073709551615");
      const deltaAsU64 = actualDelta.gt(U64_MAX) ? U64_MAX : actualDelta;

      return { u64Delta: deltaAsU64, meteoraDelta: actualDelta };
    } finally {
      await teardownEphemeralWallet(zodiacProgram, provider, owner, vaultPda, depEph.ephemeralKp, depEph.ephemeralPda);
    }
  }

  async function recordLiquidity(liquidityDelta: anchor.BN): Promise<void> {
    await queueWithRetry(
      "recordLiquidity",
      async (computationOffset) => {
        return zodiacProgram.methods
          .recordLiquidity(computationOffset, liquidityDelta)
          .accountsPartial({
            authority: owner.publicKey, vault: vaultPda, signPdaAccount,
            computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(zodiacProgram.programId),
            mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
            executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
            compDefAccount: getCompDefAccAddress(zodiacProgram.programId, Buffer.from(getCompDefAccOffset("record_liquidity")).readUInt32LE()),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      },
      provider, zodiacProgram.programId,
    );
  }

  async function computeWithdrawal(u: PrivacyUserContext): Promise<{ base: number; quote: number }> {
    const sharedNonce = randomBytes(16);
    const sharedNonceBN = new anchor.BN(deserializeLE(sharedNonce).toString());

    const finalizeSig = await queueWithRetry(
      `computeWithdrawal(${u.name})`,
      async (computationOffset) => {
        return zodiacProgram.methods
          .withdraw(computationOffset, Array.from(u.encryptionKeys.publicKey) as number[], sharedNonceBN)
          .accountsPartial({
            user: u.intermediateWallet.publicKey, signPdaAccount,
            mxeAccount: getMXEAccAddress(zodiacProgram.programId),
            mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
            executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
            computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
            compDefAccount: getCompDefAccAddress(zodiacProgram.programId, Buffer.from(getCompDefAccOffset("compute_withdrawal")).readUInt32LE()),
            clusterAccount,
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
            vault: vaultPda,
            userPosition: u.positionPda,
          })
          .signers([u.intermediateWallet])
          .rpc({ commitment: "confirmed" });
      },
      provider, zodiacProgram.programId,
    );

    const withdrawTx = await withRetry(() => provider.connection.getTransaction(finalizeSig, {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
    }));
    const events = parseEventsFromTx(zodiacProgram, withdrawTx);
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
      const decrypted = decryptCipher.decrypt([encryptedBaseArr, encryptedQuoteArr], new Uint8Array(nonceBuf));
      return { base: Number(decrypted[0]), quote: Number(decrypted[1]) };
    }
    throw new Error(`WithdrawEvent not found for ${u.name}`);
  }

  async function clearPosition(u: PrivacyUserContext, baseAmount: number, quoteAmount: number): Promise<void> {
    await queueWithRetry(
      `clearPosition(${u.name})`,
      async (computationOffset) => {
        return zodiacProgram.methods
          .clearPosition(computationOffset, new anchor.BN(baseAmount), new anchor.BN(quoteAmount))
          .accountsPartial({
            authority: owner.publicKey, vault: vaultPda,
            userPosition: u.positionPda, signPdaAccount,
            computationAccount: getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
            clusterAccount,
            mxeAccount: getMXEAccAddress(zodiacProgram.programId),
            mempoolAccount: getMempoolAccAddress(getArciumEnv().arciumClusterOffset),
            executingPool: getExecutingPoolAccAddress(getArciumEnv().arciumClusterOffset),
            compDefAccount: getCompDefAccAddress(zodiacProgram.programId, Buffer.from(getCompDefAccOffset("clear_position")).readUInt32LE()),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      },
      provider, zodiacProgram.programId,
    );
    console.log(`  ${u.name} position cleared (base=${baseAmount}, quote=${quoteAmount})`);
  }

  // ============================================================
  // MIXER DEPOSIT + WITHDRAWAL HELPERS
  // ============================================================

  async function mixerDepositSol(
    user: Keypair,
    amount: number,
    tree: SubtreesMerkleTree,
    altAddr: PublicKey,
  ): Promise<{ outputs: Utxo[]; outputCommitments: string[] }> {
    const depositFee = new anchor.BN(calculateDepositFee(amount));
    const extData = {
      recipient: user.publicKey, // Doesn't matter for deposits
      extAmount: new anchor.BN(amount),
      encryptedOutput1: Buffer.from("enc_fp_sol_dep_1"),
      encryptedOutput2: Buffer.from("enc_fp_sol_dep_2"),
      fee: depositFee,
      feeRecipient: feeRecipient.publicKey,
      mintAddress: SOL_MINT,
    };

    const inputs = [new Utxo({ lightWasm }), new Utxo({ lightWasm })];
    const publicAmount = new BN(amount).sub(depositFee).add(FIELD_SIZE).mod(FIELD_SIZE);
    const outputs = [
      new Utxo({ lightWasm, amount: publicAmount.toString(), index: tree.nextIndex }),
      new Utxo({ lightWasm, amount: "0" }),
    ];

    const { proofToSubmit, outputCommitments } = await generateProofAndFormat(inputs, outputs, tree, extData, lightWasm, keyBasePath);

    await executeTransactSol(
      mixerProgram, provider, proofToSubmit, extData,
      { treeAccountPDA: solTreeAccountPDA, treeTokenAccountPDA: solTreeTokenAccountPDA, globalConfigPDA, recipient: user.publicKey, feeRecipient: feeRecipient.publicKey },
      user, altAddr,
    );

    tree.insertPair(outputCommitments[0], outputCommitments[1]);
    return { outputs, outputCommitments };
  }

  async function mixerWithdrawSol(
    depositOutputs: Utxo[],
    recipientPubkey: PublicKey,
    tree: SubtreesMerkleTree,
    altAddr: PublicKey,
    signer: Keypair,
  ): Promise<{ withdrawnAmount: number }> {
    const withdrawInputs = [depositOutputs[0], new Utxo({ lightWasm })];
    const withdrawOutputs = [new Utxo({ lightWasm, amount: "0" }), new Utxo({ lightWasm, amount: "0" })];

    const inputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const withdrawFee = new anchor.BN(calculateWithdrawalFee(inputsSum.toNumber()));
    const extAmount = withdrawFee.add(new BN(0)).sub(inputsSum);

    const extData = {
      recipient: recipientPubkey,
      extAmount,
      encryptedOutput1: Buffer.from("enc_fp_sol_wd_1"),
      encryptedOutput2: Buffer.from("enc_fp_sol_wd_2"),
      fee: withdrawFee,
      feeRecipient: feeRecipient.publicKey,
      mintAddress: SOL_MINT,
    };

    const { proofToSubmit, outputCommitments } = await generateProofAndFormat(
      withdrawInputs, withdrawOutputs, tree, extData, lightWasm, keyBasePath,
    );

    await executeTransactSol(
      mixerProgram, provider, proofToSubmit, extData,
      { treeAccountPDA: solTreeAccountPDA, treeTokenAccountPDA: solTreeTokenAccountPDA, globalConfigPDA, recipient: recipientPubkey, feeRecipient: feeRecipient.publicKey },
      signer, altAddr,
    );

    tree.insertPair(outputCommitments[0], outputCommitments[1]);
    return { withdrawnAmount: inputsSum.sub(withdrawFee).toNumber() };
  }

  async function mixerDepositSpl(
    user: Keypair,
    amount: number,
    tree: SubtreesMerkleTree,
    altAddr: PublicKey,
    mint: PublicKey,
  ): Promise<{ outputs: Utxo[]; outputCommitments: string[] }> {
    const mintStr = mint.toBase58();
    const depositFee = new anchor.BN(calculateDepositFee(amount));

    const signerAta = getAssociatedTokenAddressSync(mint, user.publicKey);
    const recipientAta = getAssociatedTokenAddressSync(mint, user.publicKey); // self-reference for deposit

    const extData = {
      recipient: recipientAta,
      extAmount: new anchor.BN(amount),
      encryptedOutput1: Buffer.from("enc_fp_spl_dep_1"),
      encryptedOutput2: Buffer.from("enc_fp_spl_dep_2"),
      fee: depositFee,
      feeRecipient: feeRecipientAta,
      mintAddress: mint,
    };

    const inputs = [new Utxo({ lightWasm, mintAddress: mintStr }), new Utxo({ lightWasm, mintAddress: mintStr })];
    const publicAmount = new BN(amount).sub(depositFee).add(FIELD_SIZE).mod(FIELD_SIZE);
    const outputs = [
      new Utxo({ lightWasm, amount: publicAmount.toString(), index: tree.nextIndex, mintAddress: mintStr }),
      new Utxo({ lightWasm, amount: "0", mintAddress: mintStr }),
    ];

    const { proofToSubmit, outputCommitments } = await generateProofAndFormat(inputs, outputs, tree, extData, lightWasm, keyBasePath);

    await executeTransactSpl(
      mixerProgram, provider, proofToSubmit, extData,
      {
        splTreeAccountPDA, globalConfigPDA, splMint: mint,
        signerAta, recipientWallet: user.publicKey, recipientAta,
        treeAta: splTreeAta, feeRecipientAta,
      },
      user, altAddr,
    );

    tree.insertPair(outputCommitments[0], outputCommitments[1]);
    return { outputs, outputCommitments };
  }

  async function mixerWithdrawSpl(
    depositOutputs: Utxo[],
    recipientWallet: PublicKey,
    recipientAta: PublicKey,
    tree: SubtreesMerkleTree,
    altAddr: PublicKey,
    signer: Keypair,
    mint: PublicKey,
  ): Promise<{ withdrawnAmount: number }> {
    const mintStr = mint.toBase58();
    const withdrawInputs = [depositOutputs[0], new Utxo({ lightWasm, mintAddress: mintStr })];
    const withdrawOutputs = [
      new Utxo({ lightWasm, amount: "0", mintAddress: mintStr }),
      new Utxo({ lightWasm, amount: "0", mintAddress: mintStr }),
    ];

    const inputsSum = withdrawInputs.reduce((sum, x) => sum.add(x.amount), new BN(0));
    const withdrawFee = new anchor.BN(calculateWithdrawalFee(inputsSum.toNumber()));
    const extAmount = withdrawFee.add(new BN(0)).sub(inputsSum);

    const signerAta = getAssociatedTokenAddressSync(mint, signer.publicKey);

    const extData = {
      recipient: recipientAta,
      extAmount,
      encryptedOutput1: Buffer.from("enc_fp_spl_wd_1"),
      encryptedOutput2: Buffer.from("enc_fp_spl_wd_2"),
      fee: withdrawFee,
      feeRecipient: feeRecipientAta,
      mintAddress: mint,
    };

    const { proofToSubmit, outputCommitments } = await generateProofAndFormat(
      withdrawInputs, withdrawOutputs, tree, extData, lightWasm, keyBasePath,
    );

    await executeTransactSpl(
      mixerProgram, provider, proofToSubmit, extData,
      {
        splTreeAccountPDA, globalConfigPDA, splMint: mint,
        signerAta, recipientWallet, recipientAta,
        treeAta: splTreeAta, feeRecipientAta,
      },
      signer, altAddr,
    );

    tree.insertPair(outputCommitments[0], outputCommitments[1]);
    return { withdrawnAmount: inputsSum.sub(withdrawFee).toNumber() };
  }

  // ============================================================
  // Phase C: User1 Full Privacy Deposit (10 tests)
  // ============================================================
  describe("Phase C: User1 Full Privacy Deposit", () => {
    let revealedBase: number;
    let revealedQuote: number;
    let u64Delta: anchor.BN;

    it("User1 deposits SPL to mixer", async () => {
      const u = users[0];
      logSeparator(`MIXER: ${u.name} deposits ${MIXER_SPL_DEPOSIT} SPL`);
      const { outputs } = await mixerDepositSpl(u.realWallet, MIXER_SPL_DEPOSIT, splSyncTree, splAltAddress, baseMint);
      u.splDepositOutputs = outputs;
      console.log(`  ${u.name} SPL deposited to mixer`);
    });

    it("User1 deposits SOL to mixer", async () => {
      const u = users[0];
      logSeparator(`MIXER: ${u.name} deposits ${MIXER_SOL_DEPOSIT} SOL`);
      const { outputs } = await mixerDepositSol(u.realWallet, MIXER_SOL_DEPOSIT, solSyncTree, solAltAddress);
      u.solDepositOutputs = outputs;
      console.log(`  ${u.name} SOL deposited to mixer`);
    });

    it("Relayer withdraws SPL to User1 intermediate wallet", async () => {
      const u = users[0];
      logSeparator(`MIXER: Relayer withdraws SPL to ${u.name} intermediate wallet`);
      const intermediateAta = getAssociatedTokenAddressSync(baseMint, u.intermediateWallet.publicKey);

      const balBefore = await withRetry(() => getAccount(provider.connection, intermediateAta));
      const { withdrawnAmount } = await mixerWithdrawSpl(
        u.splDepositOutputs!, u.intermediateWallet.publicKey, intermediateAta,
        splSyncTree, splAltAddress, relayer, baseMint,
      );
      const balAfter = await withRetry(() => getAccount(provider.connection, intermediateAta));
      expect(Number(balAfter.amount) - Number(balBefore.amount)).to.equal(withdrawnAmount);
      console.log(`  ${u.name} intermediate wallet received ${withdrawnAmount} SPL`);
    });

    it("Relayer withdraws SOL to User1 intermediate wallet", async () => {
      const u = users[0];
      logSeparator(`MIXER: Relayer withdraws SOL to ${u.name} intermediate wallet`);

      const balBefore = await provider.connection.getBalance(u.intermediateWallet.publicKey);
      const { withdrawnAmount } = await mixerWithdrawSol(
        u.solDepositOutputs!, u.intermediateWallet.publicKey, solSyncTree, solAltAddress, relayer,
      );
      const balAfter = await provider.connection.getBalance(u.intermediateWallet.publicKey);
      expect(balAfter - balBefore).to.equal(withdrawnAmount);
      console.log(`  ${u.name} intermediate wallet received ${withdrawnAmount} SOL`);

      // Wrap received SOL to WSOL for Zodiac deposit
      const intermediateWsolAta = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, NATIVE_MINT, u.intermediateWallet.publicKey
      );
      const wrapTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: u.intermediateWallet.publicKey,
          toPubkey: intermediateWsolAta.address,
          lamports: u.quoteDepositAmount,
        }),
        createSyncNativeInstruction(intermediateWsolAta.address),
      );
      await sendWithEphemeralPayer(provider, wrapTx, [u.intermediateWallet]);
      console.log(`  Wrapped ${u.quoteDepositAmount} SOL -> WSOL`);
    });

    it("creates User1 position (MPC)", async () => {
      await createUserPosition(users[0]);
    });

    it("User1 intermediate wallet deposits to zodiac", async () => {
      await depositUserMPC(users[0]);
    });

    it("reveals pending deposits", async () => {
      logSeparator("MPC: revealPendingDeposits (User1 batch)");
      const revealed = await revealPending();
      revealedBase = revealed.base;
      revealedQuote = revealed.quote;
      logKeyValue("  Revealed base", revealedBase);
      logKeyValue("  Revealed quote", revealedQuote);
      expect(revealedBase).to.equal(users[0].baseDepositAmount);
      expect(revealedQuote).to.equal(users[0].quoteDepositAmount);
    });

    it("funds relay with revealed amount", async () => {
      logSeparator("RELAY FUNDING (User1 batch)");
      await fundRelayWithAmounts(revealedBase, revealedQuote);
    });

    it("deposits to Meteora and records liquidity delta", async () => {
      logSeparator("METEORA DEPOSIT (User1 batch)");
      const result = await depositToMeteora();
      u64Delta = result.u64Delta;
      expect(u64Delta.gt(new anchor.BN(0))).to.be.true;
      cumulativeMeteoraLiquidity = cumulativeMeteoraLiquidity.add(result.meteoraDelta);
      cumulativeBaseDeposited += users[0].baseDepositAmount;
      cumulativeQuoteDeposited += users[0].quoteDepositAmount;
    });

    it("records liquidity in Arcium", async () => {
      logSeparator("MPC: recordLiquidity (User1 batch)");
      await recordLiquidity(u64Delta);
    });
  });

  // ============================================================
  // Phase D: User2 Full Privacy Deposit (10 tests)
  // ============================================================
  describe("Phase D: User2 Full Privacy Deposit", () => {
    let revealedBase: number;
    let revealedQuote: number;
    let u64Delta: anchor.BN;

    it("User2 deposits SPL to mixer", async () => {
      const u = users[1];
      logSeparator(`MIXER: ${u.name} deposits ${MIXER_SPL_DEPOSIT} SPL`);
      const { outputs } = await mixerDepositSpl(u.realWallet, MIXER_SPL_DEPOSIT, splSyncTree, splAltAddress, baseMint);
      u.splDepositOutputs = outputs;
      console.log(`  ${u.name} SPL deposited to mixer`);
    });

    it("User2 deposits SOL to mixer", async () => {
      const u = users[1];
      logSeparator(`MIXER: ${u.name} deposits ${MIXER_SOL_DEPOSIT} SOL`);
      const { outputs } = await mixerDepositSol(u.realWallet, MIXER_SOL_DEPOSIT, solSyncTree, solAltAddress);
      u.solDepositOutputs = outputs;
      console.log(`  ${u.name} SOL deposited to mixer`);
    });

    it("Relayer withdraws SPL to User2 intermediate wallet", async () => {
      const u = users[1];
      logSeparator(`MIXER: Relayer withdraws SPL to ${u.name} intermediate wallet`);
      const intermediateAta = getAssociatedTokenAddressSync(baseMint, u.intermediateWallet.publicKey);

      const balBefore = await withRetry(() => getAccount(provider.connection, intermediateAta));
      const { withdrawnAmount } = await mixerWithdrawSpl(
        u.splDepositOutputs!, u.intermediateWallet.publicKey, intermediateAta,
        splSyncTree, splAltAddress, relayer, baseMint,
      );
      const balAfter = await withRetry(() => getAccount(provider.connection, intermediateAta));
      expect(Number(balAfter.amount) - Number(balBefore.amount)).to.equal(withdrawnAmount);
      console.log(`  ${u.name} intermediate wallet received ${withdrawnAmount} SPL`);
    });

    it("Relayer withdraws SOL to User2 intermediate wallet", async () => {
      const u = users[1];
      logSeparator(`MIXER: Relayer withdraws SOL to ${u.name} intermediate wallet`);

      const balBefore = await provider.connection.getBalance(u.intermediateWallet.publicKey);
      const { withdrawnAmount } = await mixerWithdrawSol(
        u.solDepositOutputs!, u.intermediateWallet.publicKey, solSyncTree, solAltAddress, relayer,
      );
      const balAfter = await provider.connection.getBalance(u.intermediateWallet.publicKey);
      expect(balAfter - balBefore).to.equal(withdrawnAmount);
      console.log(`  ${u.name} intermediate wallet received ${withdrawnAmount} SOL`);

      // Wrap SOL -> WSOL
      const intermediateWsolAta = await getOrCreateAssociatedTokenAccount(
        provider.connection, owner, NATIVE_MINT, u.intermediateWallet.publicKey
      );
      const wrapTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: u.intermediateWallet.publicKey,
          toPubkey: intermediateWsolAta.address,
          lamports: u.quoteDepositAmount,
        }),
        createSyncNativeInstruction(intermediateWsolAta.address),
      );
      await sendWithEphemeralPayer(provider, wrapTx, [u.intermediateWallet]);
      console.log(`  Wrapped ${u.quoteDepositAmount} SOL -> WSOL`);
    });

    it("creates User2 position (MPC)", async () => {
      await createUserPosition(users[1]);
    });

    it("User2 intermediate wallet deposits to zodiac", async () => {
      await depositUserMPC(users[1]);
    });

    it("reveals pending deposits", async () => {
      logSeparator("MPC: revealPendingDeposits (User2 batch)");
      const revealed = await revealPending();
      revealedBase = revealed.base;
      revealedQuote = revealed.quote;
      logKeyValue("  Revealed base", revealedBase);
      logKeyValue("  Revealed quote", revealedQuote);
      expect(revealedBase).to.equal(users[1].baseDepositAmount);
      expect(revealedQuote).to.equal(users[1].quoteDepositAmount);
    });

    it("funds relay with revealed amount", async () => {
      logSeparator("RELAY FUNDING (User2 batch)");
      await fundRelayWithAmounts(revealedBase, revealedQuote);
    });

    it("deposits to Meteora and records liquidity delta", async () => {
      logSeparator("METEORA DEPOSIT (User2 batch)");
      const result = await depositToMeteora();
      u64Delta = result.u64Delta;
      expect(u64Delta.gt(new anchor.BN(0))).to.be.true;
      cumulativeMeteoraLiquidity = cumulativeMeteoraLiquidity.add(result.meteoraDelta);
      cumulativeBaseDeposited += users[1].baseDepositAmount;
      cumulativeQuoteDeposited += users[1].quoteDepositAmount;
    });

    it("records liquidity in Arcium", async () => {
      logSeparator("MPC: recordLiquidity (User2 batch)");
      await recordLiquidity(u64Delta);
    });
  });

  // ============================================================
  // Phase E: User2 Withdrawal (4 tests)
  // ============================================================
  describe("Phase E: User2 Withdrawal", () => {
    let user2Base: number;
    let user2Quote: number;
    let user2LiquidityShare: anchor.BN;

    it("computes withdrawal for User2", async () => {
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

      // Compute pro-rata liquidity share
      const positionInfo = await provider.connection.getAccountInfo(positionPda);
      const currentUnlocked = new anchor.BN(positionInfo!.data.slice(152, 168), "le");
      user2LiquidityShare = currentUnlocked.mul(new anchor.BN(user2Base)).div(new anchor.BN(cumulativeBaseDeposited));
    });

    it("withdraws User2 liquidity from Meteora", async () => {
      logSeparator("METEORA: Partial Withdraw (User2)");
      await new Promise(r => setTimeout(r, 3000));

      const wdEph = await setupEphemeralWallet(zodiacProgram, provider, owner, vaultPda, 100_000_000);
      try {
        const wdTx = await zodiacProgram.methods
          .withdrawFromMeteoraDammV2(RELAY_INDEX, user2LiquidityShare, new anchor.BN(0), new anchor.BN(0))
          .accounts({
            payer: wdEph.ephemeralKp.publicKey, vault: vaultPda, ephemeralWallet: wdEph.ephemeralPda, relayPda,
            poolAuthority: POOL_AUTHORITY, pool: poolPda, position: positionPda,
            relayTokenA, relayTokenB, tokenAVault, tokenBVault,
            tokenAMint: tokenA, tokenBMint: tokenB, positionNftAccount: posNftAccount,
            tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
            eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .transaction();
        await sendWithEphemeralPayer(provider, wdTx, [wdEph.ephemeralKp]);
        console.log("  Partial withdrawal succeeded");
      } finally {
        await teardownEphemeralWallet(zodiacProgram, provider, owner, vaultPda, wdEph.ephemeralKp, wdEph.ephemeralPda);
      }
    });

    it("transfers tokens from relay to User2 intermediate wallet", async () => {
      logSeparator("RELAY TRANSFER: User2 withdrawal");
      await new Promise(r => setTimeout(r, 2000));

      const splMintForRelay = isTokenANative ? tokenB : tokenA;
      const destTokenKp = Keypair.generate();
      const destWsolKp = Keypair.generate();
      const destinationTokenAccount = await createAccount(
        provider.connection, owner, splMintForRelay, users[1].intermediateWallet.publicKey, destTokenKp,
      );
      const destinationWsolAccount = await createAccount(
        provider.connection, owner, NATIVE_MINT, users[1].intermediateWallet.publicKey, destWsolKp,
      );

      const relSplBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      const relWsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
      const splTransfer = Math.min(user2Base, Number(relSplBal.amount));
      const wsolTransfer = Math.min(user2Quote, Number(relWsolBal.amount));

      await zodiacProgram.methods
        .relayTransferToDestination(RELAY_INDEX, new anchor.BN(splTransfer))
        .accounts({
          authority: owner.publicKey, vault: vaultPda, relayPda,
          relayTokenAccount: relaySplAccount, destinationTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner]).rpc({ commitment: "confirmed" });

      await zodiacProgram.methods
        .relayTransferToDestination(RELAY_INDEX, new anchor.BN(wsolTransfer))
        .accounts({
          authority: owner.publicKey, vault: vaultPda, relayPda,
          relayTokenAccount: relayWsolAccount, destinationTokenAccount: destinationWsolAccount, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner]).rpc({ commitment: "confirmed" });

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
  // Phase F: User1 Final Withdrawal (4 tests)
  // ============================================================
  describe("Phase F: User1 Final Withdrawal", () => {
    let user1Base: number;
    let user1Quote: number;

    it("computes withdrawal for User1", async () => {
      const u = users[0];
      logSeparator(`MPC: computeWithdrawal for ${u.name}`);
      const result = await computeWithdrawal(u);
      user1Base = result.base;
      user1Quote = result.quote;
      u.decryptedBaseWithdraw = user1Base;
      u.decryptedQuoteWithdraw = user1Quote;
      logKeyValue("  Decrypted base", user1Base);
      logKeyValue("  Decrypted quote", user1Quote);
      expect(user1Base).to.equal(u.baseDepositAmount);
      expect(user1Quote).to.equal(u.quoteDepositAmount);
    });

    it("withdraws User1 liquidity from Meteora", async () => {
      logSeparator("METEORA: Full Withdraw (remaining User1 liquidity)");
      await new Promise(r => setTimeout(r, 3000));

      const positionInfo = await provider.connection.getAccountInfo(positionPda);
      const unlockedLiquidity = new anchor.BN(positionInfo!.data.slice(152, 168), "le");
      expect(unlockedLiquidity.gt(new anchor.BN(0))).to.be.true;

      const wdEph = await setupEphemeralWallet(zodiacProgram, provider, owner, vaultPda, 100_000_000);
      try {
        const wdTx = await zodiacProgram.methods
          .withdrawFromMeteoraDammV2(RELAY_INDEX, unlockedLiquidity, new anchor.BN(0), new anchor.BN(0))
          .accounts({
            payer: wdEph.ephemeralKp.publicKey, vault: vaultPda, ephemeralWallet: wdEph.ephemeralPda, relayPda,
            poolAuthority: POOL_AUTHORITY, pool: poolPda, position: positionPda,
            relayTokenA, relayTokenB, tokenAVault, tokenBVault,
            tokenAMint: tokenA, tokenBMint: tokenB, positionNftAccount: posNftAccount,
            tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
            eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .transaction();
        await sendWithEphemeralPayer(provider, wdTx, [wdEph.ephemeralKp]);

        const posAfter = await provider.connection.getAccountInfo(positionPda);
        const afterLiq = new anchor.BN(posAfter!.data.slice(152, 168), "le");
        expect(afterLiq.eq(new anchor.BN(0))).to.be.true;
        console.log("  All remaining liquidity withdrawn");
      } finally {
        await teardownEphemeralWallet(zodiacProgram, provider, owner, vaultPda, wdEph.ephemeralKp, wdEph.ephemeralPda);
      }
    });

    it("transfers tokens from relay to User1 intermediate wallet", async () => {
      logSeparator("RELAY TRANSFER: User1 withdrawal");
      await new Promise(r => setTimeout(r, 2000));

      const splMintForRelay = isTokenANative ? tokenB : tokenA;
      const destTokenKp = Keypair.generate();
      const destWsolKp = Keypair.generate();
      const destinationTokenAccount = await createAccount(
        provider.connection, owner, splMintForRelay, users[0].intermediateWallet.publicKey, destTokenKp,
      );
      const destinationWsolAccount = await createAccount(
        provider.connection, owner, NATIVE_MINT, users[0].intermediateWallet.publicKey, destWsolKp,
      );

      const relSplBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
      const relWsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
      const splTransfer = Math.min(user1Base, Number(relSplBal.amount));
      const wsolTransfer = Math.min(user1Quote, Number(relWsolBal.amount));

      await zodiacProgram.methods
        .relayTransferToDestination(RELAY_INDEX, new anchor.BN(splTransfer))
        .accounts({
          authority: owner.publicKey, vault: vaultPda, relayPda,
          relayTokenAccount: relaySplAccount, destinationTokenAccount, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner]).rpc({ commitment: "confirmed" });

      await zodiacProgram.methods
        .relayTransferToDestination(RELAY_INDEX, new anchor.BN(wsolTransfer))
        .accounts({
          authority: owner.publicKey, vault: vaultPda, relayPda,
          relayTokenAccount: relayWsolAccount, destinationTokenAccount: destinationWsolAccount, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner]).rpc({ commitment: "confirmed" });

      const destSplBal = await withRetry(() => getAccount(provider.connection, destinationTokenAccount));
      const destWsolBal = await withRetry(() => getAccount(provider.connection, destinationWsolAccount));
      expect(Number(destSplBal.amount)).to.equal(splTransfer);
      expect(Number(destWsolBal.amount)).to.equal(wsolTransfer);
      console.log(`  User1 received ${splTransfer} SPL + ${wsolTransfer} WSOL`);
    });

    it("clears User1 position", async () => {
      logSeparator("MPC: clearPosition for User1");
      await clearPosition(users[0], user1Base, user1Quote);
    });
  });

  // ============================================================
  // Cleanup
  // ============================================================
  after(async () => {
    logSeparator("CLEANUP");

    // Drain relay token accounts and close them
    try {
      if (relayTokenA && relayTokenB) {
        const splBal = await withRetry(() => getAccount(provider.connection, relaySplAccount));
        if (Number(splBal.amount) > 0) {
          const ownerAta = await getOrCreateAssociatedTokenAccount(
            provider.connection, owner, isTokenANative ? tokenB : tokenA, owner.publicKey
          );
          await zodiacProgram.methods
            .relayTransferToDestination(RELAY_INDEX, new anchor.BN(splBal.amount.toString()))
            .accounts({
              authority: owner.publicKey, vault: vaultPda, relayPda,
              relayTokenAccount: relaySplAccount, destinationTokenAccount: ownerAta.address, tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner]).rpc({ commitment: "confirmed" });
        }

        const wsolBal = await withRetry(() => getAccount(provider.connection, relayWsolAccount));
        if (Number(wsolBal.amount) > 0) {
          const ownerWsolAta = await getOrCreateAssociatedTokenAccount(provider.connection, owner, NATIVE_MINT, owner.publicKey);
          await zodiacProgram.methods
            .relayTransferToDestination(RELAY_INDEX, new anchor.BN(wsolBal.amount.toString()))
            .accounts({
              authority: owner.publicKey, vault: vaultPda, relayPda,
              relayTokenAccount: relayWsolAccount, destinationTokenAccount: ownerWsolAta.address, tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner]).rpc({ commitment: "confirmed" });

          try {
            await closeAccount(provider.connection, owner, ownerWsolAta.address, owner.publicKey, owner);
          } catch {}
        }

        // Close relay token accounts
        for (const acct of [relaySplAccount, relayWsolAccount]) {
          try {
            await zodiacProgram.methods
              .closeRelayTokenAccount(RELAY_INDEX)
              .accounts({
                authority: owner.publicKey, vault: vaultPda, relayPda,
                relayTokenAccount: acct, tokenProgram: TOKEN_PROGRAM_ID,
              })
              .signers([owner]).rpc({ commitment: "confirmed" });
          } catch {}
        }
      }
    } catch (err: any) {
      console.log("Cleanup: relay drain error:", err.message?.substring(0, 100));
    }

    // Withdraw relay SOL
    try {
      if (relayPda) {
        const relayBal = await provider.connection.getBalance(relayPda);
        if (relayBal > 0) {
          await zodiacProgram.methods
            .withdrawRelaySol(RELAY_INDEX, new anchor.BN(relayBal))
            .accounts({ authority: owner.publicKey, vault: vaultPda, relayPda, systemProgram: SystemProgram.programId })
            .signers([owner]).rpc({ commitment: "confirmed" });
          console.log(`  Withdrew ${relayBal / 1e9} SOL from relay PDA`);
        }
      }
    } catch (err: any) {
      console.log("Cleanup: relay SOL error:", err.message?.substring(0, 100));
    }

    // Return funded keypairs SOL
    for (const kp of fundedKeypairs) {
      try {
        const bal = await provider.connection.getBalance(kp.publicKey);
        if (bal > 5000) {
          const tx = new Transaction().add(
            SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: owner.publicKey, lamports: bal - 5000 })
          );
          tx.feePayer = owner.publicKey;
          await provider.sendAndConfirm(tx, [owner, kp]);
        }
      } catch {}
    }

    logSeparator("FULL PRIVACY FLOW SUMMARY");
    console.log("");
    console.log("  DEPOSIT FLOW PER USER:");
    console.log("    realWallet --SPL--> Mixer --SPL--> intermediateWallet --SPL+WSOL--> Zodiac Vault");
    console.log("    realWallet --SOL--> Mixer --SOL--> intermediateWallet --------^");
    console.log("");
    console.log("  PRIVACY LAYERS:");
    console.log("    1. ZK Mixer: Breaks realWallet -> intermediateWallet link");
    console.log("    2. Arcium MPC: Individual deposit amounts never visible on-chain");
    console.log("    3. Relay PDA: Single aggregate position in Meteora");
    console.log("    4. Ephemeral wallets: Fresh keypair per operation");
    console.log("");
    for (const u of users) {
      console.log(`  ${u.name}: deposited ${u.baseDepositAmount} base + ${u.quoteDepositAmount} quote`);
      console.log(`    -> withdrew ${u.decryptedBaseWithdraw || "N/A"} base + ${u.decryptedQuoteWithdraw || "N/A"} quote`);
    }
    console.log("");
    console.log("=".repeat(60));
    console.log("Full privacy integration test complete.");
    console.log("=".repeat(60));
  });

  // ============================================================
  // Helper: initCompDef (idempotent)
  // ============================================================
  async function initCompDef(
    program: Program<ZodiacLiquidity>,
    owner: Keypair,
    circuitName: string,
    methodName: string,
  ): Promise<string> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed("ComputationDefinitionAccount");
    const offset = getCompDefAccOffset(circuitName);

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset], getArciumProgramId()
    )[0];

    // Derive the MXE LUT PDA (authority=mxePda, recentSlot=0)
    const mxePda = getMXEAccAddress(program.programId);
    const slotBuffer = Buffer.alloc(8); // u64 LE = 0
    const [mxeLutPda] = PublicKey.findProgramAddressSync(
      [mxePda.toBuffer(), slotBuffer],
      AddressLookupTableProgram.programId,
    );

    // Always attempt to init — genesis may pre-create the PDA but the MXE
    // needs the actual CPI to register the action.  If the instruction fails
    // because the account already exists, we catch and continue.
    try {
      // @ts-ignore
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
    } catch (err: any) {
      const msg = err?.message || err?.toString() || "";
      // Account already initialized — this is OK if genesis pre-created it AND the MXE already knows about it
      if (msg.includes("already in use") || msg.includes("0x0") || msg.includes("custom program error")) {
        console.log(`${circuitName} comp def already initialized (caught: ${msg.substring(0, 100)})`);
        return "skipped";
      }
      throw err;
    }
  }
});
