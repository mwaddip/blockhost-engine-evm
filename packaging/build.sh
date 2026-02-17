#!/bin/bash
# Build blockhost-engine .deb package
set -e

VERSION="0.1.0"
PKG_NAME="blockhost-engine_${VERSION}_all"
TEMPLATE_PKG_NAME="blockhost-auth-svc_${VERSION}_amd64"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PKG_DIR="$SCRIPT_DIR/$PKG_NAME"
TEMPLATE_PKG_DIR="$SCRIPT_DIR/$TEMPLATE_PKG_NAME"

echo "Building blockhost-engine v${VERSION}..."

# Clean up build artifacts on exit (success or failure)
cleanup() {
  rm -rf "$PKG_DIR"
  rm -rf "$TEMPLATE_PKG_DIR"
  rm -rf "$SCRIPT_DIR/.forge-build"
  rm -f "$SCRIPT_DIR/web3-auth-svc"
}
trap cleanup EXIT

# Clean and recreate package directory
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR"/{DEBIAN,usr/bin,usr/share/blockhost/contracts,opt/blockhost/scripts,opt/blockhost/contracts/mocks,lib/systemd/system}

# ============================================
# Bundle monitor with esbuild
# ============================================
echo ""
echo "Bundling monitor with esbuild..."

# Install dependencies first (needed for bundling)
(cd "$PROJECT_DIR" && npm install --silent)

# Bundle the monitor into a single JS file
npx esbuild "$PROJECT_DIR/src/monitor/index.ts" \
    --bundle \
    --platform=node \
    --target=node18 \
    --minify \
    --outfile="$PKG_DIR/usr/share/blockhost/monitor.js"

# Verify the bundle was created
if [ ! -f "$PKG_DIR/usr/share/blockhost/monitor.js" ]; then
    echo "ERROR: Failed to create monitor bundle"
    exit 1
fi

MONITOR_SIZE=$(du -h "$PKG_DIR/usr/share/blockhost/monitor.js" | cut -f1)
echo "Monitor bundle created: $MONITOR_SIZE"

# Bundle the bw CLI into a single JS file
echo "Bundling bw CLI with esbuild..."
npx esbuild "$PROJECT_DIR/src/bw/index.ts" \
    --bundle \
    --platform=node \
    --target=node18 \
    --minify \
    --outfile="$PKG_DIR/usr/share/blockhost/bw.js"

if [ ! -f "$PKG_DIR/usr/share/blockhost/bw.js" ]; then
    echo "ERROR: Failed to create bw CLI bundle"
    exit 1
fi

BW_SIZE=$(du -h "$PKG_DIR/usr/share/blockhost/bw.js" | cut -f1)
echo "bw CLI bundle created: $BW_SIZE"

# Create bw wrapper script
cat > "$PKG_DIR/usr/bin/bw" << 'BWEOF'
#!/bin/sh
export NODE_OPTIONS="--dns-result-order=ipv4first${NODE_OPTIONS:+ $NODE_OPTIONS}"
exec /usr/bin/node /usr/share/blockhost/bw.js "$@"
BWEOF
chmod 755 "$PKG_DIR/usr/bin/bw"

# Bundle the ab CLI into a single JS file
echo "Bundling ab CLI with esbuild..."
npx esbuild "$PROJECT_DIR/src/ab/index.ts" \
    --bundle \
    --platform=node \
    --target=node18 \
    --minify \
    --outfile="$PKG_DIR/usr/share/blockhost/ab.js"

if [ ! -f "$PKG_DIR/usr/share/blockhost/ab.js" ]; then
    echo "ERROR: Failed to create ab CLI bundle"
    exit 1
fi

AB_SIZE=$(du -h "$PKG_DIR/usr/share/blockhost/ab.js" | cut -f1)
echo "ab CLI bundle created: $AB_SIZE"

# Create ab wrapper script
cat > "$PKG_DIR/usr/bin/ab" << 'ABEOF'
#!/bin/sh
export NODE_OPTIONS="--dns-result-order=ipv4first${NODE_OPTIONS:+ $NODE_OPTIONS}"
exec /usr/bin/node /usr/share/blockhost/ab.js "$@"
ABEOF
chmod 755 "$PKG_DIR/usr/bin/ab"

# Bundle the is CLI into a single JS file
echo "Bundling is CLI with esbuild..."
npx esbuild "$PROJECT_DIR/src/is/index.ts" \
    --bundle \
    --platform=node \
    --target=node18 \
    --minify \
    --outfile="$PKG_DIR/usr/share/blockhost/is.js"

