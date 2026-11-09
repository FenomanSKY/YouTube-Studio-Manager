"""StudioPulse: local multi-channel dashboard for all channels in channels.json.

Run from the StudioPulse folder:  StudioPulse.cmd or dashboard.cmd  (or Tools\\youtube\\.venv\\Scripts\\python.exe Tools\\dashboard\\server.py)
Opens http://127.0.0.1:8765. Listens on localhost only.

Reads through Tools/youtube/yt.py (one token per channel in Secrets/, never sent to the browser).
API responses are cached (CACHE_MIN minutes, "Sync" forces a refresh) and every API call is counted against the
channel's daily quota estimate in Data/dashboard/quota.json (each channel has its own Google Cloud project).
Write actions (POSTs need the per-run token): replying to a comment (confirmed in the page), choosing a channel's
Chrome profile (saved to channels.json), and opening YouTube Studio in that profile (launcher.py).
Login health (/api/health) refreshes each token, which costs no YouTube API quota; tokens live in the DPAPI vault.
"""
import datetime as dt
import glob
import json
import re
import os
import secrets
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "Tools", "youtube"))
import yt  # noqa: E402

sys.path.insert(0, HERE)
import launcher  # noqa: E402
import accounts  # noqa: E402
from googleapiclient.errors import HttpError  # noqa: E402

PORT = int(os.environ.get("STUDIOPULSE_PORT") or 8765)
CACHE_MIN = 15
STATIC = os.path.join(HERE, "static")
TOKEN = secrets.token_urlsafe(24)
# where each channel's projects live (folders with upload.json / script.json), from channels.json "projects"
# channels shown here: channels.json "dashboard": false hides one (paused channel); yt.cmd still serves it
SHOWN = [k for k, v in yt.CHANNELS.items() if v.get("dashboard", True)]
PROJECT_DIRS = {k: os.path.join(ROOT, yt.CHANNELS[k]["projects"]) for k in SHOWN if yt.CHANNELS[k].get("projects")}
DAILY_LIMIT = 10000
HEALTH_MIN = 60
CHANNEL_IDS = os.path.join(ROOT, "Data", "dashboard", "channel_ids.json")
CHANNELS_JSON = os.path.join(ROOT, "Tools", "youtube", "channels.json")

api_lock = threading.Lock()
cache = {}


def reload_channels():
    """Re-read channels.json after a channel was added or removed (lists are updated in place)."""
    with api_lock:
        fresh = accounts.load_channels()
        yt.CHANNELS.clear()
        yt.CHANNELS.update(fresh)
        SHOWN[:] = [k for k, v in yt.CHANNELS.items() if v.get("dashboard", True)]
        PROJECT_DIRS.clear()
        PROJECT_DIRS.update({k: os.path.join(ROOT, yt.CHANNELS[k]["projects"]) for k in SHOWN
                             if yt.CHANNELS[k].get("projects")})


# ---------- quota (yt.py counts every API call, CLI included) ----------
def quota_day():
    return str(dt.datetime.now(dt.timezone(dt.timedelta(hours=-8))).date())  # same day key as yt.count_call


