/**
 * bw send <amount> <token> <from> <to>
 *
 * Send tokens from a signing wallet to a recipient.
 * Core function executeSend() is also used by fund-manager.
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveAddress, resolveWallet } from "../../fund-manager/addressbook";
import { transferToken, ERC20_ABI } from "../../fund-manager/token-utils";
import { resolveToken } from "../cli-utils";

/**
 * Core send operation — used by both CLI and fund-manager.
 * Throws on error (caller decides how to handle).
 * Returns the transaction hash.
 */
export async function executeSend(
  amountStr: string,
  tokenArg: string,
  fromRole: string,
  toRole: string,
  book: Addressbook,
  provider: ethers.Provider,
  contract: ethers.Contract
): Promise<string> {
  const signer = resolveWallet(fromRole, book, provider);
  if (!signer) throw new Error(`Cannot sign as '${fromRole}': no keyfile`);

  const toAddress = resolveAddress(toRole, book);
  if (!toAddress) throw new Error(`Cannot resolve recipient '${toRole}'`);

  const resolved = await resolveToken(tokenArg, contract);

  if (resolved.isNative) {
    const tx = await signer.sendTransaction({
      to: toAddress,
      value: ethers.parseEther(amountStr),
    });
    const receipt = await tx.wait();
    if (!receipt) throw new Error("Transaction dropped from mempool");
    return receipt.hash;
  }

  const token = new ethers.Contract(resolved.address, ERC20_ABI, provider);
  const decimals = Number(await token.decimals());
  const tokenAmount = ethers.parseUnits(amountStr, decimals);
  const receipt = await transferToken(resolved.address, toAddress, tokenAmount, signer);
  if (!receipt) throw new Error("Transaction dropped from mempool");
  return receipt.hash;
}

/**
 * CLI handler
 */
export async function sendCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider,
  contract: ethers.Contract
): Promise<void> {
  if (args.length < 4) {
    console.error("Usage: bw send <amount> <token> <from> <to>");
    console.error("  Example: bw send 1 eth hot admin");
    console.error("  Example: bw send 100 stable server hot");
    process.exit(1);
  }

  const [amountStr, tokenArg, fromRole, toRole] = args;
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error(`Invalid amount: ${amountStr}`);
    process.exit(1);
  }

  console.log(`Sending ${amountStr} ${tokenArg} from ${fromRole} to ${toRole}...`);
  const txHash = await executeSend(amountStr, tokenArg, fromRole, toRole, book, provider, contract);
  console.log(`Sent. tx: ${txHash}`);
}