if [ ! -f "$PKG_DIR/usr/share/blockhost/is.js" ]; then
    echo "ERROR: Failed to create is CLI bundle"
    exit 1
fi

IS_SIZE=$(du -h "$PKG_DIR/usr/share/blockhost/is.js" | cut -f1)
echo "is CLI bundle created: $IS_SIZE"

# Create is wrapper script
cat > "$PKG_DIR/usr/bin/is" << 'ISEOF'
#!/bin/sh
export NODE_OPTIONS="--dns-result-order=ipv4first${NODE_OPTIONS:+ $NODE_OPTIONS}"
exec /usr/bin/node /usr/share/blockhost/is.js "$@"
ISEOF
chmod 755 "$PKG_DIR/usr/bin/is"

# ============================================
# Compile auth-svc standalone binary with bun
# ============================================
echo ""
echo "Compiling auth-svc with bun..."

AUTH_SVC_BINARY="$SCRIPT_DIR/web3-auth-svc"

if command -v bun &> /dev/null; then
    echo "Found bun: $(bun --version)"
    bun build --compile "$PROJECT_DIR/src/auth-svc/index.ts" --outfile "$AUTH_SVC_BINARY"

    if [ ! -f "$AUTH_SVC_BINARY" ]; then
        echo "ERROR: Failed to compile auth-svc binary"
        exit 1
    fi

    AUTH_SVC_SIZE=$(du -h "$AUTH_SVC_BINARY" | cut -f1)
    echo "auth-svc binary compiled: $AUTH_SVC_SIZE"
else
    echo "WARNING: bun not found. Template package (blockhost-auth-svc) will not be built."
    echo "         Install bun: curl -fsSL https://bun.sh/install | bash"
fi

# ============================================
# Compile Solidity contracts with Foundry
# ============================================
echo ""
echo "Compiling Solidity contracts..."

FORGE_BUILD_DIR="$SCRIPT_DIR/.forge-build"
COMPILED_ARTIFACT=""

if command -v forge &> /dev/null; then
    echo "Found forge: $(forge --version | head -1)"

    # Create temporary forge project
    rm -rf "$FORGE_BUILD_DIR"
    mkdir -p "$FORGE_BUILD_DIR/src"

    # Copy contract source
    cp "$PROJECT_DIR/contracts/BlockhostSubscriptions.sol" "$FORGE_BUILD_DIR/src/"

    # Create foundry.toml
    cat > "$FORGE_BUILD_DIR/foundry.toml" << 'TOML'
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.20"
optimizer = true
optimizer_runs = 200
TOML

    # Install OpenZeppelin contracts dependency
    echo "Installing OpenZeppelin contracts..."
    (cd "$FORGE_BUILD_DIR" && forge install OpenZeppelin/openzeppelin-contracts --no-commit 2>/dev/null) || {
        echo "Warning: Could not install OpenZeppelin via forge, trying alternative..."
        mkdir -p "$FORGE_BUILD_DIR/lib"
        git clone --depth 1 https://github.com/OpenZeppelin/openzeppelin-contracts "$FORGE_BUILD_DIR/lib/openzeppelin-contracts" 2>/dev/null || {
            echo "Error: Could not install OpenZeppelin contracts"
            exit 1
        }
    }

    # Create remappings
    echo "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/" > "$FORGE_BUILD_DIR/remappings.txt"

    # Compile
    echo "Running forge build..."
    (cd "$FORGE_BUILD_DIR" && forge build) || {
        echo "Error: forge build failed"
        exit 1
    }

    # Check for compiled artifact
    COMPILED_ARTIFACT="$FORGE_BUILD_DIR/out/BlockhostSubscriptions.sol/BlockhostSubscriptions.json"
    if [ -f "$COMPILED_ARTIFACT" ]; then
        echo "Contract compiled successfully: $COMPILED_ARTIFACT"
        cp "$COMPILED_ARTIFACT" "$PKG_DIR/usr/share/blockhost/contracts/"
        echo "Copied compiled artifact to package"
    else
        echo "Warning: Compiled artifact not found at expected path"
        ls -la "$FORGE_BUILD_DIR/out/" 2>/dev/null || true
    fi

else
    echo "WARNING: forge not found. Contract will not be pre-compiled."
    echo "         Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
    echo "         The contract source will still be included for manual compilation."
fi

