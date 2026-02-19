/**
 * Event handlers for BlockhostSubscriptions contract events
 * Calls blockhost-provisioner-proxmox scripts to provision/manage VMs
 */

import { ethers } from "ethers";
import { spawn, execFileSync } from "child_process";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { getCommand } from "../provisioner";

// Paths on the server
const WORKING_DIR = "/var/lib/blockhost";
const SERVER_PRIVATE_KEY_FILE = "/etc/blockhost/server.key";
const BLOCKHOST_CONFIG_FILE = "/etc/blockhost/blockhost.yaml";

// Load NFT contract address from web3-defaults.yaml
function getNftContractAddress(): string | null {
  try {
    const WEB3_CONFIG_FILE = "/etc/blockhost/web3-defaults.yaml";
    const config = yaml.load(fs.readFileSync(WEB3_CONFIG_FILE, "utf8")) as Record<string, unknown>;
    const blockchain = config.blockchain as Record<string, unknown> | undefined;
    return (blockchain?.nft_contract as string) || null;
  } catch {
    return null;
  }
}

export interface SubscriptionCreatedEvent {
  subscriptionId: bigint;
  planId: bigint;
  subscriber: string;
  expiresAt: bigint;
  paidAmount: bigint;
  paymentToken: string;
  userEncrypted: string; // Hex-encoded encrypted connection details
}

export interface SubscriptionExtendedEvent {
  subscriptionId: bigint;
  planId: bigint;
  extendedBy: string;
  newExpiresAt: bigint;
  paidAmount: bigint;
  paymentToken: string;
}

export interface SubscriptionCancelledEvent {
  subscriptionId: bigint;
  planId: bigint;
  subscriber: string;
}

export interface PlanCreatedEvent {
  planId: bigint;
  name: string;
  pricePerDayUsdCents: bigint;
}

export interface PlanUpdatedEvent {
  planId: bigint;
  name: string;
  pricePerDayUsdCents: bigint;
  active: boolean;
}

/**
 * Format subscription ID as VM name: blockhost-001, blockhost-042, etc.
 */
function formatVmName(subscriptionId: bigint): string {
  return `blockhost-${subscriptionId.toString().padStart(3, "0")}`;
}

/**
 * Calculate days from now until expiry timestamp
 */
function calculateExpiryDays(expiresAt: bigint): number {
  const expiryMs = Number(expiresAt) * 1000;
  const nowMs = Date.now();
  const daysRemaining = Math.ceil((expiryMs - nowMs) / (1000 * 60 * 60 * 24));
  return Math.max(1, daysRemaining); // At least 1 day
}

/**
 * Decrypt userEncrypted data using the server's private key
 * Returns the decrypted user signature, or null if decryption fails
 *
 * For testing: if the data looks like a raw signature (0x + 130 hex chars), use it directly
 */
function decryptUserSignature(userEncrypted: string): string | null {
  // Check if it's a raw signature (65 bytes = 130 hex chars + 0x prefix)
  // Ethereum signatures are 65 bytes: r (32) + s (32) + v (1)
  if (userEncrypted.startsWith("0x") && userEncrypted.length === 132) {
    console.log("[INFO] Using raw signature (no decryption needed)");
    return userEncrypted;
  }

  // Otherwise, try to decrypt with server's private key
  try {
    const result = execFileSync(
      "nft_tool",
      ["decrypt", "--private-key-file", SERVER_PRIVATE_KEY_FILE, "--ciphertext", userEncrypted],
      { encoding: "utf8", timeout: 10000 }
    );
    // Strip "Decrypted: " prefix if present
    return result.trim().replace(/^Decrypted:\s*/, '');
  } catch (err) {
    console.error(`[ERROR] Failed to decrypt user signature: ${err}`);
    return null;
  }
}

/**
 * Run a command and return a promise
 */
function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: WORKING_DIR,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** Summary JSON emitted by blockhost-vm-create */
interface VmCreateSummary {
  status: string;
  vm_name: string;
  ip: string;
  ipv6?: string;
  vmid: number;
  nft_token_id: number;
  username: string;
}

/**
 * Parse the JSON summary line from blockhost-vm-create stdout.
 * The summary is the last line starting with '{'.
 */
