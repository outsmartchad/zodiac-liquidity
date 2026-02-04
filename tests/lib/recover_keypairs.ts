#!/usr/bin/env ts-node
/**
 * Recovery script — drains SOL from all saved test keypairs back to your wallet.
 *
 * Usage:
 *   cd /root/zodiac/onchain
 *   npx ts-node --skip-project tests/lib/recover_keypairs.ts
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const VAULT_DIR = path.resolve(__dirname, "../../.keypair-vault");
const DEST_WALLET_PATH = `${os.homedir()}/.config/solana/id.json`;
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  // Load destination wallet
  const destKpRaw = JSON.parse(fs.readFileSync(DEST_WALLET_PATH, "utf-8"));
  const destPubkey = Keypair.fromSecretKey(Uint8Array.from(destKpRaw)).publicKey;
  console.log(`Destination wallet: ${destPubkey.toString()}`);
  console.log(`RPC: ${RPC_URL}\n`);

  if (!fs.existsSync(VAULT_DIR)) {
    console.log("No vault directory found. Nothing to recover.");
    return;
  }

  const files = fs.readdirSync(VAULT_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log("No vault files found. Nothing to recover.");
    return;
  }

  let totalRecovered = 0;
  let totalAccounts = 0;

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, file), "utf-8"));
    console.log(`=== ${raw.testSuite} (${raw.keypairs.length} keypairs, saved ${raw.createdAt}) ===`);

    for (const entry of raw.keypairs) {
      const kp = Keypair.fromSecretKey(Uint8Array.from(entry.secretKey));
      const balance = await connection.getBalance(kp.publicKey);

      if (balance <= 5000) {
        console.log(`  ${entry.label} (${entry.pubkey}): ${balance} lamports — skip`);
        continue;
      }

      const returnAmount = balance - 5000;
      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: destPubkey,
            lamports: returnAmount,
          })
        );
        tx.feePayer = kp.publicKey;
        const sig = await connection.sendTransaction(tx, [kp]);
        const bh = await connection.getLatestBlockhash();
        await connection.confirmTransaction({
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
          signature: sig,
        });
        console.log(
          `  ${entry.label}: recovered ${(returnAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL ✓`
        );
        totalRecovered += returnAmount;
        totalAccounts++;
      } catch (e: any) {
        console.log(`  ${entry.label}: FAILED — ${e.message?.substring(0, 80)}`);
      }
    }
  }

  console.log(`\nRecovered ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL from ${totalAccounts} accounts`);

  // Clean up vault files after successful recovery
  if (totalAccounts > 0) {
    for (const file of files) {
      fs.unlinkSync(path.join(VAULT_DIR, file));
    }
    console.log("Vault files cleaned up.");
  }

  const finalBal = await connection.getBalance(destPubkey);
  console.log(`Wallet balance: ${(finalBal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

main().catch(console.error);
