"""Build a shareable YouTube Studio Manager package: a folder plus a .zip with the code only, none of the owner's data.

Run (from the project root):  Tools\\youtube\\.venv\\Scripts\\python.exe -I Tools\\dashboard\\build_release.py [--out DIR]
Default output: dist\\YouTubeStudioManager-YYYYMMDD\\ and dist\\YouTubeStudioManager-YYYYMMDD.zip next to Tools\\.

Only the files listed in FILES are copied (an allowlist, never a folder walk), so Secrets\\, Data\\, Channels\\,
channel_ids.json, the credential audit log and the owner's channels.json can never slip in. channels.json is written
fresh as {}. After building, scan() checks the result for secret-looking content and fails the build on any hit.

--repo [DIR] syncs the standalone GitHub project instead (default: env YSM_REPO, else <drive>\\Project Engineering\\YouTube-Studio-Manager): the same files
plus tests, this script, .gitignore and README; channels.json is left out (created on first run, ignored by git).
Only files this script manages are written there; anything else in DIR is left alone. The source folder stays the master copy.
"""
import argparse
import datetime as dt
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

# source (relative to ROOT) -> same path inside the package
FILES = [
    "Tools/dashboard/server.py",
    "Tools/dashboard/accounts.py",
    "Tools/dashboard/launcher.py",
    "Tools/dashboard/static/index.html",
    "Tools/dashboard/static/app.js",
    "Tools/dashboard/static/style.css",
    "Tools/dashboard/static/logo.svg",
    "Tools/youtube/yt.py",
    "Tools/youtube/vault.py",
    "Tools/youtube/yt.cmd",
]
# extra files for the GitHub project (developer tools; not needed by people who only run the zip)
DEV_FILES = [
    "Tools/dashboard/build_release.py",
    "Tools/dashboard/test_release.py",
    "Tools/dashboard/test_accounts.py",
    "Tools/youtube/test_vault.py",
]
# GPL-3.0 text, published at the package/repo root as LICENSE (GPL requires the license to travel with the code)
LICENSE_SRC = "Tools/dashboard/LICENSE"


def license_bytes():
    """Source folder keeps it in Tools/dashboard; the GitHub project (and the zip) have it at the root."""
    for rel in (LICENSE_SRC, "LICENSE"):
        path = os.path.join(ROOT, *rel.split("/"))
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
    raise SystemExit("LICENSE not found")


APP = "YouTube Studio Manager"
LAUNCHER_NAME = "YouTubeStudioManager.cmd"
REPO_DEFAULT = os.environ.get("YSM_REPO") or os.path.join(os.path.splitdrive(ROOT)[0] + os.sep, "Project Engineering", "YouTube-Studio-Manager")

GITIGNORE = """\
# user data and credentials: never commit
Secrets/
Data/
Channels/
Tools/youtube/channels.json
*.dpapi
client_secret*.json
token_*.json
# local environment and build output
.venv/
__pycache__/
*.pyc
dist/
*.zip
*.tmp
"""

REQUIREMENTS = """\
google-api-python-client==2.201.0
google-auth==2.62.1
google-auth-httplib2==0.4.4
google-auth-oauthlib==1.5.0
"""

LAUNCHER = r"""@echo off
rem YouTube Studio Manager: local multi-channel YouTube dashboard -> http://127.0.0.1:8765
setlocal
cd /d "%~dp0"
set "VENV=%~dp0Tools\youtube\.venv"
set "PY=%VENV%\Scripts\python.exe"
if exist "%VENV%\.installed" goto run

echo Setting up YouTube Studio Manager for the first time (1-3 minutes)...
if not exist "%PY%" (
  where py >nul 2>nul && py -3 -m venv "%VENV%"
  if not exist "%PY%" python -m venv "%VENV%"
)
if not exist "%PY%" (
  echo.
  echo Python 3.10 or newer is not installed.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run this file again.
  pause
  exit /b 1
)
"%PY%" -m pip install --disable-pip-version-check -q -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo.
  echo Installing the dependencies failed. Check your internet connection, then run this file again.
  pause
  exit /b 1
)
echo ok> "%VENV%\.installed"

:run
echo YouTube Studio Manager (C) 2026 FenomanSKY - free software under the GNU GPL v3, WITHOUT ANY WARRANTY. See LICENSE.
echo YouTube Studio Manager is running. Keep this window open; close it to stop the dashboard.
"%PY%" -I "%~dp0Tools\dashboard\server.py" %*
if errorlevel 1 pause
"""

