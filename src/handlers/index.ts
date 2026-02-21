/**
 * Event handlers for BlockhostSubscriptions contract events
 * SubscriptionCreated enqueues to the pipeline runner.
 * Extend/cancel/plan handlers remain inline.
 */

import { ethers } from "ethers";
import { spawn } from "child_process";
import type { Pipeline } from "blockhost-runner";
import { getCommand } from "../provisioner";

// Paths on the server
const WORKING_DIR = "/var/lib/blockhost";

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

export async function handleSubscriptionCreated(event: SubscriptionCreatedEvent, txHash: string, pipeline: Pipeline): Promise<void> {
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

  // Enqueue to pipeline — runner handles VM create, encryption, minting, DB update
  const enqueued = pipeline.enqueue({
    subscriptionId: Number(event.subscriptionId),
    vmName,
    ownerWallet: event.subscriber,
    expiryDays,
    userEncrypted: event.userEncrypted,
  });

  if (enqueued) {
    console.log(`[INFO] Enqueued ${vmName} to pipeline (expiry: ${expiryDays} days)`);
  } else {
    console.error(`[ERROR] Failed to enqueue ${vmName} to pipeline`);
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
