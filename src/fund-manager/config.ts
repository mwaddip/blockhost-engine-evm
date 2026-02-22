/**
 * Fund manager configuration loading with defaults
 */

import * as fs from "fs";
import type { FundManagerConfig, RevenueShareConfig } from "./types";
import { loadBlockhostConfig } from "../config/blockhost-config";

const REVENUE_SHARE_PATH = "/etc/blockhost/revenue-share.json";

const DEFAULTS: FundManagerConfig = {
  fund_cycle_interval_hours: 24,
  gas_check_interval_minutes: 30,
  min_withdrawal_usd: 50,
  gas_low_threshold_usd: 5,
  gas_swap_amount_usd: 20,
  server_stablecoin_buffer_usd: 50,
  hot_wallet_gas_eth: 0.01,
};

/**
 * Load fund manager configuration from blockhost.yaml
 */
export function loadFundManagerConfig(): FundManagerConfig {
  try {
    const config = loadBlockhostConfig();
    if (!config) {
      return { ...DEFAULTS };
    }

    const fm = config.fund_manager as Record<string, unknown> | undefined;
    if (!fm) {
      return { ...DEFAULTS };
    }

    return {
      fund_cycle_interval_hours:
        (fm.fund_cycle_interval_hours as number) ?? DEFAULTS.fund_cycle_interval_hours,
      gas_check_interval_minutes:
        (fm.gas_check_interval_minutes as number) ?? DEFAULTS.gas_check_interval_minutes,
      min_withdrawal_usd:
        (fm.min_withdrawal_usd as number) ?? DEFAULTS.min_withdrawal_usd,
      gas_low_threshold_usd:
        (fm.gas_low_threshold_usd as number) ?? DEFAULTS.gas_low_threshold_usd,
      gas_swap_amount_usd:
        (fm.gas_swap_amount_usd as number) ?? DEFAULTS.gas_swap_amount_usd,
      server_stablecoin_buffer_usd:
        (fm.server_stablecoin_buffer_usd as number) ?? DEFAULTS.server_stablecoin_buffer_usd,
      hot_wallet_gas_eth:
        (fm.hot_wallet_gas_eth as number) ?? DEFAULTS.hot_wallet_gas_eth,
    };
  } catch (err) {
    console.error(`[FUND] Error loading config: ${err}`);
    return { ...DEFAULTS };
  }
}

/**
 * Load revenue share configuration from /etc/blockhost/revenue-share.json
 */
export function loadRevenueShareConfig(): RevenueShareConfig {
  const disabled: RevenueShareConfig = {
    enabled: false,
    total_percent: 0,
    recipients: [],
  };

  try {
    if (!fs.existsSync(REVENUE_SHARE_PATH)) {
      return disabled;
    }

    const data = fs.readFileSync(REVENUE_SHARE_PATH, "utf8");
    const config = JSON.parse(data) as RevenueShareConfig;

    if (!config.enabled) {
      return disabled;
    }

    if (
      !config.recipients ||
      !Array.isArray(config.recipients) ||
      config.recipients.length === 0
    ) {
      return disabled;
    }

    if (!config.total_percent || config.total_percent <= 0) {
      return disabled;
    }

    return config;
  } catch (err) {
    console.error(`[FUND] Error loading revenue share config: ${err}`);
    return disabled;
  }
}