# ============================================
# Create DEBIAN control files
# ============================================
echo ""
echo "Creating DEBIAN control files..."

# Create DEBIAN/control
cat > "$PKG_DIR/DEBIAN/control" << EOF
Package: blockhost-engine
Version: ${VERSION}
Section: admin
Priority: optional
Architecture: all
Depends: blockhost-common (>= 0.1.0), libpam-web3-tools (>= 0.5.0), nodejs (>= 18), python3 (>= 3.10)
Recommends: blockhost-provisioner-proxmox (>= 0.1.0) | blockhost-provisioner-libvirt (>= 0.1.0)
Maintainer: Blockhost <admin@blockhost.io>
Description: Blockchain-based VM hosting subscription engine
 Blockhost Engine provides the core subscription management system:
 - Smart contract deployment (BlockhostSubscriptions + AccessCredentialNFT)
 - Blockchain event monitor service (bundled JS, runs on Node.js)
 - Event handlers for VM provisioning
 - NFT minting CLI (blockhost-mint-nft)
 - Server initialization and signup page generation
 .
 The monitor is a single bundled JavaScript file that runs on Node.js.
EOF

# Create DEBIAN/postinst
cat > "$PKG_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e

case "$1" in
    configure)
        if [ -d /run/systemd/system ]; then
            systemctl daemon-reload || true
        fi

        echo ""
        echo "=========================================="
        echo "  blockhost-engine installed successfully"
        echo "=========================================="
        echo ""
        echo "Next steps:"
        echo "1. Run: sudo blockhost-init"
        echo "2. Fund the deployer wallet with ETH"
        echo "3. Deploy contracts:"
        echo "   cd /opt/blockhost && npm install && npx hardhat run scripts/deploy.ts --network sepolia"
        echo "4. Run: sudo systemctl enable --now blockhost-monitor"
        echo ""
        ;;
esac
exit 0
EOF

# Create DEBIAN/prerm
cat > "$PKG_DIR/DEBIAN/prerm" << 'EOF'
#!/bin/bash
set -e
case "$1" in
    remove|upgrade|deconfigure)
        if [ -d /run/systemd/system ]; then
            systemctl stop blockhost-monitor 2>/dev/null || true
            systemctl disable blockhost-monitor 2>/dev/null || true
        fi
        ;;
esac
exit 0
EOF

# Create DEBIAN/postrm
cat > "$PKG_DIR/DEBIAN/postrm" << 'EOF'
#!/bin/bash
set -e
case "$1" in
    purge)
        rm -rf /opt/blockhost/node_modules 2>/dev/null || true
        rm -f /opt/blockhost/.env 2>/dev/null || true
        ;;
esac
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
fi
exit 0
EOF

chmod 755 "$PKG_DIR/DEBIAN/postinst" "$PKG_DIR/DEBIAN/prerm" "$PKG_DIR/DEBIAN/postrm"

# ============================================
# Copy application files
# ============================================
echo "Copying files..."

# Bin scripts (init, signup generator, and deploy)
cp "$PROJECT_DIR/scripts/init-server.sh" "$PKG_DIR/usr/bin/blockhost-init"
cp "$PROJECT_DIR/scripts/generate-signup-page.py" "$PKG_DIR/usr/bin/blockhost-generate-signup"
cp "$PROJECT_DIR/scripts/deploy-contracts.sh" "$PKG_DIR/usr/bin/blockhost-deploy-contracts"
chmod 755 "$PKG_DIR/usr/bin/"*

# Install mint_nft as importable Python module (used by wizard finalization)
mkdir -p "$PKG_DIR/usr/lib/python3/dist-packages/blockhost"
cp "$PROJECT_DIR/scripts/mint_nft.py" "$PKG_DIR/usr/lib/python3/dist-packages/blockhost/mint_nft.py"

# Install engine wizard plugin (Python module + templates)
WIZARD_SRC="$PROJECT_DIR/blockhost/engine_evm"
WIZARD_DST="$PKG_DIR/usr/lib/python3/dist-packages/blockhost/engine_evm"
mkdir -p "$WIZARD_DST/templates/engine_evm"
cp "$WIZARD_SRC/__init__.py" "$WIZARD_DST/"
cp "$WIZARD_SRC/wizard.py" "$WIZARD_DST/"
cp "$WIZARD_SRC/templates/engine_evm/"*.html "$WIZARD_DST/templates/engine_evm/"

