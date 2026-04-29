/**
 * NFT Reconciliation Module
 *
 * Periodically checks that local NFT state (vms.json) matches on-chain state.
 * Fixes discrepancies caused by partial failures during VM provisioning.
 */

import { ethers } from "ethers";
import { spawnSync } from "child_process";
import * as fs from "fs";
import { getCommand } from "../provisioner";
import { loadWeb3Defaults } from "../config/web3-config";
import { loadBlockhostConfig } from "../config/blockhost-config";
import { NFT_READ_ABI } from "../config/nft-abi";

const VMS_JSON_PATH = "/var/lib/blockhost/vms.json";
const PROVISIONING_LOCK_PATH = "/run/blockhost/provisioning.lock";
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface VmEntry {
  vm_name: string;
  owner_wallet: string;
  nft_token_id?: number;
  nft_minted?: boolean;
  status: string;
  gecos_synced?: boolean;
  network_config_synced?: boolean;
}

interface VmsDatabase {
  vms: Record<string, VmEntry>;
  allocated_ips: string[];
}

let lastReconcileTime = 0;
let reconcileInProgress = false;

/**
 * Load NFT contract address from config (web3-defaults.yaml first, blockhost.yaml fallback)
 */
function loadNftContract(): string | null {
  try {
    // Try web3-defaults.yaml first
    const web3 = loadWeb3Defaults();
    if (web3) {
      const blockchain = web3.blockchain as Record<string, unknown> | undefined;
      if (blockchain?.nft_contract) {
        return blockchain.nft_contract as string;
      }
    }

    // Fall back to blockhost.yaml
    const bhConfig = loadBlockhostConfig();
    if (bhConfig?.nft_contract) {
      return bhConfig.nft_contract as string;
    }

    return null;
  } catch (err) {
    console.error(`[RECONCILE] Error loading NFT contract address: ${err}`);
    return null;
  }
}

/**
 * Load the local VMs database
 */
function loadVmsDatabase(): VmsDatabase | null {
  try {
    if (!fs.existsSync(VMS_JSON_PATH)) {
      return null;
    }
    const data = fs.readFileSync(VMS_JSON_PATH, "utf8");
    return JSON.parse(data) as VmsDatabase;
  } catch (err) {
    console.error(`[RECONCILE] Error loading vms.json: ${err}`);
    return null;
  }
}

/**
 * Persist field updates to a VM record via blockhost-vmdb update-fields.
 * Routes through common's lockfile so writes serialise with provisioner-owned
 * register_vm / mark_destroyed (per facts/COMMON_INTERFACE.md §2 + §6a).
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
    `[RECONCILE] update-fields failed for ${vmName}: ${errMsg || `exit ${result.status}`}`,
  );
  return false;
}

/**
 * Call the provisioner's update-gecos command to update a VM's GECOS field.
 * Returns true if the command succeeded (exit 0), false otherwise.
 */
function updateGecos(vmName: string, walletAddress: string, nftTokenId: number): boolean {
  try {
    const cmd = getCommand("update-gecos");
    const result = spawnSync(cmd, [vmName, walletAddress, "--nft-id", nftTokenId.toString()], {
      encoding: "utf8",
      timeout: 30000,
      cwd: "/var/lib/blockhost",
    });
    if (result.status === 0) {
      return true;
    }
    const errMsg = (result.stderr || result.stdout || "").trim();
    console.warn(`[RECONCILE] update-gecos failed for ${vmName}: ${errMsg || `exit ${result.status}`}`);
    return false;
  } catch (err) {
    console.warn(`[RECONCILE] update-gecos error for ${vmName}: ${err}`);
    return false;
  }
}

/**
 * Retry blockhost-network-hook push-vm-config for any active VM whose previous
 * push didn't confirm success. The plugin command is idempotent — safe to call
 * every cycle. See facts/ENGINE_INTERFACE.md §13 (Reconciler).
 */
