# YouTube Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YouTube watch time tracking — separate youtube_heartbeats table, mirrored /stats/youtube/* API, four frontend pages (/, /twitch, /youtube, /settings), and a merged Chrome extension covering both platforms.

**Architecture:** Additive only — existing Twitch heartbeats table and all existing endpoints are untouched. New youtube_heartbeats + channel_links SQLite tables added to init_db. Backend grows two new Pydantic models and ~12 new endpoints. Extension gains youtube-content.js; background.js routes by platform field in heartbeat payload.

**Tech Stack:** Python 3.11, FastAPI, SQLite, Pydantic v2, pytest, Vanilla JS ES2020, Chart.js 4.4, Chrome Manifest V3.

---

## File Map

**Backend**
- `api/main.py` — MODIFY: extend init_db, add YoutubeHeartbeat/ChannelLink models, add _yt_user_clause/_yt_stats_since helpers, add all new endpoints and page routes
- `api/tests/conftest.py` — MODIFY: add _clean_youtube_data autouse fixture + insert_youtube_heartbeat helper
- `api/tests/test_youtube_tables.py` — CREATE
- `api/tests/test_youtube_ingest.py` — CREATE
- `api/tests/test_youtube_stats.py` — CREATE
- `api/tests/test_channel_links.py` — CREATE
- `api/tests/test_static_routes.py` — MODIFY: add /twitch /youtube /settings smoke tests

**Static Pages**
- `api/static/styles.css` — MODIFY: add .topnav + .platform-badge styles
- `api/static/twitch.html` — CREATE: Twitch dashboard (current index.html + nav)
- `api/static/twitch.js` — CREATE: copy of current app.js (no logic changes)
- `api/static/youtube.html` — CREATE: YouTube-only dashboard
- `api/static/youtube.js` — CREATE: YouTube-only dashboard JS
- `api/static/settings.html` — CREATE: channel link management
- `api/static/settings.js` — CREATE: channel link management JS
- `api/static/index.html` — MODIFY: replace with merged view
- `api/static/app.js` — MODIFY: replace with merged view JS

**Extension**
- `extension/youtube-content.js` — CREATE
- `extension/manifest.json` — MODIFY: add youtube.com permissions + content script entry
- `extension/background.js` — MODIFY: route youtube heartbeats to /youtube/heartbeats

---

## Task 1: Add youtube_heartbeats and channel_links tables

**Files:**
- Modify: `api/main.py` — init_db executescript (lines 61–79)
- Create: `api/tests/test_youtube_tables.py`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_youtube_tables.py`:

```python
"""Verify youtube_heartbeats and channel_links tables are created by init_db."""
import sqlite3
from tests.conftest import DB_PATH


def test_youtube_heartbeats_table_exists():
    conn = sqlite3.connect(DB_PATH)
    try:
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
    finally:
        conn.close()
    assert "youtube_heartbeats" in tables
    assert "channel_links" in tables


def test_youtube_heartbeats_has_required_columns():
    conn = sqlite3.connect(DB_PATH)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(youtube_heartbeats)")}
    finally:
        conn.close()
    assert cols >= {"id", "ts", "channel", "title", "video_id", "playlist_id",
                    "state", "tab_visible", "youtube_user", "client_id"}


def test_channel_links_has_required_columns():
    conn = sqlite3.connect(DB_PATH)
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(channel_links)")}
    finally:
        conn.close()
    assert cols >= {"id", "twitch_channel", "youtube_channel"}
