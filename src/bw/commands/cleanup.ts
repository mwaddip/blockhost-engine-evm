/**
 * bw --debug --cleanup <address>
 *
 * Testnet utility: sweep all ETH from addressbook wallets (that have keyfiles)
 * back to a single address. Skips wallets that are the target or have
 * insufficient balance to cover gas.
 */

import { ethers } from "ethers";
import type { Addressbook } from "../../fund-manager/types";
import { resolveWallet } from "../../fund-manager/addressbook";

/**
 * Sweep ETH from all signing-capable addressbook wallets to a target address.
 */
export async function cleanupCommand(
  args: string[],
  book: Addressbook,
  provider: ethers.JsonRpcProvider
): Promise<void> {
  if (args.length < 1) {
    console.error("Usage: bw --debug --cleanup <address>");
    process.exit(1);
  }

  const target = args[0];
  if (!ethers.isAddress(target)) {
    console.error(`Invalid target address: ${target}`);
    process.exit(1);
  }

  const targetLower = target.toLowerCase();

  // Collect roles that have keyfiles (can sign) and aren't the target
  const roles: string[] = [];
  for (const [role, entry] of Object.entries(book)) {
    if (!entry.keyfile) continue;
    if (entry.address.toLowerCase() === targetLower) continue;
    roles.push(role);
  }

  if (roles.length === 0) {
    console.log("No signing wallets to sweep.");
    return;
  }

  console.log(`Sweeping ETH from ${roles.length} wallet(s) to ${target}...`);
  console.log("");

  // Query gas price once — all txs use the same estimate
  let gasCost: bigint;
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    gasCost = gasPrice * 21000n;
  } catch (err) {
    console.error(`Cannot estimate gas: ${err}`);
    process.exit(1);
  }

  // 10% safety margin on gas
  const gasCostWithMargin = gasCost + gasCost / 10n;

  // Build send tasks — each wallet is an independent signer, no nonce conflicts
  type SweepResult = { role: string; amount: bigint; hash: string }
    | { role: string; skipped: string }
    | { role: string; failed: string };

  const tasks: Promise<SweepResult>[] = [];

  for (const role of roles) {
    const wallet = resolveWallet(role, book, provider);
    if (!wallet) {
      console.log(`  ${role}: skipped (cannot load wallet)`);
      continue;
    }

    tasks.push(
      (async (): Promise<SweepResult> => {
        const balance = await provider.getBalance(wallet.address);
        if (balance === 0n) {
          return { role, skipped: "zero balance" };
        }

        if (balance <= gasCostWithMargin) {
          return { role, skipped: `${ethers.formatEther(balance)} ETH, below gas cost` };
        }

        const sendAmount = balance - gasCostWithMargin;

        try {
          const tx = await wallet.sendTransaction({
            to: target,
            value: sendAmount,
          });
          const receipt = await tx.wait();
          if (!receipt) return { role, failed: "Transaction dropped from mempool" };
          return { role, amount: sendAmount, hash: receipt.hash };
        } catch (err) {
          return { role, failed: `${err}` };
        }
      })()
    );
  }

  const results = await Promise.all(tasks);

  let totalSwept = 0n;
  let swept = 0;
  let skipped = 0;

  for (const r of results) {
    if ("hash" in r) {
      totalSwept += r.amount;
      swept++;
      console.log(`  ${r.role}: sent ${ethers.formatEther(r.amount)} ETH (tx: ${r.hash})`);
    } else if ("skipped" in r) {
      skipped++;
      if (r.skipped !== "zero balance") {
        console.log(`  ${r.role}: skipped (${r.skipped})`);
      }
    } else {
      console.error(`  ${r.role}: failed (${r.failed})`);
    }
  }

  console.log("");
  console.log(
    `Done. Swept ${ethers.formatEther(totalSwept)} ETH from ${swept} wallet(s), skipped ${skipped}.`
  );
}
