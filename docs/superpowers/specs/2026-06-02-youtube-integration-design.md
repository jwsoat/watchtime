# YouTube Integration Design

**Date:** 2026-06-02  
**Branch:** add-youtube  
**Status:** Approved

## Overview

Add YouTube watch time tracking to the existing Twitch tracker. Single merged extension covers both platforms. Single backend API with separate tables per platform. Three frontend routes: `/twitch` (Twitch-only), `/youtube` (YouTube-only), `/` (merged view). Settings page links Twitch channels to YouTube channels for merged display.

---

## 1. Extension

One merged Chrome extension replacing the current Twitch-only extension.

**Files changed:**

- `extension/manifest.json` — add `youtube.com` host permissions; add `youtube-content.js` content script targeting `https://www.youtube.com/*`, `https://m.youtube.com/*`, `https://youtube.com/*`
- `extension/youtube-content.js` (new) — YouTube detection content script (see below)
- `extension/background.js` — add routing: if `payload.platform === 'youtube'` flush to `/youtube/heartbeats`, else `/heartbeats`
- `extension/options.js` / `options.html` — no change; one API URL + API key covers both platforms

**`youtube-content.js` detection logic:**

- Channel: extract from DOM — `ytd-channel-name a`, `#channel-name a`, or `yt-formatted-string#channel-name`; fall back to `/@handle` from current URL if on a channel page
- Video playing: `document.querySelector('video').paused === false`
- Playlist ID: `new URLSearchParams(location.search).get('list')` — null if not in a playlist
- Video ID: `new URLSearchParams(location.search).get('v')`
- Video title: `document.querySelector('h1.ytd-watch-metadata yt-formatted-string')` or `document.title`
- YouTube user: `ytcfg.data_?.DELEGATED_SESSION_ID` or `document.querySelector('yt-user-info')?.textContent`
- Activity detection: same mouse/keyboard idle logic as Twitch content.js (5-min threshold)
- Heartbeat interval: 60s (matches Twitch)
- Heartbeat payload fields: `ts`, `channel`, `title`, `video_id`, `playlist_id`, `state` (`active`|`passive`), `tab_visible`, `youtube_user`, `platform: 'youtube'`

---

## 2. Backend — Database

Two new tables added via `migrate_db()` (idempotent, additive — no changes to existing `heartbeats` table).

```sql
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
CREATE INDEX IF NOT EXISTS idx_yt_ts ON youtube_heartbeats(ts);
CREATE INDEX IF NOT EXISTS idx_yt_channel_ts ON youtube_heartbeats(channel, ts);

CREATE TABLE IF NOT EXISTS channel_links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_channel  TEXT NOT NULL,
    youtube_channel TEXT NOT NULL,
    UNIQUE(twitch_channel, youtube_channel)
);
```

---

## 3. Backend — API Endpoints

All endpoints require `X-API-Key` header. Existing Twitch endpoints unchanged.

### YouTube ingest

| Method | Path | Notes |
|--------|------|-------|
| POST | `/youtube/heartbeats` | Batch ingest; same shape as `/heartbeats` minus Twitch-specific fields |

### YouTube stats

All support `?user=<youtube_user>` filter and `?include_passive=false`.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/stats/youtube/users` | List distinct `youtube_user` values seen |
| GET | `/stats/youtube/today` | Per-channel seconds since local midnight |
| GET | `/stats/youtube/week` | Per-channel seconds, last 7 days |
| GET | `/stats/youtube/month` | Per-channel seconds, last 30 days |
| GET | `/stats/youtube/all` | Per-channel seconds, all time |
| GET | `/stats/youtube/playlists` | Per-playlist seconds; supports `?window=today\|week\|month\|all` and `?user=` |

### Settings

| Method | Path | Body / Notes |
|--------|------|-------|
| GET | `/settings/channel-links` | Returns `[{id, twitch_channel, youtube_channel}]` |
| POST | `/settings/channel-links` | `{twitch_channel, youtube_channel}` — inserts or ignores duplicate |
| DELETE | `/settings/channel-links/{id}` | Removes link by ID |

---

## 4. Frontend — Routes and Pages

Backend serves four HTML pages from `api/static/`:

| Route | Files | Purpose |
|-------|-------|---------|
| `/` | `index.html`, `app.js` | Merged Twitch + YouTube view |
| `/twitch` | `twitch.html`, `twitch.js` | Twitch-only dashboard (current `index.html`/`app.js` moved here) |
| `/youtube` | `youtube.html`, `youtube.js` | YouTube-only dashboard |
| `/settings` | `settings.html`, `settings.js` | Channel link management |

`main.py` adds routes:

```python
@app.get("/twitch", include_in_schema=False)
def twitch_page(): return FileResponse(STATIC_DIR / "twitch.html")

@app.get("/youtube", include_in_schema=False)
def youtube_page(): return FileResponse(STATIC_DIR / "youtube.html")

@app.get("/settings", include_in_schema=False)
def settings_page(): return FileResponse(STATIC_DIR / "settings.html")
```

Root `/` now serves `index.html` (merged view).

---

## 5. Merged Root View (`/`)

**Data flow:**

1. On load: fetch `/stats/users` (Twitch) + `/stats/youtube/users` (YouTube) in parallel → populate two account pickers
2. On window pill click or account picker change: fetch `/stats/{window}` + `/stats/youtube/{window}` + `/settings/channel-links` in parallel
3. Build merge map from `channel_links`: `{ twitch_channel → youtube_channel }`
4. Render table:
   - Linked pairs: one row, label `"<twitch> / <youtube>"`, seconds summed, platform badges shown
   - Unlinked Twitch channels: row with Twitch badge
   - Unlinked YouTube channels: row with YouTube badge
5. Time window pills (today / last 7 days / last 30 days / all time) apply to both platforms simultaneously
6. URL deep-linking preserved (`?window=today|last7days|last30days|alltime`)

**Account pickers:**

- Twitch picker: filters Twitch stats only (linked rows re-merge if YouTube picker is also set)
- YouTube picker: filters YouTube stats only
- Both default to "All accounts"

---

## 6. Settings Page (`/settings`)

- Table listing current `channel_links`: columns Twitch Channel, YouTube Channel, Delete button
- Add form: two text inputs (Twitch handle, YouTube handle) + Add button
- POST to `/settings/channel-links`, DELETE to `/settings/channel-links/{id}`
- No auth gate — same API key required (page loaded behind the API key gate shared with other pages, or settings page has its own key prompt)

---

## 7. YouTube-Only Dashboard (`/youtube`)

Mirrors current Twitch dashboard structure:

- Account picker (YouTube users)
- Time window pills (today / last 7 days / last 30 days / all time)
- Per-channel watch time table
- Playlist breakdown section (calls `/stats/youtube/playlists?window=...`)
- URL deep-linking on window selection

---

## Out of Scope

- YouTube API / OAuth (no quota concerns; all detection is DOM-based)
- Playlist tracking on Twitch
- Home Assistant integration (Phase 3, separate spec)
- TV ambient view for YouTube
