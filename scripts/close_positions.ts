/**
 * Close all Meteora DAMM v2 positions owned by the wallet.
 * For each position: claim fees -> remove all liquidity -> close position (burns NFT, returns rent)
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction, Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import * as fs from "fs";
import BN from "bn.js";

const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const RPC_URL = "https://api.devnet.solana.com";

// All 31 NFT mints (30 with liquidity + 1 "empty" that has pending fees)
const ALL_NFT_MINTS = [
  "13MRH4tZeDoCf6fRcU73mP9AtkTGyEo89khPcKMn3RvJ",
  "tCmV7zXMm4cncah6RDksFrkkWtycj4YBk5cX4qA7XLg",
  "37hLbmnape2fLxJeBz1mRTFGm21rbPEKMnJX1BXitmW2",
  "3rJjECpjW1FYWJAqZQ9hWpb8aRh6AQZDioYeUJq7XAtY",
  "5ExfH7wx9jJS9T67vNyNN1H4VKUgPFLBTzVrYeZCdYn4",
  "5Koa1w8dSedu35tnhXx37MijgKQoVLdr4dsRo4JoHKM3",
  "5RKDrh2x3BoGyS7qreJv2X45SNQVt8BsrvjyAD7naR7C",
  "5q7SUqxZzTpBJW8JTjNBHt4dg3X3pbLdPDv7X9RR74A2",
  "68Lt1pyN3GNwKrCppoZ7AtmDEFXdyNohiVZRht3CbmgF",
  "6iF4qQRj8aWtwXqQ7PF1Nb6yXZXf1aCbrGiaydcz9rcw",
  "7cHfgFTTZgRFfNaqru8Xq3xAYainUDAyUcR2cVkWd9TV",
  "7qbYUikwQSCctwtqnsUqWZbkwvSYr8T1N81D8ABB5u78",
  "8KstdcpCUZfe36H5cswqMFYcwTdtBsXKUdsvkTn91XSN",
  "8xHUe549QvfFnMcfapaU2ByENZeYk6xTaJp56BWpacDv",
  "8xeE8kCmqvYr9M14qK5HkmCtRqx5pVetQSgXaSxdzhzh",
  "8zpUYJE4vhwqQ4SHFWubKbwRpBsFd2Q1VX9yMadg14w1",
  "94T7ovGZpYJ1tWhBp1x5dA4YZNJby94Zfn2Pxep4yRG5",
  "9GR5AF7jGKEwcFeDM2dtfazTHYjmfqKEZH2zy9Z9hYEi",
  "Ap86SEkbNELaeae26xhJCiTqh5y8nmSqxW7vyEwN1kLk",
  "Aum2CSu4FVfsUoCtsmmNpdHpmmzvwX3dSe3eM5vQq7eo",
  "BCLqdpdS3HoWhi9VFMmDavGcbFXYbBfMvE6cD7YbNG4f",
  "BWEjH2QzooeUvwnGxFWiuyb6zc95ytGATzAdFcYC39Ww",
  "BcBhDkVjF2RrCwte2MVFq1zkUKiUbPdZ9WPVF4GhQbNs",
  "BrmTNoWCpzXKcHkYfsqEppwPmKM4oKzZidsZv7Cczc6c",
  "CszoHH4ZmaojyD388q23JLRubdMHrVoffcsJbHRLWMXt",
  "DPDaoacRLEuNBj4cYup5zWoVvmGEtLDr1qEPvAK8wG9b",
  "DRDN9EPWJgFyGo3BNsmkw2Qr4f5xZHDcUHABEdxDJKpF",
  "E4DUtVTS2ay22XWuFpVd8UaciyafJDTL6xL3ygiEWX4d",
  "EnbLKi1HMAkdr7iFFgaG76g5KbZ7D4PEd4mrXGpmzRzQ",
  "GMFAr2DiQwdsaH5zjNANJ9RSKx3pihBxHLQw8NyWsyzp",
  "J63Fyw25xirdgKi3drmHcfLpmHjwg5TBcEd3hin3GSpV",
];

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const keypairData = JSON.parse(fs.readFileSync(
    process.env.HOME + "/.config/solana/id.json", "utf-8"
  ));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  const anchorWallet = new anchor.Wallet(wallet);
  const provider = new anchor.AnchorProvider(connection, anchorWallet, {
    commitment: "confirmed",
  });

  console.log("Wallet: " + wallet.publicKey.toBase58());
  const startBalance = await connection.getBalance(wallet.publicKey);
  console.log("Starting balance: " + (startBalance / 1e9) + " SOL\n");

  const idlJson = JSON.parse(fs.readFileSync("./idls/damm_v2.json", "utf-8"));
  const program = new anchor.Program(idlJson, provider);

  let closed = 0;
  let failed = 0;

  console.log("=== Processing " + ALL_NFT_MINTS.length + " positions ===\n");

  for (const mintStr of ALL_NFT_MINTS) {
    const nftMint = new PublicKey(mintStr);

    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), nftMint.toBuffer()],
      DAMM_V2_PROGRAM_ID
    );
    const [positionNftAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("position_nft_account"), nftMint.toBuffer()],
      DAMM_V2_PROGRAM_ID
    );

    try {
      const positionInfo = await connection.getAccountInfo(position);
      if (!positionInfo) {
        console.log("  SKIP " + mintStr.slice(0, 12) + "... no position account");
        failed++;
        continue;
      }

      const data = positionInfo.data;
      const poolPubkey = new PublicKey(data.subarray(8, 40));

      // Fetch pool to get token mints
      const poolInfo = await connection.getAccountInfo(poolPubkey);
      if (!poolInfo) {
        console.log("  SKIP " + mintStr.slice(0, 12) + "... no pool account");
        failed++;
        continue;
      }

      // Pool layout: 8 disc + 160 pool_fees + token_a_mint(32) + token_b_mint(32) ...
      const tokenAMint = new PublicKey(poolInfo.data.subarray(168, 200));
      const tokenBMint = new PublicKey(poolInfo.data.subarray(200, 232));

      const [tokenAVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tokenAMint.toBuffer(), poolPubkey.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );
      const [tokenBVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault"), tokenBMint.toBuffer(), poolPubkey.toBuffer()],
        DAMM_V2_PROGRAM_ID
      );

      // Determine token programs for each mint
      const tokenAMintInfo = await connection.getAccountInfo(tokenAMint);
      const tokenBMintInfo = await connection.getAccountInfo(tokenBMint);
      if (!tokenAMintInfo || !tokenBMintInfo) {
        console.log("  SKIP " + mintStr.slice(0, 12) + "... mint account missing");
        failed++;
        continue;
      }
      const tokenAProgram = tokenAMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const tokenBProgram = tokenBMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

      const tokenAAccount = getAssociatedTokenAddressSync(
        tokenAMint, wallet.publicKey, false, tokenAProgram
      );
      const tokenBAccount = getAssociatedTokenAddressSync(
        tokenBMint, wallet.publicKey, false, tokenBProgram
      );

      const tx = new Transaction();

      // Create ATAs if they don't exist
      const tokenAAcctInfo = await connection.getAccountInfo(tokenAAccount);
      if (!tokenAAcctInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          wallet.publicKey, tokenAAccount, wallet.publicKey, tokenAMint, tokenAProgram
        ));
      }
      const tokenBAcctInfo = await connection.getAccountInfo(tokenBAccount);
      if (!tokenBAcctInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          wallet.publicKey, tokenBAccount, wallet.publicKey, tokenBMint, tokenBProgram
        ));
      }

      // Always: claim fees + remove all liquidity + close position
      // (claim_fee is safe even with zero fees, remove_all is safe with zero liquidity)

      // 1. Claim fees
      tx.add(await program.methods
        .claimPositionFee()
        .accountsPartial({
          poolAuthority: POOL_AUTHORITY,
          pool: poolPubkey,
          position: position,
          tokenAAccount: tokenAAccount,
          tokenBAccount: tokenBAccount,
          tokenAVault: tokenAVault,
          tokenBVault: tokenBVault,
          tokenAMint: tokenAMint,
          tokenBMint: tokenBMint,
          positionNftAccount: positionNftAccount,
          owner: wallet.publicKey,
          tokenAProgram: tokenAProgram,
          tokenBProgram: tokenBProgram,
        })
        .instruction());

      // 2. Remove ALL liquidity
      tx.add(await program.methods
        .removeAllLiquidity(
          new BN(0),
          new BN(0),
        )
        .accountsPartial({
          poolAuthority: POOL_AUTHORITY,
          pool: poolPubkey,
          position: position,
          tokenAAccount: tokenAAccount,
          tokenBAccount: tokenBAccount,
          tokenAVault: tokenAVault,
          tokenBVault: tokenBVault,
          tokenAMint: tokenAMint,
          tokenBMint: tokenBMint,
          positionNftAccount: positionNftAccount,
          owner: wallet.publicKey,
          tokenAProgram: tokenAProgram,
          tokenBProgram: tokenBProgram,
        })
        .instruction());

      // 3. Close position (burns NFT, returns position + NFT account rent)
      tx.add(await program.methods
        .closePosition()
        .accountsPartial({
          positionNftMint: nftMint,
          positionNftAccount: positionNftAccount,
          pool: poolPubkey,
          position: position,
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
      const msg = e.message || String(e);
      // Extract the key error info
      if (e.logs) {
        const errorLog = e.logs.find((l: string) => l.includes("Error") || l.includes("error"));
        if (errorLog) {
          console.log("  FAIL " + mintStr.slice(0, 12) + "... " + errorLog.slice(0, 120));
        } else {
          console.log("  FAIL " + mintStr.slice(0, 12) + "... " + msg.slice(0, 120));
        }
      } else {
        console.log("  FAIL " + mintStr.slice(0, 12) + "... " + msg.slice(0, 120));
      }
      failed++;
    }

    await sleep(500);
  }

  const endBalance = await connection.getBalance(wallet.publicKey);
  console.log("\n=== RESULTS ===");
  console.log("Closed: " + closed);
  console.log("Failed: " + failed);
  console.log("SOL recovered: " + ((endBalance - startBalance) / 1e9) + " SOL");
  console.log("Final balance: " + (endBalance / 1e9) + " SOL");
}

main().catch(console.error);