function parseVmSummary(stdout: string): VmCreateSummary | null {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{")) {
      try {
        return JSON.parse(line) as VmCreateSummary;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Encrypt connection details using the user's signature (symmetric encryption).
 * Returns the encrypted hex string, or null on failure.
 */
function encryptConnectionDetails(
  userSignature: string,
  hostname: string,
  username: string
): string | null {
  const connectionDetails = JSON.stringify({
    hostname,
    port: 22,
    username,
  });

  try {
    const result = execFileSync("nft_tool", [
      "encrypt-symmetric",
      "--signature", userSignature,
      "--plaintext", connectionDetails,
    ], { encoding: "utf8", timeout: 10000 });

    const hexMatch = result.match(/0x[0-9a-fA-F]+/);
    if (!hexMatch) {
      console.error("[ERROR] No hex data in encrypt-symmetric output");
      return null;
    }

    return hexMatch[0];
  } catch (err) {
    console.error(`[ERROR] Failed to encrypt connection details: ${err}`);
    return null;
  }
}

/**
 * Reserve an NFT token ID in the VM database.
 * Queries totalSupply() on-chain to get the floor, then reserves in vms.json.
 * Returns the reserved token ID, or null on failure.
 */
async function reserveNftTokenId(vmName: string): Promise<number | null> {
  const nftAddress = getNftContractAddress();
  if (!nftAddress) {
    console.error("[ERROR] NFT contract address not configured");
    return null;
  }

  const rpcUrl = process.env.RPC_URL || "";
  if (!rpcUrl) {
    console.error("[ERROR] RPC_URL not set");
    return null;
  }

  try {
    // Query totalSupply() on-chain to get the floor token ID
    const totalSupplyResult = execFileSync("cast", [
      "call", nftAddress, "totalSupply()(uint256)", "--rpc-url", rpcUrl,
    ], { encoding: "utf8", timeout: 15000 });

    const totalSupply = parseInt(totalSupplyResult.trim(), 10);
    if (isNaN(totalSupply)) {
      console.error(`[ERROR] Could not parse totalSupply: ${totalSupplyResult}`);
      return null;
    }

    // Reserve in the VM database
    const script = `
from blockhost.vm_db import get_database
db = get_database()
db.reserve_nft_token_id("${vmName}", token_id=${totalSupply})
print(${totalSupply})
`;
    const result = execFileSync("python3", ["-c", script], {
      encoding: "utf8",
      timeout: 10000,
      cwd: WORKING_DIR,
    });

    const tokenId = parseInt(result.trim(), 10);
    if (isNaN(tokenId)) {
      console.error(`[ERROR] Could not parse reserved token ID: ${result}`);
      return null;
    }

    return tokenId;
  } catch (err) {
    console.error(`[ERROR] Failed to reserve NFT token ID: ${err}`);
    return null;
  }
}

/**
 * Mark an NFT reservation as failed in the VM database.
 */
function markNftFailed(tokenId: number): void {
  const script = `
from blockhost.vm_db import get_database
db = get_database()
db.mark_nft_failed(${tokenId})
`;
  const proc = spawn("python3", ["-c", script], { cwd: WORKING_DIR });
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`[WARN] Failed to mark NFT ${tokenId} as failed in database`);
    }
  });
}

/**
 * Mark an NFT as minted in the VM database (fire-and-forget).
 */
function markNftMinted(nftTokenId: number, ownerWallet: string): void {
  const script = `
from blockhost.vm_db import get_database
db = get_database()
db.mark_nft_minted(${nftTokenId}, "${ownerWallet}")
`;
  const proc = spawn("python3", ["-c", script], { cwd: WORKING_DIR });
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`[WARN] Failed to mark NFT ${nftTokenId} as minted in database`);
    }
  });
}

/**
 * Destroy a VM via the provisioner's destroy command.
 */
async function destroyVm(vmName: string): Promise<{ success: boolean; output: string }> {
  const result = await runCommand(getCommand("destroy"), [vmName]);
  return {
    success: result.code === 0,
    output: (result.code === 0 ? result.stdout : result.stderr || result.stdout).trim(),
  };
}

