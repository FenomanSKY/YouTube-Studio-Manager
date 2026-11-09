"""Build a shareable StudioPulse package: a folder plus a .zip with the code only, none of the owner's data.

Run (from the project root):  Tools\\youtube\\.venv\\Scripts\\python.exe -I Tools\\dashboard\\build_release.py [--out DIR]
Default output: dist\\StudioPulse-YYYYMMDD\\ and dist\\StudioPulse-YYYYMMDD.zip next to Tools\\.

Only the files listed in FILES are copied (an allowlist, never a folder walk), so Secrets\\, Data\\, Channels\\,
channel_ids.json, the credential audit log and the owner's channels.json can never slip in. channels.json is written
fresh as {}. After building, scan() checks the result for secret-looking content and fails the build on any hit.

--repo [DIR] syncs the standalone GitHub project instead (default D:\\Project Engineering\\StudioPulse): the same files
plus tests, this script, .gitignore and README; channels.json is left out (created on first run, ignored by git).
Only files this script manages are written there; anything else in DIR is left alone. Project AI stays the source.
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
REPO_DEFAULT = r"D:\Project Engineering\StudioPulse"

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
rem StudioPulse: dasbor YouTube multi-channel lokal -> http://127.0.0.1:8765
setlocal
cd /d "%~dp0"
set "VENV=%~dp0Tools\youtube\.venv"
set "PY=%VENV%\Scripts\python.exe"
if exist "%VENV%\.installed" goto run

echo Menyiapkan StudioPulse untuk pertama kali (1-3 menit)...
if not exist "%PY%" (
  where py >nul 2>nul && py -3 -m venv "%VENV%"
  if not exist "%PY%" python -m venv "%VENV%"
)
if not exist "%PY%" (
  echo.
  echo Python 3.10 atau lebih baru belum terpasang.
  echo Pasang dari https://www.python.org/downloads/ ^(centang "Add python.exe to PATH"^), lalu jalankan file ini lagi.
  pause
  exit /b 1
)
"%PY%" -m pip install --disable-pip-version-check -q -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo.
  echo Gagal memasang dependensi. Periksa koneksi internet, lalu jalankan file ini lagi.
  pause
  exit /b 1
)
echo ok> "%VENV%\.installed"

:run
echo StudioPulse berjalan. Biarkan jendela ini terbuka; tutup jendela ini untuk menghentikan dasbor.
"%PY%" -I "%~dp0Tools\dashboard\server.py" %*
if errorlevel 1 pause
"""

