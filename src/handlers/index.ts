/**
 * Event handlers for BlockhostSubscriptions contract events
 * Calls blockhost-provisioner-proxmox scripts to provision/manage VMs
 */

import { ethers } from "ethers";
import { spawn, execFileSync, spawnSync } from "child_process";
import { getCommand } from "../provisioner";
import { getNetworkMode } from "../config/network-mode";

// Paths on the server
const WORKING_DIR = "/var/lib/blockhost";
const SERVER_PRIVATE_KEY_FILE = "/etc/blockhost/server.key";

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
 * Decrypt userEncrypted data using the server's private key (ECIES via bhcrypt).
 * Returns the decrypted user signature, or null if decryption fails.
 *
 * For testing: if the data looks like a raw signature (0x + 130 hex chars), use it directly.
 */
function decryptUserSignature(userEncrypted: string): string | null {
  // Check if it's a raw signature (65 bytes = 130 hex chars + 0x prefix)
  if (userEncrypted.startsWith("0x") && userEncrypted.length === 132) {
    console.log("[INFO] Using raw signature (no decryption needed)");
    return userEncrypted;
  }

  try {
    const result = execFileSync(
      "bhcrypt",
      ["decrypt", "--private-key-file", SERVER_PRIVATE_KEY_FILE, "--ciphertext", userEncrypted],
      { encoding: "utf8", timeout: 10000 }
    );
    return result.trim();
  } catch (err) {
    console.error(`[ERROR] Failed to decrypt user signature: ${err}`);
    return null;
  }
}

/**
 * Encrypt connection details using the user's signature (symmetric encryption via bhcrypt).
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
    const result = execFileSync("bhcrypt", [
      "encrypt-symmetric",
      "--signature", userSignature,
      "--plaintext", connectionDetails,
    ], { encoding: "utf8", timeout: 10000 });

    // bhcrypt outputs raw 0x-prefixed hex (no labels)
    const output = result.trim();
    if (output.startsWith("0x")) {
      return output;
    }

    console.error("[ERROR] Unexpected encrypt-symmetric output format");
    return null;
  } catch (err) {
    console.error(`[ERROR] Failed to encrypt connection details: ${err}`);
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
 * Parse the minted token ID from blockhost-mint-nft stdout.
 * The mint script outputs the token ID as an integer on stdout.
 */
function parseMintTokenId(stdout: string): number | null {
  const trimmed = stdout.trim();
  // Look for an integer (the last line that is purely numeric)
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const parsed = parseInt(line, 10);
    if (!isNaN(parsed) && String(parsed) === line) {
      return parsed;
    }
  }
  return null;
}

/**
 * Register a newly created VM in the database.
 */
async function registerVm(
  vmName: string,
  vmid: number,
  ip: string,
  ipv6: string | null,
  walletAddress: string,
  expiryDays: number,
): Promise<boolean> {
  const script = `
import os
from blockhost.vm_db import get_database
db = get_database()
db.register_vm(
    name=os.environ["VM_NAME"],
    vmid=int(os.environ["VMID"]),
    ip=os.environ["IP"],
    ipv6=os.environ.get("IPV6") or None,
    wallet_address=os.environ["WALLET"],
    expiry_days=int(os.environ["EXPIRY_DAYS"]),
)
`;
  return new Promise((resolve) => {
    const proc = spawn("python3", ["-c", script], {
      cwd: WORKING_DIR,
      env: {
        ...process.env,
        VM_NAME: vmName,
        VMID: String(vmid),
        IP: ip,
        IPV6: ipv6 || "",
        WALLET: walletAddress,
        EXPIRY_DAYS: String(expiryDays),
      },
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[WARN] Failed to register VM ${vmName} in database`);
      }
      resolve(code === 0);
    });
  });
}

/**
 * Mark an NFT as minted on a VM record in the database.
 */
async function markNftMinted(nftTokenId: number, vmName: string): Promise<boolean> {
  const script = `
import os
from blockhost.vm_db import get_database
db = get_database()
db.set_nft_minted(os.environ["VM_NAME"], int(os.environ["NFT_TOKEN_ID"]))
`;
  return new Promise((resolve) => {
    const proc = spawn("python3", ["-c", script], {
      cwd: WORKING_DIR,
      env: { ...process.env, VM_NAME: vmName, NFT_TOKEN_ID: String(nftTokenId) },
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[WARN] Failed to mark NFT ${nftTokenId} as minted for ${vmName}`);
      }
      resolve(code === 0);
    });
  });
}

