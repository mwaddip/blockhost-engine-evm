/**
 * Hot wallet distribution logic
 *
 * Steps 2-5 of the fund cycle:
 *  2. Top up hot wallet gas (server → hot ETH if hot is low)
 *  3. Top up server stablecoin buffer (hot → server stablecoin)
 *  4. Revenue shares (hot → dev/broker per revenue-share.json)
 *  5. Remainder to admin (hot → admin)
 *
 * All transfers use bw executeSend() — no inline ethers.js transfer code.
 */

import { ethers } from "ethers";
import type { Addressbook, FundManagerConfig, RevenueShareConfig } from "./types";
import { resolveAddress } from "./addressbook";
import { getTokenBalance, getAllTokenBalances } from "./token-utils";
import { executeSend } from "../bw/commands/send";

/**
 * Step 2: Ensure hot wallet has enough ETH to pay for transfers.
 * Server sends ETH to bring it up to the configured target (hot_wallet_gas_eth).
 * Also called from the periodic gas check cycle.
 */
export async function topUpHotWalletGas(
  book: Addressbook,
  config: FundManagerConfig,
  provider: ethers.Provider,
  contract: ethers.Contract
): Promise<void> {
  const hotAddress = book.hot?.address;
  if (!hotAddress) return;

  const target = ethers.parseEther(config.hot_wallet_gas_eth.toString());
  const hotBalance = await provider.getBalance(hotAddress);
  if (hotBalance >= target) return;

  const serverAddress = book.server?.address;
  if (!serverAddress) return;

  const needed = target - hotBalance;
  const serverBalance = await provider.getBalance(serverAddress);
  if (serverBalance < needed * 2n) {
    console.warn("[FUND] Server wallet ETH too low to top up hot wallet");
    return;
  }

  const neededStr = ethers.formatEther(needed);
  console.log(`[FUND] Topping up hot wallet gas: ${neededStr} ETH`);
  const txHash = await executeSend(neededStr, "eth", "server", "hot", book, provider, contract);
  console.log(`[FUND] Hot wallet gas top-up complete: tx ${txHash}`);
}

/**
 * Step 3: Ensure server wallet has enough stablecoin for future gas swaps.
 * Hot wallet sends stablecoin to server if server balance is below buffer.
 */
export async function topUpServerStablecoinBuffer(
  book: Addressbook,
  config: FundManagerConfig,
  provider: ethers.Provider,
  contract: ethers.Contract
): Promise<void> {
  const serverAddress = book.server?.address;
  if (!serverAddress) return;

  let stablecoinAddress: string;
  try {
    stablecoinAddress = await contract.getPrimaryStablecoin();
    if (stablecoinAddress === ethers.ZeroAddress) return;
  } catch (err) {
    console.error(`[FUND] Failed to query primary stablecoin, skipping buffer top-up: ${err}`);
    return;
  }

  const { balance: serverStableBalance, decimals } = await getTokenBalance(
    stablecoinAddress,
    serverAddress,
    provider
  );

  const bufferTarget = ethers.parseUnits(
    config.server_stablecoin_buffer_usd.toString(),
    decimals
  );
  if (serverStableBalance >= bufferTarget) return;

  // Check hot wallet has enough
  const needed = bufferTarget - serverStableBalance;
  const { balance: hotStableBalance } = await getTokenBalance(
    stablecoinAddress,
    book.hot!.address,
    provider
  );
  if (hotStableBalance < needed) {
    console.warn("[FUND] Hot wallet stablecoin insufficient for server buffer top-up");
    return;
  }

  const neededStr = ethers.formatUnits(needed, decimals);
  console.log(`[FUND] Topping up server stablecoin buffer: ${neededStr} to server`);
  await executeSend(neededStr, stablecoinAddress, "hot", "server", book, provider, contract);
  console.log("[FUND] Server stablecoin buffer topped up");
}

/**
 * Step 4: Distribute revenue shares from hot wallet.
 */
export async function distributeRevenueShares(
  book: Addressbook,
  revenueConfig: RevenueShareConfig,
  provider: ethers.Provider,
  contract: ethers.Contract
): Promise<void> {
  if (!revenueConfig.enabled || revenueConfig.recipients.length === 0) {
    return;
  }

  const balances = await getAllTokenBalances(book.hot!.address, contract, provider);

  for (const tb of balances) {
    if (tb.balance === 0n) continue;

    // Calculate total share amount
    const totalShareAmount =
      (tb.balance * BigInt(Math.round(revenueConfig.total_percent * 100))) / 10000n;
    if (totalShareAmount === 0n) continue;

    // Distribute to each recipient
    let distributed = 0n;
    for (let i = 0; i < revenueConfig.recipients.length; i++) {
      const recipient = revenueConfig.recipients[i];
      const recipientAddress = resolveAddress(recipient.role, book);
      if (!recipientAddress) {
        console.error(`[FUND] Revenue share recipient '${recipient.role}' not in addressbook`);
        continue;
      }

      const isLast = i === revenueConfig.recipients.length - 1;
      let share: bigint;
      if (isLast) {
        // Last recipient gets remainder; clamp to 0 if rounding caused overallocation
        share = distributed >= totalShareAmount ? 0n : totalShareAmount - distributed;
      } else {
        share = (totalShareAmount * BigInt(Math.round(recipient.percent * 100))) /
          BigInt(Math.round(revenueConfig.total_percent * 100));
      }
      distributed += share;
      if (share === 0n) continue;

      try {
        const shareStr = ethers.formatUnits(share, tb.decimals);
        await executeSend(shareStr, tb.tokenAddress, "hot", recipient.role, book, provider, contract);
        console.log(
          `[FUND] Revenue share: sent ${shareStr} ${tb.symbol} to ${recipient.role} (${recipient.percent}%)`
        );
      } catch (err) {
        console.error(`[FUND] Error sending revenue share to ${recipient.role}: ${err}`);
      }
    }
  }
}

/**
 * Step 5: Send all remaining token balances from hot wallet to admin.
 */
export async function sendRemainderToAdmin(
  book: Addressbook,
  provider: ethers.Provider,
  contract: ethers.Contract
): Promise<void> {
  if (!resolveAddress("admin", book)) {
    console.error("[FUND] Cannot send remainder: admin not in addressbook");
    return;
  }

  const balances = await getAllTokenBalances(book.hot!.address, contract, provider);

  for (const tb of balances) {
    if (tb.balance === 0n) continue;

    try {
      const amountStr = ethers.formatUnits(tb.balance, tb.decimals);
      await executeSend(amountStr, tb.tokenAddress, "hot", "admin", book, provider, contract);
      console.log(`[FUND] Remainder: sent ${amountStr} ${tb.symbol} to admin`);
    } catch (err) {
      console.error(`[FUND] Error sending remainder to admin: ${err}`);
    }
  }
}
