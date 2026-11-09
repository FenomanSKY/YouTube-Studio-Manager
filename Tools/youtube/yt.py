"""YouTube tool for the channels in channels.json: upload, stats, comments, and analytics snapshots.

Pick a channel with --ch KEY before the command (default: env YT_CHANNEL, else the first channel), e.g.
  Tools\\youtube\\yt.cmd --ch mychannel channel

Usage (from the YouTube Studio Manager folder):
  Tools\\youtube\\yt.cmd auth [--force]             browser login (--force = fresh login, resets 7-day expiry)
  Tools\\youtube\\yt.cmd channel                    channel info + totals
  Tools\\youtube\\yt.cmd videos [--limit N]         recent uploads with public stats
  Tools\\youtube\\yt.cmd analytics [--days N]       per-video analytics (views, watch time, retention %, subs)
  Tools\\youtube\\yt.cmd retention VIDEO_ID         audience retention curve
  Tools\\youtube\\yt.cmd sources [--days N]         traffic sources and top countries
  Tools\\youtube\\yt.cmd comments VIDEO_ID [--limit N]
  Tools\\youtube\\yt.cmd reply COMMENT_ID "text"
  Tools\\youtube\\yt.cmd comment VIDEO_ID "text"
  Tools\\youtube\\yt.cmd upload FILE --title T [--description-file F] [--tags a,b] [--privacy private]
                                 [--publish-at 2026-11-10T15:00:00Z | --schedule] [--thumbnail F] [--playlist ID]
                                 [--captions F.srt] [--localizations F.json]
  Tools\\youtube\\yt.cmd captions VIDEO_ID FILE.srt [--lang en]    add/replace a subtitle track
  Tools\\youtube\\yt.cmd localize VIDEO_ID FILE.json              translated titles/descriptions {"es": {"title", "description"}}
  Tools\\youtube\\yt.cmd branding [--banner F.png] [--info F.md] [--country ID]
                                 channel banner + description/keywords (from the "## Deskripsi/Keyword channel" sections)
  Tools\\youtube\\yt.cmd next-slot                                next publish slot of the channel (UTC)
  Tools\\youtube\\yt.cmd token-status                     login health (vault/plain, days left in Testing mode)
  Tools\\youtube\\yt.cmd vault-migrate                    encrypt the plain token into Secrets/vault (DPAPI)
  Tools\\youtube\\yt.cmd vault-remove-plain               plain token file to the Recycle Bin (user's OK only)
  Tools\\youtube\\yt.cmd snapshot [--days N]        save everything to the channel's "snapshots" folder (YYYY-MM-DD.json)

--schedule uploads as private and publishes at the next US prime-time slot (SLOT_UTC_HOUR, 20:00 UTC = 3 pm New York
in winter / 4 pm in summer, 03:00 WIB), at least 2 hours from now.

All output is JSON. Never print or copy anything from Secrets/.
"""
import argparse
import datetime as dt
import glob
import json
import os
import sys

from google.auth.exceptions import RefreshError, TransportError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import HttpRequest, MediaFileUpload

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vault  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SECRETS = os.path.join(ROOT, "Secrets")
# One entry per channel: which OAuth client and token file in Secrets/, and where snapshots go.
# Pick with --ch KEY (before the command) or env YT_CHANNEL; default: the first channel. An empty channels.json ({}) is
# valid: the dashboard starts on its welcome screen and CH stays a placeholder until a channel is added.
_CHANNELS_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "channels.json")
if not os.path.exists(_CHANNELS_JSON):  # fresh checkout or package: start empty (channels.json is user data, not in git)
    with open(_CHANNELS_JSON, "w", encoding="utf-8") as _f:
        _f.write("{}\n")
with open(_CHANNELS_JSON, encoding="utf-8") as _f:
    CHANNELS = json.load(_f)
