/**
 * Close ALL token accounts for the wallet.
 * - WSOL: close (unwraps SOL back)
 * - Non-WSOL with balance: burn then close
 * - Zero balance: close directly
 * Also handles Token-2022 accounts.
 */

import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, createBurnInstruction } from "@solana/spl-token";
import * as fs from "fs";
import BN from "bn.js";

const RPC_URL = "https://api.devnet.solana.com";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface TokenAccountInfo {
  pubkey: PublicKey;
  mint: PublicKey;
  amount: string; // raw amount as string
  decimals: number;
  programId: PublicKey;
}

async function getAllTokenAccounts(connection: Connection, owner: PublicKey): Promise<TokenAccountInfo[]> {
  const accounts: TokenAccountInfo[] = [];

  // Get SPL Token accounts
  const splAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: TOKEN_PROGRAM_ID,
  });
  for (const { pubkey, account } of splAccounts.value) {
    const parsed = account.data.parsed.info;
    accounts.push({
      pubkey,
      mint: new PublicKey(parsed.mint),
      amount: parsed.tokenAmount.amount,
      decimals: parsed.tokenAmount.decimals,
      programId: TOKEN_PROGRAM_ID,
    });
  }

  // Get Token-2022 accounts
  const t22Accounts = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: TOKEN_2022_PROGRAM_ID,
  });
  for (const { pubkey, account } of t22Accounts.value) {
    const parsed = account.data.parsed.info;
    accounts.push({
      pubkey,
      mint: new PublicKey(parsed.mint),
      amount: parsed.tokenAmount.amount,
      decimals: parsed.tokenAmount.decimals,
      programId: TOKEN_2022_PROGRAM_ID,
    });
  }

  return accounts;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const keypairData = JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  const startBalance = await connection.getBalance(wallet.publicKey);
  console.log("Wallet: " + wallet.publicKey.toBase58());
  console.log("Starting balance: " + (startBalance / 1e9) + " SOL\n");

  const allAccounts = await getAllTokenAccounts(connection, wallet.publicKey);
  console.log("Total token accounts: " + allAccounts.length);

  const wsol = allAccounts.filter(a => a.mint.toBase58() === WSOL_MINT);
  const nonWsol = allAccounts.filter(a => a.mint.toBase58() !== WSOL_MINT);
  const zeroBalance = nonWsol.filter(a => a.amount === "0");
  const withBalance = nonWsol.filter(a => a.amount !== "0");

  console.log("WSOL accounts: " + wsol.length);
  console.log("Non-WSOL zero balance: " + zeroBalance.length);
  console.log("Non-WSOL with balance: " + withBalance.length + "\n");

  let closed = 0;
  let failed = 0;

  // Batch close in transactions of up to 10 instructions each
  async function processBatch(accounts: TokenAccountInfo[], label: string, needsBurn: boolean) {
    console.log("--- " + label + " (" + accounts.length + " accounts) ---");

    for (let i = 0; i < accounts.length; i += 6) {
      const batch = accounts.slice(i, i + 6);
      const tx = new Transaction();

      for (const acct of batch) {
        // Burn tokens first if needed
        if (needsBurn && acct.amount !== "0") {
          tx.add(createBurnInstruction(
            acct.pubkey,
            acct.mint,
            wallet.publicKey,
            BigInt(acct.amount),
            [],
            acct.programId,
          ));
        }

        // Close account
        tx.add(createCloseAccountInstruction(
          acct.pubkey,
          wallet.publicKey, // destination for rent
          wallet.publicKey, // authority
          [],
          acct.programId,
        ));
      }

      try {
        tx.feePayer = wallet.publicKey;
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(wallet);

        const sig = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await connection.confirmTransaction(sig, "confirmed");

        closed += batch.length;
        console.log("  Closed " + batch.length + " accounts (" + (i + batch.length) + "/" + accounts.length + ") " + sig.slice(0, 16) + "...");
      } catch (e: any) {
        // If batch fails, try one by one
        for (const acct of batch) {
          try {
            const singleTx = new Transaction();
            if (needsBurn && acct.amount !== "0") {
              singleTx.add(createBurnInstruction(
                acct.pubkey, acct.mint, wallet.publicKey,
                BigInt(acct.amount), [], acct.programId,
              ));
            }
            singleTx.add(createCloseAccountInstruction(
              acct.pubkey, wallet.publicKey, wallet.publicKey, [], acct.programId,
            ));
            singleTx.feePayer = wallet.publicKey;
            const { blockhash: bh } = await connection.getLatestBlockhash();
            singleTx.recentBlockhash = bh;
            singleTx.sign(wallet);

            const sig2 = await connection.sendRawTransaction(singleTx.serialize(), { maxRetries: 3 });
            await connection.confirmTransaction(sig2, "confirmed");
            closed++;
            console.log("  Closed 1 account (retry) " + acct.pubkey.toBase58().slice(0, 12) + "...");
          } catch (e2: any) {
            failed++;
            console.log("  FAIL " + acct.pubkey.toBase58().slice(0, 12) + "... " + ((e2.message || e2).toString()).slice(0, 80));
          }
          await sleep(300);
        }
      }

      await sleep(400);
    }
  }

  // 1. Close WSOL accounts (unwraps SOL)
  await processBatch(wsol, "WSOL accounts (unwrap SOL)", false);

  // 2. Close zero-balance accounts
  await processBatch(zeroBalance, "Zero-balance accounts", false);

  // 3. Burn and close accounts with balance
  await processBatch(withBalance, "Burn + close accounts", true);

  const endBalance = await connection.getBalance(wallet.publicKey);
  console.log("\n=== RESULTS ===");
  console.log("Closed: " + closed);
  console.log("Failed: " + failed);
  console.log("SOL recovered: " + ((endBalance - startBalance) / 1e9) + " SOL");
  console.log("Final balance: " + (endBalance / 1e9) + " SOL");
}

main().catch(console.error);