/**
 * Resolve the subscriber-facing host via blockhost.network_hook.
 * In broker/manual modes this is a pass-through; in onion mode it creates
 * a hidden service and pushes the .onion into the VM. See facts/ENGINE_INTERFACE.md §13.
 * Throws on any failure so the caller can decide whether to fall back.
 */
function getConnectionEndpoint(vmName: string, bridgeIp: string, mode: string): string {
  const script =
    "import sys\n" +
    "from blockhost.network_hook import get_connection_endpoint\n" +
    "print(get_connection_endpoint(sys.argv[1], sys.argv[2], sys.argv[3]))\n";
  const result = spawnSync("python3", ["-c", script, vmName, bridgeIp, mode], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const errMsg = (result.stderr || result.stdout || "").trim();
    throw new Error(`network_hook.get_connection_endpoint failed: ${errMsg || `exit ${result.status}`}`);
  }
  const host = result.stdout.trim();
  if (!host) {
    throw new Error("network_hook.get_connection_endpoint returned empty host");
  }
  return host;
}

/**
 * Release network resources for a destroyed VM via blockhost.network_hook.
 * Onion mode removes the hidden service; broker/manual modes are no-ops.
 */
function networkHookCleanup(vmName: string, mode: string): void {
  const script =
    "import sys\n" +
    "from blockhost.network_hook import cleanup\n" +
    "cleanup(sys.argv[1], sys.argv[2])\n";
  const result = spawnSync("python3", ["-c", script, vmName, mode], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    const errMsg = (result.stderr || result.stdout || "").trim();
    throw new Error(`network_hook.cleanup failed: ${errMsg || `exit ${result.status}`}`);
  }
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

  // Step 1: Decrypt user signature BEFORE creating VM
  // If decryption fails, don't create the VM
  let userSignature: string | null = null;
  if (event.userEncrypted && event.userEncrypted !== "0x") {
    console.log("Decrypting user signature...");
    userSignature = decryptUserSignature(event.userEncrypted);
    if (userSignature) {
      console.log("User signature decrypted successfully");
    } else {
      console.error(`[ERROR] Could not decrypt user signature for ${vmName} — aborting`);
      console.log("==========================================\n");
      return;
    }
  }

  // Step 2: Create VM (no --nft-token-id, no --no-mint)
  const createArgs = [
    vmName,
    "--owner-wallet", event.subscriber,
    "--expiry-days", expiryDays.toString(),
    "--apply",
  ];

  console.log("Creating VM...");
  const result = await runCommand(getCommand("create"), createArgs);

  if (result.code !== 0) {
    console.error(`[ERROR] Failed to provision VM ${vmName}`);
    console.error(result.stderr || result.stdout);
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

  console.log(`[INFO] VM summary: ip=${summary.ip}, vmid=${summary.vmid}`);

  // Step 3b: Register VM in database
  const registered = await registerVm(
    vmName, summary.vmid, summary.ip, summary.ipv6 || null,
    event.subscriber, expiryDays,
  );
  if (!registered) {
    console.warn(`[WARN] VM ${vmName} created but database registration failed — continuing`);
  }

  // Step 4a: Resolve subscriber-facing host via network hook.
  // Called unconditionally: in onion mode the hook has side effects (creating
  // the hidden service and pushing the .onion into the VM) that must run
  // regardless of whether the user signature is present.
  const networkMode = getNetworkMode();
  let host: string;
  try {
    host = getConnectionEndpoint(vmName, summary.ip, networkMode);
    console.log(`[OK] Connection endpoint (mode=${networkMode}): ${host}`);
  } catch (err) {
    const fallback = summary.ipv6 || summary.ip;
    console.warn(`[WARN] network_hook failed for ${vmName}: ${err}`);
    console.warn(`[WARN] Falling back to provisioner bridge address: ${fallback}`);
    host = fallback;
  }

  // Step 4b: Encrypt connection details using user's signature
  let userEncrypted = "0x";

  if (userSignature) {
    const encrypted = encryptConnectionDetails(userSignature, host, summary.username);
    if (encrypted) {
      userEncrypted = encrypted;
      console.log("[OK] Connection details encrypted");
    } else {
      console.warn("[WARN] Failed to encrypt connection details, minting without user data");
    }
  }

  // Step 5: Mint NFT — capture actual token ID from stdout
  const mintArgs = [
    "--owner-wallet", event.subscriber,
  ];
  if (userEncrypted !== "0x") {
    mintArgs.push("--user-encrypted", userEncrypted);
  }

  console.log("Minting NFT...");
  const mintResult = await runCommand("blockhost-mint-nft", mintArgs);

  if (mintResult.code !== 0) {
    console.error(`[WARN] NFT minting failed for ${vmName} (VM is still operational)`);
    console.error(mintResult.stderr || mintResult.stdout);
    console.error(`[WARN] Retry manually: blockhost-mint-nft --owner-wallet ${event.subscriber}`);
    console.log("==========================================\n");
    return;
  }

  console.log(`[OK] NFT minted for ${vmName}`);

  const actualTokenId = parseMintTokenId(mintResult.stdout);
  if (actualTokenId === null) {
    console.warn(`[WARN] Could not parse token ID from mint output — GECOS update skipped`);
    console.log("==========================================\n");
    return;
  }

  console.log(`[INFO] Minted token ID: ${actualTokenId}`);

  // Step 6: Call update-gecos with actual token ID
  const updateGecosCmd = getCommand("update-gecos");
  const gecosResult = spawnSync(updateGecosCmd, [vmName, event.subscriber, "--nft-id", String(actualTokenId)], {
    timeout: 30_000,
    cwd: WORKING_DIR,
  });
  if (gecosResult.status !== 0) {
    const errMsg = ((gecosResult.stderr || gecosResult.stdout) ?? "").toString().trim();
    console.error(`[WARN] update-gecos failed for ${vmName}: ${errMsg || `exit ${gecosResult.status}`}`);
    // Not fatal — reconciler will retry
  } else {
    console.log(`[OK] GECOS updated for ${vmName} with token ${actualTokenId}`);
  }

  // Step 7: Mark NFT minted in DB (awaited, not fire-and-forget)
  await markNftMinted(actualTokenId, vmName);

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
import os
from blockhost.vm_db import get_database

vm_name = os.environ["VM_NAME"]
additional_days = int(os.environ["ADDITIONAL_DAYS"])

db = get_database()
vm = db.get_vm(vm_name)
if vm:
    old_status = vm.get('status', 'unknown')
    db.extend_expiry(vm_name, additional_days)
    print(f"Extended {vm['vm_name']} expiry by {additional_days} days")
    if old_status == 'suspended':
        print("NEEDS_RESUME")
else:
    print(f"VM {vm_name} not found in database")
`;

  const proc = spawn("python3", ["-c", script], {
    cwd: WORKING_DIR,
    env: { ...process.env, VM_NAME: vmName, ADDITIONAL_DAYS: String(additionalDays) },
  });

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

    // Release network resources (hidden service for onion mode; no-op otherwise).
    const networkMode = getNetworkMode();
    try {
      networkHookCleanup(vmName, networkMode);
      console.log(`[OK] Network cleanup complete (mode=${networkMode})`);
    } catch (err) {
      console.warn(`[WARN] network_hook cleanup failed for ${vmName}: ${err}`);
    }
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
