# Reconciler

The reconciler runs every 5 minutes as part of the monitor polling loop. It ensures local state (`vms.json`) matches on-chain state.

## NFT Minting Reconciliation

Detects and fixes cases where NFTs were minted on-chain but the local database wasn't updated (e.g., due to a crash during provisioning).

## NFT Ownership Transfer Detection

When an NFT is transferred to a new wallet, the reconciler detects the ownership change and updates the VM so the new owner can authenticate:

1. Compares on-chain `ownerOf(tokenId)` with the locally stored `owner_wallet` for each active VM
2. On transfer: updates `vms.json` and calls the provisioner's `update-gecos` command to update the VM's GECOS field
3. If the GECOS update fails (VM stopped, guest agent unresponsive), retries on the next cycle

This is the sole mechanism for propagating NFT ownership changes to VMs. The PAM module authenticates against the VM's GECOS field, not the blockchain directly.
