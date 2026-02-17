# Blockhost Engine

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
| `src/auth-svc/` | TypeScript | Web3 auth signing server (compiled to standalone binary for VMs) |
| `src/root-agent/` | TypeScript | Client for the privileged root agent daemon |
| `blockhost/engine_evm/` | Python | Installer wizard plugin (blockchain config, finalization steps) |
| `auth-svc/signing-page/` | HTML | Signing page served by auth-svc |
| `scripts/` | TS/Python/Bash | Deployment, signup page generation, server init |

## Prerequisites

- Node.js 18+
- Python 3.10+
- Bun (for compiling auth-svc standalone binary)
- Foundry (forge/cast) for NFT contract deployment
- `blockhost-common` package (shared configuration)
- A provisioner package (e.g. `blockhost-provisioner-proxmox`) with a manifest
- `libpam-web3-tools` >= 0.5.0 (provides NFT contract and CLI tools)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/mwaddip/blockhost-engine.git
cd blockhost-engine
npm install
```

### 2. Configure environment

```bash
cp examples/env.example .env
# Edit .env with your deployer private key and RPC URL
```

### 3. Deploy contracts (Sepolia testnet)

The deploy script deploys both BlockhostSubscriptions and AccessCredentialNFT:

```bash
source .env
npm run deploy:sepolia
```

This will:
- Deploy BlockhostSubscriptions (payment/subscription management)
- Deploy AccessCredentialNFT (VM access credentials)
- Update `/etc/blockhost/web3-defaults.yaml` with the NFT contract address

### 4. Initialize server

```bash
sudo ./scripts/init-server.sh
```

This creates:
- `/etc/blockhost/server.key` - Server private key for ECIES encryption
- `/etc/blockhost/blockhost.yaml` - Server configuration

### 5. Generate signup page

```bash
python3 scripts/generate-signup-page.py --output /var/www/signup.html
```

### 6. Start monitor service

```bash
npm run monitor
# Or use systemd: see examples/blockhost-monitor.service
```

## Smart Contract

**BlockhostSubscriptions.sol** handles:

- **Plans** - Subscription tiers with USD pricing (cents/day)
- **Subscriptions** - User subscriptions with expiration timestamps
- **Payments** - ERC20 tokens (USDC primary, others via Uniswap pricing)
- **NFT Minting** - Each subscription gets an NFT with embedded signing page

### Key Functions

```solidity
// Admin
createPlan(name, pricePerDayUsdCents)
setPrimaryStablecoin(tokenAddress)

// Users
buySubscription(planId, days, paymentMethodId, userEncrypted)
extendSubscription(subscriptionId, days, paymentMethodId)
cancelSubscription(subscriptionId)