# Install engine manifest
cp "$PROJECT_DIR/engine.json" "$PKG_DIR/usr/share/blockhost/engine.json"

# Create blockhost-mint-nft CLI wrapper (used by engine's TypeScript handlers)
cat > "$PKG_DIR/usr/bin/blockhost-mint-nft" << 'MINTEOF'
#!/bin/sh
exec python3 /usr/lib/python3/dist-packages/blockhost/mint_nft.py "$@"
MINTEOF
chmod 755 "$PKG_DIR/usr/bin/blockhost-mint-nft"

# Deployment scripts (need Hardhat/Node.js for one-time deployment)
cp "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$PKG_DIR/opt/blockhost/"
cp "$PROJECT_DIR/tsconfig.json" "$PROJECT_DIR/hardhat.config.ts" "$PKG_DIR/opt/blockhost/"
cp "$PROJECT_DIR/scripts/deploy.ts" "$PROJECT_DIR/scripts/create-plan.ts" "$PKG_DIR/opt/blockhost/scripts/"

# Contract sources (for deployment/reference)
cp "$PROJECT_DIR/contracts/BlockhostSubscriptions.sol" "$PKG_DIR/opt/blockhost/contracts/"
cp "$PROJECT_DIR/contracts/mocks/"*.sol "$PKG_DIR/opt/blockhost/contracts/mocks/"

# Static resources
cp "$PROJECT_DIR/scripts/signup-template.html" "$PKG_DIR/usr/share/blockhost/"

# Systemd service
cp "$PROJECT_DIR/examples/blockhost-monitor.service" "$PKG_DIR/lib/systemd/system/blockhost-monitor.service"

# Example env
cat > "$PKG_DIR/opt/blockhost/.env.example" << 'ENVEOF'
# Blockhost Monitor Configuration
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
BLOCKHOST_CONTRACT=0xYourContractAddressHere
ENVEOF

# ============================================
# Build package
# ============================================
echo ""
echo "Building package..."
dpkg-deb --build "$PKG_DIR"

echo ""
echo "=========================================="
echo "Package built: $SCRIPT_DIR/${PKG_NAME}.deb"
echo "=========================================="
dpkg-deb --info "$SCRIPT_DIR/${PKG_NAME}.deb"

# Show what's included
echo ""
echo "Package contents:"
echo "  /usr/share/blockhost/monitor.js - Bundled monitor ($MONITOR_SIZE)"
echo "  /usr/share/blockhost/bw.js      - Bundled bw CLI ($BW_SIZE)"
echo "  /usr/share/blockhost/ab.js      - Bundled ab CLI ($AB_SIZE)"
echo "  /usr/share/blockhost/is.js      - Bundled is CLI ($IS_SIZE)"
echo "  /usr/bin/bw                     - Blockwallet CLI wrapper"
echo "  /usr/bin/ab                     - Addressbook CLI wrapper"
echo "  /usr/bin/is                     - Identity predicate CLI wrapper"
echo "  /usr/bin/blockhost-deploy-contracts - Contract deployer script"
echo "  /usr/bin/blockhost-mint-nft      - NFT minting CLI wrapper"
echo "  /usr/lib/python3/dist-packages/blockhost/mint_nft.py - NFT minting module"
echo "  /usr/lib/python3/dist-packages/blockhost/engine_evm/ - Engine wizard plugin"
echo "  /usr/share/blockhost/engine.json - Engine manifest"
echo "  /usr/bin/blockhost-init         - Server initialization script"
echo "  /usr/bin/blockhost-generate-signup - Signup page generator"
echo "  /opt/blockhost/                 - Deployment scripts (require npm install)"
echo "  /usr/share/blockhost/contracts/ - Compiled contract artifacts"
echo "  /lib/systemd/system/            - Systemd service unit"

# Show contract compilation status
if [ -f "$PKG_DIR/usr/share/blockhost/contracts/BlockhostSubscriptions.json" ]; then
    echo ""
    echo "Compiled contract included:"
    echo "  /usr/share/blockhost/contracts/BlockhostSubscriptions.json"
else
    echo ""
    echo "WARNING: Compiled contract NOT included (forge not available)"
fi