```

- [ ] **Step 2: Run to verify they fail**

```
cd api && pytest tests/test_youtube_tables.py -v
```
Expected: FAIL — tables not found.

- [ ] **Step 3: Extend init_db in api/main.py**

Replace the `conn.executescript(...)` block inside `init_db()` (the one that creates the heartbeats table) with:

```python
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
        """)
```

- [ ] **Step 4: Run to verify they pass**

```
cd api && pytest tests/test_youtube_tables.py -v
```
Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add api/main.py api/tests/test_youtube_tables.py
git commit -m "feat: add youtube_heartbeats and channel_links tables"
```

---

## Task 2: Add YouTube fixtures to conftest.py

**Files:**
- Modify: `api/tests/conftest.py`

- [ ] **Step 1: Add autouse cleanup fixture and insert helper**

In `api/tests/conftest.py`, add after the existing `_clean_heartbeats` fixture (after line 45):

```python
@pytest.fixture(autouse=True)
def _clean_youtube_data(app):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("DELETE FROM youtube_heartbeats")
        conn.execute("DELETE FROM channel_links")
        conn.commit()
    finally:
        conn.close()
    yield


def insert_youtube_heartbeat(
    db_conn, ts, channel, youtube_user=None, title=None,
    video_id=None, playlist_id=None, state="active", tab_visible=1,
    client_id="test-client",
):
    """Insert a youtube_heartbeat row directly. Caller must commit."""
    db_conn.execute(
        "INSERT INTO youtube_heartbeats "
        "(ts, channel, title, video_id, playlist_id, state, tab_visible, youtube_user, client_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (ts, channel.lower(), title, video_id, playlist_id, state, tab_visible, youtube_user, client_id),
    )
```

- [ ] **Step 2: Verify existing tests still pass**

```
cd api && pytest -v
```
Expected: all existing tests PASSED.

- [ ] **Step 3: Commit**

```bash
git add api/tests/conftest.py
git commit -m "test: add youtube fixtures to conftest"
```

---

## Task 3: YouTube ingest endpoint

**Files:**
- Modify: `api/main.py`
- Create: `api/tests/test_youtube_ingest.py`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_youtube_ingest.py`:

```python
"""Tests for POST /youtube/heartbeats."""
import sqlite3
import time
from tests.conftest import DB_PATH


def _payload(**overrides):
    base = {
        "ts": int(time.time()),
        "channel": "mkbhd",
        "state": "active",
        "tab_visible": True,
        "client_id": "test-client",
    }
    base.update(overrides)
    return base


def test_youtube_batch_stores_heartbeats(client, auth_headers):
    batch = {"heartbeats": [
        _payload(channel="mkbhd", youtube_user="me"),
        _payload(channel="linus", state="passive"),
    ]}
    res = client.post("/youtube/heartbeats", json=batch, headers=auth_headers)
    assert res.status_code == 200
    assert res.json() == {"ok": True, "stored": 2}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT channel, youtube_user FROM youtube_heartbeats ORDER BY id"
        ).fetchall()
    finally:
        conn.close()
    assert [(r["channel"], r["youtube_user"]) for r in rows] == [
        ("mkbhd", "me"), ("linus", None),
    ]


def test_youtube_batch_without_optional_fields(client, auth_headers):
    batch = {"heartbeats": [_payload()]}
    res = client.post("/youtube/heartbeats", json=batch, headers=auth_headers)
    assert res.status_code == 200
    assert res.json()["stored"] == 1


def test_youtube_batch_stores_playlist_id(client, auth_headers):
    batch = {"heartbeats": [_payload(playlist_id="PLabc123")]}
    client.post("/youtube/heartbeats", json=batch, headers=auth_headers)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT playlist_id FROM youtube_heartbeats ORDER BY id DESC LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    assert row["playlist_id"] == "PLabc123"


def test_youtube_batch_requires_auth(client):
    res = client.post("/youtube/heartbeats", json={"heartbeats": [_payload()]})
    assert res.status_code == 401


def test_youtube_batch_channel_lowercased(client, auth_headers):
    batch = {"heartbeats": [_payload(channel="MKBHD")]}
    client.post("/youtube/heartbeats", json=batch, headers=auth_headers)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT channel FROM youtube_heartbeats ORDER BY id DESC LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    assert row["channel"] == "mkbhd"
```

- [ ] **Step 2: Run to verify they fail**

```
cd api && pytest tests/test_youtube_ingest.py -v
```
Expected: FAIL — 404 Not Found.

- [ ] **Step 3: Add YoutubeHeartbeat model to api/main.py**

After the existing `HeartbeatBatch` model (after line ~117), add:

```python
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
```

- [ ] **Step 4: Add POST /youtube/heartbeats endpoint to api/main.py**

After the existing `heartbeats_batch` endpoint (after line ~154), add:

```python
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
```

- [ ] **Step 5: Run to verify they pass**

```
cd api && pytest tests/test_youtube_ingest.py -v
```
Expected: 5 PASSED.

- [ ] **Step 6: Commit**

```bash
git add api/main.py api/tests/test_youtube_ingest.py
git commit -m "feat: add POST /youtube/heartbeats ingest endpoint"
```

---

## Task 4: YouTube stats endpoints

**Files:**
- Modify: `api/main.py`
- Create: `api/tests/test_youtube_stats.py`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_youtube_stats.py`:

```python
"""Tests for /stats/youtube/* endpoints."""
import time
from tests.conftest import insert_youtube_heartbeat


def test_youtube_users_empty(client, auth_headers):
    res = client.get("/stats/youtube/users", headers=auth_headers)
    assert res.json() == {"users": []}


def test_youtube_users_lists_accounts(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 100, channel="a", youtube_user="user_a")
    insert_youtube_heartbeat(db, ts=now - 50,  channel="b", youtube_user="user_a")
    insert_youtube_heartbeat(db, ts=now - 200, channel="c", youtube_user="user_b")
    db.commit()
    res = client.get("/stats/youtube/users", headers=auth_headers)
    users = {u["user"] for u in res.json()["users"]}
    assert users == {"user_a", "user_b"}


def test_youtube_stats_today_counts_seconds(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 30, channel="mkbhd")
    insert_youtube_heartbeat(db, ts=now - 60, channel="mkbhd")
    db.commit()
    res = client.get("/stats/youtube/today", headers=auth_headers)
    data = res.json()
    assert data["channels"][0]["channel"] == "mkbhd"
    assert data["channels"][0]["seconds"] == 120


def test_youtube_stats_today_user_filter(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 10, channel="a", youtube_user="user_a")
    insert_youtube_heartbeat(db, ts=now - 20, channel="b", youtube_user="user_b")
    db.commit()
    res = client.get("/stats/youtube/today?user=user_a", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert channels == ["a"]


def test_youtube_stats_week_excludes_old(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 3 * 86400, channel="recent")
    insert_youtube_heartbeat(db, ts=now - 10 * 86400, channel="old")
    db.commit()
    res = client.get("/stats/youtube/week", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert "recent" in channels
    assert "old" not in channels


def test_youtube_stats_month_excludes_old(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 15 * 86400, channel="recent")
    insert_youtube_heartbeat(db, ts=now - 45 * 86400, channel="old")
    db.commit()
    res = client.get("/stats/youtube/month", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert "recent" in channels
    assert "old" not in channels


def test_youtube_stats_all_includes_old(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 365 * 86400, channel="ancient")
    db.commit()
    res = client.get("/stats/youtube/all", headers=auth_headers)
    channels = [c["channel"] for c in res.json()["channels"]]
    assert "ancient" in channels


def test_youtube_playlists_groups_by_playlist_id(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 10, channel="a", playlist_id="PLabc")
    insert_youtube_heartbeat(db, ts=now - 20, channel="b", playlist_id="PLabc")
    insert_youtube_heartbeat(db, ts=now - 30, channel="c", playlist_id="PLxyz")
    insert_youtube_heartbeat(db, ts=now - 40, channel="d")  # no playlist
    db.commit()
    res = client.get("/stats/youtube/playlists?window=today", headers=auth_headers)
    playlists = {p["playlist_id"]: p["seconds"] for p in res.json()["playlists"]}
    assert playlists["PLabc"] == 120
    assert playlists["PLxyz"] == 60
    assert None not in playlists


def test_youtube_playlists_exclude_passive(client, auth_headers, db):
    now = int(time.time())
    insert_youtube_heartbeat(db, ts=now - 10, channel="a", playlist_id="PLabc", state="active")
    insert_youtube_heartbeat(db, ts=now - 20, channel="b", playlist_id="PLabc", state="passive")
    db.commit()
    res = client.get(
        "/stats/youtube/playlists?window=today&include_passive=false",
        headers=auth_headers,
    )
    playlists = {p["playlist_id"]: p["seconds"] for p in res.json()["playlists"]}
    assert playlists["PLabc"] == 60


def test_youtube_stats_requires_auth(client):
    for path in ["/stats/youtube/users", "/stats/youtube/today", "/stats/youtube/playlists"]:
        assert client.get(path).status_code == 401
```

- [ ] **Step 2: Run to verify they fail**

```
cd api && pytest tests/test_youtube_stats.py -v
```
Expected: FAIL — 404 Not Found.

- [ ] **Step 3: Add helpers to api/main.py**

In the `# ---------- Helpers ----------` section (after `_local_midnight`), add:

```python
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
```

- [ ] **Step 4: Add /stats/youtube/* endpoints to api/main.py**

After the `youtube_heartbeats_batch` endpoint, add:

```python
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
```

- [ ] **Step 5: Run to verify they pass**

```
cd api && pytest tests/test_youtube_stats.py -v
```
Expected: 10 PASSED.

- [ ] **Step 6: Commit**

```bash
git add api/main.py api/tests/test_youtube_stats.py
git commit -m "feat: add /stats/youtube/* endpoints including playlists"
```

---

## Task 5: Channel links CRUD

**Files:**
- Modify: `api/main.py`
- Create: `api/tests/test_channel_links.py`

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_channel_links.py`:

```python
"""Tests for /settings/channel-links CRUD."""


def test_get_links_empty(client, auth_headers):
    res = client.get("/settings/channel-links", headers=auth_headers)
    assert res.json() == {"links": []}


def test_add_link(client, auth_headers):
    res = client.post(
        "/settings/channel-links",
        json={"twitch_channel": "xqc", "youtube_channel": "xqcow"},
        headers=auth_headers,
    )
    assert res.status_code == 200
    assert "id" in res.json()
    links = client.get("/settings/channel-links", headers=auth_headers).json()["links"]
    assert len(links) == 1
    assert links[0]["twitch_channel"] == "xqc"
    assert links[0]["youtube_channel"] == "xqcow"


def test_add_link_lowercases_channels(client, auth_headers):
    client.post(
        "/settings/channel-links",
        json={"twitch_channel": "XQC", "youtube_channel": "XQCow"},
        headers=auth_headers,
    )
    links = client.get("/settings/channel-links", headers=auth_headers).json()["links"]
    assert links[0]["twitch_channel"] == "xqc"
    assert links[0]["youtube_channel"] == "xqcow"


def test_add_duplicate_link_is_idempotent(client, auth_headers):
    payload = {"twitch_channel": "xqc", "youtube_channel": "xqcow"}
    r1 = client.post("/settings/channel-links", json=payload, headers=auth_headers)
    r2 = client.post("/settings/channel-links", json=payload, headers=auth_headers)
    assert r1.status_code == 200
    assert r2.status_code == 200
    links = client.get("/settings/channel-links", headers=auth_headers).json()["links"]
    assert len(links) == 1


def test_delete_link(client, auth_headers):
    r = client.post(
        "/settings/channel-links",
        json={"twitch_channel": "xqc", "youtube_channel": "xqcow"},
        headers=auth_headers,
    )
    link_id = r.json()["id"]
    del_res = client.delete(f"/settings/channel-links/{link_id}", headers=auth_headers)
    assert del_res.json() == {"ok": True}
    links = client.get("/settings/channel-links", headers=auth_headers).json()["links"]
    assert links == []


def test_channel_links_require_auth(client):
    assert client.get("/settings/channel-links").status_code == 401
    assert client.post(
        "/settings/channel-links",
        json={"twitch_channel": "a", "youtube_channel": "b"},
    ).status_code == 401
    assert client.delete("/settings/channel-links/1").status_code == 401
```

- [ ] **Step 2: Run to verify they fail**

```
cd api && pytest tests/test_channel_links.py -v
```
Expected: FAIL — 404 Not Found.

- [ ] **Step 3: Add ChannelLink model to api/main.py**

After `YoutubeHeartbeatBatch` model, add:

```python
class ChannelLink(BaseModel):
    twitch_channel: str = Field(..., min_length=1, max_length=64)
    youtube_channel: str = Field(..., min_length=1, max_length=128)
```

- [ ] **Step 4: Add CRUD endpoints to api/main.py**

After `yt_stats_playlists`, add:

```python
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
        conn.execute("DELETE FROM channel_links WHERE id = ?", (link_id,))
    return {"ok": True}
```

- [ ] **Step 5: Run full test suite**

```
cd api && pytest -v
```
Expected: all PASSED.

- [ ] **Step 6: Commit**

```bash
git add api/main.py api/tests/test_channel_links.py
git commit -m "feat: add /settings/channel-links CRUD"
```

---

## Task 6: New page routes and placeholder HTML files

**Files:**
- Modify: `api/main.py`
- Modify: `api/tests/test_static_routes.py`
- Create: `api/static/twitch.html` (placeholder)
- Create: `api/static/youtube.html` (placeholder)
- Create: `api/static/settings.html` (placeholder)

- [ ] **Step 1: Add three tests to api/tests/test_static_routes.py**

Append to `api/tests/test_static_routes.py`:

```python
def test_twitch_returns_html(client):
    res = client.get("/twitch")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")


def test_youtube_returns_html(client):
    res = client.get("/youtube")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")


def test_settings_returns_html(client):
    res = client.get("/settings")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
```

- [ ] **Step 2: Run to verify they fail**

```
cd api && pytest tests/test_static_routes.py -v
```
Expected: 3 new tests FAIL — 404.

- [ ] **Step 3: Create placeholder HTML files**

Create `api/static/twitch.html`:
```html
<!doctype html><html lang="en"><body>Twitch</body></html>
```

Create `api/static/youtube.html`:
```html
<!doctype html><html lang="en"><body>YouTube</body></html>
```

Create `api/static/settings.html`:
```html
<!doctype html><html lang="en"><body>Settings</body></html>
```

- [ ] **Step 4: Add routes to api/main.py**

After the existing `@app.get("/tv")` route (around line 48), add:

```python
@app.get("/twitch", include_in_schema=False)
def twitch_page():
    return FileResponse(STATIC_DIR / "twitch.html")


@app.get("/youtube", include_in_schema=False)
def youtube_page():
    return FileResponse(STATIC_DIR / "youtube.html")


@app.get("/settings", include_in_schema=False)
def settings_page():
    return FileResponse(STATIC_DIR / "settings.html")
```

- [ ] **Step 5: Run to verify they pass**

```
cd api && pytest tests/test_static_routes.py -v
```
Expected: all PASSED.

- [ ] **Step 6: Commit**

```bash
git add api/main.py api/static/twitch.html api/static/youtube.html api/static/settings.html api/tests/test_static_routes.py
git commit -m "feat: add /twitch /youtube /settings page routes"
```

---

## Task 7: Move Twitch dashboard to twitch.html/twitch.js

**Files:**
- Modify: `api/static/styles.css` — add nav + badge styles
- Create: `api/static/twitch.js` — copy of app.js
- Modify: `api/static/twitch.html` — replace placeholder with full dashboard

- [ ] **Step 1: Add nav and badge styles to api/static/styles.css**

Append to the end of `api/static/styles.css`:

```css
/* Navigation */
.topnav { display: flex; gap: 16px; align-items: center; margin: 0 auto 0 24px; }
.topnav a { color: var(--muted); text-decoration: none; font-size: 13px; padding: 4px 8px; border-radius: 4px; }
.topnav a:hover { color: var(--text); }
.topnav a.active { color: var(--text); background: var(--surface); }

