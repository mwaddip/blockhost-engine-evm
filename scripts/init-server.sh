#!/bin/bash
# Blockhost Server Initialization Script
# Generates server keypair, deployer keypair, and creates initial configuration
#
# Usage: sudo ./scripts/init-server.sh [options]
#
# Prerequisites:
#   - blockhost-common package (provides /etc/blockhost, /var/lib/blockhost)
#   - blockhost-engine-evm package (provides nft_tool)
#   - foundry (provides cast for wallet address derivation)

set -euo pipefail

# Configuration directories (provided by blockhost-common)
CONFIG_DIR="/etc/blockhost"
DATA_DIR="/var/lib/blockhost"
# Files owned by blockhost-engine-evm
SERVER_KEY_FILE="${CONFIG_DIR}/server.key"
DEPLOYER_KEY_FILE="${CONFIG_DIR}/deployer.key"
CONFIG_FILE="${CONFIG_DIR}/blockhost.yaml"

# Files owned by blockhost-common (read-only reference)
WEB3_CONFIG_FILE="${CONFIG_DIR}/web3-defaults.yaml"
DB_CONFIG_FILE="${CONFIG_DIR}/db.yaml"

# Defaults (can be overridden via arguments)
PUBLIC_SECRET="blockhost-access"
DEPLOYER_KEY=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --public-secret)
            PUBLIC_SECRET="$2"
            shift 2
            ;;
        --deployer-key)
            DEPLOYER_KEY="$2"
            shift 2
            ;;
        --deployer-key-file)
            DEPLOYER_KEY=$(cat "$2")
            shift 2
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --public-secret MSG     Static message users sign to derive encryption key"
            echo "                          Default: \"blockhost-access\""
            echo "  --deployer-key KEY      Existing deployer private key (hex, with or without 0x)"
            echo "  --deployer-key-file F   Read deployer private key from file"
            echo ""
            echo "Note: Blockchain settings (chain_id, rpc_url) are configured in"
            echo "      ${WEB3_CONFIG_FILE} (provided by blockhost-common)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Check root
if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root"
    exit 1
fi

# Check blockhost-common is installed
if [[ ! -d "${CONFIG_DIR}" ]]; then
    echo "Error: ${CONFIG_DIR} not found. Install blockhost-common first:"
    echo "  sudo dpkg -i blockhost-common_*.deb"
    exit 1
fi

if [[ ! -d "${DATA_DIR}" ]]; then
    echo "Error: ${DATA_DIR} not found. Install blockhost-common first:"
    echo "  sudo dpkg -i blockhost-common_*.deb"
    exit 1
fi

# Check nft_tool is available
if ! command -v nft_tool &> /dev/null; then
    echo "Error: nft_tool not found. Install blockhost-engine-evm package."
    exit 1
fi

# Check cast (foundry) is available for address derivation
if ! command -v cast &> /dev/null; then
    echo "Error: cast not found. Install foundry: curl -L https://foundry.paradigm.xyz | bash"
    exit 1
fi

echo "========================================"
echo "  Blockhost Server Initialization"
echo "========================================"
echo ""

# Check if already initialized
if [[ -f "${SERVER_KEY_FILE}" ]]; then
    echo ""
    echo "WARNING: Server keypair already exists at ${SERVER_KEY_FILE}"
    read -p "Regenerate keypair? This will invalidate existing encrypted data. [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing keypair."

        # Still show the public key
        SERVER_PRIVATE_KEY=$(cat "${SERVER_KEY_FILE}")
        SERVER_PUBLIC_KEY=$(nft_tool derive-pubkey --private-key "${SERVER_PRIVATE_KEY}" | grep -oP '(?<=hex\): ).*')

        # Show deployer address if it exists
        if [[ -f "${DEPLOYER_KEY_FILE}" ]]; then
            DEPLOYER_PRIVATE_KEY=$(cat "${DEPLOYER_KEY_FILE}")
            DEPLOYER_ADDRESS=$(cast wallet address --private-key "0x${DEPLOYER_PRIVATE_KEY}")
        fi

        echo ""
        echo "========================================"
        echo "  Existing Configuration"
        echo "========================================"
        echo ""
        echo "Server public key:"
        echo "${SERVER_PUBLIC_KEY}"
        if [[ -n "${DEPLOYER_ADDRESS:-}" ]]; then
            echo ""
            echo "Deployer wallet address:"
            echo "${DEPLOYER_ADDRESS}"
        fi
        echo ""
        exit 0
    fi
fi