CH = next(iter(CHANNELS.values()), {"title": "", "token": "token_none.json", "snapshots": "Data/snapshots"})
TOKEN = os.path.join(SECRETS, CH["token"])
SNAPSHOTS = os.path.join(ROOT, CH["snapshots"])
SLOT_UTC_HOUR = 20
QUOTA_FILE = os.path.join(ROOT, "Data", "dashboard", "quota.json")
# YouTube Data API v3 unit costs (anything else costs 1); Analytics API has its own quota, counted as requests
QUOTA_COST = {"youtube.videos.insert": 1600, "youtube.captions.insert": 400, "youtube.thumbnails.set": 50,
              "youtube.comments.insert": 50, "youtube.videos.update": 50, "youtube.videos.delete": 50,
              "youtube.search.list": 100, "youtube.playlistItems.insert": 50,
              "youtube.channelBanners.insert": 50, "youtube.channels.update": 50}
SCOPES = [
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]


def vault_path(cfg=None):
    return vault.path_for(SECRETS, (cfg or CH)["token"])


def has_token(cfg=None):
    cfg = cfg or CH
    return os.path.exists(vault_path(cfg)) or os.path.exists(os.path.join(SECRETS, cfg["token"]))


def _stored():
    """(Credentials or None, vault record or None). The vault wins; the old plain token file is the fallback."""
    rec = vault.load(vault_path())
    if rec:
        return Credentials.from_authorized_user_info(rec["token"], SCOPES), rec
    if os.path.exists(TOKEN):
        return Credentials.from_authorized_user_file(TOKEN, SCOPES), None
    return None, None


def _keep(c, rec, login_at=None):
    """Save to the vault (never back to the plain file). A token read from the plain file is marked as migrated."""
    vault.save(vault_path(), json.loads(c.to_json()), login_at=login_at,
               migrated_from=None if rec or login_at else (CH["token"] if os.path.exists(TOKEN) else None), keep=rec)


def creds(force=False):
    # force: login baru walau token lama masih jalan (Testing mode: refresh token mati 7 hari setelah login)
    if force:
        c = None
        try:
            rec = vault.load(vault_path())
        except vault.VaultError:
            rec = None
    else:
        c, rec = _stored()
    if c and c.valid:
        return c
    login_at = None
    if c and c.expired and c.refresh_token:
        c.refresh(Request())
    else:
        if not CH.get("client_secret"):
            sys.exit(json.dumps({"ok": False, "error": "this channel has no OAuth client file (.json) yet; follow the Google Cloud guide in the dashboard"}))
        secret = os.path.join(SECRETS, CH["client_secret"])
        if not os.path.exists(secret):
            sys.exit(f"Missing {CH['client_secret']} in {SECRETS}")
        c = _login(secret)
        login_at = vault.now()
    _keep(c, rec, login_at)
    return c


CHANNEL_IDS = os.path.join(ROOT, "Data", "dashboard", "channel_ids.json")
USE_CHROME_SESSION = True  # auth opens Google in the channel's own YouTube Studio Manager Chrome session when one exists


def ch_key():
    return next((k for k, v in CHANNELS.items() if v is CH), None)


def _login(secret):
    """Browser OAuth login. When the dashboard has a Chrome session for this channel (Open Studio), the consent page
    opens there, already signed in to the channel's Google account, so the user only clicks Allow."""
    flow = InstalledAppFlow.from_client_secrets_file(secret, SCOPES)
    key, browser, hint = ch_key(), None, {}
    if USE_CHROME_SESSION and key:
        sys.path.insert(0, os.path.join(ROOT, "Tools", "dashboard"))
        try:
            import launcher
            # always the channel's own Chrome session: a new channel signs in to Google there once, and that same
            # login then serves Studio too (no session yet = Chrome creates the folder and shows Google's sign-in)
            emails = launcher.session_info(key)["emails"] if launcher.has_session(key) else []
            browser = launcher.register_session_browser(key)
            if len(emails) == 1:
                hint = {"login_hint": emails[0]}
        except Exception as e:  # never block a login because of the dashboard helper
            print(f"Chrome session not used: {e}", file=sys.stderr)
    # prompt=consent always returns a new refresh token; select_account when the account is not known yet
    prompt = "consent" if hint else "select_account consent"
    return flow.run_local_server(port=0, browser=browser, prompt=prompt, timeout_seconds=300,
                                 authorization_prompt_message="", **hint)


