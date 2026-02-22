/**
 * bw who <identifier>
 * bw who <message> <signature>
 *
 * Query the owner of an AccessCredentialNFT by token ID, or recover a signer
 * address from a message and signature.
 *
 * Forms:
 *   bw who <nft_id>              — who owns NFT token? (integer)
 *   bw who admin                 — who owns admin NFT? (from blockhost.yaml)
 *   bw who <message> <signature> — who signed this message? (signature recovery)
 *
 * Reads nft_contract and rpc_url from web3-defaults.yaml,
 * and admin.credential_nft_id from blockhost.yaml.
 */

import { ethers } from "ethers";
import { loadWeb3Config } from "../../config/web3-config";
import { loadBlockhostConfig } from "../../config/blockhost-config";
import { NFT_READ_ABI } from "../../config/nft-abi";

function loadAdminNftId(): number {
  const raw = loadBlockhostConfig();
  if (!raw) {
    throw new Error("Config not found: blockhost.yaml");
  }

  const admin = raw.admin as Record<string, unknown> | undefined;

  if (!admin || admin.credential_nft_id === undefined || admin.credential_nft_id === null) {
    throw new Error("admin.credential_nft_id not set in blockhost.yaml");
  }

  const id = Number(admin.credential_nft_id);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid admin.credential_nft_id: ${admin.credential_nft_id}`);
  }

  return id;
}

function isSignature(arg: string): boolean {
  return /^0x[0-9a-fA-F]{130}$/.test(arg);
}

/**
 * CLI handler
 */
export async function whoCommand(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw who <identifier>");
    console.error("       bw who <message> <signature>");
    console.error("  identifier: token ID (0, 1, 2, ...) or 'admin'");
    console.error("  signature:  0x-prefixed 65-byte signature (130 hex chars)");
    process.exit(1);
  }

  // Signature recovery form: bw who <message> <signature>
  if (args.length === 2) {
    const [msg, sig] = isSignature(args[1]) ? [args[0], args[1]] : [args[1], args[0]];
    if (!isSignature(sig)) {
      console.error("Error: second form requires a valid signature (0x + 130 hex chars)");
      process.exit(1);
    }
    try {
      const signer = ethers.verifyMessage(msg, sig);
      console.log(signer);
    } catch {
      console.error("Error: could not recover signer from message and signature");
      process.exit(1);
    }
    return;
  }

  const identifier = args[0];

  let tokenId: number;
  if (identifier === "admin") {
    tokenId = loadAdminNftId();
  } else if (/^\d+$/.test(identifier)) {
    tokenId = parseInt(identifier, 10);
  } else {
    console.error(`Invalid identifier: '${identifier}'. Use a token ID or 'admin'.`);
    process.exit(1);
  }

  const { nftContract, rpcUrl } = loadWeb3Config();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(nftContract, NFT_READ_ABI, provider);

  try {
    const owner: string = await contract.ownerOf(tokenId);
    console.log(owner);
  } catch {
    console.error(`Error: token ${tokenId} does not exist`);
    process.exit(1);
  }
}
