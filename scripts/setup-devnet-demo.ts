/**
 * Setup script for Zodiac devnet demo.
 *
 * Creates:
 * 1. Base SPL token mint (or reuses existing)
 * 2. Mixer SPL tree for that mint
 * 3. Funds SOL tree and SPL tree with liquidity
 * 4. Fee recipient ATA
 * 5. Relayer ATA for SPL token
 *
 * Usage: npx tsx scripts/setup-devnet-demo.ts [--mint <EXISTING_MINT>]
 *
 * Outputs the VAULT_MINT and other env vars needed for operator/relayer.
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
  NATIVE_MINT,
  createMint,
  mintTo,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent,
  createAssociatedTokenAccountIdempotentInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const MIXER_PROGRAM_ID = new PublicKey("AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb");
const SPL_MAX_DEPOSIT = 1_000_000_000_000;

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let existingMint: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mint" && args[i + 1]) {
      existingMint = args[i + 1];
    }
  }

  // Setup connection
  const rpcUrl =
    process.env.RPC_URL ||
    "https://devnet.helius-rpc.com/?api-key=7853a445-0e8d-435d-8e33-c33d7df387ce";
  const connection = new Connection(rpcUrl, "confirmed");

  // Load owner keypair
  const keypairPath =
    process.env.KEYPAIR_PATH ||
    path.join(os.homedir(), ".config/solana/id.json");
  const ownerSecret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const owner = Keypair.fromSecretKey(Uint8Array.from(ownerSecret));
  console.log("Authority:", owner.publicKey.toString());

  const balance = await connection.getBalance(owner.publicKey);
  console.log("Balance:", (balance / LAMPORTS_PER_SOL).toFixed(4), "SOL");

  // Load mixer program
  const mixerIdl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../target/idl/zodiac_mixer.json"),
      "utf-8"
    )
  );
  const wallet = new anchor.Wallet(owner);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const mixerProgram = new Program(mixerIdl as any, provider);

  // Load relayer keypair (for fee recipient)
  let relayerKp: Keypair;
  const relayerKpPath = "/root/zodiac/relayer/test-relayer-keypair.json";
  if (fs.existsSync(relayerKpPath)) {
    const relayerSecret = JSON.parse(fs.readFileSync(relayerKpPath, "utf-8"));
    relayerKp = Keypair.fromSecretKey(Uint8Array.from(relayerSecret));
    console.log("Relayer keypair:", relayerKp.publicKey.toString());
  } else {
    relayerKp = Keypair.generate();
    fs.writeFileSync(
      relayerKpPath,
      JSON.stringify(Array.from(relayerKp.secretKey))
    );
    console.log("Generated relayer keypair:", relayerKp.publicKey.toString());
  }

  // Fund relayer if needed
  const relayerBalance = await connection.getBalance(relayerKp.publicKey);
  if (relayerBalance < 0.1 * LAMPORTS_PER_SOL) {
    console.log("Funding relayer with 0.5 SOL...");
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: relayerKp.publicKey,
        lamports: 0.5 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundTx, [owner]);
  }

  // === Step 1: Create or reuse base mint ===
  let baseMint: PublicKey;
  if (existingMint) {
    baseMint = new PublicKey(existingMint);
    console.log("\nUsing existing base mint:", baseMint.toString());
  } else {
    console.log("\nCreating new base SPL token mint...");
    baseMint = await createMint(
      connection,
      owner,
      owner.publicKey,
      null,
      9 // 9 decimals
    );
    console.log("Base mint created:", baseMint.toString());
  }

  // === Step 2: Mixer SOL tree (check if exists) ===
  console.log("\n--- Mixer SOL Tree ---");
  const [solTreePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree")],
    MIXER_PROGRAM_ID
  );
  const [solTreeTokenPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("tree_token")],
    MIXER_PROGRAM_ID
  );
  const [globalConfigPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    MIXER_PROGRAM_ID
  );

  const existingSolTree = await connection.getAccountInfo(solTreePDA);
  if (!existingSolTree) {
    console.log("Initializing SOL mixer tree...");
    await (mixerProgram.methods.initialize() as any)
      .accounts({
        treeAccount: solTreePDA,
        treeTokenAccount: solTreeTokenPDA,
        globalConfig: globalConfigPDA,
        authority: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    console.log("SOL mixer tree initialized");
  } else {
    console.log("SOL mixer tree already exists:", solTreePDA.toString());
  }

  // Fund SOL tree if low
  const solTreeBalance = await connection.getBalance(solTreeTokenPDA);
  if (solTreeBalance < 0.2 * LAMPORTS_PER_SOL) {
    console.log("Funding SOL tree with 0.5 SOL...");
    const fundTreeTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: solTreeTokenPDA,
        lamports: 0.5 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundTreeTx, [owner]);
  }

  // Set deposit limit for SOL tree
  await (mixerProgram.methods.updateDepositLimit(new anchor.BN(SPL_MAX_DEPOSIT)) as any)
    .accounts({
      treeAccount: solTreePDA,
      authority: owner.publicKey,
    })
    .signers([owner])
    .rpc();
  console.log("SOL tree deposit limit updated");

  // === Step 3: Mixer SPL tree ===
  console.log("\n--- Mixer SPL Tree ---");
  const [splTreePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree"), baseMint.toBuffer()],
    MIXER_PROGRAM_ID
  );

  // Create tree ATA owned by globalConfig PDA
  const splTreeAta = getAssociatedTokenAddressSync(
    baseMint,
    globalConfigPDA,
    true
  );
  const treeAtaInfo = await connection.getAccountInfo(splTreeAta);
  if (!treeAtaInfo) {
    console.log("Creating SPL tree ATA...");
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      splTreeAta,
      globalConfigPDA,
      baseMint
    );
    const createAtaTx = new Transaction().add(createAtaIx);
    await provider.sendAndConfirm(createAtaTx, [owner]);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Initialize SPL tree
  const existingSplTree = await connection.getAccountInfo(splTreePDA);
  if (!existingSplTree) {
    console.log("Initializing SPL mixer tree...");
    await (
      mixerProgram.methods.initializeTreeAccountForSplToken(
        new anchor.BN(SPL_MAX_DEPOSIT)
      ) as any
    )
      .accounts({
        treeAccount: splTreePDA,
        mint: baseMint,
        globalConfig: globalConfigPDA,
        authority: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    console.log("SPL mixer tree initialized for", baseMint.toString());
  } else {
    console.log("SPL mixer tree already exists:", splTreePDA.toString());
  }

  // Fund SPL tree ATA with tokens
  console.log("Minting 100M tokens to SPL tree ATA...");
  await mintTo(
    connection,
    owner,
    baseMint,
    splTreeAta,
    owner,
    100_000_000 // 100M tokens
  );

  // === Step 4: Fee recipient ATA (using relayer as fee recipient) ===
  console.log("\n--- Fee Recipient ATAs ---");
  const feeRecipientAta = await createAssociatedTokenAccountIdempotent(
    connection,
    owner,
    baseMint,
    relayerKp.publicKey
  );
  console.log("Fee recipient ATA:", feeRecipientAta.toString());

  // Relayer SPL ATA (needed for mixer SPL withdrawals)
  await createAssociatedTokenAccountIdempotent(
    connection,
    owner,
    baseMint,
    relayerKp.publicKey
  );
  console.log("Relayer SPL ATA created");

  // === Step 5: Ensure mixer config ===
  console.log("\n--- Mixer Config ---");
  const currentConfig = await mixerProgram.account.globalConfig.fetch(
    globalConfigPDA
  );
  if (currentConfig.paused) {
    console.log("Unpausing mixer...");
    await (mixerProgram.methods.togglePause() as any)
      .accounts({
        globalConfig: globalConfigPDA,
        authority: owner.publicKey,
      })
      .signers([owner])
      .rpc();
  }
  // Set fee config: 0% deposit, 0.25% withdrawal, 5% error margin
  await (mixerProgram.methods.updateGlobalConfig(0, 25, 500) as any)
    .accounts({
      globalConfig: globalConfigPDA,
      authority: owner.publicKey,
    })
    .signers([owner])
    .rpc();
  console.log(
    "Mixer config: deposit_fee=0%, withdrawal_fee=0.25%, error_margin=5%"
  );

  // === Output ===
  console.log("\n============================================");
  console.log("SETUP COMPLETE");
  console.log("============================================");
  console.log("");
  console.log("BASE MINT (VAULT_MINT):", baseMint.toString());
  console.log("RELAYER PUBKEY:", relayerKp.publicKey.toString());
  console.log("SOL TREE PDA:", solTreePDA.toString());
  console.log("SPL TREE PDA:", splTreePDA.toString());
  console.log("GLOBAL CONFIG:", globalConfigPDA.toString());
  console.log("SPL TREE ATA:", splTreeAta.toString());
  console.log("FEE RECIPIENT ATA:", feeRecipientAta.toString());
  console.log("");
  console.log("--- OPERATOR .env ---");
  console.log(`RPC_URL=${rpcUrl}`);
  console.log(`WS_URL=${rpcUrl.replace("https://", "wss://")}`);
  console.log(`AUTHORITY_KEYPAIR_PATH=${keypairPath}`);
  console.log(`VAULT_MINT=${baseMint.toString()}`);
  console.log(`LIQUIDITY_PROGRAM_ID=7qpT6gRLFm1F9kHLSkHpcMPM6sbdWRNokQaqae1Zz3j2`);
  console.log(`MIXER_PROGRAM_ID=AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb`);
  console.log(`PORT=3001`);
  console.log("");
  console.log("--- RELAYER .env ---");
  console.log(`RPC_URL=${rpcUrl}`);
  console.log(`WS_URL=${rpcUrl.replace("https://", "wss://")}`);
  console.log(`KEYPAIR_PATH=${relayerKpPath}`);
  console.log(`PORT=3002`);
  console.log(`SUPPORTED_MINTS=${baseMint.toString()}`);
  console.log(`MIXER_PROGRAM_ID=AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb`);
  console.log(`IDL_PATH=/root/zodiac/relayer/zodiac_mixer.json`);
}

main().catch((e) => {
  console.error("Setup failed:", e);
  process.exit(1);
});