/* Platform badges */
.platform-badge { font-size: 10px; padding: 2px 6px; border-radius: 10px; font-weight: 600; vertical-align: middle; }
.platform-badge.twitch { background: rgba(145,70,255,0.15); color: #9146FF; }
.platform-badge.youtube { background: rgba(255,68,68,0.12); color: #FF4444; }
```

- [ ] **Step 2: Create api/static/twitch.js**

```bash
cp api/static/app.js api/static/twitch.js
```

- [ ] **Step 3: Replace api/static/twitch.html with full dashboard**

Write the full content of `api/static/twitch.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Twitch Watchtime</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <div id="gate" class="gate hidden">
    <div class="card">
      <h2>Twitch Watchtime</h2>
      <p style="color:var(--muted); margin-top:8px; font-size:13px;">
        Paste your API key to unlock the dashboard.
      </p>
      <input id="gate-input" type="password" placeholder="API key" autocomplete="off">
      <button id="gate-submit">Unlock</button>
      <div id="gate-err" class="err"></div>
    </div>
  </div>

  <div id="app" class="page hidden">
    <div class="topbar">
      <h1>Twitch Watchtime</h1>
      <nav class="topnav">
        <a href="/">Merged</a>
        <a href="/twitch" class="active">Twitch</a>
        <a href="/youtube">YouTube</a>
        <a href="/settings">Settings</a>
      </nav>
      <select id="account-picker" class="account-picker"></select>
    </div>

    <div class="card hero">
      <div>
        <div class="today-label">Today</div>
        <div class="today-value mono" id="today-value">0h 0m</div>
      </div>
      <div class="top">
        <div class="today-label">Top today</div>
        <div class="top-channel" id="top-channel">—</div>
        <div class="top-seconds mono" id="top-seconds">0m</div>
      </div>
    </div>

    <div class="card live-card hidden" id="live-indicator">
      <div class="live-meta">
        <span class="dot"></span>
        <span id="live-label">Now watching</span>
      </div>
      <div class="live-channel-name" id="live-channel"></div>
      <div class="live-title" id="live-title"></div>
      <div class="live-category" id="live-category"></div>
    </div>

    <div class="pills">
      <button class="pill active" data-window="today">Today</button>
      <button class="pill" data-window="week">Last 7 days</button>
      <button class="pill" data-window="month">Last 30 days</button>
      <button class="pill" data-window="all">All-time</button>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Top channels</h2>
        <div id="top-channels" class="ranked"></div>
      </div>
      <div class="card">
        <h2>Top categories</h2>
        <div id="top-categories" class="ranked"></div>
      </div>
      <div class="card">
        <h2>Daily — last 30 days</h2>
        <div class="chart-box"><canvas id="daily-chart"></canvas></div>
      </div>
      <div class="card">
        <h2>Quick stats</h2>
        <div class="mini-grid">
          <div class="mini">
            <div class="val mono" id="qs-total">0h</div>
            <div class="lbl">Total all-time</div>
          </div>
          <div class="mini">
            <div class="val mono" id="qs-channels">0</div>
            <div class="lbl">Channels watched</div>
          </div>
          <div class="mini">
            <div class="val mono" id="qs-longest">0h</div>
            <div class="lbl">Longest day</div>
          </div>
        </div>
      </div>
      <div class="card">
        <h2>Recently watched</h2>
        <div id="recent-list"></div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="/static/twitch.js"></script>
</body>
</html>
```

- [ ] **Step 4: Run tests**

```
cd api && pytest -v
```
Expected: all PASSED.

- [ ] **Step 5: Commit**

```bash
git add api/static/twitch.html api/static/twitch.js api/static/styles.css
git commit -m "feat: Twitch dashboard at /twitch with top nav"
```

---

## Task 8: YouTube dashboard page

**Files:**
- Create: `api/static/youtube.html` (replaces placeholder)
- Create: `api/static/youtube.js`

- [ ] **Step 1: Create api/static/youtube.js**

Write `api/static/youtube.js`:

```javascript
const POLL_MS = 10_000;
const STORAGE_KEY = "watchtime_api_key";
const YT_ACCOUNT_KEY = "watchtime_yt_account";
const WINDOW_PARAMS = { today: "today", last7days: "week", last30days: "month", alltime: "all" };
const WINDOW_TO_PARAM = Object.fromEntries(
  Object.entries(WINDOW_PARAMS).map(([k, v]) => [v, k])
);

const state = {
  apiKey: localStorage.getItem(STORAGE_KEY) || null,
  user: null,
  window: "today",
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

async function api(path) {
  const res = await fetch(path, { headers: { "X-API-Key": state.apiKey } });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(STORAGE_KEY);
    state.apiKey = null;
    showGate("Invalid API key.");
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function withUser(url) {
  if (!state.user) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}user=${encodeURIComponent(state.user)}`;
}

function showGate(errMsg = "") {
  $("gate").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("gate-err").textContent = errMsg;
  $("gate-input").value = "";
  $("gate-input").focus();
}

function hideGate() {
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
}

$("gate-submit").addEventListener("click", async () => {
  const key = $("gate-input").value.trim();
  if (!key) return;
  state.apiKey = key;
  try {
    await api("/stats/youtube/users");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

async function loadAccountPicker() {
  const { users } = await api("/stats/youtube/users");
  const select = $("account-picker");
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All accounts";
  select.appendChild(all);
  for (const u of users) {
    const opt = document.createElement("option");
    opt.value = u.user;
    opt.textContent = `Viewing: ${u.user}`;
    select.appendChild(opt);
  }
  const saved = localStorage.getItem(YT_ACCOUNT_KEY);
  const defaultUser = saved !== null ? saved : (users.length > 0 ? users[0].user : "");
  select.value = defaultUser;
  state.user = defaultUser || null;
}

$("account-picker").addEventListener("change", (e) => {
  state.user = e.target.value || null;
  localStorage.setItem(YT_ACCOUNT_KEY, state.user ?? "");
  refresh();
});

function applyWindowFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, win] of Object.entries(WINDOW_PARAMS)) {
    if (params.has(key)) {
      state.window = win;
      document.querySelectorAll(".pill").forEach(p =>
        p.classList.toggle("active", p.dataset.window === win));
      break;
    }
  }
}

function setWindowUrl(win) {
  const key = WINDOW_TO_PARAM[win];
  if (!key) return;
  history.replaceState(null, "", `?${key}`);
}

function fmtDuration(seconds) {
  if (!seconds) return "0 seconds";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (h > 0) return m === 0 ? plural(h, "hour") : `${plural(h, "hour")} ${plural(m, "minute")}`;
  if (m > 0) return s === 0 ? plural(m, "minute") : `${plural(m, "minute")} ${plural(s, "second")}`;
  return plural(s, "second");
}

const AVATAR_COLORS = ["#FF4444", "#FF8C00", "#FFD700", "#48dbfb", "#1dd1a1", "#f368e0", "#5f27cd", "#ff6b6b"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

async function updateTopChannels() {
  const data = await api(withUser(`/stats/youtube/${state.window}`));
  const channels = data.channels.slice(0, 10);
  const max = channels[0]?.seconds || 1;
  const root = $("top-channels");
  root.innerHTML = "";
  channels.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "ranked-row";
    row.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(c.channel)}">${c.channel[0].toUpperCase()}</div>
      <div class="name">${c.channel}</div>
      <div class="value mono">${fmtDuration(c.seconds)}</div>
      <div class="bar"><span style="width:${(c.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(row);
  });
  if (channels.length === 0) root.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
}

async function updateTopPlaylists() {
  const data = await api(withUser(`/stats/youtube/playlists?window=${state.window}`));
  const playlists = data.playlists.slice(0, 10);
  const max = playlists[0]?.seconds || 1;
  const root = $("top-playlists");
  root.innerHTML = "";
  playlists.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "ranked-row";
    row.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(p.playlist_id)}">${p.playlist_id[0].toUpperCase()}</div>
      <div class="name">${p.playlist_id}</div>
      <div class="value mono">${fmtDuration(p.seconds)}</div>
      <div class="bar"><span style="width:${(p.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(row);
  });
  if (playlists.length === 0) root.innerHTML = '<div style="color:var(--muted)">No playlist data yet.</div>';
}

async function updateHero() {
  const [todayData, allData] = await Promise.all([
    api(withUser("/stats/youtube/today")),
    api(withUser("/stats/youtube/all")),
  ]);
  const todaySecs = todayData.channels.reduce((s, c) => s + c.seconds, 0);
  $("today-value").textContent = fmtDuration(todaySecs);
  const top = todayData.channels[0];
  $("top-channel").textContent = top ? top.channel : "—";
  $("top-seconds").textContent = top ? fmtDuration(top.seconds) : "0 seconds";
  $("qs-total").textContent = fmtDuration(allData.channels.reduce((s, c) => s + c.seconds, 0));
  $("qs-channels").textContent = allData.channels.length.toString();
}

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.window = pill.dataset.window;
    setWindowUrl(state.window);
    updateTopChannels();
    updateTopPlaylists();
  });
});

async function refresh() {
  try {
    await Promise.all([updateHero(), updateTopChannels(), updateTopPlaylists()]);
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

async function boot() {
  await loadAccountPicker();
  applyWindowFromUrl();
  await refresh();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, POLL_MS);
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
```

- [ ] **Step 2: Replace api/static/youtube.html with full dashboard**

Write `api/static/youtube.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YouTube Watchtime</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <div id="gate" class="gate hidden">
    <div class="card">
      <h2>YouTube Watchtime</h2>
      <p style="color:var(--muted); margin-top:8px; font-size:13px;">
        Paste your API key to unlock the dashboard.
      </p>
      <input id="gate-input" type="password" placeholder="API key" autocomplete="off">
      <button id="gate-submit">Unlock</button>
      <div id="gate-err" class="err"></div>
    </div>
  </div>

  <div id="app" class="page hidden">
    <div class="topbar">
      <h1>YouTube Watchtime</h1>
      <nav class="topnav">
        <a href="/">Merged</a>
        <a href="/twitch">Twitch</a>
        <a href="/youtube" class="active">YouTube</a>
        <a href="/settings">Settings</a>
      </nav>
      <select id="account-picker" class="account-picker"></select>
    </div>

    <div class="card hero">
      <div>
        <div class="today-label">Today</div>
        <div class="today-value mono" id="today-value">0h 0m</div>
      </div>
      <div class="top">
        <div class="today-label">Top today</div>
        <div class="top-channel" id="top-channel">—</div>
        <div class="top-seconds mono" id="top-seconds">0 seconds</div>
      </div>
    </div>

    <div class="pills">
      <button class="pill active" data-window="today">Today</button>
      <button class="pill" data-window="week">Last 7 days</button>
      <button class="pill" data-window="month">Last 30 days</button>
      <button class="pill" data-window="all">All-time</button>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Top channels</h2>
        <div id="top-channels" class="ranked"></div>
      </div>
      <div class="card">
        <h2>Top playlists</h2>
        <div id="top-playlists" class="ranked"></div>
      </div>
      <div class="card">
        <h2>Quick stats</h2>
        <div class="mini-grid">
          <div class="mini">
            <div class="val mono" id="qs-total">0h</div>
            <div class="lbl">Total all-time</div>
          </div>
          <div class="mini">
            <div class="val mono" id="qs-channels">0</div>
            <div class="lbl">Channels watched</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="/static/youtube.js"></script>
</body>
</html>
```

- [ ] **Step 3: Run tests**

```
cd api && pytest -v
```
Expected: all PASSED.

- [ ] **Step 4: Commit**

```bash
git add api/static/youtube.html api/static/youtube.js
git commit -m "feat: YouTube dashboard at /youtube"
```

---

## Task 9: Settings page

**Files:**
- Create: `api/static/settings.html` (replaces placeholder)
- Create: `api/static/settings.js`

- [ ] **Step 1: Create api/static/settings.js**

Write `api/static/settings.js`:

```javascript
const STORAGE_KEY = "watchtime_api_key";
const $ = (id) => document.getElementById(id);
const state = { apiKey: localStorage.getItem(STORAGE_KEY) || null };

async function apiReq(method, path, body) {
  const opts = {
    method,
    headers: { "X-API-Key": state.apiKey, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(STORAGE_KEY);
    state.apiKey = null;
    showGate("Invalid API key.");
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showGate(errMsg = "") {
  $("gate").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("gate-err").textContent = errMsg;
  $("gate-input").value = "";
  $("gate-input").focus();
}

function hideGate() {
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
}

$("gate-submit").addEventListener("click", async () => {
  const key = $("gate-input").value.trim();
  if (!key) return;
  state.apiKey = key;
  try {
    await apiReq("GET", "/settings/channel-links");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

async function loadLinks() {
  const { links } = await apiReq("GET", "/settings/channel-links");
  const tbody = $("links-tbody");
  if (!links.length) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted); padding:12px 0">No links yet.</td></tr>';
    return;
  }
  tbody.innerHTML = links.map(l => `
    <tr>
      <td>${l.twitch_channel}</td>
      <td>${l.youtube_channel}</td>
      <td><button class="del-btn" data-id="${l.id}">Delete</button></td>
    </tr>
  `).join("");
  tbody.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await apiReq("DELETE", `/settings/channel-links/${btn.dataset.id}`);
      loadLinks();
    });
  });
}

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const twitch = $("input-twitch").value.trim().toLowerCase();
  const youtube = $("input-youtube").value.trim().toLowerCase();
  if (!twitch || !youtube) return;
  await apiReq("POST", "/settings/channel-links", {
    twitch_channel: twitch,
    youtube_channel: youtube,
  });
  $("input-twitch").value = "";
  $("input-youtube").value = "";
  loadLinks();
});

async function boot() {
  await loadLinks();
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
```

- [ ] **Step 2: Replace api/static/settings.html with full page**

Write `api/static/settings.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Settings — Watchtime</title>
  <link rel="stylesheet" href="/static/styles.css">
  <style>
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 4px; border-bottom: 1px solid var(--border, #2f2f35); }
    th { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
    .add-row { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    .add-row input { flex: 1; min-width: 140px; }
    .del-btn { background: none; border: 1px solid #555; color: var(--muted); padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .del-btn:hover { border-color: #ff6b6b; color: #ff6b6b; }
  </style>
</head>
<body>
  <div id="gate" class="gate hidden">
    <div class="card">
      <h2>Settings</h2>
      <p style="color:var(--muted); margin-top:8px; font-size:13px;">
        Paste your API key to unlock settings.
      </p>
      <input id="gate-input" type="password" placeholder="API key" autocomplete="off">
      <button id="gate-submit">Unlock</button>
      <div id="gate-err" class="err"></div>
    </div>
  </div>

  <div id="app" class="page hidden">
    <div class="topbar">
      <h1>Settings</h1>
      <nav class="topnav">
        <a href="/">Merged</a>
        <a href="/twitch">Twitch</a>
        <a href="/youtube">YouTube</a>
        <a href="/settings" class="active">Settings</a>
      </nav>
    </div>

    <div class="card" style="max-width:640px">
      <h2>Channel links</h2>
      <p style="color:var(--muted); font-size:13px; margin:8px 0 16px">
        Link a Twitch channel to a YouTube channel so they appear as one combined row on the merged dashboard.
      </p>
      <table>
        <thead>
          <tr>
            <th>Twitch channel</th>
            <th>YouTube channel</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="links-tbody"></tbody>
      </table>
      <form id="add-form" class="add-row">
        <input id="input-twitch" type="text" placeholder="Twitch handle (e.g. xqc)" autocomplete="off">
        <input id="input-youtube" type="text" placeholder="YouTube handle (e.g. xqcow)" autocomplete="off">
        <button type="submit">Add link</button>
      </form>
    </div>
  </div>

  <script src="/static/settings.js"></script>
</body>
</html>
```

- [ ] **Step 3: Run tests**

```
cd api && pytest -v
```
Expected: all PASSED.

- [ ] **Step 4: Commit**

```bash
git add api/static/settings.html api/static/settings.js
git commit -m "feat: settings page for channel link management"
```

---

## Task 10: Merged root page (index.html + app.js)

**Files:**
- Modify: `api/static/index.html`
- Modify: `api/static/app.js`

- [ ] **Step 1: Replace api/static/index.html**

Write the full content of `api/static/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Watchtime — Merged</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body>
  <div id="gate" class="gate hidden">
    <div class="card">
      <h2>Watchtime</h2>
      <p style="color:var(--muted); margin-top:8px; font-size:13px;">
        Paste your API key to unlock the dashboard.
      </p>
      <input id="gate-input" type="password" placeholder="API key" autocomplete="off">
      <button id="gate-submit">Unlock</button>
      <div id="gate-err" class="err"></div>
    </div>
  </div>

  <div id="app" class="page hidden">
    <div class="topbar">
      <h1>Watchtime</h1>
      <nav class="topnav">
        <a href="/" class="active">Merged</a>
        <a href="/twitch">Twitch</a>
        <a href="/youtube">YouTube</a>
        <a href="/settings">Settings</a>
      </nav>
    </div>

    <div style="display:flex; gap:12px; margin-bottom:8px; flex-wrap:wrap;">
      <select id="twitch-picker" class="account-picker"></select>
      <select id="youtube-picker" class="account-picker"></select>
    </div>

    <div class="pills">
      <button class="pill active" data-window="today">Today</button>
      <button class="pill" data-window="week">Last 7 days</button>
      <button class="pill" data-window="month">Last 30 days</button>
      <button class="pill" data-window="all">All-time</button>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>All channels</h2>
      <div id="merged-channels" class="ranked"></div>
    </div>
  </div>

  <script src="/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Replace api/static/app.js**

Write the full content of `api/static/app.js`:

```javascript
const POLL_MS = 10_000;
const STORAGE_KEY = "watchtime_api_key";
const TW_ACCOUNT_KEY = "watchtime_account";
const YT_ACCOUNT_KEY = "watchtime_yt_account";
const WINDOW_PARAMS = { today: "today", last7days: "week", last30days: "month", alltime: "all" };
const WINDOW_TO_PARAM = Object.fromEntries(
  Object.entries(WINDOW_PARAMS).map(([k, v]) => [v, k])
);

const state = {
  apiKey: localStorage.getItem(STORAGE_KEY) || null,
  twUser: null,
  ytUser: null,
  window: "today",
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

async function api(path) {
  const res = await fetch(path, { headers: { "X-API-Key": state.apiKey } });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem(STORAGE_KEY);
    state.apiKey = null;
    showGate("Invalid API key.");
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showGate(errMsg = "") {
  $("gate").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("gate-err").textContent = errMsg;
  $("gate-input").value = "";
  $("gate-input").focus();
}

function hideGate() {
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
}

$("gate-submit").addEventListener("click", async () => {
  const key = $("gate-input").value.trim();
  if (!key) return;
  state.apiKey = key;
  try {
    await api("/stats/users");
    localStorage.setItem(STORAGE_KEY, key);
    hideGate();
    boot();
  } catch (e) {}
});

$("gate-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("gate-submit").click();
});

// ---------- Account pickers ----------

async function loadPickers() {
  const [{ users: twUsers }, { users: ytUsers }] = await Promise.all([
    api("/stats/users"),
    api("/stats/youtube/users"),
  ]);

  const twSelect = $("twitch-picker");
  twSelect.innerHTML = "";
  const twAll = document.createElement("option");
  twAll.value = "";
  twAll.textContent = "All Twitch accounts";
  twSelect.appendChild(twAll);
  for (const u of twUsers) {
    const opt = document.createElement("option");
    opt.value = u.user;
    opt.textContent = `Twitch: ${u.user}`;
    twSelect.appendChild(opt);
  }
  const savedTw = localStorage.getItem(TW_ACCOUNT_KEY);
  if (savedTw && twUsers.find(u => u.user === savedTw)) {
    twSelect.value = savedTw;
    state.twUser = savedTw;
  }

  const ytSelect = $("youtube-picker");
  ytSelect.innerHTML = "";
  const ytAll = document.createElement("option");
  ytAll.value = "";
  ytAll.textContent = "All YouTube accounts";
  ytSelect.appendChild(ytAll);
  for (const u of ytUsers) {
    const opt = document.createElement("option");
    opt.value = u.user;
    opt.textContent = `YouTube: ${u.user}`;
    ytSelect.appendChild(opt);
  }
  const savedYt = localStorage.getItem(YT_ACCOUNT_KEY);
  if (savedYt && ytUsers.find(u => u.user === savedYt)) {
    ytSelect.value = savedYt;
    state.ytUser = savedYt;
  }
}

$("twitch-picker").addEventListener("change", (e) => {
  state.twUser = e.target.value || null;
  localStorage.setItem(TW_ACCOUNT_KEY, state.twUser ?? "");
  refresh();
});

$("youtube-picker").addEventListener("change", (e) => {
  state.ytUser = e.target.value || null;
  localStorage.setItem(YT_ACCOUNT_KEY, state.ytUser ?? "");
  refresh();
});

// ---------- Window ----------

function applyWindowFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, win] of Object.entries(WINDOW_PARAMS)) {
    if (params.has(key)) {
      state.window = win;
      document.querySelectorAll(".pill").forEach(p =>
        p.classList.toggle("active", p.dataset.window === win));
      break;
    }
  }
}

function setWindowUrl(win) {
  const key = WINDOW_TO_PARAM[win];
  if (!key) return;
  history.replaceState(null, "", `?${key}`);
}

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    state.window = pill.dataset.window;
    setWindowUrl(state.window);
    updateMerged();
  });
});

