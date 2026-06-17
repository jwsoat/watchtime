# Watchtime Tracker

Personal watch time logger for **Twitch**, **YouTube**, **X (Twitter)**,
**Facebook**, **Instagram** and **Plex**. A browser extension sends heartbeats
to a self-hosted API, which stores them in SQLite and serves a multi-platform
dashboard. Plex is tracked server-side by polling a Plex Media Server, so it
captures playback on every device, not just the browser.

Live at **stats.jwsoat.co.nz**.

## How it works

The extension runs a heartbeat timer on twitch.tv, youtube.com, x.com,
facebook.com and instagram.com pages. Every tick (~10s), if a video is playing,
it records:

- channel name
- timestamp (Unix seconds UTC)
- category / stream title
- video ID and playlist ID (YouTube)
- tab visibility
- user activity state (active, passive, audio-only)

Heartbeats buffer in `chrome.storage.local` and flush to the API every minute.
If the API is unreachable, they accumulate locally (up to 5000) and flush on
next success.

Watch time = `count(heartbeats) * interval`. No session-stitching needed.

## Dashboard

Four views behind an API key gate:

| Path | Description |
|------|-------------|
| `/` | **Merged** — combined Twitch + YouTube rankings, daily chart, quick stats |
| `/twitch` | Twitch-only — channels, categories, daily chart |
| `/youtube` | YouTube-only — channels, videos, daily chart |
| `/x` `/facebook` `/instagram` `/plex` | Per-source — top accounts, top videos, daily chart |
| `/tv` | Ambient scoreboard with rotating panels (point a spare display here) |
| `/settings` | Accounts, channel links, avatars, data management, Google Drive backup |

**Merged view** ranks all channels across both platforms in two columns (odd
ranks left, even right, up to 40 total). Platform badges (TW/YT) indicate source.

**Account picker** lets you filter by linked Twitch + YouTube account pairs.
Configure these in Settings.

## Setup

### 1. Backend

```bash
cp .env.example .env
echo "API_KEY=$(openssl rand -hex 32)" > .env

docker compose up -d --build
```

Test:
```bash
curl http://localhost:8765/health
# {"ok":true,"interval":10}
```

Put behind a reverse proxy for HTTPS:
```caddyfile
stats.jwsoat.co.nz {
    reverse_proxy localhost:8765
}
```

### 2. Extension

1. Open `chrome://extensions`, enable Developer Mode
2. Click "Load unpacked", select the `extension/` directory
3. Click Details > Extension options
4. Set API URL and API key, click Save

Open twitch.tv or youtube.com, watch something, verify:
```bash
curl -H "X-API-Key: $API_KEY" https://stats.jwsoat.co.nz/stats/today
```

## API endpoints

All `/stats/*`, `/heartbeat*`, and `/settings/*` require `X-API-Key` header.

### Ingestion

| Method | Path | Notes |
|--------|------|-------|
| POST | `/heartbeat` | Single Twitch heartbeat |
| POST | `/heartbeats` | Batched Twitch heartbeats |
| POST | `/youtube/heartbeats` | Batched YouTube heartbeats |
| POST | `/media/heartbeats` | Batched heartbeats for x / facebook / instagram / plex (each carries its own `platform`) |

### Twitch stats

| Method | Path | Notes |
|--------|------|-------|
| GET | `/stats/today` | Per-channel seconds since midnight |
| GET | `/stats/week` | Last 7 days |
| GET | `/stats/month` | Last 30 days |
| GET | `/stats/all` | All time |
| GET | `/stats/daily?days=30` | Total seconds per day |
| GET | `/stats/now` | Currently watching |
| GET | `/stats/top_channel?window=today` | Top channel + seconds |
| GET | `/stats/total?window=today` | Total seconds |
| GET | `/stats/channel?channel=xqc` | Single channel breakdown |
| GET | `/stats/categories` | Category rankings |
| GET | `/stats/recent` | Recently watched channels |
| GET | `/stats/users` | Known Twitch users |
| GET | `/stats/channels` | All tracked channels (both platforms) |

### YouTube stats

| Method | Path | Notes |
|--------|------|-------|
| GET | `/stats/youtube/today` | Per-channel seconds since midnight |
| GET | `/stats/youtube/week` | Last 7 days |
| GET | `/stats/youtube/month` | Last 30 days |
| GET | `/stats/youtube/all` | All time |
| GET | `/stats/youtube/daily?days=30` | Seconds per day |
| GET | `/stats/youtube/now` | Currently watching |
| GET | `/stats/youtube/videos` | Video rankings |
| GET | `/stats/youtube/playlists` | Playlist stats |
| GET | `/stats/youtube/users` | Known YouTube users |

