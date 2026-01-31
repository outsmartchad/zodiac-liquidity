import BN from 'bn.js';
import { ethers } from 'ethers';
import { LightWasm } from '@lightprotocol/hasher.rs';

const FIELD_SIZE = new BN(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

export class Keypair {
  public privkey: BN;
  public pubkey: BN;
  private lightWasm: LightWasm;

  constructor(privkeyHex: string, lightWasm: LightWasm) {
    const rawDecimal = BigInt(privkeyHex);
    this.privkey = new BN((rawDecimal % BigInt(FIELD_SIZE.toString())).toString());
    this.lightWasm = lightWasm;
    this.pubkey = new BN(this.lightWasm.poseidonHashString([this.privkey.toString()]));
  }

  sign(commitment: string, merklePath: string): string {
    return this.lightWasm.poseidonHashString([this.privkey.toString(), commitment, merklePath]);
  }

  static generateNew(lightWasm: LightWasm): Keypair {
    const wallet = ethers.Wallet.createRandom();
    return new Keypair(wallet.privateKey, lightWasm);
  }
}
