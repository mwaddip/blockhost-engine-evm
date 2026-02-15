/**
 * ERC20 token utilities: ABI, balance queries, USD valuation
 */

import { ethers } from "ethers";
import type { TokenBalance } from "./types";

// ERC20 ABI - only what we need
export const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// Subscription contract ABI - functions needed by fund-manager and bw CLI
export const SUBSCRIPTION_ABI = [
  "function withdrawFunds(address tokenAddress, address to) external",
  "function getPaymentMethodIds() view returns (uint256[])",
  "function getPaymentMethod(uint256) view returns (address tokenAddress, address pairAddress, address stablecoinAddress, uint8 tokenDecimals, uint8 stablecoinDecimals, bool active)",
  "function getPrimaryStablecoin() view returns (address)",
  "function setPrimaryStablecoin(address) external",
  "function createPlan(string, uint256) external returns (uint256)",
  "event PlanCreated(uint256 indexed planId, string name, uint256 pricePerDayUsdCents)",
  "function getTokenPriceUsdCents(uint256) view returns (uint256)",
  "function owner() view returns (address)",
];

/**
 * Get the balance of an ERC20 token for an address, with metadata
 */
export async function getTokenBalance(
  tokenAddress: string,
  walletAddress: string,
  provider: ethers.Provider
): Promise<{ balance: bigint; decimals: number; symbol: string }> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [balance, decimals, symbol] = await Promise.all([
    token.balanceOf(walletAddress) as Promise<bigint>,
    token.decimals() as Promise<number>,
    token.symbol() as Promise<string>,
  ]);
  return { balance, decimals: Number(decimals), symbol };
}

/**
 * Get all token balances for a wallet across all payment methods
 */
export async function getAllTokenBalances(
  walletAddress: string,
  contract: ethers.Contract,
  provider: ethers.Provider
): Promise<TokenBalance[]> {
  const balances: TokenBalance[] = [];
  const seen = new Set<string>();

  try {
    const paymentMethodIds: bigint[] = await contract.getPaymentMethodIds();

    for (const pmId of paymentMethodIds) {
      try {
        const [tokenAddress, , , , , active] = await contract.getPaymentMethod(pmId);
        if (!active) continue;

        const addrLower = tokenAddress.toLowerCase();
        if (seen.has(addrLower)) continue;
        seen.add(addrLower);

        const { balance, decimals, symbol } = await getTokenBalance(
          tokenAddress,
          walletAddress,
          provider
        );

        let usdValue = 0;
        if (balance > 0n) {
          try {
            const priceUsdCents: bigint = await contract.getTokenPriceUsdCents(pmId);
            const balanceFloat = parseFloat(ethers.formatUnits(balance, decimals));
            usdValue = (balanceFloat * Number(priceUsdCents)) / 100;
          } catch {
            // Price query failed; stablecoins default to $1
            const balanceFloat = parseFloat(ethers.formatUnits(balance, decimals));
            usdValue = balanceFloat; // Assume 1:1 for stablecoins
          }
        }

        balances.push({
          tokenAddress,
          symbol,
          balance,
          decimals,
          usdValue,
          paymentMethodId: Number(pmId),
        });
      } catch (err) {
        console.error(`[FUND] Error querying payment method ${pmId}: ${err}`);
      }
    }
  } catch (err) {
    console.error(`[FUND] Error getting payment method IDs: ${err}`);
  }

  return balances;
}

/**
 * Transfer ERC20 tokens from a signing wallet to a recipient
 */
export async function transferToken(
  tokenAddress: string,
  to: string,
  amount: bigint,
  signer: ethers.Wallet
): Promise<ethers.TransactionReceipt | null> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const tx = await token.transfer(to, amount);
  return tx.wait();
}

/**
 * Format a token balance for display
 */
export function formatTokenBalance(
  balance: bigint,
  decimals: number,
  symbol: string
): string {
  return `${ethers.formatUnits(balance, decimals)} ${symbol}`;
}