// ---------- Formatters ----------

function fmtDuration(seconds) {
  if (!seconds) return "0 seconds";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (h > 0) return m === 0 ? plural(h, "hour") : `${plural(h, "hour")} ${plural(m, "minute")}`;
  if (m > 0) return s === 0 ? plural(m, "minute") : `${plural(m, "minute")} ${plural(s, "second")}`;
  return plural(s, "second");
}

const AVATAR_COLORS = ["#9146FF", "#FF4444", "#00f5d4", "#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#f368e0"];
function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ---------- Merge ----------

function buildMergedRows(twChannels, ytChannels, links) {
  const linkMap = {};
  for (const l of links) {
    if (!linkMap[l.twitch_channel]) linkMap[l.twitch_channel] = [];
    linkMap[l.twitch_channel].push(l.youtube_channel);
  }

  const usedYt = new Set();
  const rows = [];

  for (const t of twChannels) {
    const linked = linkMap[t.channel] || [];
    let ytSeconds = 0;
    const ytNames = [];
    for (const ytCh of linked) {
      const ytRow = ytChannels.find(y => y.channel === ytCh);
      if (ytRow) {
        ytSeconds += ytRow.seconds;
        ytNames.push(ytCh);
        usedYt.add(ytCh);
      }
    }
    rows.push({
      label: ytNames.length ? `${t.channel} / ${ytNames.join(", ")}` : t.channel,
      seconds: t.seconds + ytSeconds,
      platforms: ytNames.length ? ["twitch", "youtube"] : ["twitch"],
      avatar: t.channel,
    });
  }

  for (const y of ytChannels) {
    if (!usedYt.has(y.channel)) {
      rows.push({
        label: y.channel,
        seconds: y.seconds,
        platforms: ["youtube"],
        avatar: y.channel,
      });
    }
  }

  rows.sort((a, b) => b.seconds - a.seconds);
  return rows;
}

