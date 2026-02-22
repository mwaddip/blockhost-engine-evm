/**
 * Shared loader for /etc/blockhost/blockhost.yaml
 *
 * Replaces 4 independent copies across fund-manager/config.ts,
 * admin/config.ts, and bw/commands/who.ts.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import { BLOCKHOST_CONFIG_PATH } from "./paths";

let cached: Record<string, unknown> | null = null;

/**
 * Load and cache the raw blockhost.yaml contents.
 * Returns null if the file doesn't exist.
 */
export function loadBlockhostConfig(): Record<string, unknown> | null {
  if (cached) return cached;

  if (!fs.existsSync(BLOCKHOST_CONFIG_PATH)) {
    return null;
  }

  cached = yaml.load(fs.readFileSync(BLOCKHOST_CONFIG_PATH, "utf8")) as Record<string, unknown>;
  return cached;
}
