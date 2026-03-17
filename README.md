# Blockhost Engine (EVM)

Blockchain-based VM hosting subscription system. Users purchase subscriptions on-chain, which triggers automatic VM provisioning with NFT-based SSH authentication.

## How It Works

1. **User visits signup page** - Connects wallet, signs message, purchases subscription
2. **Smart contract emits event** - SubscriptionCreated with encrypted user data
3. **Monitor service detects event** - Triggers VM provisioning
4. **VM is created** - With web3-only SSH authentication (no passwords, no keys)
5. **NFT is minted** - Contains embedded signing page for authentication
6. **User authenticates** - Signs with wallet on VM's signing page, gets OTP, SSHs in

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Signup Page   │────▶│  Smart Contract  │────▶│  Monitor Svc    │
│   (static HTML) │     │  (Sepolia/ETH)   │     │  (TypeScript)   │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   User's VM     │◀────│  Provisioner     │◀────│  Engine         │
│   (web3 auth)   │     │  (pluggable)     │     │  (manifest)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

The engine discovers provisioner commands via a manifest file (`/usr/share/blockhost/provisioner.json`). VMs are identified by name (`blockhost-001`), not by backend-specific IDs. Different provisioner backends (Proxmox, cloud, etc.) can be used without engine changes.

## Components

| Component | Language | Description |
|-----------|----------|-------------|
| `contracts/` | Solidity | Subscription smart contract with NFT minting |
| `src/monitor/` | TypeScript | Blockchain event watcher |
| `src/handlers/` | TypeScript | Event handlers calling VM provisioning |
| `src/admin/` | TypeScript | On-chain admin commands (port knocking, etc.) |
| `src/reconcile/` | TypeScript | NFT state reconciliation and ownership transfer detection |
| `src/fund-manager/` | TypeScript | Automated fund withdrawal, revenue sharing, gas management |
| `src/bw/` | TypeScript | blockwallet CLI for scriptable wallet operations |
| `src/ab/` | TypeScript | Addressbook CLI for managing wallet entries |
| `src/is/` | TypeScript | Identity predicate CLI (NFT ownership, signature, contract checks) |
| `src/root-agent/` | TypeScript | Client for the privileged root agent daemon |
| `blockhost/engine_evm/` | Python | Installer wizard plugin (blockchain config, finalization steps) |
| `scripts/` | TS/Python/Bash | Deployment, crypto CLI, signup page generation |

## Prerequisites

- Node.js 22+
- Python 3.10+
- Foundry (forge/cast) for NFT contract deployment
- `blockhost-common` package (shared configuration)
- A provisioner package (e.g. `blockhost-provisioner-proxmox`) with a manifest
- `python3-pycryptodome` and `python3-ecdsa` (crypto operations for bhcrypt)

## Installation

This package is a component of the Blockhost system — it is not used standalone. Production installation is handled by the [blockhost-installer](https://github.com/mwaddip/blockhost-installer), which installs `blockhost-common`, a provisioner, and this engine as `.deb` packages. See [INSTALL.md](INSTALL.md) for manual package installation.

## Development

```bash
git clone https://github.com/mwaddip/blockhost-engine-evm.git
cd blockhost-engine-evm
npm install

npm run compile          # Compile Solidity contracts
npm test                 # Run tests
npm run test:coverage    # Run tests with coverage
npm run node             # Start local Hardhat node
npm run deploy:local     # Deploy to local node
```

## Documentation

| Doc | Covers |
|-----|--------|
| [Smart Contract](docs/smart-contract.md) | Contract functions, plans, payments |
| [Page Templates](docs/page-templates.md) | Custom signup page branding, DOM IDs, CSS classes |
| [CLI Reference](docs/cli.md) | `bw`, `ab`, `is` command-line tools |
| [Fund Manager](docs/fund-manager.md) | Withdrawal cycles, gas management, revenue sharing |
| [Reconciler](docs/reconciler.md) | NFT state sync, ownership transfer detection |
| [Configuration](docs/configuration.md) | Config file locations and purpose |
| [Engine Manifest](docs/engine-manifest.md) | `engine.json` constraints and identity |
| [Privilege Separation](docs/privilege-separation.md) | Root agent protocol and actions |

## Project Structure

```
blockhost-engine-evm/
├── contracts/                 # Solidity smart contracts
│   ├── BlockhostSubscriptions.sol
│   └── mocks/                 # Test mocks
├── scripts/                   # Deployment, crypto CLI & utility scripts
│   ├── bhcrypt.py             # Crypto CLI (installed as bhcrypt)
│   ├── mint_nft.py            # NFT minting (installed as blockhost-mint-nft)
│   ├── deploy.ts              # Contract deployment (Hardhat, development)
│   ├── deploy-contracts.sh    # Contract deployment (production, no Hardhat)
│   ├── generate-signup-page.py # Combines template + engine.js → signup.html
│   ├── signup-template.html   # Signup page HTML/CSS template (replaceable)
│   └── signup-engine.js       # Signup page JS bundle (engine-owned)
├── blockhost/engine_evm/       # Installer wizard plugin
│   ├── wizard.py              # Blueprint, API routes, finalization steps
│   └── templates/engine_evm/  # Wizard page and summary templates
├── engine.json                # Engine manifest (identity, wizard plugin, constraints)
├── src/                       # TypeScript source
│   ├── monitor/               # Blockchain event monitor
│   ├── handlers/              # Event handlers
│   ├── admin/                 # On-chain admin command processing
│   ├── reconcile/             # NFT state reconciliation
│   ├── fund-manager/          # Automated fund withdrawal & distribution
│   ├── bw/                    # blockwallet CLI
│   ├── ab/                    # addressbook CLI
│   ├── is/                    # identity predicate CLI
│   └── root-agent/            # Root agent client (privilege separation)
├── docs/                      # Detailed documentation
├── test/                      # Contract tests
├── examples/                  # Deployment examples
└── PROJECT.yaml               # Machine-readable spec
```

## License

MIT

## Related Packages

- `blockhost-common` - Shared configuration and Python modules
- `blockhost-provisioner-proxmox` - VM provisioning scripts (Proxmox/Terraform)
- `libpam-web3` - PAM module for web3 authentication (installed on VMs)