async function updateMerged() {
  const twParam = state.twUser ? `?user=${encodeURIComponent(state.twUser)}` : "";
  const ytParam = state.ytUser ? `?user=${encodeURIComponent(state.ytUser)}` : "";

  const [twData, ytData, linksData] = await Promise.all([
    api(`/stats/${state.window}${twParam}`),
    api(`/stats/youtube/${state.window}${ytParam}`),
    api("/settings/channel-links"),
  ]);

  const rows = buildMergedRows(twData.channels, ytData.channels, linksData.links);
  const max = rows[0]?.seconds || 1;
  const root = $("merged-channels");
  root.innerHTML = "";

  rows.forEach((row, i) => {
    const badges = row.platforms.map(p =>
      `<span class="platform-badge ${p}">${p === "twitch" ? "TW" : "YT"}</span>`
    ).join(" ");
    const el = document.createElement("div");
    el.className = "ranked-row";
    el.innerHTML = `
      <div class="rank mono">#${i + 1}</div>
      <div class="avatar" style="background:${avatarColor(row.avatar)}">${row.avatar[0].toUpperCase()}</div>
      <div class="name">${row.label} ${badges}</div>
      <div class="value mono">${fmtDuration(row.seconds)}</div>
      <div class="bar"><span style="width:${(row.seconds / max * 100).toFixed(1)}%"></span></div>
    `;
    root.appendChild(el);
  });

  if (rows.length === 0) {
    root.innerHTML = '<div style="color:var(--muted)">No data yet.</div>';
  }
}