def _known_channel_id():
    try:
        with open(CHANNEL_IDS, encoding="utf-8") as f:
            return json.load(f).get(ch_key())
    except (OSError, ValueError):
        return None


def auth(force=False):
    """Login (force: fresh consent) and make sure the Google account owns THIS channel before keeping the token."""
    expected = _known_channel_id()
    if not force:
        c = creds()
    else:
        if not CH.get("client_secret"):
            sys.exit(json.dumps({"ok": False, "error": "this channel has no OAuth client file (.json) yet; follow the Google Cloud guide in the dashboard"}))
        secret = os.path.join(SECRETS, CH["client_secret"])
        if not os.path.exists(secret):
            sys.exit(f"Missing {CH['client_secret']} in {SECRETS}")
        try:
            rec = vault.load(vault_path())
        except vault.VaultError:
            rec = None
        c = _login(secret)
        api = build("youtube", "v3", credentials=c, cache_discovery=False)
        items = api.channels().list(part="snippet", mine=True).execute().get("items", [])
        got = items[0]["id"] if items else None
        name = items[0]["snippet"]["title"] if items else "account without a channel"
        if not got:
            sys.exit(json.dumps({"ok": False, "error": "the selected Google account has no YouTube channel; the token was NOT saved"}))
        if expected and got != expected:
            sys.exit(json.dumps({"ok": False, "error": f"the selected Google account owns '{name}', not {CH['title']}; "
                                                      "the token was NOT saved"}, ensure_ascii=False))
        taken = _channel_taken(got)
        if taken:
            sys.exit(json.dumps({"ok": False, "error": f"channel '{name}' is already registered as {CHANNELS[taken]['title']}; "
                                                      "the token was NOT saved"}, ensure_ascii=False))
        _keep(c, rec, vault.now())
        return {"ok": True, "channel": name, "id": got}
    return {"ok": True, "channel": channel()["title"]}


def _channel_taken(cid):
    """Key of ANOTHER channel in channels.json already mapped to this UC id (a new channel must not duplicate one)."""
    try:
        with open(CHANNEL_IDS, encoding="utf-8") as f:
            ids = json.load(f)
    except (OSError, ValueError):
        return None
    me = ch_key()
    return next((k for k, v in ids.items() if v == cid and k != me and k in CHANNELS), None)


REFRESH_DAYS_TESTING = 7  # Google drops refresh tokens of OAuth apps in "Testing" status 7 days after login


def token_status():
    """Health of the current channel's login, checked with a token refresh (costs no YouTube API quota).
    state: ok | expiring | unknown_age | expired | missing | offline | error. Never returns token values."""
    mode = CH.get("oauth_mode", "testing")
    base = {"oauth_mode": mode, "plain_file": os.path.exists(TOKEN), "checked_at": vault.now()}
    try:
        c, rec = _stored()
    except vault.VaultError as e:
        return dict(base, state="error", store="vault", detail=str(e))
    if not c:
        return dict(base, state="missing", store=None, detail="not signed in")
    base.update(store="vault" if rec else "plain", login_at=(rec or {}).get("login_at"),
                migrated_from=(rec or {}).get("migrated_from"))
    try:
        c.refresh(Request())
    except RefreshError as e:
        bad = "invalid_grant" in str(e)
        return dict(base, state="expired" if bad else "error",
                    detail="Google rejected the refresh token; sign in again" if bad else str(e)[:200])
    except TransportError as e:
        return dict(base, state="offline", detail=str(e)[:200])
    if rec:  # keep the fresh access token; a plain-file token is only migrated by vault-migrate
        vault.save(vault_path(), json.loads(c.to_json()), keep=rec)
    res = dict(base, state="ok", expires_at=None, days_left=None)
    if mode == "testing":
        if not res["login_at"]:
            res.update(state="unknown_age", detail="login age unknown (old token); sign in again to start tracking it")
        else:
            exp = dt.datetime.fromisoformat(res["login_at"]) + dt.timedelta(days=REFRESH_DAYS_TESTING)
            left = (exp - dt.datetime.now(dt.timezone.utc)).total_seconds() / 86400
            res.update(expires_at=exp.isoformat(timespec="seconds"), days_left=round(left, 1))
            if left < 2:
                res.update(state="expiring", detail=f"refresh token mati dalam {max(left, 0):.1f} hari")
    return res


