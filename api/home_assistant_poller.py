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
import urllib.parse
import urllib.request

# Home Assistant player states that count as actively watching.
_ACTIVE_STATES = {"playing", "buffering"}

# app_name values (compared lowercased) that we recognise as YouTube playback.
_YOUTUBE_APP_NAMES = {"youtube", "youtube tv", "youtube music"}

# How long a FAILED handle resolution is remembered before we retry the
# YouTube API for that display name. Successful resolutions are cached
# forever; only misses burn search quota (100 units/call).
_HANDLE_RETRY_S = 24 * 3600


def _read_api_key(db_path: str):
    """Return the YouTube Data API key from home_assistant_config, or None."""
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT api_key FROM home_assistant_config WHERE id = 1"
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.OperationalError:
        return None
    if not row or not row[0]:
        return None
    return row[0]


def _load_handle_cache(db_path: str):
    """Return {display_name: handle_or_None} from the resolution cache."""
    try:
        conn = sqlite3.connect(db_path)
        try:
            rows = conn.execute(
                "SELECT display_name, handle FROM youtube_channel_handles"
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.OperationalError:
        return {}
    return {name: handle for name, handle in rows}


def _save_handle_cache(db_path: str, display_name: str, handle):
    """Upsert one resolution result (handle may be None = lookup failed)."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO youtube_channel_handles (display_name, handle, resolved_at) "
            "VALUES (?, ?, ?) ON CONFLICT(display_name) DO UPDATE SET "
            "handle = excluded.handle, resolved_at = excluded.resolved_at",
            (display_name, handle, int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()


def _api_get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "twitch-watchtime/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _resolve_handle(api_key: str, display_name: str):
    """Resolve a channel display name to its YouTube @handle.

    One search.list call (100 quota units) to find the channel, then one
    channels.list call (1 unit) for its customUrl. Only an exact
    case-insensitive channelTitle match is accepted — closest-guess
    attributions would silently mis-file watch time. Returns the handle
    without the leading '@' (matching the browser extension's format), or
    None when nothing matches exactly or the API errors."""
    try:
        q = urllib.parse.quote(display_name)
        search = _api_get_json(
            "https://www.googleapis.com/youtube/v3/search"
            f"?part=snippet&type=channel&maxResults=5&q={q}&key={api_key}"
        )
        target = display_name.casefold().strip()
        channel_id = None
        for item in search.get("items", []):
            title = ((item.get("snippet") or {}).get("channelTitle") or "").casefold().strip()
            if title == target:
                channel_id = (item.get("snippet") or {}).get("channelId")
                break
        if not channel_id:
            return None
        chan = _api_get_json(
            "https://www.googleapis.com/youtube/v3/channels"
            f"?part=snippet&id={channel_id}&key={api_key}"
        )
        items = chan.get("items") or []
        custom = ((items[0].get("snippet") or {}).get("customUrl") or "") if items else ""
        if custom.startswith("@"):
            custom = custom[1:]
        return custom.lower() or None
    except Exception:  # noqa: BLE001 — resolver must never break the poll loop
        return None


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


def _rows_from_states(states, now: int, entity_users=None, resolver=None):
    """Build youtube_heartbeats rows from a /api/states payload.

    Only entities whose id starts with `media_player.` and whose current
    `app_name` attribute names a YouTube app are considered. Channel takes
    `media_artist` (falling back to `media_channel`, which HA populates for
    Cast YouTube on some integrations) and title takes `media_title`. Rows
    without a channel or title are dropped rather than fabricated.

    `entity_users` maps entity_id → youtube_user so playback on a specific
    device is attributed to a specific person on the merged/YouTube dashboard.
    Entities not in the mapping are recorded with youtube_user = NULL.

    `resolver` maps a channel display name (e.g. "Mark Tilbury") to the
    YouTube @handle the browser extension records (e.g. "marktilbury") so
    HA-sourced and browser-sourced playback land on the same channel. When
    absent or None-returning, the lowercased display name is used."""
    if not isinstance(states, list):
        return []
    entity_users = entity_users or {}
    resolved = {}
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
        channel = channel.strip().lower()
        if resolver is not None:
            if channel not in resolved:
                resolved[channel] = resolver(channel) or channel
            channel = resolved[channel]
        rows.append((
            now, channel, title,
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


def _make_resolver(db_path: str, api_key):
    """Build a display-name → handle resolver backed by the persistent cache.

    Successful resolutions are cached forever; misses (handle None) are
    retried at most once per _HANDLE_RETRY_S so unresolvable names don't
    burn search quota every poll. Without an API key the resolver still
    serves cached handles."""
    now = time.time()
    cache = _load_handle_cache(db_path)

    def resolve(display_name):
        cached = cache.get(display_name)
        if cached:
            return cached
        at = _retry_time(db_path, display_name)
        if at and now - at < _HANDLE_RETRY_S:
            return cached  # recent miss — don't re-burn search quota
        handle = _resolve_handle(api_key, display_name) if api_key else None
        _save_handle_cache(db_path, display_name, handle)
        cache[display_name] = handle
        return handle

    return resolve


def _retry_time(db_path: str, display_name: str):
    """resolved_at timestamp for a cache entry (0 when missing)."""
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT resolved_at FROM youtube_channel_handles "
                "WHERE display_name = ?",
                (display_name,),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.OperationalError:
        return 0
    return row[0] if row else 0


def _loop(db_path: str, interval: int):
    while True:
        base_url, token = _read_config(db_path)
        if base_url and token:
            try:
                payload = _fetch_states(base_url, token)
                entity_users = _read_entity_users(db_path)
                api_key = _read_api_key(db_path)
                resolver = _make_resolver(db_path, api_key) if api_key else None
                rows = _rows_from_states(
                    payload, int(time.time()), entity_users, resolver
                )
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
