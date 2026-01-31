import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  AddressLookupTableProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage
} from '@solana/web3.js';
import * as anchor from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

let globalTestALT: PublicKey | null = null;

export function resetGlobalTestALT() {
  globalTestALT = null;
}

export async function createGlobalTestALT(
  connection: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> {
  if (globalTestALT) {
    return globalTestALT;
  }

  try {
    const recentSlot = await connection.getSlot('confirmed');

    let [lookupTableInst, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: recentSlot,
    });

    const createALTTx = new Transaction().add(lookupTableInst);

    try {
      await sendAndConfirmTransaction(connection, createALTTx, [payer]);
    } catch (error: any) {
      const isSlotTooOld =
        error.message?.includes('not a recent slot') ||
        error.transactionLogs?.some((log: string) => log.includes('not a recent slot'));

      if (isSlotTooOld) {
        const newerSlot = await connection.getSlot('finalized');

        [lookupTableInst, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
          authority: payer.publicKey,
          payer: payer.publicKey,
          recentSlot: newerSlot,
        });

        const retryCreateALTTx = new Transaction().add(lookupTableInst);
        await sendAndConfirmTransaction(connection, retryCreateALTTx, [payer]);
      } else {
        throw error;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const chunkSize = 20;
    const addressChunks = [];
    for (let i = 0; i < addresses.length; i += chunkSize) {
      addressChunks.push(addresses.slice(i, i + chunkSize));
    }

    for (let i = 0; i < addressChunks.length; i++) {
      const chunk = addressChunks[i];

      const extendInstruction = AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: lookupTableAddress,
        addresses: chunk,
      });

      const extendTx = new Transaction().add(extendInstruction);
      await sendAndConfirmTransaction(connection, extendTx, [payer]);

      if (i < addressChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const altAccount = await connection.getAddressLookupTable(lookupTableAddress);
    if (!altAccount.value) {
      throw new Error('Failed to create ALT');
    }

    globalTestALT = lookupTableAddress;
    return lookupTableAddress;

  } catch (error) {
    throw error;
  }
}

export function getTestProtocolAddresses(
  programId: PublicKey,
  authority: PublicKey,
  feeRecipient: PublicKey
): PublicKey[] {
  const [globalConfigAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    programId
  );

  const [treeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree')],
    programId
  );

  const [treeTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('tree_token')],
    programId
  );

  return [
    programId,
    treeAccount,
    treeTokenAccount,
    globalConfigAccount,
    authority,
    feeRecipient,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
  ];
}

export function getTestProtocolAddressesWithMint(
  programId: PublicKey,
  authority: PublicKey,
  treeAta: PublicKey,
  feeRecipient: PublicKey,
  feeRecipientAta: PublicKey,
  splTreeAccount: PublicKey,
  mint: PublicKey
): PublicKey[] {
  const [globalConfigAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_config')],
    programId
  );

  const [treeAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree')],
    programId
  );

  return [
    programId,
    treeAccount,
    treeAta,
    globalConfigAccount,
    authority,
    feeRecipient,
    feeRecipientAta,
    splTreeAccount,
    mint,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
  ];
}

export async function createVersionedTransactionWithALT(
  connection: Connection,
  payer: PublicKey,
  instructions: anchor.web3.TransactionInstruction[],
  altAddress: PublicKey
): Promise<VersionedTransaction> {
  const lookupTableAccount = await connection.getAddressLookupTable(altAddress);
  if (!lookupTableAccount.value) {
    throw new Error(`ALT not found: ${altAddress.toString()}`);
  }

  const recentBlockhash = await connection.getLatestBlockhash();

  const messageV0 = new anchor.web3.TransactionMessage({
    payerKey: payer,
    recentBlockhash: recentBlockhash.blockhash,
    instructions: instructions,
  }).compileToV0Message([lookupTableAccount.value]);

  return new VersionedTransaction(messageV0);
}

export async function sendAndConfirmVersionedTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  signers: Keypair[]
): Promise<string> {
  transaction.sign(signers);

  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });

  const latestBlockHash = await connection.getLatestBlockhash();

  await connection.confirmTransaction({
    blockhash: latestBlockHash.blockhash,
    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
    signature: signature,
  });

  return signature;
}

export function getGlobalTestALT(): PublicKey {
  if (!globalTestALT) {
    throw new Error('Global test ALT not created. Call createGlobalTestALT() first in before() hook');
  }
  return globalTestALT;
}

export function clearGlobalTestALT(): void {
  globalTestALT = null;
}
