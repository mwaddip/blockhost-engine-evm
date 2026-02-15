/**
 * ab --init <admin-addr> <server-addr> [dev-addr] [broker-addr] <server-keyfile>
 *
 * Bootstrap the addressbook with initial required entries.
 * dev and broker are optional — the keyfile (last arg, not an address) marks the end.
 * Fails if addressbook already has entries (safety — only for fresh bootstrap).
 *
 * Arg counts:
 *   3: admin, server, keyfile
 *   4: admin, server, dev, keyfile
 *   5: admin, server, dev, broker, keyfile
 */

import * as fs from "fs";
import { ethers } from "ethers";
import { loadAddressbook, saveAddressbook } from "../../fund-manager/addressbook";
import type { Addressbook } from "../../fund-manager/types";

export async function initCommand(args: string[]): Promise<void> {
  if (args.length < 3 || args.length > 5) {
    console.error("Usage: ab --init <admin-addr> <server-addr> [dev-addr] [broker-addr] <server-keyfile>");
    console.error("  dev and broker are optional; keyfile is always last");
    process.exit(1);
  }

  // Keyfile is always the last argument (it's a path, not an 0x address)
  const serverKeyfile = args[args.length - 1];
  const addresses = args.slice(0, -1);

  // Validate keyfile exists
  if (!fs.existsSync(serverKeyfile)) {
    console.error(`Error: server keyfile not found: ${serverKeyfile}`);
    process.exit(1);
  }

  const adminAddr = addresses[0];
  const serverAddr = addresses[1];
  const devAddr = addresses.length >= 3 ? addresses[2] : null;
  const brokerAddr = addresses.length >= 4 ? addresses[3] : null;

  // Validate addresses
  if (!ethers.isAddress(adminAddr)) {
    console.error(`Error: invalid admin address: ${adminAddr}`);
    process.exit(1);
  }
  if (!ethers.isAddress(serverAddr)) {
    console.error(`Error: invalid server address: ${serverAddr}`);
    process.exit(1);
  }
  if (devAddr && !ethers.isAddress(devAddr)) {
    console.error(`Error: invalid dev address: ${devAddr}`);
    process.exit(1);
  }
  if (brokerAddr && !ethers.isAddress(brokerAddr)) {
    console.error(`Error: invalid broker address: ${brokerAddr}`);
    process.exit(1);
  }

  // Safety: refuse if addressbook already has entries
  const existing = loadAddressbook();
  if (Object.keys(existing).length > 0) {
    console.error("Error: addressbook already has entries. --init is only for fresh bootstrap.");
    process.exit(1);
  }

  const book: Addressbook = {
    admin: { address: adminAddr },
    server: { address: serverAddr, keyfile: serverKeyfile },
  };

  if (devAddr) {
    book.dev = { address: devAddr };
  }

  if (brokerAddr) {
    book.broker = { address: brokerAddr };
  }

  await saveAddressbook(book);
  console.log("Addressbook initialized:");
  console.log(`  admin  → ${adminAddr}`);
  console.log(`  server → ${serverAddr} (keyfile: ${serverKeyfile})`);
  if (devAddr) console.log(`  dev    → ${devAddr}`);
  if (brokerAddr) console.log(`  broker → ${brokerAddr}`);
}
