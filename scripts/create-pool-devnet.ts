/**
 * Create Meteora DAMM v2 pool + position via Zodiac relay PDA.
 *
 * Requires:
 * - Vault already created (run operator first or setup-devnet-demo.ts)
 * - Authority keypair at ~/.config/solana/id.json
 *
 * Usage: npx tsx scripts/create-pool-devnet.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  createAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import {
  getSqrtPriceFromPrice,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} from "@meteora-ag/cp-amm-sdk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const ZODIAC_PROGRAM_ID = new PublicKey("7qpT6gRLFm1F9kHLSkHpcMPM6sbdWRNokQaqae1Zz3j2");
const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");
const RELAY_INDEX = 0;

// Base mint from setup
const BASE_MINT = new PublicKey("XtxSDbMYj2Q19npSD6wcRGHNDFBYLo9TeULECtovo8N");

function maxKey(a: PublicKey, b: PublicKey): PublicKey {
  return a.toBuffer().compare(b.toBuffer()) > 0 ? a : b;
}
function minKey(a: PublicKey, b: PublicKey): PublicKey {
  return a.toBuffer().compare(b.toBuffer()) <= 0 ? a : b;
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
        console.log(`Blockhash expired, retrying (${attempt + 1}/3)...`);
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

async function main() {
  // Setup connection
  const rpcUrl =
    process.env.RPC_URL ||
    "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  // Load owner keypair
  const keypairPath =
    process.env.KEYPAIR_PATH ||
    path.join(os.homedir(), ".config/solana/id.json");
  const ownerSecret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const owner = Keypair.fromSecretKey(Uint8Array.from(ownerSecret));
  console.log("Authority:", owner.publicKey.toString());

  // Load zodiac program
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../target/idl/zodiac_liquidity.json"),
      "utf-8"
    )
  );
  const wallet = new anchor.Wallet(owner);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = new Program(idl as any, provider);

  const baseMint = BASE_MINT;
  const quoteMint = NATIVE_MINT;

  // Derive vault PDA
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), baseMint.toBuffer()], ZODIAC_PROGRAM_ID
  );
  const relayPda = deriveRelayPda(vaultPda, RELAY_INDEX, ZODIAC_PROGRAM_ID);
  console.log("Vault:", vaultPda.toString());
  console.log("Relay:", relayPda.toString());

  // Verify vault exists
  const vaultInfo = await connection.getAccountInfo(vaultPda);
  if (!vaultInfo) {
    console.error("ERROR: Vault does not exist. Start the operator first to create it.");
    process.exit(1);
  }

  // === Fund relay PDA ===
  console.log("\n--- Funding Relay PDA ---");
  const fundRelayTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: relayPda,
      lamports: 1_000_000_000, // 1 SOL
    })
  );
  await provider.sendAndConfirm(fundRelayTx, [owner]);
  console.log("Funded relay PDA with 1 SOL");

  // === Sort tokens (Meteora requires sorted order) ===
  const tokenA = minKey(baseMint, quoteMint);
  const tokenB = maxKey(baseMint, quoteMint);
  const isTokenANative = tokenA.equals(NATIVE_MINT);
  console.log("TokenA:", tokenA.toString(), isTokenANative ? "(NATIVE)" : "(SPL)");
  console.log("TokenB:", tokenB.toString());

  // === Create relay token accounts ===
  console.log("\n--- Creating Relay Token Accounts ---");
  const relayTokenAKp = Keypair.generate();
  const relayTokenA = await createAccount(connection, owner, tokenA, relayPda, relayTokenAKp);
  const relayTokenBKp = Keypair.generate();
  const relayTokenB = await createAccount(connection, owner, tokenB, relayPda, relayTokenBKp);
  const relaySplAccount = isTokenANative ? relayTokenB : relayTokenA;
  const relayWsolAccount = isTokenANative ? relayTokenA : relayTokenB;
  console.log("Relay token A:", relayTokenA.toString());
  console.log("Relay token B:", relayTokenB.toString());

  // === Fund relay with initial liquidity ===
  console.log("\n--- Funding Relay with Initial Liquidity ---");
  const INITIAL_LIQ = 1_000_000;

  // Fund SPL
  const authorityTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection, owner, baseMint, owner.publicKey
  );
  await mintTo(connection, owner, baseMint, authorityTokenAccount.address, owner, INITIAL_LIQ);
  await new Promise(r => setTimeout(r, 2000));

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
  console.log("Funded relay with", INITIAL_LIQ, "SPL tokens");

  // Fund WSOL
  const fundWsolTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: relayWsolAccount, lamports: INITIAL_LIQ }),
    createSyncNativeInstruction(relayWsolAccount),
  );
  await provider.sendAndConfirm(fundWsolTx, [owner]);
  console.log("Funded relay with", INITIAL_LIQ, "WSOL lamports");

  // === Derive Meteora PDAs ===
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("cpool"), maxKey(tokenA, tokenB).toBuffer(), minKey(tokenA, tokenB).toBuffer()],
    DAMM_V2_PROGRAM_ID
  );
  const [tokenAVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), tokenA.toBuffer(), poolPda.toBuffer()],
    DAMM_V2_PROGRAM_ID
  );
  const [tokenBVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), tokenB.toBuffer(), poolPda.toBuffer()],
    DAMM_V2_PROGRAM_ID
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], DAMM_V2_PROGRAM_ID);

  console.log("\nPool PDA:", poolPda.toString());

  // === Create pool via ephemeral wallet ===
  console.log("\n--- Creating Pool ---");

  // Register ephemeral wallet
  const poolEphKp = Keypair.generate();
  const poolEphPda = deriveEphemeralWalletPda(vaultPda, poolEphKp.publicKey, ZODIAC_PROGRAM_ID);

  await program.methods
    .registerEphemeralWallet()
    .accounts({
      authority: owner.publicKey,
      vault: vaultPda,
      wallet: poolEphKp.publicKey,
      ephemeralWallet: poolEphPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner])
    .rpc({ commitment: "confirmed" });

  // Fund ephemeral wallet
  const fundEphTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: poolEphKp.publicKey, lamports: 200_000_000 })
  );
  await provider.sendAndConfirm(fundEphTx, [owner]);
  console.log("Ephemeral wallet registered:", poolEphKp.publicKey.toString());

  // Pool creation
  const poolNftMint = Keypair.generate();
  const [poolPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), poolNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
  );
  const [poolNftAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("position_nft_account"), poolNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
  );

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
  const sqrtPrice = getSqrtPriceFromPrice(1, 9, 9);

  const poolTx = await program.methods
    .createCustomizablePoolViaRelay(
      RELAY_INDEX, poolFees,
      new anchor.BN(MIN_SQRT_PRICE), new anchor.BN(MAX_SQRT_PRICE),
      false, new anchor.BN(1_000_000), sqrtPrice, 0, 0, null,
    )
    .accounts({
      payer: poolEphKp.publicKey, vault: vaultPda, ephemeralWallet: poolEphPda, relayPda,
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

  const poolSig = await sendWithEphemeralPayer(provider, poolTx, [poolEphKp, poolNftMint]);
  console.log("Pool created:", poolPda.toString());
  console.log("Pool tx:", poolSig);

  // Teardown ephemeral wallet
  try {
    const ephBal = await connection.getBalance(poolEphKp.publicKey);
    if (ephBal > 5000) {
      const returnTx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: poolEphKp.publicKey, toPubkey: owner.publicKey, lamports: ephBal - 5000 })
      );
      await sendWithEphemeralPayer(provider, returnTx, [poolEphKp]);
    }
  } catch {}
  await program.methods
    .closeEphemeralWallet()
    .accounts({ authority: owner.publicKey, vault: vaultPda, ephemeralWallet: poolEphPda })
    .signers([owner])
    .rpc({ commitment: "confirmed" });

  await new Promise(r => setTimeout(r, 5000));

  // === Create position via ephemeral wallet ===
  console.log("\n--- Creating Position ---");

  const posEphKp = Keypair.generate();
  const posEphPda = deriveEphemeralWalletPda(vaultPda, posEphKp.publicKey, ZODIAC_PROGRAM_ID);

  await program.methods
    .registerEphemeralWallet()
    .accounts({
      authority: owner.publicKey,
      vault: vaultPda,
      wallet: posEphKp.publicKey,
      ephemeralWallet: posEphPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner])
    .rpc({ commitment: "confirmed" });

  const fundPosEphTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: posEphKp.publicKey, lamports: 200_000_000 })
  );
  await provider.sendAndConfirm(fundPosEphTx, [owner]);
  console.log("Position ephemeral wallet registered:", posEphKp.publicKey.toString());

  const posNftMint = Keypair.generate();
  const [positionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), posNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
  );
  const [posNftAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("position_nft_account"), posNftMint.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID
  );
  const [relayPositionTracker] = PublicKey.findProgramAddressSync(
    [Buffer.from("relay_position"), vaultPda.toBuffer(), Buffer.from([RELAY_INDEX]), poolPda.toBuffer()],
    ZODIAC_PROGRAM_ID
  );

  const posTx = await program.methods
    .createMeteoraPosition(RELAY_INDEX)
    .accounts({
      payer: posEphKp.publicKey, vault: vaultPda, ephemeralWallet: posEphPda, relayPda,
      relayPositionTracker,
      positionNftMint: posNftMint.publicKey, positionNftAccount: posNftAccount,
      pool: poolPda, position: positionPda,
      poolAuthority: POOL_AUTHORITY,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, eventAuthority, ammProgram: DAMM_V2_PROGRAM_ID,
    })
    .transaction();

  const posSig = await sendWithEphemeralPayer(provider, posTx, [posEphKp, posNftMint]);
  console.log("Position created:", positionPda.toString());
  console.log("Position tx:", posSig);

  // Teardown
  try {
    const ephBal = await connection.getBalance(posEphKp.publicKey);
    if (ephBal > 5000) {
      const returnTx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: posEphKp.publicKey, toPubkey: owner.publicKey, lamports: ephBal - 5000 })
      );
      await sendWithEphemeralPayer(provider, returnTx, [posEphKp]);
    }
  } catch {}
  await program.methods
    .closeEphemeralWallet()
    .accounts({ authority: owner.publicKey, vault: vaultPda, ephemeralWallet: posEphPda })
    .signers([owner])
    .rpc({ commitment: "confirmed" });

  // === Output ===
  console.log("\n============================================");
  console.log("POOL CREATION COMPLETE");
  console.log("============================================");
  console.log("Pool address:", poolPda.toString());
  console.log("Position:", positionPda.toString());
  console.log("Relay token A:", relayTokenA.toString());
  console.log("Relay token B:", relayTokenB.toString());
  console.log("\nFrontend URL: http://45.62.123.89:3000/dammv2/" + poolPda.toString());
}

main().catch((e) => {
  console.error("Pool creation failed:", e);
  process.exit(1);
});
