/**
 * Initialize SPL Merkle tree on devnet for a given mint.
 * Usage: npx tsx init-spl-tree.ts <MINT_ADDRESS>
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";

const MIXER_PROGRAM_ID = new PublicKey("AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb");
const RPC_URL = "https://devnet.helius-rpc.com/?api-key=7853a445-0e8d-435d-8e33-c33d7df387ce";
const KEYPAIR_PATH = "/root/.config/solana/id.json";

async function main() {
  const mintAddress = process.argv[2];
  if (!mintAddress) {
    console.error("Usage: npx tsx init-spl-tree.ts <MINT_ADDRESS>");
    process.exit(1);
  }

  const mint = new PublicKey(mintAddress);
  const connection = new Connection(RPC_URL, "confirmed");
  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Mint:", mint.toBase58());

  // Derive PDAs
  const [treeAccountPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree"), mint.toBuffer()],
    MIXER_PROGRAM_ID,
  );
  const [globalConfigPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    MIXER_PROGRAM_ID,
  );

  console.log("Tree PDA:", treeAccountPDA.toBase58());
  console.log("GlobalConfig PDA:", globalConfigPDA.toBase58());

  // Check if already initialized
  const existing = await connection.getAccountInfo(treeAccountPDA);
  if (existing) {
    console.log("SPL tree already initialized for this mint, skipping.");
    process.exit(0);
  }

  // Load IDL
  const idl = JSON.parse(fs.readFileSync("/root/zodiac/relayer/zodiac_mixer.json", "utf-8"));
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  // Max deposit: 10 SOL equivalent (10_000_000_000 lamports) — adjust as needed
  const maxDeposit = new anchor.BN("10000000000");

  console.log("Initializing SPL tree...");
  const tx = await (program.methods as any)
    .initializeTreeAccountForSplToken(maxDeposit)
    .accounts({
      treeAccount: treeAccountPDA,
      mint: mint,
      globalConfig: globalConfigPDA,
      authority: authority.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  console.log("SPL tree initialized! Tx:", tx);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
