"""
Twitch Watch Time API
Heartbeat-based watch time tracker. The browser extension POSTs heartbeats
every N seconds while a Twitch video is playing; we store them and compute
watch time as COUNT(heartbeats) * interval.
"""
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
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
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


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


def _seconds_from_count(n: int) -> int:
    return n * HEARTBEAT_INTERVAL


@app.get("/stats/today", dependencies=[Depends(require_api_key)])
def stats_today(include_passive: bool = True):
    """Total watch time today (server local time) per channel."""
    midnight = _local_midnight()
    return _stats_since(midnight, include_passive)


@app.get("/stats/week", dependencies=[Depends(require_api_key)])
def stats_week(include_passive: bool = True):
    """Last 7 days, per channel."""
    since = int(time.time()) - 7 * 86400
    return _stats_since(since, include_passive)


@app.get("/stats/all", dependencies=[Depends(require_api_key)])
def stats_all(include_passive: bool = True):
    return _stats_since(0, include_passive)


@app.get("/stats/daily", dependencies=[Depends(require_api_key)])
def stats_daily(days: int = 30, include_passive: bool = True):
    """Watch time per day for the last N days."""
    since = int(time.time()) - days * 86400
    state_filter = "" if include_passive else "AND state = 'active'"
    with db() as conn:
        rows = conn.execute(f"""
            SELECT
                date(ts, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS n
            FROM heartbeats
            WHERE ts >= ? {state_filter}
            GROUP BY day
            ORDER BY day ASC
        """, (since,)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "days": [
            {"day": r["day"], "seconds": _seconds_from_count(r["n"])}
            for r in rows
        ],
    }


@app.get("/stats/top_channel", dependencies=[Depends(require_api_key)])
def stats_top_channel(window: str = "today"):
    """Convenience endpoint for Home Assistant — single channel name + seconds."""
    if window == "today":
        since = _local_midnight()
    elif window == "week":
        since = int(time.time()) - 7 * 86400
    else:
        since = 0
    with db() as conn:
        row = conn.execute("""
            SELECT channel, COUNT(*) AS n
            FROM heartbeats
            WHERE ts >= ?
            GROUP BY channel
            ORDER BY n DESC
            LIMIT 1
        """, (since,)).fetchone()
    if not row:
        return {"channel": None, "seconds": 0}
    return {"channel": row["channel"], "seconds": _seconds_from_count(row["n"])}


@app.get("/stats/total", dependencies=[Depends(require_api_key)])
def stats_total(window: str = "today"):
    """Total seconds watched across all channels in a window."""
    if window == "today":
        since = _local_midnight()
    elif window == "week":
        since = int(time.time()) - 7 * 86400
    else:
        since = 0
    with db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM heartbeats WHERE ts >= ?",
            (since,),
        ).fetchone()
    return {"window": window, "seconds": _seconds_from_count(row["n"])}


# ---------- Helpers ----------

def _stats_since(since: int, include_passive: bool):
    state_filter = "" if include_passive else "AND state = 'active'"
    with db() as conn:
        rows = conn.execute(f"""
            SELECT channel, COUNT(*) AS n
            FROM heartbeats
            WHERE ts >= ? {state_filter}
            GROUP BY channel
            ORDER BY n DESC
        """, (since,)).fetchall()
    return {
        "interval_seconds": HEARTBEAT_INTERVAL,
        "channels": [
            {"channel": r["channel"], "seconds": _seconds_from_count(r["n"])}
            for r in rows
        ],
    }


def _local_midnight() -> int:
    """Unix ts of today's 00:00 in the server's local timezone."""
    now = time.localtime()
    midnight_struct = time.struct_time((
        now.tm_year, now.tm_mon, now.tm_mday,
        0, 0, 0, now.tm_wday, now.tm_yday, now.tm_isdst,
    ))
    return int(time.mktime(midnight_struct))