export async function handleSubscriptionCreated(event: SubscriptionCreatedEvent, txHash: string): Promise<void> {
  const vmName = formatVmName(event.subscriptionId);
  const expiryDays = calculateExpiryDays(event.expiresAt);

  console.log("\n========== SUBSCRIPTION CREATED ==========");
  console.log(`Transaction: ${txHash}`);
  console.log(`Subscription ID: ${event.subscriptionId}`);
  console.log(`Plan ID: ${event.planId}`);
  console.log(`Subscriber: ${event.subscriber}`);
  console.log(`Expires At: ${new Date(Number(event.expiresAt) * 1000).toISOString()}`);
  console.log(`Paid Amount: ${ethers.formatUnits(event.paidAmount, 6)} (assuming 6 decimals)`);
  console.log(`Payment Token: ${event.paymentToken}`);
  console.log(`User Encrypted: ${event.userEncrypted.length > 10 ? event.userEncrypted.slice(0, 10) + "..." : event.userEncrypted}`);
  console.log("------------------------------------------");
  console.log(`Provisioning VM: ${vmName}`);
  console.log(`Expiry: ${expiryDays} days`);

  // Decrypt user signature if provided (needed for connection detail encryption)
  let userSignature: string | null = null;
  if (event.userEncrypted && event.userEncrypted !== "0x") {
    console.log("Decrypting user signature...");
    userSignature = decryptUserSignature(event.userEncrypted);
    if (userSignature) {
      console.log("User signature decrypted successfully");
    } else {
      console.warn("[WARN] Could not decrypt user signature, proceeding without encrypted connection details");
    }
  }

  // Step 1: Reserve NFT token ID (engine owns this)
  const nftTokenId = await reserveNftTokenId(vmName);
  if (nftTokenId === null) {
    console.error(`[ERROR] Failed to reserve NFT token ID for ${vmName}`);
    console.log("==========================================\n");
    return;
  }
  console.log(`[INFO] Reserved NFT token ID: ${nftTokenId}`);

  // Step 2: Create VM (pass reserved token ID to provisioner)
  const createArgs = [
    vmName,
    "--owner-wallet", event.subscriber,
    "--nft-token-id", nftTokenId.toString(),
    "--expiry-days", expiryDays.toString(),
    "--apply",
  ];

  console.log("Creating VM...");
  const result = await runCommand(getCommand("create"), createArgs);

  if (result.code !== 0) {
    console.error(`[ERROR] Failed to provision VM ${vmName}`);
    console.error(result.stderr || result.stdout);
    markNftFailed(nftTokenId);
    console.log("==========================================\n");
    return;
  }

  console.log(`[OK] VM ${vmName} provisioned successfully`);

  // Step 3: Parse JSON summary from provisioner output
  const summary = parseVmSummary(result.stdout);
  if (!summary) {
    console.log("[INFO] No JSON summary from provisioner (legacy mode)");
    console.log(result.stdout);
    console.log("==========================================\n");
    return;
  }

  console.log(`[INFO] VM summary: ip=${summary.ip}, vmid=${summary.vmid}, token=${summary.nft_token_id}`);

  // Step 4: Encrypt connection details using user's signature
  let userEncrypted = "0x";

  if (userSignature) {
    const hostname = summary.ipv6 || summary.ip;
    const encrypted = encryptConnectionDetails(userSignature, hostname, summary.username);
    if (encrypted) {
      userEncrypted = encrypted;
      console.log("[OK] Connection details encrypted");
    } else {
      console.warn("[WARN] Failed to encrypt connection details, minting without user data");
    }
  }

  // Step 5: Mint NFT (separate from VM creation)
  const mintArgs = [
    "--owner-wallet", event.subscriber,
  ];
  if (userEncrypted !== "0x") {
    mintArgs.push("--user-encrypted", userEncrypted);
  }

  console.log("Minting NFT...");
  const mintResult = await runCommand("blockhost-mint-nft", mintArgs);

  if (mintResult.code === 0) {
    console.log(`[OK] NFT minted for ${vmName}`);
    markNftMinted(summary.nft_token_id, event.subscriber);
  } else {
    // VM exists and is functional, but NFT minting failed
    // Operator can retry: blockhost-mint-nft --owner-wallet 0x...
    console.error(`[WARN] NFT minting failed for ${vmName} (VM is still operational)`);
    console.error(mintResult.stderr || mintResult.stdout);
    console.error(`[WARN] Retry manually: blockhost-mint-nft --owner-wallet ${event.subscriber}`);
  }

  console.log("==========================================\n");
}

