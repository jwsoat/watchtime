# Twitch Watch Time Tracker

Personal watch time logger for Twitch. A browser extension sends heartbeats to
your own self-hosted API, which stores them in SQLite. Phase 1: ingestion only.
Phase 2 will add a custom dashboard, Phase 3 a Home Assistant integration.

## How it works

The extension runs a 60-second timer on twitch.tv pages. Every tick, if a video
is playing, it records:

- channel (from URL)
- timestamp
- category and stream title (from DOM)
- whether the tab is visible
- whether the user is active (mouse/keyboard in last 5 min) vs idle

Heartbeats are buffered in `chrome.storage.local` and flushed to the API every
minute. If the API is unreachable, they accumulate locally and flush on next
success. Up to 5000 queued before the oldest start dropping.

Watch time = `count(heartbeats) * 60 seconds`. No session-stitching needed.

## Setup

### 1. Backend (on Proxmox)

```bash
cp .env.example .env
# Generate a key:
echo "API_KEY=$(openssl rand -hex 32)" > .env

docker compose up -d
docker compose logs -f watch-api
```

Test:

```bash
curl http://localhost:8765/health
# {"ok":true,"interval":60}
```

You'll want to put this behind a reverse proxy (Caddy/Traefik/nginx) for HTTPS
since the extension needs to talk to it from twitch.tv. Easiest with Caddy:

```caddyfile
watch.jwsoat.co.nz {
    reverse_proxy localhost:8765
}
```

### 2. Extension

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" and pick the `extension/` directory
4. Click "Details" → "Extension options"
5. Paste your API URL and API key, click Save

Open twitch.tv, watch any stream, and within a couple of minutes you should
see heartbeats arriving. Check with:

```bash
curl -H "X-API-Key: $API_KEY" http://localhost:8765/stats/today
```

## API endpoints

All `/stats/*` and `/heartbeat*` require `X-API-Key` header.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | No auth, sanity check |
| POST | `/heartbeat` | Single heartbeat (extension uses batch) |
| POST | `/heartbeats` | Batched heartbeats |
| GET | `/stats/today` | Per-channel seconds since local midnight |
| GET | `/stats/week` | Per-channel seconds, last 7 days |
| GET | `/stats/all` | Per-channel seconds, all time |
| GET | `/stats/daily?days=30` | Total seconds per day |
| GET | `/stats/top_channel?window=today` | Top channel name + seconds |
| GET | `/stats/total?window=today` | Total seconds across all channels |

Add `?include_passive=false` to exclude idle/AFK time.

## Backups

The DB is just `api/data/watchtime.db`. Throw it in your regular backup.
For extra paranoia, periodic dumps:

```bash
docker exec twitch-watch-api sh -c \
  "sqlite3 /data/watchtime.db .dump" > backup-$(date +%F).sql
```

## What's next

- Phase 2: custom HTML dashboard served from the API container
- Phase 3: REST sensors in Home Assistant pointed at `/stats/*`
