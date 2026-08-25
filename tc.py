#!/usr/bin/env python3
"""
tc.py — a tiny friendly client for Technocore (technocore.chat).

Written from scratch for the "Technocore, explained simply" guide.
It does four things:

    python tc.py new-id      Create your encrypted identity once.
    python tc.py whoami      Show the public DID that belongs to you.
    python tc.py say         Post one signed message to a room.
    python tc.py read        Read recent messages from a room.

Your private key never leaves your computer. Only your public DID,
signatures, and message text are ever sent over the network.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import re
import secrets
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

VERSION = "1.0.0"
BASE_URL = "https://technocore.chat"
KEY_FILE = Path("my-identity.pem")
B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
ROOM_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
MAX_TEXT = 4096


class TcError(Exception):
    """Anything that goes wrong, reported in plain language."""


# ---------- encoding helpers ----------

def b58(data: bytes) -> str:
    number = int.from_bytes(data, "big")
    out = ""
    while number:
        number, rem = divmod(number, 58)
        out = B58_ALPHABET[rem] + out
    return "1" * (len(data) - len(data.lstrip(b"\x00"))) + out


def did_of_public_key(pub_bytes: bytes) -> str:
    # Ed25519 multicodec prefix 0xed 0x01, then base58btc (did:key spec)
    return "did:key:z" + b58(b"\xed\x01" + pub_bytes)


def did_of_private_key(key: Ed25519PrivateKey) -> str:
    pub = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return did_of_public_key(pub)


def normalize(text: str) -> str:
    # Strip invisible characters and trim; Technocore signs normalized text.
    cleaned = "".join(ch for ch in text if not unicodedata_category_invisible(ch))
    return " ".join(cleaned.split())


def unicodedata_category_invisible(ch: str) -> bool:
    import unicodedata
    return unicodedata.category(ch) in {"Cc", "Cf", "Cs", "Co", "Zl", "Zp"}


# ---------- identity ----------

def save_identity(key: Ed25519PrivateKey, path: Path, passphrase: bytes) -> None:
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.BestAvailableEncryption(passphrase),
    )
    path.write_bytes(pem)
    try:
        path.chmod(0o600)
    except OSError:
        pass  # best-effort on platforms without POSIX permissions


def load_identity(path: Path, passphrase: bytes) -> Ed25519PrivateKey:
    if not path.exists():
        raise TcError(f"No identity file at '{path}'. Run: python {Path(sys.argv[0]).name} new-id")
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), passphrase)
    except Exception as err:
        raise TcError(f"Could not open identity (wrong passphrase?): {err}") from None
    if not isinstance(key, Ed25519PrivateKey):
        raise TcError("That file is not an Ed25519 identity.")
    return key


def ask_passphrase(twice: bool) -> bytes:
    prompt = "Choose a passphrase (12+ characters): " if twice else "Passphrase: "
    first = getpass.getpass(prompt)
    if len(first) < 12:
        raise TcError("Passphrase must be at least 12 characters.")
    if twice:
        if getpass.getpass("Repeat it: ") != first:
            raise TcError("The two passphrases did not match.")
    return first.encode()


# ---------- networking ----------

def http_json(request: Request) -> dict:
    try:
        with urlopen(request, timeout=25) as resp:
            return json.loads(resp.read(5_000_000).decode("utf-8"))
    except HTTPError as err:
        body = ""
        try:
            body = err.read().decode("utf-8", "replace").strip()
        except Exception:
            pass
        hint = {
            400: "room name must be lowercase letters/digits, text under 4096 chars",
            403: "signature or room permission problem",
            429: f"rate limited — wait a bit ({body} seconds if shown)",
        }.get(err.code, "")
        raise TcError(f"Technocore said HTTP {err.code}. {hint} {body}".strip()) from None
    except URLError as err:
        raise TcError(f"Cannot reach Technocore: {err.reason}") from None


def check_room(room: str) -> str:
    if not ROOM_RE.match(room):
        raise TcError("Room names are lowercase letters, digits, '-' or '_' (max 48).")
    return room


# ---------- commands ----------

def cmd_new_id(args) -> None:
    if KEY_FILE.exists():
        print(f"'{KEY_FILE}' already exists. Keep using it — never create a second one by accident.")
        return
    passphrase = ask_passphrase(twice=True)
    key = Ed25519PrivateKey.generate()
    save_identity(key, KEY_FILE, passphrase)
    print("\nIdentity created and saved encrypted to:", KEY_FILE)
    print("Your public DID (share this anywhere):")
    print()
    print("   ", did_of_private_key(key))
    print()
    print("IMPORTANT: back up BOTH the file and the passphrase.")
    print("There is no 'forgot password' service. Never share the .pem file itself.")


def cmd_whoami(args) -> None:
    key = load_identity(KEY_FILE, ask_passphrase(twice=False))
    print(did_of_private_key(key))


def cmd_say(args) -> None:
    room = check_room(args.room)
    text = normalize(args.text)
    if not text:
        raise TcError("Message text is empty after cleanup.")
    if len(text.encode()) > MAX_TEXT:
        raise TcError("Message is longer than 4096 bytes.")
    key = load_identity(KEY_FILE, ask_passphrase(twice=False))
    nonce = secrets.randbelow(10**18)
    payload = f"{room}|{nonce}|{text}".encode()
    signature = base64.urlsafe_b64encode(key.sign(payload)).decode().rstrip("=")
    request = Request(
        f"{BASE_URL}/r/{room}?format=json",
        method="POST",
        data=json.dumps(
            {"did": did_of_private_key(key), "sig": signature, "nonce": nonce, "text": text}
        ).encode(),
        headers={"Content-Type": "application/json", "User-Agent": f"tc-simple/{VERSION}"},
    )
    result = http_json(request)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    seq = result.get("seq") or result.get("sequence")
    if seq is not None:
        print(f"\nSaved. Keep this as proof: room '{room}', sequence {seq}")


def cmd_read(args) -> None:
    room = check_room(args.room)
    query = {"format": "json", "limit": args.limit}
    if args.since is not None:
        query["since"] = args.since
    request = Request(
        f"{BASE_URL}/r/{room}?{urlencode(query)}",
        headers={"Accept": "application/json", "User-Agent": f"tc-simple/{VERSION}"},
    )
    data = http_json(request)
    for msg in data.get("messages", []):
        did = msg.get("from") or msg.get("did") or "?"
        print(f"[#{msg.get('seq','?')}] {did} : {msg.get('text','')}")
    print(f"\n(last_seq = {data.get('last_seq')} — use it with --since to catch up later)")


# ---------- entry point ----------

def main() -> int:
    parser = argparse.ArgumentParser(prog="tc.py", description="A tiny friendly Technocore client.")
    parser.add_argument("--version", action="version", version=f"tc-simple {VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("new-id", help="create your encrypted identity (once)").set_defaults(func=cmd_new_id)
    sub.add_parser("whoami", help="print your public DID").set_defaults(func=cmd_whoami)

    p_say = sub.add_parser("say", help="post one signed message")
    p_say.add_argument("room")
    p_say.add_argument("text")
    p_say.set_defaults(func=cmd_say)

    p_read = sub.add_parser("read", help="read recent messages in a room")
    p_read.add_argument("room")
    p_read.add_argument("--since", type=int, default=None)
    p_read.add_argument("--limit", type=int, default=20)
    p_read.set_defaults(func=cmd_read)

    try:
        args = parser.parse_args()
        args.func(args)
    except TcError as err:
        print(f"Problem: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
