"""Channel accounts for YouTube Studio Manager: add, show credentials, store an API key, revoke, and remove.

Every write goes through update_channels() so channels.json keeps its order and is replaced atomically.
Secrets stay on this PC: OAuth client JSON in Secrets/, tokens and API keys in Secrets/vault (DPAPI). The dashboard shows
them masked; the full value is only returned by reveal(), which the page asks for on an explicit click, and every
reveal/copy/download/replace is written to Data/dashboard/credential_audit.jsonl. Removing a channel archives its files
under Secrets/_removed/ (restorable) instead of deleting them.
"""
import datetime as dt
import json
import os
import re
import shutil
import threading
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SECRETS = os.path.join(ROOT, "Secrets")
CHANNELS_JSON = os.path.join(ROOT, "Tools", "youtube", "channels.json")
CHANNEL_IDS = os.path.join(ROOT, "Data", "dashboard", "channel_ids.json")
AUDIT = os.path.join(ROOT, "Data", "dashboard", "credential_audit.jsonl")
REMOVED_JSON = os.path.join(ROOT, "Data", "dashboard", "removed_channels.json")
REMOVED_DIR = os.path.join(SECRETS, "_removed")

import sys  # noqa: E402

sys.path.insert(0, os.path.join(ROOT, "Tools", "youtube"))
import vault  # noqa: E402

lock = threading.RLock()
KEY_RE = re.compile(r"^[a-z0-9]{2,32}$")
CLIENT_FILE_RE = re.compile(r"^client_secret_[A-Za-z0-9_.-]+\.json$")


class AccountError(Exception):
    pass


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


# ---------- channels.json ----------
def load_channels():
    try:
        with open(CHANNELS_JSON, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:  # fresh checkout: channels.json is user data, created on first use and kept out of git
        return {}


def update_channels(fn):
    """fn(cfg) edits the dict in place; the file is rewritten atomically. Returns fn's result."""
    with lock:
        cfg = load_channels()
        res = fn(cfg)
        tmp = CHANNELS_JSON + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, CHANNELS_JSON)
        return res


def _json_rw(path, fn, default):
    with lock:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = default
        res = fn(data)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1, ensure_ascii=False)
        return res


