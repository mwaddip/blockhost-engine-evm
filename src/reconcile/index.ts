/**
 * NFT Reconciliation Module
 *
 * Periodically checks that local NFT state (vms.json) matches on-chain state.
 * Fixes discrepancies caused by partial failures during VM provisioning.
 */

import { ethers } from "ethers";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { getCommand } from "../provisioner";

const VMS_JSON_PATH = "/var/lib/blockhost/vms.json";
const WEB3_CONFIG_PATH = "/etc/blockhost/web3-defaults.yaml";
const BLOCKHOST_CONFIG_PATH = "/etc/blockhost/blockhost.yaml";
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// NFT contract ABI - only what we need
const NFT_ABI = [
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
];

interface VmEntry {
  vm_name: string;
  owner_wallet: string;
  nft_token_id?: number;
  nft_minted?: boolean;
  status: string;
  gecos_synced?: boolean;
}

interface VmsDatabase {
  vms: Record<string, VmEntry>;
  allocated_ips: string[];
  reserved_nft_tokens?: Record<string, { vm_name: string; minted: boolean }>;
}

let lastReconcileTime = 0;
let reconcileInProgress = false;

/**
 * Check if the provisioner's create command is currently running
 */
function isProvisioningInProgress(): boolean {
  try {
    const result = spawnSync("pgrep", ["-f", getCommand("create")], {
      encoding: "utf8",
    });
    if (result.stdout && result.stdout.trim()) {
      return true;
    }

    // Also check for lock file if one exists
    if (fs.existsSync("/var/run/blockhost-provisioning.lock")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Load NFT contract address from config
 */
function loadNftContractAddress(): string | null {
  try {
    // Try web3-defaults.yaml first
    if (fs.existsSync(WEB3_CONFIG_PATH)) {
      const config = yaml.load(fs.readFileSync(WEB3_CONFIG_PATH, "utf8")) as Record<string, unknown>;
      const blockchain = config.blockchain as Record<string, unknown> | undefined;
      if (blockchain?.nft_contract) {
        return blockchain.nft_contract as string;
      }
    }

    // Fall back to blockhost.yaml
    if (fs.existsSync(BLOCKHOST_CONFIG_PATH)) {
      const config = yaml.load(fs.readFileSync(BLOCKHOST_CONFIG_PATH, "utf8")) as Record<string, unknown>;
      if (config.nft_contract) {
        return config.nft_contract as string;
      }
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
 * Save the VMs database
 */
function saveVmsDatabase(db: VmsDatabase): boolean {
  try {
    fs.writeFileSync(VMS_JSON_PATH, JSON.stringify(db, null, 2));
    return true;
  } catch (err) {
    console.error(`[RECONCILE] Error saving vms.json: ${err}`);
    return false;
  }
}

/**
 * Update local state using Python (for consistency with blockhost-provisioner-proxmox)
 */
function markTokenMintedViaPython(tokenId: number, vmName: string): boolean {
  const script = `
from blockhost.vm_db import get_database

db = get_database()
db.mark_nft_minted('${vmName}', ${tokenId})
print(f"Marked token {${tokenId}} as minted for ${vmName}")
`;

  try {
    const result = execSync(`python3 -c "${script.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
      timeout: 10000,
      cwd: "/var/lib/blockhost",
    });
    console.log(`[RECONCILE] ${result.trim()}`);
    return true;
  } catch (err) {
    // Python module might not be available, fall back to direct JSON update
    console.warn(`[RECONCILE] Python update failed, will use direct JSON update`);
    return false;
  }
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

      vm.owner_wallet = onChainOwner;
      vm.gecos_synced = false;
      saveVmsDatabase(localDb);

      if (updateGecos(vm.vm_name, onChainOwner, vm.nft_token_id)) {
        vm.gecos_synced = true;
        saveVmsDatabase(localDb);
        console.log(`[RECONCILE] GECOS updated for ${vmName}`);
      } else {
        console.warn(`[RECONCILE] GECOS update failed for ${vmName}, will retry next cycle`);
      }
    } else if (vm.gecos_synced === false) {
      // Previous GECOS update failed — retry
      console.log(`[RECONCILE] Retrying GECOS update for ${vmName}`);
      if (updateGecos(vm.vm_name, vm.owner_wallet, vm.nft_token_id)) {
        vm.gecos_synced = true;
        saveVmsDatabase(localDb);
        console.log(`[RECONCILE] GECOS retry succeeded for ${vmName}`);
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

  // Check if provisioning is in progress
  if (isProvisioningInProgress()) {
    console.log(`[RECONCILE] Skipping - provisioning in progress`);
    return;
  }

  reconcileInProgress = true;

  try {
    // Load NFT contract address
    const nftAddress = loadNftContractAddress();
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
    const nftContract = new ethers.Contract(nftAddress, NFT_ABI, provider);

    // Get on-chain total supply
    let onChainSupply: bigint;
    try {
      onChainSupply = await nftContract.totalSupply();
    } catch (err) {
      // Contract might not be deployed or doesn't have totalSupply
      console.warn(`[RECONCILE] Could not query totalSupply: ${err}`);
      return;
    }

    const onChainCount = Number(onChainSupply);

    // Derive local expected next ID from reserved_nft_tokens keys
    // The next ID would be max(existing keys) + 1, or 0 if no tokens reserved
    let localNextId = 0;
    if (localDb.reserved_nft_tokens) {
      const reservedIds = Object.keys(localDb.reserved_nft_tokens).map(k => parseInt(k, 10));
      if (reservedIds.length > 0) {
        localNextId = Math.max(...reservedIds) + 1;
      }
    }

    // If on-chain has more tokens than local expects, we need to reconcile
    if (onChainCount > localNextId) {
      console.log(`[RECONCILE] Discrepancy detected: on-chain has ${onChainCount} tokens, local max reserved=${localNextId - 1}`);

      // Check each token from localNextId to onChainCount-1
      for (let tokenId = localNextId; tokenId < onChainCount; tokenId++) {
        await reconcileToken(nftContract, localDb, tokenId);
      }
    }

    // Also check VMs that have reserved tokens but not marked as minted
    for (const [vmName, vm] of Object.entries(localDb.vms)) {
      if (vm.nft_token_id !== undefined && vm.nft_minted !== true) {
        // Check if this token actually exists on-chain
        try {
          await nftContract.ownerOf(vm.nft_token_id);
          // Token exists on-chain, mark as minted locally
          console.log(`[RECONCILE] Token #${vm.nft_token_id} exists on-chain but not marked minted for ${vmName}`);

          if (!markTokenMintedViaPython(vm.nft_token_id, vmName)) {
            // Fall back to direct update
            vm.nft_minted = true;
            saveVmsDatabase(localDb);
          }
          console.log(`[RECONCILE] Reconciled NFT token #${vm.nft_token_id}: marked as minted for ${vmName}`);
        } catch {
          // Token doesn't exist on-chain, that's expected for reserved-but-not-minted
        }
      }
    }

    // Check reserved_nft_tokens map if it exists
    if (localDb.reserved_nft_tokens) {
      for (const [tokenIdStr, tokenInfo] of Object.entries(localDb.reserved_nft_tokens)) {
        const tokenId = parseInt(tokenIdStr, 10);
        if (!tokenInfo.minted && tokenId < onChainCount) {
          // Check if token exists on-chain
          try {
            await nftContract.ownerOf(tokenId);
            // Token exists, mark as minted
            console.log(`[RECONCILE] Token #${tokenId} in nft_tokens exists on-chain but not marked minted`);
            tokenInfo.minted = true;
            saveVmsDatabase(localDb);
            console.log(`[RECONCILE] Reconciled NFT token #${tokenId}: marked as minted for ${tokenInfo.vm_name}`);
          } catch {
            // Token doesn't exist
          }
        }
      }
    }

    // Reconcile NFT ownership transfers and retry failed GECOS updates
    await reconcileOwnership(nftContract, localDb);

  } catch (err) {
    console.error(`[RECONCILE] Error during reconciliation: ${err}`);
  } finally {
    reconcileInProgress = false;
  }
}

/**
 * Reconcile a specific token that exists on-chain but may be missing locally
 */
async function reconcileToken(
  nftContract: ethers.Contract,
  localDb: VmsDatabase,
  tokenId: number
): Promise<void> {
  try {
    // Get token owner from chain
    const owner = await nftContract.ownerOf(tokenId);

    // Try to find which VM this token belongs to
    let foundVm: string | null = null;

    // Check VMs by owner wallet
    for (const [vmName, vm] of Object.entries(localDb.vms)) {
      if (vm.owner_wallet?.toLowerCase() === owner.toLowerCase()) {
        // Check if this VM doesn't have a token assigned or has this specific token
        if (vm.nft_token_id === undefined || vm.nft_token_id === tokenId) {
          foundVm = vmName;
          break;
        }
      }
    }

    if (foundVm) {
      const vm = localDb.vms[foundVm];
      if (vm.nft_token_id === undefined) {
        console.log(`[RECONCILE] Token #${tokenId} found on-chain for ${foundVm}, assigning locally`);
        vm.nft_token_id = tokenId;
      }
      if (!vm.nft_minted) {
        console.log(`[RECONCILE] Marking token #${tokenId} as minted for ${foundVm}`);
        vm.nft_minted = true;
      }
      saveVmsDatabase(localDb);
    } else {
      console.warn(`[RECONCILE] Token #${tokenId} exists on-chain (owner: ${owner}) but no matching VM found locally`);
    }
  } catch (err) {
    console.error(`[RECONCILE] Error reconciling token ${tokenId}: ${err}`);
  }
}

/**
 * Check if reconciliation should run (based on interval)
 */
export function shouldRunReconciliation(): boolean {
  const now = Date.now();
  if (now - lastReconcileTime >= RECONCILE_INTERVAL_MS) {
    lastReconcileTime = now;
    return true;
  }
  return false;
}

/**
 * Get reconciliation interval in milliseconds
 */
export function getReconcileInterval(): number {
  return RECONCILE_INTERVAL_MS;
}
