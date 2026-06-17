"""
Twitch Watch Time API
Heartbeat-based watch time tracker. The browser extension POSTs heartbeats
every N seconds while a Twitch video is playing; we store them and compute
watch time as COUNT(heartbeats) * interval.
"""
import io
import json
import os
import pathlib
import re
import shutil
import sqlite3
import tempfile
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Depends, Query, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

API_KEY = os.environ["API_KEY"]
DB_PATH = os.environ.get("DB_PATH", "/data/watchtime.db")
HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL_SECONDS", "60"))

# Additional "generic" video sources stored in one table with a platform
# discriminator. X/Twitter, Facebook and Instagram are tracked by the browser
# extension; Plex is tracked server-side by polling a Plex Media Server.
MEDIA_PLATFORMS = {"x", "facebook", "instagram", "plex"}

app = FastAPI(title="Twitch Watch Time API", version="0.1.0")

# Allow extension origins. Manifest V3 extensions send Origin like
# chrome-extension://<id>. We allow all here because this is a single-user
# personal API behind an API key — origin isn't load-bearing for auth.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)


STATIC_DIR = pathlib.Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

import hashlib

def _build_hash():
    h = hashlib.md5()
    for f in sorted(STATIC_DIR.glob("*.js")) + sorted(STATIC_DIR.glob("*.css")):
        h.update(f.read_bytes())
    return h.hexdigest()[:8]

ASSET_VERSION = _build_hash()


def _serve_html(path):
    text = path.read_text()
    text = text.replace(".js\"", f".js?v={ASSET_VERSION}\"")
    text = text.replace(".css\"", f".css?v={ASSET_VERSION}\"")
    return Response(content=text, media_type="text/html")


@app.get("/", include_in_schema=False)
def root():
    return _serve_html(STATIC_DIR / "index.html")


@app.get("/tv", include_in_schema=False)
def tv():
    return _serve_html(STATIC_DIR / "tv.html")


@app.get("/twitch", include_in_schema=False)
def twitch_page():
    return _serve_html(STATIC_DIR / "twitch.html")


@app.get("/youtube", include_in_schema=False)
def youtube_page():
    return _serve_html(STATIC_DIR / "youtube.html")


@app.get("/x", include_in_schema=False)
def x_page():
    return _serve_html(STATIC_DIR / "media.html")


@app.get("/facebook", include_in_schema=False)
def facebook_page():
    return _serve_html(STATIC_DIR / "media.html")


@app.get("/instagram", include_in_schema=False)
def instagram_page():
    return _serve_html(STATIC_DIR / "media.html")


@app.get("/plex", include_in_schema=False)
def plex_page():
    return _serve_html(STATIC_DIR / "media.html")


@app.get("/settings", include_in_schema=False)
def settings_page():
    return _serve_html(STATIC_DIR / "settings.html")


# ---------- DB ----------

def migrate_db(conn):
    """Idempotent column additions and other schema migrations."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(heartbeats)")}
    if "twitch_user" not in cols:
        conn.execute("ALTER TABLE heartbeats ADD COLUMN twitch_user TEXT")


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS heartbeats (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          INTEGER NOT NULL,
                channel     TEXT    NOT NULL,
                category    TEXT,
                title       TEXT,
                state       TEXT    NOT NULL CHECK(state IN ('active','passive','audio_only')),
                tab_visible INTEGER NOT NULL CHECK(tab_visible IN (0,1)),
                client_id   TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_heartbeats_ts
                ON heartbeats(ts);
            CREATE INDEX IF NOT EXISTS idx_heartbeats_channel_ts
                ON heartbeats(channel, ts);
            CREATE TABLE IF NOT EXISTS youtube_heartbeats (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                ts           INTEGER NOT NULL,
                channel      TEXT    NOT NULL,
                title        TEXT,
                video_id     TEXT,
                playlist_id  TEXT,
                state        TEXT    NOT NULL CHECK(state IN ('active','passive')),
                tab_visible  INTEGER NOT NULL CHECK(tab_visible IN (0,1)),
                youtube_user TEXT,
                client_id    TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_yt_ts
                ON youtube_heartbeats(ts);
            CREATE INDEX IF NOT EXISTS idx_yt_channel_ts
                ON youtube_heartbeats(channel, ts);
            CREATE TABLE IF NOT EXISTS media_heartbeats (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts          INTEGER NOT NULL,
                platform    TEXT    NOT NULL CHECK(platform IN ('x','facebook','instagram','plex')),
                channel     TEXT    NOT NULL,
                title       TEXT,
                video_id    TEXT,
                state       TEXT    NOT NULL CHECK(state IN ('active','passive')),
                tab_visible INTEGER NOT NULL CHECK(tab_visible IN (0,1)),
                media_user  TEXT,
                client_id   TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_media_platform_ts
                ON media_heartbeats(platform, ts);
            CREATE INDEX IF NOT EXISTS idx_media_platform_channel_ts
                ON media_heartbeats(platform, channel, ts);
            CREATE TABLE IF NOT EXISTS channel_links (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                twitch_channel  TEXT NOT NULL,
                youtube_channel TEXT NOT NULL,
                UNIQUE(twitch_channel, youtube_channel)
            );
            CREATE TABLE IF NOT EXISTS user_accounts (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                label         TEXT NOT NULL,
                twitch_user   TEXT,
                youtube_user  TEXT,
                UNIQUE(twitch_user, youtube_user)
            );
        """)
        migrate_db(conn)
        conn.commit()


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


init_db()


# ---------- Auth ----------

def require_api_key(x_api_key: Optional[str] = Header(default=None)):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="bad api key")


# ---------- Models ----------

class Heartbeat(BaseModel):
    ts: int = Field(..., description="Unix seconds, UTC")
    channel: str = Field(..., min_length=1, max_length=64)
    category: Optional[str] = Field(default=None, max_length=128)
    title: Optional[str] = Field(default=None, max_length=512)
    state: str = Field(..., pattern="^(active|passive|audio_only)$")
    tab_visible: bool
    client_id: str = Field(..., min_length=1, max_length=64)
    twitch_user: Optional[str] = Field(default=None, max_length=64)


class HeartbeatBatch(BaseModel):
    heartbeats: list[Heartbeat]


