"""Open YouTube Studio for one channel, signed in as that channel's own Google account.

Two ways, per channel in channels.json:
- default: a Chrome session that belongs to this channel only, a separate Chrome user data folder at
  %LOCALAPPDATA%\\StudioPulse\\chrome\\<channel>. The first "Buka Studio" lands on Google's sign-in page; the user signs
  in by hand, and Chrome itself keeps that session (encrypted by Chrome), so later clicks open Studio already signed in.
- "chrome_profile": an existing profile of the user's normal Chrome (folder name such as "Profile 2").

This module only starts chrome.exe. It never stores or types passwords, never reads cookies, and does not automate
the page. It reads the session folder's Preferences only for the signed-in email shown on the dashboard.
"""
import datetime as dt
import json
import os
import shutil
import subprocess

CHROME_CANDIDATES = [
    os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
    os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]
USER_DATA = os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data")
SESSION_ROOT = os.path.expandvars(r"%LOCALAPPDATA%\StudioPulse\chrome")


class LaunchError(Exception):
    pass


def chrome_exe():
    for p in CHROME_CANDIDATES:
        if os.path.isfile(p):
            return p
    raise LaunchError("Chrome tidak ditemukan di Program Files atau LocalAppData")


def profiles():
    """Profiles of the user's normal Chrome from 'Local State': [{dir, name, email}]."""
    try:
        with open(os.path.join(USER_DATA, "Local State"), encoding="utf-8") as f:
            cache = json.load(f)["profile"]["info_cache"]
    except (OSError, ValueError, KeyError):
        return []
    return sorted(({"dir": d, "name": v.get("name") or d, "email": v.get("user_name") or None}
                   for d, v in cache.items()), key=lambda p: (p["dir"] != "Default", p["dir"]))


def studio_url(channel_id=None):
    return f"https://studio.youtube.com/channel/{channel_id}" if channel_id else "https://studio.youtube.com/"


def _start(args):
    subprocess.Popen([chrome_exe(), *args], close_fds=True, creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))


# ---------- per-channel session (own user data folder) ----------
def _safe(ch):
    if not ch or not all(c.isalnum() or c in "-_" for c in ch):
        raise LaunchError(f"nama channel tidak valid: {ch!r}")
    return ch


def session_dir(ch):
    return os.path.join(SESSION_ROOT, _safe(ch))


def _meta_path(ch):
    return os.path.join(SESSION_ROOT, _safe(ch) + ".json")


def _meta(ch):
    try:
        with open(_meta_path(ch), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _emails(d):
    """Google accounts Chrome lists as signed in for this session (from Default/Preferences), [] when unknown."""
    try:
        with open(os.path.join(d, "Default", "Preferences"), encoding="utf-8") as f:
            prefs = json.load(f)
    except (OSError, ValueError):
        return []
    out = [a.get("email") for a in prefs.get("account_info", []) if a.get("email")]
    last = prefs.get("google", {}).get("services", {}).get("last_signed_in_username")
    if last and last not in out:
        out.append(last)
    return out


def session_info(ch):
    d = session_dir(ch)
    m = _meta(ch)
    exists = os.path.isdir(os.path.join(d, "Default"))
    return {"exists": exists, "emails": _emails(d) if exists else [],
            "created": m.get("created"), "last_opened": m.get("last_opened"), "opens": m.get("opens", 0)}


def open_session(ch, channel_id=None, url=None):
    """Open Studio (or url) in the channel's own Chrome session; the first time Google asks the user to sign in."""
    d = session_dir(ch)
    first = not os.path.isdir(os.path.join(d, "Default"))
    os.makedirs(d, exist_ok=True)
    url = url or studio_url(channel_id)
    _start([f"--user-data-dir={d}", "--no-first-run", "--no-default-browser-check", url])
    _touch(ch)
    return {"opened": url, "mode": "session", "first_time": first}


def _touch(ch):
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    m = _meta(ch)
    m.setdefault("created", now)
    m.update(last_opened=now, opens=m.get("opens", 0) + 1)
    os.makedirs(SESSION_ROOT, exist_ok=True)
    with open(_meta_path(ch), "w", encoding="utf-8") as f:
        json.dump(m, f, indent=1)


def forget_session(ch):
    """Delete the channel's Chrome session folder (signs that browser out). Chrome for it must be closed."""
    d = session_dir(ch)
    if not os.path.isdir(d):
        return {"forgotten": False, "reason": "belum ada sesi"}
    try:
        os.rename(d, d + ".del")  # fails while that Chrome window still holds the folder
    except OSError:
        raise LaunchError("Tutup dulu jendela Chrome milik channel ini, lalu coba lagi")
    shutil.rmtree(d + ".del", ignore_errors=True)
    try:
        os.remove(_meta_path(ch))
    except OSError:
        pass
    return {"forgotten": True}


def has_session(ch):
    return os.path.isdir(os.path.join(session_dir(ch), "Default"))


def register_session_browser(ch):
    """Register a `webbrowser` entry that opens URLs in the channel's own Chrome session, so the OAuth consent page
    appears where that Google account is already signed in (one click on Allow, no password). Returns its name."""
    import webbrowser
    d = session_dir(ch)

    class SessionBrowser(webbrowser.BaseBrowser):
        def open(self, url, new=0, autoraise=True):
            os.makedirs(d, exist_ok=True)
            _start([f"--user-data-dir={d}", "--no-first-run", "--no-default-browser-check", url])
            _touch(ch)
            return True

    name = f"studiopulse-{ch}"
    webbrowser.register(name, None, SessionBrowser(name))
    return name


# ---------- an existing profile of the normal Chrome ----------
def open_profile(profile_dir, channel_id=None, url=None):
    if profile_dir not in {p["dir"] for p in profiles()}:
        raise LaunchError(f"Profil Chrome '{profile_dir}' tidak ada lagi; pilih ulang")
    url = url or studio_url(channel_id)
    _start([f"--profile-directory={profile_dir}", url])
    return {"opened": url, "mode": "profile", "profile": profile_dir}


def open_studio(ch, profile_dir=None, channel_id=None, url=None):
    """Studio home of the channel, or `url` (a YouTube/Studio page chosen by the server), in the channel's browser."""
    return open_profile(profile_dir, channel_id, url) if profile_dir else open_session(ch, channel_id, url)
