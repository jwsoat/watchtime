"""
Plex watch-time poller.

Unlike Twitch/YouTube/X/Facebook/Instagram (tracked by the browser extension),
Plex is tracked server-side: we poll a Plex Media Server's session list on the
same cadence as the heartbeat interval and write one `media_heartbeats` row per
actively-playing video session. This captures playback on every device (TV,
phone, native apps), not just the browser.

Enabled by setting PLEX_BASE_URL and PLEX_TOKEN. When unset, the poller is a
no-op so tests and Plex-less deployments are unaffected.
"""
import json
import os
import sqlite3
import threading
import time
import urllib.request

# Plex item types we count as "video". Music ("track") is intentionally skipped.
_VIDEO_TYPES = {"episode", "movie", "clip", "trailer"}

# Plex player states that count as actively watching.
_ACTIVE_STATES = {"playing", "buffering"}


def is_configured() -> bool:
    return bool(os.environ.get("PLEX_BASE_URL") and os.environ.get("PLEX_TOKEN"))


def _fetch_sessions(base_url: str, token: str):
    url = f"{base_url.rstrip('/')}/status/sessions"
    req = urllib.request.Request(
        url,
        headers={"X-Plex-Token": token, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _rows_from_sessions(payload: dict, now: int):
    """Turn a Plex /status/sessions JSON payload into media_heartbeats rows."""
    container = payload.get("MediaContainer", {}) if isinstance(payload, dict) else {}
    metadata = container.get("Metadata", []) or []
    rows = []
    for item in metadata:
        if item.get("type") not in _VIDEO_TYPES:
            continue
        player_state = (item.get("Player") or {}).get("state", "")
        # The show/series for episodes, otherwise the title itself (movies).
        channel = item.get("grandparentTitle") or item.get("title")
        if not channel:
            continue
        title = item.get("title")
        video_id = str(item.get("ratingKey")) if item.get("ratingKey") is not None else None
        user = (item.get("User") or {}).get("title")
        state = "active" if player_state in _ACTIVE_STATES else "passive"
        rows.append((
            now, "plex", channel.lower(), title, video_id,
            state, 1, user.lower() if user else None, "plex-poller",
        ))
    return rows


def _insert(db_path: str, rows):
    if not rows:
        return
    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            "INSERT INTO media_heartbeats "
            "(ts, platform, channel, title, video_id, state, tab_visible, media_user, client_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


def _loop(db_path: str, interval: int):
    base_url = os.environ["PLEX_BASE_URL"]
    token = os.environ["PLEX_TOKEN"]
    while True:
        try:
            payload = _fetch_sessions(base_url, token)
            _insert(db_path, _rows_from_sessions(payload, int(time.time())))
        except Exception as err:  # noqa: BLE001 — keep the poller alive
            print(f"[watchtime] plex poll failed: {err}")
        time.sleep(interval)


def start(db_path: str, interval: int):
    """Start the Plex poller in a daemon thread. No-op when not configured."""
    if not is_configured():
        return False
    thread = threading.Thread(
        target=_loop, args=(db_path, interval), name="plex-poller", daemon=True
    )
    thread.start()
    return True