// ---------- Refresh ----------

async function refresh() {
  try {
    await updateMerged();
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

// ---------- Boot ----------

async function boot() {
  await loadPickers();
  applyWindowFromUrl();
  await refresh();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, POLL_MS);
}

if (state.apiKey) {
  hideGate();
  boot();
} else {
  showGate();
}
```

- [ ] **Step 3: Run tests**

```
cd api && pytest -v
```
Expected: all PASSED.

- [ ] **Step 4: Commit**

```bash
git add api/static/index.html api/static/app.js
git commit -m "feat: merged Twitch+YouTube dashboard at /"
```

---

## Task 11: YouTube extension content script

**Files:**
- Create: `extension/youtube-content.js`

- [ ] **Step 1: Create extension/youtube-content.js**

Write `extension/youtube-content.js`:

```javascript
// Runs on youtube.com pages.
// Detects channel, video state, playlist, and logged-in user.

const HEARTBEAT_MS = 60 * 1000;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

let lastActivity = Date.now();

["mousemove", "keydown", "click", "wheel", "touchstart"].forEach((evt) => {
  window.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true });
});

function getVideoId() {
  return new URLSearchParams(location.search).get("v");
}

function getPlaylistId() {
  return new URLSearchParams(location.search).get("list") || null;
}

function getChannelFromDom() {
  const selectors = [
    "ytd-channel-name yt-formatted-string a",
    "#channel-name yt-formatted-string a",
    "#owner #channel-name a",
    "ytd-video-owner-renderer #channel-name a",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim().toLowerCase();
  }
  // Fallback: /@handle in URL on channel pages
  const match = location.pathname.match(/^\/@([^/]+)/);
  if (match) return match[1].toLowerCase();
  return null;
}

