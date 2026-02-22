/**
 * Event monitor for BlockhostSubscriptions contract
 * Uses polling to fetch logs (compatible with public RPCs that don't support filters)
 */

import { ethers } from "ethers";
import {
  handleSubscriptionCreated,
  handleSubscriptionExtended,
  handleSubscriptionCancelled,
  handlePlanCreated,
  handlePlanUpdated,
} from "../handlers";
import {
  loadAdminConfig,
  initAdminCommands,
  shutdownAdminCommands,
  processAdminCommands,
} from "../admin";
import {
  runReconciliation,
  shouldRunReconciliation,
  getReconcileInterval,
} from "../reconcile";
import {
  shouldRunFundCycle,
  runFundCycle,
  shouldRunGasCheck,
  runGasCheck,
  getFundCycleInterval,
  getGasCheckInterval,
} from "../fund-manager";

// Contract ABI - only the events we care about
const CONTRACT_ABI = [
  "event PlanCreated(uint256 indexed planId, string name, uint256 pricePerDayUsdCents)",
  "event PlanUpdated(uint256 indexed planId, string name, uint256 pricePerDayUsdCents, bool active)",
  "event SubscriptionCreated(uint256 indexed subscriptionId, uint256 indexed planId, address indexed subscriber, uint256 expiresAt, uint256 paidAmount, address paymentToken, bytes userEncrypted)",
  "event SubscriptionExtended(uint256 indexed subscriptionId, uint256 indexed planId, address indexed extendedBy, uint256 newExpiresAt, uint256 paidAmount, address paymentToken)",
  "event SubscriptionCancelled(uint256 indexed subscriptionId, uint256 indexed planId, address indexed subscriber)",
  "event PrimaryStablecoinSet(address indexed stablecoinAddress, uint8 decimals)",
  "event PaymentMethodAdded(uint256 indexed paymentMethodId, address tokenAddress, address pairAddress, address stablecoinAddress)",
  "event PaymentMethodUpdated(uint256 indexed paymentMethodId, bool active)",
  "event FundsWithdrawn(address indexed token, address indexed to, uint256 amount)",
];

const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds

async function processLogs(
  contract: ethers.Contract,
  fromBlock: number,
  toBlock: number
): Promise<void> {
  const iface = contract.interface;

  // Query all events from the contract
  const filter = { address: await contract.getAddress(), fromBlock, toBlock };
  const provider = contract.runner as ethers.Provider;
  const logs = await provider.getLogs(filter);

  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) continue;

      const txHash = log.transactionHash;

      switch (parsed.name) {
        case "SubscriptionCreated":
          await handleSubscriptionCreated({
            subscriptionId: parsed.args[0],
            planId: parsed.args[1],
            subscriber: parsed.args[2],
            expiresAt: parsed.args[3],
            paidAmount: parsed.args[4],
            paymentToken: parsed.args[5],
            userEncrypted: parsed.args[6],
          }, txHash);
          break;

        case "SubscriptionExtended":
          await handleSubscriptionExtended({
            subscriptionId: parsed.args[0],
            planId: parsed.args[1],
            extendedBy: parsed.args[2],
            newExpiresAt: parsed.args[3],
            paidAmount: parsed.args[4],
            paymentToken: parsed.args[5],
          }, txHash);
          break;

        case "SubscriptionCancelled":
          await handleSubscriptionCancelled({
            subscriptionId: parsed.args[0],
            planId: parsed.args[1],
            subscriber: parsed.args[2],
          }, txHash);
          break;

        case "PlanCreated":
          await handlePlanCreated({
            planId: parsed.args[0],
            name: parsed.args[1],
            pricePerDayUsdCents: parsed.args[2],
          }, txHash);
          break;

        case "PlanUpdated":
          await handlePlanUpdated({
            planId: parsed.args[0],
            name: parsed.args[1],
            pricePerDayUsdCents: parsed.args[2],
            active: parsed.args[3],
          }, txHash);
          break;

        case "PrimaryStablecoinSet":
          console.log(`[INFO] PrimaryStablecoinSet: ${parsed.args[0]} (${parsed.args[1]} decimals) - tx: ${txHash}`);
          break;

        case "PaymentMethodAdded":
          console.log(`[INFO] PaymentMethodAdded: ID ${parsed.args[0]}, token ${parsed.args[1]} - tx: ${txHash}`);
          break;

        case "PaymentMethodUpdated":
          console.log(`[INFO] PaymentMethodUpdated: ID ${parsed.args[0]}, active: ${parsed.args[1]} - tx: ${txHash}`);
          break;

        case "FundsWithdrawn":
          console.log(`[INFO] FundsWithdrawn: ${ethers.formatUnits(parsed.args[2], 6)} of ${parsed.args[0]} to ${parsed.args[1]} - tx: ${txHash}`);
          break;
      }
    } catch (err) {
      console.error(`Error parsing log: ${err}`);
    }
  }
}