def channel_ids():
    try:
        with open(CHANNEL_IDS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


# ---------- audit ----------
def audit(ch, action, detail=""):
    os.makedirs(os.path.dirname(AUDIT), exist_ok=True)
    with lock, open(AUDIT, "a", encoding="utf-8") as f:
        f.write(json.dumps({"t": now(), "ch": ch, "action": action, "detail": detail}, ensure_ascii=False) + "\n")


def audit_log(ch=None, limit=20):
    try:
        with open(AUDIT, encoding="utf-8") as f:
            rows = [json.loads(line) for line in f if line.strip()]
    except (OSError, ValueError):
        return []
    rows = [r for r in rows if ch is None or r.get("ch") == ch]
    return rows[-limit:][::-1]


# ---------- masking ----------
def mask(value, head=6, tail=4):
    if not value:
        return None
    if len(value) <= head + tail + 2:
        return value[:2] + "•" * max(4, len(value) - 2)
    return value[:head] + "•" * 12 + (value[-tail:] if tail > 0 else "")  # value[-0:] would be the whole value


# ---------- OAuth client JSON ----------
def _client_path(name):
    if not name or not CLIENT_FILE_RE.match(name):
        raise AccountError("invalid client secret file name")
    return os.path.join(SECRETS, name)


def parse_client_json(text):
    """Validate a Google OAuth client JSON (Desktop 'installed' or 'web'); returns (data, kind, inner)."""
    try:
        data = json.loads(text)
    except ValueError:
        raise AccountError("the file is not valid JSON")
    if not isinstance(data, dict):
        raise AccountError("unrecognised JSON content")
    if data.get("type") == "service_account":
        raise AccountError("this is a Service Account JSON; YouTube needs an OAuth client (Desktop app) from the Google Cloud Console")
    kind = "installed" if "installed" in data else "web" if "web" in data else None
    inner = data.get(kind) if kind else None
    if not inner or not inner.get("client_id") or not inner.get("client_secret"):
        raise AccountError("not an OAuth client JSON (needs an 'installed' block with client_id and client_secret)")
    if not str(inner["client_id"]).endswith(".apps.googleusercontent.com"):
        raise AccountError("client_id does not end in .apps.googleusercontent.com")
    return data, kind, inner


def save_client_json(text):
    """Store an uploaded OAuth client JSON in Secrets as client_secret_<client_id>.json; returns the file name."""
    data, kind, inner = parse_client_json(text)
    name = f"client_secret_{inner['client_id']}.json"
    path = _client_path(name)
    with lock:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                try:
                    if json.load(f) == data:
                        return name
                except ValueError:
                    pass
            shutil.copy2(path, path + f".{dt.datetime.now():%Y%m%d%H%M%S}.bak")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    return name


def client_info(name):
    """Masked facts about a client JSON, safe to show on the page."""
    path = _client_path(name)
    if not os.path.exists(path):
        return {"file": name, "exists": False}
    with open(path, encoding="utf-8") as f:
        text = f.read()
    try:
        data, kind, inner = parse_client_json(text)
    except AccountError as e:
        return {"file": name, "exists": True, "error": str(e)}
    masked = json.loads(text)
    masked[kind]["client_secret"] = mask(inner["client_secret"], 7, 0)
    masked[kind]["client_id"] = mask(inner["client_id"], 12, 27)
    return {"file": name, "exists": True, "kind": kind, "project_id": inner.get("project_id"),
            "client_id": mask(inner["client_id"], 12, 27), "client_secret": mask(inner["client_secret"], 7, 0),
            "bytes": len(text.encode("utf-8")), "modified": dt.datetime.fromtimestamp(os.path.getmtime(path),
                                                                                     dt.timezone.utc).isoformat(timespec="seconds"),
            "json_masked": json.dumps(masked, indent=2, ensure_ascii=False), "redirect_uris": inner.get("redirect_uris", [])}


def client_users(name, cfg=None):
    cfg = cfg or load_channels()
    return [k for k, v in cfg.items() if v.get("client_secret") == name]


def list_client_files():
    cfg = load_channels()
    out = []
    for n in sorted(os.listdir(SECRETS)):
        if CLIENT_FILE_RE.match(n):
            info = client_info(n)
            out.append({"file": n, "project_id": info.get("project_id"), "client_id": info.get("client_id"),
                        "used_by": [cfg[k]["title"] for k in client_users(n, cfg)]})
    return out


# ---------- API key (per channel, in the vault) ----------
def apikey_path(ch):
    return os.path.join(SECRETS, "vault", f"apikey_{ch}.dpapi")


def get_api_key(ch):
    rec = vault.load(apikey_path(ch))
    return (rec or {}).get("token", {}).get("api_key")


def set_api_key(ch, key):
    key = (key or "").strip()
    if not re.match(r"^AIza[0-9A-Za-z_-]{30,}$", key):
        raise AccountError("unrecognised API key format (Google API keys start with 'AIza')")
    vault.save(apikey_path(ch), {"api_key": key})
    audit(ch, "apikey_set", mask(key))
    return {"api_key": mask(key)}


def remove_api_key(ch):
    p = apikey_path(ch)
    if os.path.exists(p):
        os.remove(p)
        audit(ch, "apikey_removed")
    return {"api_key": None}


def test_api_key(ch, cid):
    """One public channels.list call with the key (1 unit of the key's project). Never sends OAuth tokens."""
    key = get_api_key(ch)
    if not key:
        raise AccountError("no API key yet")
    q = urllib.parse.urlencode({"part": "id,snippet", "id": cid or "", "key": key, "maxResults": 1})
    req = urllib.request.Request("https://www.googleapis.com/youtube/v3/channels?" + q,
                                 headers={"User-Agent": "YouTubeStudioManager/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error", {}).get("message", str(e))
        except ValueError:
            msg = str(e)
        audit(ch, "apikey_test", f"failed: {msg[:120]}")
        return {"ok": False, "message": msg[:300]}
    items = data.get("items", [])
    audit(ch, "apikey_test", "ok")
    return {"ok": True, "message": f"API key works · {items[0]['snippet']['title']}" if items else "API key works"}


# ---------- reveal (explicit click on the page) ----------
def reveal(ch, cfg, field):
    if field == "api_key":
        val = get_api_key(ch)
    else:
        path = _client_path(cfg.get("client_secret"))
        with open(path, encoding="utf-8") as f:
            text = f.read()
        data, kind, inner = parse_client_json(text)
        val = {"client_id": inner["client_id"], "client_secret": inner["client_secret"],
               "json": json.dumps(data, indent=2)}.get(field)
    if val is None:
        raise AccountError("no value to show")
    audit(ch, "reveal_" + field)
    return {"field": field, "value": val}


# ---------- token facts from the vault ----------
def token_facts(token_name):
    try:
        rec = vault.load(vault.path_for(SECRETS, token_name))
    except vault.VaultError as e:
        return {"error": str(e)}
    if not rec:
        return {"stored": False}
    t = rec["token"]
    return {"stored": True, "scopes": t.get("scopes") or [], "login_at": rec.get("login_at"),
            "updated_at": rec.get("updated_at"), "expiry": t.get("expiry"), "migrated_from": rec.get("migrated_from")}


# ---------- add / remove ----------
def slug(title):
    s = re.sub(r"[^a-z0-9]", "", (title or "").lower())
    return s[:32]


def folder_name(title):
    return re.sub(r"[^A-Za-z0-9]", "", "".join(w[:1].upper() + w[1:] for w in re.split(r"\s+", title or "")))[:40]


def add_channel(title, client_file=None, client_json=None, language="id", slot_utc_hour=12, category="27"):
    """Register a channel (pending until its OAuth login succeeds). Returns the new key."""
    title = (title or "").strip()
    if not 2 <= len(title) <= 60:
        raise AccountError("channel name must be 2–60 characters")
    key = slug(title)
    if not KEY_RE.match(key):
        raise AccountError("channel name must contain letters or digits")
    if language not in ("id", "en"):
        raise AccountError("language must be en or id")
    try:
        slot = int(slot_utc_hour)
        assert 0 <= slot <= 23
    except (ValueError, TypeError, AssertionError):
        raise AccountError("jam slot UTC 0–23")
    if client_json:
        client_file = save_client_json(client_json)
    if client_file and not os.path.exists(_client_path(client_file)):  # None = set up later with the Google Cloud guide
        raise AccountError("OAuth client file not found in Secrets")
    folder = folder_name(title)

    def edit(cfg):
        if key in cfg:
            raise AccountError(f"a channel with key '{key}' already exists")
        cfg[key] = {"title": title, "client_secret": client_file or None, "token": f"token_{key}.json",
                    "snapshots": f"Channels/{folder}/Data/snapshots", "projects": f"Channels/{folder}/Videos",
                    "slot_utc_hour": slot, "language": language, "category": str(category),
                    "formats": ["short"], "pending": True}
    update_channels(edit)
    for sub in ("Videos", os.path.join("Data", "snapshots")):
        os.makedirs(os.path.join(ROOT, "Channels", folder, sub), exist_ok=True)
    audit(key, "channel_added", f"{title} · {client_file or 'client JSON menyusul'}")
    return key


def finish_pending(ch, cid=None):
    def edit(cfg):
        if ch in cfg:
            cfg[ch].pop("pending", None)
    update_channels(edit)
    if cid:
        _json_rw(CHANNEL_IDS, lambda d: d.__setitem__(ch, cid), {})
    audit(ch, "oauth_connected", cid or "")


def revoke(ch, token_name):
    """Revoke the channel's OAuth grant at Google and archive the vault token. The channel stays listed."""
    path = vault.path_for(SECRETS, token_name)
    rec = vault.load(path)
    result = "no token"
    if rec:
        tok = rec["token"].get("refresh_token") or rec["token"].get("token")
        try:
            req = urllib.request.Request("https://oauth2.googleapis.com/revoke",
                                         data=urllib.parse.urlencode({"token": tok}).encode(),
                                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            urllib.request.urlopen(req, timeout=15).close()
            result = "revoked at Google"
        except urllib.error.HTTPError as e:  # 400 = already invalid; still drop it locally
            result = f"Google answered {e.code} (the token may already be invalid)"
        _archive(ch, [path])
    plain = os.path.join(SECRETS, token_name)
    if os.path.exists(plain):
        _archive(ch, [plain])
    audit(ch, "oauth_revoked", result)
    return {"revoked": True, "detail": result}


def _archive(ch, paths):
    dest = os.path.join(REMOVED_DIR, f"{ch}-{dt.datetime.now():%Y%m%d-%H%M%S}")
    os.makedirs(dest, exist_ok=True)
    moved = []
    for p in paths:
        if p and os.path.exists(p):
            shutil.move(p, os.path.join(dest, os.path.basename(p)))
            moved.append(os.path.basename(p))
    return os.path.relpath(dest, ROOT), moved


def remove_channel(ch):
    """Take a channel out of YouTube Studio Manager. Its token, API key and (if no other channel uses it) client JSON are
    archived to Secrets/_removed/, the channels.json entry to Data/dashboard/removed_channels.json. Video project
    folders under Channels/ are left untouched."""
    cfg = load_channels()
    if ch not in cfg:
        raise AccountError(f"channel {ch} does not exist")
    entry = cfg[ch]
    files = [vault.path_for(SECRETS, entry["token"]), os.path.join(SECRETS, entry["token"]), apikey_path(ch)]
    if entry.get("client_secret") and client_users(entry["client_secret"], cfg) == [ch]:
        files.append(_client_path(entry["client_secret"]))
    dest, moved = _archive(ch, files)
    _json_rw(REMOVED_JSON, lambda d: d.__setitem__(ch, dict(entry, removed_at=now(), archive=dest)), {})
    update_channels(lambda c: c.pop(ch, None))
    _json_rw(CHANNEL_IDS, lambda d: d.pop(ch, None), {})
    audit(ch, "channel_removed", f"arsip: {dest} ({', '.join(moved)})")
    return {"removed": ch, "archive": dest, "moved": moved}


# ---------- client JSON from the Downloads folder (Google Cloud guide) ----------
DOWNLOAD_RE = re.compile(r"^client_secret[A-Za-z0-9_.() -]*\.json$")


def downloads_dir():
    """The user's Downloads folder (Windows known folder, follows OneDrive/relocation), else ~/Downloads."""
    try:
        import ctypes
        from ctypes import wintypes
        import uuid

        class GUID(ctypes.Structure):
            _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]
        u = uuid.UUID("374DE290-123F-4565-9164-39C4925E467B")
        g = GUID(u.fields[0], u.fields[1], u.fields[2], (ctypes.c_ubyte * 8)(*u.bytes[8:]))
        p = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(p)) == 0:
            path = p.value
            ctypes.windll.ole32.CoTaskMemFree(p)
            return path
    except Exception:
        pass
    return os.path.join(os.path.expanduser("~"), "Downloads")


def find_downloads(limit=8):
    """OAuth client JSON files waiting in Downloads (newest first). Only masked facts leave this function."""
    d = downloads_dir()
    try:
        names = [n for n in os.listdir(d) if DOWNLOAD_RE.match(n)]
    except OSError:
        return {"dir": d, "files": []}
    out = []
    for n in sorted(names, key=lambda n: os.path.getmtime(os.path.join(d, n)), reverse=True)[:limit]:
        p = os.path.join(d, n)
        if os.path.getsize(p) > 64 * 1024:
            continue
        row = {"name": n, "modified": dt.datetime.fromtimestamp(os.path.getmtime(p), dt.timezone.utc).isoformat(timespec="seconds")}
        try:
            with open(p, encoding="utf-8") as f:
                data, kind, inner = parse_client_json(f.read())
            row.update(valid=True, kind=kind, project_id=inner.get("project_id"), client_id=mask(inner["client_id"], 12, 27),
                       used_by=[load_channels()[k]["title"] for k in client_users(f"client_secret_{inner['client_id']}.json")])
        except (AccountError, OSError, UnicodeDecodeError) as e:
            row.update(valid=False, error=str(e)[:160])
        out.append(row)
    return {"dir": d, "files": out}


def take_download(name):
    """Read a client JSON from Downloads by its exact listed name; returns (text, path). Validated, size-capped."""
    d = downloads_dir()
    if not name or not DOWNLOAD_RE.match(name) or name not in os.listdir(d):
        raise AccountError("file not found in the Downloads folder")
    p = os.path.join(d, name)
    if os.path.getsize(p) > 64 * 1024:
        raise AccountError("file is too large for an OAuth client JSON")
    with open(p, encoding="utf-8") as f:
        text = f.read()
    parse_client_json(text)
    return text, p
