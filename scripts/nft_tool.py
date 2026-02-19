#!/usr/bin/env python3
"""
nft_tool -- NFT & crypto CLI for Blockhost engine.

Replaces the deprecated pam_web3_tool Rust binary.
Provides: keypair generation, address derivation, symmetric encryption/decryption,
and ECIES decryption (Noble-compatible).

Dependencies: python3-pycryptodome (>= 3.15), python3-ecdsa
"""

import argparse
import sys

from Crypto.Cipher import AES
from Crypto.Hash import SHA256, keccak
from Crypto.Protocol.KDF import HKDF
from Crypto.Random import get_random_bytes
from ecdsa import SECP256k1, SigningKey, VerifyingKey


def keccak256(data: bytes) -> bytes:
    """Compute keccak-256 hash."""
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def strip_0x(hex_str: str) -> str:
    """Strip optional 0x prefix."""
    if hex_str.startswith("0x") or hex_str.startswith("0X"):
        return hex_str[2:]
    return hex_str


# ---------------------------------------------------------------------------
# Subcommand handlers
# ---------------------------------------------------------------------------


def cmd_generate_keypair(args):
    """Generate a secp256k1 keypair."""
    sk = SigningKey.generate(curve=SECP256k1)
    priv_hex = sk.to_string().hex()
    print(f"Private key (hex): {priv_hex}")
    if args.show_pubkey:
        vk = sk.get_verifying_key()
        pub_hex = (b"\x04" + vk.to_string()).hex()
        # Two spaces before hex value (aligns with "Private key (hex): ")
        print(f"Public key (hex):  {pub_hex}")


def cmd_derive_pubkey(args):
    """Derive public key from private key."""
    priv_hex = strip_0x(args.private_key)
    sk = SigningKey.from_string(bytes.fromhex(priv_hex), curve=SECP256k1)
    vk = sk.get_verifying_key()
    pub_hex = (b"\x04" + vk.to_string()).hex()
    print(f"Public key (hex): {pub_hex}")


def cmd_key_to_address(args):
    """Derive EIP-55 checksummed Ethereum address from private key."""
    key_hex = strip_0x(args.key)
    sk = SigningKey.from_string(bytes.fromhex(key_hex), curve=SECP256k1)
    vk = sk.get_verifying_key()
    pub_bytes = vk.to_string()  # 64 bytes (x || y, no 04 prefix)
    addr_bytes = keccak256(pub_bytes)[-20:]

    # EIP-55 checksum
    addr_hex = addr_bytes.hex()
    addr_hash = keccak256(addr_hex.encode("ascii")).hex()
    checksummed = "0x" + "".join(
        c.upper() if int(addr_hash[i], 16) >= 8 else c
        for i, c in enumerate(addr_hex)
    )
    print(checksummed)


