"""
Twitch Watch Time API
Heartbeat-based watch time tracker. The browser extension POSTs heartbeats
every N seconds while a Twitch video is playing; we store them and compute
watch time as COUNT(heartbeats) * interval.
"""
import os
import pathlib
import sqlite3
import time
from contextlib import contextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

API_KEY = os.environ["API_KEY"]
DB_PATH = os.environ.get("DB_PATH", "/data/watchtime.db")
HEARTBEAT_INTERVAL = int(os.environ.get("HEARTBEAT_INTERVAL_SECONDS", "60"))

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


@app.get("/", include_in_schema=False)
def root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/tv", include_in_schema=False)
def tv():
    return FileResponse(STATIC_DIR / "tv.html")


@app.get("/twitch", include_in_schema=False)
def twitch_page():
    return FileResponse(STATIC_DIR / "twitch.html")


@app.get("/youtube", include_in_schema=False)
def youtube_page():
    return FileResponse(STATIC_DIR / "youtube.html")


@app.get("/settings", include_in_schema=False)
def settings_page():
    return FileResponse(STATIC_DIR / "settings.html")


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
def stats_top_channel(window: str = "today", user: Optional[str] = None):
    """Single channel name + seconds for the given window."""
    since = _window_since(window)
    user_sql, user_params = _user_clause(user)
    with db() as conn:
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
def stats_total(window: str = "today", user: Optional[str] = None):
    """Total seconds in a window."""
    since = _window_since(window)
    user_sql, user_params = _user_clause(user)
    with db() as conn:
        row = conn.execute(f"""
            SELECT COUNT(*) AS n FROM heartbeats
            WHERE ts >= ? {user_sql}
        """, (since, *user_params)).fetchone()
    return {"window": window, "seconds": _seconds_from_count(row["n"])}


@app.get("/stats/now", dependencies=[Depends(require_api_key)])
def stats_now(user: Optional[str] = None):
    """Most recent heartbeat in last 120s, or {'now': None}."""
    cutoff = int(time.time()) - 120
    user_sql, user_params = _user_clause(user)
    with db() as conn:
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
def stats_channel(channel: str, window: str = "today", user: Optional[str] = None):
    """Seconds watched for a specific channel in a window."""
    since = _window_since(window)
    user_sql, user_params = _user_clause(user)
    with db() as conn:
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
def stats_categories(window: str = "today", user: Optional[str] = None):
    """Top 10 categories by seconds in window. Excludes NULL categories."""
    since = _window_since(window)
    user_sql, user_params = _user_clause(user)
    with db() as conn:
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
