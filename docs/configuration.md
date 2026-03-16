# Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `blockhost.yaml` | `/etc/blockhost/` | Server keypair, public secret, admin wallet, fund manager settings |
| `web3-defaults.yaml` | `/etc/blockhost/` | Blockchain config (chain ID, contracts, RPC) |
| `admin-commands.json` | `/etc/blockhost/` | Admin command definitions (port knocking, etc.) |
| `addressbook.json` | `/etc/blockhost/` | Role-to-wallet mapping (admin, server, hot, dev, broker) |
| `revenue-share.json` | `/etc/blockhost/` | Revenue sharing configuration (dev/broker splits) |
| `vms.json` | `/var/lib/blockhost/` | VM database (IPs, VMIDs, NFT state) |
| `engine.json` | `/usr/share/blockhost/` | Engine manifest (identity, wizard plugin, constraints) |