README = """\
# StudioPulse

Dasbor lokal untuk mengelola beberapa channel YouTube sekaligus: statistik, performa konten, jadwal,
komentar, kuota API, dan login. Semuanya berjalan di komputer Anda sendiri (http://127.0.0.1:8765).

## Yang dibutuhkan

- Windows 10/11
- Python 3.10 atau lebih baru (https://www.python.org/downloads/, centang "Add python.exe to PATH")
- Google Chrome
- Akun Google pemilik channel YouTube

## Cara mulai

1. Ekstrak zip ini ke folder mana saja, misalnya `Documents\\StudioPulse`.
2. Klik dua kali `StudioPulse.cmd`. Saat pertama kali, file ini menyiapkan Python dan memasang
   dependensi (butuh internet, 1-3 menit). Setelah itu dasbor langsung terbuka di browser.
3. Di layar sambutan, klik **Tambah Channel**, lalu ikuti **Panduan Google Cloud** di Informasi akun:
   buat project, aktifkan YouTube Data API v3 dan YouTube Analytics API, tambahkan email Anda sebagai
   Test user, lalu buat OAuth client jenis "Desktop app". File `client_secret_....json` yang Anda unduh
   diambil otomatis dari folder Downloads.
4. Klik **Login Google**, pilih akun pemilik channel, lalu klik **Izinkan**.

Biarkan jendela hitam StudioPulse terbuka selama memakai dasbor. Tutup jendela itu untuk menghentikannya.
Panduan lengkap dan FAQ ada di menu **Panduan** di dalam dasbor.

## Data Anda

- File OAuth client disimpan di folder `Secrets\\`; token login dan API key dienkripsi Windows (DPAPI),
  sehingga hanya bisa dibuka oleh akun Windows Anda.
- Statistik kuota dan catatan audit ada di `Data\\`, folder video tiap channel di `Channels\\`.
- Sesi Chrome tiap channel ada di `%LOCALAPPDATA%\\StudioPulse\\chrome\\`.
- Jangan membagikan folder `Secrets\\` dan `Data\\` ke orang lain.

## Masalah umum

- **"Access blocked" saat login**: email Google Anda belum ada di daftar Test users project Google Cloud.
- **"Google hasn't verified this app"**: normal untuk app milik Anda sendiri; klik Continue.
- **Harus login ulang tiap 7 hari**: app Google Cloud masih mode Testing. Ubah ke In production di
  Google Auth Platform -> Audience.
- **Dependensi gagal terpasang**: hapus folder `Tools\\youtube\\.venv`, lalu jalankan `StudioPulse.cmd` lagi.

## Untuk developer

```
Tools/dashboard/server.py      server HTTP lokal (stdlib, hanya 127.0.0.1) + API JSON
Tools/dashboard/accounts.py    tambah/hapus channel, kredensial tersamar, log audit
Tools/dashboard/launcher.py    membuka YouTube Studio di sesi Chrome khusus tiap channel
Tools/dashboard/static/        frontend plain JS/CSS, tanpa build step
Tools/youtube/yt.py            YouTube Data/Analytics API + CLI (yt.cmd --ch KUNCI ...)
Tools/youtube/vault.py         penyimpanan token terenkripsi DPAPI
```

- Tes: `Tools\\youtube\\.venv\\Scripts\\python.exe -I Tools\\dashboard\\test_release.py`
  (juga `Tools\\dashboard\\test_accounts.py` dan `Tools\\youtube\\test_vault.py`).
- Zip rilis: `Tools\\youtube\\.venv\\Scripts\\python.exe -I Tools\\dashboard\\build_release.py` (hasil di `dist\\`).
  Build otomatis gagal kalau ada file atau pola kredensial yang ikut.
- `channels.json`, `Secrets\\`, `Data\\`, dan `Channels\\` adalah data pengguna dan sudah masuk `.gitignore`.
- Port bisa diganti lewat variabel lingkungan `STUDIOPULSE_PORT`.
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
            problems.append(f"{rel}: folder terlarang")
        if FORBIDDEN_NAMES.search(parts[-1]) and parts[-1] != "channels.json":
            problems.append(f"{rel}: nama file terlarang")
        for name, rx in LEAK_PATTERNS.items():
            if rx.search(data):
                problems.append(f"{rel}: berisi {name}")
        low = data.lower()
        for m in markers:
            if re.search(rb"(?<![a-z0-9])" + re.escape(m.lower().encode("utf-8")) + rb"(?![a-z0-9])", low):
                problems.append(f"{rel}: menyebut data pemilik ({len(m)} karakter)")
    if need_channels and not any(rel.replace("\\", "/") == "Tools/youtube/channels.json" for rel, _ in paths_and_bytes):
        problems.append("Tools/youtube/channels.json tidak ada")
    for rel, data in paths_and_bytes:
        if rel.replace("\\", "/") == "Tools/youtube/channels.json" and data.strip() != b"{}":
            problems.append("channels.json tidak kosong")
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
        "StudioPulse.cmd": LAUNCHER.replace("\n", "\r\n"),
        "README.md": README,
    }
    for rel, text in generated.items():
        with open(os.path.join(pkg, *rel.split("/")), "w", encoding="utf-8", newline="") as f:
            f.write(text)
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
    for rel, text in {"requirements.txt": REQUIREMENTS, "StudioPulse.cmd": LAUNCHER.replace("\n", "\r\n"),
                      "README.md": README, ".gitignore": GITIGNORE}.items():
        out[rel] = text.encode("utf-8")
    return out


def sync_repo(repo):
    """Write the managed files into the repo folder after a leak scan of exactly those bytes. Returns changed paths."""
    files = repo_files()
    problems = scan(sorted(files.items()), owner_markers(), need_channels=False)
    if problems:
        raise SystemExit("SYNC DITOLAK, ditemukan:\n  " + "\n  ".join(problems))
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
    p = argparse.ArgumentParser(description="Build the shareable StudioPulse package")
    p.add_argument("--out", default=os.path.join(ROOT, "dist"))
    p.add_argument("--name", default="StudioPulse-" + dt.date.today().strftime("%Y%m%d"))
    p.add_argument("--repo", nargs="?", const=REPO_DEFAULT, help="sync the standalone GitHub project instead of a zip")
    a = p.parse_args()
    if a.repo:
        repo = os.path.abspath(a.repo)
        if repo.lower().startswith(os.path.abspath(ROOT).lower() + os.sep):
            raise SystemExit("--repo harus di luar folder sumber")
        changed = sync_repo(repo)
        print(f"OK: {repo} ({len(changed)} file diperbarui), lolos cek kebocoran")
        for rel in changed:
            print("  " + rel)
        return
    pkg, zpath = build(os.path.abspath(a.out), a.name)
    problems = scan_zip(zpath, owner_markers())
    if problems:
        print("BUILD DITOLAK, ditemukan:\n  " + "\n  ".join(problems), file=sys.stderr)
        os.remove(zpath)
        sys.exit(1)
    with zipfile.ZipFile(zpath) as z:
        n = len(z.namelist())
    print(f"OK: {zpath} ({n} file, {os.path.getsize(zpath) // 1024} KB), lolos cek kebocoran")


if __name__ == "__main__":
    main()
