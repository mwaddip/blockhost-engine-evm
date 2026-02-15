#!/bin/bash
# blockhost-deploy-contracts — deploy NFT and/or subscription contracts
#
# Usage:
#   blockhost-deploy-contracts          # deploy both (NFT first, then subscription)
#   blockhost-deploy-contracts nft      # deploy NFT contract only
#   blockhost-deploy-contracts pos      # deploy subscription contract only
#
# Reads deployer key from /etc/blockhost/deployer.key
# Reads RPC URL from web3-defaults.yaml
#
# stdout: contract address(es), one per line
# Exit: 0 = success, 1 = failure

set -e

WEB3_DEFAULTS="/etc/blockhost/web3-defaults.yaml"
DEPLOYER_KEY_FILE="/etc/blockhost/deployer.key"

# Pre-compiled artifact paths
NFT_ABI_PATH="/usr/share/blockhost/contracts/AccessCredentialNFT.json"
SUB_ARTIFACT_PATH="/usr/share/blockhost/contracts/BlockhostSubscriptions.json"

# NFT contract source (for forge fallback)
NFT_SOURCE_PATH="/usr/share/blockhost/contracts/AccessCredentialNFT.sol"

# Subscription contract source (for forge fallback)
SUB_SOURCE_PATH="/opt/blockhost/contracts/BlockhostSubscriptions.sol"

MODE="${1:-both}"

# Validate mode
case "$MODE" in
    both|nft|pos) ;;
    *)
        echo "Usage: blockhost-deploy-contracts [nft|pos]" >&2
        echo "  nft   Deploy NFT contract only" >&2
        echo "  pos   Deploy subscription contract only" >&2
        echo "  (no arg) Deploy both" >&2
        exit 1
        ;;
esac

# Read deployer key
if [ ! -f "$DEPLOYER_KEY_FILE" ]; then
    echo "Error: deployer key not found: $DEPLOYER_KEY_FILE" >&2
    exit 1
fi
DEPLOYER_KEY=$(cat "$DEPLOYER_KEY_FILE" | tr -d '[:space:]')
# Strip 0x prefix if present
DEPLOYER_KEY="${DEPLOYER_KEY#0x}"

if [ -z "$DEPLOYER_KEY" ]; then
    echo "Error: deployer key file is empty" >&2
    exit 1
fi

# Read RPC URL from web3-defaults.yaml
if [ ! -f "$WEB3_DEFAULTS" ]; then
    echo "Error: config not found: $WEB3_DEFAULTS" >&2
    exit 1
fi

RPC_URL=$(python3 -c "
import yaml, sys
with open('$WEB3_DEFAULTS') as f:
    c = yaml.safe_load(f)
rpc = c.get('blockchain', {}).get('rpc_url', '')
if not rpc:
    print('Error: blockchain.rpc_url not set in web3-defaults.yaml', file=sys.stderr)
    sys.exit(1)
print(rpc)
") || exit 1

if [ -z "$RPC_URL" ]; then
    echo "Error: could not read RPC URL from config" >&2
    exit 1
fi

# Temporary directory for forge builds
TMPDIR=""
cleanup() {
    if [ -n "$TMPDIR" ] && [ -d "$TMPDIR" ]; then
        rm -rf "$TMPDIR"
    fi
}
trap cleanup EXIT

# Deploy NFT contract
# Returns contract address on stdout
deploy_nft() {
    local nft_name="BlockhostAccess"
    local nft_symbol="BHA"
    local default_image_uri=""

    if [ -f "$NFT_ABI_PATH" ]; then
        # Use pre-compiled bytecode
        local bytecode
        bytecode=$(python3 -c "
import json, sys
with open('$NFT_ABI_PATH') as f:
    data = json.load(f)
bc = data.get('bytecode', {})
if isinstance(bc, dict):
    bc = bc.get('object', '')
if not bc:
    print('Error: no bytecode in ABI JSON', file=sys.stderr)
    sys.exit(1)
print(bc)
") || { echo "Error: failed to extract NFT bytecode" >&2; return 1; }

        # Encode constructor args: (string, string, string)
        local encoded_args
        encoded_args=$(cast abi-encode "constructor(string,string,string)" \
            "$nft_name" "$nft_symbol" "$default_image_uri") || {
            echo "Error: failed to encode NFT constructor args" >&2
            return 1
        }

        # Deploy via cast
        local deploy_data="${bytecode}${encoded_args#0x}"
        local result
        result=$(cast send \
            --private-key "$DEPLOYER_KEY" \
            --rpc-url "$RPC_URL" \
            --json \
            --create "$deploy_data" 2>&1) || {
            echo "Error: NFT deployment transaction failed: $result" >&2
            return 1
        }

        local addr
        addr=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['contractAddress'])" 2>/dev/null)
        if [ -z "$addr" ]; then
            echo "Error: could not parse NFT contract address from: $result" >&2
            return 1
        fi
        echo "$addr"
    elif command -v forge &>/dev/null && [ -f "$NFT_SOURCE_PATH" ]; then
        # Fallback: compile with forge
        TMPDIR=$(mktemp -d)
        mkdir -p "$TMPDIR/src"
        cp "$NFT_SOURCE_PATH" "$TMPDIR/src/"

        cat > "$TMPDIR/foundry.toml" << 'TOML'
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
TOML

        (cd "$TMPDIR" && forge install OpenZeppelin/openzeppelin-contracts --no-commit 2>/dev/null) || {
            echo "Error: could not install OpenZeppelin contracts" >&2
            return 1
        }

        local result
        result=$(cd "$TMPDIR" && forge create \
            "src/AccessCredentialNFT.sol:AccessCredentialNFT" \
            --constructor-args "$nft_name" "$nft_symbol" "$default_image_uri" \
            --private-key "$DEPLOYER_KEY" \
            --rpc-url "$RPC_URL" \
            --json 2>&1) || {
            echo "Error: forge create failed for NFT: $result" >&2
            return 1
        }

        local addr
        addr=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['deployedTo'])" 2>/dev/null)
        if [ -z "$addr" ]; then
            echo "Error: could not parse NFT contract address" >&2
            return 1
        fi
        echo "$addr"
    else
        echo "Error: neither pre-compiled NFT ABI nor forge available" >&2
        return 1
    fi
}

