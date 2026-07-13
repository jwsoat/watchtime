"""
Home Assistant media_player poller.

Polls a Home Assistant instance's `/api/states` on the heartbeat cadence and
records YouTube playback surfaced by any `media_player.*` entity whose
`attributes.app_name` is `"youtube"`. Channel comes from `media_artist`, title
from `media_title`, so a TV/Chromecast/Google Cast/Android TV/etc. session
gets credited to the same YouTube channel dashboard as browser-tracked
playback.

Configured via the `home_assistant_config` row in the API DB (UI at
/settings). When no config is stored, the loop sleeps without polling.
"""
import json
import sqlite3
import threading
import time
import urllib.request

# Home Assistant player states that count as actively watching.
_ACTIVE_STATES = {"playing", "buffering"}

# app_name values (compared lowercased) that we recognise as YouTube playback.
_YOUTUBE_APP_NAMES = {"youtube", "youtube tv", "youtube music"}


def _read_config(db_path: str):
    """Return (base_url, token) from home_assistant_config, or (None, None)."""
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT base_url, token FROM home_assistant_config WHERE id = 1"
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.OperationalError:
        return None, None
    if not row:
        return None, None
    return row[0], row[1]


def _read_entity_users(db_path: str):
    """Return {entity_id: youtube_user} for every configured mapping."""
    try:
        conn = sqlite3.connect(db_path)
        try:
            rows = conn.execute(
                "SELECT entity_id, youtube_user FROM home_assistant_entity_users"
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.OperationalError:
        return {}
    return {entity_id: user for entity_id, user in rows}


def _fetch_states(base_url: str, token: str):
    url = f"{base_url.rstrip('/')}/api/states"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "twitch-watchtime/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _rows_from_states(states, now: int, entity_users=None):
    """Build youtube_heartbeats rows from a /api/states payload.

    Only entities whose id starts with `media_player.` and whose current
    `app_name` attribute names a YouTube app are considered. Channel takes
    `media_artist` (falling back to `media_channel`, which HA populates for
    Cast YouTube on some integrations) and title takes `media_title`. Rows
    without a channel or title are dropped rather than fabricated.

    `entity_users` maps entity_id → youtube_user so playback on a specific
    device is attributed to a specific person on the merged/YouTube dashboard.
    Entities not in the mapping are recorded with youtube_user = NULL."""
    if not isinstance(states, list):
        return []
    entity_users = entity_users or {}
    rows = []
    for entity in states:
        if not isinstance(entity, dict):
            continue
        entity_id = entity.get("entity_id") or ""
        if not entity_id.startswith("media_player."):
            continue
        attrs = entity.get("attributes") or {}
        app_name = (attrs.get("app_name") or "").strip().lower()
        if app_name not in _YOUTUBE_APP_NAMES:
            continue
        channel = attrs.get("media_artist") or attrs.get("media_channel")
        title = attrs.get("media_title")
        if not channel or not title:
            continue
        player_state = (entity.get("state") or "").lower()
        state = "active" if player_state in _ACTIVE_STATES else "passive"
        # Some HA integrations expose the 11-char YouTube video id here;
        # others put a full URL. Keep only the plain id (matches the browser
        # extension's format so per-video merging works).
        raw_content_id = attrs.get("media_content_id")
        video_id = raw_content_id if (
            isinstance(raw_content_id, str)
            and len(raw_content_id) == 11
            and "/" not in raw_content_id
        ) else None
        youtube_user = entity_users.get(entity_id)
        rows.append((
            now, channel.strip().lower(), title,
            video_id, None, state, 1, youtube_user,
            f"ha:{entity_id}",
        ))
    return rows


def _insert(db_path: str, rows):
    if not rows:
        return
    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            "INSERT INTO youtube_heartbeats "
            "(ts, channel, title, video_id, playlist_id, state, tab_visible, "
            "youtube_user, client_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


def _loop(db_path: str, interval: int):
    while True:
        base_url, token = _read_config(db_path)
        if base_url and token:
            try:
                payload = _fetch_states(base_url, token)
                entity_users = _read_entity_users(db_path)
                rows = _rows_from_states(payload, int(time.time()), entity_users)
                _insert(db_path, rows)
            except Exception as err:  # noqa: BLE001 — keep the poller alive
                print(f"[watchtime] home assistant poll failed: {err}")
        time.sleep(interval)


def start(db_path: str, interval: int):
    """Spawn the Home Assistant poller daemon thread. Always starts; the loop
    itself no-ops when config is missing, so saving config via the UI takes
    effect on the next tick without a restart."""
    thread = threading.Thread(
        target=_loop, args=(db_path, interval),
        name="home-assistant-poller", daemon=True,
    )
    thread.start()
    return True
