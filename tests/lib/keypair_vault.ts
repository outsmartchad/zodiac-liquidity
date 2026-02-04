/**
 * Keypair Vault — persists funded test keypairs to disk so SOL can be
 * recovered even when tests crash before the after() hook runs.
 *
 * Usage:
 *   import { KeypairVault } from "./lib/keypair_vault";
 *   const vault = new KeypairVault("zodiac-mixer");
 *
 *   // In before() — register every funded keypair:
 *   vault.save(relayer, "relayer", 7_000_000_000);
 *
 *   // In after() — mark successful cleanup:
 *   vault.clear();
 *
 * Recovery (run from onchain/):
 *   npx ts-node --skip-project tests/lib/recover_keypairs.ts
 */

import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const VAULT_DIR = path.resolve(__dirname, "../../.keypair-vault");

interface SavedKeypair {
  label: string;
  pubkey: string;
  secretKey: number[];
  fundedLamports: number;
  savedAt: string;
}

interface VaultFile {
  testSuite: string;
  createdAt: string;
  keypairs: SavedKeypair[];
}

export class KeypairVault {
  private testSuite: string;
  private filePath: string;
  private entries: SavedKeypair[] = [];

  constructor(testSuite: string) {
    this.testSuite = testSuite;
    this.filePath = path.join(VAULT_DIR, `${testSuite}.json`);
    if (!fs.existsSync(VAULT_DIR)) {
      fs.mkdirSync(VAULT_DIR, { recursive: true });
    }
  }

  /** Save a funded keypair to disk. Call this RIGHT AFTER funding it. */
  save(kp: Keypair, label: string, fundedLamports: number): void {
    const entry: SavedKeypair = {
      label,
      pubkey: kp.publicKey.toString(),
      secretKey: Array.from(kp.secretKey),
      fundedLamports,
      savedAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this._flush();
  }

  /** Clear the vault file after successful cleanup in after(). */
  clear(): void {
    this.entries = [];
    try {
      fs.unlinkSync(this.filePath);
    } catch {}
  }

  private _flush(): void {
    const data: VaultFile = {
      testSuite: this.testSuite,
      createdAt: new Date().toISOString(),
      keypairs: this.entries,
    };
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  /** Read all vault files (used by recovery script). */
  static readAll(): { testSuite: string; keypairs: SavedKeypair[] }[] {
    if (!fs.existsSync(VAULT_DIR)) return [];
    const results: { testSuite: string; keypairs: SavedKeypair[] }[] = [];
    for (const file of fs.readdirSync(VAULT_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(VAULT_DIR, file), "utf-8");
        const data: VaultFile = JSON.parse(raw);
        results.push({ testSuite: data.testSuite, keypairs: data.keypairs });
      } catch {}
    }
    return results;
  }
}