function getVideoTitle() {
  const el = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
          || document.querySelector("#title h1 yt-formatted-string");
  return el ? el.textContent.trim().slice(0, 512) : null;
}

function getVideoState() {
  const video = document.querySelector("video");
  if (!video || video.readyState < 1) return { present: false };
  return { present: true, paused: video.paused };
}

function detectYoutubeUser() {
  try {
    if (typeof ytcfg !== "undefined") {
      const name = ytcfg.data_?.LOGGED_IN_ACCOUNT_NAME;
      if (name) return name.toLowerCase();
    }
  } catch {}
  try {
    const el = document.querySelector("yt-user-info #account-name");
    if (el?.textContent?.trim()) return el.textContent.trim().toLowerCase();
  } catch {}
  try {
    const label = document.querySelector("#avatar-btn")?.getAttribute("aria-label") || "";
    const m = label.match(/Google Account:\s*([^(]+)/);
    if (m) return m[1].trim().toLowerCase();
  } catch {}
  return null;
}

let ytUserFallback = null;
chrome.storage.local.get("youtubeUser", ({ youtubeUser: u }) => { ytUserFallback = u || null; });

let tickInterval = null;
let firstTick = null;

function stopTicking() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (firstTick) { clearTimeout(firstTick); firstTick = null; }
}

