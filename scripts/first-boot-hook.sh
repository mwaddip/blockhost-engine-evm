#!/bin/bash
#
# EVM Engine first-boot hook
#
# Called by first-boot.sh after the engine package is installed.
# Installs engine-specific host dependencies (Foundry toolchain).
#

set -e

# Inherited from first-boot.sh
STATE_DIR="${STATE_DIR:-/var/lib/blockhost}"
LOG_FILE="${LOG_FILE:-/var/log/blockhost-firstboot.log}"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [engine-hook] $1"
    echo "$msg" >> "$LOG_FILE"
    echo "$msg"
}

#
# Install Foundry (forge, cast, anvil, chisel)
#
if command -v cast &>/dev/null; then
    log "Foundry already installed: $(cast --version 2>/dev/null || echo 'unknown')"
    exit 0
fi

log "Installing Foundry..."

FOUNDRY_DIR="/usr/local/lib/foundry"
mkdir -p "$FOUNDRY_DIR"

# Get latest release from GitHub
FOUNDRY_VERSION=$(curl -s https://api.github.com/repos/foundry-rs/foundry/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$FOUNDRY_VERSION" ]; then
    FOUNDRY_VERSION="nightly"
fi
log "Installing Foundry version: $FOUNDRY_VERSION"

FOUNDRY_URL="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"
log "Downloading from: $FOUNDRY_URL"

if curl -L "$FOUNDRY_URL" -o /tmp/foundry.tar.gz 2>&1; then
    tar -xzf /tmp/foundry.tar.gz -C "$FOUNDRY_DIR"
    rm /tmp/foundry.tar.gz

    for tool in forge cast anvil chisel; do
        if [ -f "$FOUNDRY_DIR/$tool" ]; then
            chmod +x "$FOUNDRY_DIR/$tool"
            ln -sf "$FOUNDRY_DIR/$tool" "/usr/local/bin/$tool"
            log "Installed: $tool"
        fi
    done

    log "Foundry installed successfully"
else
    log "ERROR: Failed to download Foundry"
    exit 1
fi