# Generate server keypair
echo "Generating server secp256k1 keypair..."
SERVER_PRIVATE_KEY=$(nft_tool generate-keypair | grep -oP '(?<=hex\): ).*')

# Save server private key (restricted permissions)
echo "${SERVER_PRIVATE_KEY}" > "${SERVER_KEY_FILE}"
chmod 600 "${SERVER_KEY_FILE}"
echo "Server private key saved to: ${SERVER_KEY_FILE}"

# Derive server public key
SERVER_PUBLIC_KEY=$(nft_tool derive-pubkey --private-key "${SERVER_PRIVATE_KEY}" | grep -oP '(?<=hex\): ).*')

# Generate or use provided deployer keypair
if [[ -n "${DEPLOYER_KEY}" ]]; then
    echo "Using provided deployer key..."
    # Strip 0x prefix if present
    DEPLOYER_PRIVATE_KEY="${DEPLOYER_KEY#0x}"
else
    echo "Generating deployer keypair..."
    DEPLOYER_PRIVATE_KEY=$(nft_tool generate-keypair | grep -oP '(?<=hex\): ).*')
fi

# Save deployer private key (restricted permissions)
echo "${DEPLOYER_PRIVATE_KEY}" > "${DEPLOYER_KEY_FILE}"
chmod 600 "${DEPLOYER_KEY_FILE}"
echo "Deployer private key saved to: ${DEPLOYER_KEY_FILE}"

# Derive deployer address using cast
DEPLOYER_ADDRESS=$(cast wallet address --private-key "0x${DEPLOYER_PRIVATE_KEY}")

# Create/update main config file
echo "Creating configuration..."
cat > "${CONFIG_FILE}" << EOF
# Blockhost Server Configuration
# Generated by init-server.sh on $(date -Iseconds)

# Static message users sign to derive their encryption key
# This must match what the signup page displays
public_secret: "${PUBLIC_SECRET}"

# Server public key (for reference - signup page needs this)
# Private key is stored in: ${SERVER_KEY_FILE}
server_public_key: "${SERVER_PUBLIC_KEY}"

# Deployer wallet address (fund this with ETH for gas)
# Private key is stored in: ${DEPLOYER_KEY_FILE}
deployer_address: "${DEPLOYER_ADDRESS}"

# Contract address (set after deployment)
# Run: blockhost-deploy --network sepolia
# Or set manually if using existing contract
contract_address: ""
EOF

chmod 644 "${CONFIG_FILE}"
echo "Configuration saved to: ${CONFIG_FILE}"

# Note: web3-defaults.yaml is provided by blockhost-common
# It already has sensible defaults; update nft_contract after deployment

# Initialize empty VM database if it doesn't exist
DB_FILE="${DATA_DIR}/vms.json"
if [[ ! -f "${DB_FILE}" ]]; then
    echo "Initializing VM database..."
    cat > "${DB_FILE}" << EOF
{
  "vms": {},
  "next_vmid": 100,
  "reserved_nft_tokens": {},
  "allocated_ips": []
}
EOF
    chmod 644 "${DB_FILE}"
    echo "VM database created: ${DB_FILE}"
fi

echo ""
echo "========================================"
echo "  Initialization Complete"
echo "========================================"
echo ""
echo "Server Public Key (for signup page encryption):"
echo "${SERVER_PUBLIC_KEY}"
echo ""
echo "Deployer Wallet Address:"
echo "${DEPLOYER_ADDRESS}"
echo ""
echo "Public Secret:"
echo "${PUBLIC_SECRET}"
echo ""
echo "Files created:"
echo "  - ${SERVER_KEY_FILE} (chmod 600)"
echo "  - ${DEPLOYER_KEY_FILE} (chmod 600)"
echo "  - ${CONFIG_FILE}"
echo "  - ${DB_FILE}"
echo ""
echo "========================================"
echo "  Next Steps"
echo "========================================"
echo ""
echo "1. Fund the deployer wallet with ETH for gas:"
echo "   ${DEPLOYER_ADDRESS}"
echo ""
echo "2. Deploy the contract:"
echo "   blockhost-deploy --network sepolia"
echo ""
echo "3. Update the NFT contract address in ${WEB3_CONFIG_FILE}:"
echo "   (set blockchain.nft_contract to the deployed address)"
echo ""
echo "4. Generate the signup page:"
echo "   blockhost-generate-signup --output /var/www/html/signup.html"
echo ""
echo "5. Start the monitor service:"
echo "   systemctl enable --now blockhost-monitor"
echo ""