### Other sources (X, Facebook, Instagram, Plex)

`{platform}` is one of `x`, `facebook`, `instagram`, `plex`.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/stats/media/{platform}/today` | Per-account seconds since midnight |
| GET | `/stats/media/{platform}/week` | Last 7 days |
| GET | `/stats/media/{platform}/month` | Last 30 days |
| GET | `/stats/media/{platform}/all` | All time |
| GET | `/stats/media/{platform}/daily?days=30` | Seconds per day |
| GET | `/stats/media/{platform}/videos` | Video/post rankings |
| GET | `/stats/media/{platform}/now` | Currently watching |
| GET | `/stats/media/{platform}/users` | Known accounts |

Add `?include_passive=false` to exclude idle time. Add `?user=<handle>` to
filter by account. Add `?platform=twitch|youtube` on shared endpoints.

> **Note on attribution:** X, Facebook and Instagram are tracked by scraping the
> page DOM, which these sites obfuscate and change frequently. Playback *time* is
> reliable; the detected account/title is best-effort and may occasionally be
> missing. Expect to refresh the content-script selectors over time.

### Settings

| Method | Path | Notes |
|--------|------|-------|
| GET | `/settings/channel-links` | List Twitch-YouTube channel pairs |
| POST | `/settings/channel-links` | Add link |
| DELETE | `/settings/channel-links/{id}` | Remove link |
| GET | `/settings/user-accounts` | List account pairs |
| POST | `/settings/user-accounts` | Add account |
| DELETE | `/settings/user-accounts/{id}` | Remove account |
| POST | `/settings/user-accounts/auto-link` | Auto-detect pairs from extension |

### Avatars

| Method | Path | Notes |
|--------|------|-------|
| GET | `/avatars/{platform}/{channel}` | Fetch avatar (custom > cache > unavatar.io) |
| POST | `/avatars/{platform}/{channel}` | Upload custom avatar |
| DELETE | `/avatars/{platform}/{channel}` | Delete custom avatar |
| GET | `/avatars/custom` | List custom avatars |

### Data management

| Method | Path | Notes |
|--------|------|-------|
| GET | `/settings/export` | Full JSON export of all tables |
| GET | `/settings/backup` | Download raw SQLite file |
| POST | `/settings/import?mode=merge` | Import JSON (merge or replace) |

### Google Drive backup

| Method | Path | Notes |
|--------|------|-------|
| GET | `/settings/gdrive/status` | Connection status + backup list |
| GET | `/settings/gdrive/connect` | Start OAuth flow |
| POST | `/settings/gdrive/backup` | Upload backup + rotate (keeps 3) |
| DELETE | `/settings/gdrive/disconnect` | Remove stored token |

Requires `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` env vars. Add
`https://stats.jwsoat.co.nz/settings/gdrive/callback` as an authorized
redirect URI in Google Cloud Console.

## Backups

Three options:

1. **Local download** — Settings > Data Management > Download DB backup
2. **JSON export** — Settings > Data Management > Export JSON (importable)
3. **Google Drive** — Settings > Google Drive backup > connects via OAuth,
   keeps 3 rotating backups in a "Watchtime Backups" folder

The raw database is at `api/data/watchtime.db`. For cron-based backups:
```bash
docker exec twitch-watch-api sh -c \
  "sqlite3 /data/watchtime.db .dump" > backup-$(date +%F).sql
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | Yes | — | Auth key for all protected endpoints |
| `DB_PATH` | No | `/data/watchtime.db` | SQLite database path |
| `HEARTBEAT_INTERVAL_SECONDS` | No | `10` | Heartbeat-to-seconds multiplier |
| `GDRIVE_CLIENT_ID` | No | — | Google OAuth client ID (for Drive backup) |
| `GDRIVE_CLIENT_SECRET` | No | — | Google OAuth client secret |
| `PLEX_BASE_URL` | No | — | Plex Media Server URL, e.g. `http://192.168.1.10:32400` (enables Plex poller) |
| `PLEX_TOKEN` | No | — | Plex auth token ([how to find it](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)) |
| `TZ` | No | `UTC` | Timezone for "today" calculations |

### Plex tracking

Set `PLEX_BASE_URL` and `PLEX_TOKEN` to enable the server-side Plex poller. On
startup the API polls `{PLEX_BASE_URL}/status/sessions` every
`HEARTBEAT_INTERVAL_SECONDS` and records one heartbeat per actively-playing
video session (movies, episodes, clips — music is skipped). This captures
playback from any Plex client (TV, phone, native apps), not just the browser.
