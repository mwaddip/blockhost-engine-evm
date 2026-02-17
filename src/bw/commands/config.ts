/**
 * bw config stable [address]
 *
 * Read or set the primary stablecoin on the subscription contract.
 *
 *   bw config stable              — show current primary stablecoin address
 *   bw config stable 0xToken...   — set primary stablecoin (owner-only)
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveWallet } from "../../fund-manager/addressbook";
import { SUBSCRIPTION_ABI } from "../../fund-manager/token-utils";

export async function configCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider,
  contract: ethers.Contract
): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw config stable [address]");
    console.error("  No address: show current primary stablecoin");
    console.error("  With address: set primary stablecoin (owner-only)");
    process.exit(1);
  }

  const subcommand = args[0];

  if (subcommand !== "stable") {
    console.error(`Unknown config subcommand: ${subcommand}`);
    console.error("Available: stable");
    process.exit(1);
  }

  if (args.length === 1) {
    // Read-only: show current primary stablecoin
    const stablecoin: string = await contract.getPrimaryStablecoin();
    if (stablecoin === ethers.ZeroAddress) {
      console.error("No primary stablecoin configured");
      process.exit(1);
    }
    console.log(stablecoin);
    return;
  }

  // Write: set primary stablecoin
  const address = args[1];
  if (!ethers.isAddress(address)) {
    console.error(`Invalid address: ${address}`);
    process.exit(1);
  }

  const signer = resolveWallet("server", book, provider);
  if (!signer) {
    console.error("Error: server wallet not available for signing");
    process.exit(1);
  }

  const signedContract = new ethers.Contract(
    await contract.getAddress(),
    SUBSCRIPTION_ABI,
    signer
  );

  const tx = await signedContract.setPrimaryStablecoin(address);
  await tx.wait();
  console.log(address);
}