README = """\
# YouTube Studio Manager

A local dashboard for running several YouTube channels at once: stats, content performance, release
schedule, comments, API quota and sign-ins, all in one place. It runs entirely on your own computer
(http://127.0.0.1:8765) and talks only to Google's APIs.

## Features

- **Overview**: subscribers, views, watch hours and 28-day trends across all channels, plus actionable notes.
- **Channel Comparison**: channels side by side, with traffic sources and top viewer countries.
- **Content Performance**: every video in one sortable, filterable table with retention curves.
- **Calendar & Queue**: weekly release calendar, upload slots and clash warnings between channels.
- **Comments**: latest comments from every channel; reply from the dashboard (always confirmed first).
- **API Quota**: today's YouTube Data API usage per channel (10,000 units/day per Google Cloud project).
- **Channels & Sign-in**: sign-in health, one separate Chrome session per channel and a one-click renew.
- Times are shown in your own time zone; the interface is in English.

## Requirements

- Windows 10/11 (tokens are encrypted with Windows DPAPI)
- Python 3.10 or newer (https://www.python.org/downloads/, tick "Add python.exe to PATH")
- Google Chrome
- The Google account that owns each YouTube channel

## Getting started

1. Download the code (green **Code** button -> **Download ZIP**, or `git clone`) and extract it anywhere,
   for example `Documents\\YouTube-Studio-Manager`.
2. Double-click `YouTubeStudioManager.cmd`. The first time, it creates a Python environment and installs
   the dependencies (needs internet, 1-3 minutes). The dashboard then opens in your browser.
3. On the welcome screen click **Add Channel**, then follow the **Google Cloud guide** in Account info:
   create a project, enable YouTube Data API v3 and YouTube Analytics API, add your email as a Test user
   and create a "Desktop app" OAuth client. The `client_secret_....json` file you download is picked up
   from your Downloads folder automatically.
4. Click **Sign in with Google**, choose the account that owns the channel, then click **Allow**.

Keep the black YouTube Studio Manager window open while you use the dashboard; close it to stop.
The full guide and FAQ are in the **Guide** page inside the dashboard.

## Your data

- OAuth client files are kept in `Secrets\\`; sign-in tokens and API keys are encrypted with Windows DPAPI,
  so only your Windows account can read them.
- Quota stats and the audit log live in `Data\\`, each channel's video folders in `Channels\\`.
- Each channel's Chrome session lives in `%LOCALAPPDATA%\\YouTubeStudioManager\\chrome\\`.
- Never share the `Secrets\\` and `Data\\` folders. They are listed in `.gitignore`.

## Troubleshooting

- **"Access blocked" when signing in**: your Google email is not in the project's Test users list.
- **"Google hasn't verified this app"**: normal for your own app; click Continue.
- **Signing in again every 7 days**: the Google Cloud app is still in Testing mode. Switch it to
  In production under Google Auth Platform -> Audience.
- **Dependencies fail to install**: delete `Tools\\youtube\\.venv`, then run `YouTubeStudioManager.cmd` again.

## For developers

```
Tools/dashboard/server.py      local HTTP server (stdlib, 127.0.0.1 only) + JSON API
Tools/dashboard/accounts.py    add/remove channels, masked credentials, audit log
Tools/dashboard/launcher.py    opens YouTube Studio in each channel's own Chrome session
Tools/dashboard/static/        plain JS/CSS front end, no build step
Tools/youtube/yt.py            YouTube Data/Analytics API + CLI (yt.cmd --ch KEY ...)
Tools/youtube/vault.py         DPAPI-encrypted token storage
```

- Tests: `Tools\\youtube\\.venv\\Scripts\\python.exe -I Tools\\dashboard\\test_release.py`
  (also `Tools\\dashboard\\test_accounts.py` and `Tools\\youtube\\test_vault.py`).
- Release zip: `Tools\\youtube\\.venv\\Scripts\\python.exe -I Tools\\dashboard\\build_release.py` (output in `dist\\`).
  The build fails automatically if any credential file or pattern slips in.
- `channels.json`, `Secrets\\`, `Data\\` and `Channels\\` are user data and are git-ignored.
- Change the port with the `YSM_PORT` environment variable.

## Disclaimer

YouTube Studio Manager is an independent open-source project. It is not affiliated with, endorsed or
sponsored by Google LLC or YouTube. YouTube is a trademark of Google LLC.

## License

Copyright (C) 2026 FenomanSKY.

YouTube Studio Manager is free software under the **GNU General Public License v3** (or any later version);
the full text is in `LICENSE`. You may use, modify and redistribute it, including commercially, as long as
any version you distribute (original or modified) is also released as source under the same GPL license and
keeps the original author's credit. It comes as is, WITHOUT ANY WARRANTY.
"""

