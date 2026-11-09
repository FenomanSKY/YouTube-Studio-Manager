"""Token vault: OAuth tokens encrypted with Windows DPAPI (current Windows user), one file per channel.

Secrets/vault/<token stem>.dpapi  =  b"SPV1" + CryptProtectData(json)
json = {"token": <google Credentials.to_json() dict>, "login_at": ISO UTC or null,
        "migrated_from": "token_x.json" or null, "updated_at": ISO UTC}

DPAPI ties the file to this Windows user on this PC: a copied file (OneDrive, backup, another user) cannot be read.
It does not protect against programs running as the same Windows user. Never print what load() returns.
"""
import ctypes
import ctypes.wintypes as wt
import datetime as dt
import json
import os

MAGIC = b"SPV1"
ENTROPY = b"StudioPulse-vault-v1"
CRYPTPROTECT_UI_FORBIDDEN = 0x1


class VaultError(Exception):
    pass


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data):
    buf = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf


def _call(fn, data, *extra):
    src, _keep = _blob(data)
    ent, _keep2 = _blob(ENTROPY)
    out = _Blob()
    if not fn(ctypes.byref(src), *extra, ctypes.byref(ent), None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out)):
        raise VaultError(f"DPAPI failed (error {ctypes.get_last_error()})")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def protect(data: bytes) -> bytes:
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    return _call(crypt32.CryptProtectData, data, ctypes.c_wchar_p("StudioPulse token"))


def unprotect(data: bytes) -> bytes:
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    return _call(crypt32.CryptUnprotectData, data, None)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def path_for(secrets_dir, token_name):
    """Vault file for a channel's token name from channels.json (token_mychannel.json -> vault/token_mychannel.dpapi)."""
    return os.path.join(secrets_dir, "vault", os.path.splitext(token_name)[0] + ".dpapi")


def load(path):
    """Decrypted record dict, or None when the file does not exist. Raises VaultError on a damaged file."""
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        raw = f.read()
    if not raw.startswith(MAGIC):
        raise VaultError(f"{os.path.basename(path)}: not a vault file")
    try:
        rec = json.loads(unprotect(raw[len(MAGIC):]).decode("utf-8"))
    except (VaultError, ValueError) as e:
        raise VaultError(f"{os.path.basename(path)}: cannot decrypt ({e}); log in again with auth --force")
    if not isinstance(rec, dict) or not isinstance(rec.get("token"), dict):
        raise VaultError(f"{os.path.basename(path)}: unexpected content")
    return rec


def save(path, token, login_at=None, migrated_from=None, keep=None):
    """Write a record atomically. keep: the previous record, whose login_at/migrated_from are kept when not given."""
    keep = keep or {}
    rec = {"token": token,
           "login_at": login_at if login_at is not None else keep.get("login_at"),
           "migrated_from": migrated_from if migrated_from is not None else keep.get("migrated_from"),
           "updated_at": now()}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(MAGIC + protect(json.dumps(rec).encode("utf-8")))
    os.replace(tmp, path)
    return rec
