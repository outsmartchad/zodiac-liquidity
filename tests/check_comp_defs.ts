import { Connection, PublicKey } from "@solana/web3.js";
import { getArciumAccountBaseSeed, getCompDefAccOffset, getArciumProgramId } from "@arcium-hq/client";

const PROGRAM_ID = new PublicKey("7qpT6gRLFm1F9kHLSkHpcMPM6sbdWRNokQaqae1Zz3j2");
const circuits = ["init_vault","init_user_position","deposit","reveal_pending_deposits","record_liquidity","compute_withdrawal","get_user_position","clear_position"];

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  for (const name of circuits) {
    const offset = getCompDefAccOffset(name);
    const [pda] = PublicKey.findProgramAddressSync(
      [baseSeed, PROGRAM_ID.toBuffer(), offset],
      getArciumProgramId()
    );
    const info = await conn.getAccountInfo(pda);
    if (!info) { console.log(name + ": NOT FOUND"); continue; }
    const data = info.data;
    // Print size and first 64 bytes hex
    console.log(name + ": " + data.length + " bytes");
    // The hash is typically stored in the comp def data - let's find it
    // Try to extract the URL and hash from the data
    const dataStr = data.toString("utf8");
    const urlMatch = dataStr.match(/https?:\/\/[^\x00]+/);
    if (urlMatch) console.log("  url: " + urlMatch[0]);
  }

  // Also check mempool and execpool
  console.log("\nChecking execpool...");
  // Check recent computation accounts
}
main().catch(console.error);