class YoutubeHeartbeat(BaseModel):
    ts: int = Field(..., description="Unix seconds, UTC")
    channel: str = Field(..., min_length=1, max_length=128)
    title: Optional[str] = Field(default=None, max_length=512)
    video_id: Optional[str] = Field(default=None, max_length=16)
    playlist_id: Optional[str] = Field(default=None, max_length=64)
    state: str = Field(..., pattern="^(active|passive)$")
    tab_visible: bool
    client_id: str = Field(..., min_length=1, max_length=64)
    youtube_user: Optional[str] = Field(default=None, max_length=128)


class YoutubeHeartbeatBatch(BaseModel):
    heartbeats: list[YoutubeHeartbeat]


class MediaHeartbeat(BaseModel):
    ts: int = Field(..., description="Unix seconds, UTC")
    platform: str = Field(..., pattern="^(x|facebook|instagram|plex)$")
    channel: str = Field(..., min_length=1, max_length=128)
    title: Optional[str] = Field(default=None, max_length=512)
    video_id: Optional[str] = Field(default=None, max_length=128)
    state: str = Field(..., pattern="^(active|passive)$")
    tab_visible: bool
    client_id: str = Field(..., min_length=1, max_length=64)
    media_user: Optional[str] = Field(default=None, max_length=128)


class MediaHeartbeatBatch(BaseModel):
    heartbeats: list[MediaHeartbeat]


class ChannelLink(BaseModel):
    twitch_channel: str = Field(..., min_length=1, max_length=64)
    youtube_channel: str = Field(..., min_length=1, max_length=128)


class UserAccount(BaseModel):
    label: str = Field(..., min_length=1, max_length=64)
    twitch_user: Optional[str] = Field(default=None, max_length=64)
    youtube_user: Optional[str] = Field(default=None, max_length=128)


# ---------- Endpoints ----------

@app.get("/health")
def health():
    return {"ok": True, "interval": HEARTBEAT_INTERVAL}


_AVATAR_DIR = pathlib.Path(os.environ.get("DB_PATH", "/data/watchtime.db")).parent / "avatars"
_AVATAR_TTL = 86400 * 7  # 7 days
_AVATAR_INDEX = _AVATAR_DIR / "custom_index.json"


