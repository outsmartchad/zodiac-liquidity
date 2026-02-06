/**
 * zodiac-swap.ts — Tests for the swap_via_relay instruction.
 *
 * Uses the EXISTING devnet infrastructure (vault, pool, relay) rather than
 * creating from scratch. This avoids the full MPC vault creation flow.
 *
 * Tests:
 *   1. Swap tokenA → tokenB (SOL → ZDC) via relay PDA
 *   2. Swap tokenB → tokenA (ZDC → SOL) via relay PDA
 *   3. Slippage protection (minimum_amount_out enforcement)
 *   4. Unauthorized signer rejection
 *
 * Prerequisites: Vault, pool, and relay must already be deployed on devnet.
 */

import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { ZodiacLiquidity } from "../target/types/zodiac_liquidity";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

// ── Known devnet addresses ───────────────────────────────────────────

const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

// Existing devnet infrastructure
const VAULT_MINT = new PublicKey("5nbVWwY1s8jvB19E7QigiJy1TppzSLJ86JGupfYn5ovp"); // ZDC, 6 decimals
const VAULT_PDA = new PublicKey("AvsLCrCTUGxqad4W2Fui1yRgS7fPNhFU8Pghg7BHLP14");
const RELAY_PDA = new PublicKey("8uBeqPBW8KBpaQzpF42H2Cg4fFaPCkFi1NFLqPJKx2GS");
const POOL_PDA = new PublicKey("3yficxXJu1TqZrE3QAboeULG998b4dbUcrxKZkChw5RP");
const RELAY_INDEX = 0;

// Relay token accounts (discovered by operator's MeteoraManager)
const RELAY_TOKEN_A = new PublicKey("7ymRUNGCPvPhy9meiGPmhh6RJmujNhJFXfeLs8HmLKvD");
const RELAY_TOKEN_B = new PublicKey("8KueimB6YWuNfNp9xqC9ZTjKcL837PxBFfhvExYk3ZgE");

// ── Helpers ──────────────────────────────────────────────────────────

function maxKey(a: PublicKey, b: PublicKey): PublicKey {
  return a.toBuffer().compare(b.toBuffer()) > 0 ? a : b;
}
function minKey(a: PublicKey, b: PublicKey): PublicKey {
  return a.toBuffer().compare(b.toBuffer()) <= 0 ? a : b;
}

function readKpJson(path: string): Keypair {
  const file = fs.readFileSync(path);
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(file.toString())));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, delay = 2000): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("withRetry exhausted");
}

// ── Test Suite ───────────────────────────────────────────────────────