# Deploy subscription contract
# Returns contract address on stdout
deploy_subscription() {
    if [ -f "$SUB_ARTIFACT_PATH" ]; then
        # Use pre-compiled bytecode from artifact
        local bytecode
        bytecode=$(python3 -c "
import json, sys
with open('$SUB_ARTIFACT_PATH') as f:
    data = json.load(f)
bc = data.get('bytecode', {})
if isinstance(bc, dict):
    bc = bc.get('object', '')
if not bc:
    print('Error: no bytecode in artifact', file=sys.stderr)
    sys.exit(1)
print(bc)
") || { echo "Error: failed to extract subscription bytecode" >&2; return 1; }

        # No constructor args for BlockhostSubscriptions
        local result
        result=$(cast send \
            --private-key "$DEPLOYER_KEY" \
            --rpc-url "$RPC_URL" \
            --json \
            --create "$bytecode" 2>&1) || {
            echo "Error: subscription deployment transaction failed: $result" >&2
            return 1
        }

        local addr
        addr=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['contractAddress'])" 2>/dev/null)
        if [ -z "$addr" ]; then
            echo "Error: could not parse subscription contract address from: $result" >&2
            return 1
        fi
        echo "$addr"
    elif command -v forge &>/dev/null && [ -f "$SUB_SOURCE_PATH" ]; then
        # Fallback: compile with forge
        TMPDIR=$(mktemp -d)
        mkdir -p "$TMPDIR/src"
        cp "$SUB_SOURCE_PATH" "$TMPDIR/src/"

        cat > "$TMPDIR/foundry.toml" << 'TOML'
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.20"
optimizer = true
optimizer_runs = 200
TOML

        (cd "$TMPDIR" && forge install OpenZeppelin/openzeppelin-contracts --no-commit 2>/dev/null) || {
            echo "Error: could not install OpenZeppelin contracts" >&2
            return 1
        }
        echo "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/" > "$TMPDIR/remappings.txt"

        local result
        result=$(cd "$TMPDIR" && forge create \
            "src/BlockhostSubscriptions.sol:BlockhostSubscriptions" \
            --private-key "$DEPLOYER_KEY" \
            --rpc-url "$RPC_URL" \
            --json 2>&1) || {
            echo "Error: forge create failed for subscription: $result" >&2
            return 1
        }

        local addr
        addr=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)['deployedTo'])" 2>/dev/null)
        if [ -z "$addr" ]; then
            echo "Error: could not parse subscription contract address" >&2
            return 1
        fi
        echo "$addr"
    else
        echo "Error: neither pre-compiled artifact nor forge available" >&2
        return 1
    fi
}

# Main dispatch
case "$MODE" in
    nft)
        deploy_nft
        ;;
    pos)
        deploy_subscription
        ;;
    both)
        # NFT first, then subscription
        nft_addr=$(deploy_nft) || exit 1
        sub_addr=$(deploy_subscription) || exit 1
        echo "$nft_addr"
        echo "$sub_addr"
        ;;
esac
