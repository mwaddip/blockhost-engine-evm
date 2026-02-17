#!/usr/bin/env node
/**
 * bw (blockwallet) CLI — scriptable wallet operations for blockhost
 *
 * Usage:
 *   bw send <amount> <token> <from> <to>
 *   bw balance <role> [token]
 *   bw split <amount> <token> <ratios> <from> <to1> <to2> ...
 *   bw withdraw [token] <to>
 *   bw swap <amount> <from-token> eth <wallet>
 *   bw who <identifier>
 *
 * Debug:
 *   bw --debug --cleanup <address>   Sweep all ETH from signing wallets to <address>
 *
 * Environment:
 *   RPC_URL          — RPC endpoint URL
 *   BLOCKHOST_CONTRACT   — Subscription contract address
 */

import { loadAddressbook } from "../fund-manager/addressbook";
import { createProviderAndContract } from "./cli-utils";
import { sendCommand } from "./commands/send";
import { balanceCommand } from "./commands/balance";
import { splitCommand } from "./commands/split";
import { withdrawCommand } from "./commands/withdraw";
import { swapCommand } from "./commands/swap";
import { cleanupCommand } from "./commands/cleanup";
import { whoCommand } from "./commands/who";
import { configCommand } from "./commands/config";
import { planCommand } from "./commands/plan";
import { setCommand } from "./commands/set";

function printUsage(): void {
  console.log("bw (blockwallet) — scriptable wallet operations for blockhost");
  console.log("");
  console.log("Usage:");
  console.log("  bw send <amount> <token> <from> <to>      Send tokens");
  console.log("  bw balance <role> [token]                  Show balances");
  console.log("  bw split <amount> <token> <ratios> <from> <to1> <to2> ...");
  console.log("                                             Split tokens");
  console.log("  bw withdraw [token] <to>                   Withdraw from contract");
  console.log("  bw swap <amount> <from-token> eth <wallet> Swap token for ETH");
  console.log("  bw who <identifier>                        Query NFT owner");
  console.log("  bw who <message> <signature>               Recover signer address");
  console.log("  bw config stable [address]                 Get/set primary stablecoin");
  console.log("  bw plan create <name> <price>              Create subscription plan");
  console.log("  bw set encrypt <nft_id> <data>             Update NFT encrypted data");
  console.log("");
  console.log("Debug:");
  console.log("  bw --debug --cleanup <address>             Sweep ETH to address");
  console.log("");
  console.log("Token shortcuts: eth, stable, or 0x address");
  console.log("Roles: admin, server, hot, dev, broker (from addressbook.json)");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));

  if (flags.has("--help") || flags.has("-h") || argv.length === 0) {
    printUsage();
    process.exit(0);
  }

  // 'who' reads its own config (web3-defaults.yaml), no addressbook or env vars needed
  if (positional[0] === "who") {
    await whoCommand(positional.slice(1));
    return;
  }

  const book = loadAddressbook();
  if (Object.keys(book).length === 0) {
    console.error("Error: addressbook is empty or missing. Run the installer wizard first.");
    process.exit(1);
  }

  // --debug --cleanup <address>: sweep testnet ETH back to a single address
  if (flags.has("--cleanup")) {
    if (!flags.has("--debug")) {
      console.error("Error: --cleanup requires --debug flag");
      process.exit(1);
    }
    const { provider } = createProviderAndContract();
    await cleanupCommand(positional, book, provider);
    return;
  }

  const [command, ...args] = positional;

  if (!command) {
    printUsage();
    process.exit(0);
  }

  const { provider, contract } = createProviderAndContract();

  switch (command) {
    case "send":
      await sendCommand(args, book, provider, contract);
      break;
    case "balance":
      await balanceCommand(args, book, provider, contract);
      break;
    case "split":
      await splitCommand(args, book, provider, contract);
      break;
    case "withdraw":
      await withdrawCommand(args, book, provider, contract);
      break;
    case "swap":
      await swapCommand(args, book, provider, contract);
      break;
    case "config":
      await configCommand(args, book, provider, contract);
      break;
    case "plan":
      await planCommand(args, book, provider, contract);
      break;
    case "set":
      await setCommand(args, book, provider);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
