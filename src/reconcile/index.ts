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
}

let lastReconcileTime = 0;
let reconcileInProgress = false;

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

    // Reconcile NFT minting: for each active/suspended VM where nft_minted !== true,
    // check on-chain for an NFT owned by this wallet
    for (const [vmName, vm] of Object.entries(localDb.vms)) {
      if (vm.status === "destroyed") continue;
      if (vm.nft_minted === true) continue;

      if (vm.nft_token_id !== undefined) {
        // VM has a token ID assigned — check if it exists on-chain
        try {
          await nftContract.ownerOf(vm.nft_token_id);
          // Token exists on-chain, mark as minted locally
          console.log(`[RECONCILE] Token #${vm.nft_token_id} exists on-chain for ${vmName}, marking minted`);
          if (!markTokenMintedViaPython(vm.nft_token_id, vmName)) {
            vm.nft_minted = true;
            saveVmsDatabase(localDb);
          }
        } catch {
          // Token doesn't exist on-chain yet
          console.warn(`[RECONCILE] Token #${vm.nft_token_id} not found on-chain for ${vmName}`);
        }
      } else {
        // No token ID assigned — log warning
        console.warn(`[RECONCILE] VM ${vmName} has no NFT token ID and nft_minted !== true`);
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
