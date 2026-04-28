/**
 * Keyfile loading and ethers.Wallet construction
 */

import * as fs from "fs";
import { ethers } from "ethers";

function readKeyfile(keyfilePath: string): string {
  const raw = fs.readFileSync(keyfilePath, "utf8").trim();
  return raw.startsWith("0x") ? raw.slice(2) : raw;
}

export function walletFromKeyfile(
  keyfilePath: string,
  provider: ethers.Provider,
): ethers.Wallet {
  const privateKey = readKeyfile(keyfilePath);
  return new ethers.Wallet(privateKey, provider);
}
