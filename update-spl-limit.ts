/**
 * Update SPL tree deposit limit on devnet.
 * Usage: npx tsx update-spl-limit.ts <MINT_ADDRESS> <NEW_LIMIT>
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";

const MIXER_PROGRAM_ID = new PublicKey("AjsXjQ7aoXGx3TFioFaHJrYGQVspPFdv4YNVPbkqrbkb");
const RPC_URL = "https://devnet.helius-rpc.com/?api-key=7853a445-0e8d-435d-8e33-c33d7df387ce";
const KEYPAIR_PATH = "/root/.config/solana/id.json";

async function main() {
  const mintAddress = process.argv[2];
  const newLimit = process.argv[3];
  if (!mintAddress || !newLimit) {
    console.error("Usage: npx tsx update-spl-limit.ts <MINT_ADDRESS> <NEW_LIMIT>");
    process.exit(1);
  }

  const mint = new PublicKey(mintAddress);
  const connection = new Connection(RPC_URL, "confirmed");
  const keypairData = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  const [treeAccountPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_tree"), mint.toBuffer()],
    MIXER_PROGRAM_ID,
  );

  const idl = JSON.parse(fs.readFileSync("/root/zodiac/relayer/zodiac_mixer.json", "utf-8"));
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  console.log(`Updating deposit limit for ${mint.toBase58()} to ${newLimit}...`);
  const tx = await (program.methods as any)
    .updateDepositLimitForSplToken(new anchor.BN(newLimit))
    .accounts({
      treeAccount: treeAccountPDA,
      mint: mint,
      authority: authority.publicKey,
    })
    .signers([authority])
    .rpc();

  console.log("Updated! Tx:", tx);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
