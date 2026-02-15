"""
EVM engine wizard plugin for BlockHost installer.

Provides:
- Flask Blueprint with /wizard/evm route and blockchain API routes
- Pre-provisioner finalization steps: keypair, wallet, contracts, chain_config
- Post-nginx finalization steps: mint_nft, plan, revenue_share
- Summary data and template for the summary page
"""

import grp
import json
import os
import re
import secrets
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from flask import (
    Blueprint,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

blueprint = Blueprint(
    "engine_evm",
    __name__,
    template_folder="templates",
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CHAIN_NAMES = {
    "11155111": "Sepolia Testnet",
    "1": "Ethereum Mainnet",
    "137": "Polygon",
    "42161": "Arbitrum One",
}

USDC_BY_CHAIN = {
    11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",  # Sepolia
    1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  # Mainnet
    137: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",  # Polygon
    42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",  # Arbitrum
}

CONFIG_DIR = Path("/etc/blockhost")
CONTRACTS_DIR = Path("/usr/share/blockhost/contracts")

# Async deploy jobs (module-level, shared across requests)
_deploy_jobs = {}


# ---------------------------------------------------------------------------
# Address validation
# ---------------------------------------------------------------------------


def validate_address(address: str) -> bool:
    """Validate an EVM address (0x + 40 hex chars)."""
    if not address or not isinstance(address, str):
        return False
    address = address.strip()
    if not address.startswith("0x") or len(address) != 42:
        return False
    try:
        int(address, 16)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Wizard Route
# ---------------------------------------------------------------------------


@blueprint.route("/wizard/evm", methods=["GET", "POST"])
def wizard_evm():
    """EVM blockchain configuration step."""
    if request.method == "POST":
        chain_id = request.form.get("chain_id", "11155111").strip()
        if chain_id == "custom":
            chain_id = request.form.get("custom_chain_id", "").strip()

        session["blockchain"] = {
            "chain_id": chain_id,
            "rpc_url": request.form.get("rpc_url", "").strip(),
            "wallet_mode": request.form.get("wallet_mode", "generate"),
            "deployer_key": request.form.get("deployer_key", "").strip(),
            "deployer_address": request.form.get("deployer_address", "").strip(),
            "contract_mode": request.form.get("contract_mode", "deploy"),
            "nft_contract": request.form.get("nft_contract", "").strip(),
            "subscription_contract": request.form.get(
                "subscription_contract", ""
            ).strip(),
            "plan_name": request.form.get("plan_name", "Basic VM").strip(),
            "plan_price_cents": int(request.form.get("plan_price_cents", 50)),
            "revenue_share_enabled": request.form.get("revenue_share_enabled") == "on",
            "revenue_share_percent": float(
                request.form.get("revenue_share_percent", 1.0)
            ),
            "revenue_share_dev": request.form.get("revenue_share_dev") == "on",
            "revenue_share_broker": request.form.get("revenue_share_broker") == "on",
        }

        # Navigate to next wizard step
        try:
            nav = current_app.jinja_env.globals.get("wizard_nav")
            if nav:
                next_info = nav("evm")
                if next_info and next_info.get("next"):
                    return redirect(url_for(next_info["next"]))
        except Exception:
            pass
        return redirect(url_for("wizard_ipv6"))

    return render_template(
        "engine_evm/blockchain.html",
        chain_names=CHAIN_NAMES,
        blockchain=session.get("blockchain", {}),
    )


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------


@blueprint.route("/api/blockchain/generate-wallet", methods=["POST"])
def api_generate_wallet():
    """Generate a new secp256k1 keypair."""
    try:
        result = subprocess.run(
            ["cast", "wallet", "new"],
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            return jsonify({"error": f"Key generation failed: {result.stderr}"}), 500

        # Parse output: "Private key: 0x...\nAddress: 0x..."
        private_key = ""
        address = ""
        for line in result.stdout.strip().split("\n"):
            lower = line.lower()
            if "private" in lower and "0x" in line:
                private_key = line[line.index("0x") :].strip()
            elif "address" in lower and "0x" in line:
                address = line[line.index("0x") :].strip()

        if not private_key or not address:
            # Fallback: try parsing as bare hex lines
            lines = [l.strip() for l in result.stdout.strip().split("\n") if l.strip()]
            if len(lines) >= 2:
                private_key = lines[0] if lines[0].startswith("0x") else f"0x{lines[0]}"
                address = lines[1] if lines[1].startswith("0x") else f"0x{lines[1]}"

        if not private_key or not address:
            return jsonify({"error": "Could not parse keypair output"}), 500

        return jsonify({"private_key": private_key, "address": address})
    except FileNotFoundError:
        return jsonify({"error": "cast not found — is Foundry installed?"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Key generation timed out"}), 500


@blueprint.route("/api/blockchain/validate-key", methods=["POST"])
def api_validate_key():
    """Validate a private key and return its address."""
    data = request.get_json()
    private_key = (data or {}).get("private_key", "").strip()

    if not private_key:
        return jsonify({"error": "Private key required"}), 400

    # Normalize: ensure 0x prefix
    if not private_key.startswith("0x"):
        private_key = f"0x{private_key}"

    # Basic format check: 0x + 64 hex chars
    if len(private_key) != 66:
        return jsonify({"error": "Invalid key length (expected 64 hex chars)"}), 400
    try:
        int(private_key, 16)
    except ValueError:
        return jsonify({"error": "Invalid hex in private key"}), 400

    try:
        result = subprocess.run(
            ["cast", "wallet", "address", "--private-key", private_key],
            capture_output=True,
            text=True,
            timeout=10,
        )

        if result.returncode == 0 and result.stdout.strip():
            address = result.stdout.strip()
            return jsonify({"address": address, "private_key": private_key})
        else:
            return (
                jsonify({"error": result.stderr.strip() or "Invalid private key"}),
                400,
            )
    except FileNotFoundError:
        # Fallback: try pam_web3_tool
        try:
            result = subprocess.run(
                ["pam_web3_tool", "key-to-address", "--key", private_key],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip():
                address = result.stdout.strip()
                if "0x" in address:
                    address = address[address.index("0x") :]
                return jsonify({"address": address, "private_key": private_key})
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        return jsonify({"error": "cast not installed (cannot derive address)"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Address derivation timed out"}), 500


@blueprint.route("/api/blockchain/balance")
def api_balance():
    """Check wallet balance via JSON-RPC."""
    address = request.args.get("address", "").strip()
    rpc_url = request.args.get("rpc_url", "").strip()

    if not address or not rpc_url:
        return jsonify({"error": "address and rpc_url required"}), 400

    if not validate_address(address):
        return jsonify({"error": "Invalid address"}), 400

    import urllib.request
    import urllib.error

    try:
        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "method": "eth_getBalance",
                "params": [address, "latest"],
                "id": 1,
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            rpc_url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "BlockHost-Installer/1.0",
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))

        if "error" in data:
            return jsonify({"error": data["error"].get("message", "RPC error")}), 400

        balance_wei = int(data.get("result", "0x0"), 16)
        balance_eth = balance_wei / 1e18

        return jsonify(
            {
                "balance_wei": str(balance_wei),
                "balance_eth": f"{balance_eth:.6f}",
                "has_funds": balance_wei > 0,
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@blueprint.route("/api/blockchain/deploy", methods=["POST"])
def api_deploy():
    """Start async contract deployment."""
    data = request.get_json() or {}
    deployer_key = data.get("deployer_key", "").strip()
    rpc_url = data.get("rpc_url", "").strip()
    chain_id = data.get("chain_id", "").strip()

    if not deployer_key or not rpc_url:
        return jsonify({"error": "deployer_key and rpc_url required"}), 400

    job_id = f"deploy-{secrets.token_hex(4)}"
    _deploy_jobs[job_id] = {
        "status": "running",
        "message": "Starting contract deployment...",
        "nft_contract": None,
        "subscription_contract": None,
    }

    thread = threading.Thread(
        target=_run_deploy,
        args=(job_id, deployer_key, rpc_url, chain_id),
    )
    thread.start()

    return jsonify({"job_id": job_id})


@blueprint.route("/api/blockchain/deploy-status/<job_id>")
def api_deploy_status(job_id):
    """Poll deployment status."""
    job = _deploy_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


@blueprint.route("/api/blockchain/set-contracts", methods=["POST"])
def api_set_contracts():
    """Store existing contract addresses in session."""
    data = request.get_json() or {}
    nft = data.get("nft_contract", "").strip()
    sub = data.get("subscription_contract", "").strip()

    if nft and not validate_address(nft):
        return jsonify({"error": "Invalid NFT contract address"}), 400
    if sub and not validate_address(sub):
        return jsonify({"error": "Invalid subscription contract address"}), 400

    blockchain = session.get("blockchain", {})
    if nft:
        blockchain["nft_contract"] = nft
    if sub:
        blockchain["subscription_contract"] = sub
    session["blockchain"] = blockchain

    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# Deploy helper (runs in background thread)
# ---------------------------------------------------------------------------


def _run_deploy(job_id: str, deployer_key: str, rpc_url: str, chain_id: str):
    """Deploy NFT and subscription contracts in background."""
    job = _deploy_jobs[job_id]

    try:
        # Write temporary deployer key for the deploy script
        tmp_key = Path("/tmp/blockhost-deploy-key")
        key_hex = deployer_key.replace("0x", "")
        tmp_key.write_text(key_hex)
        tmp_key.chmod(0o600)

        try:
            # Try blockhost-deploy-contracts CLI first
            deploy_script = Path("/usr/bin/blockhost-deploy-contracts")
            if deploy_script.exists():
                job["message"] = "Deploying contracts via blockhost-deploy-contracts..."

                # The script reads from /etc/blockhost/deployer.key and web3-defaults.yaml,
                # but we haven't written those yet. Write a minimal web3-defaults.yaml
                # for the deploy script.
                CONFIG_DIR.mkdir(parents=True, exist_ok=True)
                tmp_deployer = CONFIG_DIR / "deployer.key"
                tmp_deployer.write_text(key_hex)
                tmp_deployer.chmod(0o600)

                _write_minimal_web3_defaults(rpc_url, chain_id)

                result = subprocess.run(
                    [str(deploy_script)],
                    capture_output=True,
                    text=True,
                    timeout=300,
                )

                if result.returncode == 0:
                    addresses = [
                        l.strip()
                        for l in result.stdout.strip().split("\n")
                        if l.strip().startswith("0x")
                    ]
                    if len(addresses) >= 2:
                        job["nft_contract"] = addresses[0]
                        job["subscription_contract"] = addresses[1]
                        job["status"] = "completed"
                        job["message"] = "Contracts deployed successfully"
                        return
                    elif len(addresses) == 1:
                        job["nft_contract"] = addresses[0]
                        job["status"] = "completed"
                        job["message"] = "NFT contract deployed"
                        return

                # Fall through to cast fallback
                job["message"] = "Deploy script failed, trying cast fallback..."

            # Fallback: deploy with cast send --create
            _deploy_with_cast(job, key_hex, rpc_url)

        finally:
            tmp_key.unlink(missing_ok=True)

    except Exception as e:
        job["status"] = "failed"
        job["message"] = str(e)


def _deploy_with_cast(job: dict, deployer_key_hex: str, rpc_url: str):
    """Deploy contracts using cast send --create with pre-compiled artifacts."""
    # Look for compiled contract artifacts
    nft_artifact = CONTRACTS_DIR / "AccessCredentialNFT.json"
    sub_artifact = CONTRACTS_DIR / "BlockhostSubscriptions.json"

    if not sub_artifact.exists():
        job["status"] = "failed"
        job["message"] = (
            "Compiled contract artifacts not found. "
            "Install blockhost-engine package or compile contracts with forge."
        )
        return

    # Deploy NFT contract first
    job["message"] = "Deploying NFT contract..."
    nft_address = None
    if nft_artifact.exists():
        nft_address = _cast_deploy(nft_artifact, deployer_key_hex, rpc_url)
        if not nft_address:
            job["status"] = "failed"
            job["message"] = "NFT contract deployment failed"
            return
        job["nft_contract"] = nft_address

    # Deploy subscription contract
    job["message"] = "Deploying subscription contract..."
    sub_address = _cast_deploy(sub_artifact, deployer_key_hex, rpc_url)
    if not sub_address:
        job["status"] = "failed"
        job["message"] = "Subscription contract deployment failed"
        return

    job["subscription_contract"] = sub_address
    job["status"] = "completed"
    job["message"] = "Contracts deployed successfully"


def _cast_deploy(
    artifact_path: Path, deployer_key_hex: str, rpc_url: str
) -> Optional[str]:
    """Deploy a single contract using cast send --create. Returns address or None."""
    try:
        artifact = json.loads(artifact_path.read_text())
        bytecode = artifact.get("bytecode", {}).get("object", "")
        if not bytecode:
            bytecode = artifact.get("bytecode", "")
        if isinstance(bytecode, dict):
            bytecode = bytecode.get("object", "")
        if not bytecode.startswith("0x"):
            bytecode = f"0x{bytecode}"

        result = subprocess.run(
            [
                "cast",
                "send",
                "--private-key",
                f"0x{deployer_key_hex}",
                "--rpc-url",
                rpc_url,
                "--create",
                bytecode,
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode == 0:
            tx_data = json.loads(result.stdout)
            return tx_data.get("contractAddress")
    except Exception:
        pass
    return None


def _write_minimal_web3_defaults(rpc_url: str, chain_id: str):
    """Write a minimal web3-defaults.yaml for deploy script."""
    from installer.web.utils import write_yaml

    web3_path = CONFIG_DIR / "web3-defaults.yaml"
    if not web3_path.exists():
        write_yaml(
            web3_path,
            {
                "blockchain": {
                    "chain_id": int(chain_id) if chain_id.isdigit() else chain_id,
                    "rpc_url": rpc_url,
                }
            },
        )


# ---------------------------------------------------------------------------
# Summary & UI
# ---------------------------------------------------------------------------


def get_ui_params(session_data: dict) -> dict:
    """Return EVM-specific UI parameters for wizard templates."""
    blockchain = session_data.get("blockchain", {})
    chain_id = blockchain.get("chain_id", "11155111")
    return {
        "chain_name": CHAIN_NAMES.get(chain_id, f"Chain {chain_id}"),
        "chain_id": chain_id,
    }


def get_summary_data(session_data: dict) -> dict:
    """Return blockchain summary data for the summary page."""
    blockchain = session_data.get("blockchain", {})
    chain_id = blockchain.get("chain_id", "11155111")
    return {
        "chain_name": CHAIN_NAMES.get(chain_id, f"Chain {chain_id}"),
        "chain_id": chain_id,
        "rpc_url": blockchain.get("rpc_url", ""),
        "deployer_address": blockchain.get("deployer_address", ""),
        "contract_mode": blockchain.get("contract_mode", "deploy"),
        "nft_contract": blockchain.get("nft_contract", ""),
        "subscription_contract": blockchain.get("subscription_contract", ""),
        "plan_name": blockchain.get("plan_name", "Basic VM"),
        "plan_price_cents": blockchain.get("plan_price_cents", 50),
        "revenue_share_enabled": blockchain.get("revenue_share_enabled", False),
    }


def get_summary_template() -> str:
    """Return the template name for the engine summary section."""
    return "engine_evm/summary_section.html"


def get_progress_steps_meta() -> list[dict]:
    """Return step metadata for the progress UI."""
    pre = [
        {"id": "wallet", "label": "Setting up deployer wallet"},
        {"id": "contracts", "label": "Deploying smart contracts"},
        {"id": "chain_config", "label": "Writing configuration files"},
    ]
    post = [
        {"id": "mint_nft", "label": "Minting admin credential NFT"},
        {"id": "plan", "label": "Creating subscription plan"},
        {"id": "revenue_share", "label": "Configuring revenue sharing"},
    ]
    return pre + post


# ---------------------------------------------------------------------------
# Finalization Steps (pre-provisioner)
# ---------------------------------------------------------------------------


def get_finalization_steps() -> list[tuple]:
    """Return pre-provisioner finalization steps.

    Each tuple: (step_id, display_name, callable[, hint])
    """
    return [
        ("wallet", "Setting up deployer wallet", finalize_wallet),
        (
            "contracts",
            "Deploying smart contracts",
            finalize_contracts,
            "(may take a minute)",
        ),
        ("chain_config", "Writing configuration files", finalize_chain_config),
    ]


def get_post_finalization_steps() -> list[tuple]:
    """Return post-nginx finalization steps.

    These run after provisioner, ipv6, https, signup, and nginx steps.
    """
    return [
        ("mint_nft", "Minting admin credential NFT", finalize_mint_nft),
        ("plan", "Creating subscription plan", finalize_plan),
        ("revenue_share", "Configuring revenue sharing", finalize_revenue_share),
    ]


# ---------------------------------------------------------------------------
# Helpers (private)
# ---------------------------------------------------------------------------


def _set_blockhost_ownership(path, mode=0o640):
    """Set file to root:blockhost with given mode."""
    try:
        from installer.web.utils import set_blockhost_ownership

        set_blockhost_ownership(path, mode)
    except ImportError:
        os.chmod(str(path), mode)
        try:
            gid = grp.getgrnam("blockhost").gr_gid
            os.chown(str(path), 0, gid)
        except KeyError:
            pass


def _write_yaml(path: Path, data: dict):
    """Write data to YAML file."""
    try:
        from installer.web.utils import write_yaml

        write_yaml(path, data)
    except ImportError:
        try:
            import yaml

            path.write_text(yaml.safe_dump(data, default_flow_style=False))
        except ImportError:
            # Minimal fallback
            lines = []
            _dict_to_yaml(data, lines, 0)
            path.write_text("\n".join(lines) + "\n")


def _dict_to_yaml(data: dict, lines: list, indent: int):
    """Simple dict to YAML converter."""
    prefix = "  " * indent
    for key, value in data.items():
        if isinstance(value, dict):
            lines.append(f"{prefix}{key}:")
            _dict_to_yaml(value, lines, indent + 1)
        elif isinstance(value, list):
            lines.append(f"{prefix}{key}:")
            for item in value:
                if isinstance(item, dict):
                    lines.append(f"{prefix}  -")
                    _dict_to_yaml(item, lines, indent + 2)
                else:
                    lines.append(f"{prefix}  - {item}")
        elif value is None:
            lines.append(f"{prefix}{key}: null")
        elif isinstance(value, bool):
            lines.append(f"{prefix}{key}: {str(value).lower()}")
        elif isinstance(value, (int, float)):
            lines.append(f"{prefix}{key}: {value}")
        else:
            lines.append(f'{prefix}{key}: "{value}"')


def _discover_bridge() -> str:
    """Read bridge name from first-boot marker or scan /sys/class/net."""
    bridge_file = Path("/run/blockhost/bridge")
    if bridge_file.exists():
        name = bridge_file.read_text().strip()
        if name:
            return name
    for p in Path("/sys/class/net").iterdir():
        if (p / "bridge").is_dir():
            return p.name
    return "br0"


def _derive_address_from_key(private_key: str) -> Optional[str]:
    """Derive Ethereum address from private key using available tools."""
    key_hex = private_key.replace("0x", "")

    # Try cast first
    try:
        result = subprocess.run(
            ["cast", "wallet", "address", "--private-key", f"0x{key_hex}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Try pam_web3_tool
    try:
        result = subprocess.run(
            ["pam_web3_tool", "key-to-address", "--key", f"0x{key_hex}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            output = result.stdout.strip()
            if "0x" in output:
                return output[output.index("0x") :].strip().split()[0]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return None


# ---------------------------------------------------------------------------
# Pre-finalization step functions
# ---------------------------------------------------------------------------


def finalize_wallet(config: dict) -> tuple[bool, Optional[str]]:
    """Write deployer private key to /etc/blockhost/deployer.key.

    Idempotent: skips write if file exists with matching content.
    """
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        blockchain = config.get("blockchain", {})
        deployer_key = blockchain.get("deployer_key", "")

        if not deployer_key:
            return False, "No deployer key in configuration"

        # Normalize: strip 0x prefix for storage
        key_hex = deployer_key.replace("0x", "")
        if len(key_hex) != 64:
            return False, f"Invalid deployer key length ({len(key_hex)}, expected 64)"

        key_file = CONFIG_DIR / "deployer.key"

        # Idempotent: skip if same key already written
        if key_file.exists() and key_file.read_text().strip() == key_hex:
            deployer_address = blockchain.get("deployer_address", "")
            if not deployer_address:
                deployer_address = _derive_address_from_key(key_hex) or ""
            config["_step_result_wallet"] = {"address": deployer_address}
            return True, None

        key_file.write_text(key_hex)
        _set_blockhost_ownership(key_file, 0o640)

        # Derive address for step result
        deployer_address = blockchain.get("deployer_address", "")
        if not deployer_address:
            deployer_address = _derive_address_from_key(key_hex) or ""

        config["_step_result_wallet"] = {"address": deployer_address}
        return True, None
    except Exception as e:
        return False, str(e)


def finalize_contracts(config: dict) -> tuple[bool, Optional[str]]:
    """Deploy or verify smart contracts.

    For contract_mode == 'deploy': use blockhost-deploy-contracts or cast fallback.
    For contract_mode == 'existing': verify contracts exist on-chain.

    Idempotent: skips deployment if contracts already recorded in config.
    """
    try:
        blockchain = config.get("blockchain", {})
        contract_mode = blockchain.get("contract_mode", "deploy")
        rpc_url = blockchain.get("rpc_url", "")

        if contract_mode == "existing":
            # Verify existing contracts
            nft = blockchain.get("nft_contract", "")
            sub = blockchain.get("subscription_contract", "")

            if not nft or not sub:
                return False, "Contract addresses required for existing mode"

            for label, addr in [("NFT", nft), ("Subscription", sub)]:
                ok = _verify_contract_exists(addr, rpc_url)
                if not ok:
                    return False, f"{label} contract not found at {addr}"

            config["_step_result_contracts"] = {
                "nft_contract": nft,
                "subscription_contract": sub,
            }
            return True, None

        # Deploy mode
        nft = blockchain.get("nft_contract", "")
        sub = blockchain.get("subscription_contract", "")
        if nft and sub:
            # Already deployed (idempotent)
            config["_step_result_contracts"] = {
                "nft_contract": nft,
                "subscription_contract": sub,
            }
            return True, None

        deployer_key = blockchain.get("deployer_key", "").replace("0x", "")
        key_file = CONFIG_DIR / "deployer.key"
        if not key_file.exists():
            if deployer_key:
                key_file.write_text(deployer_key)
                _set_blockhost_ownership(key_file, 0o640)
            else:
                return False, "Deployer key not available"

        chain_id = blockchain.get("chain_id", "")

        # Try blockhost-deploy-contracts CLI
        deploy_script = Path("/usr/bin/blockhost-deploy-contracts")
        if deploy_script.exists():
            # Ensure minimal web3-defaults.yaml exists for the deploy script
            _write_minimal_web3_defaults(rpc_url, chain_id)

            result = subprocess.run(
                [str(deploy_script)],
                capture_output=True,
                text=True,
                timeout=300,
            )

            if result.returncode == 0:
                addresses = [
                    l.strip()
                    for l in result.stdout.strip().split("\n")
                    if l.strip().startswith("0x")
                ]
                if len(addresses) >= 2:
                    blockchain["nft_contract"] = addresses[0]
                    blockchain["subscription_contract"] = addresses[1]
                    config["blockchain"] = blockchain
                    config["_step_result_contracts"] = {
                        "nft_contract": addresses[0],
                        "subscription_contract": addresses[1],
                    }
                    return True, None

        # Fallback: deploy with cast
        nft_artifact = CONTRACTS_DIR / "AccessCredentialNFT.json"
        sub_artifact = CONTRACTS_DIR / "BlockhostSubscriptions.json"

        if not sub_artifact.exists():
            return False, (
                "Contract artifacts not found at "
                f"{CONTRACTS_DIR}. Install blockhost-engine package."
            )

        if nft_artifact.exists():
            nft_addr = _cast_deploy(nft_artifact, deployer_key, rpc_url)
            if not nft_addr:
                return False, "NFT contract deployment failed"
            blockchain["nft_contract"] = nft_addr

        sub_addr = _cast_deploy(sub_artifact, deployer_key, rpc_url)
        if not sub_addr:
            return False, "Subscription contract deployment failed"
        blockchain["subscription_contract"] = sub_addr

        config["blockchain"] = blockchain
        config["_step_result_contracts"] = {
            "nft_contract": blockchain.get("nft_contract", ""),
            "subscription_contract": sub_addr,
        }
        return True, None
    except subprocess.TimeoutExpired:
        return False, "Contract deployment timed out"
    except Exception as e:
        return False, str(e)


def _verify_contract_exists(address: str, rpc_url: str) -> bool:
    """Check if a contract exists at the given address."""
    # Try `is contract` CLI first
    try:
        result = subprocess.run(
            ["is", "contract", address],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.returncode == 0
    except FileNotFoundError:
        pass

    # Fallback: eth_getCode via JSON-RPC
    import urllib.request

    try:
        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "method": "eth_getCode",
                "params": [address, "latest"],
                "id": 1,
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            rpc_url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
            code = data.get("result", "0x")
            return code not in ("0x", "0x0", "")
    except Exception:
        return False


def finalize_chain_config(config: dict) -> tuple[bool, Optional[str]]:
    """Write all blockchain configuration files.

    Files written:
    - db.yaml (bridge, ip_pool, ipv6_pool)
    - web3-defaults.yaml (chain, contracts, auth)
    - blockhost.yaml (server, deployer, provisioner, admin)
    - .env (RPC_URL, contracts, deployer key file)
    - admin-commands.json
    - admin-signature.key
    """
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        opt_dir = Path("/opt/blockhost")
        opt_dir.mkdir(parents=True, exist_ok=True)
        var_dir = Path("/var/lib/blockhost")
        var_dir.mkdir(parents=True, exist_ok=True)

        blockchain = config.get("blockchain", {})
        provisioner = config.get("provisioner", {})
        ipv6 = config.get("ipv6", {})
        chain_id = blockchain.get("chain_id", "11155111")
        rpc_url = blockchain.get("rpc_url", "")
        nft_contract = blockchain.get("nft_contract", "")
        sub_contract = blockchain.get("subscription_contract", "")
        admin_wallet = config.get("admin_wallet", "")

        # Derive deployer address
        deployer_key = blockchain.get("deployer_key", "").replace("0x", "")
        deployer_address = blockchain.get("deployer_address", "")
        if not deployer_address and deployer_key:
            deployer_address = _derive_address_from_key(deployer_key) or ""

        # Read server public key
        server_pubkey = ""
        pubkey_file = CONFIG_DIR / "server.pubkey"
        if pubkey_file.exists():
            server_pubkey = pubkey_file.read_text().strip()

        bridge = provisioner.get("bridge") or _discover_bridge()
        usdc_address = USDC_BY_CHAIN.get(
            int(chain_id) if chain_id.isdigit() else 0, ""
        )

        # --- web3-defaults.yaml ---
        chain_id_int = int(chain_id) if chain_id.isdigit() else chain_id
        web3_config = {
            "blockchain": {
                "chain_id": chain_id_int,
                "rpc_url": rpc_url,
                "nft_contract": nft_contract,
                "subscription_contract": sub_contract,
            },
            "deployer": {
                "private_key_file": "/etc/blockhost/deployer.key",
            },
        }
        if usdc_address:
            web3_config["blockchain"]["usdc_address"] = usdc_address
        if server_pubkey:
            web3_config["blockchain"]["server_public_key"] = server_pubkey
        web3_config["auth"] = {
            "signing_page": "blockhost-access",
        }

        web3_path = CONFIG_DIR / "web3-defaults.yaml"
        if web3_path.exists():
            import yaml

            existing = yaml.safe_load(web3_path.read_text()) or {}
            for section, values in web3_config.items():
                if isinstance(values, dict) and isinstance(
                    existing.get(section), dict
                ):
                    existing[section].update(values)
                else:
                    existing[section] = values
            web3_config = existing
        _write_yaml(web3_path, web3_config)
        _set_blockhost_ownership(web3_path, 0o640)

        # --- blockhost.yaml ---
        public_secret = config.get("admin_public_secret", "blockhost-access")
        bh_config = {
            "server": {
                "address": deployer_address,
                "key_file": "/etc/blockhost/deployer.key",
            },
            "server_public_key": server_pubkey,
            "public_secret": public_secret,
            "contract_address": sub_contract,
        }

        # Provisioner section
        if provisioner:
            bh_config["provisioner"] = {
                "node": provisioner.get("node", ""),
                "bridge": provisioner.get("bridge", bridge),
                "vmid_start": provisioner.get("vmid_start", 100),
                "vmid_end": provisioner.get("vmid_end", 999),
                "gc_grace_days": provisioner.get("gc_grace_days", 7),
            }

        # Admin section
        admin_commands = config.get("admin_commands", {})
        bh_config["admin"] = {
            "wallet_address": admin_wallet,
            "credential_nft_id": 0,
            "max_command_age": 300,
        }
        if admin_commands.get("enabled"):
            bh_config["admin"]["destination_mode"] = admin_commands.get(
                "destination_mode", "self"
            )

        bh_path = CONFIG_DIR / "blockhost.yaml"
        _write_yaml(bh_path, bh_config)
        _set_blockhost_ownership(bh_path, 0o640)

        # --- .env ---
        env_lines = [
            f"RPC_URL={rpc_url}",
            f"BLOCKHOST_CONTRACT={sub_contract}",
            f"NFT_CONTRACT={nft_contract}",
            f"DEPLOYER_KEY_FILE=/etc/blockhost/deployer.key",
        ]
        env_path = opt_dir / ".env"
        env_path.write_text("\n".join(env_lines) + "\n")
        _set_blockhost_ownership(env_path, 0o640)

        # --- admin-commands.json ---
        if admin_commands.get("enabled") and admin_commands.get("knock_command"):
            commands_db = {
                "commands": {
                    admin_commands["knock_command"]: {
                        "action": "knock",
                        "description": "Open configured ports temporarily",
                        "params": {
                            "allowed_ports": admin_commands.get("knock_ports", [22]),
                            "default_duration": admin_commands.get(
                                "knock_timeout", 300
                            ),
                        },
                    }
                }
            }
            cmd_path = CONFIG_DIR / "admin-commands.json"
            cmd_path.write_text(json.dumps(commands_db, indent=2) + "\n")
            _set_blockhost_ownership(cmd_path, 0o640)

        # --- admin-signature.key ---
        admin_signature = config.get("admin_signature", "")
        if admin_signature:
            sig_file = CONFIG_DIR / "admin-signature.key"
            sig_file.write_text(admin_signature)
            _set_blockhost_ownership(sig_file, 0o640)

        # --- Initialize vms.json if missing ---
        vms_path = var_dir / "vms.json"
        if not vms_path.exists():
            vms_path.write_text(
                json.dumps(
                    {
                        "vms": {},
                        "next_vmid": provisioner.get("vmid_start", 100),
                        "allocated_ips": [],
                        "allocated_ipv6": [],
                        "reserved_nft_tokens": {},
                    },
                    indent=2,
                )
            )

        config["_step_result_chain_config"] = {
            "message": "Configuration files written"
        }
        return True, None
    except Exception as e:
        return False, str(e)


# ---------------------------------------------------------------------------
# Post-finalization step functions
# ---------------------------------------------------------------------------


def finalize_mint_nft(config: dict) -> tuple[bool, Optional[str]]:
    """Mint admin credential NFT #0.

    For fresh deploys: mint via blockhost-mint-nft.
    For pre-deployed contracts: update userEncrypted if NFT already exists.
    """
    try:
        blockchain = config.get("blockchain", {})
        admin_wallet = config.get("admin_wallet", "")
        public_secret = config.get("admin_public_secret", "blockhost-access")
        admin_signature = config.get("admin_signature", "")
        nft_contract = blockchain.get("nft_contract", "")
        rpc_url = blockchain.get("rpc_url", "")

        if not admin_wallet:
            return False, "Admin wallet address not configured"

        # Build connection details JSON for the NFT
        https_cfg = config.get("https", {})
        if not https_cfg:
            https_file = CONFIG_DIR / "https.json"
            if https_file.exists():
                https_cfg = json.loads(https_file.read_text())
        server_addr = https_cfg.get("ipv6_address") or https_cfg.get("hostname", "")

        user_encrypted = "0x"
        if not server_addr:
            current_app.logger.warning(
                "No server address found in HTTPS config — "
                "NFT userEncrypted will be empty"
            )
        elif admin_signature:
            connection_details = json.dumps({
                "hostname": server_addr,
                "port": 22,
                "username": "admin",
            })
            try:
                encrypt_result = subprocess.run(
                    [
                        "pam_web3_tool",
                        "encrypt-symmetric",
                        "--signature",
                        admin_signature,
                        "--plaintext",
                        connection_details,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if encrypt_result.returncode == 0:
                    from installer.web.utils import parse_pam_ciphertext

                    ct = parse_pam_ciphertext(encrypt_result.stdout)
                    if ct:
                        user_encrypted = ct
            except (FileNotFoundError, ImportError):
                pass

        # Check if NFT #0 already exists (pre-deployed contracts)
        if blockchain.get("contract_mode") == "existing":
            # Try to check ownership
            nft_exists = False
            try:
                result = subprocess.run(
                    ["is", admin_wallet, "0"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                nft_exists = result.returncode == 0
            except FileNotFoundError:
                # Fallback: cast call ownerOf
                try:
                    result = subprocess.run(
                        [
                            "cast",
                            "call",
                            nft_contract,
                            "ownerOf(uint256)(address)",
                            "0",
                            "--rpc-url",
                            rpc_url,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=15,
                    )
                    nft_exists = result.returncode == 0
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    pass

            if nft_exists and user_encrypted != "0x":
                # Update userEncrypted on existing NFT
                deployer_key = (CONFIG_DIR / "deployer.key").read_text().strip()
                try:
                    subprocess.run(
                        [
                            "cast",
                            "send",
                            nft_contract,
                            "updateUserEncrypted(uint256,bytes)",
                            "0",
                            user_encrypted,
                            "--private-key",
                            f"0x{deployer_key}",
                            "--rpc-url",
                            rpc_url,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    pass

                config["_step_result_mint_nft"] = {
                    "token_id": 0,
                    "owner": admin_wallet,
                }
                return True, None

        # Mint NFT #0
        try:
            from blockhost.mint_nft import mint_nft as _mint_nft

            result = _mint_nft(
                owner_wallet=admin_wallet,
                machine_id="blockhost-admin",
                user_encrypted=user_encrypted,
                public_secret=public_secret,
            )

            if isinstance(result, dict):
                if result.get("success"):
                    config["_step_result_mint_nft"] = {
                        "token_id": 0,
                        "owner": admin_wallet,
                    }
                    return True, None
                else:
                    return False, result.get("error", "Minting failed")
            elif result:
                # Old-style: returns tx hash string
                config["_step_result_mint_nft"] = {
                    "token_id": 0,
                    "owner": admin_wallet,
                }
                return True, None
        except ImportError:
            pass

        # Fallback: CLI
        cmd = [
            "blockhost-mint-nft",
            "--owner-wallet",
            admin_wallet,
            "--machine-id",
            "blockhost-admin",
        ]
        if user_encrypted != "0x":
            cmd.extend(["--user-encrypted", user_encrypted])
        if public_secret:
            cmd.extend(["--public-secret", public_secret])

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode != 0:
            return False, f"NFT minting failed: {result.stderr or result.stdout}"

        config["_step_result_mint_nft"] = {
            "token_id": 0,
            "owner": admin_wallet,
        }
        return True, None
    except subprocess.TimeoutExpired:
        return False, "NFT minting timed out"
    except Exception as e:
        return False, str(e)


def finalize_plan(config: dict) -> tuple[bool, Optional[str]]:
    """Create default subscription plan and set primary stablecoin."""
    try:
        blockchain = config.get("blockchain", {})
        plan_name = blockchain.get("plan_name", "Basic VM")
        plan_price = blockchain.get("plan_price_cents", 50)
        chain_id = blockchain.get("chain_id", "11155111")
        rpc_url = blockchain.get("rpc_url", "")
        sub_contract = blockchain.get("subscription_contract", "")

        usdc_address = USDC_BY_CHAIN.get(
            int(chain_id) if chain_id.isdigit() else 0, ""
        )

        deployer_key = ""
        key_file = CONFIG_DIR / "deployer.key"
        if key_file.exists():
            deployer_key = key_file.read_text().strip()

        if not deployer_key:
            return False, "Deployer key not available"

        bw_env = {
            **os.environ,
            "RPC_URL": rpc_url,
            "BLOCKHOST_CONTRACT": sub_contract,
        }

        # Set primary stablecoin
        if usdc_address:
            # Try bw config stable CLI
            try:
                result = subprocess.run(
                    ["bw", "config", "stable", usdc_address],
                    capture_output=True,
                    text=True,
                    timeout=60,
                    env=bw_env,
                )
                if result.returncode != 0:
                    raise FileNotFoundError()
            except FileNotFoundError:
                # Fallback: cast send (retry once on nonce race)
                cast_cmd = [
                    "cast",
                    "send",
                    sub_contract,
                    "setPrimaryStablecoin(address)",
                    usdc_address,
                    "--private-key",
                    f"0x{deployer_key}",
                    "--rpc-url",
                    rpc_url,
                ]
                result = subprocess.run(
                    cast_cmd, capture_output=True, text=True, timeout=60,
                )
                if result.returncode != 0 and "nonce" in (
                    result.stderr or ""
                ).lower():
                    time.sleep(5)
                    result = subprocess.run(
                        cast_cmd, capture_output=True, text=True, timeout=60,
                    )
                if result.returncode != 0:
                    return False, f"Failed to set primary stablecoin: {result.stderr or result.stdout}"

        # Create plan
        try:
            result = subprocess.run(
                ["bw", "plan", "create", plan_name, str(plan_price)],
                capture_output=True,
                text=True,
                timeout=60,
                env=bw_env,
            )
            if result.returncode == 0:
                config["_step_result_plan"] = {
                    "plan_name": plan_name,
                    "price": f"{plan_price} cents/day",
                }
                return True, None
        except FileNotFoundError:
            pass

        # Fallback: cast send createPlan (retry once on nonce race)
        cast_cmd = [
            "cast",
            "send",
            sub_contract,
            "createPlan(string,uint256)",
            plan_name,
            str(plan_price),
            "--private-key",
            f"0x{deployer_key}",
            "--rpc-url",
            rpc_url,
        ]
        result = subprocess.run(
            cast_cmd, capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0 and "nonce" in (result.stderr or "").lower():
            time.sleep(5)
            result = subprocess.run(
                cast_cmd, capture_output=True, text=True, timeout=60,
            )

        if result.returncode != 0:
            return False, f"Plan creation failed: {result.stderr or result.stdout}"

        config["_step_result_plan"] = {
            "plan_name": plan_name,
            "price": f"{plan_price} cents/day",
        }
        return True, None
    except subprocess.TimeoutExpired:
        return False, "Plan creation timed out"
    except Exception as e:
        return False, str(e)


def finalize_revenue_share(config: dict) -> tuple[bool, Optional[str]]:
    """Write addressbook.json and revenue-share.json. Enable blockhost-monitor."""
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        blockchain = config.get("blockchain", {})
        admin_wallet = config.get("admin_wallet", "")

        # Derive deployer/server address
        deployer_key = ""
        key_file = CONFIG_DIR / "deployer.key"
        if key_file.exists():
            deployer_key = key_file.read_text().strip()

        server_address = blockchain.get("deployer_address", "")
        if not server_address and deployer_key:
            server_address = _derive_address_from_key(deployer_key) or ""

        # Build addressbook entries
        addressbook = {}

        if admin_wallet:
            addressbook["admin"] = {"address": admin_wallet}

        if server_address:
            addressbook["server"] = {
                "address": server_address,
                "keyfile": "/etc/blockhost/deployer.key",
            }

        if blockchain.get("revenue_share_dev"):
            # Placeholder — admin fills in dev address later
            addressbook["dev"] = {"address": admin_wallet}

        if blockchain.get("revenue_share_broker"):
            addressbook["broker"] = {"address": admin_wallet}

        # Try ab --init CLI first
        ab_init_used = False
        try:
            cmd = ["ab", "--init", admin_wallet, server_address]
            if blockchain.get("revenue_share_dev"):
                cmd.append(admin_wallet)  # dev placeholder
            if blockchain.get("revenue_share_broker"):
                cmd.append(admin_wallet)  # broker placeholder
            cmd.append("/etc/blockhost/deployer.key")

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
            )
            ab_init_used = result.returncode == 0
        except FileNotFoundError:
            pass

        if not ab_init_used:
            # Write addressbook directly
            ab_path = CONFIG_DIR / "addressbook.json"
            # Don't overwrite existing addressbook
            if not ab_path.exists() or not json.loads(ab_path.read_text()):
                ab_path.write_text(json.dumps(addressbook, indent=2) + "\n")
                _set_blockhost_ownership(ab_path, 0o640)

        # Write revenue-share.json
        rev_enabled = blockchain.get("revenue_share_enabled", False)
        rev_percent = blockchain.get("revenue_share_percent", 1.0)
        recipients = []

        if rev_enabled:
            if blockchain.get("revenue_share_dev"):
                recipients.append(
                    {"role": "dev", "percent": rev_percent / max(len([
                        r for r in ["dev", "broker"]
                        if blockchain.get(f"revenue_share_{r}")
                    ]), 1)}
                )
            if blockchain.get("revenue_share_broker"):
                recipients.append(
                    {"role": "broker", "percent": rev_percent / max(len([
                        r for r in ["dev", "broker"]
                        if blockchain.get(f"revenue_share_{r}")
                    ]), 1)}
                )

        rev_config = {
            "enabled": rev_enabled,
            "total_percent": rev_percent if rev_enabled else 0.0,
            "recipients": recipients,
        }

        rev_path = CONFIG_DIR / "revenue-share.json"
        rev_path.write_text(json.dumps(rev_config, indent=2) + "\n")
        _set_blockhost_ownership(rev_path, 0o640)

        # Enable blockhost-monitor service (engine-specific)
        subprocess.run(
            ["systemctl", "enable", "blockhost-monitor"],
            capture_output=True,
            timeout=30,
        )

        config["_step_result_revenue_share"] = {
            "message": "Addressbook initialized"
        }
        return True, None
    except Exception as e:
        return False, str(e)
