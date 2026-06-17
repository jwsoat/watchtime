"""
Plex watch-time poller.

Unlike Twitch/YouTube/X/Facebook/Instagram (tracked by the browser extension),
Plex is tracked server-side: we poll a Plex Media Server's session list on the
same cadence as the heartbeat interval and write one `media_heartbeats` row per
actively-playing video session. This captures playback on every device (TV,
phone, native apps), not just the browser.

Configured via the `plex_config` row in the API DB (UI at /settings). When no
config is stored, the loop sleeps without polling, so unconfigured deployments
incur no traffic.
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


def _read_config(db_path: str):
    """Return (base_url, token, channel_from_studio) from plex_config, or
    (None, None, False) when missing/unset."""
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT base_url, token, channel_from_studio FROM plex_config WHERE id = 1"
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.OperationalError:
        return None, None, False
    if not row:
        return None, None, False
    return row[0], row[1], bool(row[2])


_PLEX_HEADERS_BASE = {
    "X-Plex-Client-Identifier": "twitch-watchtime",
    "X-Plex-Product": "twitch-watchtime",
    "X-Plex-Version": "1.0",
    "X-Plex-Device-Name": "twitch-watchtime",
    "X-Plex-Platform": "Python",
    "Accept": "application/json",
    "User-Agent": "twitch-watchtime/1.0",
}


def _fetch_sessions(base_url: str, token: str):
    url = f"{base_url.rstrip('/')}/status/sessions"
    headers = {**_PLEX_HEADERS_BASE, "X-Plex-Token": token}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


# Cache show-level studio lookups so we don't refetch metadata on every poll.
_STUDIO_CACHE = {}


def _fetch_studio(base_url: str, token: str, rating_key: str):
    """Return the `studio` field for a /library/metadata/<rating_key> item.
    Cache hits only when a studio is actually found — so a user who later
    fills in the studio in Plex picks up on the next poll without a restart."""
    cached = _STUDIO_CACHE.get(rating_key)
    if cached:
        return cached
    url = f"{base_url.rstrip('/')}/library/metadata/{rating_key}"
    headers = {**_PLEX_HEADERS_BASE, "X-Plex-Token": token}
    studio = None
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        metas = (data.get("MediaContainer") or {}).get("Metadata") or []
        if metas:
            studio = metas[0].get("studio") or None
    except Exception:
        pass
    if studio:
        _STUDIO_CACHE[rating_key] = studio
    return studio


def _rows_from_sessions(payload: dict, now: int, channel_from_studio: bool = False,
                        base_url: str = None, token: str = None, remaps: dict = None):
    """Build heartbeat rows from a /status/sessions payload.

    When channel_from_studio is True and the studio is later discovered for a
    show whose earlier episodes had been recorded under `grandparentTitle`
    (because Plex hadn't populated `studio` yet), add an entry to `remaps`
    (a dict {old_channel_lower: new_channel_lower}) so the caller can
    retroactively reattribute historical rows."""
    container = payload.get("MediaContainer", {}) if isinstance(payload, dict) else {}
    metadata = container.get("Metadata", []) or []
    rows = []
    for item in metadata:
        if item.get("type") not in _VIDEO_TYPES:
            continue
        player_state = (item.get("Player") or {}).get("state", "")
        channel = None
        used_studio = False
        if channel_from_studio:
            channel = item.get("studio")
            if channel:
                used_studio = True
            elif item.get("grandparentRatingKey") and base_url and token:
                channel = _fetch_studio(base_url, token, str(item["grandparentRatingKey"]))
                if channel:
                    used_studio = True
        if used_studio and remaps is not None:
            grand = item.get("grandparentTitle")
            if grand:
                grand_lc = grand.lower()
                studio_lc = channel.lower()
                if grand_lc != studio_lc:
                    remaps[grand_lc] = studio_lc
        channel = channel or item.get("grandparentTitle") or item.get("title")
        if not channel:
            continue
        title = item.get("title") or ""
        # Episodes: append " — Show SxxEyy" so the title carries enough context
        # to identify the playback even when the channel is the studio name.
        if item.get("type") == "episode":
            show = item.get("grandparentTitle")
            season = item.get("parentIndex")
            episode = item.get("index")
            suffix = []
            if show:
                suffix.append(show)
            if season is not None and episode is not None:
                suffix.append(f"S{int(season):02d}E{int(episode):02d}")
            if suffix:
                title = f"{title} — {' '.join(suffix)}" if title else " ".join(suffix)
        video_id = str(item.get("ratingKey")) if item.get("ratingKey") is not None else None
        user = (item.get("User") or {}).get("title")
        state = "active" if player_state in _ACTIVE_STATES else "passive"
        rows.append((
            now, "plex", channel.lower(), title, video_id,
            state, 1, user.lower() if user else None, None, "plex-poller",
        ))
    return rows


def _insert(db_path: str, rows):
    if not rows:
        return
    conn = sqlite3.connect(db_path)
    try:
        conn.executemany(
            "INSERT INTO media_heartbeats "
            "(ts, platform, channel, title, video_id, state, tab_visible, "
            "media_user, display_name, client_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()


# Reassignments we've already applied this process lifetime — avoids running
# the same UPDATE on every poll once the rename has converged.
_APPLIED_REMAPS = set()


def _apply_remaps(db_path: str, remaps: dict):
    """Idempotently rename historical Plex rows from grandparentTitle to the
    show's studio once that studio becomes known."""
    if not remaps:
        return
    fresh = {old: new for old, new in remaps.items() if (old, new) not in _APPLIED_REMAPS}
    if not fresh:
        return
    conn = sqlite3.connect(db_path)
    try:
        for old, new in fresh.items():
            conn.execute(
                "UPDATE media_heartbeats SET channel = ? "
                "WHERE platform = 'plex' AND channel = ?",
                (new, old),
            )
            _APPLIED_REMAPS.add((old, new))
        conn.commit()
    finally:
        conn.close()


def _loop(db_path: str, interval: int):
    while True:
        base_url, token, from_studio = _read_config(db_path)
        if base_url and token:
            try:
                payload = _fetch_sessions(base_url, token)
                remaps = {}
                rows = _rows_from_sessions(
                    payload, int(time.time()), from_studio,
                    base_url=base_url, token=token, remaps=remaps,
                )
                _insert(db_path, rows)
                _apply_remaps(db_path, remaps)
            except Exception as err:  # noqa: BLE001 — keep the poller alive
                print(f"[watchtime] plex poll failed: {err}")
        time.sleep(interval)


def start(db_path: str, interval: int):
    """Spawn the Plex poller daemon thread. Always starts; the loop itself
    no-ops when config is missing, so saving config via the UI takes effect
    on the next tick without a restart."""
    thread = threading.Thread(
        target=_loop, args=(db_path, interval), name="plex-poller", daemon=True
    )
    thread.start()
    return True
