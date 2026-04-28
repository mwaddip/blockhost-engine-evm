/**
 * Type definitions for fund-manager
 */

export interface RevenueShareRecipient {
  role: string;
  percent: number;
}

export interface RevenueShareConfig {
  enabled: boolean;
  total_percent: number;
  recipients: RevenueShareRecipient[];
}

export interface FundManagerConfig {
  // Block-based intervals (preferred per facts/ENGINE_INTERFACE.md §4).
  // null means the operator did not configure a block-based interval; engine
  // falls back to the time-based equivalent below.
  fund_cycle_interval_blocks: number | null;
  gas_check_interval_blocks: number | null;
  // Time-based intervals (legacy). Always present (defaulted) so the engine
  // has something to fall back to if no block-based key is configured.
  fund_cycle_interval_hours: number;
  gas_check_interval_minutes: number;
  min_withdrawal_usd: number;
  gas_low_threshold_usd: number;
  gas_swap_amount_usd: number;
  server_stablecoin_buffer_usd: number;
  hot_wallet_gas_eth: number;
}

export interface ChainConfig {
  router: string;
  weth: string;
  usdc: string;
  usdc_weth_pair: string;
}

export interface FundManagerState {
  // Block-based last-run heights (preferred per facts/ENGINE_INTERFACE.md §6).
  // 0 means the cycle has never run.
  last_fund_cycle_block: number;
  last_gas_check_block: number;
  // Time-based last-run timestamps (legacy, ms since epoch).
  // Written for backwards-compat; reads prefer block-based.
  last_fund_cycle: number;
  last_gas_check: number;
  hot_wallet_generated: boolean;
}

export interface TokenBalance {
  tokenAddress: string;
  symbol: string;
  balance: bigint;
  decimals: number;
  usdValue: number;
  paymentMethodId: number;
}
