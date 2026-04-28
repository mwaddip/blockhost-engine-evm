/**
 * bw withdraw [token] <to>
 *
 * Withdraw token(s) from the subscription contract.
 * Only the server wallet (contract owner) can call withdrawFunds.
 *
 *   bw withdraw hot              — withdraw ALL payment method tokens to hot
 *   bw withdraw stable hot       — withdraw only the primary stablecoin to hot
 *   bw withdraw 0xToken... hot   — withdraw a specific token to hot
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../addressbook";
import { resolveAddress, resolveWallet } from "../../addressbook";
import {
  SUBSCRIPTION_ABI,
  ERC20_ABI,
  getTokenBalance,
  listActivePaymentTokens,
} from "../../fund-manager/token-utils";
import { resolveToken } from "../cli-utils";

/**
 * Core withdraw operation — withdraw full balance of one token from contract.
 * Returns the tx hash, or null if the contract has zero balance of that token.
 *
 * Optionally accepts a pre-fetched balance (callers like the fund cycle have
 * already queried it) to skip a redundant balanceOf RPC.
 */
export async function executeWithdraw(
  tokenAddress: string,
  toRole: string,
  book: Addressbook,
  provider: ethers.Provider,
  contractAddress: string,
  prefetchedBalance?: bigint,
): Promise<string | null> {
  const serverWallet = resolveWallet("server", book, provider);
  if (!serverWallet) throw new Error("Cannot withdraw: server wallet not available");

  const toAddress = resolveAddress(toRole, book);
  if (!toAddress) throw new Error(`Cannot resolve recipient '${toRole}'`);

  let balance: bigint;
  if (prefetchedBalance !== undefined) {
    balance = prefetchedBalance;
  } else {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    balance = (await token.balanceOf(contractAddress)) as bigint;
  }
  if (balance === 0n) return null;

  const contract = new ethers.Contract(contractAddress, SUBSCRIPTION_ABI, serverWallet);
  const tx = await contract.withdrawFunds(tokenAddress, toAddress);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Withdrawal transaction dropped from mempool");
  return receipt.hash;
}

/**
 * Withdraw all payment method tokens from the contract.
 * Returns array of { tokenAddress, symbol, txHash } for each successful withdrawal.
 */
export async function executeWithdrawAll(
  toRole: string,
  book: Addressbook,
  provider: ethers.Provider,
  contractAddress: string,
): Promise<{ tokenAddress: string; symbol: string; amount: string; txHash: string }[]> {
  const contract = new ethers.Contract(contractAddress, SUBSCRIPTION_ABI, provider);
  const tokens = await listActivePaymentTokens(contract);

  const results: { tokenAddress: string; symbol: string; amount: string; txHash: string }[] = [];

  for (const { address: tokenAddress } of tokens) {
    const { balance, decimals, symbol } = await getTokenBalance(
      tokenAddress, contractAddress, provider,
    );
    if (balance === 0n) continue;

    const txHash = await executeWithdraw(
      tokenAddress, toRole, book, provider, contractAddress, balance,
    );
    if (txHash) {
      results.push({
        tokenAddress,
        symbol,
        amount: ethers.formatUnits(balance, decimals),
        txHash,
      });
    }
  }

  return results;
}

/**
 * CLI handler
 */
export async function withdrawCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider,
  contract: ethers.Contract
): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw withdraw <to>                  Withdraw all tokens");
    console.error("       bw withdraw <token> <to>          Withdraw specific token");
    console.error("  Example: bw withdraw hot");
    console.error("  Example: bw withdraw stable hot");
    process.exit(1);
  }

  const contractAddress = await contract.getAddress();

  if (args.length === 1) {
    // Withdraw all tokens
    const toRole = args[0];
    console.log(`Withdrawing all tokens from contract to ${toRole}...`);
    const results = await executeWithdrawAll(toRole, book, provider, contractAddress);
    if (results.length === 0) {
      console.log("No token balances to withdraw.");
    } else {
      for (const r of results) {
        console.log(`  ${r.amount} ${r.symbol} (tx: ${r.txHash})`);
      }
    }
  } else {
    // Withdraw specific token
    const [tokenArg, toRole] = args;
    const resolved = await resolveToken(tokenArg, contract);
    if (resolved.isNative) {
      console.error("Cannot withdraw native ETH from contract. Use 'stable' or a token address.");
      process.exit(1);
    }

    const token = new ethers.Contract(resolved.address, ERC20_ABI, provider);
    const [balance, decimals, symbol] = await Promise.all([
      token.balanceOf(contractAddress) as Promise<bigint>,
      token.decimals() as Promise<number>,
      token.symbol() as Promise<string>,
    ]);

    if (balance === 0n) {
      console.log(`No ${symbol} balance to withdraw.`);
      return;
    }

    console.log(`Withdrawing ${ethers.formatUnits(balance, Number(decimals))} ${symbol} to ${toRole}...`);
    const txHash = await executeWithdraw(resolved.address, toRole, book, provider, contractAddress);
    console.log(`Withdrawn. tx: ${txHash}`);
  }
}
