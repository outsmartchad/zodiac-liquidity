import * as anchor from "@coral-xyz/anchor";
import { wtns, groth16 } from 'snarkjs'
import { utils } from 'ffjavascript'
import * as fs from 'fs'
import * as tmp from 'tmp-promise'
import { promisify } from 'util'
import { exec as execCallback } from 'child_process'
import { FIELD_SIZE } from './constants'

type WtnsModule = {
  debug: (input: any, wasmFile: string, wtnsFile: string, symFile: string, options: any, logger: any) => Promise<void>
  exportJson: (wtnsFile: string) => Promise<any>
}

type Groth16Module = {
  fullProve: (input: any, wasmFile: string, zkeyFile: string) => Promise<{ proof: Proof; publicSignals: string[] }>
  verify: (vkeyData: any, publicSignals: any, proof: Proof) => Promise<boolean>
}

type UtilsModule = {
  stringifyBigInts: (obj: any) => any
  unstringifyBigInts: (obj: any) => any
}

const wtnsTyped = wtns as unknown as WtnsModule
const groth16Typed = groth16 as unknown as Groth16Module
const utilsTyped = utils as unknown as UtilsModule

const exec = promisify(execCallback)

interface Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

interface ProofResult {
  proof: Proof
}

async function prove(input: any, keyBasePath: string): Promise<{
  proof: Proof
  publicSignals: string[];
}> {
  return await groth16Typed.fullProve(
    utilsTyped.stringifyBigInts(input),
    `${keyBasePath}.wasm`,
    `${keyBasePath}.zkey`,
  )
}

async function verify(verificationKeyPath: string, publicSignals: any, proof: any): Promise<boolean> {
  const vKey = JSON.parse(fs.readFileSync(`${verificationKeyPath}`, 'utf8'));
  const res = await groth16Typed.verify(vKey, publicSignals, proof);
  return res;
}

export function parseProofToBytesArray(
  proof: Proof,
  compressed: boolean = false,
): {
  proofA: number[];
  proofB: number[][];
  proofC: number[];
} {
  const proofJson = JSON.stringify(proof, null, 1);
  const mydata = JSON.parse(proofJson.toString());
  try {
    for (const i in mydata) {
      if (i == "pi_a" || i == "pi_c") {
        for (const j in mydata[i]) {
          mydata[i][j] = Array.from(
            utils.leInt2Buff(utils.unstringifyBigInts(mydata[i][j]), 32),
          ).reverse();
        }
      } else if (i == "pi_b") {
        for (const j in mydata[i]) {
          for (const z in mydata[i][j]) {
            mydata[i][j][z] = Array.from(
              utils.leInt2Buff(utils.unstringifyBigInts(mydata[i][j][z]), 32),
            );
          }
        }
      }
    }

    if (compressed) {
      const proofA = mydata.pi_a[0];
      const proofAIsPositive = yElementIsPositiveG1(
        new anchor.BN(mydata.pi_a[1]),
      )
        ? false
        : true;
      proofA[0] = addBitmaskToByte(proofA[0], proofAIsPositive);
      const proofB = mydata.pi_b[0].flat().reverse();
      const proofBY = mydata.pi_b[1].flat().reverse();
      const proofBIsPositive = yElementIsPositiveG2(
        new anchor.BN(proofBY.slice(0, 32)),
        new anchor.BN(proofBY.slice(32, 64)),
      );
      proofB[0] = addBitmaskToByte(proofB[0], proofBIsPositive);
      const proofC = mydata.pi_c[0];
      const proofCIsPositive = yElementIsPositiveG1(
        new anchor.BN(mydata.pi_c[1]),
      );
      proofC[0] = addBitmaskToByte(proofC[0], proofCIsPositive);
      return {
        proofA,
        proofB,
        proofC,
      };
    }
    return {
      proofA: [mydata.pi_a[0], mydata.pi_a[1]].flat(),
      proofB: [
        mydata.pi_b[0].flat().reverse(),
        mydata.pi_b[1].flat().reverse(),
      ].flat(),
      proofC: [mydata.pi_c[0], mydata.pi_c[1]].flat(),
    };
  } catch (error: any) {
    console.error("Error while parsing the proof.", error.message);
    throw error;
  }
}

export function parseToBytesArray(publicSignals: string[]): number[][] {
  const publicInputsJson = JSON.stringify(publicSignals, null, 1);
  const publicInputsBytesJson = JSON.parse(publicInputsJson.toString());
  try {
    const publicInputsBytes = new Array<Array<number>>();
    for (const i in publicInputsBytesJson) {
      const ref: Array<number> = Array.from([
        ...utils.leInt2Buff(utils.unstringifyBigInts(publicInputsBytesJson[i]), 32),
      ]).reverse();
      publicInputsBytes.push(ref);
    }

    return publicInputsBytes;
  } catch (error: any) {
    console.error("Error while parsing public inputs.", error.message);
    throw error;
  }
}

function yElementIsPositiveG1(yElement: anchor.BN): boolean {
  return yElement.lte(FIELD_SIZE.sub(yElement));
}

function yElementIsPositiveG2(yElement1: anchor.BN, yElement2: anchor.BN): boolean {
  const fieldMidpoint = FIELD_SIZE.div(new anchor.BN(2));

  if (yElement1.lt(fieldMidpoint)) {
    return true;
  } else if (yElement1.gt(fieldMidpoint)) {
    return false;
  }

  return yElement2.lt(fieldMidpoint);
}

function addBitmaskToByte(byte: number, yIsPositive: boolean): number {
  if (!yIsPositive) {
    return (byte |= 1 << 7);
  } else {
    return byte;
  }
}

export { prove, verify, Proof }
