#!/usr/bin/env python3
"""Validate public release roots and their agreement with the protected signer."""

import argparse
import base64
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import sys

# RFC 8032 test vector. This intentionally public fixture is forbidden in releases.
TEST_KEY = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")


def signer_public_key(path):
    # Match cmd/leviathan-update-manifest's bounded, private base64 key file.
    # Pass the derived PKCS#8 representation through stdin, never argv or a
    # second on-disk secret. OpenSSL returns only the public key.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 4096:
            raise ValueError("protected signer must be a private regular file containing a base64 Ed25519 seed or private key")
        data = stream.read(4097)
        if len(data) > 4096:
            raise ValueError("protected signer exceeds its size limit")
        encoded = data.strip().replace(b"\r", b"").replace(b"\n", b"")
    try:
        private = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError("protected signer must contain standard base64") from None
    if len(private) not in (32, 64) or base64.b64encode(private) != encoded:
        raise ValueError("protected signer must contain a canonical base64 Ed25519 seed or private key")
    seed_der = bytes.fromhex("302e020100300506032b657004220420") + private[:32]
    result = subprocess.run(["openssl", "pkey", "-inform", "DER", "-pubout", "-outform", "DER"], input=seed_der, capture_output=True, check=False)
    public_der = result.stdout
    if result.returncode or len(public_der) != 44 or public_der[:12] != bytes.fromhex("302a300506032b6570032100"):
        raise ValueError("cannot derive the protected Ed25519 signer's public key")
    public = public_der[12:]
    if len(private) == 64 and private[32:] != public:
        raise ValueError("protected signer is not a valid Ed25519 private key")
    return public


def validate(raw, allow_test=False, signing_key=None, expected_id=None):
    values = raw.split(",")
    keys = []
    if not raw or len(values) > 8:
        raise ValueError("one to eight public release roots are required")
    for value in values:
        try:
            key = base64.b64decode(value + "=", validate=True)
        except ValueError:
            raise ValueError("release roots must be canonical unpadded base64 raw Ed25519 public keys") from None
        if len(key) != 32 or base64.b64encode(key).rstrip(b"=").decode() != value or key in keys:
            raise ValueError("release roots must be unique canonical Ed25519 keys")
        if key == TEST_KEY and not allow_test:
            raise ValueError("test release root is forbidden in production artifacts")
        keys.append(key)
    if signing_key is not None:
        signer = signer_public_key(signing_key)
        if signer not in keys or hashlib.sha256(signer).hexdigest()[:32] != expected_id:
            raise ValueError("protected signer does not match the embedded public roots and configured key ID")
    return ",".join(values)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-test-key", action="store_true")
    parser.add_argument("--signing-key-file", type=Path)
    parser.add_argument("--expected-key-id")
    args = parser.parse_args()
    try:
        print(validate(os.environ.get("LEVIATHAN_UPDATE_PUBLIC_KEYS", ""), args.allow_test_key, args.signing_key_file, args.expected_key_id))
    except (ValueError, OSError) as error:
        print("release key validation: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
