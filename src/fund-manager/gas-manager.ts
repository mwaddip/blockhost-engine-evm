/**
 * Gas token monitoring and USDC→ETH swap
 *
 * Periodically checks the server wallet's ETH balance.
 * If below threshold, swaps stablecoin for ETH via bw swap.
 */

import { ethers } from "ethers";
import type { FundManagerConfig } from "./types";
import type { Addressbook } from "../addressbook";
import { getChainConfig, UNISWAP_V2_PAIR_ABI } from "./chain-pools";
import { getTokenBalance } from "./token-utils";
import { executeSwap } from "../bw/commands/swap";

/**
 * Get ETH price in USD from a Uniswap V2 WETH/USDC pair
 */
async function getEthPriceUsd(
  pairAddress: string,
  wethAddress: string,
  usdcDecimals: number,
  provider: ethers.Provider
): Promise<number> {
  const pair = new ethers.Contract(pairAddress, UNISWAP_V2_PAIR_ABI, provider);

  const [reserve0, reserve1] = await pair.getReserves();
  const token0: string = await pair.token0();

  let wethReserve: bigint;
  let usdcReserve: bigint;

  if (token0.toLowerCase() === wethAddress.toLowerCase()) {
    wethReserve = reserve0;
    usdcReserve = reserve1;
  } else {
    wethReserve = reserve1;
    usdcReserve = reserve0;
  }

  const usdcFloat = parseFloat(ethers.formatUnits(usdcReserve, usdcDecimals));
  const wethFloat = parseFloat(ethers.formatEther(wethReserve));
  if (!(wethFloat > 0) || !(usdcFloat > 0)) {
    throw new Error(
      `[GAS] Drained or empty USDC/WETH pair at ${pairAddress} ` +
      `(usdc=${usdcFloat}, weth=${wethFloat}); cannot price ETH`,
    );
  }
  return usdcFloat / wethFloat;
}

/**
 * Check server wallet gas and swap USDC→ETH if needed.
 */
export async function checkAndSwapGas(
  book: Addressbook,
  config: FundManagerConfig,
  provider: ethers.Provider,
  contract: ethers.Contract
): Promise<void> {
  const serverAddress = book.server?.address;
  if (!serverAddress || !book.server?.keyfile) {
    console.error("[GAS] Cannot check gas: server wallet not available");
    return;
  }

  // Get network chain ID
  const network = await provider.getNetwork();
  const chainConfig = getChainConfig(network.chainId);
  if (!chainConfig) {
    console.error(`[GAS] No chain configuration for chainId ${network.chainId}`);
    return;
  }

  if (
    chainConfig.usdc_weth_pair === ethers.ZeroAddress ||
    chainConfig.usdc_weth_pair === "0x0000000000000000000000000000000000000000"
  ) {
    return; // No pair configured (e.g., testnet)
  }

  // Check server ETH balance
  const ethBalance = await provider.getBalance(serverAddress);

  // Get ETH price to determine USD value
  const { decimals: usdcDecimals, balance: usdcBalance } = await getTokenBalance(
    chainConfig.usdc,
    serverAddress,
    provider
  );
  const ethPriceUsd = await getEthPriceUsd(
    chainConfig.usdc_weth_pair,
    chainConfig.weth,
    usdcDecimals,
    provider
  );

  const ethBalanceFloat = parseFloat(ethers.formatEther(ethBalance));
  const ethBalanceUsd = ethBalanceFloat * ethPriceUsd;

  if (ethBalanceUsd >= config.gas_low_threshold_usd) {
    return; // Gas is sufficient
  }

  console.log(
    `[GAS] Server ETH low: ${ethBalanceFloat.toFixed(4)} ETH (~$${ethBalanceUsd.toFixed(2)}), threshold: $${config.gas_low_threshold_usd}`
  );

  // Check server has enough USDC
  const swapAmountUsdc = ethers.parseUnits(config.gas_swap_amount_usd.toString(), usdcDecimals);
  if (usdcBalance < swapAmountUsdc) {
    console.warn(
      `[GAS] Server USDC insufficient for gas swap: ${ethers.formatUnits(usdcBalance, usdcDecimals)} < ${config.gas_swap_amount_usd}`
    );
    return;
  }

  console.log(`[GAS] Swapping $${config.gas_swap_amount_usd} USDC for ETH...`);
  const txHash = await executeSwap(
    config.gas_swap_amount_usd.toString(),
    "stable",
    "server",
    book,
    provider,
    contract
  );

  const newBalance = await provider.getBalance(serverAddress);
  console.log(
    `[GAS] Swapped $${config.gas_swap_amount_usd} USDC for ETH. New balance: ${ethers.formatEther(newBalance)} ETH (tx: ${txHash})`
  );
}
