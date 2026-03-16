/**
 * CLI utilities: token resolution, output formatting
 */

import { ethers } from "ethers";
import { SUBSCRIPTION_ABI } from "../fund-manager/token-utils";

/**
 * Resolve a token shortcut to an address.
 * "eth" → native gas token (returns "eth")
 * "stable" → contract's getPrimaryStablecoin()
 * "0x..." → raw token address
 */
export async function resolveToken(
  token: string,
  contract: ethers.Contract
): Promise<{ address: string; isNative: boolean }> {
  const lower = token.toLowerCase();

  if (lower === "eth" || lower === "native") {
    return { address: "eth", isNative: true };
  }

  if (lower === "stable" || lower === "stablecoin" || lower === "usdc") {
    const stablecoin: string = await contract.getPrimaryStablecoin();
    if (stablecoin === ethers.ZeroAddress) {
      throw new Error("No primary stablecoin configured on contract");
    }
    return { address: stablecoin, isNative: false };
  }

  if (token.startsWith("0x")) {
    if (!ethers.isAddress(token)) {
      throw new Error(`Invalid token address: ${token}`);
    }
    return { address: token, isNative: false };
  }

  throw new Error(`Unknown token: '${token}'. Use 'eth', 'stable', or a 0x address.`);
}

/**
 * Create an ethers provider and subscription contract from env vars
 */
export function createProviderAndContract(): {
  provider: ethers.JsonRpcProvider;
  contract: ethers.Contract;
} {
  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.BLOCKHOST_CONTRACT;

  if (!rpcUrl) {
    console.error("Error: RPC_URL environment variable not set");
    process.exit(1);
  }

  if (!contractAddress) {
    console.error("Error: BLOCKHOST_CONTRACT environment variable not set");
    process.exit(1);
  }

  if (!ethers.isAddress(contractAddress)) {
    console.error(`Error: BLOCKHOST_CONTRACT is not a valid address: ${contractAddress}`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(contractAddress, SUBSCRIPTION_ABI, provider);
  return { provider, contract };
}

/**
 * Format USD value for display
 */
export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

