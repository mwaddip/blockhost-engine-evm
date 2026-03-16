/**
 * Shared loader for /etc/blockhost/web3-defaults.yaml
 *
 * Replaces 5 independent copies across who.ts, is/index.ts, set.ts,
 * reconcile/index.ts, and chain-pools.ts.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import { ethers } from "ethers";
import { WEB3_DEFAULTS_PATH } from "./paths";

export interface Web3Config {
  nftContract: string;
  rpcUrl: string;
}

let cached: Record<string, unknown> | null = null;

/**
 * Load and cache the raw web3-defaults.yaml contents.
 * Returns null if the file doesn't exist.
 */
export function loadWeb3Defaults(): Record<string, unknown> | null {
  if (cached) return cached;

  if (!fs.existsSync(WEB3_DEFAULTS_PATH)) {
    return null;
  }

  cached = yaml.load(fs.readFileSync(WEB3_DEFAULTS_PATH, "utf8")) as Record<string, unknown>;
  return cached;
}

/**
 * Load nft_contract and rpc_url from the blockchain section.
 * Throws if the file or required fields are missing.
 */
export function loadWeb3Config(): Web3Config {
  const raw = loadWeb3Defaults();
  if (!raw) {
    throw new Error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
  }

  const blockchain = raw.blockchain as Record<string, unknown> | undefined;

  const nftContract = blockchain?.nft_contract as string | undefined;
  if (!nftContract || !ethers.isAddress(nftContract)) {
    throw new Error("blockchain.nft_contract not set or invalid in web3-defaults.yaml");
  }

  const rpcUrl = blockchain?.rpc_url as string | undefined;
  if (!rpcUrl) {
    throw new Error("blockchain.rpc_url not set in web3-defaults.yaml");
  }

  return { nftContract, rpcUrl };
}

/**
 * Load only the nft_contract address.
 * Throws if the file or field is missing.
 */
export function loadNftContractAddress(): string {
  const raw = loadWeb3Defaults();
  if (!raw) {
    throw new Error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
  }

  const blockchain = raw.blockchain as Record<string, unknown> | undefined;
  const nftContract = blockchain?.nft_contract as string | undefined;
  if (!nftContract || !ethers.isAddress(nftContract)) {
    throw new Error("blockchain.nft_contract not set or invalid in web3-defaults.yaml");
  }

  return nftContract;
}

/**
 * Load only the rpc_url.
 * Throws if the file or field is missing.
 */
export function loadRpcUrl(): string {
  const raw = loadWeb3Defaults();
  if (!raw) {
    throw new Error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
  }

  const blockchain = raw.blockchain as Record<string, unknown> | undefined;
  const rpcUrl = blockchain?.rpc_url as string | undefined;
  if (!rpcUrl) {
    throw new Error("blockchain.rpc_url not set in web3-defaults.yaml");
  }

  return rpcUrl;
}
