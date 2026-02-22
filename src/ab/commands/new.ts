/**
 * ab new <name> — Generate new wallet via root agent and add to addressbook
 */

import { loadAddressbook } from "../../fund-manager/addressbook";
import { generateWallet as rootAgentGenerateWallet } from "../../root-agent/client";
import { assertMutable, assertValidName } from "../index";

export async function newCommand(args: string[]): Promise<void> {
  if (args.length !== 1) {
    console.error("Usage: ab new <name>");
    process.exit(1);
  }

  const [name] = args;
  assertValidName(name);
  assertMutable(name);

  const book = loadAddressbook();

  if (book[name]) {
    console.error(`Error: '${name}' already exists in addressbook.`);
    process.exit(1);
  }

  // Root agent generates the key AND updates addressbook atomically
  const { address } = await rootAgentGenerateWallet(name);
  console.log(`Generated wallet '${name}' → ${address}`);
  console.log(`Key saved to /etc/blockhost/${name}.key`);
}
