/**
 * Keyfile loading and ethers.Wallet construction
 */

import * as fs from "fs";
import { ethers } from "ethers";

/**
 * Read a private key from a keyfile (hex, no 0x prefix)
 */
function readKeyfile(keyfilePath: string): string {
  const raw = fs.readFileSync(keyfilePath, "utf8").trim();
  // Strip 0x prefix if present for consistency
  return raw.startsWith("0x") ? raw.slice(2) : raw;
}

/**
 * Create an ethers.Wallet from a keyfile path
 */
export function walletFromKeyfile(
  keyfilePath: string,
  provider: ethers.Provider
): ethers.Wallet {
  const privateKey = readKeyfile(keyfilePath);
  return new ethers.Wallet(privateKey, provider);
}

