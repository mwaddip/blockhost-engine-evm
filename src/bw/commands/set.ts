/**
 * bw set encrypt <nft_id> <userEncrypted>
 *
 * Update the userEncrypted field on an AccessCredentialNFT.
 *
 *   bw set encrypt 0 0xDEADBEEF...   — update NFT #0 encrypted data
 *
 * Prints the transaction hash to stdout.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveWallet } from "../../fund-manager/addressbook";

const WEB3_DEFAULTS_PATH = "/etc/blockhost/web3-defaults.yaml";

const NFT_WRITE_ABI = [
  "function updateUserEncrypted(uint256, bytes) external",
];

function loadNftContract(): string {
  if (!fs.existsSync(WEB3_DEFAULTS_PATH)) {
    throw new Error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
  }

  const raw = yaml.load(fs.readFileSync(WEB3_DEFAULTS_PATH, "utf8")) as Record<string, unknown>;
  const blockchain = raw.blockchain as Record<string, unknown> | undefined;

  const nftContract = blockchain?.nft_contract as string | undefined;
  if (!nftContract || !ethers.isAddress(nftContract)) {
    throw new Error("blockchain.nft_contract not set or invalid in web3-defaults.yaml");
  }

  return nftContract;
}

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
  if (!userEncrypted.startsWith("0x")) {
    console.error("Error: userEncrypted must be hex-encoded (0x prefix)");
    process.exit(1);
  }

  const signer = resolveWallet("server", book, provider);
  if (!signer) {
    console.error("Error: server wallet not available for signing");
    process.exit(1);
  }

  const nftContractAddress = loadNftContract();
  const nftContract = new ethers.Contract(nftContractAddress, NFT_WRITE_ABI, signer);

  const tx = await nftContract.updateUserEncrypted(nftId, userEncrypted);
  const receipt = await tx.wait();
  console.log(receipt!.hash);
}
