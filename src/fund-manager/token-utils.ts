/**
 * ERC20 token utilities: ABI, balance queries, USD valuation, metadata cache
 */

import { ethers } from "ethers";
import type { TokenBalance } from "./types";

// Re-export the canonical subscription ABI so existing imports keep working.
export { SUBSCRIPTION_ABI } from "../config/subscription-abi";

// ERC20 ABI - only what we need
export const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// Token metadata is immutable per address; cache it module-wide so the fund
// cycle doesn't refetch decimals/symbol on every call.
const _tokenMetaCache = new Map<string, { decimals: number; symbol: string }>();

async function getTokenMetadata(
  tokenAddress: string,
  provider: ethers.Provider,
): Promise<{ decimals: number; symbol: string }> {
  const key = tokenAddress.toLowerCase();
  let meta = _tokenMetaCache.get(key);
  if (meta) return meta;
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([
    token.decimals() as Promise<number>,
    token.symbol() as Promise<string>,
  ]);
  meta = { decimals: Number(decimals), symbol };
  _tokenMetaCache.set(key, meta);
  return meta;
}

/**
 * Get the balance of an ERC20 token for an address, with metadata.
 * Decimals/symbol come from the module cache; only `balanceOf` hits RPC.
 */
export async function getTokenBalance(
  tokenAddress: string,
  walletAddress: string,
  provider: ethers.Provider,
): Promise<{ balance: bigint; decimals: number; symbol: string }> {
  const meta = await getTokenMetadata(tokenAddress, provider);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const balance = (await token.balanceOf(walletAddress)) as bigint;
  return { balance, decimals: meta.decimals, symbol: meta.symbol };
}

/**
 * Enumerate the contract's active payment-method tokens, deduplicated by
 * lowercase address. Used by withdrawal, getAllTokenBalances, and bw withdraw.
 */
export async function listActivePaymentTokens(
  contract: ethers.Contract,
): Promise<{ address: string; pmId: bigint }[]> {
  const ids: bigint[] = await contract.getPaymentMethodIds();
  const seen = new Set<string>();
  const result: { address: string; pmId: bigint }[] = [];

  for (const pmId of ids) {
    try {
      const [tokenAddress, , , , , active] = await contract.getPaymentMethod(pmId);
      if (!active) continue;
      const lower = tokenAddress.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      result.push({ address: tokenAddress, pmId });
    } catch (err) {
      console.error(`[FUND] Error querying payment method ${pmId}: ${err}`);
    }
  }
  return result;
}

/**
 * Get all token balances for a wallet across all payment methods
 */
export async function getAllTokenBalances(
  walletAddress: string,
  contract: ethers.Contract,
  provider: ethers.Provider,
): Promise<TokenBalance[]> {
  const balances: TokenBalance[] = [];

  let tokens: { address: string; pmId: bigint }[];
  try {
    tokens = await listActivePaymentTokens(contract);
  } catch (err) {
    console.error(`[FUND] Error getting payment method IDs: ${err}`);
    return balances;
  }

  for (const { address: tokenAddress, pmId } of tokens) {
    try {
      const { balance, decimals, symbol } = await getTokenBalance(
        tokenAddress,
        walletAddress,
        provider,
      );

      let usdValue = 0;
      if (balance > 0n) {
        try {
          const priceUsdCents: bigint = await contract.getTokenPriceUsdCents(pmId);
          const balanceFloat = parseFloat(ethers.formatUnits(balance, decimals));
          usdValue = (balanceFloat * Number(priceUsdCents)) / 100;
        } catch (err) {
          // Skip on price-query failure — coercing to $1 produces wrong distribution
          // decisions for non-stablecoins. The reconciler revisits next cycle.
          console.warn(
            `[FUND] Price query failed for ${symbol} (pmId=${pmId}), skipping: ${err}`,
          );
          continue;
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

  return balances;
}

/**
 * Transfer ERC20 tokens from a signing wallet to a recipient
 */
export async function transferToken(
  tokenAddress: string,
  to: string,
  amount: bigint,
  signer: ethers.Wallet,
): Promise<ethers.TransactionReceipt | null> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const tx = await token.transfer(to, amount);
  return tx.wait();
}
