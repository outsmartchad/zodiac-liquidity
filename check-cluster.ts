import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getClusterAccAddress,
  getArxNodeAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getArciumProgramId,
  getArciumProgram,
  getMXEAccAddress,
  getMempoolAccInfo,
  getExecutingPoolAccInfo,
} from "@arcium-hq/client";

async function main() {
  const connection = new Connection("https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY_HERE", "confirmed");

  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const CLUSTER_OFFSET = 456;
  const PROGRAM_ID = new PublicKey("FMMVCEygM2ewq4y4fmE5UDuyfhuoz4bXmEDDeg9iFPpL");
  const arciumProgramId = getArciumProgramId();

  console.log("=== Arcium Cluster 456 Inspection ===\n");
  console.log("Arcium Program ID:", arciumProgramId.toBase58());

  // 1. Fetch cluster account
  const clusterAddr = getClusterAccAddress(CLUSTER_OFFSET);
  console.log("\nCluster PDA:", clusterAddr.toBase58());

  const arciumProgram = getArciumProgram(provider);

  try {
    const clusterAcc = await (arciumProgram.account as any).cluster.fetch(clusterAddr);
    console.log("\n--- Cluster Account ---");
    console.log(JSON.stringify(clusterAcc, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof PublicKey) return value.toBase58();
      if (value && value.toNumber) return value.toNumber();
      if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
      return value;
    }, 2));
  } catch (e: any) {
    console.log("Failed to fetch cluster account:", e.message);
  }

  // 2. Fetch mempool
  const mempoolAddr = getMempoolAccAddress(CLUSTER_OFFSET);
  console.log("\nMempool PDA:", mempoolAddr.toBase58());
  try {
    const mempoolAcc = await getMempoolAccInfo(provider, mempoolAddr);
    console.log("\n--- Mempool Account ---");
    console.log("Computations in mempool:", JSON.stringify(mempoolAcc, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value && value.toNumber) return value.toNumber();
      return value;
    }, 2));
  } catch (e: any) {
    console.log("Failed to fetch mempool:", e.message);
  }

  // 3. Fetch executing pool
  const execPoolAddr = getExecutingPoolAccAddress(CLUSTER_OFFSET);
  console.log("\nExecuting Pool PDA:", execPoolAddr.toBase58());
  try {
    const execPoolAcc = await getExecutingPoolAccInfo(provider, execPoolAddr);
    console.log("\n--- Executing Pool ---");
    console.log(JSON.stringify(execPoolAcc, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value && value.toNumber) return value.toNumber();
      return value;
    }, 2));
  } catch (e: any) {
    console.log("Failed to fetch executing pool:", e.message);
  }

  // 4. Fetch MXE account
  const mxeAddr = getMXEAccAddress(PROGRAM_ID);
  console.log("\nMXE PDA:", mxeAddr.toBase58());
  try {
    const mxeAcc = await (arciumProgram.account as any).mxeaccount.fetch(mxeAddr);
    console.log("\n--- MXE Account ---");
    console.log(JSON.stringify(mxeAcc, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof PublicKey) return value.toBase58();
      if (value && value.toNumber) return value.toNumber();
      if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
      if (value instanceof Uint8Array) return `Uint8Array(${value.length}): ${Buffer.from(value).toString('hex').slice(0, 64)}...`;
      return value;
    }, 2));
  } catch (e: any) {
    console.log("Failed to fetch MXE account:", e.message);
  }

  // 5. Try to fetch ARX node accounts for known offsets from the debug log
  const knownNodeOffsets = [743829, 45548129];
  for (const nodeOffset of knownNodeOffsets) {
    const nodeAddr = getArxNodeAccAddress(nodeOffset);
    console.log(`\nARX Node (offset ${nodeOffset}) PDA:`, nodeAddr.toBase58());
    try {
      const nodeAcc = await (arciumProgram.account as any).arxNode.fetch(nodeAddr);
      console.log(`\n--- ARX Node ${nodeOffset} ---`);
      console.log(JSON.stringify(nodeAcc, (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (value instanceof PublicKey) return value.toBase58();
        if (value && value.toNumber) return value.toNumber();
        if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
        if (value instanceof Uint8Array) return `Uint8Array(${value.length}): ${Buffer.from(value).toString('hex').slice(0, 64)}...`;
        return value;
      }, 2));
    } catch (e: any) {
      console.log(`Failed to fetch ARX node ${nodeOffset}:`, e.message);
    }
  }

  // 6. Check arcium clock
  try {
    const clockAddr = new PublicKey("SysvarC1ock11111111111111111111111111111111");
    // Use getClockAccAddress if available
    const { getClockAccAddress } = await import("@arcium-hq/client");
    const arciumClockAddr = getClockAccAddress();
    console.log("\nArcium Clock PDA:", arciumClockAddr.toBase58());
    const clockAcc = await connection.getAccountInfo(arciumClockAddr);
    if (clockAcc) {
      console.log("Clock account size:", clockAcc.data.length, "bytes");
      console.log("Owner:", clockAcc.owner.toBase58());
    }
  } catch (e: any) {
    console.log("Clock fetch error:", e.message);
  }

  // 7. Check our local arcium CLI version vs SDK version
  console.log("\n=== Version Info ===");
  console.log("@arcium-hq/client version: 0.6.3");

  // Check arcium program's version/data
  const arciumAccInfo = await connection.getAccountInfo(arciumProgramId);
  if (arciumAccInfo) {
    console.log("Arcium program account size:", arciumAccInfo.data.length, "bytes");
    console.log("Arcium program owner:", arciumAccInfo.owner.toBase58());
    console.log("Arcium program executable:", arciumAccInfo.executable);
  }
}

main().catch(console.error);
