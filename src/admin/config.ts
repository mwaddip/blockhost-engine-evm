/**
 * Admin configuration loading and validation
 */

import * as fs from "fs";
import { ethers } from "ethers";
import type { AdminConfig, CommandDatabase } from "./types";
import { loadBlockhostConfig } from "../config/blockhost-config";

const ADMIN_COMMANDS_FILE = "/etc/blockhost/admin-commands.json";

/**
 * Load admin configuration from blockhost.yaml
 * Returns null if admin commands are not configured
 */
export function loadAdminConfig(): AdminConfig | null {
  try {
    const config = loadBlockhostConfig();
    if (!config) {
      return null;
    }

    const admin = config.admin as Record<string, unknown> | undefined;

    if (!admin || !admin.wallet_address) {
      return null;
    }

    const walletAddress = admin.wallet_address as string;

    // Validate wallet address format
    if (!ethers.isAddress(walletAddress)) {
      console.error(`[ADMIN] Invalid admin wallet address: ${walletAddress}`);
      return null;
    }

    return {
      wallet_address: walletAddress.toLowerCase(),
      max_command_age: (admin.max_command_age as number) || 300,
    };
  } catch (err) {
    console.error(`[ADMIN] Error loading admin config: ${err}`);
    return null;
  }
}

/**
 * Load command database from admin-commands.json
 */
export function loadCommandDatabase(): CommandDatabase | null {
  try {
    if (!fs.existsSync(ADMIN_COMMANDS_FILE)) {
      console.warn(`[ADMIN] Command database not found: ${ADMIN_COMMANDS_FILE}`);
      return null;
    }

    const data = fs.readFileSync(ADMIN_COMMANDS_FILE, "utf8");
    const db = JSON.parse(data) as CommandDatabase;

    if (!db.commands || typeof db.commands !== 'object') {
      console.error(`[ADMIN] Invalid command database structure`);
      return null;
    }

    return db;
  } catch (err) {
    console.error(`[ADMIN] Error loading command database: ${err}`);
    return null;
  }
}

/**
 * Load server private key file path from config
 */
export function getServerPrivateKeyPath(): string {
  return "/etc/blockhost/server.key";
}