function reconcileNetworkConfig(localDb: VmsDatabase): void {
  for (const [vmName, vm] of Object.entries(localDb.vms)) {
    if (vm.status === "destroyed") continue;
    if (vm.network_config_synced === true) continue;

    const result = spawnSync("blockhost-network-hook", ["push-vm-config", vm.vm_name], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (result.status === 0) {
      if (updateVmFields(vm.vm_name, { network_config_synced: true })) {
        console.log(`[RECONCILE] push-vm-config succeeded for ${vmName}`);
      }
    } else {
      const errMsg = (result.stderr || result.stdout || "").trim();
      console.warn(
        `[RECONCILE] push-vm-config still failing for ${vmName}: ${errMsg || `exit ${result.status}`}`,
      );
    }
  }
}

/**
 * Reconcile NFT ownership: detect transfers and update VM GECOS fields.
 * For each active/suspended VM with a minted NFT, compare on-chain ownerOf()
 * with the locally stored owner_wallet. On mismatch, update local state and
 * call the provisioner's update-gecos command. Failed GECOS updates are
 * retried on subsequent reconciliation cycles via the gecos_synced flag.
 */
async function reconcileOwnership(
  nftContract: ethers.Contract,
  localDb: VmsDatabase,
): Promise<void> {
  for (const [vmName, vm] of Object.entries(localDb.vms)) {
    // Only check active/suspended VMs with minted NFTs
    if (vm.status === "destroyed") continue;
    if (vm.nft_minted !== true) continue;
    if (vm.nft_token_id === undefined) continue;

    let onChainOwner: string;
    try {
      onChainOwner = await nftContract.ownerOf(vm.nft_token_id);
    } catch {
      // Token may have been burned or contract call failed — skip
      continue;
    }

    const localOwner = vm.owner_wallet || "";
    if (onChainOwner.toLowerCase() !== localOwner.toLowerCase()) {
      // Ownership transfer detected
      console.log(`[RECONCILE] NFT #${vm.nft_token_id} transferred: ${localOwner} → ${onChainOwner}`);

      if (!updateVmFields(vm.vm_name, { owner_wallet: onChainOwner, gecos_synced: false })) {
        continue;
      }

      if (updateGecos(vm.vm_name, onChainOwner, vm.nft_token_id)) {
        if (updateVmFields(vm.vm_name, { gecos_synced: true })) {
          console.log(`[RECONCILE] GECOS updated for ${vmName}`);
        }
      } else {
        console.warn(`[RECONCILE] GECOS update failed for ${vmName}, will retry next cycle`);
      }
    } else if (vm.gecos_synced === false) {
      // Previous GECOS update failed — retry
      console.log(`[RECONCILE] Retrying GECOS update for ${vmName}`);
      if (updateGecos(vm.vm_name, vm.owner_wallet, vm.nft_token_id)) {
        if (updateVmFields(vm.vm_name, { gecos_synced: true })) {
          console.log(`[RECONCILE] GECOS retry succeeded for ${vmName}`);
        }
      } else {
        console.warn(`[RECONCILE] GECOS retry failed for ${vmName}, will try again next cycle`);
      }
    }
  }
}

/**
 * Run the NFT reconciliation check
 */
export async function runReconciliation(provider: ethers.Provider): Promise<void> {
  // Concurrency guard
  if (reconcileInProgress) {
    return;
  }

  // If a vm-create is in flight (provisioner holds the lock), defer.
  // The lock is provisioner-owned per facts/PROVISIONER_INTERFACE.md §6a;
  // we only check for its existence — never read its PID, never remove it.
  if (fs.existsSync(PROVISIONING_LOCK_PATH)) {
    return;
  }

  reconcileInProgress = true;

  try {
    // Load NFT contract address
    const nftAddress = loadNftContract();
    if (!nftAddress) {
      // NFT contract not configured yet, skip silently
      return;
    }

    // Load local database
    const localDb = loadVmsDatabase();
    if (!localDb) {
      return;
    }

    // Create contract instance
    const nftContract = new ethers.Contract(nftAddress, NFT_READ_ABI, provider);

    // Reconcile NFT ownership transfers and retry failed GECOS updates
    await reconcileOwnership(nftContract, localDb);

    // Retry push-vm-config for any VM where the prior push didn't succeed
    reconcileNetworkConfig(localDb);

    // Mark reconciliation as done only on success (failed runs retry next poll)
    lastReconcileTime = Date.now();
  } catch (err) {
    console.error(`[RECONCILE] Error during reconciliation: ${err}`);
  } finally {
    reconcileInProgress = false;
  }
}

/**
 * Check if reconciliation should run (based on interval)
 */
export function shouldRunReconciliation(): boolean {
  return Date.now() - lastReconcileTime >= RECONCILE_INTERVAL_MS;
}

/**
 * Get reconciliation interval in milliseconds
 */
export function getReconcileInterval(): number {
  return RECONCILE_INTERVAL_MS;
}
