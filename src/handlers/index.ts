/**
 * Event handlers for BlockhostSubscriptions contract events
 * Calls blockhost-provisioner-proxmox scripts to provision/manage VMs
 */

import { ethers } from "ethers";
import { spawn, execFileSync, spawnSync } from "child_process";
import { getCommand } from "../provisioner";

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

const RESULT_SENTINEL = "BLOCKHOST_RESULT: ";

/**
 * Parse the JSON summary line from blockhost-vm-create stdout per
 * facts/PROVISIONER_INTERFACE.md §2: the canonical result is the line prefixed
 * with `BLOCKHOST_RESULT: `.
 */
function parseVmSummary(stdout: string): VmCreateSummary | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith(RESULT_SENTINEL)) {
      try {
        return JSON.parse(line.slice(RESULT_SENTINEL.length)) as VmCreateSummary;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Parse the minted token ID from blockhost-mint-nft stdout per
 * facts/ENGINE_INTERFACE.md §1: the canonical line is prefixed with
 * `BLOCKHOST_RESULT: ` followed by an integer. mint_nft.py is engine-owned
 * and emits the sentinel, so no transitional fallback is needed here.
 */
function parseMintTokenId(stdout: string): number | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith(RESULT_SENTINEL)) {
      const parsed = parseInt(line.slice(RESULT_SENTINEL.length).trim(), 10);
      if (!isNaN(parsed)) return parsed;
      return null;
    }
  }
  return null;
}

/**
 * Mark an NFT as minted on a VM record in the database.
 */
function markNftMinted(nftTokenId: number, vmName: string): boolean {
  const result = spawnSync("blockhost-vmdb", ["mark-nft-minted", vmName, String(nftTokenId)], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    const errMsg = (result.stderr || result.stdout || "").trim();
    console.error(`[WARN] Failed to mark NFT ${nftTokenId} as minted for ${vmName}: ${errMsg || `exit ${result.status}`}`);
    return false;
  }
  return true;
}

/**
 * Resolve the subscriber-facing public address for a VM via blockhost-network-hook.
 * The dispatcher reads vm-db.network_mode and asks the active plugin. The engine
 * is mode-agnostic — no fallback. See facts/NETWORK_INTERFACE.md §7.1 and
 * facts/ENGINE_INTERFACE.md §13.
 */
function networkHookPublicAddress(vmName: string): string {
  const result = spawnSync("blockhost-network-hook", ["public-address", vmName], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    const errMsg = (result.stderr || result.stdout || "").trim();
    throw new Error(`blockhost-network-hook public-address failed: ${errMsg || `exit ${result.status}`}`);
  }
  const host = result.stdout.trim();
  if (!host) {
    throw new Error("blockhost-network-hook public-address returned empty host");
  }
  return host;
}

/**
 * Push mode-specific configuration into the VM via blockhost-network-hook.
 * Idempotent. Best-effort — engines record success/failure on the VM record
 * and let the reconciler retry on next cycle. See facts/NETWORK_INTERFACE.md §7.2.
 */
function networkHookPushVmConfig(vmName: string): { ok: boolean; error?: string } {
  const result = spawnSync("blockhost-network-hook", ["push-vm-config", vmName], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status === 0) {
    return { ok: true };
  }
  const errMsg = (result.stderr || result.stdout || "").trim();
  return { ok: false, error: errMsg || `exit ${result.status}` };
}

/**
 * Release per-VM network resources (host- and guest-side) via blockhost-network-hook.
 * Called before vm-destroy so guest-side reversal can run while the VM is still up.
 * See facts/NETWORK_INTERFACE.md §7.3.
 */
function networkHookCleanup(vmName: string): void {
  const result = spawnSync("blockhost-network-hook", ["cleanup", vmName], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    const errMsg = (result.stderr || result.stdout || "").trim();
    throw new Error(`blockhost-network-hook cleanup failed: ${errMsg || `exit ${result.status}`}`);
  }
}

/**
 * Persist field updates to a VM record via blockhost-vmdb update-fields.
 * Routes through common's lockfile per facts/COMMON_INTERFACE.md §2.
 */
function updateVmFields(vmName: string, fields: Record<string, unknown>): boolean {
  const result = spawnSync(
    "blockhost-vmdb",
    ["update-fields", vmName, "--fields", JSON.stringify(fields)],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status === 0) {
    return true;
  }
  const errMsg = (result.stderr || result.stdout || "").trim();
  console.error(
    `[WARN] update-fields failed for ${vmName}: ${errMsg || `exit ${result.status}`}`,
  );
  return false;
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

  // VM is already registered in vms.json by the provisioner — see
  // facts/PROVISIONER_INTERFACE.md §2 (vm-create / Database side effects).

  // Step 4a: Resolve subscriber-facing public address via blockhost-network-hook.
  // Engine is mode-agnostic: the dispatcher reads vm-db.network_mode and asks
  // the active plugin. No fallback — bad data baked into an NFT is worse than
  // a failed handler that can be re-driven manually.
  let host: string;
  try {
    host = networkHookPublicAddress(vmName);
    console.log(`[OK] Public address: ${host}`);
  } catch (err) {
    console.error(`[ERROR] Could not resolve public address for ${vmName}: ${err}`);
    console.error(`[ERROR] Aborting handler — NFT will not be minted with garbage data`);
    console.log("==========================================\n");
    return;
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

  // Step 6: Push mode-specific config into the VM. Idempotent and best-effort —
  // the reconciler retries if the guest agent isn't ready yet. Persist the
  // outcome so the reconciler knows whether to retry.
  const pushResult = networkHookPushVmConfig(vmName);
  if (pushResult.ok) {
    console.log(`[OK] push-vm-config succeeded for ${vmName}`);
    updateVmFields(vmName, { network_config_synced: true });
  } else {
    console.warn(`[WARN] push-vm-config failed for ${vmName}: ${pushResult.error}`);
    updateVmFields(vmName, { network_config_synced: false });
  }

  // Step 7: Call update-gecos with actual token ID
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

  // Step 8: Mark NFT minted in DB (awaited, not fire-and-forget)
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

  // blockhost-vmdb extend-expiry returns "NEEDS_RESUME" on line 2 if VM was suspended.
  const extendResult = spawnSync(
    "blockhost-vmdb",
    ["extend-expiry", vmName, String(additionalDays)],
    { encoding: "utf8", timeout: 30_000 },
  );

  let needsResume = false;
  if (extendResult.status === 0) {
    const output = (extendResult.stdout || "").trim();
    const firstLine = output.split("\n")[0];
    if (firstLine) console.log(`[OK] ${firstLine}`);
    needsResume = output.includes("NEEDS_RESUME");
  } else {
    const errMsg = (extendResult.stderr || extendResult.stdout || "").trim();
    console.error(`[ERROR] Failed to extend expiry: ${errMsg || `exit ${extendResult.status}`}`);
  }

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

  // Step 1: Release per-VM network resources BEFORE destroying the VM so the
  // plugin can do guest-side reversal while the VM is still running. See
  // facts/ENGINE_INTERFACE.md §13.
  try {
    networkHookCleanup(vmName);
    console.log(`[OK] Network cleanup complete for ${vmName}`);
  } catch (err) {
    console.warn(`[WARN] blockhost-network-hook cleanup failed for ${vmName}: ${err}`);
  }

  // Step 2: Destroy the VM. Provisioner calls mark_destroyed itself per
  // facts/PROVISIONER_INTERFACE.md §2.
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