# never allowed in the package, by path
FORBIDDEN_PARTS = {"secrets", "data", "channels", "__pycache__", ".venv"}
FORBIDDEN_NAMES = re.compile(r"(^channel_ids\.json$|audit|^token_.*\.json$|^client_secret.*\.json$|\.dpapi$|quota\.json$)", re.I)
# never allowed in any file's content
LEAK_PATTERNS = {
    "OAuth client secret": re.compile(rb"GOCSPX-[A-Za-z0-9_-]{10,}"),
    "OAuth client id": re.compile(rb"\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com"),
    "Google API key": re.compile(rb"AIza[0-9A-Za-z_-]{30,}"),
    "access token": re.compile(rb"ya29\.[0-9A-Za-z_-]{20,}"),
    "refresh token": re.compile(rb"1//0[0-9A-Za-z_-]{20,}"),
    "token JSON": re.compile(rb'"refresh_token"\s*:\s*"[^"]{8,}"'),
    "DPAPI blob": re.compile(rb"\x01\x00\x00\x00\xd0\x8c\x9d\xdf"),
}


def owner_markers():
    """Strings that identify the owner's setup: channel keys, titles, UC ids and Google project ids of the source
    channels.json / channel_ids.json (read from the project, never from Secrets\\)."""
    import json
    out = set()
    try:
        with open(os.path.join(ROOT, "Tools", "youtube", "channels.json"), encoding="utf-8") as f:
            for k, v in json.load(f).items():
                out.add(k)
                out.add(v.get("title") or "")
                folder = (v.get("projects") or "").replace("\\", "/").split("/")
                if len(folder) > 1:
                    out.add(folder[1])
    except (OSError, ValueError):
        pass
    try:
        with open(os.path.join(ROOT, "Data", "dashboard", "channel_ids.json"), encoding="utf-8") as f:
            out.update(json.load(f).values())
    except (OSError, ValueError):
        pass
    return {m for m in out if len(m) >= 4}


def scan(paths_and_bytes, markers=(), need_channels=True):
    """[(relative path, content bytes)] -> list of problems (empty = clean). Problems name the file and the rule,
    never the matched value."""
    problems = []
    for rel, data in paths_and_bytes:
        parts = rel.replace("\\", "/").split("/")
        if {p.lower() for p in parts[:-1]} & FORBIDDEN_PARTS:
            problems.append(f"{rel}: forbidden folder")
        if FORBIDDEN_NAMES.search(parts[-1]) and parts[-1] != "channels.json":
            problems.append(f"{rel}: forbidden file name")
        for name, rx in LEAK_PATTERNS.items():
            if rx.search(data):
                problems.append(f"{rel}: contains {name}")
        low = data.lower()
        for m in markers:
            if re.search(rb"(?<![a-z0-9])" + re.escape(m.lower().encode("utf-8")) + rb"(?![a-z0-9])", low):
                problems.append(f"{rel}: mentions owner data ({len(m)} characters)")
    if need_channels and not any(rel.replace("\\", "/") == "Tools/youtube/channels.json" for rel, _ in paths_and_bytes):
        problems.append("Tools/youtube/channels.json is missing")
    for rel, data in paths_and_bytes:
        if rel.replace("\\", "/") == "Tools/youtube/channels.json" and data.strip() != b"{}":
            problems.append("channels.json is not empty")
    return problems


