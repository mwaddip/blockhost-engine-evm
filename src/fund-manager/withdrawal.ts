/**
 * Contract withdrawal logic
 *
 * Step 1 of the fund cycle: withdraw accumulated tokens from the
 * subscription contract to the hot wallet.
 * Uses bw withdraw under the hood.
 */

import { ethers } from "ethers";
import type { FundManagerConfig } from "./types";
import type { Addressbook } from "../addressbook";
import { getTokenBalance, listActivePaymentTokens } from "./token-utils";
import { executeWithdraw } from "../bw/commands/withdraw";

/**
 * Withdraw all eligible token balances from the contract to the hot wallet.
 * Only withdraws tokens whose USD value exceeds the configured threshold.
 */
export async function withdrawFromContract(
  book: Addressbook,
  config: FundManagerConfig,
  provider: ethers.Provider,
  contract: ethers.Contract
): Promise<void> {
  if (!book.server?.keyfile) {
    console.error("[FUND] Cannot withdraw: server wallet has no keyfile");
    return;
  }

  const hotAddress = book.hot?.address;
  if (!hotAddress) {
    console.error("[FUND] Cannot withdraw: hot wallet not configured");
    return;
  }

  const contractAddress = await contract.getAddress();

  let tokens: { address: string; pmId: bigint }[];
  try {
    tokens = await listActivePaymentTokens(contract);
  } catch (err) {
    console.error(`[FUND] Error getting payment method IDs: ${err}`);
    return;
  }

  if (tokens.length === 0) {
    console.log("[FUND] No payment methods configured, skipping withdrawal");
    return;
  }

  for (const { address: tokenAddress, pmId } of tokens) {
    try {
      const { balance, decimals, symbol } = await getTokenBalance(
        tokenAddress,
        contractAddress,
        provider,
      );
      if (balance === 0n) continue;

      // Check USD value. Skip on price-query failure — coercing to $1 makes
      // wrong withdrawal decisions for non-stablecoin tokens.
      let usdValue: number;
      try {
        const priceUsdCents: bigint = await contract.getTokenPriceUsdCents(pmId);
        const balanceFloat = parseFloat(ethers.formatUnits(balance, decimals));
        usdValue = (balanceFloat * Number(priceUsdCents)) / 100;
      } catch (err) {
        console.warn(`[FUND] Price query failed for ${symbol} (pmId=${pmId}), skipping withdrawal this cycle: ${err}`);
        continue;
      }

      if (usdValue < config.min_withdrawal_usd) {
        console.log(
          `[FUND] Skipping ${symbol}: $${usdValue.toFixed(2)} below $${config.min_withdrawal_usd} threshold`,
        );
        continue;
      }

      console.log(
        `[FUND] Withdrawing ${ethers.formatUnits(balance, decimals)} ${symbol} (~$${usdValue.toFixed(2)}) to hot wallet`,
      );

      // Pass the already-fetched balance so executeWithdraw doesn't re-query.
      const txHash = await executeWithdraw(
        tokenAddress, "hot", book, provider, contractAddress, balance,
      );
      if (txHash) {
        console.log(`[FUND] Withdrawal complete: tx ${txHash}`);
      }
    } catch (err) {
      console.error(`[FUND] Error withdrawing ${tokenAddress}: ${err}`);
    }
  }
}
