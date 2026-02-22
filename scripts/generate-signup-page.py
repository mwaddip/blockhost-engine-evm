#!/usr/bin/env python3
"""
Generate a static, self-contained signup page for Blockhost.

This script creates a standalone HTML file that:
- Connects to user's wallet (MetaMask, etc.)
- Prompts user to sign the decrypt message
- Encrypts the signature with the server's public key using ECIES
- Submits the buySubscription transaction

Usage:
    python3 generate-signup-page.py [--output signup.html]
    python3 generate-signup-page.py --config /etc/blockhost/blockhost.yaml --output /var/www/signup.html
    python3 generate-signup-page.py --serve 8080  # Serve on IPv4/IPv6 port 8080
"""

import argparse
import http.server
import os
import socket
import socketserver
import sys
import yaml
from pathlib import Path

# Default paths
DEFAULT_CONFIG = "/etc/blockhost/blockhost.yaml"
DEFAULT_WEB3_CONFIG = "/etc/blockhost/web3-defaults.yaml"
DEFAULT_OUTPUT = "signup.html"

# Template location - check multiple locations
SCRIPT_DIR = Path(__file__).parent
TEMPLATE_LOCATIONS = [
    SCRIPT_DIR / "signup-template.html",  # Development
    Path("/usr/share/blockhost/signup-template.html"),  # Installed
]


def find_template() -> Path:
    """Find the template file in known locations."""
    for path in TEMPLATE_LOCATIONS:
        if path.exists():
            return path
    return TEMPLATE_LOCATIONS[0]  # Return first for error message


def load_config(config_path: str, web3_config_path: str) -> dict:
    """Load configuration from YAML files."""
    config = {}

    # Load main blockhost config
    if os.path.exists(config_path):
        with open(config_path) as f:
            config.update(yaml.safe_load(f) or {})
    else:
        print(f"Warning: Config file not found: {config_path}")

    # Load web3 config
    if os.path.exists(web3_config_path):
        with open(web3_config_path) as f:
            web3_config = yaml.safe_load(f) or {}
            config.update(web3_config)
    else:
        print(f"Warning: Web3 config file not found: {web3_config_path}")

    return config


def generate_page(config: dict, template: str) -> str:
    """Generate the signup page by replacing placeholders."""

    # Required config values
    server_public_key = config.get('server_public_key', '')
    public_secret = config.get('public_secret', 'blockhost-access')

    # Web3 config (may be nested under 'blockchain')
    blockchain = config.get('blockchain', {})
    chain_id = blockchain.get('chain_id', config.get('chain_id', 11155111))
    rpc_url = blockchain.get('rpc_url', config.get('rpc_url', 'https://ethereum-sepolia-rpc.publicnode.com'))
    nft_contract = blockchain.get('nft_contract', config.get('nft_contract', ''))
    subscription_contract = blockchain.get('subscription_contract', config.get('subscription_contract', ''))
    usdc_address = blockchain.get('usdc_address', config.get('usdc_address', ''))

    # Theming (future expansion)
    page_title = config.get('page_title', 'Blockhost - Get Your Server')
    primary_color = config.get('primary_color', '#6366f1')

    if not server_public_key:
        print("Error: server_public_key not found in config. Run blockhost-init first.")
        sys.exit(1)

    # Replace placeholders
    replacements = {
        '{{SERVER_PUBLIC_KEY}}': server_public_key,
        '{{PUBLIC_SECRET}}': public_secret,
        '{{CHAIN_ID}}': str(chain_id),
        '{{RPC_URL}}': rpc_url,
        '{{NFT_CONTRACT}}': nft_contract,
        '{{SUBSCRIPTION_CONTRACT}}': subscription_contract,
        '{{USDC_ADDRESS}}': usdc_address,
        '{{PAGE_TITLE}}': page_title,
        '{{PRIMARY_COLOR}}': primary_color,
    }

    result = template
    for placeholder, value in replacements.items():
        result = result.replace(placeholder, value)

    return result


class DualStackHTTPServer(socketserver.TCPServer):
    """HTTP server that listens on both IPv4 and IPv6."""
    allow_reuse_address = True

    def __init__(self, server_address, RequestHandlerClass):
        # Try IPv6 first (dual-stack), fall back to IPv4
        try:
            self.address_family = socket.AF_INET6
            # Enable dual-stack (IPv4 + IPv6) on Linux
            super().__init__(server_address, RequestHandlerClass)
            # Set IPV6_V6ONLY to False for dual-stack
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (OSError, socket.error):
            # Fall back to IPv4 only
            self.address_family = socket.AF_INET
            super().__init__(server_address, RequestHandlerClass)


def serve_page(output_path: Path, port: int):
    """Serve the generated page on IPv4 and IPv6."""
    directory = output_path.parent
    filename = output_path.name

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(directory), **kwargs)

        def do_GET(self):
            # Serve the generated file at root
            if self.path == '/' or self.path == f'/{filename}':
                self.path = f'/{filename}'
            super().do_GET()

    try:
        # Try dual-stack (IPv6 + IPv4)
        server = DualStackHTTPServer(('::', port), Handler)
        print(f"Serving on:")
        print(f"  http://localhost:{port}/")
        print(f"  http://[::1]:{port}/")
        print(f"  (and all network interfaces)")
    except Exception as e:
        print(f"Warning: Could not bind to IPv6, falling back to IPv4: {e}")
        server = http.server.HTTPServer(('0.0.0.0', port), Handler)
        print(f"Serving on http://0.0.0.0:{port}/")

    print(f"\nServing: {output_path}")
    print("Press Ctrl+C to stop\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


def main():
    parser = argparse.ArgumentParser(description='Generate Blockhost signup page')
    parser.add_argument('--config', default=DEFAULT_CONFIG,
                        help=f'Path to blockhost.yaml (default: {DEFAULT_CONFIG})')
    parser.add_argument('--web3-config', default=DEFAULT_WEB3_CONFIG,
                        help=f'Path to web3-defaults.yaml (default: {DEFAULT_WEB3_CONFIG})')
    parser.add_argument('--output', '-o', default=DEFAULT_OUTPUT,
                        help=f'Output HTML file (default: {DEFAULT_OUTPUT})')
    parser.add_argument('--template',
                        help=f'Template HTML file (default: auto-detect)')
    parser.add_argument('--serve', type=int, metavar='PORT',
                        help='Start HTTP server on PORT after generating (IPv4+IPv6)')
    args = parser.parse_args()

    # Find template
    template_path = Path(args.template) if args.template else find_template()
    if not template_path.exists():
        print(f"Error: Template file not found: {template_path}")
        print("Searched in:")
        for loc in TEMPLATE_LOCATIONS:
            print(f"  - {loc}")
        sys.exit(1)

    with open(template_path) as f:
        template = f.read()

    # Load config
    config = load_config(args.config, args.web3_config)

    # Generate page
    html = generate_page(config, template)

    # Write output
    output_path = Path(args.output).resolve()
    with open(output_path, 'w') as f:
        f.write(html)

    blockchain = config.get('blockchain', {})
    print(f"Generated: {output_path}")
    print(f"  Server public key: {config.get('server_public_key', 'NOT SET')[:20]}...")
    print(f"  Public secret: {config.get('public_secret', 'NOT SET')}")
    print(f"  Chain ID: {blockchain.get('chain_id', config.get('chain_id', 'NOT SET'))}")
    print(f"  Subscription contract: {blockchain.get('subscription_contract', 'NOT SET')}")

    # Start server if requested
    if args.serve:
        print()
        serve_page(output_path, args.serve)


if __name__ == '__main__':
    main()
