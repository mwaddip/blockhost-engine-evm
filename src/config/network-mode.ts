/**
 * Reads /etc/blockhost/network-mode (single line: broker | manual | onion).
 * Defaults to "broker" if the file is absent, for backwards compatibility with
 * installs predating the network hook (see facts/ENGINE_INTERFACE.md §13).
 */

import * as fs from "fs";
import { NETWORK_MODE_PATH } from "./paths";

let cached: string | null = null;

export function getNetworkMode(): string {
  if (cached) return cached;

  try {
    if (fs.existsSync(NETWORK_MODE_PATH)) {
      const value = fs.readFileSync(NETWORK_MODE_PATH, "utf8").trim();
      if (value) {
        cached = value;
        return cached;
      }
    }
  } catch (err) {
    console.warn(`[WARN] Failed to read ${NETWORK_MODE_PATH}: ${err}`);
  }

  cached = "broker";
  return cached;
}