# Copy to packages/host/ if the parent project structure exists
# (for integration with blockhost-installer/scripts/build-packages.sh)
PACKAGES_HOST_DIR="$(dirname "$PROJECT_DIR")/blockhost-installer/packages/host"
if [ -d "$(dirname "$PACKAGES_HOST_DIR")" ]; then
    mkdir -p "$PACKAGES_HOST_DIR"
    cp "$SCRIPT_DIR/${PKG_NAME}.deb" "$PACKAGES_HOST_DIR/"
    echo ""
    echo "Copied to: $PACKAGES_HOST_DIR/${PKG_NAME}.deb"
fi

# ============================================
# Build template package: blockhost-auth-svc
# (installed on VMs, not the host)
# ============================================
if [ -f "$AUTH_SVC_BINARY" ]; then
    echo ""
    echo "=========================================="
    echo "Building template package: blockhost-auth-svc v${VERSION}..."
    echo "=========================================="

    rm -rf "$TEMPLATE_PKG_DIR"
    mkdir -p "$TEMPLATE_PKG_DIR"/{DEBIAN,usr/bin,usr/share/blockhost/signing-page,lib/systemd/system,usr/lib/tmpfiles.d}

    # Copy compiled binary
    cp "$AUTH_SVC_BINARY" "$TEMPLATE_PKG_DIR/usr/bin/web3-auth-svc"
    chmod 755 "$TEMPLATE_PKG_DIR/usr/bin/web3-auth-svc"

    # Copy signing page HTML
    cp "$PROJECT_DIR/auth-svc/signing-page/index.html" "$TEMPLATE_PKG_DIR/usr/share/blockhost/signing-page/index.html"

    # Create systemd unit
    cat > "$TEMPLATE_PKG_DIR/lib/systemd/system/web3-auth-svc.service" << 'SVCEOF'
[Unit]
Description=Web3 Authentication Signing Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/web3-auth-svc
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

    # Create tmpfiles.d config (creates pending dir on boot)
    cat > "$TEMPLATE_PKG_DIR/usr/lib/tmpfiles.d/web3-auth-svc.conf" << 'TMPEOF'
d /run/libpam-web3/pending 0755 root root -
TMPEOF

    # Create DEBIAN/control
    cat > "$TEMPLATE_PKG_DIR/DEBIAN/control" << EOF
Package: blockhost-auth-svc
Version: ${VERSION}
Section: admin
Priority: optional
Architecture: amd64
Depends:
Maintainer: Blockhost <admin@blockhost.io>
Description: Web3 authentication signing server for Blockhost VMs
 Standalone HTTPS server that serves the web3 signing page and handles
 callback-based signature submission for PAM authentication.
 .
 This package is installed on VM templates, not the Proxmox host.
 No runtime dependencies — compiled to a standalone binary.
EOF

    # Create DEBIAN/postinst
    cat > "$TEMPLATE_PKG_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e
case "$1" in
    configure)
        # Create pending directory (also handled by tmpfiles.d on boot)
        mkdir -p /run/libpam-web3/pending
        chmod 0755 /run/libpam-web3/pending

        if [ -d /run/systemd/system ]; then
            systemctl daemon-reload || true
            systemd-tmpfiles --create web3-auth-svc.conf 2>/dev/null || true
        fi
        ;;
esac
exit 0
EOF

    # Create DEBIAN/prerm
    cat > "$TEMPLATE_PKG_DIR/DEBIAN/prerm" << 'EOF'
#!/bin/bash
set -e
case "$1" in
    remove|upgrade|deconfigure)
        if [ -d /run/systemd/system ]; then
            systemctl stop web3-auth-svc 2>/dev/null || true
            systemctl disable web3-auth-svc 2>/dev/null || true
        fi
        ;;
esac
exit 0
EOF

    chmod 755 "$TEMPLATE_PKG_DIR/DEBIAN/postinst" "$TEMPLATE_PKG_DIR/DEBIAN/prerm"

    # Build template .deb
    dpkg-deb --build "$TEMPLATE_PKG_DIR"

    echo ""
    echo "=========================================="
    echo "Template package built: $SCRIPT_DIR/${TEMPLATE_PKG_NAME}.deb"
    echo "=========================================="
    echo ""
    echo "Template package contents:"
    echo "  /usr/bin/web3-auth-svc                            - Auth server binary ($AUTH_SVC_SIZE)"
    echo "  /usr/share/blockhost/signing-page/index.html      - Signing page HTML"
    echo "  /lib/systemd/system/web3-auth-svc.service         - Systemd unit"
    echo "  /usr/lib/tmpfiles.d/web3-auth-svc.conf            - tmpfiles.d config"
else
    echo ""
    echo "Skipping template package build (bun not available)"
fi
