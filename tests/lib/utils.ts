import * as anchor from "@coral-xyz/anchor";
import { utils } from "ffjavascript";
import BN from 'bn.js';
import { Utxo } from './utxo';
import * as borsh from 'borsh';
import { sha256 } from '@ethersproject/sha2';
import { PublicKey } from '@solana/web3.js';

export function bnToBytes(bn: anchor.BN): number[] {
  return Array.from(
    utils.leInt2Buff(utils.unstringifyBigInts(bn.toString()), 32)
  ).reverse() as number[];
}

export function mockEncrypt(value: Utxo): string {
  return JSON.stringify(value);
}

export function getExtDataHash(extData: {
  recipient: string | PublicKey;
  extAmount: string | number | BN;
  encryptedOutput1?: string | Uint8Array;
  encryptedOutput2?: string | Uint8Array;
  fee: string | number | BN;
  feeRecipient: string | PublicKey;
  mintAddress: string | PublicKey;
}): Uint8Array {
  const recipient = extData.recipient instanceof PublicKey
    ? extData.recipient
    : new PublicKey(extData.recipient);

  const feeRecipient = extData.feeRecipient instanceof PublicKey
    ? extData.feeRecipient
    : new PublicKey(extData.feeRecipient);

  const mintAddress = extData.mintAddress instanceof PublicKey
    ? extData.mintAddress
    : new PublicKey(extData.mintAddress);

  const extAmount = new BN(extData.extAmount.toString());
  const fee = new BN(extData.fee.toString());

  const encryptedOutput1 = extData.encryptedOutput1
    ? Buffer.from(extData.encryptedOutput1 as any)
    : Buffer.alloc(0);
  const encryptedOutput2 = extData.encryptedOutput2
    ? Buffer.from(extData.encryptedOutput2 as any)
    : Buffer.alloc(0);

  const schema = {
    struct: {
      recipient: { array: { type: 'u8', len: 32 } },
      extAmount: 'i64',
      encryptedOutput1: { array: { type: 'u8' } },
      encryptedOutput2: { array: { type: 'u8' } },
      fee: 'u64',
      feeRecipient: { array: { type: 'u8', len: 32 } },
      mintAddress: { array: { type: 'u8', len: 32 } },
    }
  };

  const value = {
    recipient: recipient.toBytes(),
    extAmount: extAmount,
    encryptedOutput1: encryptedOutput1,
    encryptedOutput2: encryptedOutput2,
    fee: fee,
    feeRecipient: feeRecipient.toBytes(),
    mintAddress: mintAddress.toBytes(),
  };

  const serializedData = borsh.serialize(schema, value);
  const hashHex = sha256(serializedData);
  return Buffer.from(hashHex.slice(2), 'hex');
}

export function getMintAddressField(mint: PublicKey): string {
  const mintStr = mint.toString();

  if (mintStr === '11111111111111111111111111111112') {
    return mintStr;
  }

  const mintBytes = mint.toBytes();
  return new anchor.BN(mintBytes.slice(0, 31), 'be').toString();
}