def vault_migrate():
    """Copy the plain token file into the vault after a successful refresh. The plain file is left in place."""
    if os.path.exists(vault_path()):
        return {"migrated": False, "reason": "vault already exists"}
    if not os.path.exists(TOKEN):
        return {"migrated": False, "reason": "no plain token file"}
    c = Credentials.from_authorized_user_file(TOKEN, SCOPES)
    try:
        c.refresh(Request())
    except RefreshError as e:
        return {"migrated": False, "reason": "the old token is no longer valid: " + str(e)[:120]}
    vault.save(vault_path(), json.loads(c.to_json()), migrated_from=CH["token"])
    ok = vault.load(vault_path())["token"].get("refresh_token") == c.refresh_token
    return {"migrated": ok, "vault": os.path.relpath(vault_path(), ROOT)}


def vault_remove_plain():
    """Move the plain token file to the Recycle Bin, only when the vault copy decrypts and refreshes."""
    if not os.path.exists(TOKEN):
        return {"removed": False, "reason": "no plain token file"}
    rec = vault.load(vault_path())
    if not rec:
        return {"removed": False, "reason": "not in the vault yet; run vault-migrate first"}
    c = Credentials.from_authorized_user_info(rec["token"], SCOPES)
    c.refresh(Request())
    import subprocess
    ps = ("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("
          "$env:SP_FILE, 'OnlyErrorDialogs', 'SendToRecycleBin')")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, env=dict(os.environ, SP_FILE=TOKEN))
    return {"removed": not os.path.exists(TOKEN), "to": "Recycle Bin"}


def count_call(method_id):
    """Add one API call to today's per-channel estimate (quota day = Pacific time, like YouTube)."""
    day = str(dt.datetime.now(dt.timezone(dt.timedelta(hours=-8))).date())
    ch = next((k for k, v in CHANNELS.items() if v is CH), "?")
    try:
        with open(QUOTA_FILE, encoding="utf-8") as f:
            q = json.load(f)
    except (OSError, ValueError):
        q = {}
    rec = q.setdefault(day, {}).setdefault(ch, {"units": 0, "analytics": 0, "calls": {}})
    if method_id.startswith("youtubeAnalytics"):
        rec["analytics"] += 1
    else:
        rec["units"] += QUOTA_COST.get(method_id, 1)
    rec["calls"][method_id] = rec["calls"].get(method_id, 0) + 1
    for d in sorted(q)[:-14]:
        del q[d]
    os.makedirs(os.path.dirname(QUOTA_FILE), exist_ok=True)
    with open(QUOTA_FILE, "w", encoding="utf-8") as f:
        json.dump(q, f, indent=1)


_execute = HttpRequest.execute


def _counted_execute(self, *a, **k):
    try:
        count_call(getattr(self, "methodId", None) or "unknown")
    except Exception:  # counting must never break an API call
        pass
    return _execute(self, *a, **k)


HttpRequest.execute = _counted_execute


def yt():
    return build("youtube", "v3", credentials=creds(), cache_discovery=False)


def ya():
    return build("youtubeAnalytics", "v2", credentials=creds(), cache_discovery=False)


