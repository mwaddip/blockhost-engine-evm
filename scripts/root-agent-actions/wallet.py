"""
Root agent action: generate-wallet (EVM)

Generates a secp256k1 private key, derives the EVM address,
saves the keyfile, and adds the wallet to the addressbook.
"""

import json
import secrets
from pathlib import Path

from _common import CONFIG_DIR, SHORT_NAME_RE, WALLET_DENY_NAMES

from Cryptodome.Hash import keccak
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


ADDRESSBOOK_PATH = CONFIG_DIR / "addressbook.json"


def _keccak256(data: bytes) -> bytes:
    k = keccak.new(digest_bits=256)
    k.update(data)
    return k.digest()


def _derive_evm_address(private_hex: str) -> str:
    """Derive EIP-55 checksummed EVM address from a hex private key."""
    priv_int = int(private_hex, 16)
    priv_key = ec.derive_private_key(priv_int, ec.SECP256K1(), default_backend())
    pub_bytes = priv_key.public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    # keccak256 of uncompressed pubkey without the 0x04 prefix, last 20 bytes
    addr_bytes = _keccak256(pub_bytes[1:])[-20:]

    # EIP-55 checksum
    addr_hex = addr_bytes.hex()
    addr_hash = _keccak256(addr_hex.encode("ascii")).hex()
    checksummed = "0x" + "".join(
        c.upper() if int(addr_hash[i], 16) >= 8 else c
        for i, c in enumerate(addr_hex)
    )
    return checksummed


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
