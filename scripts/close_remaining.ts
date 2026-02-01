/**
 * Close remaining positions that failed with AmountIsZero.
 * Strategy: claim fees only + close position (skip removeAllLiquidity)
 * The liquidity amounts are so small they round to zero tokens.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import * as fs from "fs";

const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const RPC_URL = "https://api.devnet.solana.com";

// Failed mints from first run
const FAILED_MINTS = [
  "5Koa1w8dSedu35tnhXx37MijgKQoVLdr4dsRo4JoHKM3",
  "68Lt1pyN3GNwKrCppoZ7AtmDEFXdyNohiVZRht3CbmgF",
  "8KstdcpCUZfe36H5cswqMFYcwTdtBsXKUdsvkTn91XSN",
  "8xHUe549QvfFnMcfapaU2ByENZeYk6xTaJp56BWpacDv",
  "8xeE8kCmqvYr9M14qK5HkmCtRqx5pVetQSgXaSxdzhzh",
  "Ap86SEkbNELaeae26xhJCiTqh5y8nmSqxW7vyEwN1kLk",
  "J63Fyw25xirdgKi3drmHcfLpmHjwg5TBcEd3hin3GSpV",
];

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const keypairData = JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });

  const startBalance = await connection.getBalance(wallet.publicKey);
  console.log("Starting balance: " + (startBalance / 1e9) + " SOL\n");

  const idlJson = JSON.parse(fs.readFileSync("./idls/damm_v2.json", "utf-8"));
  const program = new anchor.Program(idlJson, provider);

  let closed = 0;

  for (const mintStr of FAILED_MINTS) {
    const nftMint = new PublicKey(mintStr);
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), nftMint.toBuffer()], DAMM_V2_PROGRAM_ID
    );
    const [positionNftAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("position_nft_account"), nftMint.toBuffer()], DAMM_V2_PROGRAM_ID
    );

    try {
      const positionInfo = await connection.getAccountInfo(position);
      if (!positionInfo) { console.log("  SKIP " + mintStr.slice(0, 12)); continue; }

      const poolPubkey = new PublicKey(positionInfo.data.subarray(8, 40));
      const poolInfo = await connection.getAccountInfo(poolPubkey);
      if (!poolInfo) { console.log("  SKIP " + mintStr.slice(0, 12) + " no pool"); continue; }

      const tokenAMint = new PublicKey(poolInfo.data.subarray(168, 200));
      const tokenBMint = new PublicKey(poolInfo.data.subarray(200, 232));

      const [tokenAVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tokenAMint.toBuffer(), poolPubkey.toBuffer()], DAMM_V2_PROGRAM_ID
      );
      const [tokenBVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tokenBMint.toBuffer(), poolPubkey.toBuffer()], DAMM_V2_PROGRAM_ID
      );

      const tokenAMintInfo = await connection.getAccountInfo(tokenAMint);
      const tokenBMintInfo = await connection.getAccountInfo(tokenBMint);
      const tokenAProgram = (tokenAMintInfo && tokenAMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
        ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const tokenBProgram = (tokenBMintInfo && tokenBMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
        ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

      const tokenAAccount = getAssociatedTokenAddressSync(tokenAMint, wallet.publicKey, false, tokenAProgram);
      const tokenBAccount = getAssociatedTokenAddressSync(tokenBMint, wallet.publicKey, false, tokenBProgram);

      const tx = new Transaction();

      // Create ATAs if needed
      if (!(await connection.getAccountInfo(tokenAAccount))) {
        tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, tokenAAccount, wallet.publicKey, tokenAMint, tokenAProgram));
      }
      if (!(await connection.getAccountInfo(tokenBAccount))) {
        tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey, tokenBAccount, wallet.publicKey, tokenBMint, tokenBProgram));
      }

      // Only claim fees (skip removeAllLiquidity since amounts round to zero)
      tx.add(await program.methods
        .claimPositionFee()
        .accountsPartial({
          poolAuthority: POOL_AUTHORITY, pool: poolPubkey, position: position,
          tokenAAccount, tokenBAccount, tokenAVault, tokenBVault,
          tokenAMint, tokenBMint, positionNftAccount,
          owner: wallet.publicKey, tokenAProgram, tokenBProgram,
        })
        .instruction());

      // Close position
      tx.add(await program.methods
        .closePosition()
        .accountsPartial({
          positionNftMint: nftMint, positionNftAccount,
          pool: poolPubkey, position,
          poolAuthority: POOL_AUTHORITY,
          rentReceiver: wallet.publicKey,
          owner: wallet.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction());

      const sig = await provider.sendAndConfirm(tx);
      console.log("  OK " + mintStr.slice(0, 12) + "... closed (" + sig.slice(0, 16) + "...)");
      closed++;
    } catch (e: any) {
      if (e.logs) {
        const errLog = e.logs.find((l: string) => l.includes("Error"));
        console.log("  FAIL " + mintStr.slice(0, 12) + "... " + (errLog || e.message).slice(0, 120));
      } else {
        console.log("  FAIL " + mintStr.slice(0, 12) + "... " + (e.message || e).toString().slice(0, 120));
      }
    }
    await sleep(500);
  }

  const endBalance = await connection.getBalance(wallet.publicKey);
  console.log("\nClosed: " + closed + "/" + FAILED_MINTS.length);
  console.log("SOL recovered: " + ((endBalance - startBalance) / 1e9));
  console.log("Final balance: " + (endBalance / 1e9) + " SOL");
}

main().catch(console.error);