def scan_zip(path, markers=()):
    with zipfile.ZipFile(path) as z:
        items = [(n.split("/", 1)[1], z.read(n)) for n in z.namelist() if not n.endswith("/") and "/" in n]
    return scan(items, markers)


def build(out_dir, name):
    pkg = os.path.join(out_dir, name)
    if os.path.exists(pkg):
        shutil.rmtree(pkg)  # only ever our own previous build output
    os.makedirs(pkg)
    for rel in FILES:
        dst = os.path.join(pkg, *rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, *rel.split("/")), dst)
    generated = {
        "Tools/youtube/channels.json": "{}\n",
        "requirements.txt": REQUIREMENTS,
        LAUNCHER_NAME: LAUNCHER.replace("\n", "\r\n"),
        "README.md": README,
    }
    for rel, text in generated.items():
        with open(os.path.join(pkg, *rel.split("/")), "w", encoding="utf-8", newline="") as f:
            f.write(text)
    with open(os.path.join(pkg, "LICENSE"), "wb") as f:
        f.write(license_bytes())
    zpath = os.path.join(out_dir, name + ".zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(pkg):
            for fn in sorted(files):
                full = os.path.join(dirpath, fn)
                z.write(full, os.path.join(name, os.path.relpath(full, pkg)).replace("\\", "/"))
    return pkg, zpath


def repo_files():
    """{relative path: bytes} of everything the GitHub project gets."""
    out = {}
    for rel in FILES + DEV_FILES:
        with open(os.path.join(ROOT, *rel.split("/")), "rb") as f:
            out[rel] = f.read()
    for rel, text in {"requirements.txt": REQUIREMENTS, LAUNCHER_NAME: LAUNCHER.replace("\n", "\r\n"),
                      "README.md": README, ".gitignore": GITIGNORE}.items():
        out[rel] = text.encode("utf-8")
    out["LICENSE"] = license_bytes()
    return out


def sync_repo(repo):
    """Write the managed files into the repo folder after a leak scan of exactly those bytes. Returns changed paths."""
    files = repo_files()
    problems = scan(sorted(files.items()), owner_markers(), need_channels=False)
    if problems:
        raise SystemExit("SYNC REFUSED, found:\n  " + "\n  ".join(problems))
    changed = []
    for rel, data in files.items():
        dst = os.path.join(repo, *rel.split("/"))
        try:
            with open(dst, "rb") as f:
                if f.read() == data:
                    continue
        except OSError:
            pass
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(data)
        changed.append(rel)
    return changed


def main():
    p = argparse.ArgumentParser(description=f"Build the shareable {APP} package")
    p.add_argument("--out", default=os.path.join(ROOT, "dist"))
    p.add_argument("--name", default="YouTubeStudioManager-" + dt.date.today().strftime("%Y%m%d"))
    p.add_argument("--repo", nargs="?", const=REPO_DEFAULT, help="sync the standalone GitHub project instead of a zip")
    a = p.parse_args()
    if a.repo:
        repo = os.path.abspath(a.repo)
        if repo.lower().startswith(os.path.abspath(ROOT).lower() + os.sep):
            raise SystemExit("--repo must be outside the source folder")
        changed = sync_repo(repo)
        print(f"OK: {repo} ({len(changed)} file(s) updated), leak check passed")
        for rel in changed:
            print("  " + rel)
        return
    pkg, zpath = build(os.path.abspath(a.out), a.name)
    problems = scan_zip(zpath, owner_markers())
    if problems:
        print("BUILD REFUSED, found:\n  " + "\n  ".join(problems), file=sys.stderr)
        os.remove(zpath)
        sys.exit(1)
    with zipfile.ZipFile(zpath) as z:
        n = len(z.namelist())
    print(f"OK: {zpath} ({n} files, {os.path.getsize(zpath) // 1024} KB), leak check passed")


if __name__ == "__main__":
    main()
