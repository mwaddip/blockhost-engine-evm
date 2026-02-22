/**
 * Admin command dispatcher
 *
 * Handles decryption, validation, and dispatch of on-chain admin commands.
 */

import { execFileSync } from "child_process";
import { ethers } from "ethers";
import type { AdminCommand, AdminConfig, CommandResult, CommandDatabase } from "./types";
import { loadCommandDatabase, checkDestination, getServerPrivateKeyPath, loadServerPublicKey } from "./config";
import { isNonceUsed, markNonceUsed, pruneOldNonces, loadNonces } from "./nonces";
import { executeKnock, closeAllKnocks } from "./handlers/knock";

// Action handlers
const ACTION_HANDLERS: Record<string, (params: Record<string, unknown>, config: Record<string, unknown>, txHash: string) => Promise<CommandResult>> = {
  knock: async (params, config, txHash) => executeKnock(params as any, config as any, txHash),
};

/**
 * Attempt to decrypt transaction data as an admin command
 * Returns null if decryption fails (not an admin command)
 */
export function tryDecryptCommand(txData: string): string | null {
  const privateKeyPath = getServerPrivateKeyPath();

  // Remove 0x prefix if present
  const ciphertext = txData.startsWith('0x') ? txData.slice(2) : txData;

  if (!ciphertext || ciphertext.length < 10) {
    return null;
  }

  try {
    // Use nft_tool for ECIES decryption
    const result = execFileSync(
      "nft_tool",
      ["decrypt", "--private-key-file", privateKeyPath, "--ciphertext", ciphertext],
      { encoding: "utf8", timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    // Strip "Decrypted: " prefix if present
    return result.trim().replace(/^Decrypted:\s*/, '');
  } catch {
    // Decryption failed - this is not an admin command
    return null;
  }
}

/**
 * Parse and validate a decrypted command payload
 */
export function parseCommand(decryptedPayload: string): AdminCommand | null {
  try {
    const cmd = JSON.parse(decryptedPayload) as AdminCommand;

    // Validate required fields
    if (!cmd.command || typeof cmd.command !== 'string') {
      console.warn(`[ADMIN] Command missing 'command' field`);
      return null;
    }

    if (!cmd.nonce || typeof cmd.nonce !== 'string') {
      console.warn(`[ADMIN] Command missing 'nonce' field`);
      return null;
    }

    if (!cmd.timestamp || typeof cmd.timestamp !== 'number') {
      console.warn(`[ADMIN] Command missing 'timestamp' field`);
      return null;
    }

    // Ensure params is an object
    if (!cmd.params || typeof cmd.params !== 'object') {
      cmd.params = {};
    }

    return cmd;
  } catch (err) {
    console.warn(`[ADMIN] Failed to parse command JSON: ${err}`);
    return null;
  }
}

/**
 * Validate command timestamp and nonce
 */
export function validateCommand(cmd: AdminCommand, maxAgeSeconds: number): { valid: boolean; reason?: string } {
  const now = Math.floor(Date.now() / 1000);

  // Check timestamp is not too old
  const age = now - cmd.timestamp;
  if (age > maxAgeSeconds) {
    return { valid: false, reason: `Command too old (${age}s > ${maxAgeSeconds}s)` };
  }

  // Check timestamp is not in the future (with 60s tolerance)
  if (cmd.timestamp > now + 60) {
    return { valid: false, reason: `Command timestamp in future` };
  }

  // Check nonce not already used (anti-replay)
  if (isNonceUsed(cmd.nonce)) {
    return { valid: false, reason: `Nonce already used (replay attack prevented)` };
  }

  return { valid: true };
}

/**
 * Dispatch a validated command to its handler
 */
export async function dispatchCommand(
  cmd: AdminCommand,
  txHash: string,
  commandDb: CommandDatabase
): Promise<CommandResult> {
  // Look up command name in database
  const cmdDef = commandDb.commands[cmd.command];
  if (!cmdDef) {
    return {
      success: false,
      message: `Unknown command: ${cmd.command}`,
    };
  }

  // Get action handler
  const handler = ACTION_HANDLERS[cmdDef.action];
  if (!handler) {
    return {
      success: false,
      message: `Unknown action type: ${cmdDef.action}`,
    };
  }

  console.log(`[ADMIN] Dispatching action '${cmdDef.action}' for command '${cmd.command}'`);

  // Merge command params with definition params (command params override)
  const mergedParams = { ...cmdDef.params, ...cmd.params };

  // Execute the handler
  return handler(mergedParams, cmdDef.params, txHash);
}

/**
 * Process admin commands from transactions in a block range
 *
 * This is called from the monitor's poll loop after processing contract events.
 */
export async function processAdminCommands(
  provider: ethers.Provider,
  adminConfig: AdminConfig,
  fromBlock: number,
  toBlock: number
): Promise<void> {
  // Load server public key for destination check
  const serverPublicKey = loadServerPublicKey();
  if (!serverPublicKey && adminConfig.destination_mode === 'server') {
    console.warn(`[ADMIN] Server public key not configured, skipping admin commands`);
    return;
  }

  // Load command database
  const commandDb = loadCommandDatabase();
  if (!commandDb) {
    return; // No commands configured
  }

  // Periodically prune old nonces
  pruneOldNonces(adminConfig.max_command_age || 300);

  // Process each block
  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
    try {
      // Get block with full transaction data
      const block = await provider.getBlock(blockNum, true);
      if (!block || !block.prefetchedTransactions) {
        continue;
      }

      // Check each transaction
      for (const tx of block.prefetchedTransactions) {
        await processTransaction(tx, adminConfig, serverPublicKey || '', commandDb);
      }
    } catch (err) {
      console.error(`[ADMIN] Error processing block ${blockNum}: ${err}`);
    }
  }
}

/**
 * Process a single transaction as a potential admin command
 */
async function processTransaction(
  tx: ethers.TransactionResponse,
  adminConfig: AdminConfig,
  serverPublicKey: string,
  commandDb: CommandDatabase
): Promise<void> {
  // Check sender is admin wallet
  if (tx.from.toLowerCase() !== adminConfig.wallet_address) {
    return; // Not from admin
  }

  // Check transaction has data
  if (!tx.data || tx.data === '0x' || tx.data.length < 10) {
    return; // No data payload
  }

  // Check destination matches configured mode
  if (!checkDestination(tx.to, adminConfig, serverPublicKey)) {
    return; // Destination doesn't match
  }

  // Attempt ECIES decryption
  const decrypted = tryDecryptCommand(tx.data);
  if (!decrypted) {
    return; // Decryption failed - not an admin command
  }

  console.log(`[ADMIN] Decrypted potential command from tx: ${tx.hash}`);

  // Parse command JSON
  const cmd = parseCommand(decrypted);
  if (!cmd) {
    console.warn(`[ADMIN] Invalid command format in tx: ${tx.hash}`);
    return;
  }

  // Validate timestamp and nonce
  const validation = validateCommand(cmd, adminConfig.max_command_age || 300);
  if (!validation.valid) {
    console.warn(`[ADMIN] Command validation failed: ${validation.reason} (tx: ${tx.hash})`);
    return;
  }

  // Mark nonce as used BEFORE executing (prevents race conditions)
  markNonceUsed(cmd.nonce);

  console.log(`[ADMIN] Executing command '${cmd.command}' from tx: ${tx.hash}`);

  // Dispatch command
  const result = await dispatchCommand(cmd, tx.hash, commandDb);

  if (result.success) {
    console.log(`[ADMIN] Command succeeded: ${result.message}`);
  } else {
    console.error(`[ADMIN] Command failed: ${result.message}`);
  }
}

/**
 * Initialize admin command system
 */
export function initAdminCommands(): void {
  loadNonces();
  console.log(`[ADMIN] Admin command system initialized`);
}

/**
 * Cleanup on shutdown
 */
export async function shutdownAdminCommands(): Promise<void> {
  await closeAllKnocks();
  console.log(`[ADMIN] Admin command system shutdown`);
}

// Re-export types and utilities
export * from "./types";
export * from "./config";
export * from "./nonces";