function tick() {
  if (!chrome.runtime?.id) { stopTicking(); return; }

  const videoId = getVideoId();
  if (!videoId) return;

  const video = getVideoState();
  if (!video.present || video.paused) return;

  const channel = getChannelFromDom();
  if (!channel) return;

  const tabVisible = document.visibilityState === "visible";
  const idle = Date.now() - lastActivity > IDLE_THRESHOLD_MS;

  const heartbeat = {
    ts: Math.floor(Date.now() / 1000),
    channel,
    title: getVideoTitle(),
    video_id: videoId,
    playlist_id: getPlaylistId(),
    state: idle ? "passive" : "active",
    tab_visible: tabVisible,
    youtube_user: detectYoutubeUser() || ytUserFallback,
    platform: "youtube",
  };

  try {
    chrome.runtime.sendMessage({ type: "heartbeat", payload: heartbeat });
  } catch (e) {
    stopTicking();
  }
}

tickInterval = setInterval(tick, HEARTBEAT_MS);
firstTick = setTimeout(tick, 5000);
```

- [ ] **Step 2: Commit**

```bash
git add extension/youtube-content.js
git commit -m "feat: youtube-content.js — YouTube watch detection for merged extension"
```

---

## Task 12: Update extension manifest and background.js

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`

- [ ] **Step 1: Read extension/manifest.json to understand current structure**

Open `extension/manifest.json` and note: current `content_scripts` entries, current `host_permissions`, and current `version`.

- [ ] **Step 2: Replace extension/manifest.json**

Write `extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Watchtime Logger",
  "version": "0.3.0",
  "description": "Logs Twitch and YouTube watch time to your own backend.",
  "permissions": ["storage", "alarms"],
  "host_permissions": [
    "https://www.twitch.tv/*",
    "https://player.twitch.tv/*",
    "https://www.youtube.com/*",
    "https://m.youtube.com/*",
    "https://youtube.com/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://www.twitch.tv/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://player.twitch.tv/*"],
      "js": ["player.js"],
      "run_at": "document_idle"
    },
    {
      "matches": [
        "https://www.youtube.com/*",
        "https://m.youtube.com/*",
        "https://youtube.com/*"
      ],
      "js": ["youtube-content.js"],
      "run_at": "document_idle"
    }
  ],
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
  "action": {
    "default_title": "Watchtime Logger"
  }
}
```

- [ ] **Step 3: Update extension/background.js**

The current `background.js` has a single `QUEUE_KEY = "hb_queue"` and a single `flush()` function that sends to `/heartbeats`. Replace the `flush` function, add an `enqueueYoutube` function, and update the message listener.

Find and replace everything from `async function flush()` through the end of `chrome.runtime.onMessage.addListener(...)` with:

```javascript
async function flushQueue(queueKey, endpoint) {
  const { apiUrl, apiKey } = await getSettings();
  if (!apiUrl || !apiKey) return;

  const { [queueKey]: queue = [] } = await chrome.storage.local.get(queueKey);
  if (queue.length === 0) return;

  const batch = queue.slice(0, 500);

  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ heartbeats: batch }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { [queueKey]: latest = [] } = await chrome.storage.local.get(queueKey);
    await chrome.storage.local.set({ [queueKey]: latest.slice(batch.length) });
  } catch (err) {
    console.warn(`[watchtime] flush failed for ${endpoint}:`, err.message);
  }
}

async function flush() {
  await flushQueue(QUEUE_KEY, "/heartbeats");
  await flushQueue("yt_queue", "/youtube/heartbeats");
}

async function enqueueYoutube(hb) {
  const clientId = await ensureClientId();
  hb.client_id = clientId;
  const { yt_queue: queue = [] } = await chrome.storage.local.get("yt_queue");
  queue.push(hb);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  await chrome.storage.local.set({ yt_queue: queue });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "heartbeat") {
    const { platform, ...hb } = msg.payload;
    if (platform === "youtube") {
      enqueueYoutube(hb).then(() => sendResponse({ ok: true }));
    } else {
      enqueue(hb).then(() => sendResponse({ ok: true }));
    }
    return true;
  }
});
```

- [ ] **Step 4: Run full test suite one last time**

```
cd api && pytest -v
```
Expected: all PASSED.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/background.js
git commit -m "feat: merge extension v0.3.0 — YouTube tracking + routing in background.js"
```

---

## Self-Review

**Spec coverage:**
- ✅ youtube_heartbeats + channel_links tables → Task 1
- ✅ POST /youtube/heartbeats → Task 3
- ✅ /stats/youtube/users, today, week, month, all, playlists → Task 4
- ✅ /settings/channel-links GET/POST/DELETE → Task 5
- ✅ /twitch /youtube /settings routes → Task 6
- ✅ /twitch full Twitch dashboard → Task 7
- ✅ /youtube dashboard with channels + playlists → Task 8
- ✅ /settings channel link form → Task 9
- ✅ / merged view, two pickers, platform badges, linked rows → Task 10
- ✅ youtube-content.js detects channel/video_id/playlist_id/youtube_user → Task 11
- ✅ manifest.json adds youtube.com host permissions + content script → Task 12
- ✅ background.js routes platform=youtube to /youtube/heartbeats → Task 12

**Type consistency:**
- `_yt_stats_since` used by `yt_stats_today/week/month/all` ✅
- `_yt_user_clause` used by `_yt_stats_since` and `yt_stats_playlists` ✅
- `YoutubeHeartbeat.state` pattern `"^(active|passive)$"` matches DB CHECK ✅
- `insert_youtube_heartbeat` parameter order matches DB column order ✅
- `buildMergedRows(twChannels, ytChannels, links)` — `links` is `linksData.links` (array of `{twitch_channel, youtube_channel}`) ✅
- `platform: "youtube"` in youtube-content.js → `platform === "youtube"` in background.js ✅
- `{ platform, ...hb }` destructuring strips platform before queuing ✅

**No placeholders.**
