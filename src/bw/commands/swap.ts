/**
 * bw swap <amount> <from-token> eth <wallet>
 *
 * Swap ERC20 tokens for native ETH via Uniswap V2 Router.
 *
 *   bw swap 20 stable eth server   — swap $20 USDC for ETH using server wallet
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveWallet } from "../../fund-manager/addressbook";
import { ERC20_ABI } from "../../fund-manager/token-utils";
import { getChainConfig, UNISWAP_V2_ROUTER_ABI } from "../../fund-manager/chain-pools";
import { resolveToken } from "../cli-utils";

const SLIPPAGE_PERCENT = 2n; // 2% slippage tolerance
const DEADLINE_SECONDS = 300; // 5-minute transaction deadline

/**
 * Core swap operation — swap ERC20 token for native ETH via Uniswap V2.
 * Returns the transaction hash.
 */
export async function executeSwap(
  amountStr: string,
  fromTokenArg: string,
  walletRole: string,
  book: Addressbook,
  provider: ethers.Provider,
  contract: ethers.Contract
): Promise<string> {
  const signer = resolveWallet(walletRole, book, provider);
  if (!signer) throw new Error(`Cannot sign as '${walletRole}': no keyfile`);

  const network = await provider.getNetwork();
  const chainConfig = getChainConfig(network.chainId);
  if (!chainConfig) throw new Error(`No chain config for chainId ${network.chainId}`);

  const resolved = await resolveToken(fromTokenArg, contract);
  if (resolved.isNative) throw new Error("Cannot swap from native ETH");

  const token = new ethers.Contract(resolved.address, ERC20_ABI, signer);
  const decimals = Number(await token.decimals());
  const amountIn = ethers.parseUnits(amountStr, decimals);
  const walletAddress = await signer.getAddress();

  // Approve router if needed
  const router = new ethers.Contract(chainConfig.router, UNISWAP_V2_ROUTER_ABI, signer);
  const allowance: bigint = await token.allowance(walletAddress, chainConfig.router);
  if (allowance < amountIn) {
    const approveTx = await token.approve(chainConfig.router, ethers.MaxUint256);
    await approveTx.wait();
  }

  // Get expected output with slippage tolerance
  const path = [resolved.address, chainConfig.weth];
  const amounts: bigint[] = await router.getAmountsOut(amountIn, path);
  const minOut = (amounts[1] * (100n - SLIPPAGE_PERCENT)) / 100n;
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  const tx = await router.swapExactTokensForETH(
    amountIn,
    minOut,
    path,
    walletAddress,
    deadline
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("Swap transaction dropped from mempool");
  return receipt.hash;
}

/**
 * CLI handler
 */
export async function swapCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider,
  contract: ethers.Contract
): Promise<void> {
  if (args.length < 4) {
    console.error("Usage: bw swap <amount> <from-token> eth <wallet>");
    console.error("  Example: bw swap 20 stable eth server");
    process.exit(1);
  }

  const [amountStr, fromTokenArg, toTokenArg, walletRole] = args;

  if (toTokenArg.toLowerCase() !== "eth") {
    console.error("Only swaps to ETH are currently supported.");
    process.exit(1);
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error(`Invalid amount: ${amountStr}`);
    process.exit(1);
  }

  console.log(`Swapping ${amountStr} ${fromTokenArg} for ETH using ${walletRole} wallet...`);
  const txHash = await executeSwap(amountStr, fromTokenArg, walletRole, book, provider, contract);
  console.log(`Swapped. tx: ${txHash}`);
}
