/**
 * Fund Manager Module
 *
 * Periodic tasks integrated into the monitor polling loop:
 *  - Fund cycle (every 24h): withdraw from contract → distribute to stakeholders
 *  - Gas check (every 30min): ensure server + hot wallets have enough ETH
 *
 * Follows the same pattern as src/reconcile/index.ts
 */

import { ethers } from "ethers";
import { loadFundManagerConfig, loadRevenueShareConfig } from "./config";
import { loadAddressbook, ensureHotWallet } from "./addressbook";
import { loadState, updateState } from "./state";
import { SUBSCRIPTION_ABI } from "./token-utils";
import { withdrawFromContract } from "./withdrawal";
import {
  topUpHotWalletGas,
  topUpServerStablecoinBuffer,
  distributeRevenueShares,
  sendRemainderToAdmin,
} from "./distribution";
import { checkAndSwapGas } from "./gas-manager";

let fundCycleInProgress = false;
let gasCheckInProgress = false;

const config = loadFundManagerConfig();
const fundCycleIntervalMs = config.fund_cycle_interval_hours * 60 * 60 * 1000;
const gasCheckIntervalMs = config.gas_check_interval_minutes * 60 * 1000;

/**
 * Check if the fund cycle should run (based on interval)
 */
export function shouldRunFundCycle(): boolean {
  const state = loadState();
  const now = Date.now();
  return now - state.last_fund_cycle >= fundCycleIntervalMs;
}

/**
 * Check if the gas check should run (based on interval)
 */
export function shouldRunGasCheck(): boolean {
  const state = loadState();
  const now = Date.now();
  return now - state.last_gas_check >= gasCheckIntervalMs;
}

/**
 * Get fund cycle interval in milliseconds
 */
export function getFundCycleInterval(): number {
  return fundCycleIntervalMs;
}

/**
 * Get gas check interval in milliseconds
 */
export function getGasCheckInterval(): number {
  return gasCheckIntervalMs;
}

/**
 * Create a contract instance for fund-manager operations
 */
function getContract(contractAddress: string, provider: ethers.Provider): ethers.Contract {
  return new ethers.Contract(contractAddress, SUBSCRIPTION_ABI, provider);
}

/**
 * Run the full fund withdrawal and distribution cycle.
 *
 * 1. Withdraw from contract to hot wallet
 * 2. Top up hot wallet gas
 * 3. Top up server stablecoin buffer
 * 4. Revenue shares (if enabled)
 * 5. Remainder to admin
 */
export async function runFundCycle(provider: ethers.Provider): Promise<void> {
  if (fundCycleInProgress) return;
  fundCycleInProgress = true;

  try {
    const contractAddress = process.env.BLOCKHOST_CONTRACT;
    if (!contractAddress) {
      console.error("[FUND] BLOCKHOST_CONTRACT not set, skipping fund cycle");
      return;
    }

    console.log("[FUND] Starting fund cycle...");

    // Load addressbook and ensure hot wallet exists
    let book = loadAddressbook();
    if (Object.keys(book).length === 0) {
      console.error("[FUND] Addressbook empty, skipping fund cycle");
      return;
    }
    book = await ensureHotWallet(book);

    const contract = getContract(contractAddress, provider);

    // Step 1: Withdraw from contract to hot wallet
    await withdrawFromContract(book, config, provider, contract);

    // Step 2: Top up hot wallet gas (server → hot)
    await topUpHotWalletGas(book, config, provider, contract);

    // Step 3: Top up server stablecoin buffer (hot → server)
    await topUpServerStablecoinBuffer(book, config, provider, contract);

    // Step 4: Revenue shares (hot → dev/broker)
    const revenueConfig = loadRevenueShareConfig();
    await distributeRevenueShares(book, revenueConfig, provider, contract);

    // Step 5: Remainder to admin (hot → admin)
    await sendRemainderToAdmin(book, provider, contract);

    updateState({ last_fund_cycle: Date.now() });
    console.log("[FUND] Fund cycle complete");
  } catch (err) {
    console.error(`[FUND] Error during fund cycle: ${err}`);
  } finally {
    fundCycleInProgress = false;
  }
}

/**
 * Run the gas balance check and swap if needed.
 */
export async function runGasCheck(provider: ethers.Provider): Promise<void> {
  if (gasCheckInProgress) return;
  gasCheckInProgress = true;

  try {
    const contractAddress = process.env.BLOCKHOST_CONTRACT;
    if (!contractAddress) return;

    const book = loadAddressbook();
    if (Object.keys(book).length === 0) return;

    const contract = getContract(contractAddress, provider);

    // Top up hot wallet ETH from server if low
    if (book.hot) {
      await topUpHotWalletGas(book, config, provider, contract);
    }

    // Swap USDC→ETH for server wallet if low
    await checkAndSwapGas(book, config, provider, contract);
  } catch (err) {
    console.error(`[GAS] Error during gas check: ${err}`);
  } finally {
    updateState({ last_gas_check: Date.now() });
    gasCheckInProgress = false;
  }
}
