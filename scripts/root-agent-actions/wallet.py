"""
Root agent action: generate-wallet (EVM)

Generates a secp256k1 private key, derives the EVM address,
saves the keyfile, and adds the wallet to the addressbook.
"""

import json
import secrets
import subprocess
from pathlib import Path

from _common import CONFIG_DIR, SHORT_NAME_RE, WALLET_DENY_NAMES


ADDRESSBOOK_PATH = CONFIG_DIR / "addressbook.json"


def _derive_evm_address(private_hex: str) -> str:
    """Derive EIP-55 checksummed EVM address from a hex private key.

    Shells out to /usr/bin/bhcrypt (the engine's crypto CLI) so EIP-55
    checksum logic lives in exactly one place. bhcrypt ships in the same
    .deb as this root agent action plugin, so the binary is always present.
    """
    result = subprocess.run(
        ["bhcrypt", "key-to-address", "--key", private_hex],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    address = result.stdout.strip()
    if not address.startswith("0x") or len(address) != 42:
        raise RuntimeError(f"bhcrypt returned invalid address: {address!r}")
    return address


def _load_addressbook() -> dict:
    if ADDRESSBOOK_PATH.exists():
        return json.loads(ADDRESSBOOK_PATH.read_text())
    return {}


def _save_addressbook(book: dict) -> None:
    tmp = ADDRESSBOOK_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(book, indent=2))
    tmp.rename(ADDRESSBOOK_PATH)


def _set_blockhost_ownership(path: Path, mode: int) -> None:
    import grp
    import os
    import pwd

    try:
        uid = pwd.getpwnam("root").pw_uid
        gid = grp.getgrnam("blockhost").gr_gid
        os.chown(str(path), uid, gid)
    except (KeyError, OSError):
        pass
    path.chmod(mode)


def handle_generate_wallet(params: dict) -> dict:
    name = params.get("name", "")

    if not name or not SHORT_NAME_RE.match(name):
        return {"ok": False, "error": f"Invalid wallet name: {name!r}"}

    if name in WALLET_DENY_NAMES:
        return {"ok": False, "error": f"Reserved name: {name}"}

    keyfile = CONFIG_DIR / f"{name}.key"
    if keyfile.exists():
        return {"ok": False, "error": f"Key file already exists: {keyfile}"}

    # Generate private key
    raw_key = secrets.token_hex(32)

    # Derive address
    address = _derive_evm_address(raw_key)

    # Write keyfile
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    keyfile.write_text(raw_key)
    _set_blockhost_ownership(keyfile, 0o640)

    # Update addressbook
    book = _load_addressbook()
    book[name] = {"address": address, "keyfile": str(keyfile)}
    _save_addressbook(book)

    return {"ok": True, "address": address, "keyfile": str(keyfile)}


ACTIONS = {
    "generate-wallet": handle_generate_wallet,
}
