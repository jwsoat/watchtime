# Additional video sources: X, Facebook, Instagram, Plex

**Date:** 2026-06-17
**Status:** Implemented

## Goal

Extend Watchtime beyond Twitch + YouTube to track **X (Twitter)**, **Facebook**,
**Instagram** and **Plex**, reusing the existing additive heartbeat architecture.

## Design

Rather than duplicate the full Twitch/YouTube stack (table + models + ~10
endpoints) four times, the four new sources share a single generic store:

- **One table** `media_heartbeats` with a `platform` discriminator
  (`x|facebook|instagram|plex`) and the common columns
  (`ts, channel, title, video_id, state, tab_visible, media_user, client_id`).
- **One ingest endpoint** `POST /media/heartbeats` — each heartbeat carries its
  own `platform`, so the extension uses a single queue for all browser sources.
- **Generic stats endpoints** `GET /stats/media/{platform}/{today|week|month|all|daily|videos|now|users}`
  parameterized by platform, mirroring the YouTube endpoint set.

### Browser sources (X, Facebook, Instagram)

Tracked by the Chrome extension, same as YouTube:

- New content scripts `x-content.js`, `facebook-content.js`,
  `instagram-content.js`. Each finds the most-visible playing `<video>`, scrapes
  the author (channel), post/video id and title, and sends a heartbeat with a
  `platform` field.
- `background.js` routes `x|facebook|instagram` into a new `media_queue` that
  flushes to `/media/heartbeats` (keeping the `platform` field).
- `manifest.json` gains host permissions + content scripts for x.com,
  twitter.com, facebook.com, instagram.com.

These SPAs use obfuscated, frequently-changing markup, so attribution is
best-effort: playback **time** is reliable; account/title may be null and the
selectors will need periodic maintenance.

### Plex (server-side)

`plex_poller.py` runs a daemon thread (started on app startup, only when
`PLEX_BASE_URL` + `PLEX_TOKEN` are set). It polls
`{PLEX_BASE_URL}/status/sessions` every `HEARTBEAT_INTERVAL_SECONDS` and writes
one `media_heartbeats` row (platform `plex`) per actively-playing video session.
This captures every device, not just the browser. Music tracks are skipped.

### Frontend

A single generic dashboard `media.html` + `media.js` serves `/x`, `/facebook`,
`/instagram`, `/plex`. The platform is read from the URL path; per-platform
accent colours are applied via CSS variables. Nav links added to all pages.
Avatars extended to use unavatar.io's twitter/facebook/instagram providers
(Plex falls back to initials).

## Testing

`tests/test_media.py` covers ingest (incl. platform validation + lowercasing),
per-platform isolation, user/passive filters, time windows, users/videos/now
endpoints, and the Plex session-parsing logic. Static routes covered in
`tests/test_static_routes.py`.