// Queries
getSubscription(subscriptionId)
isSubscriptionActive(subscriptionId)
```

## VM Authentication Flow

VMs use NFT-based web3 authentication instead of passwords or SSH keys:

1. VM serves signing page on port 8443 via web3-auth-svc (HTTPS, self-signed TLS)
2. User connects wallet that owns the NFT
3. User signs challenge message
4. Signing page displays 6-digit OTP
5. User SSHs to VM, enters OTP when prompted
6. PAM module verifies signature against NFT ownership

## Reconciler

The reconciler runs every 5 minutes as part of the monitor polling loop. It ensures local state (`vms.json`) matches on-chain state.

### NFT Minting Reconciliation

Detects and fixes cases where NFTs were minted on-chain but the local database wasn't updated (e.g., due to a crash during provisioning).

### NFT Ownership Transfer Detection

When an NFT is transferred to a new wallet, the reconciler detects the ownership change and updates the VM so the new owner can authenticate:

1. Compares on-chain `ownerOf(tokenId)` with the locally stored `owner_wallet` for each active VM
2. On transfer: updates `vms.json` and calls the provisioner's `update-gecos` command to update the VM's GECOS field
3. If the GECOS update fails (VM stopped, guest agent unresponsive), retries on the next cycle

This is the sole mechanism for propagating NFT ownership changes to VMs. The PAM module authenticates against the VM's GECOS field, not the blockchain directly.

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `blockhost.yaml` | `/etc/blockhost/` | Server keypair, public secret, admin wallet, fund manager settings |
| `web3-defaults.yaml` | `/etc/blockhost/` | Blockchain config (chain ID, contracts, RPC) |
| `admin-commands.json` | `/etc/blockhost/` | Admin command definitions (port knocking, etc.) |
| `addressbook.json` | `/etc/blockhost/` | Role-to-wallet mapping (admin, server, hot, dev, broker) |
| `revenue-share.json` | `/etc/blockhost/` | Revenue sharing configuration (dev/broker splits) |
| `vms.json` | `/var/lib/blockhost/` | VM database (IPs, VMIDs, reserved NFT tokens) |
| `engine.json` | `/usr/share/blockhost/` | Engine manifest (identity, wizard plugin, constraints) |

## Fund Manager

Integrated into the monitor polling loop. Automates fund withdrawal from the contract, revenue sharing, and gas management.

### Fund Cycle (every 24h, configurable)

1. **Withdraw** — For each payment method token with balance > $50, call `withdrawFunds()` to move tokens from contract to hot wallet
2. **Hot wallet gas** — Server sends ETH to hot wallet if below threshold (default 0.01 ETH)
3. **Server stablecoin buffer** — Hot wallet sends stablecoin to server if below threshold (default $50)
4. **Revenue shares** — If enabled in `revenue-share.json`, distribute configured % to dev/broker
5. **Remainder to admin** — Send all remaining hot wallet token balances to admin

### Gas Check (every 30min, configurable)

- Top up hot wallet ETH from server if below threshold
- Check server wallet ETH balance; if below `gas_low_threshold_usd` ($5), swap USDC→ETH via Uniswap V2

### Hot Wallet

Auto-generated on first fund cycle if not in addressbook. Private key saved to `/etc/blockhost/hot.key` (chmod 600). Acts as an intermediary for distribution — contract funds flow through it before going to recipients.

### Fund Manager Configuration

In `/etc/blockhost/blockhost.yaml` under the `fund_manager:` key:

| Setting | Default | Description |
|---|---|---|
| `fund_cycle_interval_hours` | 24 | Hours between fund cycles |
| `gas_check_interval_minutes` | 30 | Minutes between gas checks |
| `min_withdrawal_usd` | 50 | Minimum USD value to trigger withdrawal |
| `gas_low_threshold_usd` | 5 | Server ETH balance (in USD) that triggers a swap |
| `gas_swap_amount_usd` | 20 | USDC amount to swap for ETH |
| `server_stablecoin_buffer_usd` | 50 | Target stablecoin balance for server wallet |
| `hot_wallet_gas_eth` | 0.01 | Target ETH balance for hot wallet |

Revenue sharing is configured in `/etc/blockhost/revenue-share.json`:

```json
{
  "enabled": true,
  "total_percent": 1.0,
  "recipients": [
    { "role": "dev", "percent": 0.5 },
    { "role": "broker", "percent": 0.5 }
  ]
}
```

## is (identity predicate) CLI

Standalone binary for yes/no identity questions. Exit 0 = yes, 1 = no. No env vars or addressbook needed — config from `web3-defaults.yaml`.

```bash
is <wallet> <nft_id>         # Does wallet own NFT token?
is contract <address>        # Does a contract exist at address?
```

Arguments are order-independent, disambiguated by type (address = `0x` + 40 hex, NFT ID = integer, `contract` = keyword). Signature verification is handled by `bw who <message> <signature>`.

## bw (blockwallet) CLI

Standalone CLI for scriptable wallet operations. Uses the same `RPC_URL` and `BLOCKHOST_CONTRACT` env vars as the monitor.

```bash
bw send <amount> <token> <from> <to>       # Send tokens between wallets
bw balance <role> [token]                   # Show wallet balances
bw split <amount> <token> <ratios> <from> <to1> <to2> ...  # Split tokens
bw withdraw [token] <to>                    # Withdraw from contract
bw swap <amount> <from-token> eth <wallet>  # Swap token for ETH via Uniswap V2
bw who <identifier>                        # Query NFT owner by token ID or 'admin'
bw who <message> <signature>               # Recover signer address from signature
bw config stable [address]                 # Get/set primary stablecoin
bw plan create <name> <price>              # Create subscription plan
bw set encrypt <nft_id> <data>             # Update NFT encrypted data
```

- **Token shortcuts**: `eth` (native), `stable` (contract's primary stablecoin), or `0x` address
- **Roles**: `admin`, `server`, `hot`, `dev`, `broker` (resolved from addressbook.json)
- **Signing**: Only roles with `keyfile` in addressbook can be used as `<from>`/`<wallet>`
- **`bw who`**: Queries NFT ownership or recovers signer address. Config from `web3-defaults.yaml` — no env vars or addressbook needed.
- **`bw config stable`**: No arg reads current primary stablecoin; with arg sets it (owner-only).
- **`bw plan create`**: Creates a subscription plan, prints the plan ID.
- **`bw set encrypt`**: Updates the `userEncrypted` field on an NFT. NFT contract from `web3-defaults.yaml`.

The fund-manager module imports `executeSend()`, `executeWithdraw()`, and `executeSwap()` from the bw command modules directly — all wallet operations flow through the same code paths.

## ab (addressbook) CLI

Standalone CLI for managing wallet entries in `/etc/blockhost/addressbook.json`. No RPC or contract env vars required — purely local filesystem operations.

```bash
ab add <name> <0xaddress>    # Add new entry
ab del <name>                # Delete entry
ab up <name> <0xaddress>     # Update entry's address
ab new <name>                # Generate new wallet, save key, add to addressbook
ab list                      # Show all entries
ab --init <admin> <server> [dev] [broker] <keyfile>  # Bootstrap addressbook
```

- **Immutable roles**: `server`, `admin`, `hot`, `dev`, `broker` — cannot be added, deleted, updated, or generated via `ab`
- **`ab new`**: Generates a keypair, saves private key to `/etc/blockhost/<name>.key` (chmod 600), same pattern as hot wallet generation
- **`ab up`**: Only changes the address; preserves existing `keyfile` if present
- **`ab del`**: Removes the entry from JSON but does NOT delete the keyfile (if any)
- **`ab --init`**: Bootstrap addressbook with admin, server, and optionally dev/broker addresses. Keyfile (last arg) marks the end of input. Only works on an empty addressbook (fresh install safety).

## Engine Manifest (`engine.json`)

Declares engine identity, wizard plugin module, finalization steps, and chain-specific `constraints` used by consumers (installer, admin panel) for input validation and UI rendering.

### `constraints`

| Field | Description | EVM value |
|-------|-------------|-----------|
| `address_pattern` | Regex for valid addresses | `^0x[0-9a-fA-F]{40}$` |
| `signature_pattern` | Regex for valid signatures | `^0x[0-9a-fA-F]{130}$` |
| `native_token` | Native currency keyword for CLIs | `eth` |
| `native_token_label` | Display label for native currency | `ETH` |
| `token_pattern` | Regex for valid token addresses | `^0x[0-9a-fA-F]{40}$` |
| `address_placeholder` | Placeholder for address inputs | `0x...` |

All patterns are anchored regexes. If `constraints` is absent, consumers skip format validation and let CLIs reject invalid input.

## Auth Service (web3-auth-svc)

The engine ships an HTTPS signing server as a standalone binary for VMs. It is compiled from TypeScript to a self-contained executable using `bun build --compile` — no Node.js runtime needed on VMs.

### How It Works

The auth-svc serves the signing page and handles callback-based signature submission:

- `GET /` — Serves the signing page HTML
- `GET /auth/pending/:session_id` — Returns session JSON from `/run/libpam-web3/pending/`
- `POST /auth/callback/:session_id` — Validates signature, writes `.sig` file atomically

### Signature Formats

Content-based detection (same as PAM module):
- **EVM**: optional `0x` prefix + 130 hex chars (secp256k1)
- **OPNet**: JSON with `otp`, `machine_id`, `wallet_address` fields

### Template Package

The auth-svc ships as `blockhost-auth-svc_<version>_amd64.deb`, installed on VM templates (not the host):

| File | Purpose |
|------|---------|
| `/usr/bin/web3-auth-svc` | Standalone binary |
| `/usr/share/blockhost/signing-page/index.html` | Signing page HTML |
| `/lib/systemd/system/web3-auth-svc.service` | Systemd unit |
| `/usr/lib/tmpfiles.d/web3-auth-svc.conf` | Creates `/run/libpam-web3/pending/` on boot |

### Config

Reads `/etc/web3-auth/config.toml` (written by cloud-init template on VMs):

```toml
[https]
port = 8443
bind = ["::"]
cert_path = "/etc/libpam-web3/tls/cert.pem"
key_path = "/etc/libpam-web3/tls/key.pem"
signing_page_path = "/usr/share/blockhost/signing-page/index.html"
```

## Privilege Separation

The monitor service runs as the unprivileged `blockhost` user. Operations that require root (iptables, writing key files to `/etc/blockhost/`, saving addressbook) are delegated to a separate **root agent daemon** (provided by `blockhost-common`) via a Unix socket at `/run/blockhost/root-agent.sock`.

The TypeScript client (`src/root-agent/client.ts`) communicates using length-prefixed JSON (4-byte big-endian length + JSON payload). Available actions:

| Action | Description |
|--------|-------------|
| `iptables-open` | Add an ACCEPT rule for a port |
| `iptables-close` | Remove an ACCEPT rule for a port |
| `generate-wallet` | Generate a keypair, save key to `/etc/blockhost/<name>.key`, update addressbook |
| `addressbook-save` | Write addressbook entries to `/etc/blockhost/addressbook.json` |
| `qm-start` | Start a Proxmox VM by VMID |

The systemd service (`examples/blockhost-monitor.service`) declares a dependency on `blockhost-root-agent.service` and runs with `NoNewPrivileges=true` and `ProtectSystem=strict`.

## Development

```bash
# Compile contracts
npm run compile

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Start local Hardhat node
npm run node

