# Android tracking via Tasker (`mobile-android` platform)

The Android side of watchtime tracking: while a tracked app is in the
foreground, a Tasker profile POSTs a heartbeat to the API every 10 seconds —
the same cadence and heartbeat shape as the browser extension. `channel` is
the app name, so per-platform stats rank **apps** (TikTok, Twitch, Netflix…).

## What's in this directory

| File | Purpose |
|------|---------|
| `watchtime-mobile-android.xml` | Importable Tasker project: 2 profiles + 4 tasks |
| `README.md` | This file — setup, manual build, troubleshooting |

## Concept

- **Profile 1 `WT App Tracked`** — *Application* context (UsageStats-backed)
  on the tracked apps, **Enter** task `WT Start`:
  1. if a tracking loop is already running (`%WT_ACTIVE`), stop it first
     (this is a *different tracked app* coming to the front — `WT End` closes
     the previous session)
  2. set `%WT_ACTIVE = 1`, snapshot `%WT_APP = %applabel`, then run `WT Loop`
     (async — runs until told to stop)
  3. run `WT End` once, which kills any leftover loop and emits a baseline
     `passive` beat for the previous app
- **Profile 2 `WT App Left`** — *Application* context on the same apps with
  **Exit** task `WT Exit`: set `%WT_ACTIVE = 0` and run `WT End`.
- **Task `WT Loop`** — POST one `active` heartbeat → wait 10s → if
  `%WT_ACTIVE ≠ 1`, exit; else loop. While the app is foreground the screen is
  on and the loop re-arms `Wait`, so Doze is not engaged.
- **Task `WT End`** — POST one final `passive` heartbeat for `%WT_APP`, then
  stop any running `WT Loop` child task.
- **Task `WT Setup`** — one-time config: set `%WT_URL` / `%WT_KEY`, mint a
  random `client_id` into `%WT_CLIENT`, save them.

Heartbeat JSON sent (identical to the extension's media shape):

```json
{"heartbeats":[{"ts":1760400000,"platform":"mobile-android",
 "channel":"TikTok","title":null,"video_id":null,"state":"active",
 "tab_visible":true,"client_id":"android-123456","media_user":null,
 "display_name":null}]}
```

## Setup

1. Install Tasker and grant it **Usage Stats** access (it prompts when you
   add an Application context or import the profiles).
2. Import `watchtime-mobile-android.xml` (Tasker → long-press the project
   list → **Import**), or build the profiles/tasks by hand from the concept
   above — the XML is a starting point, not magic.
3. Edit the `WT Setup` task: set `%WT_URL` to your API base URL and `%WT_KEY`
   to the API key.
4. Run `WT Setup` once (it saves the vars and mints `%WT_CLIENT`).
5. In profile `WT App Tracked`, tap the **App** context and tick every app you
   want tracked. Do the same on `WT App Left` — keep the two lists identical.
6. Toggle the profiles on, open a tracked app ~30s, then verify:

```bash
curl -H "X-API-Key: $API_KEY" https://stats.jwsoat.co.nz/stats/media/mobile-android/today
```

## Manual build checklist (if the XML won't import across Tasker versions)

Tasker's XML format shifts between releases. If import fails, recreate:

- **Profile A** `WT App Tracked`: State context **App** (select apps) →
  Enter task:
  1. `If %WT_ACTIVE = 1` → `Stop Task: WT Loop` → `End If`
  2. `Variable Set %WT_ACTIVE → 1`
  3. `Variable Set %WT_APP → %applabel`
  4. `Run Task: WT Loop` (**not** "Wait for completion")
  5. `Run Task: WT End`
- **Profile B** `WT App Left`: State context **App** (same apps) → Exit task:
  1. `Variable Set %WT_ACTIVE → 0`
  2. `Run Task: WT End`
- **Task** `WT Loop`:
  1. `Variable Set %WT_APP → %applabel`
  2. `Variable Set %WT_JSON → {"heartbeats":[{"ts":%TS,"platform":"mobile-android","channel":"%WT_APP","title":null,"video_id":null,"state":"active","tab_visible":true,"client_id":"%WT_CLIENT","media_user":null,"display_name":null}]}`
  3. `HTTP Request: %WT_URL/media/heartbeats, Method POST, Headers
     X-API-Key: %WT_KEY · Content-Type: application/json, Body %WT_JSON`
  4. `Wait 10s`
  5. `JavaScriptlet: exit(!(local("%WT_ACTIVE") == "1"))`
  6. `Goto Action 1` (loop)
- **Task** `WT End`:
  1. `Stop Task WT Loop` (kills a running loop; no-op if none)
  2. `Variable Set %WT_JSON → ...same but "state":"passive","tab_visible":false...`
  3. `HTTP Request` (same as above)
- **Task** `WT Setup`: set the three vars, then `Flash: Watchtime vars saved`.

## Notes & limits

- **Battery**: the loop only exists while a tracked app is foreground. No
  boot receiver, no persistent notification, no polling — Tasker's Application
  context is UsageStats-backed (system push, not polling).
- **Overlap**: if you also track the same service in the desktop browser
  (e.g. TikTok), both count — same as Plex today. The **Merged** view rolls
  them up by creator only via explicit creator links.
- **No in-app content**: Android gives no per-video info to a background
  observer, so `title`/`video_id` are always null and
  `/stats/media/mobile-android/videos` stays empty — the "channels" ranking is
  app usage.
- **media_user**: single-user device; always null. Account filtering doesn't
  apply to this platform (same as the other media platforms).
- **Multi-user phones**: `%WT_CLIENT` is per-Tasker-install. On a shared
  phone, set a distinct client suffix per Android user profile to keep the
  sessions distinguishable.
- **HTTPS**: Tasker's HTTP action validates certs like any client — a
  self-signed cert needs the CA added to the user store, or use the Caddy
  domain. Cleartext `http://` works if your server is reachable that way.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| No heartbeats at all | `WT Setup` never run (vars empty); profile toggle off; UsageStats not granted |
| `401` in Tasker HTTP result | `%WT_KEY` wrong/empty |
| Heartbeats only on app *close* | `%WT_ACTIVE` logic inverted — check step order in `WT Start` |
| Double sessions when switching between two tracked apps | `WT App Left`'s Exit didn't fire before the next Enter — harmless for totals, only affects `/now` for a beat |
| Tasker killed overnight | Android battery optimization on Tasker — exempt it in system settings |