def _avatar_safe(channel: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", channel.lower())


def _load_custom_index() -> dict:
    if _AVATAR_INDEX.exists():
        try:
            return json.loads(_AVATAR_INDEX.read_text())
        except Exception:
            return {}
    return {}


def _save_custom_index(index: dict):
    _AVATAR_INDEX.write_text(json.dumps(index))


def _detect_ct(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"GIF":
        return "image/gif"
    if data[:2] in (b"\xff\xd8", b"\xff\xe0", b"\xff\xe1"):
        return "image/jpeg"
    return "image/jpeg"


@app.get("/avatars/custom", dependencies=[Depends(require_api_key)])
def list_custom_avatars():
    index = _load_custom_index()
    return {"avatars": [{"platform": k.split(":")[0], "channel": k.split(":")[1]} for k in index]}


# unavatar.io provider names keyed by our internal platform name. Plex has no
# avatar provider, so it falls through to the initials placeholder in the UI.
_AVATAR_PROVIDERS = {
    "twitch": "twitch",
    "youtube": "youtube",
    "x": "twitter",
    "facebook": "facebook",
    "instagram": "instagram",
}


@app.get("/avatars/{platform}/{channel}")
def get_avatar(platform: str, channel: str):
    provider = _AVATAR_PROVIDERS.get(platform)
    if provider is None:
        raise HTTPException(status_code=404)
    _AVATAR_DIR.mkdir(exist_ok=True)
    safe = _avatar_safe(channel)
    # Custom override takes priority
    custom_file = _AVATAR_DIR / f"custom_{platform}_{safe}"
    if custom_file.exists():
        data = custom_file.read_bytes()
        return Response(content=data, media_type=_detect_ct(data), headers={"Cache-Control": "public, max-age=604800"})
    # Auto-cache
    cache_file = _AVATAR_DIR / f"{platform}_{safe}"
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < _AVATAR_TTL:
        data = cache_file.read_bytes()
        return Response(content=data, media_type=_detect_ct(data), headers={"Cache-Control": "public, max-age=604800"})
    try:
        url = f"https://unavatar.io/{provider}/{urllib.parse.quote(channel)}?fallback=404"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = resp.read()
            cache_file.write_bytes(data)
            return Response(content=data, media_type=_detect_ct(data), headers={"Cache-Control": "public, max-age=604800"})
    except Exception:
        raise HTTPException(status_code=404, headers={"Cache-Control": "no-store"})


@app.post("/avatars/{platform}/{channel}", dependencies=[Depends(require_api_key)])
async def set_custom_avatar(platform: str, channel: str, file: UploadFile = File(...)):
    if platform not in _AVATAR_PROVIDERS and platform not in MEDIA_PLATFORMS:
        raise HTTPException(status_code=404)
    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")
    _AVATAR_DIR.mkdir(exist_ok=True)
    safe = _avatar_safe(channel)
    data = await file.read()
    custom_file = _AVATAR_DIR / f"custom_{platform}_{safe}"
    custom_file.write_bytes(data)
    index = _load_custom_index()
    index[f"{platform}:{channel.lower()}"] = True
    _save_custom_index(index)
    return {"ok": True}


@app.delete("/avatars/{platform}/{channel}", dependencies=[Depends(require_api_key)])
def delete_custom_avatar(platform: str, channel: str):
    _AVATAR_DIR.mkdir(exist_ok=True)
    safe = _avatar_safe(channel)
    custom_file = _AVATAR_DIR / f"custom_{platform}_{safe}"
    if custom_file.exists():
        custom_file.unlink()
    # Also clear auto-cache so it re-fetches
    cache_file = _AVATAR_DIR / f"{platform}_{safe}"
    if cache_file.exists():
        cache_file.unlink()
    index = _load_custom_index()
    index.pop(f"{platform}:{channel.lower()}", None)
    _save_custom_index(index)
    return {"ok": True}


@app.post("/heartbeat", dependencies=[Depends(require_api_key)])
def heartbeat(hb: Heartbeat):
    with db() as conn:
        conn.execute(
            "INSERT INTO heartbeats "
            "(ts, channel, category, title, state, tab_visible, client_id, twitch_user) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (hb.ts, hb.channel.lower(), hb.category, hb.title,
             hb.state, int(hb.tab_visible), hb.client_id, hb.twitch_user),
        )
    return {"ok": True}


@app.post("/heartbeats", dependencies=[Depends(require_api_key)])
def heartbeats_batch(batch: HeartbeatBatch):
    rows = [
        (hb.ts, hb.channel.lower(), hb.category, hb.title,
         hb.state, int(hb.tab_visible), hb.client_id, hb.twitch_user)
        for hb in batch.heartbeats
    ]
    with db() as conn:
        conn.executemany(
            "INSERT INTO heartbeats "
            "(ts, channel, category, title, state, tab_visible, client_id, twitch_user) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
    return {"ok": True, "stored": len(rows)}


@app.post("/youtube/heartbeats", dependencies=[Depends(require_api_key)])
def youtube_heartbeats_batch(batch: YoutubeHeartbeatBatch):
    rows = [
        (hb.ts, hb.channel.lower(), hb.title, hb.video_id, hb.playlist_id,
         hb.state, int(hb.tab_visible), hb.youtube_user, hb.client_id)
        for hb in batch.heartbeats
    ]
    with db() as conn:
        conn.executemany(
            "INSERT INTO youtube_heartbeats "
            "(ts, channel, title, video_id, playlist_id, state, tab_visible, youtube_user, client_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
    return {"ok": True, "stored": len(rows)}


@app.post("/media/heartbeats", dependencies=[Depends(require_api_key)])
def media_heartbeats_batch(batch: MediaHeartbeatBatch):
    """Ingest heartbeats for the generic video sources (x, facebook, instagram,
    plex). Each heartbeat carries its own `platform` so a single extension queue
    can serve all browser-tracked sources."""
    rows = [
        (hb.ts, hb.platform, hb.channel.lower(), hb.title, hb.video_id,
         hb.state, int(hb.tab_visible),
         hb.media_user.lower() if hb.media_user else None, hb.client_id)
        for hb in batch.heartbeats
    ]
    with db() as conn:
        conn.executemany(
            "INSERT INTO media_heartbeats "
            "(ts, platform, channel, title, video_id, state, tab_visible, media_user, client_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
    return {"ok": True, "stored": len(rows)}


@app.get("/stats/channels", dependencies=[Depends(require_api_key)])
def all_channels():
    with db() as conn:
        tw = [r["channel"] for r in conn.execute(
            "SELECT DISTINCT channel FROM heartbeats ORDER BY channel"
        ).fetchall()]
        yt = [r["channel"] for r in conn.execute(
            "SELECT DISTINCT channel FROM youtube_heartbeats ORDER BY channel"
        ).fetchall()]
        media = {}
        for p in sorted(MEDIA_PLATFORMS):
            media[p] = [r["channel"] for r in conn.execute(
                "SELECT DISTINCT channel FROM media_heartbeats WHERE platform = ? ORDER BY channel",
                (p,),
            ).fetchall()]
    return {"twitch": tw, "youtube": yt, **media}


@app.get("/stats/youtube/users", dependencies=[Depends(require_api_key)])
def yt_stats_users():
    with db() as conn:
        rows = conn.execute("""
            SELECT youtube_user AS user, MAX(ts) AS last_ts, COUNT(*) AS count
            FROM youtube_heartbeats
            WHERE youtube_user IS NOT NULL
            GROUP BY youtube_user
            ORDER BY last_ts DESC
        """).fetchall()
    return {
        "users": [
            {"user": r["user"], "last_ts": r["last_ts"], "count": r["count"]}
            for r in rows
        ]
    }


@app.get("/stats/youtube/today", dependencies=[Depends(require_api_key)])
def yt_stats_today(include_passive: bool = True, user: Optional[str] = None):
    return _yt_stats_since(_local_midnight(), include_passive, user)


@app.get("/stats/youtube/week", dependencies=[Depends(require_api_key)])
def yt_stats_week(include_passive: bool = True, user: Optional[str] = None):
    return _yt_stats_since(int(time.time()) - 7 * 86400, include_passive, user)


@app.get("/stats/youtube/month", dependencies=[Depends(require_api_key)])
def yt_stats_month(include_passive: bool = True, user: Optional[str] = None):
    return _yt_stats_since(int(time.time()) - 30 * 86400, include_passive, user)


@app.get("/stats/youtube/all", dependencies=[Depends(require_api_key)])
def yt_stats_all(include_passive: bool = True, user: Optional[str] = None):
    return _yt_stats_since(0, include_passive, user)


@app.get("/stats/youtube/playlists", dependencies=[Depends(require_api_key)])
def yt_stats_playlists(
    window: str = "today",
    include_passive: bool = True,
    user: Optional[str] = None,
):
    since = _window_since(window)
    state_filter = "" if include_passive else "AND state = 'active'"
    user_sql, user_params = _yt_user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT playlist_id, COUNT(*) AS n
            FROM youtube_heartbeats
            WHERE ts >= ? AND playlist_id IS NOT NULL {state_filter} {user_sql}
            GROUP BY playlist_id
            ORDER BY n DESC
        """, (since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "playlists": [
            {"playlist_id": r["playlist_id"], "seconds": _seconds_from_count(r["n"])}
            for r in rows
        ],
    }


@app.get("/stats/youtube/now", dependencies=[Depends(require_api_key)])
def yt_stats_now(user: Optional[str] = None):
    cutoff = int(time.time()) - 120
    user_sql, user_params = _yt_user_clause(user)
    with db() as conn:
        row = conn.execute(f"""
            SELECT channel, title, youtube_user
            FROM youtube_heartbeats
            WHERE ts >= ? AND state = 'active' {user_sql}
            ORDER BY ts DESC LIMIT 1
        """, (cutoff, *user_params)).fetchone()
    if not row:
        return {"channel": None}
    return {
        "channel": row["channel"],
        "title": row["title"],
        "youtube_user": row["youtube_user"],
    }


@app.get("/stats/youtube/daily", dependencies=[Depends(require_api_key)])
def yt_stats_daily(days: int = 30, user: Optional[str] = None):
    since = int(time.time()) - days * 86400
    user_sql, user_params = _yt_user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT date(ts, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
            FROM youtube_heartbeats
            WHERE ts >= ? {user_sql}
            GROUP BY day ORDER BY day ASC
        """, (since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "days": [{"day": r["day"], "seconds": _seconds_from_count(r["n"])} for r in rows],
    }


@app.get("/stats/youtube/videos", dependencies=[Depends(require_api_key)])
def yt_stats_videos(window: str = "today", user: Optional[str] = None):
    since = _window_since(window)
    user_sql, user_params = _yt_user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT title, COUNT(*) AS n
            FROM youtube_heartbeats
            WHERE ts >= ? AND title IS NOT NULL {user_sql}
            GROUP BY title ORDER BY n DESC LIMIT 10
        """, (since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "videos": [{"title": r["title"], "seconds": _seconds_from_count(r["n"])} for r in rows],
    }


def _validate_media_platform(platform: str):
    if platform not in MEDIA_PLATFORMS:
        raise HTTPException(status_code=404, detail=f"unknown platform '{platform}'")


@app.get("/stats/media/{platform}/users", dependencies=[Depends(require_api_key)])
def media_stats_users(platform: str):
    _validate_media_platform(platform)
    with db() as conn:
        rows = conn.execute("""
            SELECT media_user AS user, MAX(ts) AS last_ts, COUNT(*) AS count
            FROM media_heartbeats
            WHERE platform = ? AND media_user IS NOT NULL
            GROUP BY media_user
            ORDER BY last_ts DESC
        """, (platform,)).fetchall()
    return {
        "users": [
            {"user": r["user"], "last_ts": r["last_ts"], "count": r["count"]}
            for r in rows
        ]
    }


@app.get("/stats/media/{platform}/today", dependencies=[Depends(require_api_key)])
def media_stats_today(platform: str, include_passive: bool = True, user: Optional[str] = None):
    _validate_media_platform(platform)
    return _media_stats_since(platform, _local_midnight(), include_passive, user)


@app.get("/stats/media/{platform}/week", dependencies=[Depends(require_api_key)])
def media_stats_week(platform: str, include_passive: bool = True, user: Optional[str] = None):
    _validate_media_platform(platform)
    return _media_stats_since(platform, int(time.time()) - 7 * 86400, include_passive, user)


@app.get("/stats/media/{platform}/month", dependencies=[Depends(require_api_key)])
def media_stats_month(platform: str, include_passive: bool = True, user: Optional[str] = None):
    _validate_media_platform(platform)
    return _media_stats_since(platform, int(time.time()) - 30 * 86400, include_passive, user)


@app.get("/stats/media/{platform}/all", dependencies=[Depends(require_api_key)])
def media_stats_all(platform: str, include_passive: bool = True, user: Optional[str] = None):
    _validate_media_platform(platform)
    return _media_stats_since(platform, 0, include_passive, user)


@app.get("/stats/media/{platform}/daily", dependencies=[Depends(require_api_key)])
def media_stats_daily(platform: str, days: int = 30, user: Optional[str] = None):
    _validate_media_platform(platform)
    since = int(time.time()) - days * 86400
    user_sql, user_params = _media_user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT date(ts, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
            FROM media_heartbeats
            WHERE platform = ? AND ts >= ? {user_sql}
            GROUP BY day ORDER BY day ASC
        """, (platform, since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "days": [{"day": r["day"], "seconds": _seconds_from_count(r["n"])} for r in rows],
    }


@app.get("/stats/media/{platform}/videos", dependencies=[Depends(require_api_key)])
def media_stats_videos(platform: str, window: str = "today", user: Optional[str] = None):
    _validate_media_platform(platform)
    since = _window_since(window)
    user_sql, user_params = _media_user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT title, COUNT(*) AS n
            FROM media_heartbeats
            WHERE platform = ? AND ts >= ? AND title IS NOT NULL {user_sql}
            GROUP BY title ORDER BY n DESC LIMIT 10
        """, (platform, since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "videos": [{"title": r["title"], "seconds": _seconds_from_count(r["n"])} for r in rows],
    }


@app.get("/stats/media/{platform}/now", dependencies=[Depends(require_api_key)])
def media_stats_now(platform: str, user: Optional[str] = None):
    _validate_media_platform(platform)
    cutoff = int(time.time()) - 120
    user_sql, user_params = _media_user_clause(user)
    with db() as conn:
        row = conn.execute(f"""
            SELECT channel, title, media_user
            FROM media_heartbeats
            WHERE platform = ? AND ts >= ? AND state = 'active' {user_sql}
            ORDER BY ts DESC LIMIT 1
        """, (platform, cutoff, *user_params)).fetchone()
    if not row:
        return {"channel": None}
    return {"channel": row["channel"], "title": row["title"], "media_user": row["media_user"]}


def _seconds_from_count(n: int) -> int:
    return n * HEARTBEAT_INTERVAL


@app.get("/settings/channel-links", dependencies=[Depends(require_api_key)])
def get_channel_links():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, twitch_channel, youtube_channel FROM channel_links ORDER BY id"
        ).fetchall()
    return {
        "links": [
            {"id": r["id"], "twitch_channel": r["twitch_channel"], "youtube_channel": r["youtube_channel"]}
            for r in rows
        ]
    }


@app.post("/settings/channel-links", dependencies=[Depends(require_api_key)])
def add_channel_link(link: ChannelLink):
    tc = link.twitch_channel.lower()
    yc = link.youtube_channel.lower()
    with db() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO channel_links (twitch_channel, youtube_channel) VALUES (?, ?)",
                (tc, yc),
            )
            link_id = cursor.lastrowid
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id FROM channel_links WHERE twitch_channel = ? AND youtube_channel = ?",
                (tc, yc),
            ).fetchone()
            link_id = row["id"]
    return {"ok": True, "id": link_id}


@app.delete("/settings/channel-links/{link_id}", dependencies=[Depends(require_api_key)])
def delete_channel_link(link_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM channel_links WHERE id = ?", (link_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="link not found")
    return {"ok": True}


@app.get("/settings/user-accounts", dependencies=[Depends(require_api_key)])
def get_user_accounts():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, label, twitch_user, youtube_user FROM user_accounts ORDER BY id"
        ).fetchall()
    return {
        "accounts": [
            {"id": r["id"], "label": r["label"],
             "twitch_user": r["twitch_user"], "youtube_user": r["youtube_user"]}
            for r in rows
        ]
    }


@app.post("/settings/user-accounts", dependencies=[Depends(require_api_key)])
def add_user_account(account: UserAccount):
    tw = account.twitch_user.lower() if account.twitch_user else None
    yt = account.youtube_user.lower() if account.youtube_user else None
    if tw is None and yt is None:
        raise HTTPException(status_code=400, detail="at least one of twitch_user or youtube_user required")
    with db() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO user_accounts (label, twitch_user, youtube_user) VALUES (?, ?, ?)",
                (account.label, tw, yt),
            )
            account_id = cursor.lastrowid
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id FROM user_accounts WHERE twitch_user IS ? AND youtube_user IS ?",
                (tw, yt),
            ).fetchone()
            account_id = row["id"]
    return {"ok": True, "id": account_id}


@app.delete("/settings/user-accounts/{account_id}", dependencies=[Depends(require_api_key)])
def delete_user_account(account_id: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM user_accounts WHERE id = ?", (account_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="account not found")
    return {"ok": True}


@app.post("/settings/user-accounts/auto-link", dependencies=[Depends(require_api_key)])
def auto_link_user_accounts():
    """
    Detect Twitch+YouTube account pairs that came from the same Chrome extension
    install (same client_id) and add them to user_accounts. Idempotent — pairs
    already linked are skipped via UNIQUE constraint.
    """
    with db() as conn:
        pairs = conn.execute("""
            SELECT DISTINCT h.twitch_user, y.youtube_user
            FROM heartbeats h
            JOIN youtube_heartbeats y ON h.client_id = y.client_id
            WHERE h.twitch_user IS NOT NULL AND y.youtube_user IS NOT NULL
        """).fetchall()

        created = 0
        skipped = 0
        for row in pairs:
            tw = row["twitch_user"]
            yt = row["youtube_user"]
            try:
                conn.execute(
                    "INSERT INTO user_accounts (label, twitch_user, youtube_user) VALUES (?, ?, ?)",
                    (f"Auto: {tw} / {yt}", tw, yt),
                )
                created += 1
            except sqlite3.IntegrityError:
                skipped += 1
    return {"ok": True, "created": created, "skipped": skipped, "total_pairs": len(pairs)}


@app.get("/stats/today", dependencies=[Depends(require_api_key)])
def stats_today(include_passive: bool = True, user: Optional[str] = None):
    """Total watch time today (server local time) per channel."""
    midnight = _local_midnight()
    return _stats_since(midnight, include_passive, user)


@app.get("/stats/week", dependencies=[Depends(require_api_key)])
def stats_week(include_passive: bool = True, user: Optional[str] = None):
    """Last 7 days, per channel."""
    since = int(time.time()) - 7 * 86400
    return _stats_since(since, include_passive, user)


@app.get("/stats/month", dependencies=[Depends(require_api_key)])
def stats_month(include_passive: bool = True, user: Optional[str] = None):
    """Last 30 days (rolling), per channel."""
    since = int(time.time()) - 30 * 86400
    return _stats_since(since, include_passive, user)


@app.get("/stats/all", dependencies=[Depends(require_api_key)])
def stats_all(include_passive: bool = True, user: Optional[str] = None):
    return _stats_since(0, include_passive, user)


@app.get("/stats/daily", dependencies=[Depends(require_api_key)])
def stats_daily(days: int = 30, include_passive: bool = True, user: Optional[str] = None):
    """Watch time per day for the last N days."""
    since = int(time.time()) - days * 86400
    state_filter = "" if include_passive else "AND state = 'active'"
    user_sql, user_params = _user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT
                date(ts, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS n
            FROM heartbeats
            WHERE ts >= ? {state_filter} {user_sql}
            GROUP BY day
            ORDER BY day ASC
        """, (since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "days": [
            {"day": r["day"], "seconds": _seconds_from_count(r["n"])}
            for r in rows
        ],
    }


@app.get("/stats/top_channel", dependencies=[Depends(require_api_key)])
def stats_top_channel(window: str = "today", user: Optional[str] = None, platform: str = "twitch"):
    """Single channel name + seconds for the given window. platform: twitch|youtube|merged."""
    since = _window_since(window)
    with db() as conn:
        if platform == "youtube":
            yt_sql, yt_params = _yt_user_clause(user)
            row = conn.execute(f"""
                SELECT channel, COUNT(*) AS n
                FROM youtube_heartbeats
                WHERE ts >= ? {yt_sql}
                GROUP BY channel
                ORDER BY n DESC
                LIMIT 1
            """, (since, *yt_params)).fetchone()
            if not row:
                return {"channel": None, "seconds": 0}
            return {"channel": row["channel"], "seconds": _seconds_from_count(row["n"])}
        if platform == "merged":
            tw_user, yt_user = _resolve_merged_user(conn, user)
            tw_sql, tw_params = _user_clause(tw_user)
            yt_sql, yt_params = _yt_user_clause(yt_user)
            # Get top from both tables, pick overall winner
            tw_row = conn.execute(f"""
                SELECT channel, COUNT(*) AS n FROM heartbeats
                WHERE ts >= ? {tw_sql}
                GROUP BY channel ORDER BY n DESC LIMIT 1
            """, (since, *tw_params)).fetchone()
            yt_row = conn.execute(f"""
                SELECT channel, COUNT(*) AS n FROM youtube_heartbeats
                WHERE ts >= ? {yt_sql}
                GROUP BY channel ORDER BY n DESC LIMIT 1
            """, (since, *yt_params)).fetchone()
            tw_sec = _seconds_from_count(tw_row["n"]) if tw_row else 0
            yt_sec = _seconds_from_count(yt_row["n"]) if yt_row else 0
            if tw_sec == 0 and yt_sec == 0:
                return {"channel": None, "seconds": 0}
            if tw_sec >= yt_sec:
                return {"channel": tw_row["channel"], "seconds": tw_sec}
            return {"channel": yt_row["channel"], "seconds": yt_sec}
        # Default: twitch
        user_sql, user_params = _user_clause(user)
        row = conn.execute(f"""
            SELECT channel, COUNT(*) AS n
            FROM heartbeats
            WHERE ts >= ? {user_sql}
            GROUP BY channel
            ORDER BY n DESC
            LIMIT 1
        """, (since, *user_params)).fetchone()
        if not row:
            return {"channel": None, "seconds": 0}
        return {"channel": row["channel"], "seconds": _seconds_from_count(row["n"])}


@app.get("/stats/total", dependencies=[Depends(require_api_key)])
def stats_total(window: str = "today", user: Optional[str] = None, platform: str = "twitch"):
    """Total seconds in a window. platform: twitch|youtube|merged."""
    since = _window_since(window)
    with db() as conn:
        if platform == "youtube":
            yt_sql, yt_params = _yt_user_clause(user)
            row = conn.execute(f"""
                SELECT COUNT(*) AS n FROM youtube_heartbeats
                WHERE ts >= ? {yt_sql}
            """, (since, *yt_params)).fetchone()
            return {"window": window, "seconds": _seconds_from_count(row["n"])}
        if platform == "merged":
            tw_user, yt_user = _resolve_merged_user(conn, user)
            tw_sql, tw_params = _user_clause(tw_user)
            yt_sql, yt_params = _yt_user_clause(yt_user)
            tw_row = conn.execute(f"""
                SELECT COUNT(*) AS n FROM heartbeats
                WHERE ts >= ? {tw_sql}
            """, (since, *tw_params)).fetchone()
            yt_row = conn.execute(f"""
                SELECT COUNT(*) AS n FROM youtube_heartbeats
                WHERE ts >= ? {yt_sql}
            """, (since, *yt_params)).fetchone()
            total = _seconds_from_count(tw_row["n"]) + _seconds_from_count(yt_row["n"])
            return {"window": window, "seconds": total}
        # Default: twitch
        user_sql, user_params = _user_clause(user)
        row = conn.execute(f"""
            SELECT COUNT(*) AS n FROM heartbeats
            WHERE ts >= ? {user_sql}
        """, (since, *user_params)).fetchone()
        return {"window": window, "seconds": _seconds_from_count(row["n"])}


@app.get("/stats/now", dependencies=[Depends(require_api_key)])
def stats_now(user: Optional[str] = None, platform: str = "twitch"):
    """Most recent heartbeat in last 120s, or {'now': None}. platform: twitch|youtube|merged."""
    cutoff = int(time.time()) - 120
    with db() as conn:
        if platform == "youtube":
            yt_sql, yt_params = _yt_user_clause(user)
            row = conn.execute(f"""
                SELECT ts, channel, title, youtube_user
                FROM youtube_heartbeats
                WHERE ts >= ? AND state = 'active' {yt_sql}
                ORDER BY ts DESC
                LIMIT 1
            """, (cutoff, *yt_params)).fetchone()
            if not row:
                return {"now": None}
            return {
                "ts": row["ts"],
                "channel": row["channel"],
                "category": None,
                "title": row["title"],
                "twitch_user": row["youtube_user"],
            }
        if platform == "merged":
            tw_user, yt_user = _resolve_merged_user(conn, user)
            tw_sql, tw_params = _user_clause(tw_user)
            yt_sql, yt_params = _yt_user_clause(yt_user)
            tw_row = conn.execute(f"""
                SELECT ts, channel, category, title, twitch_user
                FROM heartbeats WHERE ts >= ? {tw_sql}
                ORDER BY ts DESC LIMIT 1
            """, (cutoff, *tw_params)).fetchone()
            yt_row = conn.execute(f"""
                SELECT ts, channel, title, youtube_user
                FROM youtube_heartbeats
                WHERE ts >= ? AND state = 'active' {yt_sql}
                ORDER BY ts DESC LIMIT 1
            """, (cutoff, *yt_params)).fetchone()
            # Pick most recent across both platforms
            tw_ts = tw_row["ts"] if tw_row else 0
            yt_ts = yt_row["ts"] if yt_row else 0
            if tw_ts == 0 and yt_ts == 0:
                return {"now": None}
            if tw_ts >= yt_ts:
                return {
                    "ts": tw_row["ts"],
                    "channel": tw_row["channel"],
                    "category": tw_row["category"],
                    "title": tw_row["title"],
                    "twitch_user": tw_row["twitch_user"],
                }
            return {
                "ts": yt_row["ts"],
                "channel": yt_row["channel"],
                "category": None,
                "title": yt_row["title"],
                "twitch_user": yt_row["youtube_user"],
            }
        # Default: twitch
        user_sql, user_params = _user_clause(user)
        row = conn.execute(f"""
            SELECT ts, channel, category, title, twitch_user
            FROM heartbeats
            WHERE ts >= ? {user_sql}
            ORDER BY ts DESC
            LIMIT 1
        """, (cutoff, *user_params)).fetchone()
    if not row:
        return {"now": None}
    return {
        "ts": row["ts"],
        "channel": row["channel"],
        "category": row["category"],
        "title": row["title"],
        "twitch_user": row["twitch_user"],
    }


@app.get("/stats/channel", dependencies=[Depends(require_api_key)])
def stats_channel(channel: str, window: str = "today", user: Optional[str] = None, platform: str = "twitch"):
    """Seconds watched for a specific channel in a window. platform: twitch|youtube|merged."""
    since = _window_since(window)
    with db() as conn:
        if platform == "youtube":
            yt_sql, yt_params = _yt_user_clause(user)
            row = conn.execute(f"""
                SELECT COUNT(*) AS n FROM youtube_heartbeats
                WHERE ts >= ? AND channel = ? {yt_sql}
            """, (since, channel, *yt_params)).fetchone()
            return {"channel": channel, "window": window, "seconds": _seconds_from_count(row["n"])}
        if platform == "merged":
            tw_user, yt_user = _resolve_merged_user(conn, user)
            tw_sql, tw_params = _user_clause(tw_user)
            yt_sql, yt_params = _yt_user_clause(yt_user)
            tw_row = conn.execute(f"""
                SELECT COUNT(*) AS n FROM heartbeats
                WHERE ts >= ? AND channel = ? {tw_sql}
            """, (since, channel, *tw_params)).fetchone()
            yt_row = conn.execute(f"""
                SELECT COUNT(*) AS n FROM youtube_heartbeats
                WHERE ts >= ? AND channel = ? {yt_sql}
            """, (since, channel, *yt_params)).fetchone()
            total = _seconds_from_count(tw_row["n"]) + _seconds_from_count(yt_row["n"])
            return {"channel": channel, "window": window, "seconds": total}
        # Default: twitch
        user_sql, user_params = _user_clause(user)
        row = conn.execute(f"""
            SELECT COUNT(*) AS n FROM heartbeats
            WHERE ts >= ? AND channel = ? {user_sql}
        """, (since, channel, *user_params)).fetchone()
        return {"channel": channel, "window": window, "seconds": _seconds_from_count(row["n"])}


@app.get("/stats/users", dependencies=[Depends(require_api_key)])
def stats_users():
    """Distinct twitch_user values with last activity and heartbeat count.
    NULL is reported as 'anonymous'. Ordered by last_ts DESC."""
    with db() as conn:
        rows = conn.execute("""
            SELECT
                twitch_user AS user,
                MAX(ts) AS last_ts,
                COUNT(*) AS count
            FROM heartbeats
            WHERE twitch_user IS NOT NULL
            GROUP BY twitch_user
            ORDER BY last_ts DESC
        """).fetchall()
    return {
        "users": [
            {"user": r["user"], "last_ts": r["last_ts"], "count": r["count"]}
            for r in rows
        ]
    }


@app.get("/stats/categories", dependencies=[Depends(require_api_key)])
def stats_categories(window: str = "today", user: Optional[str] = None, platform: str = "twitch"):
    """Top 10 categories by seconds in window. platform: twitch|youtube|merged.

    YouTube heartbeats have no category column, so youtube returns empty.
    Merged returns Twitch categories only (YouTube has none to merge).
    """
    if platform == "youtube":
        return {"categories": []}
    since = _window_since(window)
    with db() as conn:
        if platform == "merged":
            tw_user, _ = _resolve_merged_user(conn, user)
            user_sql, user_params = _user_clause(tw_user)
        else:
            user_sql, user_params = _user_clause(user)
        rows = conn.execute(f"""
            SELECT category, COUNT(*) AS n
            FROM heartbeats
            WHERE ts >= ? AND category IS NOT NULL {user_sql}
            GROUP BY category
            ORDER BY n DESC
            LIMIT 10
        """, (since, *user_params)).fetchall()
    return {
        "categories": [
            {"category": r["category"], "seconds": _seconds_from_count(r["n"])}
            for r in rows
        ]
    }


@app.get("/stats/recent", dependencies=[Depends(require_api_key)])
def stats_recent(limit: int = 5, user: Optional[str] = None):
    """Last N distinct channels with their last-watched timestamp."""
    limit = max(1, min(limit, 50))
    user_sql, user_params = _user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT channel, MAX(ts) AS last_ts
            FROM heartbeats
            WHERE 1=1 {user_sql}
            GROUP BY channel
            ORDER BY last_ts DESC
            LIMIT ?
        """, (*user_params, limit)).fetchall()
    return {
        "recent": [
            {"channel": r["channel"], "last_ts": r["last_ts"]}
            for r in rows
        ]
    }


# ---------- Helpers ----------

def _user_clause(user: Optional[str]):
    """
    Build a (sql_fragment, params) tuple for the twitch_user filter.
    - None -> ('', ()) means no filter.
    - 'anonymous' -> ('AND twitch_user IS NULL', ())
    - other -> ('AND twitch_user = ?', (value,))
    """
    if user is None:
        return "", ()
    if user == "anonymous":
        return "AND twitch_user IS NULL", ()
    return "AND twitch_user = ?", (user,)


def _stats_since(since: int, include_passive: bool, user: Optional[str] = None):
    state_filter = "" if include_passive else "AND state = 'active'"
    user_sql, user_params = _user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT channel, COUNT(*) AS n
            FROM heartbeats
            WHERE ts >= ? {state_filter} {user_sql}
            GROUP BY channel
            ORDER BY n DESC
        """, (since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "channels": [
            {"channel": r["channel"], "seconds": _seconds_from_count(r["n"])}
            for r in rows
        ],
    }


def _window_since(window: str) -> int:
    if window == "today":
        return _local_midnight()
    if window == "week":
        return int(time.time()) - 7 * 86400
    if window == "month":
        return int(time.time()) - 30 * 86400
    return 0  # 'all' or unknown


def _local_midnight() -> int:
    """Unix ts of today's 00:00 in the server's local timezone."""
    now = time.localtime()
    midnight_struct = time.struct_time((
        now.tm_year, now.tm_mon, now.tm_mday,
        0, 0, 0, now.tm_wday, now.tm_yday, now.tm_isdst,
    ))
    return int(time.mktime(midnight_struct))


def _yt_user_clause(user: Optional[str]):
    if user is None:
        return "", ()
    if user == "anonymous":
        return "AND youtube_user IS NULL", ()
    return "AND youtube_user = ?", (user,)


def _media_user_clause(user: Optional[str]):
    if user is None:
        return "", ()
    if user == "anonymous":
        return "AND media_user IS NULL", ()
    return "AND media_user = ?", (user,)


def _media_stats_since(platform: str, since: int, include_passive: bool, user: Optional[str] = None):
    state_filter = "" if include_passive else "AND state = 'active'"
    user_sql, user_params = _media_user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT channel, COUNT(*) AS n
            FROM media_heartbeats
            WHERE platform = ? AND ts >= ? {state_filter} {user_sql}
            GROUP BY channel
            ORDER BY n DESC
        """, (platform, since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "channels": [
            {"channel": r["channel"], "seconds": _seconds_from_count(r["n"])}
            for r in rows
        ],
    }


def _resolve_merged_user(conn, label: Optional[str]):
    """Look up a user_accounts label and return (twitch_user, youtube_user).

    Returns (None, None) if label is None (= all accounts).
    Raises 404 if label not found.
    """
    if label is None:
        return None, None
    row = conn.execute(
        "SELECT twitch_user, youtube_user FROM user_accounts WHERE label = ?",
        (label,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Merged account '{label}' not found")
    return row["twitch_user"], row["youtube_user"]


def _yt_stats_since(since: int, include_passive: bool, user: Optional[str] = None):
    state_filter = "" if include_passive else "AND state = 'active'"
    user_sql, user_params = _yt_user_clause(user)
    with db() as conn:
        rows = conn.execute(f"""
            SELECT channel, COUNT(*) AS n
            FROM youtube_heartbeats
            WHERE ts >= ? {state_filter} {user_sql}
            GROUP BY channel
            ORDER BY n DESC
        """, (since, *user_params)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "channels": [
            {"channel": r["channel"], "seconds": _seconds_from_count(r["n"])}
            for r in rows
        ],
    }


# ---------- Data management (backup / export / import) ----------

EXPORT_TABLES = {
    "heartbeats": [
        "id", "ts", "channel", "category", "title", "state",
        "tab_visible", "client_id", "twitch_user",
    ],
    "youtube_heartbeats": [
        "id", "ts", "channel", "title", "video_id", "playlist_id",
        "state", "tab_visible", "youtube_user", "client_id",
    ],
    "media_heartbeats": [
        "id", "ts", "platform", "channel", "title", "video_id",
        "state", "tab_visible", "media_user", "client_id",
    ],
    "channel_links": ["id", "twitch_channel", "youtube_channel"],
    "user_accounts": ["id", "label", "twitch_user", "youtube_user"],
}


@app.get("/settings/export", dependencies=[Depends(require_api_key)])
def export_data():
    """Export all data as JSON."""
    result = {"version": 1, "exported_at": int(time.time()), "tables": {}}
    with db() as conn:
        for table, cols in EXPORT_TABLES.items():
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
            result["tables"][table] = [dict(r) for r in rows]
    return result


@app.get("/settings/backup", dependencies=[Depends(require_api_key)])
def backup_database():
    """Download a copy of the raw SQLite database file."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    try:
        with sqlite3.connect(DB_PATH) as src:
            with sqlite3.connect(tmp.name) as dst:
                src.backup(dst)
        data = pathlib.Path(tmp.name).read_bytes()
    finally:
        os.unlink(tmp.name)
    return Response(
        content=data,
        media_type="application/x-sqlite3",
        headers={"Content-Disposition": "attachment; filename=watchtime-backup.db"},
    )


@app.post("/settings/import", dependencies=[Depends(require_api_key)])
async def import_data(file: UploadFile = File(...), mode: str = "merge"):
    """Import data from a JSON export. mode=merge (skip dupes) or mode=replace (wipe+load)."""
    if mode not in ("merge", "replace"):
        raise HTTPException(400, "mode must be 'merge' or 'replace'")

    raw = await file.read()
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, "Invalid JSON file")

    tables = payload.get("tables")
    if not isinstance(tables, dict):
        raise HTTPException(400, "Missing 'tables' key in JSON")

    counts = {}
    with db() as conn:
        if mode == "replace":
            for table in EXPORT_TABLES:
                if table in tables:
                    conn.execute(f"DELETE FROM {table}")

        for table, cols in EXPORT_TABLES.items():
            rows = tables.get(table, [])
            if not rows:
                counts[table] = 0
                continue
            non_id_cols = [c for c in cols if c != "id"]
            placeholders = ", ".join("?" for _ in non_id_cols)
            col_names = ", ".join(non_id_cols)
            verb = "INSERT OR IGNORE" if mode == "merge" else "INSERT"
            inserted = 0
            for row in rows:
                vals = [row.get(c) for c in non_id_cols]
                try:
                    conn.execute(
                        f"{verb} INTO {table} ({col_names}) VALUES ({placeholders})",
                        vals,
                    )
                    inserted += 1
                except sqlite3.IntegrityError:
                    pass
            counts[table] = inserted

    return {"status": "ok", "mode": mode, "imported": counts}


# ---------- Plex poller ----------

import plex_poller


@app.on_event("startup")
def _start_plex_poller():
    if plex_poller.start(DB_PATH, HEARTBEAT_INTERVAL):
        print("[watchtime] Plex poller started")


# ---------- Google Drive backup ----------

import gdrive


def _redirect_uri(request: Request):
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", "localhost"))
    return f"{scheme}://{host}/settings/gdrive/callback"


@app.get("/settings/gdrive/status", dependencies=[Depends(require_api_key)])
def gdrive_status():
    if not gdrive.is_configured():
        return {"configured": False, "connected": False, "backups": []}
    connected = gdrive.is_connected()
    backups = gdrive.list_backups() if connected else []
    return {"configured": True, "connected": connected, "backups": backups}


@app.get("/settings/gdrive/connect")
def gdrive_connect(request: Request, x_api_key: Optional[str] = Query(default=None, alias="x-api-key")):
    if x_api_key != API_KEY:
        raise HTTPException(401, "bad api key")
    if not gdrive.is_configured():
        raise HTTPException(400, "GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET env vars not set")
    url = gdrive.get_auth_url(_redirect_uri(request))
    return RedirectResponse(url)


@app.get("/settings/gdrive/callback")
def gdrive_callback(request: Request, code: str = Query(...)):
    gdrive.exchange_code(code, _redirect_uri(request))
    return RedirectResponse("/settings")


@app.post("/settings/gdrive/backup", dependencies=[Depends(require_api_key)])
def gdrive_backup_now():
    if not gdrive.is_connected():
        raise HTTPException(400, "Google Drive not connected")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    try:
        with sqlite3.connect(DB_PATH) as src:
            with sqlite3.connect(tmp.name) as dst:
                src.backup(dst)
        ts = time.strftime("%Y-%m-%d_%H%M%S")
        uploaded = gdrive.upload_file(tmp.name, f"watchtime-{ts}.db")
    finally:
        os.unlink(tmp.name)
    deleted = gdrive.rotate_backups()
    return {"status": "ok", "uploaded": uploaded, "rotated_out": deleted}


@app.delete("/settings/gdrive/disconnect", dependencies=[Depends(require_api_key)])
def gdrive_disconnect():
    gdrive.disconnect()
    return {"status": "ok"}
