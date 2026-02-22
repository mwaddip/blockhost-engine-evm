/**
 * bw split <amount> <token> <ratios> <from> <to1> <to2> ...
 *
 * Split tokens from a signing wallet to multiple recipients.
 * Ratios are given as "60/40" or "50/30/20" (must sum to 100).
 * Last recipient gets any rounding dust.
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveAddress, resolveWallet } from "../../fund-manager/addressbook";
import { transferToken, ERC20_ABI } from "../../fund-manager/token-utils";
import { resolveToken } from "../cli-utils";

export async function splitCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider,
  contract: ethers.Contract
): Promise<void> {
  if (args.length < 5) {
    console.error("Usage: bw split <amount> <token> <ratios> <from> <to1> <to2> ...");
    console.error("  Example: bw split 0.1 eth 60/40 hot dev broker");
    console.error("  Example: bw split 100 stable 50/50 hot dev admin");
    process.exit(1);
  }

  const [amountStr, tokenArg, ratiosStr, fromRole, ...recipientRoles] = args;

  // Parse amount
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error(`Invalid amount: ${amountStr}`);
    process.exit(1);
  }

  // Parse ratios
  const ratios = ratiosStr.split("/").map(Number);
  if (ratios.some(isNaN) || ratios.some((r) => r <= 0)) {
    console.error(`Invalid ratios: ${ratiosStr}. Use format like 60/40 or 50/30/20`);
    process.exit(1);
  }

  const ratioSum = ratios.reduce((a, b) => a + b, 0);
  if (ratioSum !== 100) {
    console.error(`Ratios must sum to 100, got ${ratioSum}`);
    process.exit(1);
  }

  if (ratios.length !== recipientRoles.length) {
    console.error(
      `Number of ratios (${ratios.length}) must match number of recipients (${recipientRoles.length})`
    );
    process.exit(1);
  }

  // Resolve sender
  const signer = resolveWallet(fromRole, book, provider);
  if (!signer) {
    process.exit(1);
  }

  // Resolve recipients
  const recipients: string[] = [];
  for (const role of recipientRoles) {
    const addr = resolveAddress(role, book);
    if (!addr) {
      process.exit(1);
    }
    recipients.push(addr);
  }

  // Resolve token
  const resolved = await resolveToken(tokenArg, contract);

  let sent = 0;
  let failed = 0;

  if (resolved.isNative) {
    // Split native ETH
    const totalWei = ethers.parseEther(amountStr);
    let remaining = totalWei;

    console.log(
      `Splitting ${amountStr} ETH from ${fromRole}: ${ratios.map((r, i) => `${r}% to ${recipientRoles[i]}`).join(", ")}`
    );

    for (let i = 0; i < recipients.length; i++) {
      const isLast = i === recipients.length - 1;
      const share = isLast
        ? remaining
        : (totalWei * BigInt(ratios[i])) / 100n;
      remaining -= share;

      try {
        const tx = await signer.sendTransaction({
          to: recipients[i],
          value: share,
        });
        const receipt = await tx.wait();
        console.log(
          `  ${recipientRoles[i]}: ${ethers.formatEther(share)} ETH (tx: ${receipt?.hash})`
        );
        sent++;
      } catch (err) {
        console.error(`  ${recipientRoles[i]}: FAILED (${err})`);
        failed++;
      }
    }
  } else {
    // Split ERC20 token
    const token = new ethers.Contract(resolved.address, ERC20_ABI, provider);
    const decimals = Number(await token.decimals());
    const symbol: string = await token.symbol();
    const totalAmount = ethers.parseUnits(amountStr, decimals);
    let remaining = totalAmount;

    console.log(
      `Splitting ${amountStr} ${symbol} from ${fromRole}: ${ratios.map((r, i) => `${r}% to ${recipientRoles[i]}`).join(", ")}`
    );

    for (let i = 0; i < recipients.length; i++) {
      const isLast = i === recipients.length - 1;
      const share = isLast
        ? remaining
        : (totalAmount * BigInt(ratios[i])) / 100n;
      remaining -= share;

      try {
        const receipt = await transferToken(
          resolved.address,
          recipients[i],
          share,
          signer
        );
        console.log(
          `  ${recipientRoles[i]}: ${ethers.formatUnits(share, decimals)} ${symbol} (tx: ${receipt?.hash})`
        );
        sent++;
      } catch (err) {
        console.error(`  ${recipientRoles[i]}: FAILED (${err})`);
        failed++;
      }
    }
  }

  if (failed > 0) {
    console.error(`Done. ${sent} sent, ${failed} failed.`);
    process.exit(1);
  }
  console.log("Done.");
}