def out(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def date_range(days):
    end = dt.date.today()
    return str(end - dt.timedelta(days=days)), str(end)


def rows(resp):
    cols = [h["name"] for h in resp.get("columnHeaders", [])]
    return [dict(zip(cols, r)) for r in resp.get("rows", [])]


def channel():
    r = yt().channels().list(part="snippet,statistics,contentDetails", mine=True).execute()
    ch = r["items"][0]
    return {
        "id": ch["id"],
        "title": ch["snippet"]["title"],
        "handle": ch["snippet"].get("customUrl"),
        "thumbnail": ch["snippet"].get("thumbnails", {}).get("default", {}).get("url"),
        "uploads_playlist": ch["contentDetails"]["relatedPlaylists"]["uploads"],
        "stats": ch["statistics"],
    }


def videos(limit=50):
    api = yt()
    uploads = channel()["uploads_playlist"]
    ids, token = [], None
    while len(ids) < limit:
        r = api.playlistItems().list(part="contentDetails", playlistId=uploads,
                                     maxResults=min(50, limit - len(ids)), pageToken=token).execute()
        ids += [i["contentDetails"]["videoId"] for i in r["items"]]
        token = r.get("nextPageToken")
        if not token:
            break
    result = []
    for i in range(0, len(ids), 50):
        r = api.videos().list(part="snippet,statistics,contentDetails,status",
                              id=",".join(ids[i:i + 50])).execute()
        for v in r["items"]:
            result.append({
                "id": v["id"],
                "title": v["snippet"]["title"],
                "published": v["snippet"]["publishedAt"],
                "duration": v["contentDetails"]["duration"],
                "privacy": v["status"]["privacyStatus"],
                "publish_at": v["status"].get("publishAt"),
                "thumbnail": v["snippet"].get("thumbnails", {}).get("medium", {}).get("url"),
                "tags": v["snippet"].get("tags", []),
                "description": v["snippet"].get("description", "")[:300],
                "stats": v["statistics"],
            })
    return result


def analytics(days=28):
    start, end = date_range(days)
    r = ya().reports().query(
        ids="channel==MINE", startDate=start, endDate=end, dimensions="video",
        metrics="views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,"
                "likes,comments,shares,subscribersGained",
        sort="-views", maxResults=200).execute()
    return {"start": start, "end": end, "videos": rows(r)}


def retention(video_id):
    r = ya().reports().query(
        ids="channel==MINE", startDate="2020-01-01", endDate=str(dt.date.today()),
        dimensions="elapsedVideoTimeRatio", filters=f"video=={video_id}",
        metrics="audienceWatchRatio,relativeRetentionPerformance").execute()
    return rows(r)


def sources(days=28):
    start, end = date_range(days)
    api = ya()
    traffic = api.reports().query(ids="channel==MINE", startDate=start, endDate=end,
                                  dimensions="insightTrafficSourceType", metrics="views,estimatedMinutesWatched",
                                  sort="-views").execute()
    country = api.reports().query(ids="channel==MINE", startDate=start, endDate=end,
                                  dimensions="country", metrics="views,estimatedMinutesWatched",
                                  sort="-views", maxResults=15).execute()
    return {"start": start, "end": end, "traffic": rows(traffic), "countries": rows(country)}


def comments(video_id, limit=100):
    r = yt().commentThreads().list(part="snippet", videoId=video_id, maxResults=min(100, limit),
                                   order="relevance", textFormat="plainText").execute()
    return [{
        "id": t["snippet"]["topLevelComment"]["id"],
        "author": t["snippet"]["topLevelComment"]["snippet"]["authorDisplayName"],
        "text": t["snippet"]["topLevelComment"]["snippet"]["textDisplay"],
        "likes": t["snippet"]["topLevelComment"]["snippet"]["likeCount"],
        "replies": t["snippet"]["totalReplyCount"],
        "published": t["snippet"]["topLevelComment"]["snippet"]["publishedAt"],
    } for t in r["items"]]


def reply(comment_id, text):
    r = yt().comments().insert(part="snippet",
                               body={"snippet": {"parentId": comment_id, "textOriginal": text}}).execute()
    return {"id": r["id"], "text": r["snippet"]["textOriginal"]}


def comment(video_id, text):
    """Post a new top-level comment. The API cannot pin it: pinning is done by hand in Studio or on the video."""
    r = yt().commentThreads().insert(part="snippet", body={"snippet": {
        "videoId": video_id, "topLevelComment": {"snippet": {"textOriginal": text}}}}).execute()
    return {"id": r["snippet"]["topLevelComment"]["id"], "text": r["snippet"]["topLevelComment"]["snippet"]["textOriginal"]}


def next_slot(min_hours=2, fmt=None):
    """Next publish slot of the channel. A channel can give Shorts their own time: "slot_utc_short": "04:30"."""
    now = dt.datetime.now(dt.timezone.utc)
    hour, minute = SLOT_UTC_HOUR, 0
    if fmt == "short" and CH.get("slot_utc_short"):
        hour, minute = map(int, CH["slot_utc_short"].split(":"))
    slot = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    while slot < now + dt.timedelta(hours=min_hours):
        slot += dt.timedelta(days=1)
    return slot.strftime("%Y-%m-%dT%H:%M:%SZ")


LANG_NAMES = {"en": "English", "id": "Bahasa Indonesia"}


def lang():
    return CH.get("language", "en")


def captions(video_id, path, lang=None, name=None):
    lang = lang or CH.get("language", "en")
    name = name or LANG_NAMES.get(lang, lang)
    r = yt().captions().insert(part="snippet", body={"snippet": {
        "videoId": video_id, "language": lang, "name": name, "isDraft": False}},
        media_body=MediaFileUpload(path, mimetype="application/octet-stream")).execute()
    return {"caption_id": r["id"], "language": lang}


def localize(video_id, path):
    with open(path, encoding="utf-8") as f:
        locs = json.load(f)
    api = yt()
    v = api.videos().list(part="snippet,localizations", id=video_id).execute()["items"][0]
    sn = v["snippet"]
    snippet = {k: sn[k] for k in ("title", "description", "categoryId", "tags", "defaultLanguage") if k in sn}
    snippet.setdefault("defaultLanguage", lang())
    merged = dict(v.get("localizations", {}), **locs)
    api.videos().update(part="snippet,localizations",
                        body={"id": video_id, "snippet": snippet, "localizations": merged}).execute()
    return {"localized": sorted(merged)}


def reschedule(video_id, when):
    api = yt()
    st = api.videos().list(part="status", id=video_id).execute()["items"][0]["status"]
    body = {"id": video_id, "status": {"privacyStatus": "private", "publishAt": when, "selfDeclaredMadeForKids": st.get("selfDeclaredMadeForKids", False)}}
    resp = api.videos().update(part="status", body=body).execute()
    return {"id": video_id, "privacy": resp["status"]["privacyStatus"], "publish_at": resp["status"].get("publishAt")}


def upload(a):
    description = ""
    if a.description_file:
        with open(a.description_file, encoding="utf-8") as f:
            description = f.read()
    status = {"privacyStatus": a.privacy, "selfDeclaredMadeForKids": False}
    if a.schedule:
        a.publish_at = next_slot(fmt=a.format)
    if a.publish_at:
        status.update(privacyStatus="private", publishAt=a.publish_at)
    body = {
        "snippet": {
            "title": a.title,
            "description": description,
            "tags": [t.strip() for t in a.tags.split(",")] if a.tags else [],
            "categoryId": a.category or CH.get("category", "27"),
            "defaultLanguage": lang(),
            "defaultAudioLanguage": lang(),
        },
        "status": status,
    }
    api = yt()
    req = api.videos().insert(part="snippet,status", body=body,
                              media_body=MediaFileUpload(a.file, chunksize=8 * 1024 * 1024, resumable=True))
    count_call("youtube.videos.insert")  # resumable chunks bypass execute()
    resp = None
    while resp is None:
        progress, resp = req.next_chunk()
        if progress:
            print(f"upload {int(progress.progress() * 100)}%", file=sys.stderr)
    vid = resp["id"]
    result = {"id": vid, "url": f"https://youtu.be/{vid}", "privacy": resp["status"]["privacyStatus"]}
    if a.publish_at:
        result["publish_at"] = a.publish_at
    if a.captions:
        result["captions"] = captions(vid, a.captions)
    if a.localizations:
        result["localizations"] = localize(vid, a.localizations)["localized"]
    if a.thumbnail:
        # the video is already up: a thumbnail refusal (e.g. channel not phone-verified) must not fail the upload
        try:
            api.thumbnails().set(videoId=vid, media_body=MediaFileUpload(a.thumbnail)).execute()
            result["thumbnail"] = "set"
        except HttpError as e:
            result["thumbnail"] = f"not set: {e.reason}"
    if a.playlist:
        api.playlistItems().insert(part="snippet", body={"snippet": {
            "playlistId": a.playlist, "resourceId": {"kind": "youtube#video", "videoId": vid}}}).execute()
        result["playlist"] = a.playlist
    return result


def read_info(path):
    """Description and keywords from a branding/channel_info.md ("## Deskripsi channel" / "## Keyword channel" or English)."""
    with open(path, encoding="utf-8") as f:
        parts = {}
        for block in f.read().split("\n## ")[1:]:
            head, _, body = block.partition("\n")
            parts[head.strip().lower()] = body.strip()
    desc = next(v for k, v in parts.items() if k.startswith(("deskripsi", "description")))
    kw = next((v for k, v in parts.items() if k.startswith("keyword")), "")
    # YouTube keywords are space-separated; multi-word keywords need quotes
    keywords = " ".join(f'"{k.strip()}"' if " " in k.strip() else k.strip() for k in kw.split(",") if k.strip())
    return desc, keywords


def branding(banner=None, info=None, country=None):
    api = yt()
    ch = api.channels().list(part="brandingSettings", mine=True).execute()["items"][0]
    bs = ch.get("brandingSettings", {})
    settings = dict(bs.get("channel", {}))
    result = {"channel": settings.get("title")}
    if info:
        settings["description"], settings["keywords"] = read_info(info)
        result.update(description_chars=len(settings["description"]), keywords=settings["keywords"])
    settings["defaultLanguage"] = lang()
    if country:
        settings["country"] = country
    body = {"id": ch["id"], "brandingSettings": {"channel": settings}}
    if banner:
        url = api.channelBanners().insert(media_body=MediaFileUpload(banner, mimetype="image/png")).execute()["url"]
        body["brandingSettings"]["image"] = {"bannerExternalUrl": url}
        result["banner"] = "set"
    api.channels().update(part="brandingSettings", body=body).execute()
    result.update(language=settings["defaultLanguage"], country=settings.get("country"))
    return result


def snapshot(days=28):
    data = {
        "taken": dt.datetime.now().isoformat(timespec="seconds"),
        "channel": channel(),
        "videos": videos(200),
        "analytics": analytics(days),
        "sources": sources(days),
    }
    os.makedirs(SNAPSHOTS, exist_ok=True)
    path = os.path.join(SNAPSHOTS, f"{dt.date.today()}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    return {"saved": path, "videos": len(data["videos"])}


def main():
    global CH, TOKEN, SNAPSHOTS, SLOT_UTC_HOUR, USE_CHROME_SESSION
    p = argparse.ArgumentParser(description="YouTube tool for the channels in channels.json")
    if not CHANNELS:
        sys.exit("channels.json is empty: add a channel in the YouTube Studio Manager dashboard first (Add Channel)")
    env_ch = os.environ.get("YT_CHANNEL")
    p.add_argument("--ch", default=env_ch if env_ch in CHANNELS else next(iter(CHANNELS)), choices=sorted(CHANNELS))
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("auth"); s.add_argument("--force", action="store_true", help="always open the browser for a fresh login")
    s.add_argument("--default-browser", action="store_true", help="do not use the channel's YouTube Studio Manager Chrome session")
    sub.add_parser("channel")
    s = sub.add_parser("videos"); s.add_argument("--limit", type=int, default=50)
    s = sub.add_parser("analytics"); s.add_argument("--days", type=int, default=28)
    s = sub.add_parser("retention"); s.add_argument("video_id")
    s = sub.add_parser("sources"); s.add_argument("--days", type=int, default=28)
    s = sub.add_parser("comments"); s.add_argument("video_id"); s.add_argument("--limit", type=int, default=100)
    s = sub.add_parser("reply"); s.add_argument("comment_id"); s.add_argument("text")
    s = sub.add_parser("comment"); s.add_argument("video_id"); s.add_argument("text")
    s = sub.add_parser("upload")
    s.add_argument("file"); s.add_argument("--title", required=True)
    s.add_argument("--description-file"); s.add_argument("--tags")
    s.add_argument("--privacy", default="private", choices=["private", "unlisted", "public"])
    s.add_argument("--publish-at", help="RFC3339 UTC, e.g. 2026-11-10T15:00:00Z (forces private until then)")
    s.add_argument("--category", help="default: the channel's category (27 = Education, 24 = Entertainment)")
    s.add_argument("--thumbnail"); s.add_argument("--playlist")
    s.add_argument("--schedule", action="store_true", help="publish at the channel's next slot")
    s.add_argument("--format", choices=["short", "long"], help="short uses the channel's slot_utc_short if set")
    s.add_argument("--captions", help=".srt subtitle file in the channel's language"); s.add_argument("--localizations", help="JSON file")
    s = sub.add_parser("captions"); s.add_argument("video_id"); s.add_argument("file"); s.add_argument("--lang", help="default: the channel's language")
    s = sub.add_parser("localize"); s.add_argument("video_id"); s.add_argument("file")
    s = sub.add_parser("delete"); s.add_argument("video_ids", nargs="+")
    s = sub.add_parser("reschedule"); s.add_argument("video_id"); s.add_argument("publish_at", help="RFC3339 UTC")
    s = sub.add_parser("branding"); s.add_argument("--banner"); s.add_argument("--info"); s.add_argument("--country")
    s = sub.add_parser("next-slot"); s.add_argument("--format", choices=["short", "long"])
    s = sub.add_parser("snapshot"); s.add_argument("--days", type=int, default=28)
    sub.add_parser("token-status", help="login health of the channel (no quota)")
    sub.add_parser("vault-migrate", help="copy the plain token file into the DPAPI vault")
    sub.add_parser("vault-remove-plain", help="move the plain token file to the Recycle Bin (after migrate)")
    a = p.parse_args()
    CH = CHANNELS[a.ch]
    TOKEN = os.path.join(SECRETS, CH["token"])
    SNAPSHOTS = os.path.join(ROOT, CH["snapshots"])
    SLOT_UTC_HOUR = CH.get("slot_utc_hour", SLOT_UTC_HOUR)

    if a.cmd == "auth":
        USE_CHROME_SESSION = not a.default_browser
        out(auth(a.force))
    elif a.cmd == "channel":
        out(channel())
    elif a.cmd == "videos":
        out(videos(a.limit))
    elif a.cmd == "analytics":
        out(analytics(a.days))
    elif a.cmd == "retention":
        out(retention(a.video_id))
    elif a.cmd == "sources":
        out(sources(a.days))
    elif a.cmd == "comments":
        out(comments(a.video_id, a.limit))
    elif a.cmd == "reply":
        out(reply(a.comment_id, a.text))
    elif a.cmd == "comment":
        out(comment(a.video_id, a.text))
    elif a.cmd == "upload":
        out(upload(a))
    elif a.cmd == "captions":
        out(captions(a.video_id, a.file, a.lang))
    elif a.cmd == "localize":
        out(localize(a.video_id, a.file))
    elif a.cmd == "reschedule":
        out(reschedule(a.video_id, a.publish_at))
    elif a.cmd == "delete":
        # permanent; only on the user's explicit request for these exact videos
        y = yt(); done = []
        for vid in a.video_ids:
            items = y.videos().list(part="snippet", id=vid).execute().get("items", [])
            if not items:
                done.append({"id": vid, "deleted": False, "error": "not found on this channel"}); continue
            y.videos().delete(id=vid).execute()
            done.append({"id": vid, "title": items[0]["snippet"]["title"], "deleted": True})
        out(done)
    elif a.cmd == "branding":
        # public change: only on the user's request
        out(branding(a.banner, a.info, a.country))
    elif a.cmd == "next-slot":
        out({"utc": next_slot(fmt=a.format)})
    elif a.cmd == "snapshot":
        out(snapshot(a.days))
    elif a.cmd == "token-status":
        out(token_status())
    elif a.cmd == "vault-migrate":
        out(vault_migrate())
    elif a.cmd == "vault-remove-plain":
        # deletes a credential file (to the Recycle Bin): only on the user's OK
        out(vault_remove_plain())


if __name__ == "__main__":
    main()
