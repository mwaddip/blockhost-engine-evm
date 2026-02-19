#!/usr/bin/env python3
"""
NFT Minting Script

Mints access credential NFTs after successful VM creation.
Uses Foundry's `cast` CLI for contract interaction.

Requires:
- Foundry (cast) installed: https://getfoundry.sh
- Deployer private key with funds on the target chain
"""

import subprocess
import sys
from pathlib import Path
from typing import Optional

from blockhost.config import load_web3_config


def read_deployer_key(config: dict) -> str:
    """Read the deployer private key from file."""
    key_file = Path(config["deployer"]["private_key_file"])

    if not key_file.exists():
        raise FileNotFoundError(
            f"Deployer key not found at {key_file}. "
            f"Create it with: cast wallet new | grep 'Private key' | awk '{{print $3}}' > {key_file}"
        )

    return key_file.read_text().strip()


def mint_nft(
    owner_wallet: str,
    user_encrypted: str = "0x",
    config: Optional[dict] = None,
    dry_run: bool = False,
) -> Optional[str]:
    """
    Mint an access credential NFT to the specified wallet.

    Args:
        owner_wallet: Ethereum address to receive the NFT
        user_encrypted: Hex-encoded encrypted connection details
        config: Web3 config dict (loaded from web3-defaults.yaml if None)
        dry_run: If True, print the command but don't execute

    Returns:
        Transaction hash if successful, None if dry run
    """
    if config is None:
        config = load_web3_config()

    nft_contract = config["blockchain"]["nft_contract"]
    rpc_url = config["blockchain"]["rpc_url"]

    # Read deployer key
    deployer_key = read_deployer_key(config)

    # Build cast command — mint(address,bytes)
    cmd = [
        "cast", "send",
        nft_contract,
        "mint(address,bytes)",
        owner_wallet,
        user_encrypted,
        "--private-key", deployer_key,
        "--rpc-url", rpc_url,
    ]

    if dry_run:
        # Mask sensitive data in output
        display_cmd = cmd.copy()
        pk_idx = display_cmd.index("--private-key") + 1
        display_cmd[pk_idx] = "0x***REDACTED***"
        print(f"[DRY RUN] Would execute: {' '.join(display_cmd)}")
        return None

    print(f"Minting NFT to {owner_wallet}...")
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        raise RuntimeError(f"Minting failed: {result.stderr}")

    # Extract transaction hash from output
    tx_hash = None
    for line in result.stdout.strip().split("\n"):
        if "transactionHash" in line or line.startswith("0x"):
            tx_hash = line.strip().split()[-1]
            break

    if tx_hash:
        print(f"NFT minted! TX: {tx_hash}")
    else:
        print(f"NFT minted! Output: {result.stdout.strip()}")

    return tx_hash


def main():
    """CLI for testing NFT minting."""
    import argparse

    parser = argparse.ArgumentParser(description="Mint access credential NFT")
    parser.add_argument("--owner-wallet", required=True, help="Wallet address to receive the NFT")
    parser.add_argument("--user-encrypted", default="0x",
                        help="Hex-encoded encrypted connection details (default: 0x)")
    parser.add_argument("--dry-run", action="store_true", help="Print command without executing")

    args = parser.parse_args()

    import re
    if not re.match(r'^0x[0-9a-fA-F]{40}$', args.owner_wallet):
        parser.error("--owner-wallet must be a valid Ethereum address (0x followed by 40 hex characters)")

    try:
        tx_hash = mint_nft(
            owner_wallet=args.owner_wallet,
            user_encrypted=args.user_encrypted,
            dry_run=args.dry_run,
        )
        if tx_hash:
            print(f"\nTransaction: {tx_hash}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
