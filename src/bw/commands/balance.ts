/**
 * bw balance <role> [token]
 *
 * Show balances for a wallet (native + all payment method tokens, or a specific token)
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveAddress } from "../../fund-manager/addressbook";
import {
  getAllTokenBalances,
  getTokenBalance,
} from "../../fund-manager/token-utils";
import { resolveToken, formatUsd } from "../cli-utils";

export async function balanceCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider,
  contract: ethers.Contract
): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw balance <role> [token]");
    process.exit(1);
  }

  const [roleOrAddr, tokenArg] = args;
  const address = resolveAddress(roleOrAddr, book);
  if (!address) {
    process.exit(1);
  }

  console.log(`\nBalances for ${roleOrAddr} (${address}):\n`);

  // Native (ETH) balance
  const ethBalance = await provider.getBalance(address);
  const ethFormatted = ethers.formatEther(ethBalance);
  console.log(`  ETH          ${ethFormatted}`);

  // If a specific token was requested
  if (tokenArg) {
    const resolved = await resolveToken(tokenArg, contract);
    if (resolved.isNative) {
      // Already printed ETH above
      console.log();
      return;
    }

    const { balance, decimals, symbol } = await getTokenBalance(
      resolved.address,
      address,
      provider
    );
    console.log(`  ${symbol.padEnd(12)} ${ethers.formatUnits(balance, decimals)}`);
    console.log();
    return;
  }

  // Show all payment method token balances
  const balances = await getAllTokenBalances(address, contract, provider);

  for (const tb of balances) {
    if (tb.balance > 0n) {
      const formatted = ethers.formatUnits(tb.balance, tb.decimals);
      const usd = tb.usdValue > 0 ? `(~${formatUsd(tb.usdValue)})` : "";
      console.log(`  ${tb.symbol.padEnd(12)} ${formatted.padEnd(24)} ${usd}`);
    }
  }

  // Show zero-balance tokens too for completeness
  const zeroBalances = balances.filter((tb) => tb.balance === 0n);
  if (zeroBalances.length > 0) {
    for (const tb of zeroBalances) {
      console.log(`  ${tb.symbol.padEnd(12)} 0`);
    }
  }

  console.log();
}
