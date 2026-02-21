# Blockhost Installation Guide

This guide covers installing the Blockhost system on a Debian/Ubuntu server (tested on Proxmox VE host).

## Prerequisites

- Debian 12+ or Ubuntu 22.04+
- Root access
- Network connectivity to Sepolia RPC endpoint
- Proxmox VE (for VM provisioning)

## Installation Steps

### 1. Install Node.js 20 and Terraform

```bash
# Install required packages
apt-get update
apt-get install -y ca-certificates curl gnupg

# Add NodeSource repository
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list

# Install Node.js
apt-get update
apt-get install -y nodejs

# Verify installation
node --version  # Should show v20.x.x
```

**Terraform:**
```bash
# Add HashiCorp repository
curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo 'deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com bookworm main' > /etc/apt/sources.list.d/hashicorp.list

# Install Terraform
apt-get update
apt-get install -y terraform

# Verify installation
terraform --version
```

**Foundry (for NFT minting):**
```bash
# Install foundryup
curl -L https://foundry.paradigm.xyz | bash

# Source the updated PATH (or start new shell)
source /root/.bashrc

# Install foundry tools
foundryup

# Verify installation
/root/.foundry/bin/cast --version
```

**bhcrypt** is included in the blockhost-engine package (no separate install needed).
Dependencies `python3-pycryptodome` and `python3-ecdsa` are pulled in automatically.

### 2. Install Blockhost Packages

Install packages in dependency order:

```bash
# 1. blockhost-common (provides config directories and Python modules)
dpkg -i blockhost-common_*.deb

# 2. blockhost-provisioner-proxmox (provides VM provisioning scripts)
dpkg -i blockhost-provisioner-proxmox_*.deb

# 3. blockhost-engine (provides monitor service)
dpkg -i blockhost-engine_*.deb
```

This creates the directory structure automatically:
- `/etc/blockhost/` - Configuration files
- `/var/lib/blockhost/` - Data and terraform working directory
- `/usr/lib/blockhost-provisioner-proxmox/` - VM provisioning scripts

### 3. Installed File Structure

After installing the packages, the following structure is created:

```
# Provided by blockhost-common:
/etc/blockhost/
├── db.yaml                   # VM database configuration
└── web3-defaults.yaml        # Blockchain config (template)

/var/lib/blockhost/
├── terraform/                # Terraform working directory
└── vms.json                  # VM database

# Provided by blockhost-provisioner-proxmox:
/usr/lib/blockhost-provisioner-proxmox/
├── scripts/                  # VM provisioning scripts
└── cloud-init/               # Cloud-init templates

# Provided by blockhost-engine:
/opt/blockhost/
├── package.json              # Monitor dependencies
├── start.sh                  # Monitor startup script
└── src/                      # TypeScript source

/usr/bin/
└── blockhost-generate-signup # Signup page generator

# Created by wizard finalization:
/etc/blockhost/
├── blockhost.yaml            # Server config
├── server.key                # Server private key (chmod 600)
└── deployer.key              # Deployer private key (chmod 600)
```

### 4. Configure Environment

Edit `/opt/blockhost/.env` with your contract address:

```bash
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
BLOCKHOST_CONTRACT=0xYourDeployedContractAddress
```

Also update the NFT contract address in `/etc/blockhost/web3-defaults.yaml`:

```yaml
blockchain:
  nft_contract: "0xYourDeployedContractAddress"
```

### 5. Enable and Start Service

```bash
systemctl enable --now blockhost-monitor
```

### 6. Verify Service Status

```bash
systemctl status blockhost-monitor
```

## Management Commands

```bash
# Check status
systemctl status blockhost-monitor

# View logs
journalctl -u blockhost-monitor -f

# Restart service
systemctl restart blockhost-monitor

# Stop service
systemctl stop blockhost-monitor

# Disable auto-start
systemctl disable blockhost-monitor
```

## Troubleshooting

### Service fails to start

1. Check logs: `journalctl -u blockhost-monitor -n 50`
2. Verify environment file exists: `cat /opt/blockhost/.env`
3. Test manual startup: `/opt/blockhost/start.sh`

### RPC connection errors

1. Verify network connectivity: `curl -I https://ethereum-sepolia-rpc.publicnode.com`
2. Try an alternative RPC endpoint in `.env`

### Missing dependencies

```bash
cd /opt/blockhost
npm install
```

## File Locations Summary

| File | Purpose |
|------|---------|
| `/opt/blockhost/.env` | Monitor environment (RPC, contract address) |
| `/opt/blockhost/start.sh` | Monitor startup script |
| `/opt/blockhost/src/` | TypeScript source (monitor, handlers) |
| `/var/lib/blockhost/terraform/` | Terraform working directory |
| `/usr/lib/blockhost-provisioner-proxmox/` | VM provisioning scripts |
| `/etc/blockhost/blockhost.yaml` | Server configuration (keys, public secret, admin wallet) |
| `/etc/blockhost/web3-defaults.yaml` | Blockchain/NFT configuration |
| `/etc/blockhost/admin-commands.json` | Admin command definitions (optional) |
| `/etc/blockhost/db.yaml` | Database and IP pool configuration |
| `/etc/blockhost/server.key` | Server private key (ECIES) |
| `/etc/blockhost/deployer.key` | Deployer private key (NFT minting) |
| `/var/lib/blockhost/vms.json` | VM database (VMs, reserved NFT tokens) |

## VM Provisioning

VM provisioning scripts are provided by the `blockhost-provisioner-proxmox` package.

### Initialize Terraform

```bash
cd /var/lib/blockhost/terraform
terraform init
```

### Manual VM Commands (for testing)

```bash
# Test VM generator (mock mode)
python3 /usr/lib/blockhost-provisioner-proxmox/scripts/vm-generator.py test-vm --owner-wallet 0x... --mock --skip-mint

# Create a real VM
python3 /usr/lib/blockhost-provisioner-proxmox/scripts/vm-generator.py myvm --owner-wallet 0x... --apply

# Garbage collect expired VMs
python3 /usr/lib/blockhost-provisioner-proxmox/scripts/vm-gc.py --execute --grace-days 3
```
