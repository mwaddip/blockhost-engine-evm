/**
 * Addressbook loading, saving, and resolution utilities
 * Shared between fund-manager and bw CLI
 */

import * as fs from "fs";
import { ethers } from "ethers";
import type { Addressbook, AddressbookEntry } from "./types";
import { walletFromKeyfile } from "./wallet";
import { addressbookSave, generateWallet as rootAgentGenerateWallet } from "../root-agent/client";

const ADDRESSBOOK_PATH = "/etc/blockhost/addressbook.json";
const HOT_KEY_PATH = "/etc/blockhost/hot.key";

/**
 * Load addressbook from /etc/blockhost/addressbook.json
 */
export function loadAddressbook(): Addressbook {
  try {
    if (!fs.existsSync(ADDRESSBOOK_PATH)) {
      console.error(`[FUND] Addressbook not found: ${ADDRESSBOOK_PATH}`);
      return {};
    }

    const data = fs.readFileSync(ADDRESSBOOK_PATH, "utf8");
    const book = JSON.parse(data) as Addressbook;

    // Validate all addresses
    for (const [role, entry] of Object.entries(book)) {
      if (!ethers.isAddress(entry.address)) {
        console.error(`[FUND] Invalid address for role '${role}': ${entry.address}`);
        delete book[role];
      }
    }

    return book;
  } catch (err) {
    console.error(`[FUND] Error loading addressbook: ${err}`);
    return {};
  }
}

/**
 * Save addressbook via root agent
 */
export async function saveAddressbook(book: Addressbook): Promise<void> {
  await addressbookSave(book);
}

/**
 * Resolve an identifier to an address.
 * Accepts a role name (looked up in addressbook) or a raw 0x address.
 */
export function resolveAddress(identifier: string, book: Addressbook): string | null {
  // Raw address
  if (identifier.startsWith("0x")) {
    if (!ethers.isAddress(identifier)) {
      console.error(`Invalid address: ${identifier}`);
      return null;
    }
    return identifier;
  }

  // Role lookup
  const entry = book[identifier];
  if (!entry) {
    console.error(`Role '${identifier}' not found in addressbook`);
    return null;
  }
  return entry.address;
}

/**
 * Resolve a role name to a signing wallet (requires keyfile).
 */
export function resolveWallet(
  identifier: string,
  book: Addressbook,
  provider: ethers.Provider
): ethers.Wallet | null {
  const entry = book[identifier];
  if (!entry) {
    console.error(`Role '${identifier}' not found in addressbook`);
    return null;
  }

  if (!entry.keyfile) {
    console.error(`Role '${identifier}' has no keyfile — cannot sign transactions`);
    return null;
  }

  if (!fs.existsSync(entry.keyfile)) {
    console.error(`Keyfile not found for '${identifier}': ${entry.keyfile}`);
    return null;
  }

  return walletFromKeyfile(entry.keyfile, provider);
}

/**
 * Ensure the hot wallet exists in the addressbook.
 * Generates one via root agent if missing.
 */
export async function ensureHotWallet(book: Addressbook): Promise<Addressbook> {
  if (book.hot) {
    return book;
  }

  console.log(`[FUND] Generating hot wallet via root agent...`);
  const { address } = await rootAgentGenerateWallet("hot");

  book.hot = {
    address,
    keyfile: HOT_KEY_PATH,
  };

  await saveAddressbook(book);
  console.log(`[FUND] Generated hot wallet: ${address}`);
  return book;
}