export async function handleSubscriptionExtended(event: SubscriptionExtendedEvent, txHash: string): Promise<void> {
  const vmName = formatVmName(event.subscriptionId);
  const newExpiryDate = new Date(Number(event.newExpiresAt) * 1000);

  console.log("\n========== SUBSCRIPTION EXTENDED ==========");
  console.log(`Transaction: ${txHash}`);
  console.log(`Subscription ID: ${event.subscriptionId}`);
  console.log(`Plan ID: ${event.planId}`);
  console.log(`Extended By: ${event.extendedBy}`);
  console.log(`New Expires At: ${newExpiryDate.toISOString()}`);
  console.log(`Paid Amount: ${ethers.formatUnits(event.paidAmount, 6)} (assuming 6 decimals)`);
  console.log(`Payment Token: ${event.paymentToken}`);
  console.log("-------------------------------------------");
  console.log(`Updating expiry for VM: ${vmName}`);

  // Calculate additional days from current time to new expiry
  const additionalDays = calculateExpiryDays(event.newExpiresAt);

  // Use Python to update the database and check if VM needs to be resumed
  // Returns "NEEDS_RESUME" if the VM was suspended and should be started
  const script = `
from blockhost.vm_db import get_database

db = get_database()
vm = db.get_vm('${vmName}')
if vm:
    old_status = vm.get('status', 'unknown')
    db.extend_expiry('${vmName}', ${additionalDays})
    print(f"Extended {vm['vm_name']} expiry by ${additionalDays} days")
    if old_status == 'suspended':
        print("NEEDS_RESUME")
else:
    print(f"VM ${vmName} not found in database")
`;

  const proc = spawn("python3", ["-c", script], { cwd: WORKING_DIR });

  let output = "";
  proc.stdout.on("data", (data) => { output += data.toString(); });
  proc.stderr.on("data", (data) => { output += data.toString(); });

  const needsResume = await new Promise<boolean>((resolve) => {
    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`[OK] ${output.trim().split('\n')[0]}`);
        resolve(output.includes("NEEDS_RESUME"));
      } else {
        console.error(`[ERROR] Failed to extend expiry: ${output}`);
        resolve(false);
      }
    });
  });

  // If VM was suspended, resume it
  if (needsResume) {
    console.log(`Resuming suspended VM: ${vmName}`);

    const resumeProc = spawn(getCommand("resume"), [vmName], { cwd: WORKING_DIR });

    let resumeOutput = "";
    resumeProc.stdout.on("data", (data) => { resumeOutput += data.toString(); });
    resumeProc.stderr.on("data", (data) => { resumeOutput += data.toString(); });

    await new Promise<void>((resolve) => {
      resumeProc.on("close", (code) => {
        if (code === 0) {
          console.log(`[OK] Successfully resumed VM: ${vmName}`);
          if (resumeOutput.trim()) {
            console.log(resumeOutput.trim());
          }
        } else {
          // Don't fail the handler - subscription extension succeeded on-chain
          // Operator can manually resume if needed
          console.error(`[WARN] Failed to resume VM ${vmName} (exit code ${code})`);
          console.error(`[WARN] ${resumeOutput.trim()}`);
          console.error(`[WARN] Operator may need to manually resume the VM`);
        }
        resolve();
      });
    });
  }

  console.log("===========================================\n");
}

export async function handleSubscriptionCancelled(event: SubscriptionCancelledEvent, txHash: string): Promise<void> {
  const vmName = formatVmName(event.subscriptionId);

  console.log("\n========== SUBSCRIPTION CANCELLED ==========");
  console.log(`Transaction: ${txHash}`);
  console.log(`Subscription ID: ${event.subscriptionId}`);
  console.log(`Plan ID: ${event.planId}`);
  console.log(`Subscriber: ${event.subscriber}`);
  console.log("--------------------------------------------");
  console.log(`Destroying VM: ${vmName}`);

  const { success, output } = await destroyVm(vmName);

  if (success) {
    console.log(`[OK] ${output}`);
  } else {
    console.error(`[ERROR] Failed to destroy VM: ${output}`);
  }

  console.log("============================================\n");
}

export async function handlePlanCreated(event: PlanCreatedEvent, txHash: string): Promise<void> {
  console.log("\n========== PLAN CREATED ==========");
  console.log(`Transaction: ${txHash}`);
  console.log(`Plan ID: ${event.planId}`);
  console.log(`Name: ${event.name}`);
  console.log(`Price: $${Number(event.pricePerDayUsdCents) / 100}/day`);
  console.log("----------------------------------");
  console.log("[INFO] Plan registered on-chain");
  console.log("==================================\n");
}

export async function handlePlanUpdated(event: PlanUpdatedEvent, txHash: string): Promise<void> {
  console.log("\n========== PLAN UPDATED ==========");
  console.log(`Transaction: ${txHash}`);
  console.log(`Plan ID: ${event.planId}`);
  console.log(`Name: ${event.name}`);
  console.log(`Price: $${Number(event.pricePerDayUsdCents) / 100}/day`);
  console.log(`Active: ${event.active}`);
  console.log("----------------------------------");
  console.log("[INFO] Plan updated on-chain");
  console.log("==================================\n");
}
