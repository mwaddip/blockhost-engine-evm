/**
 * Contract withdrawal logic
 *
 * Step 1 of the fund cycle: withdraw accumulated tokens from the
 * subscription contract to the hot wallet.
 * Uses bw withdraw under the hood.
 */

import { ethers } from "ethers";
import type { Addressbook, FundManagerConfig } from "./types";
import { getTokenBalance } from "./token-utils";
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

  // Get all payment method IDs
  let paymentMethodIds: bigint[];
  try {
    paymentMethodIds = await contract.getPaymentMethodIds();
  } catch (err) {
    console.error(`[FUND] Error getting payment method IDs: ${err}`);
    return;
  }

  if (paymentMethodIds.length === 0) {
    console.log("[FUND] No payment methods configured, skipping withdrawal");
    return;
  }

  // Collect unique token addresses with their payment method ID (for price lookup)
  const tokens = new Map<string, { address: string; pmId: bigint }>();
  for (const pmId of paymentMethodIds) {
    try {
      const [tokenAddress, , , , , active] = await contract.getPaymentMethod(pmId);
      if (!active) continue;
      const addrLower = tokenAddress.toLowerCase();
      if (!tokens.has(addrLower)) {
        tokens.set(addrLower, { address: tokenAddress, pmId });
      }
    } catch (err) {
      console.error(`[FUND] Error querying payment method ${pmId}: ${err}`);
    }
  }

  // For each unique token, check contract balance and withdraw if above threshold
  for (const [, { address: tokenAddress, pmId }] of tokens) {
    try {
      const { balance, decimals, symbol } = await getTokenBalance(
        tokenAddress,
        contractAddress,
        provider
      );
      if (balance === 0n) continue;

      // Check USD value
      let usdValue: number;
      try {
        const priceUsdCents: bigint = await contract.getTokenPriceUsdCents(pmId);
        const balanceFloat = parseFloat(ethers.formatUnits(balance, decimals));
        usdValue = (balanceFloat * Number(priceUsdCents)) / 100;
      } catch (err) {
        usdValue = parseFloat(ethers.formatUnits(balance, decimals));
        console.warn(`[FUND] Price query failed for ${symbol} (pmId=${pmId}), using $1 fallback: ${err}`);
      }

      if (usdValue < config.min_withdrawal_usd) {
        console.log(
          `[FUND] Skipping ${symbol}: $${usdValue.toFixed(2)} below $${config.min_withdrawal_usd} threshold`
        );
        continue;
      }

      console.log(
        `[FUND] Withdrawing ${ethers.formatUnits(balance, decimals)} ${symbol} (~$${usdValue.toFixed(2)}) to hot wallet`
      );

      const txHash = await executeWithdraw(tokenAddress, "hot", book, provider, contractAddress);
      if (txHash) {
        console.log(`[FUND] Withdrawal complete: tx ${txHash}`);
      }
    } catch (err) {
      console.error(`[FUND] Error withdrawing ${tokenAddress}: ${err}`);
    }
  }
}
