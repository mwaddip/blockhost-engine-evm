#!/usr/bin/env node
/**
 * is (identity predicate) CLI — yes/no identity questions via exit code
 *
 * Usage:
 *   is <wallet> <nft_id>         Does wallet own NFT token?
 *   is contract <address>        Does a contract exist at address?
 *
 * Exit: 0 = yes, 1 = no
 *
 * Arguments are order-independent, disambiguated by type:
 *   Address: 0x + 40 hex chars
 *   NFT ID: integer
 *   "contract": literal keyword
 *
 * Config from web3-defaults.yaml (rpc_url, nft_contract). No env vars or addressbook.
 */

import * as fs from "fs";
import * as yaml from "js-yaml";
import { ethers } from "ethers";

const WEB3_DEFAULTS_PATH = "/etc/blockhost/web3-defaults.yaml";

const NFT_ABI = ["function ownerOf(uint256 tokenId) view returns (address)"];

interface Web3Config {
  nftContract: string;
  rpcUrl: string;
}

function loadWeb3Config(): Web3Config {
  if (!fs.existsSync(WEB3_DEFAULTS_PATH)) {
    throw new Error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
  }

  const raw = yaml.load(fs.readFileSync(WEB3_DEFAULTS_PATH, "utf8")) as Record<string, unknown>;
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

function loadRpcUrl(): string {
  if (!fs.existsSync(WEB3_DEFAULTS_PATH)) {
    throw new Error(`Config not found: ${WEB3_DEFAULTS_PATH}`);
  }

  const raw = yaml.load(fs.readFileSync(WEB3_DEFAULTS_PATH, "utf8")) as Record<string, unknown>;
  const blockchain = raw.blockchain as Record<string, unknown> | undefined;

  const rpcUrl = blockchain?.rpc_url as string | undefined;
  if (!rpcUrl) {
    throw new Error("blockchain.rpc_url not set in web3-defaults.yaml");
  }

  return rpcUrl;
}

function isAddress(arg: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(arg);
}

function isNftId(arg: string): boolean {
  return /^\d+$/.test(arg);
}

function printUsage(): void {
  console.error("is — identity predicate (exit 0 = yes, 1 = no)");
  console.error("");
  console.error("Usage:");
  console.error("  is <wallet> <nft_id>       Does wallet own NFT token?");
  console.error("  is contract <address>      Does a contract exist at address?");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  // Form: is contract <address>
  if (argv.includes("contract")) {
    const other = argv.filter((a) => a !== "contract");
    if (other.length !== 1 || !isAddress(other[0])) {
      console.error("Usage: is contract <address>");
      process.exit(1);
    }
    const rpcUrl = loadRpcUrl();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const code = await provider.getCode(other[0]);
    // Empty code means no contract (just "0x")
    process.exit(code !== "0x" ? 0 : 1);
  }

  if (argv.length !== 2) {
    printUsage();
    process.exit(1);
  }

  const [arg1, arg2] = argv;

  // Form: is <wallet> <nft_id>  (order-independent)
  let wallet: string | null = null;
  let nftId: string | null = null;
  if (isAddress(arg1) && isNftId(arg2)) {
    wallet = arg1;
    nftId = arg2;
  } else if (isAddress(arg2) && isNftId(arg1)) {
    wallet = arg2;
    nftId = arg1;
  }

  if (wallet && nftId) {
    const { nftContract, rpcUrl } = loadWeb3Config();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(nftContract, NFT_ABI, provider);
    try {
      const owner: string = await contract.ownerOf(parseInt(nftId, 10));
      process.exit(owner.toLowerCase() === wallet.toLowerCase() ? 0 : 1);
    } catch {
      // Token doesn't exist
      process.exit(1);
    }
  }

  console.error("Error: could not parse arguments. See 'is --help'.");
  process.exit(1);
}

main().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
