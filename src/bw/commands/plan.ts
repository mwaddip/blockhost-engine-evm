/**
 * bw plan create <name> <price>
 *
 * Create a subscription plan on the contract.
 *
 *   bw plan create "Basic" 100   — create plan at $1.00/day (100 cents)
 *
 * Prints the created plan ID to stdout.
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveWallet } from "../../fund-manager/addressbook";
import { SUBSCRIPTION_ABI } from "../../fund-manager/token-utils";

export async function planCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider,
  contract: ethers.Contract
): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw plan create <name> <price>");
    console.error("  name:  plan name (string)");
    console.error("  price: price in USD cents per day (integer)");
    process.exit(1);
  }

  const subcommand = args[0];

  if (subcommand !== "create") {
    console.error(`Unknown plan subcommand: ${subcommand}`);
    console.error("Available: create");
    process.exit(1);
  }

  if (args.length < 3) {
    console.error("Usage: bw plan create <name> <price>");
    process.exit(1);
  }

  const name = args[1];
  const priceStr = args[2];

  const price = parseInt(priceStr, 10);
  if (isNaN(price) || price <= 0) {
    console.error(`Invalid price: ${priceStr} (must be a positive integer, in USD cents per day)`);
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

  const tx = await signedContract.createPlan(name, price);
  const receipt = await tx.wait();

  // Extract plan ID from PlanCreated event
  const iface = new ethers.Interface(SUBSCRIPTION_ABI);
  for (const log of receipt!.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed && parsed.name === "PlanCreated") {
        console.log(parsed.args.planId.toString());
        return;
      }
    } catch {
      // Not our event, skip
    }
  }

  // Fallback: if we couldn't parse the event, just confirm success
  console.error("Warning: could not extract plan ID from transaction receipt");
  process.exit(1);
}