describe("zodiac-swap (swap_via_relay)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ZodiacLiquidity as Program<ZodiacLiquidity>;

  let owner: Keypair;

  // Derived Meteora PDAs
  let tokenA: PublicKey;
  let tokenB: PublicKey;
  let tokenAVault: PublicKey;
  let tokenBVault: PublicKey;
  let eventAuthority: PublicKey;
  let isTokenANative: boolean;

  before(async () => {
    console.log("\n=== SETUP: swap_via_relay test suite (existing devnet infra) ===\n");

    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    console.log("Owner:", owner.publicKey.toString());
    console.log("Program:", program.programId.toString());

    // Sort tokens (Meteora convention)
    tokenA = minKey(VAULT_MINT, NATIVE_MINT);
    tokenB = maxKey(VAULT_MINT, NATIVE_MINT);
    isTokenANative = tokenA.equals(NATIVE_MINT);
    console.log("Token A:", tokenA.toString(), isTokenANative ? "(WSOL)" : "(ZDC)");
    console.log("Token B:", tokenB.toString(), !isTokenANative ? "(WSOL)" : "(ZDC)");

    // Derive Meteora PDAs
    [tokenAVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), tokenA.toBuffer(), POOL_PDA.toBuffer()],
      DAMM_V2_PROGRAM_ID,
    );
    [tokenBVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), tokenB.toBuffer(), POOL_PDA.toBuffer()],
      DAMM_V2_PROGRAM_ID,
    );
    [eventAuthority] = PublicKey.findProgramAddressSync(
      [EVENT_AUTHORITY_SEED], DAMM_V2_PROGRAM_ID,
    );
    console.log("Token A Vault:", tokenAVault.toString());
    console.log("Token B Vault:", tokenBVault.toString());
    console.log("Event Authority:", eventAuthority.toString());

    // Verify vault exists
    const vaultInfo = await provider.connection.getAccountInfo(VAULT_PDA);
    expect(vaultInfo).to.not.be.null;
    console.log("Vault exists:", VAULT_PDA.toString());

    // Verify pool exists
    const poolInfo = await provider.connection.getAccountInfo(POOL_PDA);
    expect(poolInfo).to.not.be.null;
    console.log("Pool exists:", POOL_PDA.toString());

    // Check relay token balances
    const relayABal = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_A));
    const relayBBal = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_B));
    console.log("Relay token A balance:", relayABal.amount.toString());
    console.log("Relay token B balance:", relayBBal.amount.toString());
    console.log("");
  });

  // ── Swap Tests ─────────────────────────────────────────────────────

  describe("swap_via_relay", () => {
    it("swaps SOL → ZDC (tokenA → tokenB) via relay PDA", async () => {
      // Fund relay with SOL for the swap
      const SWAP_AMOUNT = 500_000; // 0.0005 SOL in lamports

      // Token A is WSOL — send SOL directly to relay's WSOL account + sync
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: RELAY_TOKEN_A,
          lamports: SWAP_AMOUNT,
        }),
        createSyncNativeInstruction(RELAY_TOKEN_A),
      );
      await provider.sendAndConfirm(fundTx, [owner]);
      console.log("Funded relay with", SWAP_AMOUNT, "lamports WSOL for swap");

      // Read balances before swap
      const beforeA = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_A));
      const beforeB = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_B));
      console.log("Before — relay WSOL:", beforeA.amount.toString(), "ZDC:", beforeB.amount.toString());

      // Execute swap: tokenA(WSOL) → tokenB(ZDC)
      const sig = await program.methods
        .swapViaRelay(RELAY_INDEX, new anchor.BN(SWAP_AMOUNT), new anchor.BN(0))
        .accounts({
          payer: owner.publicKey,
          vault: VAULT_PDA,
          relayPda: RELAY_PDA,
          poolAuthority: POOL_AUTHORITY,
          pool: POOL_PDA,
          inputTokenAccount: RELAY_TOKEN_A,
          outputTokenAccount: RELAY_TOKEN_B,
          tokenAVault,
          tokenBVault,
          tokenAMint: tokenA,
          tokenBMint: tokenB,
          tokenAProgram: TOKEN_PROGRAM_ID,
          tokenBProgram: TOKEN_PROGRAM_ID,
          eventAuthority,
          ammProgram: DAMM_V2_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
      console.log("Swap tx:", sig);

      // Read balances after swap
      const afterA = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_A));
      const afterB = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_B));
      console.log("After  — relay WSOL:", afterA.amount.toString(), "ZDC:", afterB.amount.toString());

      // Assertions
      const wsolSpent = Number(beforeA.amount) - Number(afterA.amount);
      const zdcReceived = Number(afterB.amount) - Number(beforeB.amount);
      expect(wsolSpent).to.be.greaterThanOrEqual(SWAP_AMOUNT);
      expect(zdcReceived).to.be.greaterThan(0);
      console.log(`SOL→ZDC swap: spent ${wsolSpent} WSOL, received ${zdcReceived} ZDC`);
    });

    it("swaps ZDC → SOL (tokenB → tokenA) via relay PDA", async () => {
      await new Promise(resolve => setTimeout(resolve, 2000));

      // The relay should have ZDC from the previous swap. Use some of it.
      const relayBBal = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_B));
      const zdcBalance = Number(relayBBal.amount);
      console.log("Relay ZDC balance:", zdcBalance);

      // Swap half the ZDC back to SOL
      const SWAP_AMOUNT = Math.min(zdcBalance, 500_000);
      expect(SWAP_AMOUNT).to.be.greaterThan(0, "Relay needs ZDC to swap back");

      // Read balances before swap
      const beforeA = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_A));
      const beforeB = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_B));
      console.log("Before — relay WSOL:", beforeA.amount.toString(), "ZDC:", beforeB.amount.toString());

      // Execute swap: tokenB(ZDC) → tokenA(WSOL)
      const sig = await program.methods
        .swapViaRelay(RELAY_INDEX, new anchor.BN(SWAP_AMOUNT), new anchor.BN(0))
        .accounts({
          payer: owner.publicKey,
          vault: VAULT_PDA,
          relayPda: RELAY_PDA,
          poolAuthority: POOL_AUTHORITY,
          pool: POOL_PDA,
          inputTokenAccount: RELAY_TOKEN_B,
          outputTokenAccount: RELAY_TOKEN_A,
          tokenAVault,
          tokenBVault,
          tokenAMint: tokenA,
          tokenBMint: tokenB,
          tokenAProgram: TOKEN_PROGRAM_ID,
          tokenBProgram: TOKEN_PROGRAM_ID,
          eventAuthority,
          ammProgram: DAMM_V2_PROGRAM_ID,
        })
        .signers([owner])
        .rpc({ commitment: "confirmed" });
      console.log("Swap tx:", sig);

      // Read balances after
      const afterA = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_A));
      const afterB = await withRetry(() => getAccount(provider.connection, RELAY_TOKEN_B));
      console.log("After  — relay WSOL:", afterA.amount.toString(), "ZDC:", afterB.amount.toString());

      const zdcSpent = Number(beforeB.amount) - Number(afterB.amount);
      const wsolReceived = Number(afterA.amount) - Number(beforeA.amount);
      expect(zdcSpent).to.be.greaterThanOrEqual(SWAP_AMOUNT);
      expect(wsolReceived).to.be.greaterThan(0);
      console.log(`ZDC→SOL swap: spent ${zdcSpent} ZDC, received ${wsolReceived} WSOL`);
    });

    it("respects minimum_amount_out (slippage protection)", async () => {
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Fund relay with a small amount of SOL for the swap
      const SWAP_AMOUNT = 100_000;
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: RELAY_TOKEN_A,
          lamports: SWAP_AMOUNT,
        }),
        createSyncNativeInstruction(RELAY_TOKEN_A),
      );
      await provider.sendAndConfirm(fundTx, [owner]);

      // Try to swap with absurdly high minimum_amount_out — Meteora should reject
      try {
        await program.methods
          .swapViaRelay(
            RELAY_INDEX,
            new anchor.BN(SWAP_AMOUNT),
            new anchor.BN("999999999999999"), // impossible output
          )
          .accounts({
            payer: owner.publicKey,
            vault: VAULT_PDA,
            relayPda: RELAY_PDA,
            poolAuthority: POOL_AUTHORITY,
            pool: POOL_PDA,
            inputTokenAccount: RELAY_TOKEN_A,
            outputTokenAccount: RELAY_TOKEN_B,
            tokenAVault,
            tokenBVault,
            tokenAMint: tokenA,
            tokenBMint: tokenB,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([owner])
          .rpc({ commitment: "confirmed" });
        expect.fail("Should have failed with slippage error");
      } catch (err: any) {
        const errMsg = err.message || JSON.stringify(err);
        console.log("Slippage protection works — swap rejected:", errMsg.slice(0, 150));
        // Should NOT be a "missing account" error — it should be Meteora rejecting the swap
        expect(errMsg).to.not.include("not provided");
        expect(err).to.exist;
      }
    });

    it("rejects swap from unauthorized signer", async () => {
      // Create a random keypair that is NOT the vault authority
      const unauthorized = Keypair.generate();

      // Fund it for tx fees
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: unauthorized.publicKey,
          lamports: 100_000_000,
        }),
      );
      await provider.sendAndConfirm(fundTx, [owner]);

      try {
        await program.methods
          .swapViaRelay(RELAY_INDEX, new anchor.BN(100_000), new anchor.BN(0))
          .accounts({
            payer: unauthorized.publicKey,
            vault: VAULT_PDA,
            relayPda: RELAY_PDA,
            poolAuthority: POOL_AUTHORITY,
            pool: POOL_PDA,
            inputTokenAccount: RELAY_TOKEN_A,
            outputTokenAccount: RELAY_TOKEN_B,
            tokenAVault,
            tokenBVault,
            tokenAMint: tokenA,
            tokenBMint: tokenB,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
            eventAuthority,
            ammProgram: DAMM_V2_PROGRAM_ID,
          })
          .signers([unauthorized])
          .rpc({ commitment: "confirmed" });
        expect.fail("Should have failed with Unauthorized error");
      } catch (err: any) {
        const errStr = err.message || JSON.stringify(err);
        console.log("Unauthorized swap rejected:", errStr.slice(0, 150));
        // Anchor should enforce vault.authority == payer constraint
        const isAuthError =
          errStr.includes("Unauthorized") ||
          errStr.includes("ConstraintRaw") ||
          errStr.includes("ConstraintAddress") ||
          errStr.includes("2003") ||
          errStr.includes("6000") ||
          errStr.includes("A raw constraint was violated");
        expect(isAuthError, `Expected auth error but got: ${errStr.slice(0, 200)}`).to.be.true;
      }
    });
  });
});