def cmd_encrypt_symmetric(args):
    """Encrypt plaintext using signature-derived key (AES-256-GCM).

    Key derivation: keccak256(signature_bytes)
    Output format:  0x || hex(nonce[12] || ciphertext || tag[16])
    """
    sig_bytes = bytes.fromhex(strip_0x(args.signature))
    key = keccak256(sig_bytes)
    nonce = get_random_bytes(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(args.plaintext.encode("utf-8"))
    output = nonce + ciphertext + tag
    print(f"Ciphertext (hex): 0x{output.hex()}")


def cmd_decrypt_symmetric(args):
    """Decrypt ciphertext using signature-derived key (AES-256-GCM).

    Expected input: nonce[12] || ciphertext || tag[16]
    """
    sig_bytes = bytes.fromhex(strip_0x(args.signature))
    key = keccak256(sig_bytes)
    ct_bytes = bytes.fromhex(strip_0x(args.ciphertext))

    # Minimum: 12 (nonce) + 0 (empty plaintext) + 16 (tag) = 28 bytes
    if len(ct_bytes) < 28:
        print("Error: ciphertext too short", file=sys.stderr)
        sys.exit(1)

    nonce = ct_bytes[:12]
    tag = ct_bytes[-16:]
    ciphertext = ct_bytes[12:-16]

    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    try:
        plaintext = cipher.decrypt_and_verify(ciphertext, tag)
    except ValueError:
        print("Error: decryption failed (bad key or corrupted data)", file=sys.stderr)
        sys.exit(1)

    # Raw output (no prefix, no trailing newline)
    sys.stdout.write(plaintext.decode("utf-8"))


def cmd_decrypt(args):
    """Decrypt ECIES ciphertext (Noble-compatible).

    Format: ephemeralPK[65] || iv[12] || ciphertext || tag[16]
    ECDH -> HKDF-SHA256(ikm=shared_x, salt=zeros, info=empty) -> AES-256-GCM
    """
    if args.scheme:
        print(
            f"Error: --scheme {args.scheme} is not implemented in nft_tool. "
            "Only the default Noble ECIES format is supported.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Read private key from file
    try:
        priv_hex = open(args.private_key_file).read().strip()
    except OSError as e:
        print(f"Error: cannot read key file: {e}", file=sys.stderr)
        sys.exit(1)

    priv_hex = strip_0x(priv_hex)
    priv_bytes = bytes.fromhex(priv_hex)
    sk = SigningKey.from_string(priv_bytes, curve=SECP256k1)

    ct_bytes = bytes.fromhex(strip_0x(args.ciphertext))

    # Minimum: 65 (ephemeral PK) + 12 (IV) + 16 (tag) = 93 bytes
    if len(ct_bytes) < 93:
        print("Error: ciphertext too short for ECIES", file=sys.stderr)
        sys.exit(1)

    eph_pub_bytes = ct_bytes[:65]
    iv = ct_bytes[65:77]
    ct_and_tag = ct_bytes[77:]
    tag = ct_and_tag[-16:]
    ciphertext = ct_and_tag[:-16]

    if eph_pub_bytes[0] != 0x04:
        print("Error: expected uncompressed ephemeral public key", file=sys.stderr)
        sys.exit(1)

    # Reconstruct ephemeral public key point (ecdsa wants 64 bytes, no 04 prefix)
    eph_vk = VerifyingKey.from_string(eph_pub_bytes[1:], curve=SECP256k1)
    eph_point = eph_vk.pubkey.point

    # ECDH: shared_point = ephemeral_pk * private_scalar
    d = sk.privkey.secret_multiplier
    shared_point = eph_point * d
    shared_x = shared_point.x().to_bytes(32, "big")

    # HKDF-SHA256: salt=None means use HashLen zeros (RFC 5869), info=empty
    aes_key = HKDF(shared_x, 32, None, SHA256, context=b"")

    # AES-256-GCM decrypt
    cipher = AES.new(aes_key, AES.MODE_GCM, nonce=iv)
    try:
        plaintext = cipher.decrypt_and_verify(ciphertext, tag)
    except ValueError:
        print("Error: ECIES decryption failed", file=sys.stderr)
        sys.exit(1)

    # Raw output (no prefix, no trailing newline)
    sys.stdout.write(plaintext.decode("utf-8"))


def cmd_not_implemented(args):
    """Placeholder for deprecated subcommands."""
    print(
        f"Error: '{args.subcommand}' is not implemented in nft_tool. "
        "This subcommand was part of the deprecated pam_web3_tool.",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        prog="nft_tool",
        description="NFT & crypto tool for Blockhost engine",
    )
    sub = parser.add_subparsers(dest="subcommand")

    # generate-keypair
    kp = sub.add_parser("generate-keypair", help="Generate secp256k1 keypair")
    kp.add_argument(
        "--show-pubkey", action="store_true", help="Also print public key"
    )

    # derive-pubkey
    dp = sub.add_parser("derive-pubkey", help="Derive public key from private key")
    dp.add_argument("--private-key", required=True, help="Private key (hex)")

    # key-to-address
    ka = sub.add_parser("key-to-address", help="Derive Ethereum address from key")
    ka.add_argument("--key", required=True, help="Private key (hex)")

    # encrypt-symmetric
    es = sub.add_parser("encrypt-symmetric", help="Symmetric encrypt (AES-256-GCM)")
    es.add_argument(
        "--signature", required=True, help="Signature hex (key derivation)"
    )
    es.add_argument("--plaintext", required=True, help="Plaintext to encrypt")

    # decrypt-symmetric
    ds = sub.add_parser("decrypt-symmetric", help="Symmetric decrypt (AES-256-GCM)")
    ds.add_argument(
        "--signature", required=True, help="Signature hex (key derivation)"
    )
    ds.add_argument("--ciphertext", required=True, help="Ciphertext hex")

    # decrypt (ECIES)
    dc = sub.add_parser("decrypt", help="ECIES decrypt (Noble-compatible)")
    dc.add_argument(
        "--private-key-file", required=True, help="Path to private key file"
    )
    dc.add_argument("--ciphertext", required=True, help="ECIES ciphertext hex")
    dc.add_argument(
        "--scheme",
        help="(not supported: secp256k1/x25519 schemes are deprecated)",
    )

    # Deprecated subcommands (error out with message)
    sub.add_parser("wallet-encryption-key", help="(deprecated, not implemented)")

    args = parser.parse_args()

    if not args.subcommand:
        parser.print_help()
        sys.exit(1)

    handlers = {
        "generate-keypair": cmd_generate_keypair,
        "derive-pubkey": cmd_derive_pubkey,
        "key-to-address": cmd_key_to_address,
        "encrypt-symmetric": cmd_encrypt_symmetric,
        "decrypt-symmetric": cmd_decrypt_symmetric,
        "decrypt": cmd_decrypt,
        "wallet-encryption-key": cmd_not_implemented,
    }

    handler = handlers.get(args.subcommand)
    if handler:
        handler(args)
    else:
        cmd_not_implemented(args)


if __name__ == "__main__":
    main()
