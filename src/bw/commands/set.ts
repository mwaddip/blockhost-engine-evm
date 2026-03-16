/**
 * bw set encrypt <nft_id> <userEncrypted>
 *
 * Update the userEncrypted field on an AccessCredentialNFT.
 *
 *   bw set encrypt 0 0xDEADBEEF...   — update NFT #0 encrypted data
 *
 * Prints the transaction hash to stdout.
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveWallet } from "../../fund-manager/addressbook";
import { loadNftContractAddress } from "../../config/web3-config";
import { NFT_WRITE_ABI } from "../../config/nft-abi";

export async function setCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw set encrypt <nft_id> <userEncrypted>");
    console.error("  nft_id:        NFT token ID (integer)");
    console.error("  userEncrypted: hex-encoded encrypted data");
    process.exit(1);
  }

  const subcommand = args[0];

  if (subcommand !== "encrypt") {
    console.error(`Unknown set subcommand: ${subcommand}`);
    console.error("Available: encrypt");
    process.exit(1);
  }

  if (args.length < 3) {
    console.error("Usage: bw set encrypt <nft_id> <userEncrypted>");
    process.exit(1);
  }

  const nftIdStr = args[1];
  const userEncrypted = args[2];

  const nftId = parseInt(nftIdStr, 10);
  if (isNaN(nftId) || nftId < 0) {
    console.error(`Invalid NFT ID: ${nftIdStr}`);
    process.exit(1);
  }

  // Validate hex data
  if (!/^0x[0-9a-fA-F]+$/.test(userEncrypted)) {
    console.error("Error: userEncrypted must be valid hex (0x prefix + hex chars)");
    process.exit(1);
  }

  const signer = resolveWallet("server", book, provider);
  if (!signer) {
    console.error("Error: server wallet not available for signing");
    process.exit(1);
  }

  const nftContractAddress = loadNftContractAddress();
  const nftContract = new ethers.Contract(nftContractAddress, NFT_WRITE_ABI, signer);

  const tx = await nftContract.updateUserEncrypted(nftId, userEncrypted);
  const receipt = await tx.wait();
  if (!receipt) {
    console.error("Error: transaction dropped from mempool");
    process.exit(1);
  }
  console.log(receipt.hash);
}