async function main() {
  // Load configuration from environment
  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.BLOCKHOST_CONTRACT;

  if (!rpcUrl) {
    console.error("Error: RPC_URL environment variable not set");
    process.exit(1);
  }

  if (!contractAddress) {
    console.error("Error: BLOCKHOST_CONTRACT environment variable not set");
    process.exit(1);
  }

  console.log("==============================================");
  console.log("  BlockhostSubscriptions Event Monitor");
  console.log("==============================================");
  console.log(`Contract: ${contractAddress}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Poll Interval: ${POLL_INTERVAL_MS}ms`);
  console.log("----------------------------------------------\n");

  // Load admin configuration (optional)
  const adminConfig = loadAdminConfig();
  if (adminConfig) {
    console.log(`Admin commands: ENABLED`);
    console.log(`Admin wallet: ${adminConfig.wallet_address}`);
    console.log(`Destination mode: ${adminConfig.destination_mode || 'any'}`);
    initAdminCommands();
  } else {
    console.log(`Admin commands: DISABLED (not configured)`);
  }
  console.log("----------------------------------------------\n");

  // Connect to the network
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  console.log(`Connected to network: ${network.name} (chainId: ${network.chainId})`);

  // Create contract instance
  const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, provider);

  // Start from current block
  let lastProcessedBlock = await provider.getBlockNumber();
  console.log(`Starting from block: ${lastProcessedBlock}`);
  console.log(`NFT reconciliation: every ${getReconcileInterval() / 1000}s`);
  console.log(`Fund cycle: every ${getFundCycleInterval() / 3600000}h`);
  console.log(`Gas check: every ${getGasCheckInterval() / 60000}min`);
  console.log("\nPolling for events...\n");

  // Polling loop
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const currentBlock = await provider.getBlockNumber();

        if (currentBlock > lastProcessedBlock) {
          const fromBlock = lastProcessedBlock + 1;
          const toBlock = currentBlock;

          // Process contract events
          await processLogs(contract, fromBlock, toBlock);

          // Process admin commands from transactions (if configured)
          if (adminConfig) {
            await processAdminCommands(provider, adminConfig, fromBlock, toBlock);
          }

          lastProcessedBlock = currentBlock;
        }

        // Run NFT reconciliation periodically (non-blocking health check)
        if (shouldRunReconciliation()) {
          runReconciliation(provider).catch((err) => {
            console.error(`[RECONCILE] Error: ${err}`);
          });
        }

        // Run fund withdrawal & distribution cycle periodically
        if (shouldRunFundCycle()) {
          runFundCycle(provider).catch((err) => {
            console.error(`[FUND] Error: ${err}`);
          });
        }

        // Check gas balance and swap if needed
        if (shouldRunGasCheck()) {
          runGasCheck(provider).catch((err) => {
            console.error(`[GAS] Error: ${err}`);
          });
        }
      } catch (err) {
        console.error(`Polling error: ${err}`);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down monitor...");
    running = false;
    if (adminConfig) {
      await shutdownAdminCommands();
    }
    setTimeout(() => process.exit(0), 1000);
  });

  console.log("Monitor is running. Press Ctrl+C to stop.\n");
  await poll();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