def load_quota():
    try:
        with open(yt.QUOTA_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


# ---------- channel access ----------
class ApiError(Exception):
    pass


def use(ch, need_token=True):
    if ch not in SHOWN:
        raise ApiError(f"unknown channel {ch}")
    c = yt.CHANNELS[ch]
    yt.CH, yt.TOKEN = c, os.path.join(yt.SECRETS, c["token"])
    yt.SNAPSHOTS = os.path.join(ROOT, c["snapshots"])
    yt.SLOT_UTC_HOUR = c.get("slot_utc_hour", 20)
    if need_token and not yt.has_token(c):
        raise ApiError(f"Belum login untuk {c['title']}: klik Login Google di menu channel")


def call(ch, key, fn, fresh=False):
    """Run fn() for one channel under the lock, cached by (ch, key)."""
    ck = (ch, key)
    hit = cache.get(ck)
    if hit and not fresh and time.time() - hit[0] < CACHE_MIN * 60:
        return hit[1]
    with api_lock:
        use(ch)
        try:
            data = fn()
        except Exception as e:  # token expired/revoked shows up as RefreshError invalid_grant
            msg = str(e)
            if "invalid_grant" in msg or "RefreshError" in type(e).__name__:
                raise ApiError(f"Token {yt.CH['title']} kedaluwarsa: klik Perpanjang login di menu channel")
            raise
    cache[ck] = (time.time(), data)
    return data


def daily(days=28):
    start, end = yt.date_range(days)
    r = yt.ya().reports().query(ids="channel==MINE", startDate=start, endDate=end, dimensions="day",
                                metrics="views,estimatedMinutesWatched,subscribersGained,subscribersLost",
                                sort="day").execute()
    return {"start": start, "end": end, "days": yt.rows(r)}


def recent_comments(limit_videos=8):
    vids = [v for v in yt.videos(limit_videos) if v["privacy"] == "public"]
    out = []
    for v in vids:
        try:
            for c in yt.comments(v["id"], 20):
                out.append(dict(c, video_id=v["id"], video_title=v["title"]))
        except Exception as e:  # comments disabled on a video
            if "commentsDisabled" not in str(e) and "disabled comments" not in str(e):
                raise
    return sorted(out, key=lambda c: c["published"], reverse=True)


# ---------- local projects ----------
def projects():
    out = []
    for ch, base in PROJECT_DIRS.items():
        for d in sorted(glob.glob(os.path.join(base, "*"))):
            name = os.path.basename(d)
            if not os.path.isdir(d) or name.startswith(("_", ".")):
                continue
            up_path = os.path.join(d, "upload.json")
            meta = {}
            if os.path.exists(up_path):
                with open(up_path, encoding="utf-8-sig") as f:
                    meta = json.load(f)
            if meta.get("deleted_from_youtube"):  # dropped on purpose: not stock, not to be uploaded again
                continue
            video = os.path.join(ROOT, meta["video"]) if meta.get("video") else None
            files = {k: os.path.exists(os.path.join(d, k)) for k in
                     ("description.txt", "thumbnail.jpg", "localizations.json", "captions.en.srt")}
            if meta.get("uploaded"):
                status = "uploaded"
            elif meta and video and os.path.exists(video) and all(files[k] for k in ("description.txt", "thumbnail.jpg")):
                status = "ready"
            elif os.path.exists(os.path.join(d, "web", "shots.js")):
                status = "animating"
            elif os.path.exists(os.path.join(d, "script.json")):
                status = "script"
            else:
                status = "idea"
            out.append({
                "channel": ch, "name": name, "status": status, "title": meta.get("title"),
                "uploaded": meta.get("uploaded"), "files": files,
                "video_mb": round(os.path.getsize(video) / 1e6) if video and os.path.exists(video) else None,
                "modified": dt.datetime.fromtimestamp(os.path.getmtime(d)).isoformat(timespec="minutes"),
            })
    return out


def quota_today():
    q = load_quota().get(quota_day(), {})
    return {"day": quota_day(), "limit": DAILY_LIMIT,
            "channels": {ch: q.get(ch, {"units": 0, "analytics": 0, "calls": {}}) for ch in SHOWN}}


# ---------- HTTP ----------
def channels_meta():
    return [{"key": k, "title": v["title"], "slot_utc_hour": v.get("slot_utc_hour", 20),
             "connected": yt.has_token(v), "pending": v.get("pending", False), "has_client": bool(v.get("client_secret")),
             "chrome_profile": v.get("chrome_profile"), "oauth_mode": v.get("oauth_mode", "testing"),
             "language": v.get("language", "en"), "color": v.get("color")}
            for k, v in yt.CHANNELS.items() if k in SHOWN]


# ---------- manager: login health, Chrome profiles, Studio launcher ----------
health_cache = {}


def health(fresh=False):
    """token_status() per channel, cached HEALTH_MIN minutes. Holds no token values."""
    out = {}
    for ch in SHOWN:
        hit = health_cache.get(ch)
        if hit and not fresh and time.time() - hit[0] < HEALTH_MIN * 60:
            out[ch] = hit[1]
            continue
        with api_lock:
            use(ch, need_token=False)
            try:
                st = yt.token_status()
            except Exception as e:  # one broken channel must not hide the others
                st = {"state": "error", "detail": f"{type(e).__name__}: {e}"[:200]}
        health_cache[ch] = (time.time(), st)
        out[ch] = st
    return out


def load_channel_ids():
    try:
        with open(CHANNEL_IDS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def channel_id(ch):
    """UC... id of the channel, remembered in Data/dashboard/channel_ids.json (1 API unit the first time)."""
    ids = load_channel_ids()
    if ids.get(ch):
        return ids[ch]
    if not yt.has_token(yt.CHANNELS[ch]):
        return None
    cid = call(ch, "channel", yt.channel)["id"]
    ids[ch] = cid
    os.makedirs(os.path.dirname(CHANNEL_IDS), exist_ok=True)
    with open(CHANNEL_IDS, "w", encoding="utf-8") as f:
        json.dump(ids, f, indent=1)
    return cid


config_lock = threading.Lock()


def set_chrome_profile(ch, profile):
    """Save channels.json "chrome_profile" for one channel (None clears it); the file keeps its key order."""
    if ch not in SHOWN:
        raise ApiError(f"unknown channel {ch}")
    if profile and profile not in {p["dir"] for p in launcher.profiles()}:
        raise ApiError(f"Profil Chrome '{profile}' tidak ditemukan")
    with config_lock:
        with open(CHANNELS_JSON, encoding="utf-8") as f:
            cfg = json.load(f)
        if profile:
            cfg[ch]["chrome_profile"] = profile
        else:
            cfg[ch].pop("chrome_profile", None)
        tmp = CHANNELS_JSON + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, CHANNELS_JSON)
        if profile:
            yt.CHANNELS[ch]["chrome_profile"] = profile
        else:
            yt.CHANNELS[ch].pop("chrome_profile", None)
    return {"ch": ch, "chrome_profile": profile}


GCP = {
    "gcp_project": "https://console.cloud.google.com/projectcreate",
    "gcp_enable": "https://console.cloud.google.com/flows/enableapi?apiid=youtube.googleapis.com,youtubeanalytics.googleapis.com",
    "gcp_data": "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
    "gcp_analytics": "https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com",
    "gcp_branding": "https://console.cloud.google.com/auth/branding",
    "gcp_audience": "https://console.cloud.google.com/auth/audience",
    "gcp_client": "https://console.cloud.google.com/auth/clients/create",
}
PROJ_ID = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
YT_ID = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
LC_ID = re.compile(r"^[A-Za-z0-9_.-]{6,160}$")  # reply ids contain a dot


def target_url(kind, cid, vid=None, lc=None):
    """Only these YouTube pages can be opened through the launcher; ids are validated, never a free URL."""
    if kind in (None, "", "channel"):
        return launcher.studio_url(cid)
    if kind in GCP:  # Google Cloud Console pages of the setup guide; project id validated, never a free URL
        url = GCP[kind]
        if vid and kind != "gcp_project":
            if not PROJ_ID.match(vid):
                raise ApiError("project id tidak valid")
            url += ("&" if "?" in url else "?") + "project=" + vid
        return url
    if kind == "public":
        if not cid:
            raise ApiError("Channel ID belum diketahui; login API dulu")
        return f"https://www.youtube.com/channel/{cid}"
    if not vid or not YT_ID.match(vid):
        raise ApiError("video id tidak valid")
    if kind == "edit":
        return f"https://studio.youtube.com/video/{vid}/edit"
    if kind == "analytics":
        return f"https://studio.youtube.com/video/{vid}/analytics"
    if kind == "comments":
        return f"https://studio.youtube.com/video/{vid}/comments"
    if kind == "watch":
        if lc and not LC_ID.match(lc):
            raise ApiError("comment id tidak valid")
        return f"https://www.youtube.com/watch?v={vid}" + (f"&lc={lc}" if lc else "")
    raise ApiError(f"jenis halaman tidak dikenal: {kind}")


def launch(ch, kind=None, vid=None, lc=None):
    """Open a Studio/YouTube page for the channel in its own Chrome session (signed in as the channel's account)."""
    if ch not in SHOWN:
        raise ApiError(f"unknown channel {ch}")
    try:
        cid = channel_id(ch)
    except Exception:  # no id yet: Studio still opens on the profile's own channel
        cid = None
    url = target_url(kind, cid, vid, lc)
    try:
        return launcher.open_studio(ch, yt.CHANNELS[ch].get("chrome_profile"), cid, url=url)
    except launcher.LaunchError as e:
        raise ApiError(str(e))


def open_folder(ch):
    """Open the channel's project folder (channels.json "projects") in Explorer; the path never comes from the page."""
    if ch not in SHOWN:
        raise ApiError(f"unknown channel {ch}")
    rel = yt.CHANNELS[ch].get("projects")
    if not rel:
        raise ApiError("channel ini belum punya folder proyek di channels.json")
    path = os.path.normpath(os.path.join(ROOT, rel))
    if not path.startswith(os.path.join(ROOT, "Channels")):
        raise ApiError("folder proyek di luar Channels\\")
    os.makedirs(path, exist_ok=True)
    os.startfile(path)
    return {"opened": os.path.relpath(path, ROOT)}


def forget_session(ch):
    if ch not in SHOWN:
        raise ApiError(f"unknown channel {ch}")
    try:
        return launcher.forget_session(ch)
    except launcher.LaunchError as e:
        raise ApiError(str(e))


# ---------- OAuth re-login as a background job (yt.py auth --force in its own process) ----------
auth_jobs = {}
AUTH_TIMEOUT_S = 330  # yt.py gives up after 300 s itself


def start_auth(ch):
    """Start `yt.py --ch X auth --force`. The consent page opens in the channel's Chrome session (already signed in),
    so the user only clicks Allow. yt.py refuses a token from a Google account that does not own the channel."""
    if ch not in SHOWN:
        raise ApiError(f"unknown channel {ch}")
    if not yt.CHANNELS[ch].get("client_secret"):
        raise ApiError("Channel ini belum punya file OAuth client (.json). Ikuti Panduan Google Cloud di Informasi akun.")
    job = auth_jobs.get(ch)
    if job and job["proc"].poll() is None:
        return auth_status(ch)
    try:
        channel_id(ch)  # remember the expected channel id so yt.py can check the chosen account
    except Exception:
        pass
    proc = subprocess.Popen([sys.executable, "-I", os.path.join(ROOT, "Tools", "youtube", "yt.py"), "--ch", ch, "auth", "--force"],
                            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    auth_jobs[ch] = {"proc": proc, "started": time.time(), "result": None}
    threading.Thread(target=_collect_auth, args=(ch,), daemon=True).start()
    return auth_status(ch)


def _collect_auth(ch):
    job = auth_jobs[ch]
    try:
        out, err = job["proc"].communicate(timeout=AUTH_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        job["proc"].kill()
        job["result"] = {"state": "failed", "message": "waktu habis (5 menit) sebelum izin diberikan"}
        return
    if job.get("cancelled"):  # cancel_auth() already set the result
        return
    msg = None
    for text in (out, err):  # yt.py prints a JSON object on success and on a refused account
        for line in reversed([l for l in (text or "").strip().splitlines() if l.strip()]):
            if line.lstrip().startswith("{"):
                try:
                    msg = json.loads(line)
                except ValueError:
                    pass
                break
        if msg:
            break
    if not msg:  # pretty-printed success JSON spans lines
        try:
            msg = json.loads(out)
        except (ValueError, TypeError):
            msg = None
    if job["proc"].returncode == 0 and msg and msg.get("ok"):
        job["result"] = {"state": "ok", "message": f"Login diperbarui untuk {msg.get('channel')}"}
        if yt.CHANNELS.get(ch, {}).get("pending") or (msg.get("id") and not load_channel_ids().get(ch)):
            accounts.finish_pending(ch, msg.get("id"))  # new channel: connected now, remember its UC id
            reload_channels()
            job["result"]["message"] = f"Channel {msg.get('channel')} terhubung"
        accounts.audit(ch, "oauth_login", msg.get("channel") or "")
    else:
        last = (msg or {}).get("error") or ((err or "").strip().splitlines() or ["gagal"])[-1]
        job["result"] = {"state": "failed", "message": str(last)[:300]}
    health_cache.pop(ch, None)


def cancel_auth(ch):
    """Stop a login that waits for a click that will not come (tab closed, wrong account). Nothing is saved."""
    if ch not in SHOWN:
        raise ApiError(f"unknown channel {ch}")
    job = auth_jobs.get(ch)
    if job and job["proc"].poll() is None:
        job["cancelled"] = True
        job["result"] = {"state": "cancelled", "message": "Login dibatalkan"}
        job["proc"].kill()
        accounts.audit(ch, "oauth_cancelled")
    return auth_status(ch)


def auth_status(ch=None):
    def one(c):
        job = auth_jobs.get(c)
        if not job:
            return {"state": "idle"}
        if job["result"]:
            return dict(job["result"], started=job["started"])
        return {"state": "running", "started": job["started"], "message": "Menunggu Anda klik Izinkan di jendela Chrome channel"}
    return one(ch) if ch else {c: one(c) for c in SHOWN}


# ---------- accounts: add, info (credentials masked), API key, revoke, remove ----------
def _acct(ch):
    if ch not in SHOWN:
        raise ApiError(f"unknown channel {ch}")
    return yt.CHANNELS[ch]


def account_info(ch):
    c = _acct(ch)
    cf = c.get("client_secret")
    client = accounts.client_info(cf) if cf else {"exists": False}
    hit = health_cache.get(ch)
    key = accounts.get_api_key(ch)
    return {"key": ch, "title": c["title"], "channel_id": load_channel_ids().get(ch), "pending": c.get("pending", False),
            "language": c.get("language", "en"), "slot_utc_hour": c.get("slot_utc_hour", 20),
            "oauth_mode": c.get("oauth_mode", "testing"), "token_file": c["token"],
            "session": launcher.session_info(ch), "health": hit[1] if hit else None,
            "token": accounts.token_facts(c["token"]), "client": client,
            "client_shared_with": [yt.CHANNELS[k]["title"] for k in accounts.client_users(cf) if k != ch] if cf else [],
            "api_key": accounts.mask(key), "units_today": quota_today()["channels"].get(ch, {}).get("units", 0),
            "audit": accounts.audit_log(ch, 15)}


def add_account(b):
    try:
        key = accounts.add_channel(b.get("title"), b.get("client_file") or None, b.get("client_json") or None,
                                   b.get("language") or "id", b.get("slot_utc_hour", 12))
    except accounts.AccountError as e:
        raise ApiError(str(e))
    reload_channels()
    return {"key": key, "title": yt.CHANNELS[key]["title"]}


def replace_client(ch, text):
    _acct(ch)
    try:
        name = accounts.save_client_json(text)
    except accounts.AccountError as e:
        raise ApiError(str(e))
    old = yt.CHANNELS[ch].get("client_secret")
    if name != old:
        def edit(cfg):
            cfg[ch]["client_secret"] = name
        accounts.update_channels(edit)
        reload_channels()
    accounts.audit(ch, "client_json_replaced", f"{old} -> {name}")
    health_cache.pop(ch, None)
    return {"client_secret": name, "changed": name != old}


def download_client(ch, mode="download"):
    c = _acct(ch)
    try:
        with open(accounts._client_path(c.get("client_secret")), encoding="utf-8") as f:
            v = json.dumps(accounts.parse_client_json(f.read())[0], indent=2)
    except (accounts.AccountError, OSError) as e:
        raise ApiError(str(e))
    accounts.audit(ch, "copy_json" if mode == "copy" else "download_json", c.get("client_secret"))
    return {"filename": c.get("client_secret"), "json": v}


def cache_drop(ch):
    for k in [k for k in cache if k[0] == ch]:
        cache.pop(k, None)


def revoke_account(ch):
    c = _acct(ch)
    try:
        res = accounts.revoke(ch, c["token"])
    except Exception as e:
        raise ApiError(f"gagal mencabut: {e}")
    health_cache.pop(ch, None)
    cache_drop(ch)
    return res


def remove_account(ch, confirm, forget_chrome=False):
    c = _acct(ch)
    if (confirm or "").strip() != c["title"]:
        raise ApiError("ketik nama channel persis untuk konfirmasi")
    job = auth_jobs.get(ch)
    if job and job["proc"].poll() is None:
        raise ApiError("login API channel ini masih berjalan; tunggu selesai dulu")
    try:
        res = accounts.remove_channel(ch)
    except accounts.AccountError as e:
        raise ApiError(str(e))
    res["chrome"] = None
    if forget_chrome:
        try:
            res["chrome"] = launcher.forget_session(ch)
        except launcher.LaunchError as e:
            res["chrome"] = {"forgotten": False, "reason": str(e)}
    reload_channels()
    health_cache.pop(ch, None)
    auth_jobs.pop(ch, None)
    cache_drop(ch)
    return res


def import_download(ch, name):
    """Use a client JSON the user just downloaded from Google Cloud: copy it into Secrets, attach it to the channel,
    then remove it from Downloads so the secret does not linger there."""
    _acct(ch)
    try:
        text, path = accounts.take_download(name)
    except accounts.AccountError as e:
        raise ApiError(str(e))
    res = replace_client(ch, text)
    try:
        os.remove(path)
        res["removed_from_downloads"] = True
    except OSError:
        res["removed_from_downloads"] = False
    accounts.audit(ch, "client_json_imported", name)
    return res


def _api_state(fn):
    try:
        fn()
        return {"ok": True}
    except HttpError as e:
        text = str(e) + (e.content.decode("utf-8", "replace") if getattr(e, "content", None) else "")
        off = any(s in text for s in ("accessNotConfigured", "SERVICE_DISABLED", "has not been used in project", "is disabled"))
        msg = re.sub(r"<[^>]+>", "", getattr(e, "reason", "") or str(e))[:200]
        return {"ok": False, "disabled": off, "message": "API belum diaktifkan di project ini" if off else msg}


def check_apis(ch):
    """Is YouTube Data API v3 / YouTube Analytics API enabled in the channel's project? (1 Data API unit)"""
    _acct(ch)
    day = dt.date.today()

    def run():
        return {"data": _api_state(lambda: yt.yt().channels().list(part="id", mine=True).execute()),
                "analytics": _api_state(lambda: yt.ya().reports().query(
                    ids="channel==MINE", startDate=str(day - dt.timedelta(days=7)), endDate=str(day - dt.timedelta(days=3)),
                    metrics="views").execute()),
                "checked_at": accounts.now()}
    return call(ch, "apicheck:" + secrets.token_hex(4), run, True)


def _acct_call(fn, *a):
    try:
        return fn(*a)
    except accounts.AccountError as e:
        raise ApiError(str(e))


GET = {
    "channel": lambda ch, q, fresh: call(ch, "channel", yt.channel, fresh),
    "videos": lambda ch, q, fresh: call(ch, "videos", lambda: yt.videos(100), fresh),
    "analytics": lambda ch, q, fresh: call(ch, "analytics28", lambda: yt.analytics(28), fresh),
    "daily": lambda ch, q, fresh: call(ch, "daily28", lambda: daily(28), fresh),
    "sources": lambda ch, q, fresh: call(ch, "sources28", lambda: yt.sources(28), fresh),
    "retention": lambda ch, q, fresh: call(ch, "ret:" + q["id"][0], lambda: yt.retention(q["id"][0]), fresh),
    "comments": lambda ch, q, fresh: call(ch, "comments", recent_comments, fresh),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def local_only(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            self.send(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        if not self.local_only():
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path.startswith("/api/"):
            name = u.path[5:]
            try:
                if name == "meta":
                    return self.send(200, {"channels": channels_meta(), "cache_min": CACHE_MIN})
                if name == "projects":
                    return self.send(200, projects())
                if name == "quota":
                    return self.send(200, quota_today())
                if name == "health":
                    return self.send(200, health(q.get("fresh") == ["1"]))
                if name == "auth-status":
                    return self.send(200, auth_status())
                if name == "chrome-profiles":
                    return self.send(200, {"profiles": launcher.profiles(), "channel_ids": load_channel_ids(),
                                           "sessions": {ch: launcher.session_info(ch) for ch in SHOWN}})
                if name == "account":
                    return self.send(200, account_info(q["ch"][0]))
                if name == "account/downloads":
                    return self.send(200, accounts.find_downloads())
                if name == "client-files":
                    return self.send(200, accounts.list_client_files())
                if name in GET:
                    return self.send(200, GET[name](q["ch"][0], q, q.get("fresh") == ["1"]))
                return self.send(404, {"error": "not found"})
            except ApiError as e:
                return self.send(409, {"error": str(e)})
            except Exception as e:
                traceback.print_exc()
                return self.send(500, {"error": f"{type(e).__name__}: {e}"[:400]})
        path = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, path))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self.send(404, {"error": "not found"})
        ctype = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
                 ".png": "image/png", ".ico": "image/x-icon"}.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        if path == "index.html":
            body = body.replace(b"__TOKEN__", TOKEN.encode())
        self.send(200, body, ctype + ("; charset=utf-8" if ctype.startswith("text") else ""))

    def do_POST(self):
        if not self.local_only():
            return
        if self.headers.get("X-Token") != TOKEN:
            return self.send(403, {"error": "bad token"})
        u = urlparse(self.path)
        size = int(self.headers.get("Content-Length") or 0)
        if size > 256 * 1024:
            return self.send(413, {"error": "terlalu besar"})
        body = json.loads(self.rfile.read(size) or b"{}")
        try:
            if u.path == "/api/reply":
                text = (body.get("text") or "").strip()
                if not text or not body.get("comment_id"):
                    return self.send(400, {"error": "comment_id and text required"})
                res = call(body["ch"], "reply:" + secrets.token_hex(4), lambda: yt.reply(body["comment_id"], text), True)
                cache.pop((body["ch"], "comments"), None)
                return self.send(200, res)
            if u.path == "/api/launch":
                return self.send(200, launch(body.get("ch"), body.get("kind"), body.get("id"), body.get("lc")))
            if u.path == "/api/chrome-profile":
                return self.send(200, set_chrome_profile(body.get("ch"), body.get("profile") or None))
            if u.path == "/api/auth-cancel":
                return self.send(200, cancel_auth(body.get("ch")))
            if u.path == "/api/auth":
                return self.send(200, start_auth(body.get("ch")))
            if u.path == "/api/open-folder":
                return self.send(200, open_folder(body.get("ch")))
            if u.path == "/api/forget-session":
                return self.send(200, forget_session(body.get("ch")))
            ch = body.get("ch")
            if u.path == "/api/account/add":
                return self.send(200, add_account(body))
            if u.path == "/api/account/reveal":
                if body.get("field") not in ("client_id", "client_secret", "api_key"):
                    return self.send(400, {"error": "field tidak dikenal"})
                return self.send(200, _acct_call(accounts.reveal, ch, _acct(ch), body["field"]))
            if u.path == "/api/account/download":
                return self.send(200, download_client(ch, body.get("mode")))
            if u.path == "/api/account/client-json":
                return self.send(200, replace_client(ch, body.get("json") or ""))
            if u.path == "/api/account/apikey":
                _acct(ch)
                return self.send(200, _acct_call(accounts.set_api_key, ch, body.get("key")))
            if u.path == "/api/account/apikey-remove":
                _acct(ch)
                return self.send(200, accounts.remove_api_key(ch))
            if u.path == "/api/account/apikey-test":
                _acct(ch)
                return self.send(200, _acct_call(accounts.test_api_key, ch, load_channel_ids().get(ch)))
            if u.path == "/api/account/import-json":
                return self.send(200, import_download(ch, body.get("name")))
            if u.path == "/api/account/check-apis":
                return self.send(200, check_apis(ch))
            if u.path == "/api/account/revoke":
                return self.send(200, revoke_account(ch))
            if u.path == "/api/account/remove":
                return self.send(200, remove_account(ch, body.get("confirm"), bool(body.get("forget_chrome"))))
            return self.send(404, {"error": "not found"})
        except ApiError as e:
            return self.send(409, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            return self.send(500, {"error": f"{type(e).__name__}: {e}"[:400]})


def already_running():
    """True when something already listens on PORT (Windows would let a second server bind the same port)."""
    import socket
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False


def main():
    url = f"http://127.0.0.1:{PORT}/"
    if already_running():
        print(f"StudioPulse sudah berjalan di {url} (port {PORT} terpakai). Membuka browser saja; "
              "untuk restart, tutup jendela StudioPulse yang lama dulu.")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"StudioPulse running at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
