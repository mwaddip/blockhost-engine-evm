/**
 * Known Uniswap V2 router/WETH/pair addresses by chain ID
 * Supports override via web3-defaults.yaml
 */

import type { ChainConfig } from "./types";
import { loadWeb3Defaults } from "../config/web3-config";

const KNOWN_CHAINS: Record<string, ChainConfig> = {
  // Ethereum mainnet
  "1": {
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdc_weth_pair: "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc",
  },
  // Base
  "8453": {
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdc_weth_pair: "0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C",
  },
  // Sepolia testnet
  "11155111": {
    router: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3",
    weth: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    usdc_weth_pair: "0x0000000000000000000000000000000000000000",
  },
};

/**
 * Get chain pool configuration for the given chain ID.
 * Checks web3-defaults.yaml for overrides first.
 */
export function getChainConfig(chainId: bigint): ChainConfig | null {
  const id = chainId.toString();

  // Check for overrides in web3-defaults.yaml
  try {
    const config = loadWeb3Defaults();
    if (config) {
      const uniswap = config.uniswap_v2 as Record<string, string> | undefined;
      if (uniswap && uniswap.router && uniswap.weth) {
        const base = KNOWN_CHAINS[id] || {
          router: "",
          weth: "",
          usdc: "",
          usdc_weth_pair: "",
        };
        return {
          router: uniswap.router || base.router,
          weth: uniswap.weth || base.weth,
          usdc: uniswap.usdc || base.usdc,
          usdc_weth_pair: uniswap.usdc_weth_pair || base.usdc_weth_pair,
        };
      }
    }
  } catch (err) {
    console.error(`[GAS] Error loading chain config overrides: ${err}`);
  }

  return KNOWN_CHAINS[id] || null;
}

// Uniswap V2 Router ABI (only what we need for swaps)
export const UNISWAP_V2_ROUTER_ABI = [
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
];

// Uniswap V2 Pair ABI (for price queries)
export const UNISWAP_V2_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];