# Deploy to local node
npm run deploy:local
```

## Project Structure

```
blockhost-engine/
├── contracts/                 # Solidity smart contracts
│   ├── BlockhostSubscriptions.sol
│   └── mocks/                 # Test mocks
├── scripts/                   # Deployment & utility scripts
│   ├── deploy.ts              # Contract deployment (Hardhat, development)
│   ├── deploy-contracts.sh    # Contract deployment (production, no Hardhat)
│   ├── init-server.sh         # Server initialization
│   ├── generate-signup-page.py
│   └── signup-template.html
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
│   ├── bw/                    # blockwallet CLI (send, balance, withdraw, swap, split, who, config, plan, set)
│   ├── ab/                    # addressbook CLI (add, del, up, new, list, --init)
│   ├── is/                    # identity predicate CLI (NFT ownership, signature, contract)
│   ├── auth-svc/              # Web3 auth signing server (bun-compiled binary)
│   └── root-agent/            # Root agent client (privilege separation)
├── auth-svc/                  # Auth service assets
│   └── signing-page/          # Signing page HTML (served by auth-svc)
├── test/                      # Contract tests
├── examples/                  # Deployment examples
│   ├── blockhost-monitor.service
│   ├── blockhost-admin.yaml.example
│   ├── admin-commands.json.example
│   └── env.example
└── PROJECT.yaml               # Machine-readable spec
```

## License

MIT

## Related Packages

- `blockhost-common` - Shared configuration and Python modules
- `blockhost-provisioner-proxmox` - VM provisioning scripts (Proxmox/Terraform)
- `libpam-web3-tools` - NFT contract, signing page, and CLI tools
- `libpam-web3` - PAM module for web3 authentication (installed on VMs)
